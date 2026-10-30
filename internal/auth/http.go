package auth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"collabspace/internal/httpx"
	"collabspace/internal/ratelimit"
)

// CookieConfig controls the session cookie's attributes. Secure must be
// true in production; it is configurable only so plain-HTTP localhost
// development works. Domain is optional (e.g. for sharing cookies across
// subdomains under a custom domain).
type CookieConfig struct {
	Secure bool
	Domain string
}

// Name is the session cookie's name. With Secure and without a Domain it
// carries the __Host- prefix: browsers then accept the cookie only if it is
// Secure, has Path=/ and no Domain, so a sibling subdomain cannot plant
// ("toss") a cookie of the same name and log the victim into the attacker's
// account. Browsers refuse __Host- cookies without Secure or with a Domain,
// so those cases use the unprefixed name.
func (c CookieConfig) Name() string {
	if c.Secure && c.Domain == "" {
		return "__Host-collabspace_session"
	}
	return "collabspace_session"
}

func (c CookieConfig) set(w http.ResponseWriter, s Session, now time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     c.Name(),
		Value:    s.Token,
		Path:     "/",       // API and WebSocket both need it
		Domain:   c.Domain,
		Expires:  s.Expires, // same lifetime as the server-side session
		MaxAge:   int(s.Expires.Sub(now).Seconds()),
		HttpOnly: true,                 // not readable by JavaScript (XSS can't steal it)
		Secure:   c.Secure,             // HTTPS only
		SameSite: http.SameSiteLaxMode, // not sent on cross-site POSTs or sub-requests
	})
}

func (c CookieConfig) clear(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: c.Name(), Value: "", Path: "/", Domain: c.Domain, MaxAge: -1,
		HttpOnly: true, Secure: c.Secure, SameSite: http.SameSiteLaxMode,
	})
}

// --- request context ---

// ctxKey is unexported, so no other package can read or forge the value.
type ctxKey struct{}

type identity struct {
	user    User
	session SessionInfo
}

// UserFrom returns the authenticated user placed in the context by
// Middleware, if any.
func UserFrom(ctx context.Context) (User, bool) {
	id, ok := ctx.Value(ctxKey{}).(identity)
	return id.user, ok
}

// SessionFrom returns the session the request was authenticated with.
func SessionFrom(ctx context.Context) (SessionInfo, bool) {
	id, ok := ctx.Value(ctxKey{}).(identity)
	return id.session, ok
}

// Middleware resolves the session cookie, if present and valid, and puts the
// user in the request context. It never rejects a request; RequireUser does.
func Middleware(svc *Service, cookie CookieConfig, log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			c, err := r.Cookie(cookie.Name())
			if err != nil || c.Value == "" {
				next.ServeHTTP(w, r)
				return
			}
			u, sess, err := svc.Authenticate(r.Context(), c.Value)
			switch {
			case err == nil:
				r = r.WithContext(context.WithValue(r.Context(), ctxKey{}, identity{user: u, session: sess}))
			case !errors.Is(err, ErrNoSession):
				httpx.Internal(w, r, log, err)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireUser answers 401 unless Middleware found a valid session.
func RequireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := UserFrom(r.Context()); !ok {
			httpx.Error(w, http.StatusUnauthorized, "not signed in")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// --- handlers ---

// Limits bounds attempts on the endpoints that hash passwords. A nil
// limiter means no limit.
type Limits struct {
	LoginPerIP *ratelimit.Limiter
	// LoginPerAccountIP is the strict per-account limit, keyed by account
	// AND address, so an attacker spending it doesn't lock the owner out
	// from their own address. LoginPerAccount is a looser total across all
	// addresses, against guessing spread over many. Keyed by account alone,
	// the strict limit let anyone with a few addresses lock any known
	// account out (Week 5 review R6).
	LoginPerAccountIP *ratelimit.Limiter
	LoginPerAccount   *ratelimit.Limiter
	RegisterPerIP     *ratelimit.Limiter
	// TrustedIPHeader is the header a trusted reverse proxy overwrites with
	// the client address (e.g. X-Real-IP). Empty: use the TCP peer address.
	TrustedIPHeader string
}

type Handler struct {
	svc    *Service
	cookie CookieConfig
	limits Limits
	log    *slog.Logger
}

func NewHandler(svc *Service, cookie CookieConfig, limits Limits, log *slog.Logger) *Handler {
	return &Handler{svc: svc, cookie: cookie, limits: limits, log: log}
}

// limited answers 429 when l has no token for key. The response never says
// which limit tripped (per-IP or per-account), and the log line names only
// the limit, never the key (an email or address).
func (h *Handler) limited(w http.ResponseWriter, l *ratelimit.Limiter, name, key string) bool {
	ok, retry := l.Allow(key)
	if ok {
		return false
	}
	h.log.Warn("rate limited", "limit", name)
	w.Header().Set("Retry-After", ratelimit.RetryAfterSeconds(retry))
	httpx.Error(w, http.StatusTooManyRequests, "too many attempts; please wait and try again")
	return true
}

// Routes mounts /auth/register, /auth/login and /auth/me on r (the /api
// router, behind Middleware). Logout is mounted separately; see Logout.
func (h *Handler) Routes(r chi.Router) {
	r.Post("/auth/register", h.register)
	r.Post("/auth/login", h.login)
	r.With(RequireUser).Get("/auth/me", h.me)
}

func (h *Handler) register(w http.ResponseWriter, r *http.Request) {
	// Before reading the body: malformed requests count too.
	if h.limited(w, h.limits.RegisterPerIP, "register_ip", ratelimit.ClientIP(r, h.limits.TrustedIPHeader)) {
		return
	}
	var in RegisterInput
	if err := httpx.Decode(w, r, &in); err != nil {
		httpx.WriteDecodeError(w, err)
		return
	}
	u, s, err := h.svc.Register(r.Context(), in)
	var ve *ValidationError
	switch {
	case errors.As(err, &ve):
		httpx.Error(w, http.StatusBadRequest, ve.Msg)
		return
	case errors.Is(err, ErrBusy):
		busy(w)
		return
	case errors.Is(err, ErrEmailTaken):
		httpx.Error(w, http.StatusConflict, "an account with this email already exists")
		return
	case err != nil:
		httpx.Internal(w, r, h.log, err)
		return
	}
	h.cookie.set(w, s, h.svc.now())
	httpx.JSON(w, http.StatusCreated, map[string]any{"user": u})
}

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	ip := ratelimit.ClientIP(r, h.limits.TrustedIPHeader)
	if h.limited(w, h.limits.LoginPerIP, "login_ip", ip) {
		return
	}
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := httpx.Decode(w, r, &in); err != nil {
		httpx.WriteDecodeError(w, err)
		return
	}
	// Per account: from this address, then from all addresses together.
	// Applies whether or not the account exists, so the 429 reveals
	// nothing. (Invalid emails fail without hashing anyway.)
	if email, err := NormalizeEmail(in.Email); err == nil {
		if h.limited(w, h.limits.LoginPerAccountIP, "login_account_ip", email+"|"+ip) ||
			h.limited(w, h.limits.LoginPerAccount, "login_account", email) {
			return
		}
	}
	u, s, err := h.svc.Login(r.Context(), in.Email, in.Password)
	switch {
	case errors.Is(err, ErrInvalidCredentials):
		httpx.Error(w, http.StatusUnauthorized, "invalid email or password")
		return
	case errors.Is(err, ErrBusy):
		busy(w)
		return
	case err != nil:
		httpx.Internal(w, r, h.log, err)
		return
	}
	h.cookie.set(w, s, h.svc.now())
	httpx.JSON(w, http.StatusOK, map[string]any{"user": u})
}

// logout clears the cookie first, unconditionally: even if revoking the
// session in the database fails, this browser must not stay signed in (a
// shared computer). The 500 then tells the client the server-side session
// may still exist until it expires.
//
// It must be mounted WITHOUT Middleware: it needs no session lookup, and if
// the database is down that lookup would fail (500) before the cookie could
// be cleared.
func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	h.cookie.clear(w)
	if c, err := r.Cookie(h.cookie.Name()); err == nil {
		if err := h.svc.Logout(r.Context(), c.Value); err != nil {
			httpx.Internal(w, r, h.log, err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) me(w http.ResponseWriter, r *http.Request) {
	u, _ := UserFrom(r.Context())
	httpx.JSON(w, http.StatusOK, map[string]any{"user": u})
}

// busy answers 503 when no hashing slot became free in time.
func busy(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "5")
	httpx.Error(w, http.StatusServiceUnavailable, "the server is busy; please try again shortly")
}
