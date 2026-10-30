// Package httpx holds the small HTTP helpers shared by the API handlers:
// JSON responses, strict JSON request decoding, request logging and the
// Origin check for state-changing requests.
package httpx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"regexp"
	"runtime/debug"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// MaxJSONBody bounds every JSON request body. API payloads are tiny; Yjs
// updates travel over the WebSocket, which has its own limit.
const MaxJSONBody = 64 << 10

func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Error writes {"error": msg}. msg must be safe to show to the client:
// never an internal error string.
func Error(w http.ResponseWriter, status int, msg string) {
	JSON(w, status, map[string]string{"error": msg})
}

// RequestError is a client mistake in the request itself.
type RequestError struct {
	Status int
	Msg    string
}

func (e *RequestError) Error() string { return e.Msg }

// Decode reads exactly one JSON object into dst. It requires a JSON content
// type, limits the body size, and rejects unknown fields and trailing data.
func Decode(w http.ResponseWriter, r *http.Request, dst any) error {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		return &RequestError{http.StatusUnsupportedMediaType, "Content-Type must be application/json"}
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, MaxJSONBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return &RequestError{http.StatusRequestEntityTooLarge, "request body too large"}
		}
		return &RequestError{http.StatusBadRequest, "invalid JSON body"}
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return &RequestError{http.StatusBadRequest, "request body must contain a single JSON object"}
	}
	return nil
}

// WriteDecodeError answers a Decode failure.
func WriteDecodeError(w http.ResponseWriter, err error) {
	var re *RequestError
	if errors.As(err, &re) {
		Error(w, re.Status, re.Msg)
		return
	}
	Error(w, http.StatusBadRequest, "invalid request")
}

// RequireAllowedOrigin handles CORS headers and preflight requests for allowed
// origins, and rejects state-changing requests (or preflights) from untrusted origins.
// It sets Access-Control-Allow-Origin to the exact matched origin (never *),
// Access-Control-Allow-Credentials: true, and handles OPTIONS preflights.
// Requests without an Origin header come from non-browser clients, which
// cannot carry a victim's cookies.
func RequireAllowedOrigin(allowed []string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			o := r.Header.Get("Origin")
			if o != "" {
				if slices.Contains(allowed, o) {
					w.Header().Set("Access-Control-Allow-Origin", o)
					w.Header().Set("Access-Control-Allow-Credentials", "true")
					w.Header().Add("Vary", "Origin")
					if r.Method == http.MethodOptions {
						w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
						w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Request-Id")
						w.Header().Set("Access-Control-Max-Age", "86400")
						w.WriteHeader(http.StatusNoContent)
						return
					}
				} else {
					switch r.Method {
					case http.MethodGet, http.MethodHead:
					default:
						Error(w, http.StatusForbidden, "origin not allowed")
						return
					}
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequestLogger logs one line per request. It deliberately logs no headers,
// cookies, query strings or bodies, which may hold credentials.
func RequestLogger(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor) // keeps Hijacker for WebSockets
			next.ServeHTTP(ww, r)
			status := ww.Status()
			if status == 0 {
				// Nothing went through the wrapper: either a hijacked WebSocket
				// upgrade (which wrote its own 101) or an empty 200.
				status = http.StatusOK
				if r.Header.Get("Upgrade") == "websocket" {
					status = http.StatusSwitchingProtocols
				}
			}
			log.Info("request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", status,
				"duration_ms", time.Since(start).Milliseconds(),
				"request_id", middleware.GetReqID(r.Context()),
			)
		})
	}
}

// Internal logs err and answers 500 without revealing it to the client.
func Internal(w http.ResponseWriter, r *http.Request, log *slog.Logger, err error) {
	log.Error("internal error", "path", r.URL.Path, "request_id", middleware.GetReqID(r.Context()), "err", fmt.Sprint(err))
	Error(w, http.StatusInternalServerError, "internal error")
}

// APIHeaders sets headers every API response should carry: no caching
// (responses carry the signed-in user's data, e.g. /auth/me) and no MIME
// sniffing (Week 5 review D10).
func APIHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

// requestIDPattern is what an incoming X-Request-Id must look like to be
// kept (e.g. Nginx's $request_id). Anything else is replaced: a client can
// send any header, and the ID is written to every log line.
var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// RequestID gives every request an ID, stores it where chi's
// middleware.GetReqID finds it, and returns it in X-Request-Id so a user's
// report can be matched to the server's logs. It replaces chi's RequestID,
// which kept any client-sent value of any length (Week 5 review D12).
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if !requestIDPattern.MatchString(id) {
			var b [8]byte
			_, _ = rand.Read(b[:])
			id = hex.EncodeToString(b[:])
		}
		w.Header().Set("X-Request-Id", id)
		ctx := context.WithValue(r.Context(), middleware.RequestIDKey, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// Recoverer turns a panic in a handler into a 500 and one structured log
// line with the request ID and stack, instead of chi's Recoverer, which
// printed to stderr outside the JSON log. http.ErrAbortHandler is re-raised:
// net/http uses it to abort a response on purpose.
func Recoverer(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				v := recover()
				if v == nil {
					return
				}
				if v == http.ErrAbortHandler {
					panic(v)
				}
				log.Error("panic",
					"request_id", middleware.GetReqID(r.Context()),
					"method", r.Method,
					"path", r.URL.Path,
					"panic", fmt.Sprint(v),
					"stack", string(debug.Stack()),
				)
				if r.Header.Get("Upgrade") == "" { // a hijacked WebSocket can't take a response
					Error(w, http.StatusInternalServerError, "internal error")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// ServeFrontend mounts the Vite production build on the router. Hashed
// assets in /assets/ are cached forever; everything else falls back to
// index.html (the SPA entry), never cached. API (/api/), WebSocket (/ws/)
// and health (/healthz, /readyz) routes registered earlier take priority.
func ServeFrontend(r chi.Router, frontend fs.FS) {
	fileServer := http.FileServer(http.FS(frontend))
	r.Get("/assets/*", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		fileServer.ServeHTTP(w, r)
	})
	// theme-init.js, favicon, etc. — exact matches, no cache.
	r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
		// Try the requested file first; if it doesn't exist, serve
		// index.html (SPA client-side routing).
		path := strings.TrimPrefix(req.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if _, err := fs.Stat(frontend, path); err != nil {
			req.URL.Path = "/"
			path = "index.html"
		}
		// index.html must never be cached so new builds are picked up.
		if path == "index.html" {
			w.Header().Set("Cache-Control", "no-cache")
		}
		fileServer.ServeHTTP(w, req)
	})
}
