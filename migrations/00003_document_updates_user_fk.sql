-- +goose Up
-- Week 3: every NEW collaboration update must be attributed to a real user.
--
-- ON DELETE is left as the default NO ACTION, deliberately not CASCADE:
-- document_updates is an append-only CRDT log, and other users' documents
-- depend on every update in it. Deleting an account must not silently delete
-- history; an account that authored updates must be anonymised, not removed.
--
-- Correction (Week 5 review R8): an earlier version of this comment said that
-- deleting a user whose own documents cascade away "still works". It doesn't:
-- PostgreSQL checks this NO ACTION constraint before the documents cascade
-- removes those updates, so deleting anyone who wrote a single update fails.
-- Conversely, deleting an owner who never wrote succeeds and cascades away
-- their documents, including collaborators' updates in them. An account
-- deletion feature must decide both cases explicitly
-- (TestDeletingAUserWithUpdatesIsRefused pins today's behaviour).
--
-- Locking (Week 5 review R16): goose runs this file in one transaction, so
-- the lock taken by ADD CONSTRAINT (blocking writes to document_updates and
-- users) is held through the orphan scan, VALIDATE and CREATE INDEX. That is
-- harmless at this project's size. On a large table, put VALIDATE in a
-- separate migration marked with goose's NO TRANSACTION annotation and use
-- CREATE INDEX CONCURRENTLY.
--
-- Existing rows may reference users that never existed (the Week 1 PoC used
-- random development identities). The constraint is therefore added NOT
-- VALID: it is enforced for every new row, and existing rows are not checked.
-- If no such orphaned rows exist (a fresh database), it is validated at once.
-- Otherwise it stays NOT VALID until the legacy rows are dealt with; see
-- teach/phases/week-3-hardening.md for the check and VALIDATE commands.

ALTER TABLE document_updates
    ADD CONSTRAINT document_updates_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users (id) NOT VALID;

-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM document_updates u
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.id = u.user_id)
    ) THEN
        ALTER TABLE document_updates VALIDATE CONSTRAINT document_updates_user_id_fkey;
    END IF;
END
$$;
-- +goose StatementEnd

-- Deleting or updating a user checks this column; without an index that is a
-- full scan of the update log.
CREATE INDEX document_updates_user_id_idx ON document_updates (user_id);

-- +goose Down
DROP INDEX document_updates_user_id_idx;
ALTER TABLE document_updates DROP CONSTRAINT document_updates_user_id_fkey;
