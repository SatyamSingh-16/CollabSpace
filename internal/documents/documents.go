// Package documents owns document metadata and who may access what.
//
// Permission model (Week 2): every document has exactly one owner. The owner
// can share it with other registered users as editor (read and write) or
// viewer (read only). Access is decided by a document_members row; a user
// with no row cannot see that the document exists (404, not 403).
package documents

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Role string

const (
	RoleOwner  Role = "owner"
	RoleEditor Role = "editor"
	RoleViewer Role = "viewer"
)

var (
	ErrNotFound      = errors.New("documents: not found")
	ErrUserNotFound  = errors.New("documents: no user with that email")
	ErrOwnerRole     = errors.New("documents: the owner's role cannot be changed")
	ErrAlreadyOwned  = errors.New("documents: document already has an owner")
	errInvalidRole   = errors.New("documents: invalid role")
	maxTitleRunes    = 200
	defaultListLimit = 200
)

type Document struct {
	ID        uuid.UUID `json:"id"`
	Title     string    `json:"title"`
	OwnerID   uuid.UUID `json:"owner_id"`
	Role      Role      `json:"role"` // the requesting user's role
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	// Online is how many distinct users have the document open right now
	// (from the collaboration hub; lists only, a snapshot).
	Online int `json:"online"`
}

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// Create inserts a document and its owner membership in one transaction.
func (s *Store) Create(ctx context.Context, ownerID uuid.UUID, title string) (Document, error) {
	d := Document{ID: uuid.New(), Title: title, OwnerID: ownerID, Role: RoleOwner}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Document{}, err
	}
	defer rollback(ctx, tx)
	err = tx.QueryRow(ctx, `
		INSERT INTO documents (id, title, owner_id) VALUES ($1, $2, $3)
		RETURNING created_at, updated_at`, d.ID, d.Title, ownerID,
	).Scan(&d.CreatedAt, &d.UpdatedAt)
	if err != nil {
		return Document{}, fmt.Errorf("insert document: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO document_members (document_id, user_id, role) VALUES ($1, $2, 'owner')`, d.ID, ownerID,
	); err != nil {
		return Document{}, fmt.Errorf("insert owner membership: %w", err)
	}
	return d, tx.Commit(ctx)
}

// ListForUser returns the documents the user is a member of, most recently
// updated first.
func (s *Store) ListForUser(ctx context.Context, userID uuid.UUID) ([]Document, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT d.id, d.title, d.owner_id, m.role, d.created_at, d.updated_at
		FROM document_members m JOIN documents d ON d.id = m.document_id
		WHERE m.user_id = $1
		ORDER BY d.updated_at DESC
		LIMIT $2`, userID, defaultListLimit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scanDocument)
}

// GetForUser returns the document only if the user is a member.
func (s *Store) GetForUser(ctx context.Context, docID, userID uuid.UUID) (Document, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT d.id, d.title, d.owner_id, m.role, d.created_at, d.updated_at
		FROM document_members m JOIN documents d ON d.id = m.document_id
		WHERE m.document_id = $1 AND m.user_id = $2`, docID, userID)
	if err != nil {
		return Document{}, err
	}
	d, err := pgx.CollectExactlyOneRow(rows, scanDocument)
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrNotFound
	}
	return d, err
}

func scanDocument(row pgx.CollectableRow) (Document, error) {
	var d Document
	err := row.Scan(&d.ID, &d.Title, &d.OwnerID, &d.Role, &d.CreatedAt, &d.UpdatedAt)
	return d, err
}

// RoleFor is the single authorization lookup used by the API and the
// WebSocket handshake.
func (s *Store) RoleFor(ctx context.Context, docID, userID uuid.UUID) (Role, error) {
	var role Role
	err := s.pool.QueryRow(ctx, `
		SELECT role FROM document_members WHERE document_id = $1 AND user_id = $2`, docID, userID,
	).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return role, err
}

// SetMember gives the user with the given (normalised) email the role
// editor or viewer on the document, adding or changing their membership.
// Callers must have checked that the requester is the owner.
func (s *Store) SetMember(ctx context.Context, docID uuid.UUID, email string, role Role) (uuid.UUID, error) {
	if role != RoleEditor && role != RoleViewer {
		return uuid.Nil, errInvalidRole
	}
	var userID uuid.UUID
	err := s.pool.QueryRow(ctx, `SELECT id FROM users WHERE email = $1`, email).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrUserNotFound
	}
	if err != nil {
		return uuid.Nil, err
	}
	// The WHERE on the conflict branch refuses to touch the owner's row; in
	// that case nothing is returned.
	err = s.pool.QueryRow(ctx, `
		INSERT INTO document_members (document_id, user_id, role) VALUES ($1, $2, $3)
		ON CONFLICT (document_id, user_id) DO UPDATE SET role = EXCLUDED.role
		WHERE document_members.role <> 'owner'
		RETURNING user_id`, docID, userID, role,
	).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrOwnerRole
	}
	return userID, err
}

// Rename sets the document's title. Callers must have checked that the
// requester may edit it.
func (s *Store) Rename(ctx context.Context, docID uuid.UUID, title string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE documents SET title = $2, updated_at = now() WHERE id = $1`, docID, title)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// Delete removes the document; its update log and memberships go with it
// (ON DELETE CASCADE). Callers must have checked that the requester is the
// owner. An append racing with this either commits first (and is deleted
// with the rest) or finds no document row and fails.
func (s *Store) Delete(ctx context.Context, docID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM documents WHERE id = $1`, docID)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

type Member struct {
	UserID      uuid.UUID `json:"user_id"`
	Email       string    `json:"email"`
	DisplayName string    `json:"display_name"`
	Role        Role      `json:"role"`
}

// ListMembers returns everyone with access, owner first.
func (s *Store) ListMembers(ctx context.Context, docID uuid.UUID) ([]Member, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT u.id, u.email, u.display_name, m.role
		FROM document_members m JOIN users u ON u.id = m.user_id
		WHERE m.document_id = $1
		ORDER BY m.role = 'owner' DESC, u.email`, docID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Member, error) {
		var m Member
		err := row.Scan(&m.UserID, &m.Email, &m.DisplayName, &m.Role)
		return m, err
	})
}

// RemoveMember deletes a non-owner membership.
func (s *Store) RemoveMember(ctx context.Context, docID, userID uuid.UUID) error {
	var role Role
	err := s.pool.QueryRow(ctx, `
		DELETE FROM document_members WHERE document_id = $1 AND user_id = $2 AND role <> 'owner'
		RETURNING role`, docID, userID).Scan(&role)
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	// Nothing deleted: either not a member, or the owner.
	if r, err := s.RoleFor(ctx, docID, userID); err == nil && r == RoleOwner {
		return ErrOwnerRole
	}
	return ErrNotFound
}

// ClaimOrphan gives an ownerless document (created before accounts existed)
// to the user with the given normalised email. It touches only documents
// and document_members; the update log is not modified. It refuses if the
// document already has an owner or any member.
func (s *Store) ClaimOrphan(ctx context.Context, docID uuid.UUID, email string) (uuid.UUID, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer rollback(ctx, tx)

	var owner *uuid.UUID
	err = tx.QueryRow(ctx, `SELECT owner_id FROM documents WHERE id = $1 FOR UPDATE`, docID).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrNotFound
	}
	if err != nil {
		return uuid.Nil, err
	}
	var members int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM document_members WHERE document_id = $1`, docID).Scan(&members); err != nil {
		return uuid.Nil, err
	}
	if owner != nil || members > 0 {
		return uuid.Nil, ErrAlreadyOwned
	}
	var userID uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id FROM users WHERE email = $1`, email).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrUserNotFound
	}
	if err != nil {
		return uuid.Nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE documents SET owner_id = $2 WHERE id = $1`, docID, userID); err != nil {
		return uuid.Nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO document_members (document_id, user_id, role) VALUES ($1, $2, 'owner')`, docID, userID); err != nil {
		return uuid.Nil, err
	}
	return userID, tx.Commit(ctx)
}

// rollback ignores the request's cancellation but is bounded, so a dead
// network can't hold a pool connection indefinitely (Week 5 review D3).
// After Commit it is a no-op.
func rollback(ctx context.Context, tx pgx.Tx) {
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	_ = tx.Rollback(rctx)
}
