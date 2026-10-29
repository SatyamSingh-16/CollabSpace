package httpx

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
