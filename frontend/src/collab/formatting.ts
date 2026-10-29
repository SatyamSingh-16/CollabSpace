// Typography marks, the manual page break, and the heading outline.
//
// Font size, text color and highlight are marks with a value from a fixed
// list, rendered as CSS classes (fs-18, tc-red, hl-yellow), not inline
// style attributes: the production CSP (style-src 'self') blocks inline
// styles, and Tiptap's TextStyle-based extensions render exactly those. The
// classes map to theme tokens with checked contrast (styles.css).
//
// They are ordinary ProseMirror marks, so y-prosemirror stores them as
// formatting attributes in the Y.Doc: they sync, persist and survive
// reconnects like any bold or italic. Adding them extends the schema (see
// EDITOR_FIELD in editor.ts): a tab still running the previous build cannot
// render such content; y-tiptap then stops projecting and refuses document
// changes (read-only until reload) instead of rewriting the shared document
// (formatting.test.ts checks this).
import { Extension, Mark, Node, canInsertNode, isNodeSelection, mergeAttributes, type Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'

export const FONT_SIZES = [12, 14, 16, 18, 24, 32] as const
export const DEFAULT_FONT_SIZE = 16
export const TEXT_COLORS = ['gray', 'red', 'amber', 'green', 'blue'] as const
export const HIGHLIGHTS = ['yellow', 'green', 'blue', 'red', 'gray'] as const

export type FontSize = (typeof FONT_SIZES)[number]
export type TextColor = (typeof TEXT_COLORS)[number]
export type Highlight = (typeof HIGHLIGHTS)[number]

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fontSize: {
      setFontSize: (size: FontSize) => ReturnType
      unsetFontSize: () => ReturnType
    }
    textColor: {
      setTextColor: (color: TextColor) => ReturnType
      unsetTextColor: () => ReturnType
    }
    highlight: {
      setHighlight: (color: Highlight) => ReturnType
      unsetHighlight: () => ReturnType
    }
    pageBreak: {
      insertPageBreak: () => ReturnType
    }
    clearFormatting: {
      clearFormatting: () => ReturnType
    }
  }
}

// A mark holding one value from `allowed`, rendered as `<tag class="prefix-value"
// data-attr="value">`. Unknown values (pasted HTML, another build) don't
// become marks at all.
function valueMark<T extends string | number>(opts: {
  name: string
  attr: string
  allowed: readonly T[]
  tag: string
  prefix: string
  parse: (raw: string) => T
}) {
  const { name, attr, allowed, tag, prefix, parse } = opts
  const valid = (v: unknown): v is T => (allowed as readonly unknown[]).includes(v)
  return Mark.create({
    name,
    addAttributes() {
      return {
        value: {
          default: null,
          parseHTML: (el) => {
            const v = parse(el.getAttribute(`data-${attr}`) ?? '')
            return valid(v) ? v : null
          },
          renderHTML: (attrs) => (valid(attrs.value) ? { [`data-${attr}`]: String(attrs.value), class: `${prefix}-${attrs.value}` } : {}),
        },
      }
    },
    parseHTML() {
      return [{ tag: `${tag}[data-${attr}]`, getAttrs: (el) => (valid(parse((el as HTMLElement).getAttribute(`data-${attr}`) ?? '')) ? null : false) }]
    },
    renderHTML({ HTMLAttributes }) {
      return [tag, mergeAttributes(HTMLAttributes), 0]
    },
  })
}

export const FontSizeMark = valueMark<FontSize>({
  name: 'fontSize',
  attr: 'font-size',
  allowed: FONT_SIZES,
  tag: 'span',
  prefix: 'fs',
  parse: (raw) => Number(raw) as FontSize,
}).extend({
  addCommands() {
    return {
      // The default size is "no mark", so documents don't fill with fs-16.
      setFontSize:
        (size) =>
        ({ commands }) =>
          size === DEFAULT_FONT_SIZE ? commands.unsetMark(this.name) : commands.setMark(this.name, { value: size }),
      unsetFontSize:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    }
  },
})

export const TextColorMark = valueMark<TextColor>({
  name: 'textColor',
  attr: 'color',
  allowed: TEXT_COLORS,
  tag: 'span',
  prefix: 'tc',
  parse: (raw) => raw as TextColor,
}).extend({
  addCommands() {
    return {
      setTextColor:
        (color) =>
        ({ commands }) =>
          commands.setMark(this.name, { value: color }),
      unsetTextColor:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    }
  },
})

export const HighlightMark = valueMark<Highlight>({
  name: 'highlight',
  attr: 'highlight',
  allowed: HIGHLIGHTS,
  tag: 'mark',
  prefix: 'hl',
  parse: (raw) => raw as Highlight,
}).extend({
  addCommands() {
    return {
      setHighlight:
        (color) =>
        ({ commands }) =>
          commands.setMark(this.name, { value: color }),
      unsetHighlight:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    }
  },
})

/** Presentational marks only. Links are content (an address), not formatting. */
export const FORMATTING_MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'fontSize', 'textColor', 'highlight'] as const

/**
 * `clearFormatting`: removes the presentational marks from the selection
 * (or from what is typed next, for a bare cursor). Nodes are untouched:
 * headings, lists, code blocks, paragraphs and links stay.
 */
export const ClearFormatting = Extension.create({
  name: 'clearFormatting', // commands only: adds nothing to the schema
  addCommands() {
    return {
      clearFormatting:
        () =>
        ({ chain }) =>
          FORMATTING_MARKS.reduce((c, name) => c.unsetMark(name, { extendEmptyMarkRange: false }), chain()).run(),
    }
  },
})

/**
 * A manual page break: a block the author places where a new page must
 * start when the document is printed (print CSS: break-after: page). It is
 * stored in the Y.Doc like any node, so every client and every reload sees
 * the same breaks. It is not automatic pagination (see docs/decisions).
 */
export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML() {
    return [{ tag: 'hr[data-page-break]', priority: 60 }] // before the plain <hr> rule
  },
  renderHTML({ HTMLAttributes }) {
    return ['hr', mergeAttributes(HTMLAttributes, { 'data-page-break': '', class: 'page-break' })]
  },
  addCommands() {
    return {
      // Like Tiptap's horizontal rule: insert, then put the cursor in the
      // text block after it (creating an empty paragraph at the end), so
      // what is typed next never replaces the break.
      insertPageBreak:
        () =>
        ({ chain, state }) => {
          if (!canInsertNode(state, state.schema.nodes[this.name])) return false
          const c = chain()
          if (isNodeSelection(state.selection)) c.insertContentAt(state.selection.$to.pos, { type: this.name })
          else c.insertContent({ type: this.name })
          return c
            .command(({ tr, dispatch }) => {
              if (!dispatch) return true
              const { $to } = tr.selection
              if ($to.nodeAfter) {
                if ($to.nodeAfter.isTextblock) tr.setSelection(TextSelection.create(tr.doc, $to.pos + 1))
                else if ($to.nodeAfter.isBlock) tr.setSelection(NodeSelection.create(tr.doc, $to.pos))
                else tr.setSelection(TextSelection.create(tr.doc, $to.pos))
              } else {
                const end = $to.end()
                tr.insert(end, state.schema.nodes.paragraph.create())
                tr.setSelection(TextSelection.create(tr.doc, end + 1))
              }
              tr.scrollIntoView()
              return true
            })
            .run()
        },
    }
  },
})

export const formattingExtensions = [FontSizeMark, TextColorMark, HighlightMark, ClearFormatting, PageBreak]

/** A selection whose text has more than one value for a mark (some may have none). */
export const MIXED = 'mixed'

/**
 * The value of a value mark at the selection, read from the document: for
 * a cursor, the marks for what is typed next (stored marks, else the marks
 * at the cursor); for a range, the one value all its text shares, or MIXED.
 * null means no mark (the default).
 */
export function markValue(editor: Editor, name: 'fontSize' | 'textColor' | 'highlight'): string | number | null | typeof MIXED {
  const { state } = editor
  const type = state.schema.marks[name]
  const { selection } = state
  if (selection.empty) {
    const marks = state.storedMarks ?? selection.$from.marks()
    return type.isInSet(marks)?.attrs.value ?? null
  }
  const values = new Set<unknown>()
  for (const { $from, $to } of selection.ranges) {
    state.doc.nodesBetween($from.pos, $to.pos, (node) => {
      if (node.isText) values.add(type.isInSet(node.marks)?.attrs.value ?? null)
    })
  }
  if (values.size > 1) return MIXED
  const [only] = values
  return (only as string | number | undefined) ?? null
}

export interface OutlineEntry {
  kind: 'heading' | 'pageBreak'
  level: 1 | 2 | 3 | 0
  text: string
  /** Position of the node in the document. */
  pos: number
}

/** Headings (H1–H3) and page breaks, in document order, read from the document itself. */
export function outlineOf(doc: PMNode): OutlineEntry[] {
  const out: OutlineEntry[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading' && node.attrs.level >= 1 && node.attrs.level <= 3) {
      out.push({ kind: 'heading', level: node.attrs.level, text: node.textContent.trim(), pos })
      return false
    }
    if (node.type.name === 'pageBreak') {
      out.push({ kind: 'pageBreak', level: 0, text: '', pos })
      return false
    }
    return true
  })
  return out
}
