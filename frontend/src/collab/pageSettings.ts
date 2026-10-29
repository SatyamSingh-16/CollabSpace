// Document-level page settings (size and orientation).
//
// Where they live: a top-level Y.Map ("pageSettings") in the document's
// Y.Doc, next to (not inside) the editor's XML fragment. Changes are Yjs
// updates like any edit, so they need no protocol, server or schema change:
// the server stores them in the same ordered update log, collaborators get
// them live, reloads replay them, and only editors can change them (the
// server refuses updates from viewers). Clients that predate this ignore a
// top-level type they don't use. Page boundaries are never stored here or
// anywhere in the Y.Doc: they are computed per viewer (collab/pagination.ts).
import { useSyncExternalStore } from 'react'
import type * as Y from 'yjs'

export type PageSize = 'a4' | 'letter'
export type Orientation = 'portrait' | 'landscape'

export interface PageSettings {
  size: PageSize
  orientation: Orientation
}

export const DEFAULT_PAGE_SETTINGS: PageSettings = { size: 'a4', orientation: 'portrait' }
export const PAGE_SETTINGS_MAP = 'pageSettings'

const SIZES: readonly PageSize[] = ['a4', 'letter']
const ORIENTATIONS: readonly Orientation[] = ['portrait', 'landscape']

/** The document's page settings; anything missing or unknown reads as the default. */
export function readPageSettings(doc: Y.Doc): PageSettings {
  const map = doc.getMap(PAGE_SETTINGS_MAP)
  const size = map.get('size')
  const orientation = map.get('orientation')
  return {
    size: SIZES.includes(size as PageSize) ? (size as PageSize) : DEFAULT_PAGE_SETTINGS.size,
    orientation: ORIENTATIONS.includes(orientation as Orientation) ? (orientation as Orientation) : DEFAULT_PAGE_SETTINGS.orientation,
  }
}

/** Changes the settings (one Yjs transaction). Callers must only offer this to editors. */
export function writePageSettings(doc: Y.Doc, change: Partial<PageSettings>): void {
  const map = doc.getMap(PAGE_SETTINGS_MAP)
  doc.transact(() => {
    if (change.size && SIZES.includes(change.size) && map.get('size') !== change.size) map.set('size', change.size)
    if (change.orientation && ORIENTATIONS.includes(change.orientation) && map.get('orientation') !== change.orientation) {
      map.set('orientation', change.orientation)
    }
  })
}

/** The settings, re-rendering when they change (locally or from a collaborator). */
export function usePageSettings(doc: Y.Doc): PageSettings {
  const key = useSyncExternalStore(
    (cb) => {
      const map = doc.getMap(PAGE_SETTINGS_MAP)
      map.observe(cb)
      return () => map.unobserve(cb)
    },
    () => {
      const s = readPageSettings(doc)
      return `${s.size}|${s.orientation}`
    },
  )
  const [size, orientation] = key.split('|') as [PageSize, Orientation]
  return { size, orientation }
}

export interface PageGeometry {
  /** CSS px (96 per inch). */
  width: number
  height: number
  margin: number
  contentWidth: number
  contentHeight: number
}

const MM = 96 / 25.4
const PAGE_MARGIN = 96 // 1 inch on every side, for both sizes

/** Page dimensions in CSS px: A4 210 × 297 mm, US Letter 8.5 × 11 in, 1 in margins. */
export function pageGeometry(s: PageSettings): PageGeometry {
  const [w, h] = s.size === 'a4' ? [210 * MM, 297 * MM] : [8.5 * 96, 11 * 96]
  const [width, height] = s.orientation === 'portrait' ? [w, h] : [h, w]
  return { width, height, margin: PAGE_MARGIN, contentWidth: width - 2 * PAGE_MARGIN, contentHeight: height - 2 * PAGE_MARGIN }
}

/** A stable name for the settings, used for print CSS (@page names). */
export const pageClass = (s: PageSettings) => `page-${s.size}-${s.orientation}`
