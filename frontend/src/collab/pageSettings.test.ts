// Page settings live in a Y.Map next to the content: they sync and persist
// like edits, default to A4 portrait, and never touch the document content.
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { DEFAULT_PAGE_SETTINGS, PAGE_SETTINGS_MAP, pageGeometry, readPageSettings, writePageSettings } from './pageSettings'

describe('page settings', () => {
  it('default to A4 portrait, and read unknown values as the default', () => {
    const doc = new Y.Doc()
    expect(readPageSettings(doc)).toEqual(DEFAULT_PAGE_SETTINGS)
    doc.getMap(PAGE_SETTINGS_MAP).set('size', 'tabloid')
    doc.getMap(PAGE_SETTINGS_MAP).set('orientation', 42)
    expect(readPageSettings(doc)).toEqual({ size: 'a4', orientation: 'portrait' })
  })

  it('sync to another client and survive a reload, without touching the content', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
    a.getXmlFragment('default').insert(0, [new Y.XmlText('content')])
    const content = a.getXmlFragment('default').toString()
    writePageSettings(a, { size: 'letter', orientation: 'landscape' })
    expect(readPageSettings(b)).toEqual({ size: 'letter', orientation: 'landscape' })
    const reloaded = new Y.Doc()
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(a))
    expect(readPageSettings(reloaded)).toEqual({ size: 'letter', orientation: 'landscape' })
    expect(a.getXmlFragment('default').toString()).toBe(content)
  })

  it('writes nothing when nothing changes, and rejects unknown values', () => {
    const doc = new Y.Doc()
    let updates = 0
    doc.on('update', () => updates++)
    writePageSettings(doc, { size: 'a4' })
    writePageSettings(doc, { size: 'a4' })
    expect(updates).toBe(1)
    writePageSettings(doc, { size: 'a3' as never })
    expect(updates).toBe(1)
  })

  it('computes page geometry in CSS px (96 per inch, 1 in margins)', () => {
    const a4 = pageGeometry({ size: 'a4', orientation: 'portrait' })
    expect(a4.width).toBeCloseTo(793.7, 1)
    expect(a4.height).toBeCloseTo(1122.5, 1)
    expect(a4.contentHeight).toBeCloseTo(1122.5 - 192, 1)
    const letterLandscape = pageGeometry({ size: 'letter', orientation: 'landscape' })
    expect([letterLandscape.width, letterLandscape.height]).toEqual([1056, 816])
    expect(letterLandscape.contentWidth).toBe(864)
  })
})
