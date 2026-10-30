// Typed client for the CollabSpace REST API. In production the Go server
// serves both the API and the frontend (single-origin deployment on Render),
// so relative paths and same-origin cookies work out of the box. When
// VITE_API_BASE_URL is set (e.g. during a transition to a split-host setup
// with a custom domain), requests are sent there with credentials: 'include'.

/** Base URL for API requests. Empty string = same origin (production default). */
export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, '') ?? ''

/** credentials policy: 'include' for cross-origin, 'same-origin' otherwise. */
const CREDENTIALS: RequestCredentials = API_BASE ? 'include' : 'same-origin'

/**
 * Construct the WebSocket URL for a document.
 * If VITE_API_BASE_URL is configured, converts https:// -> wss:// and http:// -> ws://.
 * Otherwise falls back to location.origin with the appropriate ws(s) scheme.
 */
export function wsUrl(documentId: string, apiBase: string = API_BASE): string {
  if (apiBase) {
    const url = new URL(apiBase, typeof window !== 'undefined' ? window.location.href : 'http://localhost')
    const scheme = url.protocol === 'https:' ? 'wss' : 'ws'
    return `${scheme}://${url.host}/ws/documents/${documentId}`
  }
  const scheme = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws'
  const host = typeof location !== 'undefined' ? location.host : 'localhost:5173'
  return `${scheme}://${host}/ws/documents/${documentId}`
}

export interface User {
  id: string
  email: string
  display_name: string
}

export type Role = 'owner' | 'editor' | 'viewer'

export interface DocumentMeta {
  id: string
  title: string
  owner_id: string
  role: Role
  created_at: string
  updated_at: string
  /** Distinct users with the document open when the list was fetched (lists only). */
  online?: number
}

export interface Member {
  user_id: string
  email: string
  display_name: string
  role: Role
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: CREDENTIALS,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`)
  return data as T
}

export const api = {
  /** The signed-in user, or null when there is no valid session. */
  async me(): Promise<User | null> {
    try {
      return (await request<{ user: User }>('GET', '/api/auth/me')).user
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null
      throw e
    }
  },
  register: (email: string, password: string, displayName: string) =>
    request<{ user: User }>('POST', '/api/auth/register', { email, password, display_name: displayName }).then((r) => r.user),
  login: (email: string, password: string) =>
    request<{ user: User }>('POST', '/api/auth/login', { email, password }).then((r) => r.user),
  logout: () => request<void>('POST', '/api/auth/logout'),

  listDocuments: () => request<{ documents: DocumentMeta[] }>('GET', '/api/documents').then((r) => r.documents),
  createDocument: (title: string) =>
    request<{ document: DocumentMeta }>('POST', '/api/documents', { title }).then((r) => r.document),
  getDocument: (id: string) => request<{ document: DocumentMeta }>('GET', `/api/documents/${id}`).then((r) => r.document),
  renameDocument: (id: string, title: string) =>
    request<{ document: DocumentMeta }>('PATCH', `/api/documents/${id}`, { title }).then((r) => r.document),
  /** Owner only. Deletes the document, its history and its sharing for everyone. */
  deleteDocument: (id: string) => request<void>('DELETE', `/api/documents/${id}`),
  shareDocument: (id: string, email: string, role: 'editor' | 'viewer') =>
    request<unknown>('PUT', `/api/documents/${id}/members`, { email, role }),
  listMembers: (id: string) => request<{ members: Member[] }>('GET', `/api/documents/${id}/members`).then((r) => r.members),
  removeMember: (id: string, userId: string) => request<void>('DELETE', `/api/documents/${id}/members/${userId}`),
}
