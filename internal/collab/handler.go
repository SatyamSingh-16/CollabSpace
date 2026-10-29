package collab

import (
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"collabspace/internal/store"
)

// Principal is the authenticated user and their role on one document.
type Principal struct {
	UserID uuid.UUID
	Role   Role
	// DisplayName is shown to the document's other members (presence).
	DisplayName string
	// SessionID identifies the login session (for RevokeSession) and
	// SessionExpires closes the connection when it ends. Both optional.
	SessionID      string
	SessionExpires time.Time
}

var (
	ErrUnauthenticated = errors.New("collab: not authenticated")
	// ErrNoAccess covers both "no such document" and "not a member", so a
	// guessed document ID reveals nothing (the handler answers 404).
	ErrNoAccess = errors.New("collab: no access to document")
)

// Authorizer resolves who is connecting and what they may do. It runs
// before the upgrade, so failures are plain HTTP errors. Real session-based
// authorization arrives with users and workspaces (Week 2-3); until then
// tests and the PoC inject their own.
type Authorizer func(r *http.Request, docID uuid.UUID) (Principal, error)

// Handler serves GET /ws/documents/{docID}.
type Handler struct {
	hub       *Hub
	authorize Authorizer
	upgrader  websocket.Upgrader
}

func NewHandler(hub *Hub, authorize Authorizer) *Handler {
	h := &Handler{hub: hub, authorize: authorize}
	h.upgrader = websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
	}
	if origins := hub.cfg.AllowedOrigins; len(origins) > 0 {
		h.upgrader.CheckOrigin = func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			// Browsers always send Origin on WebSocket handshakes; a missing
			// header means a non-browser client, which can't be the victim of
			// cross-site WebSocket hijacking.
			return origin == "" || slices.Contains(origins, origin)
		}
	}
	// With no allowlist, CheckOrigin stays nil and Gorilla's default applies:
	// reject when the Origin host differs from the Host header.
	return h
}

// Routes mounts the WebSocket endpoint on a Chi router.
func (h *Handler) Routes(r chi.Router) {
	r.Get("/ws/documents/{docID}", h.ServeHTTP)
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	docID, err := uuid.Parse(chi.URLParam(r, "docID"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if h.hub.isClosed() {
		http.Error(w, "shutting down", http.StatusServiceUnavailable)
		return
	}

	// 1. Authenticate and authorize before upgrading. authorizedAt is taken
	// before the database read: a permission change after this instant is
	// applied when the connection joins (see authz.go).
	authorizedAt := time.Now()
	p, err := h.authorize(r, docID)
	switch {
	case errors.Is(err, ErrUnauthenticated):
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	case errors.Is(err, ErrNoAccess):
		http.NotFound(w, r)
		return
	case err != nil:
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// 2. Upgrade. On an Origin mismatch Gorilla replies 403 itself.
	ws, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	h.serveConn(ws, docID, p, authorizedAt, middleware.GetReqID(r.Context()))
}

// serveConn runs the join handshake, starts the writer and then becomes the
// reader for the lifetime of the connection.
func (h *Handler) serveConn(ws *websocket.Conn, docID uuid.UUID, p Principal, authorizedAt time.Time, requestID string) {
	cfg := &h.hub.cfg

	// Track the connection before the handshake, so Shutdown waits for it
	// and its forced path can close a socket still waiting for the join.
	c := newConn(h.hub.newConnID(), ws, cfg, p, uuid.Nil)
	c.authorizedAt = authorizedAt
	c.docID = docID
	c.handshaking.Store(true)
	if err := h.hub.trackConn(c); err != nil {
		code, reason := joinCloseCode(err)
		c.closeNow(code, reason)
		return
	}
	defer h.hub.untrackConn(c)

	// 3. The first frame must be a join.
	ws.SetReadLimit(cfg.MaxFrameBytes)
	_ = ws.SetReadDeadline(time.Now().Add(cfg.JoinTimeout))
	join, err := readJoin(ws)
	c.handshaking.Store(false)
	if err != nil {
		c.closeNow(CloseProtocolError, err.Error())
		return
	}
	// Set before the join event is sent, which publishes it to the room.
	c.clientID = join.clientID

	// 4. Register with the room; head is fixed at this instant.
	room, head, err := h.hub.join(docID, c)
	if err != nil {
		code, reason := joinCloseCode(err)
		c.closeNow(code, reason)
		return
	}
	if join.afterSeq > head {
		// The client claims updates the log doesn't have (e.g. the database
		// was reset). Its document state can't be reconciled by replay.
		room.leave(c)
		c.closeNow(CloseProtocolError, "after_seq is ahead of the document")
		return
	}
	// request_id ties these lines to the upgrade request's own log line.
	log := h.hub.log.With("doc_id", docID, "conn_id", c.id, "request_id", requestID)
	joinedAt := time.Now()
	log.Info("joined", "user_id", p.UserID, "after_seq", join.afterSeq, "head", head)

	// The session ends while connected: close at its expiry, not later.
	if !p.SessionExpires.IsZero() {
		expiry := time.AfterFunc(time.Until(p.SessionExpires), func() {
			c.close(CloseUnauthenticated, "session expired")
		})
		defer expiry.Stop()
	}

	// 5. Writer: joined, replay (after, head], synced, live. Reader: here.
	h.hub.goWriter(c, docID, join.afterSeq, head)
	c.readLoop(room)

	room.leave(c)
	c.close(CloseNormal, "") // no-op if something closed it first
	log.Info("left", "close_code", c.closeCode, "reason", c.closeReason, "connected_ms", time.Since(joinedAt).Milliseconds())
}

type joinRequest struct {
	clientID uuid.UUID
	afterSeq int64
}

var errBadJoin = errors.New("first message must be a valid join")

func readJoin(ws *websocket.Conn) (joinRequest, error) {
	_, data, err := ws.ReadMessage()
	if err != nil {
		return joinRequest{}, errBadJoin
	}
	var m clientMessage
	if err := json.Unmarshal(data, &m); err != nil || m.Type != "join" || m.V != ProtocolVersion || m.AfterSeq < 0 {
		return joinRequest{}, errBadJoin
	}
	id, err := uuid.Parse(m.ClientID)
	if err != nil || id == uuid.Nil {
		return joinRequest{}, errBadJoin
	}
	return joinRequest{clientID: id, afterSeq: m.AfterSeq}, nil
}

func joinCloseCode(err error) (int, string) {
	switch {
	case errors.Is(err, errHubClosed):
		return CloseGoingAway, "server shutting down"
	case errors.Is(err, errSessionRevoked):
		return CloseUnauthenticated, "signed out"
	case errors.Is(err, errPermissionsChanged):
		return CloseResyncRequired, "permissions changed"
	case errors.Is(err, errRoomFull):
		return CloseRoomFull, "room full"
	case errors.Is(err, store.ErrDocumentNotFound):
		return CloseDocumentNotFound, "document not found"
	default:
		return CloseResyncRequired, "join failed, retry"
	}
}
