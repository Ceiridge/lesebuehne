# Lesebühne

Lesebühne ("reading stage") reads a book aloud word for word. The current word is highlighted in
the text, and a stage next to the text shows calm visuals: key terms, diagrams, animations and
illustrations. It works for novels as well as for non-fiction.

The player runs in the browser. AI is optional: without it, you get browser voices and simple
diagrams. With it, an LLM plans the visuals, an image model paints scenes, and a neural voice reads.

The text is never changed. What you see and what you hear come from the same text.

## Features

- **Import:** EPUB 2/3 (without DRM), TXT and Markdown. Books stay in the browser (IndexedDB),
  with reading position and bookmarks.
- **Reading:** word, sentence and paragraph highlight. Click a word to continue from there.
  Tempo 0.75× to 2.5×. Footnotes can be skipped, read inline, or read at the end of the section.
- **Views:** stage and text, cinema with subtitles, sentence by sentence, text over the stage,
  full page, text only, and word by word (RSVP, up to 900 words per minute).
- **Visuals:** twelve diagram templates, key terms, quotes, sandboxed animations, and
  illustrations with a slow pan and zoom. Each book gets one consistent style.
- **Voices:** browser voices (Web Speech API), or server voices such as a local
  [Qwen3-TTS](https://github.com/ServeurpersoCom/qwentts.cpp) or any OpenAI-compatible speech endpoint.
- **App:** German and English interface, light, sepia and dark themes, four reading fonts,
  installable as an offline web app.

## Quick start

You need [Bun](https://bun.sh) 1.4.3 or later and a current Chromium-based browser, Firefox or Safari.

```sh
bun install
bun run samples   # downloads two public-domain sample texts
bun run dev
```

Open `http://127.0.0.1:3000/`, choose a sample, and press <kbd>Space</kbd>.
Press <kbd>?</kbd> in the reader for all keyboard shortcuts.

## Where it runs

| Mode | Start | What you get |
|---|---|---|
| Static site | `bun run build`, then host `dist/` | Reading, browser voices, simple diagrams. With your own API keys in the browser: AI visuals, images and voices. |
| Local server | `bun run build && bun run server` | Everything. Keys and sign-in tokens stay on your computer. |
| Development | `bun run dev` | The local server with live reload. |

The servers listen on `127.0.0.1` only. A hosted copy of the player can also use your local
server. Start the server with `LESEBUEHNE_ORIGINS=https://your-name.github.io bun run server` and
enter `http://127.0.0.1:8787` under **Settings → Connect AI**.

The workflow in `.github/workflows/pages.yml` tests, builds and publishes the player to GitHub Pages
on every push to `main`. To turn it on, set **Settings → Pages → Source** to **GitHub Actions**.

## AI setup (optional)

Put your settings in `lesebuehne.config.local.ts`. Git ignores this file. It has the same shape as
[`lesebuehne.config.ts`](lesebuehne.config.ts). Put keys in environment variables, not in files.

```ts
import { defineConfig } from '@lesebuehne/server';

export default defineConfig({
  llm: { chain: ['codex-auth', 'openrouter'] },
  providers: {
    tts: [{ id: 'qwentts', kind: 'qwentts', baseURL: 'http://127.0.0.1:8080/v1', voices: ['vivian'], concurrency: 4 }],
  },
});
```

Run `bun run doctor` to see which providers are ready, and why the others are not.

| Purpose | Providers | Needs |
|---|---|---|
| Text model (plans, style, animations) | `codex-auth`, `chatgpt-plan` | A ChatGPT sign-in (OpenCode, Codex CLI, or **Settings → Sign in**) |
| | `openrouter` | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` |
| | `openai-compatible` | `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_MODEL`. This covers OpenAI, Ollama and LM Studio. |
| | `anthropic-compatible` | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| Images | `image-use`, `codex-image` | The `image-use` CLI, or the ChatGPT sign-in |
| | `openrouter`, `openai-compatible` | An image model and its key |
| Voices | `qwentts`, `openai`, `openai-compatible` | `TTS_BASE_URL` and `TTS_VOICES`, or a `tts` entry in the config |

The server tries the text models in the order of `llm.chain`. If all of them fail, the player uses
its built-in diagrams. Reading never waits for the AI. `LESEBUEHNE_LLM_CHAIN=openrouter` uses only
the providers you name. `LESEBUEHNE_LLM_CHAIN=none` turns the text model off.

Choose the model, the speed tier and the reasoning level under **Settings → Connect AI → Text model
& reasoning**. The list comes from the provider, for example the Codex catalog of your ChatGPT
account. The default reasoning is low for stage plans and medium for style and animations.

### Server voices

Server voices stream. Playback starts while the server still generates the sentence. The player
measures how fast the audio arrives. It starts as soon as the rest will arrive in time, so the
voice does not stop in the middle of a sentence. Qwen3-TTS and OpenAI stream by default.

These engines give no word times. The player finds them from the audio itself (pauses, punctuation
and syllables). Audio and word times are cached on disk.

For Qwen3-TTS, set `concurrency` to the `--max-batch` value of `tts-server`. The rate shown under
the timeline tells you if the voice keeps up with your tempo.

## Commands

| Command | What it does |
|---|---|
| `bun run dev` | Starts the player and the AI server for development (`-- --port <n>`). |
| `bun test` | Runs all tests. The tests need no network and no voices. |
| `bun run typecheck` | Type-checks the workspace. |
| `bun run build` | Writes the static player to `dist/`. |
| `bun run preview` | Serves `dist/` (`-- --port <n> --base <path>`). |
| `bun run server` | Serves `dist/` and the AI server (`-- --port <n>`). |
| `bun run doctor` | Shows the state of every AI provider. It never prints secrets. |
| `bun run samples` | Downloads the sample texts and checks their SHA-256 hashes. |
| `bun run fixtures` | Writes test books (EPUB, footnotes, DRM, Markdown) to `out/fixtures/`. |

## Repository layout

| Path | Content |
|---|---|
| `packages/core` | Book model, sentence segmentation, speech text, timeline, audio alignment |
| `packages/ingest` | EPUB, TXT and Markdown import |
| `packages/director` | Built-in and LLM director, style, images and speech |
| `packages/renderers` | Stage, diagram layout and animation sandbox |
| `packages/player` | The browser player (Preact) |
| `packages/server` | Local AI server |
| `packages/providers/*` | Adapters for text models, images and voices |

## Copyright and privacy

- Use Lesebühne only with books that you are allowed to read. Do not publish generated audio or
  images of copyrighted books.
- Lesebühne does not remove DRM. It rejects protected EPUB files.
- The player sends text only to the AI providers that you configure.

## License

The code is under the [MIT License](LICENSE). The fonts (Literata, Source Sans 3, Atkinson
Hyperlegible Next and OpenDyslexic) are under the SIL Open Font License 1.1. The build copies each
font license to `dist/licenses/fonts/`.
