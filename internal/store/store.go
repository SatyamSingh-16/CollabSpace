// Package store persists the per-document collaboration log in PostgreSQL.
//
// The Go server never interprets update payloads; they are opaque Yjs bytes.
// What the store guarantees is ordering and durability: every update gets a
// per-document sequence number with no gaps, and AppendUpdate returns success
// only after the transaction has committed.
package store

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
	ErrDocumentNotFound = errors.New("store: document not found")

	// ErrClientIDConflict means a (client_id, client_msg_id) pair was already
	// used by a different user. A client must never reuse another user's ID.
	ErrClientIDConflict = errors.New("store: client id already used by another user")

	// ErrCommitAmbiguous means COMMIT was sent but no reply arrived, so the
	// update may or may not be durable. Callers must not report success or
	// failure; they reset and let clients resend (deduplication decides).
	ErrCommitAmbiguous = errors.New("store: commit outcome unknown")
)

// rollbackTimeout bounds the deferred ROLLBACK in AppendUpdate.
const rollbackTimeout = 2 * time.Second

// IsPermanent reports whether err is an integrity violation (SQLSTATE class
// 23, e.g. a foreign key to a deleted user). Retrying the same append can
// never succeed, so the client must not be told to retry (Week 5 review D6).
func IsPermanent(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && len(pgErr.Code) == 5 && pgErr.Code[:2] == "23"
}

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// Update is one committed entry in a document's log.
type Update struct {
	Seq     int64
	UserID  uuid.UUID
	Payload []byte
}

// AppendRequest identifies an update by its sender so retries can be deduplicated.
type AppendRequest struct {
	DocumentID  uuid.UUID
	UserID      uuid.UUID
	ClientID    uuid.UUID
	ClientMsgID int64
	Payload     []byte
}

// AppendResult reports the sequence number of the update. Duplicate is true
// when the same (client_id, client_msg_id) was already committed; Seq is then
// the original sequence number and nothing new was written.
type AppendResult struct {
	Seq       int64
	Duplicate bool
}

// CreateDocument inserts an empty document. Creating a document writes no
// Yjs bytes: an empty log is the initial state (design §6).
func (s *Store) CreateDocument(ctx context.Context, id uuid.UUID, title string) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO documents (id, title) VALUES ($1, $2)`, id, title)
	return err
}

// HeadSeq returns the last committed sequence number for a document.
//
// FOR SHARE waits for any transaction still holding the document's row lock,
// i.e. an AppendUpdate in flight. A room that resets after an ambiguous
// commit starts by reading head here; a plain SELECT would not wait, and if
// that commit then landed, the new room would start below it and nobody
// would be sent the update unless its author resent it (Week 5 review R3).
func (s *Store) HeadSeq(ctx context.Context, docID uuid.UUID) (int64, error) {
	var head int64
	err := s.pool.QueryRow(ctx, `SELECT head_seq FROM documents WHERE id = $1 FOR SHARE`, docID).Scan(&head)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrDocumentNotFound
	}
	return head, err
}

// AppendUpdate durably appends one update and assigns it the next sequence
// number. The UPDATE ... RETURNING takes a row lock on the document, which
// serialises concurrent appends. Because the counter increment and the INSERT
// are in one transaction, a failed INSERT rolls the counter back too, so
// sequence numbers never have gaps.
func (s *Store) AppendUpdate(ctx context.Context, req AppendRequest) (AppendResult, error) {
	// READ COMMITTED explicitly: the dedup lookup below relies on it, and a
	// stricter database default would turn concurrent appends into
	// serialization failures (Week 5 review R14).
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return AppendResult{}, fmt.Errorf("begin: %w", err)
	}
	// Rollback after a successful Commit is a no-op. It gets its own short
	// deadline: it must still run if ctx is already cancelled, but must not
	// block the caller (the room goroutine) for minutes on a dead network.
	defer func() {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), rollbackTimeout)
		defer cancel()
		_ = tx.Rollback(rctx)
	}()

	// Take the document row lock first. Under READ COMMITTED each statement
	// sees everything committed before it started, so the dedup lookup below
	// cannot miss a duplicate committed by a writer we were waiting on.
	var seq int64
	err = tx.QueryRow(ctx, `
		UPDATE documents SET head_seq = head_seq + 1, updated_at = now()
		WHERE id = $1 RETURNING head_seq`,
		req.DocumentID,
	).Scan(&seq)
	if errors.Is(err, pgx.ErrNoRows) {
		return AppendResult{}, ErrDocumentNotFound
	}
	if err != nil {
		return AppendResult{}, fmt.Errorf("advance head: %w", err)
	}

	var (
		existingSeq  int64
		existingUser uuid.UUID
	)
	err = tx.QueryRow(ctx, `
		SELECT seq, user_id FROM document_updates
		WHERE document_id = $1 AND client_id = $2 AND client_msg_id = $3`,
		req.DocumentID, req.ClientID, req.ClientMsgID,
	).Scan(&existingSeq, &existingUser)
	switch {
	case err == nil:
		// Returning without Commit rolls back the head_seq increment.
		if existingUser != req.UserID {
			return AppendResult{}, ErrClientIDConflict
		}
		return AppendResult{Seq: existingSeq, Duplicate: true}, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return AppendResult{}, fmt.Errorf("dedup lookup: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO document_updates (document_id, seq, user_id, client_id, client_msg_id, payload)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		req.DocumentID, seq, req.UserID, req.ClientID, req.ClientMsgID, req.Payload,
	)
	if err != nil {
		return AppendResult{}, fmt.Errorf("insert update: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		// If PostgreSQL answered with an error, it definitely rolled back.
		// Any other error (connection lost, context cancelled) means we sent
		// COMMIT without learning the outcome.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			return AppendResult{}, fmt.Errorf("commit: %w", err)
		}
		return AppendResult{}, fmt.Errorf("%w: %v", ErrCommitAmbiguous, err)
	}
	return AppendResult{Seq: seq}, nil
}

// ReadUpdates returns committed updates with afterSeq < seq <= uptoSeq in
// ascending order, at most limit rows. The upper bound is what makes replay
// and live delivery disjoint (design §1, I3); committed rows never change, so
// no snapshot isolation is needed.
func (s *Store) ReadUpdates(ctx context.Context, docID uuid.UUID, afterSeq, uptoSeq int64, limit int) ([]Update, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT seq, user_id, payload FROM document_updates
		WHERE document_id = $1 AND seq > $2 AND seq <= $3
		ORDER BY seq
		LIMIT $4`,
		docID, afterSeq, uptoSeq, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("read updates: %w", err)
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Update, error) {
		var u Update
		err := row.Scan(&u.Seq, &u.UserID, &u.Payload)
		return u, err
	})
}
