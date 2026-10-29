package collab

import "sync/atomic"

// Counters for operators: what the collaboration engine is doing and how
// often its failure paths run. They are cheap atomics, read with Stats and
// written to the log by the server (cmd/server); there is no metrics
// endpoint. Totals count since the process started.
type counters struct {
	joins           atomic.Int64 // connections registered with a room
	commits         atomic.Int64 // updates committed (new, not duplicates)
	persistFailures atomic.Int64 // definite store failures (client told to retry or not)
	roomResets      atomic.Int64 // ambiguous commit or log mismatch: everyone resyncs
	slowEvictions   atomic.Int64 // send queue full: closed with 4008
	revocations     atomic.Int64 // connections closed by logout or a membership change
}

// Stats is a snapshot for logs and diagnostics. It holds counts only: no
// user, document or session identifiers.
type Stats struct {
	Rooms       int   `json:"rooms"`
	Connections int   `json:"connections"`
	Joins       int64 `json:"joins_total"`
	Commits     int64 `json:"commits_total"`
	PersistFail int64 `json:"persist_failures_total"`
	RoomResets  int64 `json:"room_resets_total"`
	SlowEvicted int64 `json:"slow_evictions_total"`
	Revoked     int64 `json:"revocations_total"`
}

// Stats returns the current counts.
func (h *Hub) Stats() Stats {
	h.mu.Lock()
	rooms, conns := len(h.rooms), len(h.conns)
	h.mu.Unlock()
	return Stats{
		Rooms:       rooms,
		Connections: conns,
		Joins:       h.stats.joins.Load(),
		Commits:     h.stats.commits.Load(),
		PersistFail: h.stats.persistFailures.Load(),
		RoomResets:  h.stats.roomResets.Load(),
		SlowEvicted: h.stats.slowEvictions.Load(),
		Revoked:     h.stats.revocations.Load(),
	}
}
