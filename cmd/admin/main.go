// Command admin holds maintenance tasks run by an operator.
//
//	migrate-status  print the schema version and pending migrations (read-only)
//	migrate         apply pending migrations (take a backup first; see
//	                docs/operations.md). For servers run with MIGRATE_ON_START=false.
//	claim-document  give an ownerless (pre-accounts, Week 1) document to an
//	                existing account. Dry run unless -yes is passed.
//
// Usage:
//
//	DATABASE_URL=... go run ./cmd/admin migrate-status
//	DATABASE_URL=... go run ./cmd/admin migrate
//	DATABASE_URL=... go run ./cmd/admin claim-document -document <uuid> -email <email> [-yes]
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"collabspace/internal/auth"
	"collabspace/internal/config"
	"collabspace/internal/documents"
	"collabspace/migrations"
)

const usage = `usage:
  admin migrate-status
  admin migrate
  admin claim-document -document <uuid> -email <email> [-yes]`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "migrate-status":
		err = migrateStatus()
	case "migrate":
		err = migrate()
	case "claim-document":
		err = claimCommand(os.Args[2:])
	default:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// connect opens DATABASE_URL. The DSN is never printed: it may hold a
// password.
func connect(ctx context.Context) (*pgxpool.Pool, error) {
	dsn, err := config.DatabaseURL(os.Getenv) // DATABASE_URL or DATABASE_URL_FILE
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	fmt.Println("database:", pool.Config().ConnConfig.Database)
	return pool, nil
}

func migrateStatus() error {
	ctx := context.Background()
	pool, err := connect(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()
	current, pending, err := migrations.Status(ctx, pool)
	if err != nil {
		return err
	}
	fmt.Println("schema version:", current)
	if len(pending) == 0 {
		fmt.Println("pending: none")
	}
	for _, p := range pending {
		fmt.Println("pending:", p)
	}
	return nil
}

func migrate() error {
	ctx := context.Background()
	pool, err := connect(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()
	before, _, err := migrations.Status(ctx, pool)
	if err != nil {
		return err
	}
	if err := migrations.Up(ctx, pool); err != nil {
		return err
	}
	after, _, err := migrations.Status(ctx, pool)
	if err != nil {
		return err
	}
	fmt.Printf("schema version: %d -> %d\n", before, after)
	return nil
}

func claimCommand(args []string) error {
	fs := flag.NewFlagSet("claim-document", flag.ExitOnError)
	docFlag := fs.String("document", "", "document id")
	emailFlag := fs.String("email", "", "email of the account that becomes owner")
	yes := fs.Bool("yes", false, "apply the change (default: dry run)")
	_ = fs.Parse(args)
	return claim(*docFlag, *emailFlag, *yes)
}

func claim(docArg, emailArg string, apply bool) error {
	docID, err := uuid.Parse(docArg)
	if err != nil {
		return fmt.Errorf("-document: %w", err)
	}
	email, err := auth.NormalizeEmail(emailArg)
	if err != nil {
		return fmt.Errorf("-email: %w", err)
	}
	ctx := context.Background()
	pool, err := connect(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()

	before, err := describe(ctx, pool, docID)
	if err != nil {
		return err
	}
	fmt.Println("document:", before.summary)
	var userID uuid.UUID
	err = pool.QueryRow(ctx, `SELECT id FROM users WHERE email = $1`, email).Scan(&userID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return fmt.Errorf("no account with email %s (register it first)", email)
	case err != nil:
		return fmt.Errorf("look up account: %w", err) // not "no account": a connection error, say
	}
	fmt.Printf("new owner: %s (%s)\n", email, userID)
	// The same rule ClaimOrphan enforces, checked up front, so a dry run
	// doesn't invite "-yes" for a claim that will be refused (Week 5 review R15).
	if before.owned || before.members > 0 {
		return fmt.Errorf("refused: the document already has an owner or members; only an orphaned document can be claimed")
	}
	if !apply {
		fmt.Println("dry run: nothing changed. The claim is allowed; re-run with -yes to apply.")
		return nil
	}

	if _, err := documents.NewStore(pool).ClaimOrphan(ctx, docID, email); err != nil {
		return err
	}
	after, err := describe(ctx, pool, docID)
	if err != nil {
		return err
	}
	fmt.Println("claimed: ", after.summary)
	return nil
}

type docState struct {
	summary string
	owned   bool
	members int64
}

func describe(ctx context.Context, pool *pgxpool.Pool, docID uuid.UUID) (docState, error) {
	var title string
	var owner *uuid.UUID
	var head, updates, members int64
	err := pool.QueryRow(ctx, `
		SELECT d.title, d.owner_id, d.head_seq,
		       (SELECT count(*) FROM document_updates u WHERE u.document_id = d.id),
		       (SELECT count(*) FROM document_members m WHERE m.document_id = d.id)
		FROM documents d WHERE d.id = $1`, docID).Scan(&title, &owner, &head, &updates, &members)
	if err != nil {
		return docState{}, fmt.Errorf("document %s: %w", docID, err)
	}
	o := "none"
	if owner != nil {
		o = owner.String()
	}
	return docState{
		summary: fmt.Sprintf("%q owner=%s head_seq=%d updates=%d members=%d", title, o, head, updates, members),
		owned:   owner != nil,
		members: members,
	}, nil
}
