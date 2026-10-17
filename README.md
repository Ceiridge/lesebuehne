# Lesebühne

A reading stage for non-fiction: the player reads a book aloud word for word, highlights the
current paragraph, sentence and word, and shows calm visuals next to the text (list diagrams and
key terms). Everything runs in the browser; the tooling is TypeScript on [Bun](https://bun.sh).

The text is never changed: what you see and what you hear come from the same canonical text.

## Private use only

- This project is for private use.
- Do not host processed bundles of copyrighted books in public.
- The project does not circumvent DRM. DRM-protected books are rejected, not decrypted.

## Try it

```sh
bun install && bun run dev
```

Open the printed URL (`http://127.0.0.1:3000/`), click the Kant sample
("Beantwortung der Frage: Was ist Aufklärung?") and press <kbd>Space</kbd>.

## Requirements

- Bun 1.4.3 or later (Windows, macOS or Linux; any shell).
- A current Chromium-based browser, Firefox or Safari. Reading aloud uses the browser's speech
  voices (Web Speech API). Local voices (for example the Windows voices Hedda, Katja and Stefan)
  report every word, so the word highlight is exact. Online voices often do not; the player then
  estimates the word inside the sentence and says so. Without any voice the book opens in silent
  reading mode.

## Using the player

- **Open a book:** click a sample, or drop an EPUB (without DRM), TXT or Markdown file on the start
  page or choose one. TXT and Markdown files (and EPUBs without a language) ask for the language.
  Imported books stay in the browser (IndexedDB) with their reading position and bookmarks.
- **Read:** click any word to continue from there. The timeline jumps to any point.
- **Views:** stage and text, stage with subtitles (cinema), sentence by sentence (the current
  sentence large, its neighbours dimmed), full page, or text only. Subtitles can also be switched
  on in the stage-and-text view (<kbd>S</kbd>). Themes light, sepia, dark or system; four
  reading fonts; size, line height, line length, margins, spacing, alignment, highlight style,
  dimming, motion, voice, tempo (0.75×–2.5×) and footnote reading in the settings.
- **Keys:** <kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> sentence ·
  <kbd>Shift</kbd>+<kbd>←</kbd>/<kbd>→</kbd> section · <kbd>↑</kbd>/<kbd>↓</kbd> or
  <kbd>K</kbd>/<kbd>J</kbd> paragraph · <kbd>[</kbd>/<kbd>]</kbd> or <kbd>-</kbd>/<kbd>+</kbd> tempo ·
  <kbd>V</kbd> visual of the section · <kbd>T</kbd> text only · <kbd>S</kbd> subtitles · <kbd>M</kbd> contents ·
  <kbd>B</kbd> bookmark · <kbd>D</kbd> debug overlay · <kbd>?</kbd> help · <kbd>Esc</kbd> close.
- The interface is available in German and English.

## Commands

Run all commands from the repository root.

| Command | What it does |
|---|---|
| `bun install` | Installs the pinned dependencies from `bun.lock`. |
| `bun run dev` | Starts the development server on `127.0.0.1` and prints the URL. Option: `-- --port <n>`. |
| `bun test` | Runs all tests. Tests need no network and no speech voices. |
| `bun run typecheck` | Type-checks the whole workspace (`tsc`, strict). |
| `bun run build` | Writes the static player, the sample files and the font licences to `dist/`. |
| `bun run preview` | Serves `dist/` on `127.0.0.1` and prints the URL. Options: `-- --port <n> --base <path> --dir <path>`. |
| `bun run fixtures` | Writes test books (EPUB 2/3, footnotes, figures, French, DRM, font obfuscation, Markdown) to `out/fixtures/` for trying the import by hand. |

Example for a sub-path: `bun run preview -- --base /sub/` serves the build under `http://127.0.0.1:4173/sub/`.
In Git Bash, write `--base sub` (Git Bash rewrites `/sub/` to a Windows path) or set `MSYS_NO_PATHCONV=1`.

## Hosting

- The servers bind only to `127.0.0.1`.
- Open the player over HTTP. `file://` (double-click on `index.html`) is not supported.
- The content of `dist/` works on any static HTTP server, also under a sub-path, because all asset
  URLs are relative. The player makes no request to third-party servers; fonts are self-hosted.

## Repository layout

| Path | Content |
|---|---|
| `packages/core` | Book model, IDs, whitespace normalisation, sentence segmentation, speech normalisation, time axis, schemas |
| `packages/ingest` | TXT, Markdown and EPUB import |
| `packages/director` | Heuristic visual plans (list diagram, key terms, none) |
| `packages/renderers` | Visual state as a pure function of time, stage scheduling, components |
| `packages/player` | Browser player (Preact): engine, storage, settings, UI |
| `samples/` | Public-domain sample texts and their provenance (`samples.json`) |
| `scripts/` | `dev`, `build`, `preview` and `fixtures` scripts |
| `tests/` | Workspace tests and shared test support |

## Fonts

Literata, Source Sans 3, Atkinson Hyperlegible Next and OpenDyslexic, all under the SIL Open Font
License 1.1 (via Fontsource). The build copies each licence to `dist/licenses/fonts/`.
