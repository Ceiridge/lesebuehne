# Changelog

## M6 – The tool online as a static site (2026-10-17)

Try it: `bun run build && bun run preview`, open the page once, stop the preview and reload: the
player, its fonts and the samples still load. On GitHub, enable Pages with GitHub Actions.

- GitHub Pages workflow (samples, typecheck, tests, build, deploy `dist/`); relative URLs work
  under the repository sub-path.
- Installable and offline: web app manifest, generated icons (SVG and PNG, maskable) and a small
  generated service worker (precached build, network-first pages, never API or provider requests,
  old caches removed, update notice). Only on `https:` or loopback.
- AI in the browser with own keys: illustrations through OpenRouter image models
  (`chat/completions` with image output, first picture as style reference) or OpenAI-compatible
  images endpoints; voices through OpenAI-compatible speech endpoints (qwentts preset, OpenAI) with
  the shared aligner. Pictures and audio are cached in IndexedDB. A voice or images alone work
  without a text model (the heuristic plans stay).
- Image and speech logic shared by server and browser (`ImageDirector`, `SpeechDirector`); the
  server also offers `kind: 'openrouter'` images.
- Hosted page with a local server: `LESEBUEHNE_ORIGINS`, Private Network Access preflights for
  allowed origins, the hosted page asks the configured server first, `doctor` lists the origins.
- Settings → AI director: images and voice sections and a "what works here" summary; the start
  page explains static mode once and opens the AI settings without a book.

## M5 – Illustrations (2026-10-17)

Try it: `bun run dev` with a ChatGPT sign-in available (image-use or codex-auth); sections the
director sees as scenes get a picture after a minute or two, with Ken Burns moves to its regions.

- Image providers: `image-use` (the CLI, started without any shell, prompt after `--`, user's
  launcher settings honoured), `codex-image` (the Codex backend's image tool with the codex-auth
  token sources) and OpenAI-compatible images endpoints; chain `image-use → codex-image`.
- Server: `POST /api/images` with disk cache, variants, the first picture of a book as style
  reference for the next ones, and `GET /api/images/<file>`.
- Stage: Ken Burns camera as a pure function of reading time (drift, eased moves to focus regions,
  still with reduced motion), image fade-in, and a placeholder in the book's colours with the key
  terms while there is no picture (also in browser-only mode).
- Player: image jobs follow the plans in the prefetch window; R paints a new variant; the debug
  overlay shows image status and regions.

## M4 – Server voices (2026-10-17)

Try it: start a qwentts.cpp `tts-server`, then
`TTS_BASE_URL=http://127.0.0.1:8080/v1 TTS_VOICES=vivian bun run dev` and open the Kant sample.

- TTS provider for OpenAI-compatible speech endpoints with presets for a local qwentts.cpp server
  (language by name, fixed seed, one request at a time) and OpenAI; always WAV.
- Aligner in core: speech start/end and pauses from the audio energy, matched to punctuation,
  syllable-weighted words in between; deterministic, shared by server and browser.
- Server: `POST /api/tts` with disk cache and word timings, voices in capabilities and `doctor`.
- Player: server voices next to browser voices (preferred by default), an audio speech port with
  pitch-preserving tempo and exact word boundaries, prefetch of about a minute ahead with
  cancellation on jumps, a readiness chip, and fallback to a browser voice when a server voice fails.

## M3 – Diagrams and animations (2026-10-17)

Try it: `bun run dev`, open the Kybalion sample, jump to "The Principle of Rhythm" (Shift+→) and wait
a moment: the director picks an animation and the stage shows a swinging pendulum.

- Diagram engine: twelve templates laid out as SVG (process, causal chain, timeline, cycle, spectrum,
  comparison, hierarchy, matrix, Venn, network, equation, plus the list), with wrapped labels,
  glossary colours and glyph badges, Style Bible accents, and new cues `connect` and `dim`; too many
  items fall back to the list.
- Animations: the director writes a program for `animation` plans; it runs in a sandboxed iframe
  (opaque origin, CSP without network) on a small library (shapes, labels, easing, cue times), is
  checked statically before running, and is watched (start and response timeouts). Failures keep
  the diagram, restart once after a timeout, or request one corrected program. Cached with variants.
- Fixes: duplicate diagram item ids no longer fail a plan; the sandbox stays transparent in the
  dark theme.

## M2 – Providers, local server, LLM director (2026-10-17)

Try it: `bun run samples && bun run dev`, open a sample; with a ChatGPT sign-in from OpenCode or the
Codex CLI on this machine the indicator in the top bar switches to "AI". `bun run doctor` shows why
a provider is or is not available.

- Provider system with fallback chains: every provider declares its capabilities, limits and
  availability; rate limits and repeated failures cool a provider down; usage is counted. One
  structured-output loop for all LLM providers (JSON → schema → verbatim checks, one repair).
- LLM providers: `codex-auth` (ChatGPT Codex backend; tokens from OpenCode, the Codex CLI or an own
  sign-in; foreign tokens are read-only), `chatgpt-plan` (official "Sign in with ChatGPT"),
  `openai-compatible` (OpenAI, Ollama, LM Studio …), `openrouter`, `anthropic-compatible`; the
  heuristic director is always the last fallback.
- LLM director: a per-book Style Bible with palette, styles and a glossary (verbatim labels, glyphs,
  colours); section plans with diagrams, verbatim quotes, key terms, and the intent for images and
  animations (rendered through their fallback for now); budget per chapter; cues that are not
  verbatim in the text are dropped.
- Stage: new quote renderer; glossary colours and glyphs on list items and key terms; every diagram
  template renders as a list for now; highlight cues move the marker.
- Player: finds the local server on its own origin (or a configured URL), else uses own keys in
  this browser, else the heuristic. Plans are prefetched five minutes of listening ahead after a
  short dwell, cached (IndexedDB in the browser, disk on the server) and crossfade in; R makes a new
  variant. Settings → AI director shows providers, usage, sign-in and own keys; a quiet status
  indicator sits in the top bar; the debug overlay shows provider, model, prompt version, variants
  and dropped cues.
- Local server: `bun run server` (static build + API), `bun run doctor`; `bun run dev` serves the API
  on the same origin. Loopback hosts and allowed origins only; secrets never leave the server.
- Samples are no longer committed: `bun run samples` derives them reproducibly (SHA-256 checked);
  tests that need them are skipped without them. A test keeps personal paths, tokens, keys and
  email addresses out of the repository.

## M1.1 – Stage polish and new views (2026-10-17)

Try it: `bun run dev`, open a sample, choose "Bühne mit Untertiteln" or "Satz für Satz" in the top bar.

- The stage now shows real key terms per section (frequent in the section, rare in the book, plus
  emphasised phrases) instead of contrast words such as "aber" or "but".
- The stage always shows where you are: the current heading as context, and a title card when a
  section has no visual yet.
- New views: stage with subtitles (karaoke-style, word by word, split into short cues) and
  sentence by sentence; subtitles can be toggled in the stage view with S.
- Fixes: the estimated word highlight now advances in every view; the highlight follows into a
  newly rendered chapter; the position is saved in every view.

## M1 – Foundation (2026-10-17)

Try it: `bun install && bun run dev`, open the Kant sample, press Space.

### What works

- Bun workspace (TypeScript strict) with `dev`, `build`, `preview`, `test`, `typecheck` and `fixtures`;
  servers bind only to 127.0.0.1; the static build in `dist/` runs on any HTTP host, also under a sub-path.
- Import in the browser of TXT, Markdown and EPUB 2/3 (spine, table of contents, headings, lists,
  quotes, emphasis, footnotes, figures); DRM-protected EPUBs are rejected, font obfuscation is accepted.
- Canonical book model with stable content-based IDs and a per-format fidelity invariant (TXT byte
  for byte, Markdown and EPUB word for word), checked in the tests for every sample and fixture.
- German and English sentence segmentation with a table of hard cases; speech text normalisation
  (abbreviations, numbers, ordinals, years, Roman numerals, symbols) with an exact offset map and a
  per-book lexicon; other languages with basic support.
- Library in IndexedDB with reading position, bookmarks and per-section visual modes; session-only
  mode when storage is unavailable.
- Reading aloud with the Web Speech API: sentence by sentence, word highlight through the CSS Custom
  Highlight API (fallback without it), estimated word for voices without word boundaries, silent
  mode without voices, tempo 0.75×–2.5×, footnotes skipped / inline / at section end.
- Player UI in German and English: three layouts, light/sepia/dark/system themes, four self-hosted
  fonts, reading settings, table of contents, timeline with chapter and section markers, bookmarks,
  keyboard shortcuts, footnote popover, debug overlay; responsive down to phone width.
- Heuristic director (no LLM): list diagrams, key-term typography or nothing, with cues anchored
  verbatim in the text; visuals are a pure function of book time, stay at least 8 s and crossfade.
- Two public-domain samples: Kant, "Beantwortung der Frage: Was ist Aufklärung?" (TXT) and
  The Kybalion, Chapter II (Markdown).

### What is open

- No CLI (`lb ingest`, `bake`, `export`, `doctor`), no bundle export/import.
- No server, provider registry, LLM director, style bible or glossary (M2).
- Diagram templates beyond the list (M3); high-quality TTS, aligners and gapless audio (M4);
  images and Ken Burns (M5); browser providers, BYOK and the review page (M6).
- No automated browser (E2E) test; browser behaviour is covered by a manual check list.
- The word estimate for voices without word boundaries is approximate by design.
