-- +goose Up
-- Week 2: accounts, server-side sessions, document ownership and membership.
--
-- Existing data: documents created before this migration (the Week 1 PoC)
-- keep owner_id NULL and have no members, so the authenticated API cannot
-- reach them. Nothing is deleted. document_updates is untouched; its
-- user_id deliberately has no foreign key yet (see teach/phases/week-2).

CREATE TABLE users (
    id            uuid        PRIMARY KEY,
    -- Stored normalised (trimmed, lower-case) by the application; the CHECK
    -- makes a forgotten normalisation fail loudly instead of allowing two
    -- accounts that differ only by case.
    email         text        NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
    display_name  text        NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
    password_hash text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (email);

-- Only a SHA-256 hash of each session token is stored; the token itself
-- exists only in the user's cookie.
CREATE TABLE sessions (
    token_hash bytea       PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

ALTER TABLE documents ADD COLUMN owner_id uuid REFERENCES users (id) ON DELETE CASCADE;
CREATE INDEX documents_owner_id_idx ON documents (owner_id);

-- Who may open a document, and how. The owner also has a row (role
-- 'owner'), so every access check is one primary-key lookup.
CREATE TABLE document_members (
    document_id uuid        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role        text        NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, user_id)
);
CREATE INDEX document_members_user_id_idx ON document_members (user_id);
-- At most one owner row per document.
CREATE UNIQUE INDEX document_members_one_owner ON document_members (document_id) WHERE role = 'owner';

-- +goose Down
-- DESTROYS DATA: every account, session and membership, and all document
-- ownership (documents survive but become ownerless and unreachable). Only
-- for tests on throwaway databases; never run it against a database whose
-- data matters without a backup (docs/operations.md).
DROP TABLE document_members;
ALTER TABLE documents DROP COLUMN owner_id;
DROP TABLE sessions;
DROP TABLE users;
