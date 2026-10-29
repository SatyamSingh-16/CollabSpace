package collab

import (
	"bytes"
	"maps"
	"slices"

	"github.com/google/uuid"
)

// Presence: who is in the document right now.
//
// It is derived, never stored: the room's members map already holds every
// registered connection with the identity and role the handshake read from
// the server-side session and the membership table. Presence is that map
// grouped by user, so a user with three tabs is listed once, and closing one
// tab changes nothing while another is still registered.
//
// Everything runs in the room goroutine, after the event that changed the
// members (join, leave, eviction, permission change), so presence is ordered
// with commits and needs no lock. Frames go through the same bounded queues
// as updates (Room.send): the room never waits for a socket, and a client
// that can't keep up is evicted exactly as for updates.

// closeReplaced is the reason given to a connection superseded by a newer
// one from the same tab (same user and client_id).
const closeReplaced = "replaced by a newer connection"

// replaceStale evicts older connections from the same tab as c. A provider
// has one socket at a time, so when a tab reconnects (after a network drop,
// say) its old connection is dead even if the server hasn't noticed yet;
// without this it would hold a room slot until its read deadline (PongWait).
// Only the same user's connections match, so nobody can close another
// user's connection by sending their client_id.
func (r *Room) replaceStale(c *Conn) {
	for old := range r.members {
		if old != c && old.userID == c.userID && old.clientID == c.clientID {
			r.evict(old, CloseResyncRequired, closeReplaced)
		}
	}
}

// publishPresence runs after every room event. If the set of users changed,
// every member gets the new list; otherwise only newcomer (a connection that
// just joined, or nil) gets the current one.
//
// A broadcast can evict a connection whose queue is full, which can change
// the list again; the loop repeats until it is stable. Each extra round
// needs at least one eviction, so it ends.
func (r *Room) publishPresence(newcomer *Conn) {
	for r.membersChanged || newcomer != nil {
		r.membersChanged = false
		frame := r.presenceFrame()
		switch {
		case !bytes.Equal(frame, r.presence):
			r.presence = frame
			for c := range r.members {
				r.send(c, frame) // a full queue evicts c and sets membersChanged
			}
		case newcomer != nil:
			r.send(newcomer, frame)
		}
		newcomer = nil
	}
}

// presenceFrame encodes the current users, sorted by ID, so the same set
// always gives the same bytes and publishPresence can compare frames.
func (r *Room) presenceFrame() []byte {
	byUser := make(map[uuid.UUID]presenceUser, len(r.members))
	for c := range r.members {
		u, seen := byUser[c.userID]
		// One role per user. Two connections of one user can briefly hold
		// different roles around a role change; show the higher one, and
		// break ties deterministically.
		if !seen || c.role.rank() > u.Role.rank() ||
			(c.role == u.Role && c.displayName < u.DisplayName) {
			byUser[c.userID] = presenceUser{UserID: c.userID, DisplayName: c.displayName, Role: c.role}
		}
	}
	users := slices.SortedFunc(maps.Values(byUser), func(a, b presenceUser) int {
		return bytes.Compare(a.UserID[:], b.UserID[:])
	})
	if users == nil {
		users = []presenceUser{} // "users":[], not null
	}
	return encode(presenceMessage{Type: "presence", Users: users})
}

// OnlineUsers counts, for each of docIDs, the distinct users with a joined,
// open connection to it right now. Documents with nobody online are left
// out. It reads only the hub's connection map: no room or database I/O.
func (h *Hub) OnlineUsers(docIDs []uuid.UUID) map[uuid.UUID]int {
	users := make(map[uuid.UUID]map[uuid.UUID]struct{}, len(docIDs))
	for _, id := range docIDs {
		users[id] = nil
	}
	h.mu.Lock()
	for c := range h.conns {
		set, wanted := users[c.docID]
		if !wanted || c.handshaking.Load() || c.isClosing() {
			continue
		}
		if set == nil {
			set = make(map[uuid.UUID]struct{})
			users[c.docID] = set
		}
		set[c.userID] = struct{}{}
	}
	h.mu.Unlock()
	out := make(map[uuid.UUID]int)
	for id, set := range users {
		if len(set) > 0 {
			out[id] = len(set)
		}
	}
	return out
}
