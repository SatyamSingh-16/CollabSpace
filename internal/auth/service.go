// Package auth implements accounts and opaque server-side sessions:
// registration, login, logout, and resolving a session cookie to a user.
package auth

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net/mail"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

var (
	// ErrInvalidCredentials is the only login failure callers see, whether
	// the email is unknown or the password wrong.
	ErrInvalidCredentials = errors.New("auth: invalid email or password")
	ErrNoSession          = errors.New("auth: no valid session")
)

// ValidationError is a problem with user input, safe to show to the user.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

const (
	minPasswordLen = 8
	maxPasswordLen = 256 // bytes; bounds hashing work per request
	maxDisplayName = 100
)

// NormalizeEmail trims and lower-cases an address and checks that it is a
// plain address (no display name). Lower-casing the local part is a
// deliberate simplification: practically no provider treats it as
// case-sensitive, and it prevents duplicate accounts.
func NormalizeEmail(raw string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(raw))
	if len(email) < 3 || len(email) > 254 {
		return "", &ValidationError{"email must be a valid address"}
	}
	addr, err := mail.ParseAddress(email)
	if err != nil || addr.Address != email || !strings.Contains(email[strings.LastIndex(email, "@")+1:], ".") {
		return "", &ValidationError{"email must be a valid address"}
	}
	return email, nil
}

type Service struct {
	store *Store
	ttl   time.Duration
	now   func() time.Time
	// hashSlots bounds concurrent Argon2id computations (about 19 MiB
	// each), so a burst of logins cannot exhaust memory.
	hashSlots chan struct{}
	// onRevoke is told about every logout, so live WebSocket connections
	// opened with that session can be closed (set by the app).
	onRevoke func(sessionID string)

	hashWait time.Duration // hashWait, shorter in tests
}

func NewService(store *Store, sessionTTL time.Duration) *Service {
	return &Service{store: store, ttl: sessionTTL, now: time.Now, hashWait: hashWait, hashSlots: make(chan struct{}, max(4, runtime.GOMAXPROCS(0)))}
}

// OnSessionRevoked registers fn to be called with the session ID of every
// logout that deleted a session row, after the deletion.
func (s *Service) OnSessionRevoked(fn func(sessionID string)) { s.onRevoke = fn }

// SessionInfo identifies the session behind a request. ID is the hex SHA-256
// of the token: stable, unguessable, and useless as a cookie.
type SessionInfo struct {
	ID        string
	ExpiresAt time.Time
}

func sessionID(tokenHash []byte) string { return hex.EncodeToString(tokenHash) }

// ErrBusy means every hashing slot stayed taken for Service.hashWait: the server is
// overloaded with logins or registrations. Handlers answer 503 + Retry-After.
var ErrBusy = errors.New("auth: too busy, try again")

// hashWait bounds the wait for a hashing slot. Nothing else does: the
// server's ReadTimeout and WriteTimeout don't cancel a request's context, so
// queued requests used to wait without limit under a flood (Week 5 review R9).
const hashWait = 5 * time.Second

// withHashSlot runs fn while holding one of the hashing slots. It gives up
// with ErrBusy after hashWait, or with ctx's error when the client leaves.
func (s *Service) withHashSlot(ctx context.Context, fn func()) error {
	run := func() error {
		defer func() { <-s.hashSlots }()
		fn()
		return nil
	}
	// A free slot is taken at once: select picks at random among ready
	// cases, so a timer that has already fired must not compete with it.
	select {
	case s.hashSlots <- struct{}{}:
		return run()
	default:
	}
	wait := s.hashWait
	if wait <= 0 {
		wait = hashWait
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case s.hashSlots <- struct{}{}:
		return run()
	case <-timer.C:
		return ErrBusy
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Session is a freshly issued session: Token goes into the cookie and is
// never stored or logged.
type Session struct {
	Token   string
	Expires time.Time
}

type RegisterInput struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
}

func (s *Service) Register(ctx context.Context, in RegisterInput) (User, Session, error) {
	email, err := NormalizeEmail(in.Email)
	if err != nil {
		return User{}, Session{}, err
	}
	if len(in.Password) < minPasswordLen || len(in.Password) > maxPasswordLen {
		return User{}, Session{}, &ValidationError{fmt.Sprintf("password must be %d to %d characters", minPasswordLen, maxPasswordLen)}
	}
	name := strings.TrimSpace(in.DisplayName)
	if name == "" || utf8.RuneCountInString(name) > maxDisplayName {
		return User{}, Session{}, &ValidationError{fmt.Sprintf("display name must be 1 to %d characters", maxDisplayName)}
	}

	var hash string
	if slotErr := s.withHashSlot(ctx, func() { hash, err = HashPassword(in.Password) }); slotErr != nil {
		return User{}, Session{}, slotErr
	}
	if err != nil {
		return User{}, Session{}, err
	}
	token, tokenHash, err := newToken()
	if err != nil {
		return User{}, Session{}, err
	}
	expires := s.now().Add(s.ttl)
	u, err := s.store.CreateUserWithSession(ctx, User{ID: uuid.New(), Email: email, DisplayName: name}, hash, tokenHash, expires)
	if err != nil {
		return User{}, Session{}, err
	}
	return u, Session{Token: token, Expires: expires}, nil
}

func (s *Service) Login(ctx context.Context, rawEmail, password string) (User, Session, error) {
	email, err := NormalizeEmail(rawEmail)
	if err != nil || len(password) > maxPasswordLen {
		return User{}, Session{}, ErrInvalidCredentials
	}
	u, hash, err := s.store.UserByEmail(ctx, email)
	if errors.Is(err, errNotFound) {
		// Same cost as a real check, so timing doesn't reveal the account.
		// A slot failure is returned exactly as on the known-account path
		// below, so "busy" doesn't reveal it either.
		if slotErr := s.withHashSlot(ctx, func() { _, _ = VerifyPassword(password, dummyHash) }); slotErr != nil {
			return User{}, Session{}, slotErr
		}
		return User{}, Session{}, ErrInvalidCredentials
	}
	if err != nil {
		return User{}, Session{}, err
	}
	var ok bool
	if slotErr := s.withHashSlot(ctx, func() { ok, err = VerifyPassword(password, hash) }); slotErr != nil {
		return User{}, Session{}, slotErr
	}
	if err != nil {
		return User{}, Session{}, err
	}
	if !ok {
		return User{}, Session{}, ErrInvalidCredentials
	}

	token, tokenHash, err := newToken()
	if err != nil {
		return User{}, Session{}, err
	}
	expires := s.now().Add(s.ttl)
	if err := s.store.CreateSession(ctx, tokenHash, u.ID, expires); err != nil {
		return User{}, Session{}, err
	}
	return u, Session{Token: token, Expires: expires}, nil
}

// Logout revokes the session behind token. Unknown tokens are ignored.
func (s *Service) Logout(ctx context.Context, token string) error {
	if token == "" || len(token) > 128 {
		return nil
	}
	hash := hashToken(token)
	deleted, err := s.store.DeleteSession(ctx, hash)
	// Close live connections only for a session that really existed: the
	// logout endpoint is unauthenticated, and revoking arbitrary IDs would
	// let anyone grow the hub's revocation list (Week 3 review #1). Tracked
	// connections are closed now; any in the middle of a handshake meet the
	// revocation list. If the DELETE fails, the session stays valid until it
	// expires (the browser's cookie is already cleared).
	if deleted && s.onRevoke != nil {
		s.onRevoke(sessionID(hash))
	}
	return err
}

// Authenticate resolves a session token to its user, if the session exists
// and has not expired.
func (s *Service) Authenticate(ctx context.Context, token string) (User, SessionInfo, error) {
	if token == "" || len(token) > 128 {
		return User{}, SessionInfo{}, ErrNoSession
	}
	hash := hashToken(token)
	u, expires, err := s.store.UserBySession(ctx, hash)
	if errors.Is(err, errNotFound) {
		return User{}, SessionInfo{}, ErrNoSession
	}
	return u, SessionInfo{ID: sessionID(hash), ExpiresAt: expires}, err
}

// PurgeExpiredSessions deletes expired sessions; see App.RunSessionJanitor.
func (s *Service) PurgeExpiredSessions(ctx context.Context) (int64, error) {
	return s.store.DeleteExpiredSessions(ctx)
}
