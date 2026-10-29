package store_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"collabspace/internal/store"
	"collabspace/internal/testdb"
)

// Integration tests need a disposable database; see package testdb.
var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	testdb.Run(m, func(p *pgxpool.Pool) { testPool = p })
}

// newUser creates a real account: updates must reference one (migration 00003).
func newUser(t *testing.T) uuid.UUID { return testdb.NewUser(t, testPool) }

// newDoc creates a fresh document so tests never share state.
func newDoc(t *testing.T, s *store.Store) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if err := s.CreateDocument(context.Background(), id, t.Name()); err != nil {
		t.Fatalf("create document: %v", err)
	}
	return id
}

func req(doc, user, client uuid.UUID, msgID int64) store.AppendRequest {
	return store.AppendRequest{
		DocumentID: doc, UserID: user, ClientID: client, ClientMsgID: msgID,
		Payload: []byte(fmt.Sprintf("update-%s-%d", client, msgID)),
	}
}

func TestAppendAssignsSequentialSeqs(t *testing.T) {
	ctx := context.Background()
	s := store.New(testPool)
	doc, user, client := newDoc(t, s), newUser(t), uuid.New()

	for i := int64(1); i <= 3; i++ {
		res, err := s.AppendUpdate(ctx, req(doc, user, client, i))
		if err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
		if res.Seq != i || res.Duplicate {
			t.Fatalf("append %d: got %+v, want seq %d", i, res, i)
		}
	}
	head, err := s.HeadSeq(ctx, doc)
	if err != nil || head != 3 {
		t.Fatalf("head = %d, %v; want 3", head, err)
	}
}

// Concurrent appends with distinct keys must produce exactly 1..N: no gaps,
// no duplicates. This bypasses the room on purpose; the row lock alone must
// be enough.
func TestConcurrentAppendsHaveNoGaps(t *testing.T) {
	ctx := context.Background()
	s := store.New(testPool)
	doc, user := newDoc(t, s), newUser(t)

	const writers, perWriter = 8, 25
	var (
		mu   sync.Mutex
		seen = make(map[int64]bool)
		wg   sync.WaitGroup
	)
	for w := 0; w < writers; w++ {
		client := uuid.New()
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := int64(1); i <= perWriter; i++ {
				res, err := s.AppendUpdate(ctx, req(doc, user, client, i))
				if err != nil {
					t.Errorf("append: %v", err)
					return
				}
				mu.Lock()
				if seen[res.Seq] {
					t.Errorf("seq %d assigned twice", res.Seq)
				}
				seen[res.Seq] = true
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	const total = writers * perWriter
	for seq := int64(1); seq <= total; seq++ {
		if !seen[seq] {
			t.Fatalf("seq %d missing", seq)
		}
	}
	if head, _ := s.HeadSeq(ctx, doc); head != total {
		t.Fatalf("head = %d, want %d", head, total)
	}
}

func TestDuplicateReturnsOriginalSeq(t *testing.T) {
	ctx := context.Background()
	s := store.New(testPool)
	doc, user, client := newDoc(t, s), newUser(t), uuid.New()

	first, err := s.AppendUpdate(ctx, req(doc, user, client, 1))
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.AppendUpdate(ctx, req(doc, user, client, 1))
	if err != nil {
		t.Fatal(err)
	}
	if !again.Duplicate || again.Seq != first.Seq {
		t.Fatalf("retry = %+v, want duplicate of seq %d", again, first.Seq)
	}
	// The duplicate must not have consumed a sequence number.
	next, err := s.AppendUpdate(ctx, req(doc, user, client, 2))
	if err != nil || next.Seq != first.Seq+1 {
		t.Fatalf("next = %+v, %v; want seq %d", next, err, first.Seq+1)
	}
}

// The same retry racing itself: exactly one writer commits, the others see
// a duplicate of the same seq, and head advances by one.
func TestConcurrentDuplicatesCommitOnce(t *testing.T) {
	ctx := context.Background()
	s := store.New(testPool)
	doc, user, client := newDoc(t, s), newUser(t), uuid.New()

	const racers = 8
	results := make([]store.AppendResult, racers)
	errs := make([]error, racers)
	var wg sync.WaitGroup
	for i := range racers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], errs[i] = s.AppendUpdate(ctx, req(doc, user, client, 1))
		}()
	}
	wg.Wait()

	fresh := 0
	for i := range racers {
		if errs[i] != nil {
			t.Fatalf("racer %d: %v", i, errs[i])
		}
		if results[i].Seq != 1 {
			t.Fatalf("racer %d got seq %d, want 1", i, results[i].Seq)
		}
		if !results[i].Duplicate {
			fresh++
		}
	}
	if fresh != 1 {
		t.Fatalf("%d racers committed, want exactly 1", fresh)
	}
	if head, _ := s.HeadSeq(ctx, doc); head != 1 {
		t.Fatalf("head = %d, want 1", head)
	}
}

func TestClientIDReusedByOtherUserIsRejected(t *testing.T) {
	ctx := context.Background()
	s := store.New(testPool)
	doc, client := newDoc(t, s), uuid.New()

	if _, err := s.AppendUpdate(ctx, req(doc, newUser(t), client, 1)); err != nil {
		t.Fatal(err)
	}
	_, err := s.AppendUpdate(ctx, req(doc, newUser(t), client, 1))
	if !errors.Is(err, store.ErrClientIDConflict) {
		t.Fatalf("err = %v, want ErrClientIDConflict", err)
	}
}

// A failed INSERT must roll back the head_seq increment, otherwise clients
// would wait forever for a seq that was never written.
func TestFailedInsertLeavesNoGap(t *testing.T) {
	ctx := context.Background()
	s := store.New(testPool)
	doc, user, client := newDoc(t, s), newUser(t), uuid.New()

	if _, err := s.AppendUpdate(ctx, req(doc, user, client, 1)); err != nil {
		t.Fatal(err)
	}
	bad := req(doc, user, client, 2)
	bad.Payload = nil // violates CHECK (octet_length BETWEEN 1 AND ...)
	if _, err := s.AppendUpdate(ctx, bad); err == nil {
		t.Fatal("empty payload was accepted")
	}
	res, err := s.AppendUpdate(ctx, req(doc, user, client, 3))
	if err != nil || res.Seq != 2 {
		t.Fatalf("after failure got %+v, %v; want seq 2", res, err)
	}
}

func TestAppendToMissingDocument(t *testing.T) {
	s := store.New(testPool)
	_, err := s.AppendUpdate(context.Background(), req(uuid.New(), uuid.New(), uuid.New(), 1))
	if !errors.Is(err, store.ErrDocumentNotFound) {
		t.Fatalf("err = %v, want ErrDocumentNotFound", err)
	}
}

func TestReadUpdatesRespectsBounds(t *testing.T) {
	ctx := context.Background()
	s := store.New(testPool)
	doc, user, client := newDoc(t, s), newUser(t), uuid.New()
	for i := int64(1); i <= 10; i++ {
		if _, err := s.AppendUpdate(ctx, req(doc, user, client, i)); err != nil {
			t.Fatal(err)
		}
	}

	got, err := s.ReadUpdates(ctx, doc, 3, 7, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 || got[0].Seq != 4 || got[3].Seq != 7 {
		t.Fatalf("got seqs %v, want 4..7", seqs(got))
	}

	page, err := s.ReadUpdates(ctx, doc, 0, 10, 3)
	if err != nil || len(page) != 3 || page[2].Seq != 3 {
		t.Fatalf("page = %v, %v; want 1..3", seqs(page), err)
	}
}

func seqs(us []store.Update) []int64 {
	out := make([]int64, len(us))
	for i, u := range us {
		out[i] = u.Seq
	}
	return out
}

// Migration 00003: a new update must be attributed to an existing user.
func TestAppendRejectsUnknownUser(t *testing.T) {
	ctx := context.Background()
	s := store.New(testPool)
	doc := newDoc(t, s)
	_, err := s.AppendUpdate(ctx, req(doc, uuid.New(), uuid.New(), 1))
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23503" {
		t.Fatalf("err = %v, want foreign_key_violation", err)
	}
	if head, _ := s.HeadSeq(ctx, doc); head != 0 {
		t.Fatalf("head = %d after a rejected append, want 0 (no gap)", head)
	}
}
