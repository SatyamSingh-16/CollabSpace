import { describe, expect, it } from 'vitest'
import { wsUrl } from './api'

describe('wsUrl', () => {
  it('constructs ws URL using current location when API_BASE is not set', () => {
    const url = wsUrl('doc-123', '')
    expect(url).toContain('/ws/documents/doc-123')
    expect(url.startsWith('ws://') || url.startsWith('wss://')).toBe(true)
  })

  it('converts https:// backend URL to wss:// WebSocket URL', () => {
    const url = wsUrl('doc-123', 'https://collabspace-backend-5v2n.onrender.com')
    expect(url).toBe('wss://collabspace-backend-5v2n.onrender.com/ws/documents/doc-123')
  })

  it('converts http:// backend URL to ws:// WebSocket URL', () => {
    const url = wsUrl('doc-456', 'http://127.0.0.1:8080')
    expect(url).toBe('ws://127.0.0.1:8080/ws/documents/doc-456')
  })

  it('handles backend URLs with trailing slashes', () => {
    const url = wsUrl('doc-789', 'https://collabspace-backend-5v2n.onrender.com/')
    expect(url).toBe('wss://collabspace-backend-5v2n.onrender.com/ws/documents/doc-789')
  })
})
