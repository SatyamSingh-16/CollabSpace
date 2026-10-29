// Package config loads the server configuration from environment variables
// and validates it at startup, so a misconfigured server fails immediately
// instead of misbehaving later.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"collabspace/internal/ratelimit"
)

type Config struct {
	DatabaseURL    string
	HTTPAddr       string
	AllowedOrigins []string // exact browser origins, e.g. https://app.example.com
	CookieSecure   bool     // false only for local plain-HTTP development
	SessionTTL     time.Duration
	MigrateOnStart bool
	LogLevel       slog.Level
	LogFormat      string // "json" or "text"

	// Login/registration limits ("N/duration" or "off") and the header a
	// trusted reverse proxy sets to the client IP (empty: TCP peer address).
	RateLoginPerIP        ratelimit.Rule
	RateLoginPerAccountIP ratelimit.Rule // one account from one address
	RateLoginPerAccount   ratelimit.Rule // one account from all addresses together
	RateRegisterPerIP     ratelimit.Rule
	RateSharePerUser      ratelimit.Rule // sharing reveals whether an email is registered
	RateLimitMaxKeys      int
	TrustedProxyHeader    string

	ReadHeaderTimeout time.Duration
	ReadTimeout       time.Duration
	WriteTimeout      time.Duration
	IdleTimeout       time.Duration
	ShutdownTimeout   time.Duration
	StatsLogInterval  time.Duration // how often the server logs collaboration counts
}

// Load reads the configuration through getenv (os.Getenv in production; a
// map lookup in tests). All problems are reported together.
func Load(getenv func(string) string) (Config, error) {
	var errs []error
	get := func(key, def string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return def
	}
	duration := func(key string, def time.Duration) time.Duration {
		v := get(key, "")
		if v == "" {
			return def
		}
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			errs = append(errs, fmt.Errorf("%s: want a positive duration like 30s, got %q", key, v))
			return def
		}
		return d
	}
	boolean := func(key string, def bool) bool {
		v := get(key, "")
		if v == "" {
			return def
		}
		b, err := strconv.ParseBool(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: want true or false, got %q", key, v))
			return def
		}
		return b
	}

	rule := func(key, def string) ratelimit.Rule {
		r, err := ratelimit.ParseRule(get(key, def))
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", key, err))
		}
		return r
	}

	c := Config{
		HTTPAddr:       get("HTTP_ADDR", "127.0.0.1:8080"),
		CookieSecure:   boolean("COOKIE_SECURE", true), // secure unless explicitly disabled
		SessionTTL:     duration("SESSION_TTL", 7*24*time.Hour),
		MigrateOnStart: boolean("MIGRATE_ON_START", true),
		LogFormat:      get("LOG_FORMAT", "json"),

		// Defaults sized for people typing passwords, not measured capacity:
		// 30 login attempts per address per 10 minutes, 10 per account per
		// 10 minutes, 10 registrations per address per hour.
		RateLoginPerIP:        rule("RATE_LIMIT_LOGIN_PER_IP", "30/10m"),
		RateLoginPerAccountIP: rule("RATE_LIMIT_LOGIN_PER_ACCOUNT_IP", "10/10m"),
		RateLoginPerAccount:   rule("RATE_LIMIT_LOGIN_PER_ACCOUNT", "50/10m"),
		RateRegisterPerIP:     rule("RATE_LIMIT_REGISTER_PER_IP", "10/1h"),
		RateSharePerUser:      rule("RATE_LIMIT_SHARE_PER_USER", "30/10m"),
		RateLimitMaxKeys:      100_000, // ~10 MB worst case
		TrustedProxyHeader:    get("TRUSTED_PROXY_IP_HEADER", ""),

		ReadHeaderTimeout: duration("HTTP_READ_HEADER_TIMEOUT", 5*time.Second),
		ReadTimeout:       duration("HTTP_READ_TIMEOUT", 15*time.Second),
		WriteTimeout:      duration("HTTP_WRITE_TIMEOUT", 30*time.Second),
		IdleTimeout:       duration("HTTP_IDLE_TIMEOUT", 120*time.Second),
		ShutdownTimeout:   duration("SHUTDOWN_TIMEOUT", 15*time.Second),
		StatsLogInterval:  duration("STATS_LOG_INTERVAL", 5*time.Minute),
	}

	if dsn, err := DatabaseURL(getenv); err != nil {
		errs = append(errs, err)
	} else {
		c.DatabaseURL = dsn
	}
	origins := get("ALLOWED_ORIGINS", "")
	if origins == "" {
		errs = append(errs, errors.New("ALLOWED_ORIGINS is required (comma-separated, e.g. https://app.example.com)"))
	}
	for _, o := range strings.Split(origins, ",") {
		if o = strings.TrimSpace(o); o == "" {
			continue
		}
		if err := validOrigin(o); err != nil {
			errs = append(errs, fmt.Errorf("ALLOWED_ORIGINS: %w", err))
			continue
		}
		c.AllowedOrigins = append(c.AllowedOrigins, o)
	}
	if origins != "" && len(c.AllowedOrigins) == 0 {
		errs = append(errs, errors.New("ALLOWED_ORIGINS lists no origins"))
	}
	// COOKIE_SECURE=false sends the session cookie over plain HTTP and drops
	// the __Host- prefix. That is only acceptable for local development, so
	// refuse it unless every allowed origin is http:// on a loopback host
	// (Week 5 review D1). A warning in the log was the only safeguard before.
	if !c.CookieSecure {
		for _, o := range c.AllowedOrigins {
			if !isLocalHTTPOrigin(o) {
				errs = append(errs, fmt.Errorf("COOKIE_SECURE=false is only allowed when every ALLOWED_ORIGINS entry is http://localhost, 127.0.0.1 or [::1]; got %s", o))
				break
			}
		}
	}
	if c.SessionTTL < 5*time.Minute || c.SessionTTL > 90*24*time.Hour {
		errs = append(errs, fmt.Errorf("SESSION_TTL must be between 5m and 2160h, got %s", c.SessionTTL))
	}
	if err := c.LogLevel.UnmarshalText([]byte(get("LOG_LEVEL", "info"))); err != nil {
		errs = append(errs, fmt.Errorf("LOG_LEVEL: %w", err))
	}
	if c.LogFormat != "json" && c.LogFormat != "text" {
		errs = append(errs, fmt.Errorf("LOG_FORMAT must be json or text, got %q", c.LogFormat))
	}
	return c, errors.Join(errs...)
}

// validOrigin accepts exactly scheme://host[:port], which is what browsers
// send in the Origin header.
func validOrigin(o string) error {
	u, err := url.Parse(o)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.User != nil {
		return fmt.Errorf("%q is not an origin like https://app.example.com", o)
	}
	if strings.HasSuffix(o, "/") {
		return fmt.Errorf("%q: origins have no trailing slash", o)
	}
	return nil
}

// isLocalHTTPOrigin reports whether o (already validated) is plain HTTP on a
// loopback host, i.e. a local development origin.
func isLocalHTTPOrigin(o string) bool {
	u, err := url.Parse(o)
	if err != nil || u.Scheme != "http" {
		return false
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

// DatabaseURL returns DATABASE_URL, or the contents of the file named by
// DATABASE_URL_FILE (e.g. a Docker/Compose secret under /run/secrets), so
// the password needn't be in the environment, `docker inspect` output or an
// image. The URL itself is never part of an error. Used by the server and
// cmd/admin.
func DatabaseURL(getenv func(string) string) (string, error) {
	dsn := strings.TrimSpace(getenv("DATABASE_URL"))
	path := strings.TrimSpace(getenv("DATABASE_URL_FILE"))
	switch {
	case dsn != "" && path != "":
		return "", errors.New("set DATABASE_URL or DATABASE_URL_FILE, not both")
	case path != "":
		b, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("DATABASE_URL_FILE: cannot read %s: %w", path, errors.Unwrap(err))
		}
		dsn = strings.TrimSpace(string(b))
	}
	if dsn == "" {
		return "", errors.New("DATABASE_URL is required (or DATABASE_URL_FILE)")
	}
	return dsn, nil
}
