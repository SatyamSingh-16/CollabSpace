package collab

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"

	"collabspace/internal/store"
	"collabspace/internal/testdb"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	testdb.Run(m, func(p *pgxpool.Pool) { testPool = p })
}

// faultStore wraps the real store so a test can intercept AppendUpdate.
// The hook receives a function that performs the real append, so it can
// fail before writing, or write and then report an ambiguous outcome.
type faultStore struct {
	*store.Store
	mu   sync.Mutex
	hook func(req store.AppendRequest, real func() (store.AppendResult, error)) (store.AppendResult, error)
}

func (f *faultStore) setHook(h func(store.AppendRequest, func() (store.AppendResult, error)) (store.AppendResult, error)) {
	f.mu.Lock()
	f.hook = h
	f.mu.Unlock()
}

func (f *faultStore) AppendUpdate(ctx context.Context, req store.AppendRequest) (store.AppendResult, error) {
	f.mu.Lock()
	h := f.hook
	f.mu.Unlock()
	real := func() (store.AppendResult, error) { return f.Store.AppendUpdate(ctx, req) }
	if h == nil {
		return real()
	}
	return h(req, real)
}

// once makes a hook that applies to the next append only.
func (f *faultStore) once(h func(store.AppendRequest, func() (store.AppendResult, error)) (store.AppendResult, error)) {
	f.setHook(func(req store.AppendRequest, real func() (store.AppendResult, error)) (store.AppendResult, error) {
		f.setHook(nil)
		return h(req, real)
	})
}

type env struct {
	t     *testing.T
	store *store.Store
	fault *faultStore
	hub   *Hub
	srv   *httptest.Server
}

func testConfig() Config {
	cfg := DefaultConfig()
	cfg.JoinTimeout = 5 * time.Second
	return cfg
}

func newEnv(t *testing.T, cfg Config) *env {
	t.Helper()
	real := store.New(testPool)
	fault := &faultStore{Store: real}
	hub := NewHub(fault, cfg, slog.New(slog.DiscardHandler))
	router := chi.NewRouter()
	NewHandler(hub, testAuthorizer).Routes(router)
	srv := httptest.NewServer(router)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := hub.Shutdown(ctx); err != nil {
			t.Errorf("hub shutdown: %v", err)
		}
		srv.Close()
	})
	return &env{t: t, store: real, fault: fault, hub: hub, srv: srv}
}

// testAuthorizer stands in for session auth until Week 2. Identity comes
// from test headers.
func testAuthorizer(r *http.Request, _ uuid.UUID) (Principal, error) {
	if r.Header.Get("X-Test-Deny") != "" {
		return Principal{}, ErrNoAccess
	}
	user, err := uuid.Parse(r.Header.Get("X-Test-User"))
	if err != nil {
		return Principal{}, ErrUnauthenticated
	}
	// Updates must reference a real account (migration 00003).
	if err := testdb.EnsureUser(r.Context(), testPool, user); err != nil {
		return Principal{}, err
	}
	return Principal{
		UserID:      user,
		Role:        Role(r.Header.Get("X-Test-Role")),
		DisplayName: r.Header.Get("X-Test-Name"),
		SessionID:   r.Header.Get("X-Test-Session"),
	}, nil
}

func (e *env) newDoc() uuid.UUID {
	e.t.Helper()
	id := uuid.New()
	if err := e.store.CreateDocument(context.Background(), id, e.t.Name()); err != nil {
		e.t.Fatalf("create document: %v", err)
	}
	return id
}

func (e *env) wsURL(doc uuid.UUID) string {
	return "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/ws/documents/" + doc.String()
}

// client is a test WebSocket client. Each client must be used by one
// goroutine at a time.
type client struct {
	ws       *websocket.Conn
	user     uuid.UUID
	clientID uuid.UUID

	// Presence frames arrive between other frames. read() sets them aside
	// here, so tests about updates are unaffected; nextPresence() consumes
	// them in arrival order. held keeps other frames read while looking for
	// presence, for read() to return first.
	presences [][]presenceUser
	held      []serverMsg
}

func (e *env) dialAs(doc, user, clientID uuid.UUID, role Role, extra http.Header) (*client, *http.Response, error) {
	h := http.Header{}
	h.Set("X-Test-User", user.String())
	h.Set("X-Test-Role", string(role))
	for k, v := range extra {
		h[k] = v
	}
	ws, resp, err := websocket.DefaultDialer.Dial(e.wsURL(doc), h)
	if err != nil {
		return nil, resp, err
	}
	return &client{ws: ws, user: user, clientID: clientID}, resp, nil
}

// connect dials as a new editor with a fresh client ID.
func (e *env) connect(doc uuid.UUID) *client {
	e.t.Helper()
	c, _, err := e.dialAs(doc, uuid.New(), uuid.New(), RoleEditor, nil)
	if err != nil {
		e.t.Fatalf("dial: %v", err)
	}
	e.t.Cleanup(func() { c.ws.Close() })
	return c
}

// reconnect dials again as the same user and client ID, like a browser tab
// that lost its connection.
func (e *env) reconnect(old *client, doc uuid.UUID) (*client, error) {
	c, _, err := e.dialAs(doc, old.user, old.clientID, RoleEditor, nil)
	return c, err
}

type serverMsg struct {
	Type        string    `json:"type"`
	HeadSeq     int64     `json:"head_seq"`
	Seq         int64     `json:"seq"`
	Data        []byte    `json:"data"`
	UserID      uuid.UUID `json:"user_id"`
	ClientMsgID int64     `json:"client_msg_id"`
	Code        string    `json:"code"`
	Retryable   bool      `json:"retryable"`
	Role        Role      `json:"role"`
	ConnID      string    `json:"conn_id"`

	Users []presenceUser `json:"users"`
}

func (c *client) sendJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.ws.WriteMessage(websocket.TextMessage, b)
}

func (c *client) join(afterSeq int64) error {
	return c.sendJSON(map[string]any{"type": "join", "v": 1, "client_id": c.clientID, "after_seq": afterSeq})
}

func (c *client) update(msgID int64, data []byte) error {
	return c.sendJSON(map[string]any{"type": "update", "client_msg_id": msgID, "data": data})
}

// read returns the next frame that is not presence.
func (c *client) read() (serverMsg, error) {
	if len(c.held) > 0 {
		m := c.held[0]
		c.held = c.held[1:]
		return m, nil
	}
	for {
		m, err := c.readFrame()
		if err != nil || m.Type != "presence" {
			return m, err
		}
		c.presences = append(c.presences, m.Users)
	}
}

// nextPresence returns the next presence list this client was sent.
func (c *client) nextPresence() ([]presenceUser, error) {
	for len(c.presences) == 0 {
		m, err := c.readFrame()
		if err != nil {
			return nil, err
		}
		if m.Type == "presence" {
			c.presences = append(c.presences, m.Users)
		} else {
			c.held = append(c.held, m)
		}
	}
	p := c.presences[0]
	c.presences = c.presences[1:]
	return p, nil
}

func (c *client) readFrame() (serverMsg, error) {
	_ = c.ws.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, b, err := c.ws.ReadMessage()
	if err != nil {
		return serverMsg{}, err
	}
	var m serverMsg
	err = json.Unmarshal(b, &m)
	return m, err
}

func (c *client) expect(typ string) (serverMsg, error) {
	m, err := c.read()
	if err != nil {
		return m, err
	}
	if m.Type != typ {
		return m, fmt.Errorf("got %q message %+v, want %q", m.Type, m, typ)
	}
	return m, nil
}

// sync joins after afterSeq and reads joined, the replay and synced. It
// checks the replay is exactly afterSeq+1 .. head, in order.
func (c *client) sync(afterSeq int64) (head int64, replay []serverMsg, err error) {
	if err := c.join(afterSeq); err != nil {
		return 0, nil, err
	}
	joined, err := c.expect("joined")
	if err != nil {
		return 0, nil, err
	}
	next := afterSeq + 1
	for {
		m, err := c.read()
		if err != nil {
			return 0, nil, err
		}
		switch m.Type {
		case "update":
			if m.Seq != next {
				return 0, nil, fmt.Errorf("replay: got seq %d, want %d", m.Seq, next)
			}
			next++
			replay = append(replay, m)
		case "synced":
			if m.Seq != joined.HeadSeq || next != m.Seq+1 {
				return 0, nil, fmt.Errorf("synced at %d, joined head %d, replayed up to %d", m.Seq, joined.HeadSeq, next-1)
			}
			return m.Seq, replay, nil
		default:
			return 0, nil, fmt.Errorf("unexpected %q during replay", m.Type)
		}
	}
}

func (c *client) mustSync(t *testing.T, afterSeq int64) (int64, []serverMsg) {
	t.Helper()
	head, replay, err := c.sync(afterSeq)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	return head, replay
}

// expectClose reads (discarding messages) until the server closes the
// connection, and checks the close code.
func (c *client) expectClose(code int) error {
	for {
		_, err := c.read()
		if err == nil {
			continue
		}
		var ce *websocket.CloseError
		if errors.As(err, &ce) {
			if ce.Code != code {
				return fmt.Errorf("closed with %d (%q), want %d", ce.Code, ce.Text, code)
			}
			return nil
		}
		var se *json.SyntaxError
		if errors.As(err, &se) {
			continue
		}
		return fmt.Errorf("connection ended without close frame: %v", err)
	}
}

func must[T any](t *testing.T) func(T, error) T {
	return func(v T, err error) T {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
}

// eventually polls cond until it holds or the timeout expires. It is used
// only for conditions that are reached asynchronously by other goroutines
// (e.g. a room processing a leave event), never as a fixed sleep.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (e *env) room(doc uuid.UUID) *Room {
	e.hub.mu.Lock()
	defer e.hub.mu.Unlock()
	return e.hub.rooms[doc]
}

func payload(format string, args ...any) []byte {
	return []byte(fmt.Sprintf(format, args...))
}
