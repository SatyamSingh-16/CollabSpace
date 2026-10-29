package collab

import (
	"errors"
	"time"

	"github.com/google/uuid"
)

// Live authorization. A connection is authorized once, at the handshake.
// These methods let the application take that back while it is open:
//
//	RevokeSession   logout: close the session's connections (4001)
//	DocumentDeleted the document is gone: close everyone's connection (4004)
//	SetMemberRole   membership removed: close with 4003
//	                role changed: close with 4008; the client reconnects and
//	                the handshake grants the new role
//	                (a change during a handshake: the join is refused with
//	                4008, and the reconnect re-reads the database)
//	authorizationTooOld  a handshake slower than authzMemory/2 is refused
//	                with 4008, so the memory below is always long enough
//
// Session expiry is handled per connection by a timer (see serveConn).
//
// A change can land between the handshake's database read and the moment
// the connection is tracked or joins its room. To close that window the hub
// remembers recent changes for authzMemory, much longer than any handshake
// (JoinTimeout), and applies them when the connection is tracked or joins.

const authzMemory = 2 * time.Minute

var (
	errSessionRevoked     = errors.New("collab: session revoked")
	errPermissionsChanged = errors.New("collab: permissions changed")
)

type memberKey struct{ doc, user uuid.UUID }

// RevokeSession closes every connection opened with sessionID and refuses
// new ones for that session. It never blocks on a connection.
func (h *Hub) RevokeSession(sessionID string) {
	if sessionID == "" {
		return
	}
	now := time.Now()
	h.mu.Lock()
	defer h.mu.Unlock()
	h.pruneAuthzLocked(now)
	h.revoked[sessionID] = now
	for c := range h.conns {
		if c.sessionID != sessionID {
			continue
		}
		c.close(CloseUnauthenticated, "signed out")
		h.stats.revocations.Add(1)
		if c.handshaking.Load() {
			// Still waiting for its join frame: no room will act on it, so
			// end the read directly (Close is safe concurrently).
			_ = c.ws.Close()
		}
	}
}

// SetMemberRole tells the hub that userID's role on docID is now role, or
// that the membership was removed (role == ""). Call it after the change is
// committed to the database.
//
// The user's affected connections are closed here, directly, like
// RevokeSession does. A closing connection's queued updates are dropped by
// Room.commit, so once this returns nothing they had sent is committed
// (except an append already inside the store at that instant). Queuing
// the change behind their submissions instead let up to RoomInboxSize of
// them commit after the API had answered (Week 5 review R4). It never
// blocks: it runs inside the owner's HTTP request (R10).
func (h *Hub) SetMemberRole(docID, userID uuid.UUID, role Role) {
	now := time.Now()
	h.mu.Lock()
	h.pruneAuthzLocked(now)
	h.roleChanges[memberKey{docID, userID}] = now
	for c := range h.conns {
		// A connection still waiting for its join frame has queued
		// nothing; its join is refused with 4008 by membershipChangedSince.
		if c.docID != docID || c.userID != userID || c.handshaking.Load() {
			continue
		}
		switch {
		case role == "":
			c.close(CloseForbidden, "access removed")
			h.stats.revocations.Add(1)
		case c.role != role:
			c.close(CloseResyncRequired, "permissions changed")
			h.stats.revocations.Add(1)
		}
	}
	r := h.rooms[docID]
	h.mu.Unlock()
	if r != nil {
		r.permissionChanged(userID, role)
	}
}

// DocumentDeleted closes every connection to docID with 4004 after the
// document was deleted (call it after the delete is committed), and makes
// joins authorized before the deletion resync: their reconnect's handshake
// then finds no membership and is refused. It never blocks.
func (h *Hub) DocumentDeleted(docID uuid.UUID) {
	now := time.Now()
	h.mu.Lock()
	defer h.mu.Unlock()
	h.pruneAuthzLocked(now)
	h.roleChanges[memberKey{doc: docID}] = now // uuid.Nil user: every member
	for c := range h.conns {
		if c.docID != docID {
			continue
		}
		c.close(CloseDocumentNotFound, "document deleted")
		h.stats.revocations.Add(1)
		if c.handshaking.Load() {
			_ = c.ws.Close() // no room will act on it; end the read directly
		}
	}
}

// authorizationTooOld reports whether c's handshake authorization was read
// so long ago that a revocation or role change since then may already have
// been pruned from the hub's memory. Such a connection is refused with
// "resync"; the reconnect's handshake reads the database again. Without
// this, a handshake stalled longer than authzMemory (a slow database) could
// be admitted after a logout or removal (Week 5 review R11).
func (h *Hub) authorizationTooOld(c *Conn) bool {
	return time.Since(c.authorizedAt) > h.authzMemory/2
}

// membershipChangedSince reports whether (docID, userID)'s membership
// changed after since, the moment that connection's authorization was read.
// Only the fact matters, not the recorded role: if two changes' hooks ran
// in a different order than their commits, the recorded role could be the
// older one. The client reconnects and the handshake reads the truth.
func (h *Hub) membershipChangedSince(docID, userID uuid.UUID, since time.Time) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if at, ok := h.roleChanges[memberKey{docID, userID}]; ok && at.After(since) {
		return true
	}
	at, ok := h.roleChanges[memberKey{doc: docID}] // the document was deleted
	return ok && at.After(since)
}

func (h *Hub) pruneAuthzLocked(now time.Time) {
	for id, at := range h.revoked {
		if now.Sub(at) > h.authzMemory {
			delete(h.revoked, id)
		}
	}
	for k, at := range h.roleChanges {
		if now.Sub(at) > h.authzMemory {
			delete(h.roleChanges, k)
		}
	}
}

type permissionEvent struct {
	userID uuid.UUID
	role   Role
}

// permissionChanged asks the room to drop the user's (already closed)
// connections from its members now, so presence updates promptly. It is
// only a hint and never blocks: if the inbox is full, each closed
// connection's reader leaves the room on its own.
func (r *Room) permissionChanged(userID uuid.UUID, role Role) {
	select {
	case r.inbox <- permissionEvent{userID: userID, role: role}:
	default:
	}
}

// applyPermission runs in the room goroutine.
func (r *Room) applyPermission(ev permissionEvent) {
	for c := range r.members {
		if c.userID != ev.userID {
			continue
		}
		switch {
		case ev.role == "":
			r.evict(c, CloseForbidden, "access removed")
		case c.role != ev.role:
			r.evict(c, CloseResyncRequired, "permissions changed")
		}
	}
}
