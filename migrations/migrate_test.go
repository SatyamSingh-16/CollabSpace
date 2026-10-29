package migrations

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

// Each test runs in its own throwaway database, created and dropped here, so
// migrating down never touches a developer's or another package's data.
func tempDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("COLLABSPACE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("COLLABSPACE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	suffix := make([]byte, 6)
	_, _ = rand.Read(suffix)
	name := "collabspace_migtest_" + hex.EncodeToString(suffix)
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		admin.Close()
		t.Fatalf("create temp database (needs CREATEDB): %v", err)
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.Database = name
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
		admin.Close()
	})
	return pool
}

func provider(t *testing.T, pool *pgxpool.Pool) *goose.Provider {
	t.Helper()
	p, err := goose.NewProvider(goose.DialectPostgres, stdlib.OpenDBFromPool(pool), FS)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func tableExists(t *testing.T, pool *pgxpool.Pool, name string) bool {
	t.Helper()
	var exists bool
	if err := pool.QueryRow(context.Background(), `SELECT to_regclass($1) IS NOT NULL`, name).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	return exists
}

func columnExists(t *testing.T, pool *pgxpool.Pool, table, column string) bool {
	t.Helper()
	var n int
	err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, table, column).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	return n == 1
}

func TestMigrationsUpDownUp(t *testing.T) {
	ctx := context.Background()
	pool := tempDB(t)
	p := provider(t, pool)

	if _, err := p.Up(ctx); err != nil {
		t.Fatalf("up: %v", err)
	}
	for _, table := range []string{"documents", "document_updates", "users", "sessions", "document_members"} {
		if !tableExists(t, pool, table) {
			t.Fatalf("after up: table %s missing", table)
		}
	}

	if _, err := p.DownTo(ctx, 1); err != nil {
		t.Fatalf("down to 1: %v", err)
	}
	for _, table := range []string{"users", "sessions", "document_members"} {
		if tableExists(t, pool, table) {
			t.Fatalf("after down: table %s still exists", table)
		}
	}
	if !tableExists(t, pool, "documents") || !tableExists(t, pool, "document_updates") || columnExists(t, pool, "documents", "owner_id") {
		t.Fatal("after down: Week 1 schema not restored exactly")
	}

	if _, err := p.Up(ctx); err != nil {
		t.Fatalf("up again: %v", err)
	}
	if v, err := p.GetDBVersion(ctx); err != nil || v != 3 {
		t.Fatalf("version %d, %v; want 3", v, err)
	}
}

// Upgrading a database that already has Week 1 PoC data must keep it.
func TestMigration2KeepsWeek1Data(t *testing.T) {
	ctx := context.Background()
	pool := tempDB(t)
	p := provider(t, pool)
	if _, err := p.UpTo(ctx, 1); err != nil {
		t.Fatal(err)
	}
	doc := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO documents (id, title, head_seq) VALUES ($1, 'poc', 2)`, doc); err != nil {
		t.Fatal(err)
	}
	for seq := 1; seq <= 2; seq++ {
		if _, err := pool.Exec(ctx, `
			INSERT INTO document_updates (document_id, seq, user_id, client_id, client_msg_id, payload)
			VALUES ($1, $2, $3, $4, $2, '\x01')`, doc, seq, uuid.New(), uuid.New()); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := p.Up(ctx); err != nil {
		t.Fatalf("up over existing data: %v", err)
	}
	var updates, members int
	var owner *uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT owner_id FROM documents WHERE id = $1`, doc).Scan(&owner); err != nil {
		t.Fatalf("document lost: %v", err)
	}
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM document_updates WHERE document_id = $1`, doc).Scan(&updates)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM document_members WHERE document_id = $1`, doc).Scan(&members)
	if owner != nil || updates != 2 || members != 0 {
		t.Fatalf("owner %v, updates %d, members %d; want nil, 2, 0", owner, updates, members)
	}
}

func TestSchemaConstraints(t *testing.T) {
	ctx := context.Background()
	pool := tempDB(t)
	if _, err := provider(t, pool).Up(ctx); err != nil {
		t.Fatal(err)
	}
	user := func(email string) (uuid.UUID, error) {
		id := uuid.New()
		_, err := pool.Exec(ctx, `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, 'n', 'h')`, id, email)
		return id, err
	}
	code := func(err error) string {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			return pgErr.Code
		}
		return "no error"
	}

	alice, err := user("alice@example.test")
	if err != nil {
		t.Fatal(err)
	}
	bob, _ := user("bob@example.test")
	if _, err := user("ALICE@example.test"); code(err) != "23514" {
		t.Fatalf("un-normalised email: got %s, want check_violation", code(err))
	}
	if _, err := user("alice@example.test"); code(err) != "23505" {
		t.Fatalf("duplicate email: got %s, want unique_violation", code(err))
	}

	doc := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO documents (id, title, owner_id) VALUES ($1, 't', $2)`, doc, alice); err != nil {
		t.Fatal(err)
	}
	member := func(u uuid.UUID, role string) error {
		_, err := pool.Exec(ctx, `INSERT INTO document_members (document_id, user_id, role) VALUES ($1, $2, $3)`, doc, u, role)
		return err
	}
	if err := member(alice, "owner"); err != nil {
		t.Fatal(err)
	}
	if err := member(bob, "admin"); code(err) != "23514" {
		t.Fatalf("invalid role: got %s, want check_violation", code(err))
	}
	if err := member(bob, "owner"); code(err) != "23505" {
		t.Fatalf("second owner: got %s, want unique_violation", code(err))
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
		make([]byte, 16), alice); code(err) != "23514" {
		t.Fatalf("short token hash: got %s, want check_violation", code(err))
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
		make([]byte, 32), alice); err != nil {
		t.Fatal(err)
	}

	// Deleting a user removes their sessions, memberships and owned documents.
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, alice); err != nil {
		t.Fatal(err)
	}
	var left int
	_ = pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM sessions) + (SELECT count(*) FROM document_members) + (SELECT count(*) FROM documents)`).Scan(&left)
	if left != 0 {
		t.Fatalf("%d rows left after deleting the user", left)
	}
}

// Several server instances starting at once all call Up. The advisory lock
// makes one migrate while the others wait; none may fail.
func TestConcurrentUpIsSerialised(t *testing.T) {
	pool := tempDB(t)
	var wg sync.WaitGroup
	errs := make([]error, 4)
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = Up(context.Background(), pool)
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("instance %d: %v", i, err)
		}
	}
	if v, err := provider(t, pool).GetDBVersion(context.Background()); err != nil || v != 3 {
		t.Fatalf("version %d, %v", v, err)
	}
}

func fkValidated(t *testing.T, pool *pgxpool.Pool) bool {
	t.Helper()
	var valid bool
	if err := pool.QueryRow(context.Background(), `
		SELECT convalidated FROM pg_constraint WHERE conname = 'document_updates_user_id_fkey'`).Scan(&valid); err != nil {
		t.Fatalf("constraint missing: %v", err)
	}
	return valid
}

// A database with no orphaned updates gets a fully validated constraint.
func TestMigration3ValidatesForeignKeyOnCleanData(t *testing.T) {
	pool := tempDB(t)
	if _, err := provider(t, pool).Up(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !fkValidated(t, pool) {
		t.Fatal("constraint should be VALIDATED when no orphaned rows exist")
	}
}

// Week 1 rows reference users that never existed. The migration keeps them,
// leaves the constraint NOT VALID, and still rejects new orphaned rows. The
// documented procedure (attribute or remove the legacy rows, then VALIDATE)
// works.
func TestMigration3KeepsLegacyRowsAndEnforcesNewOnes(t *testing.T) {
	ctx := context.Background()
	pool := tempDB(t)
	p := provider(t, pool)
	if _, err := p.UpTo(ctx, 2); err != nil {
		t.Fatal(err)
	}
	doc, ghost := uuid.New(), uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO documents (id, title, head_seq) VALUES ($1, 'poc', 1)`, doc); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO document_updates (document_id, seq, user_id, client_id, client_msg_id, payload)
		VALUES ($1, 1, $2, $3, 1, '\x01')`, doc, ghost, uuid.New()); err != nil {
		t.Fatal(err)
	}

	if _, err := p.Up(ctx); err != nil {
		t.Fatalf("up with legacy rows: %v", err)
	}
	if fkValidated(t, pool) {
		t.Fatal("constraint must stay NOT VALID while orphaned rows exist")
	}
	var kept int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM document_updates WHERE user_id = $1`, ghost).Scan(&kept)
	if kept != 1 {
		t.Fatalf("legacy row count %d, want 1", kept)
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO document_updates (document_id, seq, user_id, client_id, client_msg_id, payload)
		VALUES ($1, 2, $2, $3, 1, '\x01')`, doc, uuid.New(), uuid.New())
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23503" {
		t.Fatalf("new orphaned row: %v, want foreign_key_violation", err)
	}

	// The documented resolution: give the legacy author a placeholder
	// account, then validate.
	if _, err := pool.Exec(ctx, `
		INSERT INTO users (id, email, display_name, password_hash)
		SELECT DISTINCT u.user_id, 'legacy-' || u.user_id || '@invalid', 'Legacy author', '!'
		FROM document_updates u LEFT JOIN users ON users.id = u.user_id WHERE users.id IS NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE document_updates VALIDATE CONSTRAINT document_updates_user_id_fkey`); err != nil {
		t.Fatalf("validate after resolving legacy rows: %v", err)
	}
	if !fkValidated(t, pool) {
		t.Fatal("constraint not validated")
	}
}

// Status is what an operator runs before migrating; it must change nothing,
// even on a database that was never migrated (goose would create its table).
func TestStatusIsReadOnlyAndReportsPending(t *testing.T) {
	ctx := context.Background()
	pool := tempDB(t)
	tables := func() int {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_tables WHERE schemaname = 'public'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	v, pending, err := Status(ctx, pool)
	if err != nil || v != 0 || len(pending) != 3 || tables() != 0 {
		t.Fatalf("fresh: version %d, pending %v, err %v, tables %d", v, pending, err, tables())
	}
	if err := Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if v, pending, err := Status(ctx, pool); err != nil || v != 3 || len(pending) != 0 {
		t.Fatalf("after Up: version %d, pending %v, err %v", v, pending, err)
	}
}

// Week 5 review R8: what deleting an account does today. No feature deletes
// accounts yet; this pins the behaviour such a feature must deal with, which
// the 00003 comment originally described wrongly ("still works").
func TestDeletingAUserWithUpdatesIsRefused(t *testing.T) {
	ctx := context.Background()
	pool := tempDB(t)
	if err := Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	mustExec := func(sql string) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	mustExec(`INSERT INTO users (id, email, display_name, password_hash) VALUES
		('aaaaaaaa-0000-4000-8000-000000000001', 'writer@example.test', 'W', 'x'),
		('aaaaaaaa-0000-4000-8000-000000000002', 'idle@example.test', 'I', 'x'),
		('aaaaaaaa-0000-4000-8000-000000000003', 'editor@example.test', 'E', 'x')`)
	// The writer owns a document and wrote in it; the idle owner's document
	// was written only by an editor.
	mustExec(`INSERT INTO documents (id, title, owner_id, head_seq) VALUES
		('dddddddd-0000-4000-8000-000000000001', 'own', 'aaaaaaaa-0000-4000-8000-000000000001', 1),
		('dddddddd-0000-4000-8000-000000000002', 'shared', 'aaaaaaaa-0000-4000-8000-000000000002', 1)`)
	mustExec(`INSERT INTO document_updates (document_id, seq, user_id, client_id, client_msg_id, payload) VALUES
		('dddddddd-0000-4000-8000-000000000001', 1, 'aaaaaaaa-0000-4000-8000-000000000001', gen_random_uuid(), 1, '\x01'),
		('dddddddd-0000-4000-8000-000000000002', 1, 'aaaaaaaa-0000-4000-8000-000000000003', gen_random_uuid(), 1, '\x02')`)

	// 1. Anyone who wrote an update can't be deleted, even if every update
	// is in their own (cascading) document: the FK check runs first.
	_, err := pool.Exec(ctx, `DELETE FROM users WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'`)
	if err == nil || !strings.Contains(err.Error(), "document_updates_user_id_fkey") {
		t.Fatalf("deleting a writer: %v, want the FK violation", err)
	}
	// 2. Deleting an owner who never wrote succeeds, and the cascade takes
	// their document AND the editor's update in it.
	mustExec(`DELETE FROM users WHERE id = 'aaaaaaaa-0000-4000-8000-000000000002'`)
	var left int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM document_updates WHERE user_id = 'aaaaaaaa-0000-4000-8000-000000000003'`).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 0 {
		t.Fatalf("editor updates left %d; the cascade behaviour changed, update the notes", left)
	}
}
