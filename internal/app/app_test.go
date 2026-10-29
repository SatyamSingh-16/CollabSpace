package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"

	"collabspace/internal/collab"
	"collabspace/internal/config"
	"collabspace/internal/store"
	"collabspace/internal/testdb"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	testdb.Run(m, func(p *pgxpool.Pool) { testPool = p })
}

const origin = "http://app.test"

type server struct {
	t   *testing.T
	app *App
	srv *httptest.Server
	cfg config.Config
}

func newServer(t *testing.T, mutate func(*config.Config)) *server {
	t.Helper()
	cfg := config.Config{
		AllowedOrigins: []string{origin},
		CookieSecure:   true,
		SessionTTL:     time.Hour,
		ReadTimeout:    15 * time.Second,
		WriteTimeout:   30 * time.Second,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	a := New(cfg, collab.DefaultConfig(), testPool, slog.New(slog.DiscardHandler))
	srv := httptest.NewUnstartedServer(a.Router)
	srv.Config.ReadTimeout = cfg.ReadTimeout
	srv.Config.WriteTimeout = cfg.WriteTimeout
	srv.Start()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = a.ShutdownConnections(ctx)
		srv.Close()
	})
	return &server{t: t, app: a, srv: srv, cfg: cfg}
}

type response struct {
	status  int
	body    map[string]any
	raw     string
	cookies []*http.Cookie
	header  http.Header
}

// do sends a request like a same-origin browser would: an Origin header on
// state-changing requests, JSON bodies, and the session cookie if given.
func (s *server) do(method, path string, body any, cookie *http.Cookie, opts ...func(*http.Request)) response {
	s.t.Helper()
	var rdr io.Reader
	if body != nil {
		if raw, ok := body.(string); ok {
			rdr = strings.NewReader(raw)
		} else {
			b, _ := json.Marshal(body)
			rdr = bytes.NewReader(b)
		}
	}
	req, _ := http.NewRequest(method, s.srv.URL+path, rdr)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if method != http.MethodGet {
		req.Header.Set("Origin", origin)
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	for _, o := range opts {
		o(req)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		s.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	r := response{status: res.StatusCode, raw: string(raw), cookies: res.Cookies(), header: res.Header}
	_ = json.Unmarshal(raw, &r.body)
	return r
}

func (r response) session() *http.Cookie {
	for _, c := range r.cookies {
		if strings.HasSuffix(c.Name, "collabspace_session") { // __Host- prefixed when Secure
			return c
		}
	}
	return nil
}

func (r response) field(path ...string) any {
	var v any = r.body
	for _, p := range path {
		m, _ := v.(map[string]any)
		v = m[p]
	}
	return v
}

type account struct {
	id     string
	email  string
	cookie *http.Cookie
}

func uniqueEmail() string { return "u-" + uuid.NewString()[:13] + "@example.test" }

func (s *server) register(t *testing.T) account {
	t.Helper()
	email := uniqueEmail()
	r := s.do("POST", "/api/auth/register", map[string]string{"email": email, "password": "password-123", "display_name": "Test User"}, nil)
	if r.status != http.StatusCreated || r.session() == nil {
		t.Fatalf("register: %d %s", r.status, r.raw)
	}
	return account{id: r.field("user", "id").(string), email: email, cookie: r.session()}
}

func (s *server) createDoc(t *testing.T, owner account, title string) string {
	t.Helper()
	r := s.do("POST", "/api/documents", map[string]string{"title": title}, owner.cookie)
	if r.status != http.StatusCreated {
		t.Fatalf("create document: %d %s", r.status, r.raw)
	}
	return r.field("document", "id").(string)
}

func (s *server) share(t *testing.T, owner account, docID, email, role string) response {
	t.Helper()
	return s.do("PUT", "/api/documents/"+docID+"/members", map[string]string{"email": email, "role": role}, owner.cookie)
}

// --- health ---

func TestHealthAndReadiness(t *testing.T) {
	s := newServer(t, nil)
	if r := s.do("GET", "/healthz", nil, nil); r.status != 200 {
		t.Fatalf("healthz %d", r.status)
	}
	if r := s.do("GET", "/readyz", nil, nil); r.status != 200 {
		t.Fatalf("readyz %d %s", r.status, r.raw)
	}
	s.app.BeginShutdown()
	if r := s.do("GET", "/readyz", nil, nil); r.status != 503 {
		t.Fatalf("readyz while shutting down: %d", r.status)
	}
	if r := s.do("GET", "/healthz", nil, nil); r.status != 200 {
		t.Fatalf("healthz must not depend on readiness: %d", r.status)
	}
}

func TestReadinessFailsWithoutDatabase(t *testing.T) {
	dead, err := pgxpool.New(context.Background(), testPool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	dead.Close()
	a := New(config.Config{AllowedOrigins: []string{origin}, SessionTTL: time.Hour}, collab.DefaultConfig(), dead, slog.New(slog.DiscardHandler))
	rec := httptest.NewRecorder()
	a.Router.ServeHTTP(rec, httptest.NewRequest("GET", "/readyz", nil))
	if rec.Code != 503 || strings.Contains(rec.Body.String(), "closed") {
		t.Fatalf("readyz without database: %d %s (must be 503 and not leak the error)", rec.Code, rec.Body.String())
	}
}

// --- registration and login ---

func TestRegisterCreatesAccountAndSecureSession(t *testing.T) {
	s := newServer(t, nil)
	email := uniqueEmail()
	r := s.do("POST", "/api/auth/register", map[string]string{"email": "  " + strings.ToUpper(email), "password": "s3cret-password", "display_name": " Ada "}, nil)
	if r.status != http.StatusCreated {
		t.Fatalf("register: %d %s", r.status, r.raw)
	}
	if r.field("user", "email") != email || r.field("user", "display_name") != "Ada" {
		t.Fatalf("user %v", r.body)
	}
	if strings.Contains(r.raw, "password") || strings.Contains(r.raw, "argon2") {
		t.Fatalf("response leaks password material: %s", r.raw)
	}

	c := r.session()
	if c == nil {
		t.Fatal("no session cookie")
	}
	if c.Name != "__Host-collabspace_session" || !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteLaxMode || c.Path != "/" || c.Domain != "" {
		t.Fatalf("cookie attributes: %+v", c)
	}
	if c.MaxAge < 3500 || c.MaxAge > 3600 {
		t.Fatalf("cookie MaxAge %d, want about the 1h session TTL", c.MaxAge)
	}

	// The database holds only hashes.
	ctx := context.Background()
	sum := sha256.Sum256([]byte(c.Value))
	var n int
	_ = testPool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE token_hash = $1`, sum[:]).Scan(&n)
	var tokenStored int
	_ = testPool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE token_hash = $1`, []byte(c.Value)).Scan(&tokenStored)
	if n != 1 || tokenStored != 0 {
		t.Fatalf("sessions by hash %d, by raw token %d; want 1, 0", n, tokenStored)
	}
	var pwHash string
	_ = testPool.QueryRow(ctx, `SELECT password_hash FROM users WHERE email = $1`, email).Scan(&pwHash)
	if !strings.HasPrefix(pwHash, "$argon2id$") || strings.Contains(pwHash, "s3cret") {
		t.Fatalf("stored password hash %q", pwHash)
	}

	if me := s.do("GET", "/api/auth/me", nil, c); me.status != 200 || me.field("user", "email") != email {
		t.Fatalf("me: %d %s", me.status, me.raw)
	}
}

func TestCookieSecureFlagFollowsConfig(t *testing.T) {
	s := newServer(t, func(c *config.Config) { c.CookieSecure = false })
	// __Host- requires Secure, so plain-HTTP development uses the bare name.
	if c := s.register(t).cookie; c.Secure || !c.HttpOnly || c.Name != "collabspace_session" {
		t.Fatalf("local-dev cookie: %+v", c)
	}
}

func TestRegisterRejectsInvalidInput(t *testing.T) {
	s := newServer(t, nil)
	cases := []struct {
		name   string
		body   any
		status int
		opts   []func(*http.Request)
	}{
		{"bad email", map[string]string{"email": "not-an-email", "password": "password-123", "display_name": "x"}, 400, nil},
		{"short password", map[string]string{"email": uniqueEmail(), "password": "short", "display_name": "x"}, 400, nil},
		{"huge password", map[string]string{"email": uniqueEmail(), "password": strings.Repeat("p", 300), "display_name": "x"}, 400, nil},
		{"blank name", map[string]string{"email": uniqueEmail(), "password": "password-123", "display_name": "  "}, 400, nil},
		{"unknown field", map[string]string{"email": uniqueEmail(), "password": "password-123", "display_name": "x", "role": "admin"}, 400, nil},
		{"two objects", `{"email":"a@b.co"}{"x":1}`, 400, nil},
		{"not JSON", "email=a@b.co", 400, nil},
		{"body over 64 KiB", map[string]string{"email": uniqueEmail(), "password": "password-123", "display_name": strings.Repeat("x", 70<<10)}, 413, nil},
		{"wrong content type", map[string]string{"email": uniqueEmail()}, 415, []func(*http.Request){func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }}},
	}
	for _, tc := range cases {
		r := s.do("POST", "/api/auth/register", tc.body, nil, tc.opts...)
		if r.status != tc.status || r.session() != nil {
			t.Errorf("%s: %d %s (want %d, no cookie)", tc.name, r.status, r.raw, tc.status)
		}
	}
}

func TestDuplicateEmailIsRejectedCaseInsensitively(t *testing.T) {
	s := newServer(t, nil)
	email := uniqueEmail()
	body := func(e string) map[string]string {
		return map[string]string{"email": e, "password": "password-123", "display_name": "x"}
	}
	if r := s.do("POST", "/api/auth/register", body(email), nil); r.status != 201 {
		t.Fatalf("first: %d", r.status)
	}
	if r := s.do("POST", "/api/auth/register", body(" "+strings.ToUpper(email)), nil); r.status != http.StatusConflict {
		t.Fatalf("duplicate: %d %s", r.status, r.raw)
	}
}

func TestLoginSuccessAndGenericFailure(t *testing.T) {
	s := newServer(t, nil)
	a := s.register(t)

	ok := s.do("POST", "/api/auth/login", map[string]string{"email": strings.ToUpper(a.email), "password": "password-123"}, nil)
	if ok.status != 200 || ok.session() == nil || ok.session().Value == a.cookie.Value {
		t.Fatalf("login: %d %s", ok.status, ok.raw)
	}
	if me := s.do("GET", "/api/auth/me", nil, ok.session()); me.status != 200 || me.field("user", "id") != a.id {
		t.Fatalf("me with login cookie: %d", me.status)
	}

	wrongPassword := s.do("POST", "/api/auth/login", map[string]string{"email": a.email, "password": "wrong-password"}, nil)
	unknownEmail := s.do("POST", "/api/auth/login", map[string]string{"email": uniqueEmail(), "password": "password-123"}, nil)
	if wrongPassword.status != 401 || unknownEmail.status != 401 || wrongPassword.raw != unknownEmail.raw {
		t.Fatalf("failures must be identical: %d %q vs %d %q", wrongPassword.status, wrongPassword.raw, unknownEmail.status, unknownEmail.raw)
	}
	if wrongPassword.session() != nil || unknownEmail.session() != nil {
		t.Fatal("failed login set a cookie")
	}
}

func TestUnauthenticatedRequestsAreRejected(t *testing.T) {
	s := newServer(t, nil)
	garbage := &http.Cookie{Name: "__Host-collabspace_session", Value: "forged-token"}
	for _, c := range []*http.Cookie{nil, garbage} {
		for _, req := range []struct{ method, path string }{
			{"GET", "/api/auth/me"}, {"GET", "/api/documents"}, {"POST", "/api/documents"}, {"GET", "/api/documents/" + uuid.NewString()},
		} {
			var body any
			if req.method == "POST" {
				body = map[string]string{"title": "x"}
			}
			if r := s.do(req.method, req.path, body, c); r.status != 401 {
				t.Errorf("%s %s (cookie %v): %d", req.method, req.path, c != nil, r.status)
			}
		}
	}
}

func TestLogoutRevokesTheSession(t *testing.T) {
	s := newServer(t, nil)
	a := s.register(t)
	doc := s.createDoc(t, a, "mine")

	r := s.do("POST", "/api/auth/logout", nil, a.cookie)
	if r.status != 204 || r.session() == nil || r.session().MaxAge >= 0 {
		t.Fatalf("logout: %d, cookie %+v (want it cleared)", r.status, r.session())
	}
	if me := s.do("GET", "/api/auth/me", nil, a.cookie); me.status != 401 {
		t.Fatalf("old cookie after logout: %d", me.status)
	}
	if _, resp, err := s.dialWS(doc, a.cookie, origin); err == nil || resp.StatusCode != 401 {
		t.Fatalf("websocket with revoked session: %v %v", err, resp)
	}
	// Logging out again is harmless.
	if r := s.do("POST", "/api/auth/logout", nil, a.cookie); r.status != 204 {
		t.Fatalf("second logout: %d", r.status)
	}
}

func TestExpiredSessionIsRejected(t *testing.T) {
	s := newServer(t, nil)
	a := s.register(t)
	doc := s.createDoc(t, a, "mine")
	sum := sha256.Sum256([]byte(a.cookie.Value))
	if _, err := testPool.Exec(context.Background(), `
		UPDATE sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second'
		WHERE token_hash = $1`, sum[:]); err != nil {
		t.Fatal(err)
	}
	if me := s.do("GET", "/api/auth/me", nil, a.cookie); me.status != 401 {
		t.Fatalf("expired session: %d", me.status)
	}
	if _, resp, err := s.dialWS(doc, a.cookie, origin); err == nil || resp.StatusCode != 401 {
		t.Fatalf("websocket with expired session: %v %v", err, resp)
	}
}

func TestForeignOriginCannotChangeState(t *testing.T) {
	s := newServer(t, nil)
	a := s.register(t)
	evil := func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }
	if r := s.do("POST", "/api/documents", map[string]string{"title": "x"}, a.cookie, evil); r.status != 403 {
		t.Fatalf("cross-origin POST: %d", r.status)
	}
	if r := s.do("POST", "/api/auth/login", map[string]string{"email": a.email, "password": "password-123"}, nil, evil); r.status != 403 {
		t.Fatalf("cross-origin login: %d", r.status)
	}
	if r := s.do("GET", "/api/documents", nil, a.cookie, evil); r.status != 200 {
		t.Fatalf("GET is not state-changing: %d", r.status)
	}
}

// --- documents and authorization ---

func TestDocumentsAreIsolatedBetweenUsers(t *testing.T) {
	s := newServer(t, nil)
	alice, bob := s.register(t), s.register(t)
	doc := s.createDoc(t, alice, "Alice's plan")

	list := s.do("GET", "/api/documents", nil, alice.cookie)
	docs, _ := list.field("documents").([]any)
	if len(docs) != 1 || docs[0].(map[string]any)["role"] != "owner" || docs[0].(map[string]any)["title"] != "Alice's plan" {
		t.Fatalf("alice's list: %s", list.raw)
	}
	if r := s.do("GET", "/api/documents", nil, bob.cookie); len(r.field("documents").([]any)) != 0 {
		t.Fatalf("bob sees: %s", r.raw)
	}
	for _, path := range []string{"/api/documents/" + doc, "/api/documents/" + uuid.NewString(), "/api/documents/not-a-uuid"} {
		if r := s.do("GET", path, nil, bob.cookie); r.status != 404 {
			t.Errorf("bob GET %s: %d", path, r.status)
		}
	}
	if r := s.share(t, bob, doc, bob.email, "editor"); r.status != 404 {
		t.Fatalf("bob sharing alice's document with himself: %d %s", r.status, r.raw)
	}
	// Documents from before Week 2 have no owner or members: nobody can reach them.
	legacy := uuid.New()
	if err := store.New(testPool).CreateDocument(context.Background(), legacy, "legacy"); err != nil {
		t.Fatal(err)
	}
	if r := s.do("GET", "/api/documents/"+legacy.String(), nil, alice.cookie); r.status != 404 {
		t.Fatalf("legacy document: %d", r.status)
	}
}

func TestSharingAndRoles(t *testing.T) {
	s := newServer(t, nil)
	alice, bob, carol := s.register(t), s.register(t), s.register(t)
	doc := s.createDoc(t, alice, "shared")

	if r := s.share(t, alice, doc, strings.ToUpper(bob.email), "viewer"); r.status != 200 {
		t.Fatalf("share as viewer: %d %s", r.status, r.raw)
	}
	if r := s.do("GET", "/api/documents/"+doc, nil, bob.cookie); r.status != 200 || r.field("document", "role") != "viewer" {
		t.Fatalf("bob after sharing: %d %s", r.status, r.raw)
	}
	if r := s.share(t, bob, doc, carol.email, "editor"); r.status != 403 {
		t.Fatalf("a viewer sharing: %d", r.status)
	}
	if r := s.share(t, alice, doc, bob.email, "editor"); r.status != 200 {
		t.Fatalf("promote bob: %d", r.status)
	}
	if r := s.do("GET", "/api/documents/"+doc, nil, bob.cookie); r.field("document", "role") != "editor" {
		t.Fatalf("bob after promotion: %s", r.raw)
	}
	if r := s.share(t, bob, doc, carol.email, "viewer"); r.status != 403 {
		t.Fatalf("an editor sharing: %d", r.status)
	}
	if r := s.share(t, alice, doc, alice.email, "viewer"); r.status != 409 {
		t.Fatalf("owner demoting herself: %d", r.status)
	}
	if r := s.share(t, alice, doc, uniqueEmail(), "viewer"); r.status != 404 {
		t.Fatalf("unknown user: %d", r.status)
	}
	if r := s.share(t, alice, doc, carol.email, "owner"); r.status != 400 {
		t.Fatalf("granting owner: %d", r.status)
	}
}

func TestCreateDocumentValidation(t *testing.T) {
	s := newServer(t, nil)
	a := s.register(t)
	for _, title := range []string{"", "   ", strings.Repeat("t", 201)} {
		if r := s.do("POST", "/api/documents", map[string]string{"title": title}, a.cookie); r.status != 400 {
			t.Errorf("title %q: %d", title, r.status)
		}
	}
}

// --- WebSocket ---

func (s *server) dialWS(docID string, cookie *http.Cookie, origin string) (*websocket.Conn, *http.Response, error) {
	h := http.Header{}
	if cookie != nil {
		h.Set("Cookie", cookie.Name+"="+cookie.Value)
	}
	if origin != "" {
		h.Set("Origin", origin)
	}
	url := "ws" + strings.TrimPrefix(s.srv.URL, "http") + "/ws/documents/" + docID
	return websocket.DefaultDialer.Dial(url, h)
}

type wsMsg struct {
	Type        string `json:"type"`
	Seq         int64  `json:"seq"`
	HeadSeq     int64  `json:"head_seq"`
	Role        string `json:"role"`
	UserID      string `json:"user_id"`
	ClientMsgID int64  `json:"client_msg_id"`
	Data        []byte `json:"data"`
	Users       []struct {
		UserID      string `json:"user_id"`
		DisplayName string `json:"display_name"`
		Role        string `json:"role"`
	} `json:"users"`
}

// wsRead returns the next frame that is not presence (Week 4); presence
// tests read raw frames with wsReadAny.
func wsRead(t *testing.T, ws *websocket.Conn) (wsMsg, error) {
	t.Helper()
	for {
		m, err := wsReadAny(t, ws)
		if err != nil || m.Type != "presence" {
			return m, err
		}
	}
}

func wsReadAny(t *testing.T, ws *websocket.Conn) (wsMsg, error) {
	t.Helper()
	_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	var m wsMsg
	_, b, err := ws.ReadMessage()
	if err == nil {
		err = json.Unmarshal(b, &m)
	}
	return m, err
}

// joinWS connects, joins at after_seq 0 and reads up to "synced".
func (s *server) joinWS(t *testing.T, docID string, a account) (*websocket.Conn, wsMsg) {
	t.Helper()
	ws, resp, err := s.dialWS(docID, a.cookie, origin)
	if err != nil {
		t.Fatalf("dial: %v (%v)", err, resp)
	}
	t.Cleanup(func() { ws.Close() })
	_ = ws.WriteJSON(map[string]any{"type": "join", "v": 1, "client_id": uuid.NewString(), "after_seq": 0})
	joined, err := wsRead(t, ws)
	if err != nil || joined.Type != "joined" {
		t.Fatalf("joined: %+v %v", joined, err)
	}
	for {
		m, err := wsRead(t, ws)
		if err != nil {
			t.Fatal(err)
		}
		if m.Type == "synced" {
			return ws, joined
		}
	}
}

func TestWebSocketHandshakeSecurity(t *testing.T) {
	s := newServer(t, nil)
	alice, bob := s.register(t), s.register(t)
	doc := s.createDoc(t, alice, "ws")

	cases := []struct {
		name   string
		cookie *http.Cookie
		origin string
		want   int
	}{
		{"no session", nil, origin, 401},
		{"forged session", &http.Cookie{Name: "__Host-collabspace_session", Value: "forged"}, origin, 401},
		{"not a member", bob.cookie, origin, 404},
		{"foreign origin", alice.cookie, "https://evil.example", 403},
	}
	for _, tc := range cases {
		_, resp, err := s.dialWS(doc, tc.cookie, tc.origin)
		if err == nil || resp == nil || resp.StatusCode != tc.want {
			t.Errorf("%s: err %v, resp %v; want HTTP %d before upgrade", tc.name, err, resp, tc.want)
		}
	}
	if _, resp, err := s.dialWS(uuid.NewString(), alice.cookie, origin); err == nil || resp.StatusCode != 404 {
		t.Errorf("unknown document: %v %v", err, resp)
	}
}

func TestCollaborationWithRealSessionsAndRoles(t *testing.T) {
	s := newServer(t, nil)
	owner, editor, viewer := s.register(t), s.register(t), s.register(t)
	doc := s.createDoc(t, owner, "collab")
	s.share(t, owner, doc, editor.email, "editor")
	s.share(t, owner, doc, viewer.email, "viewer")

	ownerWS, joined := s.joinWS(t, doc, owner)
	if joined.Role != "owner" {
		t.Fatalf("owner joined as %q", joined.Role)
	}
	editorWS, _ := s.joinWS(t, doc, editor)
	viewerWS, vj := s.joinWS(t, doc, viewer)
	if vj.Role != "viewer" {
		t.Fatalf("viewer joined as %q", vj.Role)
	}

	// The editor writes; the owner and the viewer receive it, attributed to
	// the editor's server-side identity.
	_ = editorWS.WriteJSON(map[string]any{"type": "update", "client_msg_id": 1, "data": []byte{1, 2, 3}})
	if m, err := wsRead(t, editorWS); err != nil || m.Type != "committed" || m.Seq != 1 {
		t.Fatalf("editor ack: %+v %v", m, err)
	}
	for _, ws := range []*websocket.Conn{ownerWS, viewerWS} {
		if m, err := wsRead(t, ws); err != nil || m.Type != "update" || m.UserID != editor.id {
			t.Fatalf("broadcast: %+v %v (want update from %s)", m, err, editor.id)
		}
	}

	// The viewer may not write: the server closes with 4003.
	_ = viewerWS.WriteJSON(map[string]any{"type": "update", "client_msg_id": 1, "data": []byte{9}})
	_, err := wsRead(t, viewerWS)
	var ce *websocket.CloseError
	if !errors.As(err, &ce) || ce.Code != collab.CloseForbidden {
		t.Fatalf("viewer write: %v, want close %d", err, collab.CloseForbidden)
	}
	var head int64
	_ = testPool.QueryRow(context.Background(), `SELECT head_seq FROM documents WHERE id = $1`, doc).Scan(&head)
	if head != 1 {
		t.Fatalf("head %d after a rejected viewer write, want 1", head)
	}
}

// http.Server's ReadTimeout and WriteTimeout also put deadlines on
// connections that become WebSockets. The collab package sets its own
// deadline before every socket operation, so a long-lived connection must
// outlive both timeouts.
//
// Setup runs on a normal server: WriteTimeout bounds the whole handler, and
// Argon2id hashing during registration takes longer than 150 ms under -race
// (the first version of this test failed exactly there). Accounts and
// sessions live in the shared database, so they work on both servers.
func TestWebSocketOutlivesHTTPServerTimeouts(t *testing.T) {
	setup := newServer(t, nil)
	a, b := setup.register(t), setup.register(t)
	doc := setup.createDoc(t, a, "long-lived")
	setup.share(t, a, doc, b.email, "editor")

	s := newServer(t, func(c *config.Config) {
		c.ReadTimeout = 150 * time.Millisecond
		c.WriteTimeout = 150 * time.Millisecond
	})
	wsA, _ := s.joinWS(t, doc, a)
	wsB, _ := s.joinWS(t, doc, b)

	time.Sleep(500 * time.Millisecond) // > 3× both server timeouts

	_ = wsA.WriteJSON(map[string]any{"type": "update", "client_msg_id": 1, "data": []byte{7}})
	if m, err := wsRead(t, wsA); err != nil || m.Type != "committed" {
		t.Fatalf("after idle: %+v %v", m, err)
	}
	if m, err := wsRead(t, wsB); err != nil || m.Type != "update" {
		t.Fatalf("after idle: %+v %v", m, err)
	}
}

// --- fixes from the Week 2 security review ---

// Cookie tossing: a sibling subdomain can set a cookie named
// "collabspace_session" for the parent domain, but cannot set a __Host-
// cookie. With Secure cookies the server reads only the __Host- name, so a
// tossed cookie, even one holding a valid token, is ignored.
func TestTossedUnprefixedCookieIsIgnored(t *testing.T) {
	s := newServer(t, nil)
	attacker := s.register(t)
	tossed := &http.Cookie{Name: "collabspace_session", Value: attacker.cookie.Value}
	if r := s.do("GET", "/api/auth/me", nil, tossed); r.status != 401 {
		t.Fatalf("unprefixed cookie accepted: %d %s", r.status, r.raw)
	}
}

// Logout must clear the cookie even when the database is unreachable (and
// report the failure), so a shared computer is not left signed in.
func TestLogoutClearsCookieEvenWhenRevocationFails(t *testing.T) {
	dead, err := pgxpool.New(context.Background(), testPool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	dead.Close()
	a := New(config.Config{AllowedOrigins: []string{origin}, CookieSecure: true, SessionTTL: time.Hour}, collab.DefaultConfig(), dead, slog.New(slog.DiscardHandler))
	req := httptest.NewRequest("POST", "/api/auth/logout", nil)
	req.Header.Set("Origin", origin)
	req.AddCookie(&http.Cookie{Name: "__Host-collabspace_session", Value: "some-token"})
	rec := httptest.NewRecorder()
	a.Router.ServeHTTP(rec, req)

	res := rec.Result()
	cleared := false
	for _, c := range res.Cookies() {
		cleared = cleared || (c.Name == "__Host-collabspace_session" && c.MaxAge < 0)
	}
	if res.StatusCode != 500 || !cleared {
		t.Fatalf("status %d, cookie cleared %v; want 500 and a cleared cookie", res.StatusCode, cleared)
	}
}

func TestSessionJanitorDeletesOnlyExpiredSessions(t *testing.T) {
	s := newServer(t, nil)
	live, expired := s.register(t), s.register(t)
	ctx := context.Background()
	expiredHash := sha256.Sum256([]byte(expired.cookie.Value))
	if _, err := testPool.Exec(ctx, `
		UPDATE sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
		WHERE token_hash = $1`, expiredHash[:]); err != nil {
		t.Fatal(err)
	}
	n, err := s.app.auth.PurgeExpiredSessions(ctx)
	if err != nil || n < 1 {
		t.Fatalf("purged %d, %v", n, err)
	}
	var left int
	_ = testPool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE token_hash = $1`, expiredHash[:]).Scan(&left)
	if left != 0 {
		t.Fatal("expired session still stored")
	}
	if r := s.do("GET", "/api/auth/me", nil, live.cookie); r.status != 200 {
		t.Fatalf("live session purged: %d", r.status)
	}
}
