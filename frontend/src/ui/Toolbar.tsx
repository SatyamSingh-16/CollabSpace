import { useEditorState, type Editor } from '@tiptap/react'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

import {
  DEFAULT_FONT_SIZE,
  FONT_SIZES,
  HIGHLIGHTS,
  MIXED,
  TEXT_COLORS,
  markValue,
  type FontSize,
  type Highlight,
  type TextColor,
} from '../collab/formatting'
import { BulletListIcon, ChevronIcon, CodeBlockIcon, CodeIcon, OrderedListIcon, PageBreakIcon, RedoIcon, UndoIcon } from './Icons'

const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'
const alt = mod === '⌘' ? '⌥' : 'Alt+'

interface Control {
  key: string
  label: string
  shortcut?: string
  icon: ReactNode
  active?: boolean
  disabled?: boolean
  run: () => void
  groupStart?: boolean
  popup?: boolean // opens the text style popover
}

const colorName = (c: string) => c.charAt(0).toUpperCase() + c.slice(1)
const INTERACTIVE = 'button, a[href], input, select, textarea, label, summary, [tabindex], [contenteditable="true"]'

/**
 * The formatting toolbar: only formats the editor's schema (StarterKit)
 * supports. It follows the WAI-ARIA toolbar pattern: one Tab stop, arrow
 * keys move between buttons. Active formats come from useEditorState, which
 * re-renders this toolbar (not the editor) when the selection changes.
 */
export function Toolbar({ editor, enabled }: { editor: Editor | null; enabled: boolean }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            underline: e.isActive('underline'),
            code: e.isActive('code'),
            h1: e.isActive('heading', { level: 1 }),
            h2: e.isActive('heading', { level: 2 }),
            h3: e.isActive('heading', { level: 3 }),
            bullet: e.isActive('bulletList'),
            ordered: e.isActive('orderedList'),
            codeBlock: e.isActive('codeBlock'),
            canUndo: e.can().undo(),
            canRedo: e.can().redo(),
            // From the document (and stored marks), never kept separately:
            // a mixed selection shows no value rather than the first one.
            fontSize: (markValue(e, 'fontSize') as FontSize | typeof MIXED | null) ?? DEFAULT_FONT_SIZE,
            textColor: markValue(e, 'textColor') as TextColor | typeof MIXED | null,
            highlight: markValue(e, 'highlight') as Highlight | typeof MIXED | null,
          }
        : null,
  })
  const [focusKey, setFocusKey] = useState('undo')
  const [styleOpen, setStyleOpen] = useState(false)
  const bar = useRef<HTMLDivElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  // Where focus goes back to when the popover closes: the editor if it had
  // focus when the popover opened (a mouse click on "Aa" keeps it there),
  // else the "Aa" button (opened from the keyboard).
  const returnToEditor = useRef(false)

  // The popover closes on Escape, a click outside it or the "Aa" button; it
  // also closes if editing becomes impossible. Closing changes nothing in
  // the editor: its selection and its stored marks (the formatting for what
  // is typed next) stay as they are. Focus returns to the editor with
  // view.focus(), which dispatches no transaction, so the stored marks
  // survive; a click that moved the cursor would drop them.
  useEffect(() => {
    if (!styleOpen || !editor) return
    const trigger = () => bar.current?.querySelector<HTMLButtonElement>('[data-key="textStyle"]')
    const restoreFocus = () => {
      if (returnToEditor.current && !editor.isDestroyed) editor.view.focus()
      else trigger()?.focus()
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setStyleOpen(false)
      restoreFocus()
    }
    // A click outside closes it (mousedown: browsers fire it for taps too).
    // A click on empty space, not a control and not the text, also keeps
    // the editor's focus; clicks on controls and in the text behave as usual.
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element
      if (popover.current?.contains(t) || trigger()?.contains(t)) return
      setStyleOpen(false)
      if (editor.view.hasFocus() && !t.closest?.(INTERACTIVE)) e.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [styleOpen, editor])
  useEffect(() => {
    if (!enabled) setStyleOpen(false)
  }, [enabled])
  if (!editor || !state) return null

  const chain = () => editor.chain().focus()
  const controls: Control[] = [
    { key: 'undo', label: 'Undo', shortcut: `${mod}Z`, icon: <UndoIcon />, disabled: !state.canUndo, run: () => chain().undo().run() },
    { key: 'redo', label: 'Redo', shortcut: `${mod}Shift+Z`, icon: <RedoIcon />, disabled: !state.canRedo, run: () => chain().redo().run() },
    { key: 'bold', label: 'Bold', shortcut: `${mod}B`, icon: <b>B</b>, active: state.bold, run: () => chain().toggleBold().run(), groupStart: true },
    { key: 'italic', label: 'Italic', shortcut: `${mod}I`, icon: <i>I</i>, active: state.italic, run: () => chain().toggleItalic().run() },
    { key: 'underline', label: 'Underline', shortcut: `${mod}U`, icon: <u>U</u>, active: state.underline, run: () => chain().toggleUnderline().run() },
    { key: 'code', label: 'Inline code', shortcut: `${mod}E`, icon: <CodeIcon />, active: state.code, run: () => chain().toggleCode().run() },
    {
      key: 'textStyle',
      label: 'Text style',
      icon: (
        <span className="tb-text tb-style">
          Aa
          <ChevronIcon />
        </span>
      ),
      active: styleOpen,
      popup: true,
      run: () => {
        if (!styleOpen) returnToEditor.current = editor.view.hasFocus()
        setStyleOpen(!styleOpen)
      },
    },
    { key: 'h1', label: 'Heading 1', shortcut: `${mod}${alt}1`, icon: <span className="tb-text">H1</span>, active: state.h1, run: () => chain().toggleHeading({ level: 1 }).run(), groupStart: true },
    { key: 'h2', label: 'Heading 2', shortcut: `${mod}${alt}2`, icon: <span className="tb-text">H2</span>, active: state.h2, run: () => chain().toggleHeading({ level: 2 }).run() },
    { key: 'h3', label: 'Heading 3', shortcut: `${mod}${alt}3`, icon: <span className="tb-text">H3</span>, active: state.h3, run: () => chain().toggleHeading({ level: 3 }).run() },
    { key: 'bullet', label: 'Bulleted list', icon: <BulletListIcon />, active: state.bullet, run: () => chain().toggleBulletList().run(), groupStart: true },
    { key: 'ordered', label: 'Numbered list', icon: <OrderedListIcon />, active: state.ordered, run: () => chain().toggleOrderedList().run() },
    { key: 'codeBlock', label: 'Code block', shortcut: `${mod}${alt}C`, icon: <CodeBlockIcon />, active: state.codeBlock, run: () => chain().toggleCodeBlock().run() },
    { key: 'pageBreak', label: 'Insert page break', icon: <PageBreakIcon />, run: () => chain().insertPageBreak().run(), groupStart: true },
  ]
  // Formatting from the popover applies to the editor's selection without
  // moving focus, so several changes can be made in one visit; with a bare
  // cursor it applies to what is typed next.
  const apply = (fn: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => fn(editor.chain()).run()
  const keep = (e: { preventDefault: () => void }) => e.preventDefault() // a click keeps the editor's selection
  const usable = controls.filter((c) => enabled && !c.disabled).map((c) => c.key)
  const tabStop = usable.includes(focusKey) ? focusKey : usable[0]

  // Arrow keys, Home and End move focus among the enabled buttons.
  const onKeyDown = (e: KeyboardEvent) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End']
    if (!keys.includes(e.key) || usable.length === 0) return
    e.preventDefault()
    const i = Math.max(0, usable.indexOf(focusKey))
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? usable.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + usable.length) % usable.length
    setFocusKey(usable[next])
    bar.current?.querySelector<HTMLButtonElement>(`[data-key="${usable[next]}"]`)?.focus()
  }

  return (
    <>
      <div ref={bar} className="toolbar" role="toolbar" aria-label="Formatting" onKeyDown={onKeyDown}>
        {controls.map((c) => (
          <span key={c.key} className={c.groupStart ? 'tb-item tb-group' : 'tb-item'}>
            <button
              type="button"
              data-key={c.key}
              className={c.active ? 'tb-button is-active' : 'tb-button'}
              aria-label={c.label}
              title={c.shortcut ? `${c.label} (${c.shortcut})` : c.label}
              aria-pressed={c.popup || c.active === undefined ? undefined : c.active}
              aria-haspopup={c.popup ? 'dialog' : undefined}
              aria-expanded={c.popup ? styleOpen : undefined}
              aria-controls={c.popup ? 'text-style' : undefined}
              disabled={!enabled || c.disabled}
              tabIndex={c.key === tabStop ? 0 : -1}
              onFocus={() => setFocusKey(c.key)}
              onMouseDown={(e) => e.preventDefault()} // keep the editor's selection
              onClick={c.run}
            >
              {c.icon}
            </button>
          </span>
        ))}
      </div>
        {styleOpen && (
          <div ref={popover} id="text-style" className="tb-popover" role="dialog" aria-label="Text style" onMouseDown={keep}>
            <p className="tb-popover-label" id="ts-size">
              Size{state.fontSize === MIXED && <> <span className="tb-mixed">Mixed</span></>}
            </p>
            <div className="tb-options" role="group" aria-labelledby="ts-size">
              {FONT_SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  className={state.fontSize === size ? 'tb-option is-active' : 'tb-option'}
                  aria-pressed={state.fontSize === size}
                  aria-label={`Font size ${size}px${size === DEFAULT_FONT_SIZE ? ' (default)' : ''}`}
                  onClick={() => apply((c) => c.setFontSize(size))}
                >
                  {size}
                </button>
              ))}
            </div>
            <p className="tb-popover-label" id="ts-color">
              Text color{state.textColor === MIXED && <> <span className="tb-mixed">Mixed</span></>}
            </p>
            <div className="tb-options" role="group" aria-labelledby="ts-color">
              <button
                type="button"
                className={state.textColor === null ? 'tb-swatch swatch-default is-active' : 'tb-swatch swatch-default'}
                aria-pressed={state.textColor === null}
                aria-label="Default text color"
                title="Default"
                onClick={() => apply((c) => c.unsetTextColor())}
              />
              {TEXT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`tb-swatch tc-swatch-${color}${state.textColor === color ? ' is-active' : ''}`}
                  aria-pressed={state.textColor === color}
                  aria-label={`Text color ${colorName(color)}`}
                  title={colorName(color)}
                  onClick={() => apply((c) => c.setTextColor(color))}
                />
              ))}
            </div>
            <p className="tb-popover-label" id="ts-highlight">
              Highlight{state.highlight === MIXED && <> <span className="tb-mixed">Mixed</span></>}
            </p>
            <div className="tb-options" role="group" aria-labelledby="ts-highlight">
              <button
                type="button"
                className={state.highlight === null ? 'tb-swatch swatch-none is-active' : 'tb-swatch swatch-none'}
                aria-pressed={state.highlight === null}
                aria-label="No highlight"
                title="None"
                onClick={() => apply((c) => c.unsetHighlight())}
              />
              {HIGHLIGHTS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`tb-swatch hl-swatch-${color}${state.highlight === color ? ' is-active' : ''}`}
                  aria-pressed={state.highlight === color}
                  aria-label={`Highlight ${colorName(color)}`}
                  title={colorName(color)}
                  onClick={() => apply((c) => c.setHighlight(color))}
                />
              ))}
            </div>
            <button type="button" className="btn btn-ghost btn-sm tb-clear" onClick={() => apply((c) => c.clearFormatting())}>
              Clear formatting
            </button>
          </div>
        )}
    </>
  )
}
