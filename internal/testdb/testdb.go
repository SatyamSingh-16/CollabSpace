// Package testdb connects integration tests to a disposable PostgreSQL
// database and applies the migrations.
//
//	createdb -h /tmp collabspace_test
//	COLLABSPACE_TEST_DATABASE_URL='postgres:///collabspace_test?host=/tmp' go test -race ./...
package testdb

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"collabspace/migrations"
)

const EnvVar = "COLLABSPACE_TEST_DATABASE_URL"

// Run is meant to be called from TestMain. It skips the package (exit 0) when
// EnvVar is unset, otherwise migrates the database, runs the tests with the
// pool, and exits with their status.
func Run(m *testing.M, setPool func(*pgxpool.Pool)) {
	dsn := os.Getenv(EnvVar)
	if dsn == "" {
		fmt.Println(EnvVar, "not set; skipping integration tests")
		os.Exit(0)
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		fmt.Println("connect:", err)
		os.Exit(1)
	}
	// Tests migrate the database and fill it with rows. A variable pointed
	// at collabspace_dev by mistake would do that to real data, so refuse
	// any database whose name doesn't say "test" (Week 5 review D4).
	if name := pool.Config().ConnConfig.Database; !strings.Contains(name, "test") {
		fmt.Printf("refusing to run tests against database %q: its name must contain \"test\"\n", name)
		os.Exit(1)
	}
	if err := migrations.Up(ctx, pool); err != nil {
		fmt.Println("migrate:", err)
		os.Exit(1)
	}
	setPool(pool)
	code := m.Run()
	pool.Close()
	os.Exit(code)
}

// NewUser inserts a minimal account (unusable password hash) and returns its
// ID. Collaboration updates must reference real users (migration 00003).
func NewUser(t testing.TB, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if err := EnsureUser(context.Background(), pool, id); err != nil {
		t.Fatalf("create test user: %v", err)
	}
	return id
}

// EnsureUser creates the account with this ID if it doesn't exist.
func EnsureUser(ctx context.Context, pool *pgxpool.Pool, id uuid.UUID) error {
	_, err := pool.Exec(ctx, `
		INSERT INTO users (id, email, display_name, password_hash)
		VALUES ($1, 'test-' || $2 || '@example.test', 'Test user', '!')
		ON CONFLICT (id) DO NOTHING`, id, id.String())
	return err
}
