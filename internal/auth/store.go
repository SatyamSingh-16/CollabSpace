package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrEmailTaken = errors.New("auth: email already registered")
	errNotFound   = errors.New("auth: not found")
)

type User struct {
	ID          uuid.UUID `json:"id"`
	Email       string    `json:"email"`
	DisplayName string    `json:"display_name"`
	CreatedAt   time.Time `json:"created_at"`
}

// Store is the SQL for users and sessions. All queries are parameterised.
type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// CreateUserWithSession inserts a user and their first session in one
// transaction: a registration either fully succeeds (account + login) or
// leaves nothing behind.
func (s *Store) CreateUserWithSession(ctx context.Context, u User, passwordHash string, tokenHash []byte, expires time.Time) (User, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return User{}, err
	}
	defer rollback(ctx, tx)

	err = tx.QueryRow(ctx, `
		INSERT INTO users (id, email, display_name, password_hash)
		VALUES ($1, $2, $3, $4)
		RETURNING created_at`,
		u.ID, u.Email, u.DisplayName, passwordHash,
	).Scan(&u.CreatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "users_email_key" {
			return User{}, ErrEmailTaken
		}
		return User{}, fmt.Errorf("insert user: %w", err)
	}
	if err := insertSession(ctx, tx, tokenHash, u.ID, expires); err != nil {
		return User{}, err
	}
	return u, tx.Commit(ctx)
}

// UserByEmail returns the user and their password hash.
func (s *Store) UserByEmail(ctx context.Context, email string) (User, string, error) {
	var u User
	var hash string
	err := s.pool.QueryRow(ctx, `
		SELECT id, email, display_name, created_at, password_hash FROM users WHERE email = $1`, email,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, "", errNotFound
	}
	return u, hash, err
}

// CreateSession stores a new session and removes the user's expired ones
// (housekeeping on login keeps the table from growing without a cron job).
func (s *Store) CreateSession(ctx context.Context, tokenHash []byte, userID uuid.UUID, expires time.Time) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1 AND expires_at <= now()`, userID); err != nil {
		return fmt.Errorf("purge expired sessions: %w", err)
	}
	return insertSession(ctx, s.pool, tokenHash, userID, expires)
}

type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

func insertSession(ctx context.Context, db execer, tokenHash []byte, userID uuid.UUID, expires time.Time) error {
	_, err := db.Exec(ctx, `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
		tokenHash, userID, expires)
	if err != nil {
		return fmt.Errorf("insert session: %w", err)
	}
	return nil
}

// UserBySession returns the user owning an unexpired session. Expiry is
// checked by the database clock, in the same query.
func (s *Store) UserBySession(ctx context.Context, tokenHash []byte) (User, time.Time, error) {
	var u User
	var expires time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT u.id, u.email, u.display_name, u.created_at, s.expires_at
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = $1 AND s.expires_at > now()`, tokenHash,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, time.Time{}, errNotFound
	}
	return u, expires, err
}

// DeleteSession revokes a session and reports whether one existed.
// Deleting an unknown session is not an error: logout is idempotent.
func (s *Store) DeleteSession(ctx context.Context, tokenHash []byte) (bool, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, tokenHash)
	return tag.RowsAffected() > 0, err
}

// DeleteExpiredSessions removes every expired session (uses
// sessions_expires_at_idx) and reports how many.
func (s *Store) DeleteExpiredSessions(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE expires_at <= now()`)
	return tag.RowsAffected(), err
}

// rollback runs after the request may have been cancelled, so it ignores
// cancellation, but it is bounded: it must not hold a pool connection
// indefinitely on a dead network (Week 5 review D3). After Commit it is a
// no-op.
func rollback(ctx context.Context, tx pgx.Tx) {
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	_ = tx.Rollback(rctx)
}
