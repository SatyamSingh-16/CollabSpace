package collab

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"collabspace/internal/store"
)

// Store is the part of *store.Store the collaboration engine needs. It is an
// interface so tests can inject failures (definite and ambiguous commits)
// that a real database won't produce on demand.
type Store interface {
	HeadSeq(ctx context.Context, docID uuid.UUID) (int64, error)
	AppendUpdate(ctx context.Context, req store.AppendRequest) (store.AppendResult, error)
	ReadUpdates(ctx context.Context, docID uuid.UUID, afterSeq, uptoSeq int64, limit int) ([]store.Update, error)
}

var errHubClosed = errors.New("collab: hub shut down")

// Hub maps document IDs to running rooms and owns the shutdown of every room
// and connection. Its mutex protects only the maps and the closed flag; it is
// never held during database or network I/O.
type Hub struct {
	store Store
	cfg   Config
	log   *slog.Logger

	mu    sync.Mutex
	rooms map[uuid.UUID]*Room
	conns map[*Conn]struct{} // every live connection, for forced shutdown
	// Recent revocations and role changes; see authz.go.
	revoked     map[string]time.Time
	roleChanges map[memberKey]time.Time // when each membership last changed
	authzMemory time.Duration           // how long revoked and roleChanges entries are kept
	closed      bool
	stop        chan struct{} // closed by Shutdown; every room watches it

	// wg counts room goroutines and connection goroutines. Add is only ever
	// called under mu while !closed, so it never races with Shutdown's Wait.
	wg sync.WaitGroup

	nextConnID atomic.Uint64
	stats      counters
}

func NewHub(st Store, cfg Config, log *slog.Logger) *Hub {
	if log == nil {
		log = slog.Default()
	}
	return &Hub{
		store: st,
		cfg:   cfg,
		log:   log,
		rooms: make(map[uuid.UUID]*Room),
		conns: make(map[*Conn]struct{}),
		stop:  make(chan struct{}),

		revoked:     make(map[string]time.Time),
		roleChanges: make(map[memberKey]time.Time),
		authzMemory: authzMemory,
	}
}

// roomFor returns the running room for docID, starting one if needed. The
// new room loads its head inside its own goroutine, not under h.mu.
func (h *Hub) roomFor(docID uuid.UUID) (*Room, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, errHubClosed
	}
	if r, ok := h.rooms[docID]; ok {
		return r, nil
	}
	r := newRoom(docID, h)
	h.rooms[docID] = r
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		r.run(h.stop)
	}()
	return r, nil
}

// removeRoom is called by a room as it exits. It only deletes the entry if it
// still points at that room, so a newer room for the same document survives.
func (h *Hub) removeRoom(r *Room) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rooms[r.docID] == r {
		delete(h.rooms, r.docID)
	}
}

// join registers c with the document's room and returns that room and the
// head at registration. If the room exits between lookup and registration
// (idle teardown or reset), it retries with a fresh room.
func (h *Hub) join(docID uuid.UUID, c *Conn) (*Room, int64, error) {
	for range 3 {
		r, err := h.roomFor(docID)
		if err != nil {
			return nil, 0, err
		}
		head, err := r.join(c, h.cfg.JoinTimeout)
		if errors.Is(err, errRoomClosed) {
			continue
		}
		if err != nil {
			return nil, 0, err
		}
		return r, head, nil
	}
	return nil, 0, errRoomClosed
}

// trackConn records a new connection and reserves a WaitGroup slot for its
// reader. It fails once shutdown has begun.
func (h *Hub) trackConn(c *Conn) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return errHubClosed
	}
	if _, revoked := h.revoked[c.sessionID]; revoked && c.sessionID != "" {
		return errSessionRevoked // logged out after the handshake's session check
	}
	if h.authorizationTooOld(c) {
		return errPermissionsChanged // see authz.go; the client reconnects
	}
	h.conns[c] = struct{}{}
	h.wg.Add(1)
	return nil
}

func (h *Hub) untrackConn(c *Conn) {
	h.mu.Lock()
	delete(h.conns, c)
	h.mu.Unlock()
	h.wg.Done()
}

// goWriter starts c's writer, counted in wg. The reader's slot is still held,
// so the counter is non-zero and Add is safe even during Shutdown.
func (h *Hub) goWriter(c *Conn, docID uuid.UUID, afterSeq, head int64) {
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		c.writeLoop(h.store, docID, afterSeq, head)
	}()
}

func (h *Hub) newConnID() string {
	return fmt.Sprintf("c_%d", h.nextConnID.Add(1))
}

func (h *Hub) isClosed() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.closed
}

// Shutdown stops admitting connections, tells every room to close its
// members with 1001, and waits for all room and connection goroutines.
// Nothing needs flushing: an update is acknowledged only after it is
// committed, and queued submissions were never acknowledged.
//
// If ctx expires first, every remaining socket is closed directly (Close is
// safe to call concurrently with Gorilla's other methods), which releases
// any blocked reads and writes, and ctx's error is returned.
//
// net/http's Server.Shutdown does not wait for hijacked connections, so the
// server must call this separately.
func (h *Hub) Shutdown(ctx context.Context) error {
	h.mu.Lock()
	if !h.closed {
		h.closed = true
		close(h.stop)
	}
	// Connections still waiting for their join frame belong to no room, so
	// no room will close them. Closing the socket ends their readJoin.
	for c := range h.conns {
		if c.handshaking.Load() {
			_ = c.ws.Close()
		}
	}
	h.mu.Unlock()

	done := make(chan struct{})
	go func() {
		h.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		h.mu.Lock()
		for c := range h.conns {
			_ = c.ws.Close()
		}
		h.mu.Unlock()
		return ctx.Err()
	}
}
