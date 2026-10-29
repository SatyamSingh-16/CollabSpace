package app

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"collabspace/internal/collab"
	"collabspace/internal/config"
	"collabspace/internal/documents"
	"collabspace/internal/ratelimit"
	"collabspace/internal/store"
	"collabspace/internal/testdb"
)

func expectClose(t *testing.T, ws *websocket.Conn, code int) {
	t.Helper()
	for {
		_, err := wsRead(t, ws)
		if err == nil {
			continue // drain ordinary messages
		}
		var ce *websocket.CloseError
		if !errors.As(err, &ce) || ce.Code != code {
			t.Fatalf("connection ended with %v, want close %d", err, code)
		}
		return
	}
}

func login(s *server, email, password string, opts ...func(*http.Request)) response {
	return s.do("POST", "/api/auth/login", map[string]string{"email": email, "password": password}, nil, opts...)
}

func fromIP(ip string) func(*http.Request) {
	return func(r *http.Request) { r.Header.Set("X-Real-IP", ip) }
}

// --- Phase B: rate limiting ---

func TestLoginIsRateLimitedPerClientIP(t *testing.T) {
	s := newServer(t, func(c *config.Config) { c.RateLoginPerIP = ratelimit.Rule{Burst: 3, Window: time.Minute} })
	a := s.register(t)
	for i := range 3 {
		if r := login(s, a.email, "wrong-password"); r.status != 401 {
			t.Fatalf("attempt %d: %d", i+1, r.status)
		}
	}
	r := login(s, a.email, "password-123") // even the right password
	if r.status != 429 || r.session() != nil {
		t.Fatalf("4th attempt: %d %s", r.status, r.raw)
	}
	res := s.rawPost(t, "/api/auth/login", `{"email":"`+a.email+`","password":"password-123"}`, nil)
	retry, err := strconv.Atoi(res.Header.Get("Retry-After"))
	if res.StatusCode != 429 || err != nil || retry < 1 || retry > 20 {
		t.Fatalf("Retry-After %q (status %d), want 1..20 seconds", res.Header.Get("Retry-After"), res.StatusCode)
	}
	if strings.Contains(r.raw, a.email) {
		t.Fatal("429 response mentions the email")
	}
}

// Without a trusted proxy header, client-supplied forwarding headers must
// not let an attacker pose as many addresses.
func TestForwardingHeadersAreIgnoredUnlessTrusted(t *testing.T) {
	s := newServer(t, func(c *config.Config) { c.RateLoginPerIP = ratelimit.Rule{Burst: 2, Window: time.Minute} })
	a := s.register(t)
	statuses := []int{}
	for i := range 3 {
		ip := "198.51.100." + strconv.Itoa(i+1)
		r := login(s, a.email, "wrong-password", fromIP(ip), func(r *http.Request) { r.Header.Set("X-Forwarded-For", ip) })
		statuses = append(statuses, r.status)
	}
	if statuses[2] != 429 {
		t.Fatalf("statuses %v: spoofed headers bypassed the per-IP limit", statuses)
	}
}

// The per-account limit holds across addresses (with a trusted proxy
// header), and applies to unknown emails exactly like real ones.
func TestLoginIsRateLimitedPerAccountAcrossAddresses(t *testing.T) {
	s := newServer(t, func(c *config.Config) {
		c.TrustedProxyHeader = "X-Real-IP"
		c.RateLoginPerAccount = ratelimit.Rule{Burst: 2, Window: time.Minute}
	})
	a, other := s.register(t), s.register(t)
	got := []int{}
	for i := range 3 {
		got = append(got, login(s, a.email, "wrong-password", fromIP("203.0.113."+strconv.Itoa(i+1))).status)
	}
	if got[0] != 401 || got[1] != 401 || got[2] != 429 {
		t.Fatalf("statuses %v, want 401 401 429", got)
	}
	if r := login(s, other.email, "password-123", fromIP("203.0.113.9")); r.status != 200 {
		t.Fatalf("another account was affected: %d", r.status)
	}
	unknown := uniqueEmail()
	login(s, unknown, "x-password", fromIP("203.0.113.10"))
	login(s, unknown, "x-password", fromIP("203.0.113.11"))
	if r := login(s, unknown, "x-password", fromIP("203.0.113.12")); r.status != 429 {
		t.Fatalf("unknown account not limited the same way: %d", r.status)
	}
}

// Malformed requests spend tokens too: the limit is checked before the body
// is read, so garbage can't be used to probe or to burn CPU for free.
func TestRegistrationLimitCountsMalformedRequests(t *testing.T) {
	s := newServer(t, func(c *config.Config) { c.RateRegisterPerIP = ratelimit.Rule{Burst: 2, Window: time.Hour} })
	for i := range 2 {
		if r := s.do("POST", "/api/auth/register", "{not json", nil); r.status != 400 {
			t.Fatalf("malformed %d: %d", i+1, r.status)
		}
	}
	email := uniqueEmail()
	r := s.do("POST", "/api/auth/register", map[string]string{"email": email, "password": "password-123", "display_name": "x"}, nil)
	if r.status != 429 {
		t.Fatalf("valid registration after the limit: %d", r.status)
	}
	var n int
	_ = testPool.QueryRow(context.Background(), `SELECT count(*) FROM users WHERE email = $1`, email).Scan(&n)
	if n != 0 {
		t.Fatal("a rate-limited registration created the account")
	}
}

// rawPost exposes response headers (Retry-After).
func (s *server) rawPost(t *testing.T, path, body string, cookie *http.Cookie) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("POST", s.srv.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", origin)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res
}

// --- Phase C: live revocation ---

func TestLogoutClosesThatSessionsOpenWebSocketsOnly(t *testing.T) {
	s := newServer(t, nil)
	a := s.register(t)
	doc := s.createDoc(t, a, "revocation")
	second := login(s, a.email, "password-123").session() // another device
	wsFirst, _ := s.joinWS(t, doc, a)
	wsSecond, _ := s.joinWS(t, doc, account{id: a.id, email: a.email, cookie: second})

	if r := s.do("POST", "/api/auth/logout", nil, a.cookie); r.status != 204 {
		t.Fatalf("logout: %d", r.status)
	}
	expectClose(t, wsFirst, collab.CloseUnauthenticated)

	// The other session keeps working.
	_ = wsSecond.WriteJSON(map[string]any{"type": "update", "client_msg_id": 1, "data": []byte{1}})
	if m, err := wsRead(t, wsSecond); err != nil || m.Type != "committed" {
		t.Fatalf("other session after logout: %+v %v", m, err)
	}
}

func TestSessionExpiryClosesTheOpenWebSocket(t *testing.T) {
	s := newServer(t, func(c *config.Config) { c.SessionTTL = 1500 * time.Millisecond })
	a := s.register(t)
	doc := s.createDoc(t, a, "expiring")
	ws, _ := s.joinWS(t, doc, a)
	start := time.Now()
	expectClose(t, ws, collab.CloseUnauthenticated)
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("closed after %v, want about the remaining session lifetime", d)
	}
}

func TestRemovingAMemberClosesTheirConnection(t *testing.T) {
	s := newServer(t, nil)
	owner, bob := s.register(t), s.register(t)
	doc := s.createDoc(t, owner, "shared")
	s.share(t, owner, doc, bob.email, "editor")
	ownerWS, _ := s.joinWS(t, doc, owner)
	bobWS, _ := s.joinWS(t, doc, bob)

	if r := s.do("DELETE", "/api/documents/"+doc+"/members/"+bob.id, nil, owner.cookie); r.status != 204 {
		t.Fatalf("remove: %d %s", r.status, r.raw)
	}
	expectClose(t, bobWS, collab.CloseForbidden)
	if _, resp, err := s.dialWS(doc, bob.cookie, origin); err == nil || resp.StatusCode != 404 {
		t.Fatalf("bob reconnecting: %v %v", err, resp)
	}
	// The owner's connection is unaffected.
	_ = ownerWS.WriteJSON(map[string]any{"type": "update", "client_msg_id": 1, "data": []byte{1}})
	if m, err := wsRead(t, ownerWS); err != nil || m.Type != "committed" {
		t.Fatalf("owner after removing bob: %+v %v", m, err)
	}
}

func TestRoleChangeReconnectsWithTheNewRole(t *testing.T) {
	s := newServer(t, nil)
	owner, bob := s.register(t), s.register(t)
	doc := s.createDoc(t, owner, "roles")
	s.share(t, owner, doc, bob.email, "editor")
	bobWS, joined := s.joinWS(t, doc, bob)
	if joined.Role != "editor" {
		t.Fatalf("joined as %q", joined.Role)
	}

	s.share(t, owner, doc, bob.email, "viewer")
	expectClose(t, bobWS, collab.CloseResyncRequired) // "reconnect": the client rejoins
	bobWS, joined = s.joinWS(t, doc, bob)
	if joined.Role != "viewer" {
		t.Fatalf("rejoined as %q, want viewer", joined.Role)
	}
	_ = bobWS.WriteJSON(map[string]any{"type": "update", "client_msg_id": 1, "data": []byte{1}})
	expectClose(t, bobWS, collab.CloseForbidden)

	s.share(t, owner, doc, bob.email, "editor") // and back up
	bobWS, joined = s.joinWS(t, doc, bob)
	if joined.Role != "editor" {
		t.Fatalf("after promotion joined as %q", joined.Role)
	}
	_ = bobWS.WriteJSON(map[string]any{"type": "update", "client_msg_id": 1, "data": []byte{2}})
	if m, err := wsRead(t, bobWS); err != nil || m.Type != "committed" {
		t.Fatalf("editor again: %+v %v", m, err)
	}
}

// The race window: the handshake has already read "editor" from the
// database when the owner downgrades or removes the member, and only then
// does the client send its join. The join is refused with 4008 (resync);
// the reconnect's handshake reads the current truth from the database.
func TestPermissionChangeDuringTheHandshakeIsApplied(t *testing.T) {
	s := newServer(t, nil)
	owner, bob, carol := s.register(t), s.register(t), s.register(t)
	doc := s.createDoc(t, owner, "window")
	s.share(t, owner, doc, bob.email, "editor")
	s.share(t, owner, doc, carol.email, "editor")

	bobWS, _, err := s.dialWS(doc, bob.cookie, origin) // authorized as editor
	if err != nil {
		t.Fatal(err)
	}
	defer bobWS.Close()
	carolWS, _, err := s.dialWS(doc, carol.cookie, origin)
	if err != nil {
		t.Fatal(err)
	}
	defer carolWS.Close()

	s.share(t, owner, doc, bob.email, "viewer")
	if r := s.do("DELETE", "/api/documents/"+doc+"/members/"+carol.id, nil, owner.cookie); r.status != 204 {
		t.Fatalf("remove carol: %d", r.status)
	}

	_ = bobWS.WriteJSON(map[string]any{"type": "join", "v": 1, "client_id": uuid.NewString(), "after_seq": 0})
	expectClose(t, bobWS, collab.CloseResyncRequired)
	if _, joined := s.joinWS(t, doc, bob); joined.Role != "viewer" {
		t.Fatalf("bob after reconnecting: role %q, want viewer", joined.Role)
	}
	_ = carolWS.WriteJSON(map[string]any{"type": "join", "v": 1, "client_id": uuid.NewString(), "after_seq": 0})
	expectClose(t, carolWS, collab.CloseResyncRequired)
	if _, resp, err := s.dialWS(doc, carol.cookie, origin); err == nil || resp.StatusCode != 404 {
		t.Fatalf("carol reconnecting: %v %v, want 404", err, resp)
	}
}

// Week 3 review #1: logout is unauthenticated, so a request with a made-up
// cookie must not reach the hub's revocation list.
func TestLogoutWithUnknownTokenRevokesNothing(t *testing.T) {
	s := newServer(t, nil)
	a := s.register(t)
	var revoked []string
	s.app.auth.OnSessionRevoked(func(id string) { revoked = append(revoked, id) })

	for i := range 3 {
		forged := &http.Cookie{Name: "__Host-collabspace_session", Value: "forged-" + strconv.Itoa(i)}
		if r := s.do("POST", "/api/auth/logout", nil, forged); r.status != 204 {
			t.Fatalf("logout with forged cookie: %d", r.status)
		}
	}
	if len(revoked) != 0 {
		t.Fatalf("unknown tokens reached the hook: %v", revoked)
	}
	if r := s.do("POST", "/api/auth/logout", nil, a.cookie); r.status != 204 || len(revoked) != 1 {
		t.Fatalf("real logout: %d, hook calls %d (want 1)", r.status, len(revoked))
	}
}

func TestLogoutDuringTheHandshakeEndsTheConnection(t *testing.T) {
	s := newServer(t, nil)
	a := s.register(t)
	doc := s.createDoc(t, a, "handshake")
	ws, _, err := s.dialWS(doc, a.cookie, origin) // session checked here
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if r := s.do("POST", "/api/auth/logout", nil, a.cookie); r.status != 204 {
		t.Fatalf("logout: %d", r.status)
	}
	_ = ws.WriteJSON(map[string]any{"type": "join", "v": 1, "client_id": uuid.NewString(), "after_seq": 0})
	m, err := wsRead(t, ws)
	if err == nil {
		t.Fatalf("got %+v after logout; the connection should have ended", m)
	}
}

// --- Phase D: member management ---

func TestListAndRemoveMembers(t *testing.T) {
	s := newServer(t, nil)
	owner, bob, outsider := s.register(t), s.register(t), s.register(t)
	doc := s.createDoc(t, owner, "members")
	s.share(t, owner, doc, bob.email, "viewer")

	r := s.do("GET", "/api/documents/"+doc+"/members", nil, owner.cookie)
	members, _ := r.field("members").([]any)
	if r.status != 200 || len(members) != 2 || members[0].(map[string]any)["role"] != "owner" {
		t.Fatalf("list: %d %s", r.status, r.raw)
	}
	if r := s.do("GET", "/api/documents/"+doc+"/members", nil, bob.cookie); r.status != 403 {
		t.Fatalf("viewer listing members: %d", r.status)
	}
	if r := s.do("GET", "/api/documents/"+doc+"/members", nil, outsider.cookie); r.status != 404 {
		t.Fatalf("outsider listing members: %d", r.status)
	}
	if r := s.do("DELETE", "/api/documents/"+doc+"/members/"+owner.id, nil, owner.cookie); r.status != 409 {
		t.Fatalf("removing the owner: %d", r.status)
	}
	if r := s.do("DELETE", "/api/documents/"+doc+"/members/"+outsider.id, nil, owner.cookie); r.status != 404 {
		t.Fatalf("removing a non-member: %d", r.status)
	}
	if r := s.do("DELETE", "/api/documents/"+doc+"/members/"+owner.id, nil, bob.cookie); r.status != 403 {
		t.Fatalf("a viewer removing someone: %d", r.status)
	}
	if r := s.do("DELETE", "/api/documents/"+doc+"/members/"+bob.id, nil, owner.cookie); r.status != 204 {
		t.Fatalf("remove bob: %d", r.status)
	}
	if r := s.do("GET", "/api/documents/"+doc, nil, bob.cookie); r.status != 404 {
		t.Fatalf("bob after removal: %d", r.status)
	}
}

// --- Phase E: claiming a pre-accounts document ---

func TestClaimOrphanDocumentKeepsItsUpdates(t *testing.T) {
	ctx := context.Background()
	s := newServer(t, nil)
	owner := s.register(t)
	docs := documents.NewStore(testPool)

	legacy := uuid.New()
	st := store.New(testPool)
	if err := st.CreateDocument(ctx, legacy, "Week 1 document"); err != nil {
		t.Fatal(err)
	}
	author := testdb.NewUser(t, testPool)
	for i := int64(1); i <= 2; i++ {
		if _, err := st.AppendUpdate(ctx, store.AppendRequest{DocumentID: legacy, UserID: author, ClientID: uuid.New(), ClientMsgID: i, Payload: []byte{byte(i)}}); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := docs.ClaimOrphan(ctx, legacy, uniqueEmail()); !errors.Is(err, documents.ErrUserNotFound) {
		t.Fatalf("unknown email: %v", err)
	}
	if _, err := docs.ClaimOrphan(ctx, uuid.New(), owner.email); !errors.Is(err, documents.ErrNotFound) {
		t.Fatalf("unknown document: %v", err)
	}
	got, err := docs.ClaimOrphan(ctx, legacy, owner.email)
	if err != nil || got.String() != owner.id {
		t.Fatalf("claim: %v %v", got, err)
	}
	if _, err := docs.ClaimOrphan(ctx, legacy, owner.email); !errors.Is(err, documents.ErrAlreadyOwned) {
		t.Fatalf("second claim: %v", err)
	}

	if r := s.do("GET", "/api/documents/"+legacy.String(), nil, owner.cookie); r.status != 200 || r.field("document", "role") != "owner" {
		t.Fatalf("owner GET: %d %s", r.status, r.raw)
	}
	ws, resp, err := s.dialWS(legacy.String(), owner.cookie, origin)
	if err != nil {
		t.Fatalf("dial: %v %v", err, resp)
	}
	defer ws.Close()
	_ = ws.WriteJSON(map[string]any{"type": "join", "v": 1, "client_id": uuid.NewString(), "after_seq": 0})
	replayed := 0
	for {
		m, err := wsRead(t, ws)
		if err != nil {
			t.Fatal(err)
		}
		if m.Type == "update" {
			replayed++
		}
		if m.Type == "synced" {
			break
		}
	}
	if replayed != 2 {
		t.Fatalf("replayed %d updates after the claim, want 2", replayed)
	}
}
