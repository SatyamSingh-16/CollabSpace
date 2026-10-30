package httpx

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func TestRequestIDKeepsPlainIDsAndReplacesOthers(t *testing.T) {
	var seen string
	h := RequestID(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { seen = middleware.GetReqID(r.Context()) }))
	for in, keep := range map[string]bool{
		"":                           false,
		"abc-123_X.y":                true,
		strings.Repeat("a", 65):      false, // too long
		"evil\nINFO forged log line": false,
		`{"json":"injection"}`:       false,
	} {
		req := httptest.NewRequest("GET", "/", nil)
		if in != "" {
			req.Header.Set("X-Request-Id", in)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if got := rec.Header().Get("X-Request-Id"); got != seen || seen == "" {
			t.Fatalf("%q: header %q, context %q", in, got, seen)
		}
		if (seen == in) != keep {
			t.Errorf("%q: got %q, keep=%v", in, seen, keep)
		}
	}
}

func TestRecovererLogsOneLineAndAnswers500(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&buf, nil))
	h := RequestID(Recoverer(log)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") })))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/x", nil))
	if rec.Code != 500 || !strings.Contains(rec.Body.String(), "internal error") || strings.Contains(rec.Body.String(), "boom") {
		t.Fatalf("response %d %q", rec.Code, rec.Body)
	}
	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatalf("log is not one JSON line: %q", buf.String())
	}
	if line["msg"] != "panic" || line["panic"] != "boom" || line["request_id"] != rec.Header().Get("X-Request-Id") || !strings.Contains(line["stack"].(string), "httpx_test.go") {
		t.Fatalf("log line %v", line)
	}
}

func TestRequireAllowedOriginCORS(t *testing.T) {
	allowed := []string{"https://app.example.com"}
	h := RequireAllowedOrigin(allowed)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))

	// 1. Allowed origin GET receives CORS headers
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/test", nil)
	req.Header.Set("Origin", "https://app.example.com")
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "https://app.example.com" {
		t.Fatalf("unexpected origin header: %q", rec.Header().Get("Access-Control-Allow-Origin"))
	}
	if rec.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("missing credentials header")
	}

	// 2. Allowed origin OPTIONS receives preflight headers and 204
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("OPTIONS", "/api/test", nil)
	req.Header.Set("Origin", "https://app.example.com")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
	if !strings.Contains(rec.Header().Get("Access-Control-Allow-Methods"), "POST") {
		t.Fatalf("unexpected methods header: %q", rec.Header().Get("Access-Control-Allow-Methods"))
	}

	// 3. Untrusted origin OPTIONS receives 403
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("OPTIONS", "/api/test", nil)
	req.Header.Set("Origin", "https://evil.com")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}

	// 4. Untrusted origin POST receives 403
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/test", nil)
	req.Header.Set("Origin", "https://evil.com")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}

	// 5. Untrusted origin GET is allowed (CSRF spec) but receives NO CORS headers
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/test", nil)
	req.Header.Set("Origin", "https://evil.com")
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("untrusted origin should not get Access-Control-Allow-Origin")
	}
}

func TestServeFrontend(t *testing.T) {
	mockFS := fstest.MapFS{
		"index.html":          &fstest.MapFile{Data: []byte("<html>app</html>")},
		"assets/index-123.js": &fstest.MapFile{Data: []byte("console.log('test')")},
		"theme-init.js":       &fstest.MapFile{Data: []byte("theme()")},
	}
	r := chi.NewRouter()
	ServeFrontend(r, mockFS)

	// 1. Root serves index.html with no-cache
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/", nil)
	r.ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "<html>app</html>") {
		t.Fatalf("expected index.html, got %d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("expected no-cache header, got %s", rec.Header().Get("Cache-Control"))
	}

	// 2. SPA client-side routes (e.g. /workspaces, /d/123) fall back to index.html with no-cache
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/d/123", nil)
	r.ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "<html>app</html>") {
		t.Fatalf("expected fallback to index.html, got %d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("expected no-cache header, got %s", rec.Header().Get("Cache-Control"))
	}

	// 3. Static assets get immutable cache header
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/assets/index-123.js", nil)
	r.ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "console.log('test')") {
		t.Fatalf("expected asset, got %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("expected immutable cache header, got %s", rec.Header().Get("Cache-Control"))
	}
}
