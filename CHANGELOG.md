# Changelog

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
