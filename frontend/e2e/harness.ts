// Runs the real Go server (cmd/server) and real providers over real
// WebSockets, with real accounts and sessions. Needs PostgreSQL: set
// COLLABSPACE_TEST_DATABASE_URL.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import WS from 'ws'
import * as Y from 'yjs'

import { CollabProvider } from '../src/collab/provider'

export const DATABASE_URL = process.env.COLLABSPACE_TEST_DATABASE_URL

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Builds cmd/server into a temp dir and returns the binary path. */
export function buildServer(): string {
  const out = join(mkdtempSync(join(tmpdir(), 'collab-e2e-')), 'server')
  execFileSync('go', ['build', '-o', out, './cmd/server'], { cwd: repoRoot, stdio: 'inherit' })
  return out
}

export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      s.close(() => (typeof addr === 'object' && addr ? ok(addr.port) : fail(new Error('no port'))))
    })
  })
}

export class AppServer {
  readonly logs: string[] = []
  private exited: Promise<number | null>

  private constructor(
    private readonly proc: ChildProcess,
    readonly port: number,
  ) {
    this.exited = new Promise((ok) => proc.on('exit', (code) => ok(code)))
  }

  static start(binary: string, port: number, extraEnv: Record<string, string> = {}): Promise<AppServer> {
    const proc = spawn(binary, [], {
      env: {
        ...process.env,
        DATABASE_URL,
        HTTP_ADDR: `127.0.0.1:${port}`,
        ALLOWED_ORIGINS: 'http://localhost:5173',
        COOKIE_SECURE: 'false', // plain-HTTP test server
        // Every test registers fresh accounts from 127.0.0.1; the limits
        // themselves are tested in internal/app.
        RATE_LIMIT_REGISTER_PER_IP: 'off',
        RATE_LIMIT_LOGIN_PER_IP: 'off',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const server = new AppServer(proc, port)
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`server did not start:\n${server.logs.join('\n')}`)), 15_000)
      const onData = (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          server.logs.push(line)
          if (line.includes('"msg":"listening"')) {
            clearTimeout(timer)
            ok(server)
          }
        }
      }
      proc.stdout!.on('data', onData)
      proc.stderr!.on('data', onData)
      proc.on('exit', (code) => {
        clearTimeout(timer)
        fail(new Error(`server exited with ${code}:\n${server.logs.join('\n')}`))
      })
    })
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /** SIGTERM = graceful shutdown (clients get 1001); SIGKILL = crash. */
  async stop(signal: 'SIGTERM' | 'SIGKILL'): Promise<number | null> {
    this.proc.kill(signal)
    return this.exited
  }

  async api(method: string, path: string, cookie?: string, body?: unknown): Promise<{ status: number; json: any; cookie?: string }> {
    const headers: Record<string, string> = {}
    if (cookie) headers.Cookie = cookie
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const setCookie = res.headers.get('set-cookie')
    return { status: res.status, json: await res.json().catch(() => null), cookie: setCookie?.split(';')[0] }
  }
}

export interface Account {
  id: string
  email: string
  cookie: string
}

/** Registers a fresh account, as the sign-up form does. */
export async function signUp(server: AppServer, displayName = 'E2E'): Promise<Account> {
  const email = `e2e-${randomUUID().slice(0, 12)}@example.test`
  const r = await server.api('POST', '/api/auth/register', undefined, { email, password: 'password-123', display_name: displayName })
  if (r.status !== 201 || !r.cookie) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.json)}`)
  return { id: r.json.user.id, email, cookie: r.cookie }
}

export async function createDocument(server: AppServer, owner: Account, ...shareWith: [Account, 'editor' | 'viewer'][]): Promise<string> {
  const r = await server.api('POST', '/api/documents', owner.cookie, { title: 'e2e document' })
  if (r.status !== 201) throw new Error(`create document failed: ${r.status}`)
  const id: string = r.json.document.id
  for (const [member, role] of shareWith) {
    const s = await server.api('PUT', `/api/documents/${id}/members`, owner.cookie, { email: member.email, role })
    if (s.status !== 200) throw new Error(`share failed: ${s.status}`)
  }
  return id
}

export interface TestClient {
  doc: Y.Doc
  provider: CollabProvider
  sockets: WS[]
  connectFailures: number
  /** Update frames actually written to a socket (counted in the harness). */
  sentUpdates: number
  /** Raw presence frames received, one list per socket, in arrival order. */
  presenceFrames: string[][]
  text: () => string
  type: (s: string) => void
}

/** A provider with its own Y.Doc, like one browser tab. */
export function openClient(port: number, docId: string, cookie: string): TestClient {
  const doc = new Y.Doc()
  const sockets: WS[] = []
  const client: TestClient = {
    doc,
    sockets,
    connectFailures: 0,
    sentUpdates: 0,
    presenceFrames: [],
    provider: undefined as unknown as CollabProvider,
    text: () => doc.getText('t').toString(),
    type: (s) => doc.getText('t').insert(doc.getText('t').length, s),
  }
  client.provider = new CollabProvider({
    url: `ws://127.0.0.1:${port}/ws/documents/${docId}`,
    doc,
    createSocket: (url) => {
      const s = new WS(url, { headers: { Cookie: cookie } })
      s.on('unexpected-response', (_req, res) => {
        // A refused handshake (401/403/404). Browsers can't see this
        // status; the ws package can, but the provider must cope without it.
        res.resume()
        s.terminate()
      })
      const send = s.send.bind(s) as (data: unknown) => void
      ;(s as unknown as { send: (data: unknown) => void }).send = (data) => {
        if (String(data).includes('"type":"update"')) client.sentUpdates++
        send(data)
      }
      const frames: string[] = []
      client.presenceFrames.push(frames)
      s.on('message', (data) => {
        const text = String(data)
        if (text.includes('"type":"presence"')) frames.push(text)
      })
      sockets.push(s)
      return s as unknown as WebSocket
    },
    backoffBaseMs: 100,
    backoffMaxMs: 1000,
    onConnectFailed: () => client.connectFailures++,
  })
  return client
}

export async function waitFor(what: string, cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
