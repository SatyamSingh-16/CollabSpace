import * as Y from 'yjs'

import { fromBase64, toBase64 } from './base64'
import {
  CloseCode,
  PROTOCOL_VERSION,
  TERMINAL_CLOSE_CODES,
  type ClientMessage,
  type Participant,
  type ServerMessage,
} from './protocol'

// CollabProvider connects one Y.Doc to the CollabSpace Go server.
//
// It is NOT y-websocket: the server doesn't speak the Yjs sync protocol. It
// stores opaque Yjs updates in a numbered log, and this provider follows the
// application protocol from the Phase 0 design:
//
//  - join with after_seq = appliedSeq, the highest seq such that every
//    update up to it has been applied; the server replays (after_seq, head]
//    and then sends "synced".
//  - apply update{seq} only when seq == appliedSeq + 1; drop seq <= appliedSeq
//    (already applied); anything else is a gap, so resync.
//  - local updates are batched, given a client_msg_id, kept in `pending`
//    until the server says "committed", and resent with the SAME ids after
//    any reconnect, so the server can deduplicate them.
//
// One Y.Doc is used for the provider's whole life; reconnecting never
// replaces it, so local edits made while offline are kept.

export type ConnectionStatus = 'connecting' | 'syncing' | 'connected' | 'offline' | 'error'

export interface ProviderState {
  status: ConnectionStatus
  /** True once the first initial sync finished. Editing is allowed from then on. */
  synced: boolean
  /** No local change is waiting to be sent or acknowledged. */
  saved: boolean
  appliedSeq: number
  pendingCount: number
  error: string | null
  /** The role the server granted at the last join (it can change on reconnect). */
  role: string | null
  /** The close code that stopped the provider for good, if any. */
  closeCode: number | null
  /**
   * Local changes that could not be saved because the server now grants
   * read-only access. The local Y.Doc then contains text nobody else has;
   * the app should start over with a fresh Y.Doc.
   */
  discardedEdits: number
  /**
   * Who else is connected, from the server's latest presence message on the
   * current connection. null whenever there is no live connection: a list
   * from a closed connection would be stale, so it is never shown.
   */
  participants: Participant[] | null
  /**
   * The local Y.Doc holds an edit the server will never accept (rejected,
   * or too large). It can't be saved; `saved` stays false so the page keeps
   * warning before unload, and restart() is refused.
   */
  diverged: boolean
}

export interface ProviderOptions {
  url: string
  doc: Y.Doc
  /** Defaults to the browser WebSocket. Tests inject fakes or the `ws` package. */
  createSocket?: (url: string) => WebSocket
  clientId?: string
  /** Local updates within this window are merged into one message. */
  batchMs?: number
  /** Most unacknowledged messages at once; further edits keep merging locally. */
  maxInFlight?: number
  /** Local updates are merged into one message only up to this many bytes. */
  maxMessageBytes?: number
  /** The server's limit on one update (internal/collab MaxPayloadBytes). */
  maxUpdateBytes?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  /** Source of jitter in [0, 1); injectable for tests. */
  random?: () => number
  /** Called when a connection attempt closes before the WebSocket opened. */
  onConnectFailed?: () => void
}

const OPEN = 1

/** Full-jitter exponential backoff: random in [0, min(max, base * 2^attempt)). */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  return random() * Math.min(maxMs, baseMs * 2 ** attempt)
}

export class CollabProvider {
  readonly doc: Y.Doc
  readonly clientId: string

  private readonly url: string
  private readonly createSocket: (url: string) => WebSocket
  private readonly batchMs: number
  private readonly maxInFlight: number
  private readonly maxMessageBytes: number
  private readonly maxUpdateBytes: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly random: () => number
  private readonly onConnectFailed?: () => void

  private socket: WebSocket | null = null
  /** This connection has received "synced": sending is allowed. */
  private live = false
  private appliedSeq = 0
  private nextMsgId = 1
  /** Sent, waiting for "committed". Map order is id order. */
  private readonly pending = new Map<number, Uint8Array>()
  /** Local updates not yet given an id. */
  private unsent: Uint8Array[] = []

  private reconnectAttempt = 0
  private retryAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  private status: ConnectionStatus = 'connecting'
  private everSynced = false
  private error: string | null = null
  private role: string | null = null
  private closeCode: number | null = null
  private discardedEdits = 0
  private diverged = false
  private participants: Participant[] | null = null
  private state: ProviderState
  private readonly listeners = new Set<(s: ProviderState) => void>()

  constructor(opts: ProviderOptions) {
    this.doc = opts.doc
    this.url = opts.url
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url))
    this.clientId = opts.clientId ?? crypto.randomUUID()
    this.batchMs = opts.batchMs ?? 50
    this.maxInFlight = opts.maxInFlight ?? 32
    this.maxMessageBytes = opts.maxMessageBytes ?? 256 * 1024
    this.maxUpdateBytes = opts.maxUpdateBytes ?? 512 * 1024
    this.backoffBaseMs = opts.backoffBaseMs ?? 500
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000
    this.random = opts.random ?? Math.random
    this.onConnectFailed = opts.onConnectFailed
    this.state = this.snapshot()

    this.doc.on('update', this.onDocUpdate)
    this.connect()
  }

  getState = (): ProviderState => this.state

  subscribe = (listener: (s: ProviderState) => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.doc.off('update', this.onDocUpdate)
    this.clearTimers()
    const ws = this.socket
    this.socket = null
    ws?.close(CloseCode.Normal)
    this.listeners.clear()
  }

  // --- local changes ---

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // Updates we applied from the server carry `this` as their origin.
    // Sending them back would be an echo loop.
    if (origin === this) return
    this.unsent.push(update)
    if (this.batchTimer === null) {
      this.batchTimer = setTimeout(() => {
        this.batchTimer = null
        this.flush()
      }, this.batchMs)
    }
    this.emit()
  }

  /**
   * Turn unsent local updates into numbered messages, as many as allowed now.
   *
   * Merging is capped at maxMessageBytes. Merging everything typed while
   * offline into one message used to exceed the server's limit, which
   * rejects the message for good and lost every edit in it, although each
   * edit alone was acceptable (Week 5 review R2).
   */
  private flush(): void {
    if (this.live && this.role === 'viewer') {
      this.discardLocalChanges() // a viewer's edits are never sent
      return
    }
    let sent = false
    while (this.live && this.unsent.length > 0 && this.pending.size < this.maxInFlight) {
      let n = 1
      let size = this.unsent[0].byteLength
      while (n < this.unsent.length && size + this.unsent[n].byteLength <= this.maxMessageBytes) {
        size += this.unsent[n].byteLength
        n++
      }
      const batch = this.unsent.splice(0, n)
      const data = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch)
      if (data.byteLength > this.maxUpdateBytes) {
        // One edit (e.g. a huge paste) bigger than the server accepts. It
        // can't be saved; say so instead of sending it to be rejected.
        this.diverged = true
        this.fail(
          `an edit is too large to save (${Math.ceil(data.byteLength / 1024)} KB; the limit is ${this.maxUpdateBytes / 1024} KB). Copy your recent text, then reload.`,
        )
        return
      }
      const id = this.nextMsgId++
      this.pending.set(id, data)
      this.sendUpdate(id, data)
      sent = true
    }
    if (sent) this.emit()
  }

  private sendUpdate(id: number, data: Uint8Array): void {
    this.send({ type: 'update', client_msg_id: id, data: toBase64(data) })
  }

  private send(msg: ClientMessage): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(msg))
  }

  /**
   * Try again after the provider stopped for good, e.g. once the user has
   * signed in again after their session ended (close 4001). Everything
   * local is kept: the Y.Doc, appliedSeq, the client id and every
   * unacknowledged edit, which is resent with its original id, so the
   * server deduplicates anything that was in fact saved.
   */
  restart(): void {
    if (this.destroyed || this.status !== 'error' || this.diverged) return
    this.error = null
    this.closeCode = null
    this.reconnectAttempt = 0
    this.connect()
  }

  // --- connection lifecycle ---

  private connect(): void {
    if (this.destroyed) return
    this.live = false
    this.setStatus('connecting')
    const ws = this.createSocket(this.url)
    this.socket = ws
    let opened = false
    // Each handler ignores events from sockets we have already abandoned.
    ws.onopen = () => {
      if (ws !== this.socket) return
      opened = true
      this.setStatus('syncing')
      this.send({ type: 'join', v: PROTOCOL_VERSION, client_id: this.clientId, after_seq: this.appliedSeq })
    }
    ws.onmessage = (ev: MessageEvent) => {
      if (ws !== this.socket) return
      this.onMessage(String(ev.data))
    }
    ws.onclose = (ev: CloseEvent) => {
      if (ws !== this.socket) return
      this.socket = null
      this.live = false
      this.onClose(ev.code, ev.reason)
      // Browsers hide the HTTP status of a refused handshake (401 expired
      // session, 404 no access): it looks like any network failure (1006).
      // Let the app ask the API why, while reconnects continue meanwhile.
      if (!opened) this.onConnectFailed?.()
    }
    ws.onerror = () => {
      // A close event always follows; it decides what to do.
    }
  }

  private onClose(code: number, reason: string): void {
    if (this.destroyed) return
    if (TERMINAL_CLOSE_CODES.has(code)) {
      this.fail(`connection refused (${code}${reason ? `: ${reason}` : ''})`, code)
      return
    }
    if (code === CloseCode.ResyncRequired) this.reconnectAttempt = 0
    this.setStatus('offline')
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer !== null) return
    const delay = backoffDelay(this.reconnectAttempt++, this.backoffBaseMs, this.backoffMaxMs, this.random)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  /** Abandon the current connection and start a fresh join from appliedSeq. */
  private resync(reason: string): void {
    console.warn(`collab: resync: ${reason}`)
    const ws = this.socket
    this.socket = null
    this.live = false
    ws?.close(CloseCode.Normal)
    this.reconnectAttempt = 0
    this.setStatus('offline')
    this.scheduleReconnect()
  }

  /** Stop for good: reconnecting cannot fix this. */
  private fail(message: string, closeCode: number | null = null): void {
    this.error = message
    this.closeCode = closeCode
    const ws = this.socket
    this.socket = null
    this.live = false
    ws?.close(CloseCode.Normal)
    this.clearTimers()
    this.setStatus('error')
  }

  // --- server messages ---

  private onMessage(raw: string): void {
    let m: ServerMessage
    try {
      m = JSON.parse(raw) as ServerMessage
    } catch {
      this.resync('malformed server message')
      return
    }
    switch (m.type) {
      case 'joined':
        this.role = m.role
        this.setStatus('syncing')
        return
      case 'update':
        this.onRemoteUpdate(m.seq, m.data)
        return
      case 'synced':
        this.onSynced(m.seq)
        return
      case 'committed':
        this.onCommitted(m.client_msg_id, m.seq)
        return
      case 'error':
        this.onServerError(m)
        return
      case 'presence':
        // Display only: never touches the Y.Doc or the sequence state.
        if (!Array.isArray(m.users)) return
        this.participants = m.users
        this.emit()
        return
    }
  }

  private onRemoteUpdate(seq: number, data: string): void {
    if (seq <= this.appliedSeq) return // already applied (duplicate delivery)
    if (seq !== this.appliedSeq + 1) {
      this.resync(`gap: got seq ${seq} after ${this.appliedSeq}`)
      return
    }
    try {
      Y.applyUpdate(this.doc, fromBase64(data), this)
    } catch (err) {
      // The log contains bytes this client can't apply. Skipping it would
      // silently diverge from everyone else, so stop instead.
      this.fail(`could not apply update ${seq}: ${String(err)}`)
      return
    }
    this.appliedSeq = seq
    this.emit()
  }

  private onSynced(seq: number): void {
    if (seq !== this.appliedSeq) {
      this.resync(`synced at ${seq} but applied up to ${this.appliedSeq}`)
      return
    }
    this.live = true
    this.everSynced = true
    this.reconnectAttempt = 0
    if (this.role === 'viewer') {
      // Our role was lowered while we had unsaved changes. Sending them
      // would get the connection closed (4003) and leave this tab stuck;
      // they can never be saved, so drop them and say so.
      this.discardLocalChanges()
      this.setStatus('connected')
      return
    }
    this.setStatus('connected')
    // Resend everything still unacknowledged, with the original ids, so
    // the server deduplicates anything that was in fact committed.
    for (const [id, data] of this.pending) this.sendUpdate(id, data)
    this.flush()
  }

  private discardLocalChanges(): void {
    const n = this.pending.size + (this.unsent.length > 0 ? 1 : 0)
    if (n === 0) return
    this.pending.clear()
    this.unsent = []
    this.discardedEdits += n
    this.emit()
  }

  private onCommitted(id: number, seq: number): void {
    this.pending.delete(id)
    this.retryAttempt = 0
    if (seq === this.appliedSeq + 1) {
      // Our own update, at its place in the stream. It is already in the
      // local doc, so there is nothing to apply.
      this.appliedSeq = seq
    } else if (seq > this.appliedSeq + 1) {
      this.resync(`gap: committed seq ${seq} after ${this.appliedSeq}`)
      return
    }
    // seq <= appliedSeq: a duplicate of something committed earlier.
    this.flush()
    this.emit()
  }

  private onServerError(m: Extract<ServerMessage, { type: 'error' }>): void {
    const id = m.client_msg_id
    if (id === undefined || !this.pending.has(id)) return
    if (!m.retryable) {
      // The server will never accept this update, but it is already in our
      // local document, so we have diverged from the shared one. Keep
      // `saved` false: the page must go on warning before unload.
      this.pending.delete(id)
      this.diverged = true
      this.fail(`an edit was rejected by the server (${m.code}). Copy your recent text, then reload.`)
      return
    }
    const delay = backoffDelay(this.retryAttempt++, this.backoffBaseMs, this.backoffMaxMs, this.random)
    const socket = this.socket
    setTimeout(() => {
      // Only on the same live connection; a reconnect resends all pending anyway.
      const data = this.pending.get(id)
      if (data && this.live && this.socket === socket) this.sendUpdate(id, data)
    }, delay)
  }

  // --- state ---

  private setStatus(status: ConnectionStatus): void {
    this.status = status
    // Presence belongs to one connection. Every path that leaves the
    // "connected" state (close, resync, failure, a new attempt) passes
    // here, so a list can't outlive the connection that sent it. The new
    // connection's list arrives after its "synced".
    if (status !== 'connected') this.participants = null
    this.emit()
  }

  private snapshot(): ProviderState {
    return {
      status: this.status,
      synced: this.everSynced,
      saved: !this.diverged && this.pending.size === 0 && this.unsent.length === 0,
      appliedSeq: this.appliedSeq,
      pendingCount: this.pending.size + this.unsent.length,
      error: this.error,
      role: this.role,
      closeCode: this.closeCode,
      discardedEdits: this.discardedEdits,
      participants: this.participants,
      diverged: this.diverged,
    }
  }

  private emit(): void {
    this.state = this.snapshot()
    for (const l of this.listeners) l(this.state)
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    if (this.batchTimer !== null) clearTimeout(this.batchTimer)
    this.reconnectTimer = this.batchTimer = null
  }
}
