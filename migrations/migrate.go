package migrations

import (
	"context"
	"io/fs"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

// Up applies every pending migration in FS to the pool's database. A
// PostgreSQL advisory lock serialises concurrent callers (several server
// instances starting at once): one migrates, the others wait and then find
// nothing pending.
func Up(ctx context.Context, pool *pgxpool.Pool) error {
	provider, err := newProvider(pool)
	if err != nil {
		return err
	}
	_, err = provider.Up(ctx)
	return err
}

// Status reports the database's schema version and the migrations not yet
// applied to it. It changes nothing.
func Status(ctx context.Context, pool *pgxpool.Pool) (current int64, pending []string, err error) {
	// goose creates its version table when asked for the version. On a
	// database that was never migrated, answer without it, so this stays
	// read-only.
	var migrated bool
	if err := pool.QueryRow(ctx, `SELECT to_regclass('goose_db_version') IS NOT NULL`).Scan(&migrated); err != nil {
		return 0, nil, err
	}
	if !migrated {
		names, err := fs.Glob(FS, "*.sql")
		return 0, names, err
	}
	provider, err := newProvider(pool)
	if err != nil {
		return 0, nil, err
	}
	current, err = provider.GetDBVersion(ctx)
	if err != nil {
		return 0, nil, err
	}
	statuses, err := provider.Status(ctx)
	if err != nil {
		return 0, nil, err
	}
	for _, s := range statuses {
		if s.State == goose.StatePending {
			pending = append(pending, s.Source.Path)
		}
	}
	return current, pending, nil
}

func newProvider(pool *pgxpool.Pool) (*goose.Provider, error) {
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return nil, err
	}
	return goose.NewProvider(goose.DialectPostgres, stdlib.OpenDBFromPool(pool), FS, goose.WithSessionLocker(locker))
}
