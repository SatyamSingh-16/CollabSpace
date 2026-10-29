// Wire format of the Go collaboration server (internal/collab/protocol.go).
// Every frame is JSON text; Yjs bytes travel as standard base64 (Go's
// encoding of []byte). Keep this file in sync with the Go definitions.

export const PROTOCOL_VERSION = 1

export type ClientMessage =
  | { type: 'join'; v: number; client_id: string; after_seq: number }
  | { type: 'update'; client_msg_id: number; data: string }

export type ServerMessage =
  | { type: 'joined'; head_seq: number; role: string; conn_id: string }
  | { type: 'update'; seq: number; data: string; user_id: string }
  | { type: 'synced'; seq: number }
  | { type: 'committed'; client_msg_id: number; seq: number }
  | { type: 'error'; code: ErrorCode; message?: string; client_msg_id?: number; retryable: boolean }
  | { type: 'presence'; users: Participant[] }

/**
 * One user connected to the document (Week 4). The server lists each user
 * once, however many tabs they have open; identity, name and role come from
 * the server's session and membership checks. Sorted by user_id.
 */
export interface Participant {
  user_id: string
  display_name: string
  role: string
}

export type ErrorCode = 'persist_failed' | 'server_busy' | 'invalid_payload'

export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001, // server shutdown
  MessageTooBig: 1009,
  Unauthenticated: 4001, // no session, signed out, or session expired (also while connected)
  Forbidden: 4003, // viewer tried to write, or access was removed while connected
  DocumentNotFound: 4004,
  ResyncRequired: 4008, // slow client, room reset, or role changed: reconnect with after_seq
  ProtocolError: 4009,
  RoomFull: 4013,
} as const

// Closes after which reconnecting cannot help: the same request would be
// refused again (or, for 1009, the same oversized message would be resent).
export const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  CloseCode.MessageTooBig,
  CloseCode.Unauthenticated,
  CloseCode.Forbidden,
  CloseCode.DocumentNotFound,
  CloseCode.ProtocolError,
])
