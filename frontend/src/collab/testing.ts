// Test helpers: a scripted stand-in for the server's WebSocket.
import * as Y from 'yjs'

import { toBase64 } from './base64'
import type { ClientMessage, ServerMessage } from './protocol'

/**
 * FakeSocket implements the parts of WebSocket the provider uses. The test
 * plays the server: it opens the socket, pushes server messages and closes
 * it with a chosen code. Everything is synchronous, so tests are
 * deterministic.
 */
export class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  sent: ClientMessage[] = []
  closedByClient = false
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  static latest(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1]
  }

  static factory = (url: string) => new FakeSocket(url) as unknown as WebSocket

  // --- called by the provider ---
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.closedByClient = true
    this.readyState = 3
  }

  // --- called by the test, acting as the server ---
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  deliver(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  serverClose(code: number, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
  updates() {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: 'update' }> => m.type === 'update')
  }
}

/** Yjs updates authored by "someone else", to replay as server messages. */
export function remoteEdits(...texts: string[]): Uint8Array[] {
  const doc = new Y.Doc()
  const out: Uint8Array[] = []
  doc.on('update', (u: Uint8Array) => out.push(u))
  for (const t of texts) doc.getText('t').insert(doc.getText('t').length, t)
  return out
}

export function updateMsg(seq: number, update: Uint8Array): ServerMessage {
  return { type: 'update', seq, data: toBase64(update), user_id: 'someone' }
}
