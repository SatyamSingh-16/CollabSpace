// Properties of Yjs updates that the provider and the Go server rely on.
// These test the installed yjs version, not our code.
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

function record(doc: Y.Doc): Uint8Array[] {
  const out: Uint8Array[] = []
  doc.on('update', (u: Uint8Array) => out.push(u))
  return out
}

describe('Yjs updates', () => {
  it('concurrent edits converge after the two docs exchange updates', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    const fromA = record(a)
    const fromB = record(b)

    // Both edit the same spot without seeing each other's change.
    a.getText('t').insert(0, 'hello ')
    b.getText('t').insert(0, 'world ')
    a.getText('t').insert(6, 'there ')

    for (const u of fromA) Y.applyUpdate(b, u)
    for (const u of fromB) Y.applyUpdate(a, u)

    const text = a.getText('t').toString()
    expect(b.getText('t').toString()).toBe(text)
    for (const part of ['hello ', 'world ', 'there ']) expect(text).toContain(part)
    expect(text).toHaveLength(18) // nothing lost, nothing duplicated
  })

  it('duplicate and out-of-order delivery do not corrupt the document', () => {
    const src = new Y.Doc()
    const updates = record(src)
    const t = src.getText('t')
    t.insert(0, 'a')
    t.insert(1, 'b')
    t.insert(2, 'c')
    t.delete(1, 1)
    expect(updates).toHaveLength(4)

    const dst = new Y.Doc()
    for (const i of [3, 1, 0, 2, 1, 3, 0, 2]) Y.applyUpdate(dst, updates[i])
    expect(dst.getText('t').toString()).toBe('ac')
  })

  it('a merged update is equivalent to its parts (used for client batching)', () => {
    const src = new Y.Doc()
    const updates = record(src)
    src.getText('t').insert(0, 'abc')
    src.getText('t').insert(3, 'def')
    src.getText('t').delete(0, 1)

    const viaMerge = new Y.Doc()
    Y.applyUpdate(viaMerge, Y.mergeUpdates(updates))
    expect(viaMerge.getText('t').toString()).toBe('bcdef')
  })

  // Phase 0 open assumption (a). Observed behaviour of yjs 13.6.33 for these
  // inputs only; it does not prove every malformed input throws.
  it('throws on malformed bytes and leaves the document unchanged', () => {
    const truncated = (() => {
      const d = new Y.Doc()
      const us = record(d)
      d.getText('t').insert(0, 'hello world')
      return us[0].slice(0, Math.floor(us[0].length / 2))
    })()
    const cases: [string, Uint8Array, boolean][] = [
      ['random bytes', Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256), true],
      ['truncated update', truncated, true],
      ['empty', new Uint8Array(0), true],
      ['16 zero bytes (a valid empty update)', new Uint8Array(16), false],
    ]
    for (const [name, bytes, throws] of cases) {
      const doc = new Y.Doc()
      doc.getText('t').insert(0, 'ok')
      const apply = () => Y.applyUpdate(doc, bytes)
      if (throws) expect(apply, name).toThrow()
      else expect(apply, name).not.toThrow()
      expect(doc.getText('t').toString(), name).toBe('ok')
    }
  })
})
