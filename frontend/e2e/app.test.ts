// End-to-end: real Go server (cmd/server) + PostgreSQL + real accounts,
// sessions and providers. Skipped unless COLLABSPACE_TEST_DATABASE_URL is set.
import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import WS from 'ws'

import {
  AppServer,
  buildServer,
  createDocument,
  DATABASE_URL,
  freePort,
  openClient,
  signUp,
  sleep,
  waitFor,
  type Account,
  type TestClient,
} from './harness'

describe.skipIf(!DATABASE_URL)('end to end (Go server + PostgreSQL + real sessions)', () => {
  let binary: string
  const cleanups: (() => unknown)[] = []

  beforeAll(() => {
    binary = buildServer()
  }, 120_000)

  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c()
  })

  async function startServer(port?: number): Promise<AppServer> {
    const server = await AppServer.start(binary, port ?? (await freePort()))
    cleanups.push(() => server.stop('SIGKILL'))
    return server
  }

  function client(server: AppServer, docId: string, account: Account): TestClient {
    const c = openClient(server.port, docId, account.cookie)
    cleanups.push(() => c.provider.destroy())
    return c
  }

  const synced = (c: TestClient) => c.provider.getState().synced && c.provider.getState().status === 'connected'
  const settled = (c: TestClient) => synced(c) && c.provider.getState().saved

  it('two users editing concurrently converge', async () => {
    const server = await startServer()
    const [alice, bob] = [await signUp(server), await signUp(server)]
    const docId = await createDocument(server, alice, [bob, 'editor'])
    const a = client(server, docId, alice)
    const b = client(server, docId, bob)
    await waitFor('both synced', () => synced(a) && synced(b))

    for (let i = 0; i < 25; i++) {
      a.doc.getText('t').insert(0, `a${i};`) // a prepends
      b.type(`b${i};`) // b appends
      await sleep(3)
    }
    await waitFor('converged', () => settled(a) && settled(b) && a.text() === b.text() && a.provider.getState().appliedSeq === b.provider.getState().appliedSeq)

    const text = a.text()
    for (let i = 0; i < 25; i++) {
      expect(text).toContain(`a${i};`)
      expect(text).toContain(`b${i};`)
    }
    const typed = Array.from({ length: 25 }, (_, i) => `a${i};b${i};`).join('')
    expect(text.length).toBe(typed.length)
  })

  it('presence lists each user once, with server-side names, and follows tabs closing', async () => {
    const server = await startServer()
    const [alice, bob] = [await signUp(server, 'Alice'), await signUp(server, 'Bob')]
    const docId = await createDocument(server, alice, [bob, 'viewer'])
    const names = (c: TestClient) =>
      c.provider
        .getState()
        .participants?.map((p) => `${p.display_name}:${p.role}`)
        .sort()
        .join(',') ?? null

    const a1 = client(server, docId, alice)
    const b = client(server, docId, bob)
    const a2 = client(server, docId, alice) // second tab of the same user
    await waitFor('everyone listed', () => [a1, b, a2].every((c) => names(c) === 'Alice:owner,Bob:viewer'))
    a1.type('text is unaffected by presence')
    await waitFor('saved', () => settled(a1))

    a1.provider.destroy() // one of Alice's tabs closes
    a2.provider.destroy() // her last tab closes
    await waitFor('alice gone', () => names(b) === 'Bob:viewer')
    expect(b.text()).toBe('text is unaffected by presence')
    // The server sends presence only when the list changes, so Alice's
    // first tab closing (she was still present) must have sent nothing: no
    // frame may repeat the one before it on the same socket. This holds
    // whatever order the two leaves are processed in, so no fixed wait is
    // needed (Week 5; this was sleep(300) and a check of the current list).
    const frames = b.presenceFrames.flat()
    expect(frames.length).toBeGreaterThanOrEqual(2)
    for (const list of b.presenceFrames) {
      for (let i = 1; i < list.length; i++) expect(list[i]).not.toBe(list[i - 1])
    }
  })

  it('a refreshed page (new Y.Doc, after_seq 0) restores the persisted content', async () => {
    const server = await startServer()
    const alice = await signUp(server)
    const docId = await createDocument(server, alice)
    const a = client(server, docId, alice)
    await waitFor('synced', () => synced(a))
    a.type('persisted ')
    a.type('content')
    await waitFor('saved', () => settled(a))
    a.provider.destroy()

    const refreshed = client(server, docId, alice)
    await waitFor('refreshed synced', () => synced(refreshed))
    expect(refreshed.text()).toBe('persisted content')
  })

  it('a client that lost its connection recovers the updates it missed', async () => {
    const server = await startServer()
    const [alice, bob] = [await signUp(server), await signUp(server)]
    const docId = await createDocument(server, alice, [bob, 'editor'])
    const a = client(server, docId, alice)
    const b = client(server, docId, bob)
    await waitFor('both synced', () => synced(a) && synced(b))
    a.type('start;')
    await waitFor('b sees start', () => b.text() === 'start;')

    a.sockets.at(-1)!.terminate() // drop TCP without a close frame
    b.type('missed-1;')
    b.type('missed-2;')
    await waitFor('b saved', () => settled(b))

    await waitFor('a reconnected and caught up', () => settled(a) && a.text() === b.text())
    expect(a.sockets.length).toBeGreaterThan(1)
    expect(a.text()).toBe('start;missed-1;missed-2;')
  })

  it('graceful server restart: sessions survive, clients reconnect, offline edits are saved', async () => {
    const port = await freePort()
    let server = await startServer(port)
    const alice = await signUp(server)
    const docId = await createDocument(server, alice)
    const a = client(server, docId, alice)
    await waitFor('synced', () => synced(a))
    a.type('before;')
    await waitFor('saved', () => settled(a))

    await server.stop('SIGTERM') // clients receive 1001
    await waitFor('a offline', () => a.provider.getState().status === 'offline')
    a.type('while-down;')
    expect(a.provider.getState().saved).toBe(false)

    server = await startServer(port) // sessions are in PostgreSQL, so the cookie still works
    await waitFor('a reconnected and saved', () => settled(a), 20_000)

    const fresh = client(server, docId, alice)
    await waitFor('fresh synced', () => synced(fresh))
    expect(fresh.text()).toBe('before;while-down;')
    // One message per type() call: a duplicate stored by the resend would make this 3.
    expect(fresh.provider.getState().appliedSeq).toBe(2)
  })

  it('crash (SIGKILL): committed updates survive and unacknowledged ones are resent', async () => {
    const port = await freePort()
    let server = await startServer(port)
    const alice = await signUp(server)
    const docId = await createDocument(server, alice)
    const a = client(server, docId, alice)
    await waitFor('synced', () => synced(a))
    a.type('committed;')
    await waitFor('saved', () => settled(a))

    a.type('in-flight;')
    // Wait until the update was really written to the socket (Week 5: this
    // used to be a guessed sleep(60) "probably sent").
    await waitFor('in-flight update sent', () => a.sentUpdates === 2)
    await server.stop('SIGKILL')
    // Whether 'in-flight;' was committed before the crash is unknown here,
    // exactly the ambiguous case the protocol has to resolve.

    server = await startServer(port)
    await waitFor('a reconnected and saved', () => settled(a), 20_000)

    const fresh = client(server, docId, alice)
    await waitFor('fresh synced', () => synced(fresh))
    expect(fresh.text()).toBe('committed;in-flight;')
    // Yjs would hide a duplicated update in the text, but not in the log:
    // exactly two messages were sent, so the log must end at seq 2.
    expect(fresh.provider.getState().appliedSeq).toBe(2)
    expect(a.provider.getState().appliedSeq).toBe(2)
  })

  // The deterministic version of the ambiguous case: the server commits the
  // update, but the sender never processes the acknowledgement (its socket is
  // paused), and then the server crashes. The sender must resend with the
  // same id, and the server must deduplicate it.
  it('an update committed before a crash whose ack was never seen is resent and deduplicated', async () => {
    const port = await freePort()
    let server = await startServer(port)
    const [alice, bob] = [await signUp(server), await signUp(server)]
    const docId = await createDocument(server, alice, [bob, 'viewer'])
    const a = client(server, docId, alice)
    const observer = client(server, docId, bob)
    await waitFor('both synced', () => synced(a) && synced(observer))

    a.sockets.at(-1)!.pause() // a stops reading: it will not see "committed"
    a.type('acked-by-db-only;')
    // The observer receiving it proves the server committed it.
    await waitFor('observer sees the update', () => observer.text() === 'acked-by-db-only;')
    expect(a.provider.getState()).toMatchObject({ saved: false, pendingCount: 1 })

    // Destroying the paused socket discards whatever it had not read, the
    // "committed" ack included: the ack is lost in transit. (A paused socket
    // also never notices the server dying, so it must not stay paused.)
    a.sockets.at(-1)!.terminate()
    await server.stop('SIGKILL')
    server = await startServer(port)
    await waitFor('a reconnected and saved', () => settled(a), 20_000)

    // Replay brought seq 1 (a's own update); the resend got the duplicate ack.
    expect(a.provider.getState().appliedSeq).toBe(1)
    const fresh = client(server, docId, alice)
    await waitFor('fresh synced', () => synced(fresh))
    expect(fresh.text()).toBe('acked-by-db-only;')
    expect(fresh.provider.getState().appliedSeq).toBe(1) // stored once, not twice
  })

  it('logout closes the open connection (4001) and the old cookie cannot reconnect', async () => {
    const server = await startServer()
    const alice = await signUp(server)
    const docId = await createDocument(server, alice)
    const a = client(server, docId, alice)
    await waitFor('synced', () => synced(a))

    expect((await server.api('POST', '/api/auth/logout', alice.cookie)).status).toBe(204)
    // Week 3: the server closes the live connection itself; 4001 is terminal.
    await waitFor('closed with 4001', () => a.provider.getState().status === 'error')
    expect(a.provider.getState().closeCode).toBe(4001)

    const again = client(server, docId, alice)
    await waitFor('handshake refused and reported', () => again.connectFailures > 0)
    expect(again.provider.getState().status).not.toBe('connected')
    expect((await server.api('GET', '/api/auth/me', alice.cookie)).status).toBe(401)
  })

  it('the server rejects writes from a viewer, and the provider never sends them', async () => {
    const server = await startServer()
    const [alice, bob] = [await signUp(server), await signUp(server)]
    const docId = await createDocument(server, alice, [bob, 'viewer'])

    // A hand-written client bypassing the provider: the server must refuse.
    const raw = new WS(`ws://127.0.0.1:${server.port}/ws/documents/${docId}`, { headers: { Cookie: bob.cookie } })
    cleanups.push(() => raw.terminate())
    const closed = new Promise<number>((ok) => raw.on('close', (code) => ok(code)))
    await new Promise((ok) => raw.on('open', ok))
    raw.send(JSON.stringify({ type: 'join', v: 1, client_id: randomUUID(), after_seq: 0 }))
    raw.on('message', (data) => {
      if (JSON.parse(String(data)).type === 'synced') {
        raw.send(JSON.stringify({ type: 'update', client_msg_id: 1, data: Buffer.from('sneaky').toString('base64') }))
      }
    })
    expect(await closed).toBe(4003)

    // The provider (Week 3 review #4) doesn't send a viewer's edits at all.
    const viewer = client(server, docId, bob)
    await waitFor('synced', () => synced(viewer))
    viewer.type('typed by a viewer')
    await waitFor('discarded locally', () => viewer.provider.getState().discardedEdits > 0)
    expect(viewer.provider.getState().status).toBe('connected')

    const ownerView = client(server, docId, alice)
    await waitFor('owner synced', () => synced(ownerView))
    expect(ownerView.text()).toBe('')
    expect(ownerView.provider.getState().appliedSeq).toBe(0)
  })
}, 60_000)
