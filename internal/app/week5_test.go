package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"collabspace/internal/collab"
	"collabspace/internal/config"
	"collabspace/internal/ratelimit"
)

// Week 5 review H2: if a removal committed but its call reported an error,
// the hook never ran and the removed user's connection stayed open; a retry
// answered 404 and still didn't close it. Now a 404 also closes it.
func TestRemovingANonMemberStillClosesTheirConnection(t *testing.T) {
	s := newServer(t, nil)
	owner, bob := s.register(t), s.register(t)
	doc := s.createDoc(t, owner, "h2")
	s.share(t, owner, doc, bob.email, "editor")
	bobWS, _ := s.joinWS(t, doc, bob)

	// The membership row is gone, but no hook ran (as after a lost reply).
	if _, err := s.app.pool.Exec(context.Background(),
		`DELETE FROM document_members WHERE document_id = $1 AND user_id = $2`, doc, bob.id); err != nil {
		t.Fatal(err)
	}
	if r := s.do("DELETE", "/api/documents/"+doc+"/members/"+bob.id, nil, owner.cookie); r.status != 404 {
		t.Fatalf("retry: %d", r.status)
	}
	expectClose(t, bobWS, collab.CloseForbidden)
}

// Week 5 review R6: an attacker spending the strict per-account budget from
// their own addresses must not lock the owner out from the owner's address.
// The looser per-account total still stops guessing spread over addresses.
func TestAccountLimitIsPerAddressWithALooserTotal(t *testing.T) {
	s := newServer(t, func(c *config.Config) {
		c.TrustedProxyHeader = "X-Real-IP"
		c.RateLoginPerAccountIP = ratelimit.Rule{Burst: 3, Window: time.Minute}
		c.RateLoginPerAccount = ratelimit.Rule{Burst: 8, Window: time.Minute}
	})
	victim := s.register(t)
	for i := range 3 {
		if r := login(s, victim.email, "wrong-password", fromIP("198.51.100.7")); r.status != 401 {
			t.Fatalf("attempt %d: %d", i+1, r.status)
		}
	}
	if r := login(s, victim.email, "wrong-password", fromIP("198.51.100.7")); r.status != 429 {
		t.Fatalf("4th attempt from the attacker's address: %d, want 429", r.status)
	}
	if r := login(s, victim.email, "password-123", fromIP("203.0.113.50")); r.status != 200 {
		t.Fatalf("owner from their own address: %d, want 200", r.status)
	}
	// Distributed guessing: the total across addresses (8) still applies.
	statuses := []int{}
	for i := range 6 {
		statuses = append(statuses, login(s, victim.email, "wrong-password", fromIP("192.0.2."+strconv.Itoa(i+1))).status)
	}
	if statuses[len(statuses)-1] != 429 {
		t.Fatalf("distributed attempts %v: the per-account total never applied", statuses)
	}
}

// Week 5 review R7: sharing answers 404 for unknown emails; without a limit
// one account could test emails as fast as the server answers.
func TestSharingIsRateLimitedPerUser(t *testing.T) {
	s := newServer(t, func(c *config.Config) { c.RateSharePerUser = ratelimit.Rule{Burst: 3, Window: time.Minute} })
	owner := s.register(t)
	doc := s.createDoc(t, owner, "probe")
	for i := range 3 {
		if r := s.share(t, owner, doc, uniqueEmail(), "viewer"); r.status != 404 {
			t.Fatalf("probe %d: %d", i+1, r.status)
		}
	}
	r := s.share(t, owner, doc, uniqueEmail(), "viewer")
	if r.status != 429 {
		t.Fatalf("4th probe: %d, want 429", r.status)
	}
	if r.header.Get("Retry-After") == "" {
		t.Fatal("429 without Retry-After")
	}
	// Another user has their own budget.
	other := s.register(t)
	otherDoc := s.createDoc(t, other, "mine")
	if r := s.share(t, other, otherDoc, owner.email, "viewer"); r.status != 200 {
		t.Fatalf("another user's share: %d", r.status)
	}
}

// Week 5 review D10.
func TestAPIResponsesAreNotCachedOrSniffed(t *testing.T) {
	s := newServer(t, nil)
	a := s.register(t)
	r := s.do("GET", "/api/auth/me", nil, a.cookie)
	if r.header.Get("Cache-Control") != "no-store" || r.header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("headers: %v", r.header)
	}
}

// syncBuffer is a log sink safe for the server's concurrent goroutines.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// Week 5 Phase B: run a whole session with debug logging captured, and check
// that no secret, email or document content reaches the logs, and that
// WebSocket lines carry the upgrade request's ID.
func TestLogsContainNoSecretsAndCarryRequestIDs(t *testing.T) {
	logs := &syncBuffer{}
	s := newServer(t, nil)
	cfg := s.cfg
	a := New(cfg, collab.DefaultConfig(), testPool, slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	srv := httptest.NewServer(a.Router)
	t.Cleanup(func() {
		_ = a.ShutdownConnections(context.Background())
		srv.Close()
	})
	s = &server{t: t, app: a, srv: srv, cfg: cfg}

	const password, content = "password-123", "TOP-SECRET-DOCUMENT-TEXT"
	acc := s.register(t)
	doc := s.createDoc(t, acc, "logged")
	if r := login(s, acc.email, "wrong-password"); r.status != 401 { // a failed login is logged too
		t.Fatalf("bad login %d", r.status)
	}
	ws, _ := s.joinWS(t, doc, acc)
	_ = ws.WriteJSON(map[string]any{"type": "update", "client_msg_id": 1, "data": []byte(content)})
	if m, err := wsRead(t, ws); err != nil || m.Type != "committed" {
		t.Fatalf("commit: %+v %v", m, err)
	}
	if r := s.do("POST", "/api/auth/logout", nil, acc.cookie); r.status != 204 {
		t.Fatalf("logout %d", r.status)
	}
	expectClose(t, ws, collab.CloseUnauthenticated)

	var out string
	for range 100 { // the "left" line is written after the close frame
		if out = logs.String(); strings.Contains(out, `"msg":"left"`) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	for _, secret := range []string{password, "wrong-password", acc.cookie.Value, acc.email, content} {
		if strings.Contains(out, secret) {
			t.Errorf("logs contain %q", secret)
		}
	}
	// The data field is base64 on the wire; check that form too.
	if strings.Contains(out, base64.StdEncoding.EncodeToString([]byte(content))) {
		t.Error("logs contain the update payload")
	}
	ids := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("not JSON: %q", line)
		}
		if m["msg"] == "joined" || m["msg"] == "left" {
			id, _ := m["request_id"].(string)
			if id == "" {
				t.Fatalf("%v has no request_id", m)
			}
			ids[id] = true
		}
	}
	if len(ids) != 1 {
		t.Fatalf("joined/left request ids %v, want the one upgrade request", ids)
	}
}

// Week 7: the pool's state is reported, so exhaustion can be seen in logs.
func TestPoolStatsReportTheConnectionPool(t *testing.T) {
	s := newServer(t, nil)
	s.register(t) // uses the pool
	p := s.app.PoolStats()
	if p.Max <= 0 || p.Acquired+p.Idle > p.Total {
		t.Fatalf("pool stats %+v", p)
	}
	conn, err := testPool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if got := s.app.PoolStats().Acquired; got < 1 {
		t.Fatalf("acquired %d while a connection is held", got)
	}
}
