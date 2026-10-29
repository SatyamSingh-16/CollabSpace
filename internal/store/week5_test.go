package store_test

import (
	"context"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"collabspace/internal/store"
)

// Week 5 review R14: appends must not depend on the database's default
// isolation level. Under a REPEATABLE READ default, concurrent appends used
// to fail with 40001.
func TestConcurrentAppendsUnderStricterDefaultIsolation(t *testing.T) {
	cfg := testPool.Config().Copy()
	cfg.ConnConfig.RuntimeParams["default_transaction_isolation"] = "repeatable read"
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	s := store.New(pool)
	doc, user := newDoc(t, s), newUser(t)

	const writers, perWriter = 8, 10
	var wg sync.WaitGroup
	for range writers {
		client := uuid.New()
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := int64(1); i <= perWriter; i++ {
				if _, err := s.AppendUpdate(context.Background(), req(doc, user, client, i)); err != nil {
					t.Errorf("append: %v", err)
					return
				}
			}
		}()
	}
	wg.Wait()
	if head, _ := s.HeadSeq(context.Background(), doc); head != writers*perWriter {
		t.Fatalf("head %d, want %d", head, writers*perWriter)
	}
}

func TestIsPermanent(t *testing.T) {
	cases := map[error]bool{
		&pgconn.PgError{Code: "23503"}: true,  // foreign key
		&pgconn.PgError{Code: "23505"}: true,  // unique
		&pgconn.PgError{Code: "40001"}: false, // serialization: retry may work
		&pgconn.PgError{Code: "57014"}: false, // statement timeout
		context.DeadlineExceeded:       false,
	}
	for err, want := range cases {
		if got := store.IsPermanent(err); got != want {
			t.Errorf("IsPermanent(%v) = %v, want %v", err, got, want)
		}
	}
}
