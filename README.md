# md-editor

A Markdown editor and viewer that runs **entirely in the browser**. The server
hands over one HTML file and never hears about the document again: no network
request is made after the page loads, and the document's security policy asks
the browser to block any attempt to make one.

You write Markdown on the left and watch it render on the right. Press **Edit
preview** and the rendered document takes over the full width, directly
editable, with a formatting ribbon; **Back to split** returns you to writing
source. The two surfaces are never on screen at once, which is what keeps their
synchronisation down to a pair of transitions instead of a live negotiation.

The application is a single file of ~960 kB (~330 kB compressed), with no
runtime dependency on anything external.

---

## What the server can and cannot see

This is the point of the project, so it is worth being precise.

**What is guaranteed**, for the page as it was received:

| CSP directive | Effect |
| --- | --- |
| `default-src 'none'` | nothing loads by default |
| `connect-src 'none'` | no `fetch`, no `XMLHttpRequest`, no WebSocket, no `sendBeacon` |
| `img-src data: blob:` | no remote image, including ones written in your Markdown |
| `script-src 'sha256-…'` | only the script shipped with the page may run |
| `form-action 'none'` | no form submission |
| `base-uri 'none'` | relative URLs cannot be hijacked |
| `frame-ancestors 'none'` | the page cannot be framed by a third party |

The script is allowed by its **SHA-256 digest**, computed at build time over the
exact bytes of the file. Change one byte afterwards and the browser flatly
refuses to run it.

**The limit worth knowing:** a compromised server can serve a *different* page,
with a different CSP. The guarantees above cover the document you received, not
the server. As long as you reload the page from the server, you trust it on
every visit.

**The way out:** click **Download app** once, then work on the resulting
`md-editor.html` opened from `file://`. The server is then out of the loop for
good. The digest of the delivered file is published on every build
(`dist/index.html.sha256`, and in the workflow summary), so you can check you
received the version you expected:

```bash
curl -s https://your-instance/ | sha256sum
curl -s https://your-instance/index.html.sha256
```

---

## Getting started

```bash
docker run --rm -p 8080:8080 ghcr.io/GritzTJ/md-editor:latest
```

Then <http://localhost:8080>.

With Docker Compose — the container runs read-only, unprivileged and with no
volume at all, since it has nothing to persist:

```bash
docker compose up -d
```

The image is published for `linux/amd64` and `linux/arm64`. It exposes port
**8080** and runs as **uid 101**, never root.

### Verifying where the image came from

```bash
gh attestation verify oci://ghcr.io/GritzTJ/md-editor:latest --repo GritzTJ/md-editor
```

---

## Features

- **Source editing**: CodeMirror 6, Markdown syntax highlighting, code blocks
  coloured per language, automatic list continuation, line numbers, undo/redo.
- **Preview editing**: hit **Edit preview** and the formatted document becomes
  the writing surface, with a ribbon — bold, italic, strikethrough, code,
  heading levels, bulleted / numbered / task lists, block quote, divider, link,
  image, table (with row and column add/remove). Markdown shortcuts keep
  working: typing `## ` makes a heading, `- ` a list, ` ``` ` a code block.
- **Live preview**: GFM rendering (tables, task lists, strikethrough) sanitised
  by DOMPurify, synchronised scrolling, draggable splitter.
- **One layout, two states**: source and live preview are always side by side;
  **Edit preview** replaces that with the rendered document alone, full width,
  and the button becomes **Back to split**. There is no layout control to
  contradict the mode, and no cramped ribbon over a half-width column. The
  splitter reaches 15–85 %, so either pane can take almost the whole width.
- **Local files**: `Open` / `Save` write real `.md` files through the File
  System Access API. Elsewhere, an automatic fallback to file import and
  download (see the caveat below).
- **Exports**: the rendered document as standalone HTML, or the application
  itself.
- **Light / dark theme**, following the system setting by default.

### Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl`+`O` | Open a file |
| `Ctrl`+`S` | Save |
| `Ctrl`+`Shift`+`S` | Save as |
| `Ctrl`+`Z` / `Ctrl`+`Y` | Undo / redo |

In the preview, with **Edit preview** on:

| Shortcut | Action |
| --- | --- |
| `Ctrl`+`B` / `Ctrl`+`I` | Bold / italic |
| `Ctrl`+`Shift`+`X` | Strikethrough |
| `Ctrl`+`E` | Code |
| `Ctrl`+`K` | Link |
| `Ctrl`+`Shift`+`1..6` | Heading level 1 to 6 |
| `Tab` / `Shift`+`Tab` | Next / previous cell, or list indentation |

---

## Saving files: the secure-context caveat

`Save` writes straight back into the file you opened, and `Save as` opens a real
file dialog — but only through the **File System Access API**, which browsers
expose exclusively in a *secure context*.

| Origin | API available |
| --- | --- |
| `https://…` | yes |
| `http://localhost:8080` | yes |
| `http://192.0.2.10:8080` | **no** |

Served over plain HTTP on an IP address, the API is absent entirely and both
buttons fall back to downloading a copy. `Save as` then asks for a file name, so
it still differs from `Save`, but nothing is written back to the original file.
Firefox and Safari do not implement the API at all and behave the same way.

If direct file writing matters to you, reach the app over HTTPS or through
`localhost`.

---

## Storage

**Nothing is kept by default.** No draft, no history, no content preference —
only the theme and the layout are remembered.

The **Local draft** checkbox writes the document into the browser's
`localStorage` so it survives a reload. It is off by default, deliberately: the
content is then stored **in clear text on the machine**. Unticking it erases the
draft immediately, and a dedicated button removes it at any time.

---

## Editing the preview: what to expect

Markdown → HTML is straightforward; the reverse is not. When you edit in the
preview, the source is not patched incrementally — it is **regenerated** from
the document. Three consequences, most important first:

1. **As long as the Edit preview button stays off, the source is byte-for-byte
   intact.** Read-only mode never rewrites anything.
2. **Once it is on, your writing conventions are normalised.** `*` becomes `-`
   for bullets, underlined headings become `#`, list indentation is made
   uniform. Meaning is preserved, form is standardised.
3. **Nothing is lost.** The document model covers everything the preview can
   display — tables with alignment, task checkboxes, strikethrough — and raw
   HTML written in the Markdown is kept word for word, shown as a distinct block
   that is not editable in the preview (edit it in the source pane).

That last point is not an empty promise: `test/roundtrip.mjs` checks 33
constructs, verifying both that the rendering is identical after a round trip
and that the source stops changing on the next pass.

---

## Markdown coverage

Measured against the [Markdown Guide](https://www.markdownguide.org/), construct
by construct, by `test/syntax.mjs`. Each one is checked twice: that the preview
renders it as documented, and that it survives being edited in the rendered view.

**Basic syntax — all 43 constructs, rendered and round-tripped.** Headings (hash
and setext), paragraphs, all three line-break forms, bold and italic in both
asterisk and underscore forms, blockquotes including nested ones, ordered and
unordered lists in every delimiter, nesting, inline code, indented code blocks,
all three horizontal-rule forms, inline / angle-bracket / reference-style links,
images, escapes, and raw HTML.

**Extended syntax — 7 of 15.** Supported: tables, table alignment, fenced code
blocks, syntax-highlighting language tags, strikethrough, task lists, and
disabling automatic linking with a code span.

Not implemented, each rendered as literal text:

| Construct | Example |
| --- | --- |
| Footnotes | `Text.[^1]` |
| Heading IDs | `### Heading {#custom-id}` |
| Definition lists | `Term` / `: Definition` |
| Emoji shortcodes | `:tent:` |
| Highlight | `==important==` |
| Subscript | `H~2~O` |
| Superscript | `X^2^` |
| Automatic URL linking | a bare `https://example.com` |

The first seven are optional markdown-it plugins and could be added; each would
also need a node or mark in the ProseMirror schema, or editing the preview would
destroy it. Automatic URL linking is a deliberate choice rather than a gap:
`linkify` is off, so nothing in your text is silently turned into a link.

---

## Known limitations

- **Remote images do not display.** `![](https://…)` is blocked by `img-src`.
  This is deliberate: allowing remote images would reopen an egress channel to a
  third party. `data:` images work.
- **Direct file writing needs a secure context** — see the section above.
- **No automatic offline mode** (no service worker). The downloadable standalone
  file plays that role, in a more verifiable way.
- **Raw HTML is not editable in the preview.** It appears there as a framed
  block, kept verbatim; edit it in the source pane. Like any image or atomic
  block, selecting it and typing replaces it — undo with `Ctrl`+`Z`.
- **Typing `<details>` in the source auto-inserts `</details>`**, behaviour
  inherited from `@codemirror/lang-html` through the nested HTML parser. Pasting
  already-complete HTML is not affected.

---

## Development

```bash
npm install
npm run build     # produces dist/index.html
npm run dev       # builds, then serves on :8080 with the production headers
node verify.mjs   # checks the built file
```

`verify.mjs` inspects the file actually produced, not the sources: that the
script is still valid once extracted from the HTML, that the CSP digest matches,
that no external resource is referenced and that no network primitive appears in
the bundle. It is replayed during the image build, so no image can be produced
if any of those break.

### Browser tests

```bash
npm run dev &
npm install --no-save puppeteer
node test/browser.mjs      # 77 end-to-end tests
node test/roundtrip.mjs    # 33 Markdown constructs, round-tripped
node test/buttons.mjs      # 41 controls, one assertion each
node test/syntax.mjs       # 58 Markdown Guide constructs
```

`browser.mjs` drives a real Chrome against the served application. It checks
that the browser really does block `fetch`, WebSocket, `sendBeacon`, remote
images and dynamic imports; that the preview neutralises scripts, `onerror`,
`javascript:`, iframes and forms; that preview edits reach the source and the
other way round; and that the standalone file starts from `file://` without
carrying the current document with it.

`roundtrip.mjs` is the safety net for the Edit preview mode: for every Markdown
construct it compares the rendering before and after a round trip, and checks a
second pass no longer changes the source.

`buttons.mjs` clicks every control and asserts a concrete effect. It exists
because two of them were wrong and untested: **Tasks** produced a plain bullet
when text was selected rather than a cursor, and **Outdent** pulled an item out
of its list instead of raising it one level. It removes the File System Access
API before the page loads, so the download fallbacks are exercised whatever the
origin.

`puppeteer` is not a project dependency — it would pull down a full Chrome on
every `npm install`. To test the image rather than a local build:

```bash
docker run -d -p 8080:8080 ghcr.io/GritzTJ/md-editor:latest
TARGET=http://localhost:8080/ node test/browser.mjs
```

### Layout

```
src/app.js          interface, pane synchronisation, file I/O
src/markdown.js     shared engine: markdown-it, schema, parsing, serialisation
src/rich.js         ProseMirror editor and ribbon commands
src/styles.css      light/dark theme, rendered-document styles
build.mjs           esbuild bundle -> single HTML file + CSP + digests
verify.mjs          checks on the produced file
test/browser.mjs    end-to-end tests
test/roundtrip.mjs  Markdown <-> ProseMirror round-trip fidelity
test/syntax.mjs     compliance with the Markdown Guide
test/buttons.mjs    every control, one assertion each
nginx/default.conf  security headers, GET/HEAD only
Dockerfile          multi-stage build -> unprivileged nginx
```

`src/markdown.js` is the sensitive one: as the single source of both parsing and
serialisation, it is what guarantees that what is displayed and what is edited
cannot drift apart.

---

## Licence

MIT.
