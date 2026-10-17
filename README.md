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
bun install && bun run samples && bun run dev
```

`bun run samples` downloads the public-domain sample texts once (Project Gutenberg) and derives
the files in `samples/` (checked against SHA-256 hashes). Without them the start page has no
samples and the sample-based tests are skipped.

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
  <kbd>B</kbd> bookmark · <kbd>D</kbd> debug overlay · <kbd>R</kbd> regenerate the visual (AI) ·
  <kbd>?</kbd> help · <kbd>Esc</kbd> close.
- The interface is available in German and English.

## Server voices (optional)

Besides the browser's voices the player can read with server-side TTS: a local
[qwentts.cpp](https://github.com/ServeurpersoCom/qwentts.cpp) `tts-server` (Qwen3-TTS, German and
English among others), OpenAI's speech endpoint, or any OpenAI-compatible `/v1/audio/speech`.

- Configure it in `lesebuehne.config.local.ts`, e.g.
  `tts: [{ id: 'qwentts', kind: 'qwentts', baseURL: 'http://127.0.0.1:8080/v1', voices: ['vivian'] }]`,
  or with `TTS_BASE_URL`, `TTS_VOICES` (comma-separated) and `TTS_KIND` (`qwentts`, `openai`,
  `openai-compatible`; plus `TTS_API_KEY`, `TTS_MODEL`).
- Server voices appear in Settings → Voice (marked "server voice") and are preferred when you have
  not chosen a voice. Audio is synthesized sentence by sentence about a minute ahead and cached
  on disk; the chip next to the remaining time shows whether audio is ready.
- These engines report no word times, so the player aligns each sentence itself (speech
  start/end and pauses from the audio, matched to punctuation, syllable-weighted in between).
  Tempo keeps the pitch.
- If the server voice fails, the sentence is read by a browser voice instead and the chip says so.

## AI director (optional)

Without any AI the player uses its heuristic director (lists, enumerations, key terms). With an AI
provider, an LLM director plans each section's visual: diagrams, animations, illustrations,
verbatim quotes or key terms. Per book it first writes a **Style Bible**: palette, illustration and diagram style, and a
glossary of central concepts with glyphs and colours that the stage uses consistently.

- The heuristic plan is shown at once; the LLM plan replaces it with a crossfade when it arrives.
  Plans are prefetched about five minutes of listening ahead and cached; a jump cancels work that
  is no longer needed. <kbd>R</kbd> makes a new variant; the debug overlay (<kbd>D</kbd>) switches
  between variants and shows provider, model, prompt version and dropped cues.
- **Diagrams:** twelve templates (list, process, causal chain, timeline, cycle, spectrum,
  comparison, hierarchy, 2×2 matrix, Venn, network, equation/mirror), laid out by the player (the
  LLM only gives the structure), revealed, highlighted, connected and dimmed in sync with the words.
- **Animations:** for ideas that need motion (a pendulum, a flow, a transformation) the LLM writes a
  small program against the player's animation library. It runs in a locked-down iframe (opaque
  origin, no network, no storage) as a pure function of reading time, so seeking works. Programs
  are checked before they run; if one fails, the diagram stays and one corrected version is
  requested. <kbd>R</kbd> on an animated section writes a new program.
- **Illustrations:** for concrete scenes the director describes a picture in the book's
  illustration style with named focus regions. The server generates it (about one to two minutes)
  through the `image-use` CLI or, as fallback, the ChatGPT Codex backend's image tool with the
  codex-auth sign-in, or any OpenAI-compatible images endpoint; the book's first picture is the
  style reference of the following ones. Images are prefetched with the plans, cached, and shown
  with a calm Ken Burns camera that moves to each region when the text mentions it. Until a
  picture is there, a placeholder in the book's colours shows the key terms. <kbd>R</kbd> paints a
  new variant.
- Every phrase the director anchors to is checked against the book text. Anything not verbatim is
  dropped; the text itself is never changed.
- Status: the small indicator in the top bar (heuristic / AI / working / limited). Details,
  providers and usage: Settings → AI director.

### Where the AI runs

1. **Local server** (recommended): `bun run dev` (development) or `bun run build && bun run server`
   (local full mode) serve the player and the API on `127.0.0.1`. Keys and tokens stay on the
   server. `bun run doctor` lists every provider and why it is or is not available.
2. **Browser only** (static hosting): Settings → AI director → own keys for OpenRouter, an
   OpenAI-compatible or an Anthropic-compatible endpoint. Keys are stored only in that browser's
   localStorage and requests go straight from the browser to the provider.
3. **Nothing configured:** heuristic director. Reading never waits for the AI.

### Server providers

The server tries the providers in the order of `llm.chain` and falls back to the next one, finally to
the heuristic. Providers that are rate-limited or fail repeatedly cool down for a while.

| Provider | Needs | Notes |
|---|---|---|
| `codex-auth` | A ChatGPT sign-in from OpenCode or the Codex CLI on this machine, or an own sign-in (Settings → Sign in) | Uses the ChatGPT Codex backend like OpenCode does. Other apps' tokens are only read, never refreshed. Model `auto` = first model the backend lists. |
| `chatgpt-plan` | Settings → Sign in (official "Sign in with ChatGPT") | Tokens stored owner-only in the data directory. |
| `openrouter` | `OPENROUTER_API_KEY` and a model (`OPENROUTER_MODEL` or config) | Optional daily call cap (`maxCallsPerDay`). |
| images: `image-use`, `codex-image` | The `image-use` CLI (`IMAGE_USE_DIR`, default `~/.local/share/image-use`), else the Codex sign-in above | `images` in the config; also `openai-compatible` image endpoints with `baseURL`/`apiKey`/`model`. The CLI is started without a shell. |
| `anthropic-compatible` | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (optional `ANTHROPIC_BASE_URL`) | JSON through a forced tool call. |
| `openai-compatible` | `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_MODEL` (optional `OPENAI_COMPAT_API_KEY`) or entries in config | Covers OpenAI, Ollama (`http://127.0.0.1:11434/v1`), LM Studio and others. |

Configuration: `lesebuehne.config.ts` holds the committed defaults (no keys). Put your own settings
in `lesebuehne.config.local.ts` (same shape, gitignored), for example:

```ts
import { defineConfig } from '@lesebuehne/server';

export default defineConfig({
  llm: { chain: ['codex-auth', 'openrouter'] },
  providers: { 'codex-auth': { model: 'auto', models: { plan: 'a-faster-model' } } },
});
```

Keys belong in environment variables. Other variables: `LESEBUEHNE_PORT` (server port, default
8787), `LESEBUEHNE_DATA_DIR` (cache, uploaded books, own sign-ins; default the platform's user data
directory), `LESEBUEHNE_LLM_CHAIN` (comma-separated chain).

## Commands

Run all commands from the repository root.

| Command | What it does |
|---|---|
| `bun install` | Installs the pinned dependencies from `bun.lock`. |
| `bun run samples` | Downloads the public-domain sources and writes the sample texts to `samples/`. |
| `bun run dev` | Starts the development server with the AI API on `127.0.0.1` and prints the URL. Option: `-- --port <n>`. |
| `bun test` | Runs all tests. Tests need no network and no speech voices. |
| `bun run typecheck` | Type-checks the whole workspace (`tsc`, strict). |
| `bun run build` | Writes the static player, the sample files and the font licences to `dist/`. |
| `bun run preview` | Serves `dist/` on `127.0.0.1` and prints the URL. Options: `-- --port <n> --base <path> --dir <path>`. |
| `bun run server` | Serves `dist/` and the AI API on `127.0.0.1` (local full mode). Options: `-- --port <n> --dir <path>`. |
| `bun run doctor` | Prints every AI provider's availability and configuration problems (never secrets). |
| `bun run fixtures` | Writes test books (EPUB 2/3, footnotes, figures, French, DRM, font obfuscation, Markdown) to `out/fixtures/` for trying the import by hand. |

Example for a sub-path: `bun run preview -- --base /sub/` serves the build under `http://127.0.0.1:4173/sub/`.
In Git Bash, write `--base sub` (Git Bash rewrites `/sub/` to a Windows path) or set `MSYS_NO_PATHCONV=1`.

## Hosting

- The servers bind only to `127.0.0.1`.
- Open the player over HTTP. `file://` (double-click on `index.html`) is not supported.
- The content of `dist/` works on any static HTTP server, also under a sub-path, because all asset
  URLs are relative. Fonts are self-hosted. The player contacts third-party servers only for the
  AI providers you configure yourself.
- The AI API accepts only loopback hosts and the same origin (plus `server.origins` in the config).

## Repository layout

| Path | Content |
|---|---|
| `packages/core` | Book model, IDs, whitespace normalisation, sentence segmentation, speech normalisation, time axis, schemas |
| `packages/ingest` | TXT, Markdown and EPUB import |
| `packages/director` | Heuristic and LLM director (Style Bible, section plans, verbatim checks, cache and variants) |
| `packages/providers/*` | LLM providers (`codex-auth` incl. Codex images, `chatgpt-plan`, `openai-compatible`, `openrouter`, `anthropic-compatible`), TTS (`tts-openai-compatible`) and images (`image-use`, `image-openai-compatible`) |
| `packages/server` | Local API (`127.0.0.1`): configuration, provider chains, disk cache, sign-in, TTS with alignment, images |
| `packages/renderers` | Visual state as a pure function of time, stage scheduling, diagram layout engine, animation sandbox, components |
| `packages/player` | Browser player (Preact): engine, storage, settings, UI |
| `samples/` | Generated by `bun run samples` (not committed; catalog in `scripts/samples.catalog.json`) |
| `lesebuehne.config.ts` | Server defaults (no personal data, no keys) |
| `scripts/` | `dev`, `build`, `preview`, `server`, `doctor`, `samples` and `fixtures` scripts |
| `tests/` | Workspace tests and shared test support |

## Fonts

Literata, Source Sans 3, Atkinson Hyperlegible Next and OpenDyslexic, all under the SIL Open Font
License 1.1 (via Fontsource). The build copies each licence to `dist/licenses/fonts/`.
