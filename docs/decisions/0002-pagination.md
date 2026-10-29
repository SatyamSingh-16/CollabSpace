# 0002 — Pages in the collaborative editor

**Status:** implemented (2026-10-28), as approved: layout-only automatic pagination, document-level page settings, oversized paragraphs split between lines.

## The distinction that matters

| Feature | What it is | Where |
|---|---|---|
| Heading outline | Navigation by H1–H3 | `ui/Outline.tsx` |
| Manual page break | An author-placed marker, stored in the document: "a new page starts here" | `pageBreak` node, `collab/formatting.ts` |
| Page settings | Page size (A4, US Letter) and orientation, one per document, shared | `collab/pageSettings.ts` |
| Automatic pagination | Where pages start, computed by each viewer from their own rendered layout; never stored | `collab/paginate.ts`, `collab/pagination.ts` |

## Decisions

1. **Page boundaries are never written to the Y.Doc.** They depend on fonts, zoom and rendering, which differ between clients; storing them would turn every reflow into a collaborative edit that conflicts and loops. They are widget decorations, applied with meta-only transactions (`addToHistory: false`). y-tiptap writes nothing for those: a unit test (`pagination.test.ts`) and a browser test (`pagination.spec.ts`, counting the WebSocket's update frames across resizes and re-layouts) check it.
2. **Page settings live in the same Y.Doc, in a top-level `Y.Map('pageSettings')`**, beside the XmlFragment `default` that holds the content. No server, protocol or migration change: the server stores Yjs updates as opaque bytes, so the settings persist, sync live and reload like content, and viewers can't change them (the server refuses updates from viewers; the UI disables the control). Unknown values read as the defaults (A4 portrait); writing an unchanged value writes nothing.
3. **Custom layout engine, built for this.** Tiptap pagination extensions (community and commercial) restructure the document into page nodes, which stores layout in the content and conflicts with decision 1. The engine is small and split in two: a pure packing algorithm with unit tests, and a view plugin that measures and draws.

## How it works

### Packing (`collab/paginate.ts`, pure)

Input: the top-level blocks measured in *natural* coordinates (their layout without page gaps), recursively for lists, list items and blockquotes.

- A block that doesn't fit on the current page moves to the next page whole, if it fits on a fresh page.
- A textblock taller than a whole page (paragraph, heading, code block) is split between lines. A single line taller than a page gets a page to itself.
- A block that can't be split (a rule, an image) and is taller than a page starts a fresh page and runs over. Nothing is clipped or dropped; the overflow is recorded.
- Lists and blockquotes break between their children. A break before a container's first child is hoisted to before the container, so a list breaks between items, never inside one.
- A heading at the bottom of a page moves with the block after it.
- A manual page break ends the page; the next block starts a new one. A marker that falls just past a full page ends that page where it is, rather than starting a page of its own, which would be blank.
- Every break moves strictly forward, and line splitting has an iteration cap, so packing always terminates.

### Measuring and drawing (`collab/pagination.ts`, view plugin)

- **Natural coordinates.** Every measured y has the heights of the gaps above it subtracted. The page view's CSS uses top margins only, and makes lists and quotes flow roots, so no margin collapses across a gap. Inserting a gap therefore never changes anything else's layout, and measuring with the gaps in place gives the same natural layout as measuring without them. A pass whose result equals the current one dispatches nothing, so passes converge instead of looping.
- **Gap height.** A gap holds the rest of the page, the bottom margin (with the page number), the space between sheets and the next top margin. Its height is computed so that page k's content starts exactly at k × (page height + gap): `gap = pitch − (top_k − top_{k−1})`. The last page is padded to a full sheet.
- **Invalidation.**
  - **Document changes, local or remote:** the first changed position (`findDiffStart`) restarts packing one page before the page containing it, reusing earlier pages.
  - **Width changes:** a ResizeObserver on the editor (sidebar, outline, window), the font loading events, window resize (zoom) and page-setting changes each trigger a full pass.
  - **Coalescing:** everything is coalesced to at most one pass per animation frame, and passes run before paint.
  - **Loop guard:** if the result keeps changing without a document change (it shouldn't), passes stop after 4 rather than flicker.
- **Mapping between passes.** Gaps follow their content through edits. y-tiptap replaces each changed block, so:
  - a block gap is anchored to the block after it, and survives the block before it being replaced;
  - a gap whose content was replaced is dropped, along with every gap after it, and re-laid out in the same frame;
  - for y-tiptap's whole-document replacement (forced re-render, some fallbacks), positions are mapped by the actual difference between the two documents rather than by the step, which would delete every gap.
- **Fit.** The sheet is drawn at real size (96 CSS px per inch; 1in margins) and scaled down with a transform to fit the column. Below 0.6× (phones) pages would be unreadable, so the document flows continuously and the outline says so.

### Print (`styles.css`)

- App chrome, the constellation and the background are hidden, and colours are light.
- Named `@page` rules carry the document's size and orientation, with 1in margins: the same content width as the screen, so lines wrap where they do on screen.
- In the page view each gap becomes a forced break (`break-before: page`), and the manual-break marker prints nothing, so there's no double break and no blank page. In continuous mode the browser paginates, and markers force breaks.
- The browser test compares the PDF's page count and page size with the page view: A4 portrait and landscape.

## Supported content

| Node | Behaviour |
|---|---|
| Paragraph, heading | Moved whole if it fits a page, otherwise split between lines. Headings keep with the next block. |
| Code block | Split between lines. Wraps in the page view (as it must on paper). |
| Bullet/ordered list, list item, blockquote | Broken between children, recursively. |
| Manual page break | Ends the page. |
| Horizontal rule and any other atom block | Never split. If taller than a page (not possible for a rule today), starts a fresh page and runs over. |

There are no tables or images in the schema today. If they are added, they are unsplittable atoms under the rules above until handled explicitly.

## Known limitations

- **Page numbers are per viewer.** Two collaborators with different fonts or zoom can see a boundary in a different place. The outline labels the list "Pages as laid out in this window".
- **Print fidelity depends on the printing browser.** It matches the page view where text metrics match (verified in Chromium). Another browser's print engine may wrap a line differently; content is never lost, but a page can break a line earlier.
- **Measurement cost.** Measurement restarts one page before the edit but measures to the end of the document; packing is linear. Long documents (hundreds of pages) were not benchmarked.
- **No running headers and footers** beyond the page number, and no widow/orphan control inside paragraphs.

## Tests

- **`paginate.test.ts` (12 tests):** moving, exact fit, splitting, keep-with-next, manual breaks (including a marker just past a full page), lists, no infinite loops, incremental equals full, gap heights.
- **`pagination.test.ts` (4 tests):** no Y updates from drawing gaps; gaps survive remote edits and whole-document replacement; a replaced block drops its gap.
- **`pageSettings.test.ts` (4 tests):** defaults, sync and reload, no writes when unchanged, geometry.
- **`browser/pagination.spec.ts` (7 tests, Chromium).** Each checks that every rendered line lies inside its page's content area and that no page is blank. Between them they cover:
  - boundaries, edits, undo and reload;
  - zero update frames across resizes and the outline, with the editor not recreated;
  - oversized paragraphs and manual breaks;
  - headings and a 90-item list;
  - page setup shared, persisted and viewer-locked;
  - concurrent editing that converges;
  - the PDF's page count and size.
