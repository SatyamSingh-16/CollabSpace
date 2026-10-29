import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

import { fromBase64 } from './base64'
import { CloseCode } from './protocol'
import { backoffDelay, CollabProvider } from './provider'
import { FakeSocket, remoteEdits, updateMsg } from './testing'

const URL = 'ws://test/ws/documents/doc-1'

function setup(opts: { random?: () => number } = {}) {
  const doc = new Y.Doc()
  const provider = new CollabProvider({
    url: URL,
    doc,
    createSocket: FakeSocket.factory,
    clientId: 'client-A',
    batchMs: 10,
    random: opts.random ?? (() => 0.5),
  })
  return { doc, provider, text: () => doc.getText('t').toString() }
}

/** Opens the latest socket and completes a join at `head` with `replay`. */
function joinAt(head: number, replay: Uint8Array[] = [], firstSeq = 1) {
  const s = FakeSocket.latest()
  s.open()
  s.deliver({ type: 'joined', head_seq: head, role: 'editor', conn_id: 'c1' })
  replay.forEach((u, i) => s.deliver(updateMsg(firstSeq + i, u)))
  s.deliver({ type: 'synced', seq: head })
  return s
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('CollabProvider', () => {
  it('joins with after_seq 0, applies the replay, then reports synced', () => {
    const { provider, text } = setup()
    const s = FakeSocket.latest()
    expect(provider.getState().status).toBe('connecting')

    s.open()
    expect(s.sent[0]).toEqual({ type: 'join', v: 1, client_id: 'client-A', after_seq: 0 })
    expect(provider.getState()).toMatchObject({ status: 'syncing', synced: false })

    s.deliver({ type: 'joined', head_seq: 2, role: 'editor', conn_id: 'c1' })
    const [u1, u2] = remoteEdits('hello', ' world')
    s.deliver(updateMsg(1, u1))
    s.deliver(updateMsg(2, u2))
    expect(provider.getState().synced).toBe(false) // not until "synced"
    s.deliver({ type: 'synced', seq: 2 })

    expect(text()).toBe('hello world')
    expect(provider.getState()).toMatchObject({ status: 'connected', synced: true, saved: true, appliedSeq: 2 })
  })

  it('does not send remote updates back (no echo loop)', () => {
    setup()
    const s = joinAt(0)
    const [u1] = remoteEdits('from server')
    s.deliver(updateMsg(1, u1))
    vi.advanceTimersByTime(100)
    expect(s.updates()).toHaveLength(0)
  })

  it('batches local edits into one numbered update and clears it on committed', () => {
    const { doc, provider } = setup()
    const s = joinAt(0)

    doc.getText('t').insert(0, 'ab')
    doc.getText('t').insert(2, 'cd')
    expect(provider.getState().saved).toBe(false)
    vi.advanceTimersByTime(10)

    const sent = s.updates()
    expect(sent).toHaveLength(1)
    expect(sent[0].client_msg_id).toBe(1)
    // The bytes reproduce both edits in another document.
    const other = new Y.Doc()
    Y.applyUpdate(other, fromBase64(sent[0].data))
    expect(other.getText('t').toString()).toBe('abcd')

    s.deliver({ type: 'committed', client_msg_id: 1, seq: 1 })
    expect(provider.getState()).toMatchObject({ saved: true, appliedSeq: 1, pendingCount: 0 })
  })

  it('holds local edits until synced', () => {
    const { doc } = setup()
    const s = FakeSocket.latest()
    s.open()
    doc.getText('t').insert(0, 'early')
    vi.advanceTimersByTime(100)
    expect(s.updates()).toHaveLength(0)

    s.deliver({ type: 'joined', head_seq: 0, role: 'editor', conn_id: 'c1' })
    s.deliver({ type: 'synced', seq: 0 })
    expect(s.updates()).toHaveLength(1)
  })

  it('ignores a duplicate delivery of an already-applied seq', () => {
    const { provider, text } = setup()
    const s = joinAt(0)
    const [u1, u2] = remoteEdits('x', 'y')
    s.deliver(updateMsg(1, u1))
    s.deliver(updateMsg(1, u1))
    s.deliver(updateMsg(2, u2))
    s.deliver(updateMsg(2, u2))
    expect(text()).toBe('xy')
    expect(provider.getState().appliedSeq).toBe(2)
    expect(FakeSocket.instances).toHaveLength(1) // no resync needed
  })

  it('resyncs from appliedSeq when it detects a gap', () => {
    const { provider } = setup()
    const s = joinAt(0)
    const [u1, , u3] = remoteEdits('a', 'b', 'c')
    s.deliver(updateMsg(1, u1))
    s.deliver(updateMsg(3, u3)) // seq 2 missing

    expect(s.closedByClient).toBe(true)
    expect(provider.getState()).toMatchObject({ status: 'offline', appliedSeq: 1 })
    vi.advanceTimersByTime(1000)
    const s2 = FakeSocket.latest()
    expect(s2).not.toBe(s)
    s2.open()
    expect(s2.sent[0]).toMatchObject({ type: 'join', after_seq: 1 })
  })

  it('reconnects after a drop, replays what it missed, and resends pending updates with the same ids', () => {
    const { doc, provider, text } = setup()
    const s1 = joinAt(0)
    doc.getText('t').insert(0, 'mine')
    vi.advanceTimersByTime(10)
    const original = s1.updates()[0]
    expect(original.client_msg_id).toBe(1)

    // The connection drops before "committed" arrives.
    s1.serverClose(1006)
    expect(provider.getState()).toMatchObject({ status: 'offline', saved: false, pendingCount: 1 })
    vi.advanceTimersByTime(1000)

    // Meanwhile someone else committed seq 1; our update may or may not have
    // been committed. The replay brings seq 1; then we resend.
    const s2 = FakeSocket.latest()
    expect(s2).not.toBe(s1)
    const [theirs] = remoteEdits('theirs ')
    joinAt(1, [theirs])
    expect(s2.sent[0]).toEqual({ type: 'join', v: 1, client_id: 'client-A', after_seq: 0 })
    const resent = s2.updates()
    expect(resent).toHaveLength(1)
    expect(resent[0]).toEqual(original) // same client_msg_id, same bytes (same client_id via join)

    s2.deliver({ type: 'committed', client_msg_id: 1, seq: 2 })
    expect(provider.getState()).toMatchObject({ saved: true, appliedSeq: 2 })
    expect(text()).toContain('theirs ')
    expect(text()).toContain('mine')

    // New edits continue the id sequence.
    doc.getText('t').insert(0, '!')
    vi.advanceTimersByTime(10)
    expect(s2.updates().at(-1)?.client_msg_id).toBe(2)
  })

  it('accepts a duplicate ack for an update that was committed before the drop', () => {
    const { doc, provider } = setup()
    const s1 = joinAt(0)
    doc.getText('t').insert(0, 'once')
    vi.advanceTimersByTime(10)
    const mine = fromBase64(s1.updates()[0].data)
    s1.serverClose(1006)
    vi.advanceTimersByTime(1000)

    // It had been committed as seq 1: the replay contains our own update.
    const s2 = joinAt(1, [mine])
    expect(s2.updates()[0].client_msg_id).toBe(1)
    s2.deliver({ type: 'committed', client_msg_id: 1, seq: 1 }) // the server's duplicate answer
    expect(provider.getState()).toMatchObject({ saved: true, appliedSeq: 1 })
    expect(doc.getText('t').toString()).toBe('once')
  })

  it('retries a retryable server error with the same id', () => {
    const { doc, provider } = setup()
    const s = joinAt(0)
    doc.getText('t').insert(0, 'z')
    vi.advanceTimersByTime(10)
    s.deliver({ type: 'error', code: 'persist_failed', client_msg_id: 1, retryable: true })
    expect(provider.getState().saved).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(s.updates().map((m) => m.client_msg_id)).toEqual([1, 1])
  })

  it('stops reconnecting after a terminal close code', () => {
    const { provider } = setup()
    FakeSocket.latest().serverClose(CloseCode.DocumentNotFound, 'document not found')
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(provider.getState().status).toBe('error')
  })

  it('reconnects after a server shutdown (1001) and a room reset (4008)', () => {
    setup()
    joinAt(0)
    FakeSocket.latest().serverClose(CloseCode.GoingAway)
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.instances).toHaveLength(2)
    joinAt(0)
    FakeSocket.latest().serverClose(CloseCode.ResyncRequired)
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.instances).toHaveLength(3)
  })

  it('treats an update it cannot apply as fatal instead of skipping it', () => {
    const { provider } = setup()
    const s = joinAt(0)
    s.deliver({ type: 'update', seq: 1, data: btoa('not a yjs update'), user_id: 'x' })
    expect(provider.getState()).toMatchObject({ status: 'error', appliedSeq: 0 })
  })

  it('reports a connection that closed before opening (e.g. a refused handshake)', () => {
    const failed = vi.fn()
    new CollabProvider({ url: URL, doc: new Y.Doc(), createSocket: FakeSocket.factory, random: () => 0.5, onConnectFailed: failed })
    FakeSocket.latest().serverClose(1006) // never opened
    expect(failed).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1000) // it keeps retrying meanwhile
    joinAt(0)
    FakeSocket.latest().serverClose(1006) // opened first: an ordinary drop
    expect(failed).toHaveBeenCalledTimes(1)
  })

  it('reports the role granted at each join and the code that stopped it', () => {
    const { provider } = setup()
    const s = FakeSocket.latest()
    s.open()
    s.deliver({ type: 'joined', head_seq: 0, role: 'editor', conn_id: 'c1' })
    s.deliver({ type: 'synced', seq: 0 })
    expect(provider.getState()).toMatchObject({ role: 'editor', closeCode: null })

    s.serverClose(CloseCode.ResyncRequired, 'permissions changed') // a role change
    vi.advanceTimersByTime(1000)
    const s2 = FakeSocket.latest()
    s2.open()
    s2.deliver({ type: 'joined', head_seq: 0, role: 'viewer', conn_id: 'c2' })
    s2.deliver({ type: 'synced', seq: 0 })
    expect(provider.getState().role).toBe('viewer')

    s2.serverClose(CloseCode.Forbidden, 'access removed')
    expect(provider.getState()).toMatchObject({ status: 'error', closeCode: CloseCode.Forbidden })
  })

  it('drops unsaved changes instead of sending them after being downgraded to viewer', () => {
    const { doc, provider } = setup()
    const s1 = joinAt(0) // joined as editor
    doc.getText('t').insert(0, 'not yet saved')
    vi.advanceTimersByTime(10)
    expect(s1.updates()).toHaveLength(1)
    s1.serverClose(CloseCode.ResyncRequired, 'permissions changed')
    vi.advanceTimersByTime(1000)

    const s2 = FakeSocket.latest()
    s2.open()
    s2.deliver({ type: 'joined', head_seq: 0, role: 'viewer', conn_id: 'c2' })
    s2.deliver({ type: 'synced', seq: 0 })
    expect(s2.updates()).toHaveLength(0) // nothing resent: it would be refused with 4003
    expect(provider.getState()).toMatchObject({ status: 'connected', saved: true, discardedEdits: 1, role: 'viewer' })
  })

  describe('presence', () => {
    const alice = { user_id: 'u-alice', display_name: 'Alice', role: 'editor' }
    const bob = { user_id: 'u-bob', display_name: 'Bob', role: 'viewer' }

    it('has no participants until the server sends a list', () => {
      const { provider } = setup()
      expect(provider.getState().participants).toBeNull()
      const s = joinAt(0)
      expect(provider.getState().participants).toBeNull() // presence follows synced
      s.deliver({ type: 'presence', users: [alice] })
      expect(provider.getState().participants).toEqual([alice])
      s.deliver({ type: 'presence', users: [alice, bob] })
      expect(provider.getState().participants).toEqual([alice, bob])
    })

    it('never touches the Y.Doc, the sequence state or the socket', () => {
      const { doc, provider } = setup()
      const s = joinAt(1, remoteEdits('hello'))
      const before = Y.encodeStateVector(doc)
      const onUpdate = vi.fn()
      doc.on('update', onUpdate)
      const sentBefore = s.sent.length

      s.deliver({ type: 'presence', users: [alice, bob] })
      vi.advanceTimersByTime(1000)

      expect(onUpdate).not.toHaveBeenCalled()
      expect(Y.encodeStateVector(doc)).toEqual(before)
      expect(s.sent).toHaveLength(sentBefore)
      expect(provider.getState()).toMatchObject({ appliedSeq: 1, saved: true, status: 'connected' })
    })

    it('clears the list when the connection drops, and shows only the new connection’s list', () => {
      const { provider } = setup()
      const s1 = joinAt(0)
      s1.deliver({ type: 'presence', users: [alice, bob] })
      s1.serverClose(1006) // abrupt disconnect
      expect(provider.getState()).toMatchObject({ status: 'offline', participants: null })

      vi.advanceTimersByTime(1000)
      const s2 = FakeSocket.latest()
      s2.open()
      expect(provider.getState().participants).toBeNull() // still syncing
      s2.deliver({ type: 'joined', head_seq: 0, role: 'editor', conn_id: 'c2' })
      s2.deliver({ type: 'synced', seq: 0 })
      expect(provider.getState().participants).toBeNull() // the old list is not revived
      s2.deliver({ type: 'presence', users: [alice] })
      expect(provider.getState().participants).toEqual([alice])
    })

    it('ignores presence from an abandoned connection', () => {
      const { provider } = setup()
      const s1 = joinAt(0)
      s1.deliver({ type: 'update', seq: 5, data: '', user_id: 'x' }) // a gap: resync
      expect(provider.getState().participants).toBeNull()
      s1.deliver({ type: 'presence', users: [alice, bob] }) // late frame on the old socket
      expect(provider.getState().participants).toBeNull()
    })

    it('clears the list when the provider stops for good', () => {
      const { provider } = setup()
      const s = joinAt(0)
      s.deliver({ type: 'presence', users: [alice] })
      s.serverClose(CloseCode.Unauthenticated, 'signed out')
      expect(provider.getState()).toMatchObject({ status: 'error', participants: null })
    })

    it('ignores a malformed presence message', () => {
      const { provider } = setup()
      const s = joinAt(0)
      s.deliver({ type: 'presence', users: [alice] })
      s.onmessage?.({ data: JSON.stringify({ type: 'presence', users: 'nope' }) })
      expect(provider.getState()).toMatchObject({ participants: [alice], status: 'connected' })
    })
  })

  describe('Week 5 review fixes', () => {
    it('R2: caps merging, so edits made offline are sent as several acceptable messages', () => {
      const { doc, provider } = setup()
      const s1 = joinAt(0)
      s1.serverClose(1006) // offline
      for (const ch of 'abc') doc.getText('t').insert(0, ch.repeat(200_000))
      vi.advanceTimersByTime(1000)
      const s2 = joinAt(0)
      const sizes = s2.updates().map((u) => fromBase64(u.data).byteLength)
      expect(sizes).toHaveLength(3) // 200 KB each: never merged past 256 KiB
      expect(Math.max(...sizes)).toBeLessThanOrEqual(256 * 1024)
      expect(provider.getState()).toMatchObject({ status: 'connected', diverged: false, saved: false })
    })

    it('R2: refuses to send one edit larger than the server accepts, and keeps warning', () => {
      const { doc, provider } = setup()
      const s = joinAt(0)
      doc.getText('t').insert(0, 'x'.repeat(600_000))
      vi.advanceTimersByTime(10)
      expect(s.updates()).toHaveLength(0) // not sent to be rejected
      expect(provider.getState()).toMatchObject({ status: 'error', diverged: true, saved: false })
      expect(provider.getState().error).toContain('too large')
    })

    it('R2: after a permanent rejection the edit still counts as unsaved', () => {
      const { doc, provider } = setup()
      const s = joinAt(0)
      doc.getText('t').insert(0, 'rejected')
      vi.advanceTimersByTime(10)
      s.deliver({ type: 'error', code: 'invalid_payload', client_msg_id: 1, retryable: false })
      expect(provider.getState()).toMatchObject({ status: 'error', diverged: true, saved: false })
      provider.restart() // refused: the local doc can't be reconciled
      expect(FakeSocket.instances).toHaveLength(1)
    })

    it('R1: restart() after a 4001 resumes with the same edits, ids and position', () => {
      const { doc, provider } = setup()
      const s1 = joinAt(1, remoteEdits('hello'))
      doc.getText('t').insert(0, 'unsaved ')
      vi.advanceTimersByTime(10)
      const [sent] = s1.updates()
      s1.serverClose(CloseCode.Unauthenticated, 'session expired')
      expect(provider.getState()).toMatchObject({ status: 'error', saved: false })
      vi.advanceTimersByTime(60_000)
      expect(FakeSocket.instances).toHaveLength(1) // terminal: no reconnect on its own

      provider.restart() // the user signed in again
      const s2 = FakeSocket.latest()
      s2.open()
      expect(s2.sent[0]).toEqual({ type: 'join', v: 1, client_id: 'client-A', after_seq: 1 })
      s2.deliver({ type: 'joined', head_seq: 1, role: 'editor', conn_id: 'c2' })
      s2.deliver({ type: 'synced', seq: 1 })
      expect(s2.updates()).toEqual([sent]) // same client_msg_id and bytes: deduplicated if it was saved
      s2.deliver({ type: 'committed', client_msg_id: sent.client_msg_id, seq: 2 })
      expect(provider.getState()).toMatchObject({ status: 'connected', saved: true, appliedSeq: 2, error: null, closeCode: null })
    })
  })

  it('stops sending after destroy', () => {
    const { doc, provider } = setup()
    const s = joinAt(0)
    provider.destroy()
    doc.getText('t').insert(0, 'late')
    vi.advanceTimersByTime(60_000)
    expect(s.updates()).toHaveLength(0)
    expect(FakeSocket.instances).toHaveLength(1)
  })
})

describe('backoffDelay', () => {
  it('doubles up to the cap, with full jitter', () => {
    const max = () => 0.999999
    const delays = [0, 1, 2, 3, 10].map((n) => Math.round(backoffDelay(n, 500, 30_000, max)))
    expect(delays).toEqual([500, 1000, 2000, 4000, 30_000])
    expect(backoffDelay(5, 500, 30_000, () => 0)).toBe(0)
  })
})
