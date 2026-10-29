import type { Editor, Extension } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import StarterKit from '@tiptap/starter-kit'
import type * as Y from 'yjs'

import { formattingExtensions } from './formatting'
import type { CollabProvider, ProviderState } from './provider'

// The Y.Doc field the editor content lives in. Changing it (or the extension
// list, which defines the schema) changes how stored updates are read:
// treat it like a database migration.
export const EDITOR_FIELD = 'default'

/**
 * Extensions for a collaborative editor bound to `doc`. Never pass `content`
 * to such an editor: the document's content comes only from the Y.Doc.
 */
export function collabExtensions(doc: Y.Doc, opts: { pagination?: Extension } = {}) {
  return [
    // Collaboration brings its own Yjs-aware undo; ProseMirror's history
    // would undo other people's changes.
    // Links: Tiptap's click handler calls window.open(href, '_blank')
    // without noopener, so a collaborator's link could redirect this tab
    // (reverse tabnabbing), and a click meant to place the cursor opened it.
    // Not opening on click changes behaviour only, not the schema, so stored
    // documents read the same (Week 5 review R12).
    StarterKit.configure({ undoRedo: false, link: { openOnClick: false } }),
    // Font size, text color, highlight, clear formatting, page breaks. An
    // additive schema change: existing documents read the same.
    ...formattingExtensions,
    // Page layout: view-only decorations, never written to the Y.Doc.
    ...(opts.pagination ? [opts.pagination] : []),
    Collaboration.configure({ document: doc, field: EDITOR_FIELD }),
  ]
}

/** Editing is allowed once the first sync finished, and not after a fatal error. */
export function canEdit(s: ProviderState): boolean {
  return s.synced && s.status !== 'error'
}

/**
 * Keeps the editor read-only until the provider has applied the stored
 * history. Typing into an empty editor before that would create content that
 * merges with (instead of continuing) the real document. `readOnly` (viewers)
 * keeps it read-only for good; the server enforces this too (close 4003).
 */
export function bindEditable(editor: Editor, provider: CollabProvider, opts: { readOnly?: boolean } = {}): () => void {
  const apply = (s: ProviderState) => {
    const want = !opts.readOnly && canEdit(s)
    if (editor.isEditable !== want) editor.setEditable(want, false)
  }
  apply(provider.getState())
  return provider.subscribe(apply)
}
