-- +goose Up
-- PoC subset of the schema (design §4). users/workspaces arrive in Week 2;
-- the user_id foreign key and documents.workspace_id are added then.

CREATE TABLE documents (
    id         uuid        PRIMARY KEY,
    title      text        NOT NULL,
    head_seq   bigint      NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only log of opaque Yjs updates. seq is assigned from
-- documents.head_seq inside the same transaction, so it has no gaps.
CREATE TABLE document_updates (
    document_id   uuid        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    seq           bigint      NOT NULL,
    user_id       uuid        NOT NULL,
    client_id     uuid        NOT NULL,
    client_msg_id bigint      NOT NULL,
    payload       bytea       NOT NULL CHECK (octet_length(payload) BETWEEN 1 AND 524288),
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, seq),
    UNIQUE (document_id, client_id, client_msg_id)
);

-- +goose Down
DROP TABLE document_updates;
DROP TABLE documents;
