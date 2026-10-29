// Typed client for the CollabSpace REST API. Requests are same-origin (the
// Vite dev server or Nginx proxies /api), so the HttpOnly session cookie is
// sent automatically; the token is never visible to JavaScript.

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
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
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
