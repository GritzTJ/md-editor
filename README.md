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

The application is a single file of ~1.6 MB (~700 kB compressed), with no
runtime dependency on anything external. Roughly 620 kB of that is KaTeX and its
twenty fonts — see [Maths](#maths) for what that buys and how to drop it.

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
  coloured per language, automatic list continuation, line numbers, undo/redo,
  find and replace (`Ctrl`+`F`, regex and whole-word supported).
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
- **Copy code**: hovering a code block in the preview reveals a **Copy** button.
  It uses the Clipboard API in a secure context and falls back to `execCommand`
  elsewhere, so unlike `Save` it does not disappear on `http://<IP>`.
- **Outline**: a toggleable panel listing the document's headings, built on the
  anchors already generated. It reads whichever rendered surface is on screen,
  so it works the same in both modes.
- **Images**: paste or drop a file and it is embedded as a `data:` URI, which
  makes the document self-contained. Above 512 kB the status bar says what the
  encoding added; above 2 MB it asks first.
- **Maths**: TeX between `$…$` or `$$…$$`, rendered by KaTeX with its fonts
  inside the page.
- **Exports**: the rendered document as standalone HTML, the application itself,
  or **paper and PDF** — `Ctrl`+`P` prints the document alone, without a scrap
  of interface, through the browser's own PDF writer.
- **Light / dark theme**, following the system setting by default.

### Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl`+`O` | Open a file |
| `Ctrl`+`S` | Save |
| `Ctrl`+`Shift`+`S` | Save as |
| `Ctrl`+`F` | Find and replace in the source |
| `Ctrl`+`P` | Print the document (or write it to PDF) |
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

The **Copy** button on code blocks depends on the same secure-context rule —
`navigator.clipboard` is absent on `http://<IP>` too — but it does not go away
there: it falls back to a hidden textarea and `document.execCommand("copy")`,
which is deprecated but is the only thing that still works on such an origin.
Both paths are covered by `test/buttons.mjs`, the fallback by removing the
Clipboard API from the page first.

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

That last point is not an empty promise: `test/roundtrip.mjs` checks 62
constructs, verifying both that the rendering is identical after a round trip
and that the source stops changing on the next pass.

---

## Markdown coverage

Measured against the [Markdown Guide](https://www.markdownguide.org/), construct
by construct, by `test/syntax.mjs`. Each one is checked twice: that the preview
renders it as documented, and that it survives being edited in the rendered
view — a construct can render perfectly and still be destroyed on the way back.

**All 62 checked constructs are supported, and all 62 survive the round
trip.**

Basic syntax: headings (hash and setext), paragraphs, all three line-break
forms, bold and italic in both asterisk and underscore forms, blockquotes
including nested ones, ordered and unordered lists in every delimiter, nesting,
inline code, indented code blocks, all three horizontal-rule forms, inline /
angle-bracket / reference-style links, images, escapes, raw HTML.

Extended syntax: tables with alignment, fenced code blocks with language tags,
footnotes, heading IDs, definition lists, strikethrough, task lists, emoji
shortcodes, highlight, subscript, superscript, and automatic URL linking.

Maths is **not** part of the Markdown Guide and so counts in neither figure; it
has its own section above and its own round-trip cases.

**Heading anchors are generated automatically**, the way GitHub, GitLab, Pandoc
and the static site generators do it: a table of contents written as
`[Section](#section)` works without the author labelling anything. An explicit
`{#custom-id}` wins, duplicates are numbered, and accents are kept so
`Fonctionnalités étendues` becomes `fonctionnalités-étendues`.

Those generated anchors exist for navigation only and are **never written into
the source**. Every other tool gets that for free by being a one-way converter;
this one can write the rendered document back, so the distinction is explicit —
only an identifier you typed yourself is stored in the document model, and only
that one is serialised. Edit the preview of a document with fifty headings and
the source comes back with exactly the labels you wrote, and no others.

Everything is bundled: the six markdown-it plugins and the emoji table are
compiled into the same single file, and `verify.mjs` still confirms the bundle
holds no network primitive. Support for extended syntax costs about 20 kB
compressed and buys nothing at the price of a request.

Three normalisations are worth knowing, all of them a consequence of
regenerating the source from the document model:

- an emoji shortcode comes back as the character itself — `:tent:` becomes ⛺;
- a bare autolinked URL comes back in angle brackets — `https://example.com`
  becomes `<https://example.com>`;
- everything else keeps its meaning but is written in the canonical form
  described under *Editing the preview*.

---

## Maths

TeX between `$…$` renders inline, between `$$…$$` as a display block, through
KaTeX. In the rendered editor a formula is an atom: click it to edit its source,
empty the box to delete it. Nothing is ever guessed back from rendered maths —
the TeX is carried on the node, so the round trip is exact.

`$` detection is conservative on purpose, because documents are full of dollars
that are not formulas. `It costs $5 and $10`, `$PATH`, and `awk '$1 == $2'` all
stay as text; `$E = mc^2$` does not. Those cases are in the round-trip suite.

**The cost is the honest catch.** KaTeX adds 625 kB to the file, measured: 265 kB
of code and 360 kB of stylesheet and base64 fonts. The fonts are inlined because `font-src data:`
refuses a downloaded one, and without them formulas fall back to a system serif
whose metrics KaTeX's layout does not expect — visibly broken, not merely
plainer. It roughly doubles what the browser transfers.

If you never write maths, it is removable, though not with one line: the two
`katex` imports, `renderMath` / `mathHtml` / `mathPlugin`, the `math_inline` and
`math_block` schema nodes with their parser and serialiser rules — all marked
"maths" in `src/markdown.js` — plus the `katexCss()` call in `build.mjs`. The
same commit without any of it builds to 1.05 MB.

---

## Known limitations

- **Remote images do not display.** `![](https://…)` is blocked by `img-src`.
  This is deliberate: allowing remote images would reopen an egress channel to a
  third party. Paste or drop a local file instead — it is embedded as a `data:`
  URI, which displays and travels with the document.
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
node test/browser.mjs      # 82 end-to-end tests
node test/roundtrip.mjs    # 62 Markdown constructs, round-tripped
node test/buttons.mjs      # 61 controls and behaviours, one assertion each
node test/syntax.mjs       # 62 Markdown Guide constructs, render + round trip
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

### Supply chain

The bundled dependencies are now the largest attack surface: markdown-it,
DOMPurify, ProseMirror, CodeMirror and KaTeX are compiled into the one file
users run, and the release carries our own provenance attestation. A compromised
upstream release would therefore ship signed by us. Three things push back:

- **Actions pinned to commit SHAs**, not tags. A tag is mutable, and whoever
  controls an action's repository could otherwise repoint `v5` at code that runs
  with our `packages: write` token. The trailing comment records the version.
- **`npm audit --audit-level=high` blocks the build.** Not a backlog item here:
  a vulnerable dependency is shipped code.
- **Dependabot**, weekly, grouped so a ProseMirror or CodeMirror upgrade is
  reviewed as one diff rather than fifteen — those packages have to move
  together or the bundle ends up with duplicated modules.

### Which build am I running?

The **?** dialog states the version and the commit. There is deliberately no
build timestamp anywhere: two builds of the same commit must produce identical
bytes, or the digest published with a release could not be reproduced by anyone.
A build made from an edited working tree is labelled `-dirty`, since it matches
no published digest.

`src/markdown.js` is the sensitive one: as the single source of both parsing and
serialisation, it is what guarantees that what is displayed and what is edited
cannot drift apart.

---

## Licence

MIT.
