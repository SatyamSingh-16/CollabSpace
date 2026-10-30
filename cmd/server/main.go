// Command server is the CollabSpace application server: authentication,
// documents and real-time collaboration over WebSockets.
//
// Configuration comes from environment variables; see .env.example.
//
// When the frontend/dist directory is present at build time, the production
// Vite build is embedded and served by the same binary (single-origin
// deployment on Render). Otherwise the frontend is served separately (Nginx
// reverse proxy or Vite dev proxy).
package main

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"collabspace/internal/app"
	"collabspace/internal/collab"
	"collabspace/internal/config"
	"collabspace/migrations"
)

//go:embed all:frontend_dist
var embeddedFrontend embed.FS

func main() {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "configuration error:\n"+err.Error())
		os.Exit(2)
	}
	log := newLogger(cfg)
	if err := run(cfg, log); err != nil {
		log.Error("server failed", "err", err)
		os.Exit(1)
	}
}

func newLogger(cfg config.Config) *slog.Logger {
	opts := &slog.HandlerOptions{Level: cfg.LogLevel}
	if cfg.LogFormat == "text" {
		return slog.New(slog.NewTextHandler(os.Stdout, opts))
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, opts))
}

func run(cfg config.Config, log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("database config: %w", err) // the DSN itself is never logged
	}
	defer pool.Close()
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	err = pool.Ping(pingCtx)
	cancel()
	if err != nil {
		return fmt.Errorf("database unreachable: %w", err)
	}
	if cfg.MigrateOnStart {
		if err := migrations.Up(ctx, pool); err != nil {
			return fmt.Errorf("migrate: %w", err)
		}
	}
	if !cfg.CookieSecure {
		log.Warn("COOKIE_SECURE=false: session cookies will be sent over plain HTTP (local development only)")
	}

	// Serve the embedded Vite production build (single-origin deployment)
	// when frontend_dist contains a built index.html. In local development
	// (go run), frontend_dist contains only .gitkeep and the frontend is served
	// by Vite's dev server with its proxy.
	var frontendFS fs.FS
	if f, err := embeddedFrontend.Open("frontend_dist/index.html"); err == nil {
		_ = f.Close()
		sub, _ := fs.Sub(embeddedFrontend, "frontend_dist")
		frontendFS = sub
		log.Info("serving embedded frontend")
	}

	a := app.New(cfg, collab.DefaultConfig(), pool, log, frontendFS)
	go a.RunSessionJanitor(ctx, time.Hour, log) // stops when ctx is cancelled
	go logStats(ctx, a, cfg.StatsLogInterval, log)
	srv := &http.Server{
		Handler:           a.Router,
		ReadHeaderTimeout: cfg.ReadHeaderTimeout,
		// ReadTimeout/WriteTimeout bound ordinary requests. They also set
		// deadlines on connections that later become WebSockets, but the
		// collab package sets its own read/write deadline before every
		// socket operation, which replaces them (tested in internal/app).
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		IdleTimeout:  cfg.IdleTimeout,
		ErrorLog:     slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}

	ln, err := net.Listen("tcp", cfg.HTTPAddr)
	if err != nil {
		return err
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()
	log.Info("listening", "addr", ln.Addr().String(), "origins", cfg.AllowedOrigins)

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
	}

	started := time.Now()
	log.Info("shutting down", "timeout", cfg.ShutdownTimeout.String(), "collab", a.CollabStats())
	a.BeginShutdown()
	sctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	// 1. Stop accepting and finish in-flight HTTP requests.
	// 2. Close WebSockets (hijacked, so srv.Shutdown ignores them).
	// 3. The deferred pool.Close runs last.
	httpErr := srv.Shutdown(sctx)
	wsErr := a.ShutdownConnections(sctx)
	<-serveErr
	// forced=true means the deadline passed: remaining sockets were closed
	// without waiting for their goroutines.
	log.Info("stopped",
		"duration_ms", time.Since(started).Milliseconds(),
		"forced", httpErr != nil || wsErr != nil,
		"collab", a.CollabStats())
	return errors.Join(httpErr, wsErr)
}

// logStats writes the collaboration counts every interval, so an operator
// can see load and how often failure paths (evictions, resets, persist
// failures) run, without a metrics stack. Counts only; no identifiers.
func logStats(ctx context.Context, a *app.App, every time.Duration, log *slog.Logger) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			log.Info("collab stats", "collab", a.CollabStats(), "db_pool", a.PoolStats())
		}
	}
}
