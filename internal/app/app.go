// Package app wires the server together: it constructs every dependency
// explicitly and builds the HTTP router. cmd/server owns process concerns
// (config, signals, the listener); tests build an App directly.
package app

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"collabspace/internal/auth"
	"collabspace/internal/collab"
	"collabspace/internal/config"
	"collabspace/internal/documents"
	"collabspace/internal/httpx"
	"collabspace/internal/ratelimit"
	"collabspace/internal/store"
)

type App struct {
	Router http.Handler
	hub    *collab.Hub
	auth   *auth.Service
	pool   *pgxpool.Pool
	ready  atomic.Bool
}

// New builds the application. collabCfg is usually collab.DefaultConfig();
// its AllowedOrigins is replaced with cfg.AllowedOrigins.
func New(cfg config.Config, collabCfg collab.Config, pool *pgxpool.Pool, log *slog.Logger) *App {
	authSvc := auth.NewService(auth.NewStore(pool), cfg.SessionTTL)
	cookie := auth.CookieConfig{Secure: cfg.CookieSecure}
	docs := documents.NewStore(pool)

	collabCfg.AllowedOrigins = cfg.AllowedOrigins
	hub := collab.NewHub(store.New(pool), collabCfg, log)

	// Live authorization: logout and membership changes reach open
	// WebSocket connections (see internal/collab/authz.go).
	authSvc.OnSessionRevoked(hub.RevokeSession)
	live := documents.Live{
		MemberChanged: func(docID, userID uuid.UUID, role documents.Role) {
			hub.SetMemberRole(docID, userID, collab.Role(role))
		},
		Deleted: hub.DocumentDeleted,
		Online:  hub.OnlineUsers,
	}

	maxKeys := cfg.RateLimitMaxKeys
	if maxKeys == 0 {
		maxKeys = 100_000
	}
	limits := auth.Limits{
		LoginPerIP:        ratelimit.New(cfg.RateLoginPerIP, maxKeys),
		LoginPerAccountIP: ratelimit.New(cfg.RateLoginPerAccountIP, maxKeys),
		LoginPerAccount:   ratelimit.New(cfg.RateLoginPerAccount, maxKeys),
		RegisterPerIP:     ratelimit.New(cfg.RateRegisterPerIP, maxKeys),
		TrustedIPHeader:   cfg.TrustedProxyHeader,
	}
	shareLimit := ratelimit.New(cfg.RateSharePerUser, maxKeys)

	a := &App{hub: hub, auth: authSvc, pool: pool}
	a.ready.Store(true)

	r := chi.NewRouter()
	r.Use(httpx.RequestID, httpx.RequestLogger(log), httpx.Recoverer(log))
	r.Get("/healthz", a.healthz)
	r.Get("/readyz", a.readyz)

	authHandler := auth.NewHandler(authSvc, cookie, limits, log)
	r.Route("/api", func(r chi.Router) {
		r.Use(httpx.APIHeaders, httpx.RequireAllowedOrigin(cfg.AllowedOrigins))
		// Logout needs no session lookup and must clear the cookie even when
		// the database is unreachable, so it bypasses auth.Middleware.
		r.Post("/auth/logout", authHandler.Logout)
		r.Group(func(r chi.Router) {
			r.Use(auth.Middleware(authSvc, cookie, log)) // resolves the cookie; never rejects
			authHandler.Routes(r)
			r.Group(func(r chi.Router) {
				r.Use(auth.RequireUser)
				documents.NewHandler(docs, live, shareLimit, log).Routes(r)
			})
		})
	})

	// GET /ws/documents/{docID}: authorised before the upgrade (session +
	// membership); the collab handler also checks the Origin allowlist.
	r.With(auth.Middleware(authSvc, cookie, log)).Group(func(r chi.Router) {
		collab.NewHandler(hub, collabAuthorizer(docs)).Routes(r)
	})

	a.Router = r
	return a
}

// collabAuthorizer derives the WebSocket principal from the server-side
// session (placed in the context by auth.Middleware) and the membership
// table. Nothing the client sends is trusted for identity or role.
func collabAuthorizer(docs *documents.Store) collab.Authorizer {
	return func(r *http.Request, docID uuid.UUID) (collab.Principal, error) {
		user, ok := auth.UserFrom(r.Context())
		if !ok {
			return collab.Principal{}, collab.ErrUnauthenticated
		}
		session, _ := auth.SessionFrom(r.Context())
		role, err := docs.RoleFor(r.Context(), docID, user.ID)
		if errors.Is(err, documents.ErrNotFound) {
			return collab.Principal{}, collab.ErrNoAccess
		}
		if err != nil {
			return collab.Principal{}, err
		}
		return collab.Principal{
			UserID:         user.ID,
			Role:           collab.Role(role),
			DisplayName:    user.DisplayName,
			SessionID:      session.ID,
			SessionExpires: session.ExpiresAt,
		}, nil
	}
}

// healthz is liveness: the process is up and serving HTTP. It does not
// touch the database, so a database outage doesn't get the process killed.
func (a *App) healthz(w http.ResponseWriter, _ *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// readyz is readiness: should this instance receive traffic? No while
// shutting down or when the database doesn't answer.
func (a *App) readyz(w http.ResponseWriter, r *http.Request) {
	if !a.ready.Load() {
		httpx.JSON(w, http.StatusServiceUnavailable, map[string]string{"status": "shutting down"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := a.pool.Ping(ctx); err != nil {
		httpx.JSON(w, http.StatusServiceUnavailable, map[string]string{"status": "database unavailable"})
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// CollabStats reports the collaboration engine's counts (for operators).
func (a *App) CollabStats() collab.Stats { return a.hub.Stats() }

// PoolStats is the database connection pool's state, for operators. All
// connections in use (acquired == max) plus a rising empty_acquire_total
// and acquire_wait_ms mean requests are queueing for a connection: pool
// exhaustion (docs/deployment.md, troubleshooting).
type PoolStats struct {
	Max          int32 `json:"max"`
	Total        int32 `json:"total"`
	Acquired     int32 `json:"acquired"`
	Idle         int32 `json:"idle"`
	EmptyAcquire int64 `json:"empty_acquire_total"` // acquires that had to wait for a connection
	AcquireWait  int64 `json:"acquire_wait_ms"`     // total time spent waiting to acquire
	Canceled     int64 `json:"canceled_acquire_total"`
}

func (a *App) PoolStats() PoolStats {
	s := a.pool.Stat()
	return PoolStats{
		Max:          s.MaxConns(),
		Total:        s.TotalConns(),
		Acquired:     s.AcquiredConns(),
		Idle:         s.IdleConns(),
		EmptyAcquire: s.EmptyAcquireCount(),
		AcquireWait:  s.AcquireDuration().Milliseconds(),
		Canceled:     s.CanceledAcquireCount(),
	}
}

// BeginShutdown makes /readyz fail so load balancers stop sending traffic.
func (a *App) BeginShutdown() { a.ready.Store(false) }

// ShutdownConnections closes every WebSocket (1001) and waits for the
// collaboration goroutines. Call after http.Server.Shutdown, which ignores
// hijacked connections.
func (a *App) ShutdownConnections(ctx context.Context) error {
	return a.hub.Shutdown(ctx)
}

// RunSessionJanitor deletes expired sessions every interval until ctx is
// cancelled. Expired sessions are already rejected by every lookup; this
// only keeps the table from growing with sessions of users who never return.
func (a *App) RunSessionJanitor(ctx context.Context, every time.Duration, log *slog.Logger) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n, err := a.auth.PurgeExpiredSessions(ctx)
			if err != nil && ctx.Err() == nil {
				log.Warn("session janitor", "err", err)
			} else if n > 0 {
				log.Info("expired sessions purged", "count", n)
			}
		}
	}
}
