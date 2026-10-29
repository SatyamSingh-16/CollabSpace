package collab

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"collabspace/internal/store"
)

var (
	errRoomClosed  = errors.New("collab: room closed")
	errRoomFull    = errors.New("collab: room full")
	errJoinTimeout = errors.New("collab: join timed out")
)

// Room serialises everything that happens to one document. A single
// goroutine (run) owns head and members; nothing else reads or writes them,
// so they need no mutex. Other goroutines send events through inbox.
//
// Because joins and commits are handled one at a time by this goroutine, a
// connection registered at head H receives, through its queue, exactly the
// updates committed after H (design §1, invariant I2).
type Room struct {
	docID uuid.UUID
	hub   *Hub
	store Store
	cfg   *Config
	log   *slog.Logger

	inbox chan any
	done  chan struct{} // closed after run returns
	// startErr is set before done is closed when the room could not load its
	// head; readers must only look at it after <-done.
	startErr error

	// Owned by run.
	head    int64
	members map[*Conn]struct{}
	// membersChanged is set whenever members gains or loses a connection;
	// publishPresence clears it. presence is the last presence frame
	// broadcast to the members (see presence.go).
	membersChanged bool
	presence       []byte
}

type joinEvent struct {
	conn  *Conn
	reply chan joinResult // buffered(1): the room never blocks on it
}

type joinResult struct {
	head int64
	err  error
}

type leaveEvent struct{ conn *Conn }

type submitEvent struct {
	conn        *Conn
	clientMsgID int64
	payload     []byte
}

type countEvent struct{ reply chan int }

func newRoom(docID uuid.UUID, hub *Hub) *Room {
	return &Room{
		docID:   docID,
		hub:     hub,
		store:   hub.store,
		cfg:     &hub.cfg,
		log:     hub.log.With("doc_id", docID),
		inbox:   make(chan any, hub.cfg.RoomInboxSize),
		done:    make(chan struct{}),
		members: make(map[*Conn]struct{}),
	}
}

// run is the room goroutine. It returns when the hub stops, the room has
// been idle for IdleTimeout, or the room resets itself after an ambiguous
// commit. In every case the room first removes itself from the hub, so new
// joins create a fresh room that reloads head from the database.
func (r *Room) run(stop <-chan struct{}) {
	defer func() {
		r.hub.removeRoom(r)
		close(r.done)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), r.cfg.StoreTimeout)
	head, err := r.store.HeadSeq(ctx, r.docID)
	cancel()
	if err != nil {
		r.log.Warn("room start failed", "err", err)
		r.startErr = err
		return
	}
	r.head = head

	idle := time.After(r.cfg.IdleTimeout)
	for {
		select {
		case <-stop:
			r.closeAll(CloseGoingAway, "server shutting down")
			return
		case <-idle:
			if len(r.members) == 0 {
				return
			}
		case ev := <-r.inbox:
			var newcomer *Conn
			switch ev := ev.(type) {
			case joinEvent:
				// The membership changed after this connection's authorization
				// was read: don't guess the new role from the order hooks
				// arrived in (Week 3 review #2). Refuse the join with
				// "resync"; the reconnect's handshake reads the database.
				if r.hub.membershipChangedSince(r.docID, ev.conn.userID, ev.conn.authorizedAt) ||
					r.hub.authorizationTooOld(ev.conn) {
					ev.reply <- joinResult{err: errPermissionsChanged}
					continue
				}
				// Revoked (logout, expiry) after its join frame was read
				// (Week 3 review #3).
				if ev.conn.isClosing() {
					ev.reply <- joinResult{err: errSessionRevoked}
					continue
				}
				// Before the capacity check: a reconnecting tab must not be
				// refused because its own dead connection holds the slot. If
				// this evicts anything, it frees a slot, so the join below
				// can't be refused after an eviction.
				r.replaceStale(ev.conn)
				if len(r.members) >= r.cfg.MaxRoomConns {
					ev.reply <- joinResult{err: errRoomFull}
					continue
				}
				r.members[ev.conn] = struct{}{}
				r.membersChanged = true
				newcomer = ev.conn
				r.hub.stats.joins.Add(1)
				idle = nil
				ev.reply <- joinResult{head: r.head}
			case leaveEvent:
				if _, ok := r.members[ev.conn]; ok {
					delete(r.members, ev.conn)
					r.membersChanged = true
				}
				if len(r.members) == 0 {
					idle = time.After(r.cfg.IdleTimeout)
				}
			case submitEvent:
				if reset := r.commit(ev); reset {
					return
				}
			case countEvent:
				ev.reply <- len(r.members)
			case permissionEvent:
				r.applyPermission(ev)
			}
			// Queued after this event's own frames (joined is sent by the
			// writer; updates and acks above), so a newcomer sees presence
			// after "synced" and every member sees it in event order.
			r.publishPresence(newcomer)
		}
	}
}

// commit persists one update and, only after the store confirms the commit,
// advances head and fans the update out. It reports whether the room must
// reset because its view of the log can no longer be trusted.
//
// The store call blocks this goroutine. That is deliberate: it is what keeps
// commit order, broadcast order and join registration in one sequence. The
// cost is that one document commits one update at a time; other documents
// have their own goroutines and are unaffected.
func (r *Room) commit(ev submitEvent) (reset bool) {
	if _, ok := r.members[ev.conn]; !ok || ev.conn.isClosing() {
		// Evicted, left or revoked while the event was queued. Its ack could
		// not be delivered (or must not be honoured), so don't persist it;
		// a legitimate client resends after reconnecting.
		return false
	}

	// Background, not a cancellable room context: cancelling in the middle of
	// COMMIT would turn a clean outcome into an ambiguous one.
	ctx, cancel := context.WithTimeout(context.Background(), r.cfg.StoreTimeout)
	res, err := r.store.AppendUpdate(ctx, store.AppendRequest{
		DocumentID:  r.docID,
		UserID:      ev.conn.userID,
		ClientID:    ev.conn.clientID,
		ClientMsgID: ev.clientMsgID,
		Payload:     ev.payload,
	})
	cancel()

	switch {
	case errors.Is(err, store.ErrCommitAmbiguous):
		// The update may or may not be in the log. Never guess: drop every
		// connection; clients reconnect, replay from the database (which is
		// the truth), and resend pending updates with the same IDs, so
		// deduplication settles it.
		r.log.Error("ambiguous commit, resetting room", "err", err)
		r.hub.stats.roomResets.Add(1)
		r.closeAll(CloseResyncRequired, "room reset")
		return true
	case errors.Is(err, store.ErrDocumentNotFound):
		r.closeAll(CloseDocumentNotFound, "document deleted")
		return true
	case errors.Is(err, store.ErrClientIDConflict):
		r.evict(ev.conn, CloseProtocolError, "client_id belongs to another user")
		return false
	case err != nil:
		// A definite failure: nothing was written, head is unchanged, and
		// nobody but the sender hears about it.
		// An integrity violation is permanent: retrying the same append
		// can't succeed, so don't tell the client to retry forever.
		r.log.Warn("persist failed", "err", err)
		r.hub.stats.persistFailures.Add(1)
		r.send(ev.conn, errorFrame(errCodePersistFailed, "update not saved", ev.clientMsgID, !store.IsPermanent(err)))
		return false
	case res.Duplicate && res.Seq > r.head:
		// The original is in the log but beyond our head, so this room never
		// broadcast it: a COMMIT that landed after a reset, or an outside
		// writer. Acking only the sender would leave other live members
		// missing it forever. Our head is stale; reset.
		r.log.Error("duplicate beyond head, resetting room", "head", r.head, "seq", res.Seq)
		r.hub.stats.roomResets.Add(1)
		r.closeAll(CloseResyncRequired, "room reset")
		return true
	case res.Duplicate:
		// Committed at or before head, so every member already has it (live
		// or by replay). Only the sender needs to know.
		r.send(ev.conn, committedFrame(ev.clientMsgID, res.Seq))
		return false
	case res.Seq != r.head+1:
		// Someone else wrote to this document's log. Our head is stale.
		r.log.Error("sequence jumped, resetting room", "head", r.head, "seq", res.Seq)
		r.hub.stats.roomResets.Add(1)
		r.closeAll(CloseResyncRequired, "room reset")
		return true
	}

	r.head = res.Seq
	r.hub.stats.commits.Add(1)
	frame := updateFrame(res.Seq, ev.payload, ev.conn.userID)
	for c := range r.members {
		if c == ev.conn {
			r.send(c, committedFrame(ev.clientMsgID, res.Seq))
		} else {
			r.send(c, frame)
		}
	}
	return false
}

// send enqueues a frame without blocking. A connection whose queue is full is
// evicted: memory stays bounded and the room never waits for a slow client.
// The client recovers by reconnecting with its last contiguous seq; the
// database, not memory, holds what it missed.
func (r *Room) send(c *Conn, frame []byte) {
	if !c.enqueue(frame) {
		r.log.Info("evicting slow connection", "conn_id", c.id)
		r.hub.stats.slowEvictions.Add(1)
		r.evict(c, CloseResyncRequired, "send queue full")
	}
}

// evict removes c from the room and closes it. The idle timer is not armed
// here: the evicted connection's reader always sends a leave event as it
// exits, and that event arms the timer if the room is empty.
func (r *Room) evict(c *Conn, code int, reason string) {
	if _, ok := r.members[c]; ok {
		delete(r.members, c)
		r.membersChanged = true
	}
	c.close(code, reason)
}

func (r *Room) closeAll(code int, reason string) {
	for c := range r.members {
		c.close(code, reason)
		delete(r.members, c)
	}
}

// --- called from other goroutines ---

// join registers c and returns the head at the moment of registration.
func (r *Room) join(c *Conn, timeout time.Duration) (int64, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	reply := make(chan joinResult, 1)
	select {
	case r.inbox <- joinEvent{conn: c, reply: reply}:
	case <-r.done:
		return 0, r.closedErr()
	case <-timer.C:
		return 0, errJoinTimeout
	}
	select {
	case res := <-reply:
		return res.head, res.err
	case <-r.done:
		// The room may have answered just before exiting; prefer the answer.
		select {
		case res := <-reply:
			return res.head, res.err
		default:
			return 0, r.closedErr()
		}
	case <-timer.C:
		r.leave(c) // in case the room registers it later
		return 0, errJoinTimeout
	}
}

func (r *Room) closedErr() error {
	if r.startErr != nil {
		return r.startErr
	}
	return errRoomClosed
}

// leave unregisters c. It may wait for a busy room, but never past the
// room's exit.
func (r *Room) leave(c *Conn) {
	select {
	case r.inbox <- leaveEvent{conn: c}:
	case <-r.done:
	}
}

// submit hands an update to the room. It returns false when the reader
// should stop. If the inbox stays full for SubmitTimeout (the store is slow),
// the client is told to retry later instead of the reader blocking forever.
func (r *Room) submit(c *Conn, clientMsgID int64, payload []byte) bool {
	timer := time.NewTimer(r.cfg.SubmitTimeout)
	defer timer.Stop()
	select {
	case r.inbox <- submitEvent{conn: c, clientMsgID: clientMsgID, payload: payload}:
		return true
	case <-timer.C:
		if !c.enqueue(errorFrame(errCodeServerBusy, "server busy, retry", clientMsgID, true)) {
			c.close(CloseResyncRequired, "send queue full")
			return false
		}
		return true
	case <-r.done:
		return false
	case <-c.closing:
		return false
	}
}

// memberCount asks the room goroutine how many connections it holds. It
// exists for tests and diagnostics; it returns -1 if the room has exited.
func (r *Room) memberCount() int {
	reply := make(chan int, 1)
	select {
	case r.inbox <- countEvent{reply: reply}:
	case <-r.done:
		return -1
	}
	select {
	case n := <-reply:
		return n
	case <-r.done:
		return -1
	}
}
