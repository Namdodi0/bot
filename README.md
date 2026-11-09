# Discord AI Bot

A native Discord AI bot built on `discord.js` v14, with streaming answers, live thinking/tool
progress, image understanding, web search and per-channel settings.

The only runtime dependency is `discord.js`; everything else uses Node built-ins. TypeScript is
used for typechecking only (`checkJs`), with no build step.

## Requirements

- Node.js >= 20.6
- A Discord bot token (`DISCORD_BOT_TOKEN`)
- At least one chat provider key: `NIM_API_KEY` (NVIDIA NIM) or `DEEPSEEK_API_KEY`
- A search key: `FIRECRAWL_API_KEY` (primary) and/or `TAVILY_API_KEY` (fallback)
- Optional: `REFUSELESS_API_KEY`

## Setup

1. `npm install`
2. Copy `config.discord.example.json` to `config.discord.json` and edit the non-secret settings.
3. Copy `.env.example` to `.env` and fill in the API keys. Keys stay in `.env` only.
4. `npm start`

Use the invite link with `bot` and `applications.commands` scopes. Slash commands are registered
globally by default; set `discord.guildId` to register them in one guild instead.

## Features

- **Slash-first commands** — `/ask` streams an answer into one message; `/help`, `/status`,
  `/ping`, `/stop`, `/model`, `/settings`, `/reset`, `/compact`, `/summary`, `/catchup`,
  `/search`, `/image`, `/sticker`, `/remind`. Message context menus provide
  `Explain message` and `Summarize message`.
- **Streaming with live progress** — thinking, a clipped reasoning excerpt, web-search/tool
  status and tool results appear above the answer while it streams, then are replaced by the
  clean final answer.
- **Stop** — `/stop` aborts the active turn(s) in that channel and marks the preview stopped.
- **Thinking above the answer** — the final answer message keeps the model's reasoning excerpt
  and every tool call/result above the answer, separated by a divider. `/settings` can hide it
  per channel (on by default).
- **Components V2 answers** — a top-level `TextDisplay`; images share the answer message
  through a `MediaGallery`. Answers carry no action row, and long answers are split at the
  4000-char V2 budget instead of the 2000-char content limit. Command panels use a V2
  Container card.
- **Image tools** — the image tool sends at most 2 images per reply; vision accepts up to 5
  attached images per message (largest first). The vision alias is configured with
  `model.visionAlias`.
- **File context** — mentioning the bot with a markdown/text/code/CSV/JSON attachment (or
  replying to one) reads up to 3 files through the SSRF-safe fetcher, clipped to 8k chars
  each and 16k total; PDFs and other binaries are ignored.
- **Search** — Firecrawl is primary and Tavily is the failover; both web and image lookups
  use the same router. Results are cached.
- **Context management** — per-channel store with atomic writes, dedupe by message id,
  compaction, edit/delete sync, private turns excluded from shared context, and snapshot-
  isolated parallel turns within one chat.
- **Homework mode** — problem-solving requests get a tutor overlay (plan, steps, verification,
  multiple-choice/proof/coding/essay guidance) on top of the current tone.
- **Tones** — `friendly`, `cute` (flustered anime-girl crush), `grok` (truth-seeker + unhinged comedy),
  `roast`, `roast-hard`, `roast-extreme`.
- **Pagination** — long help, summary and catch-up output is split into pages with
  Back/Next buttons.

## Commands

| Command | Purpose |
|---|---|
| `/ask` | Ask the AI (options: private, thread, image, form) |
| `/help` | Show the command list |
| `/status` | Model, context and latency |
| `/ping` | Gateway and round-trip latency |
| `/stop` | Cancel the current answer in this channel |
| `/model` | Show or switch the model (admin) |
| `/settings` | Model, tone, reasoning, privacy, threads and after-answer thinking (admin) |
| `/reset` | Clear the channel context (admin) |
| `/compact` | Compact the channel context now (admin) |
| `/summary` | Summarize recent messages |
| `/catchup` | Catch up on missed messages |
| `/search` | Web search |
| `/image` | Find and send images |
| `/sticker` | Send a server sticker |
| `/remind` | List, add or cancel reminders |

## Models

Aliases are defined in `src/core/ai/models.js` and resolved against the provider config:

- `ultra` — Nemotron 3 Ultra 550B (default text model)
- `nim` — Nemotron 3.5 Super VL 120B
- `nim-light` — Nemotron 3.5 Lightning 30B
- `mistral-large` — Mistral Large 4 (vision-capable)
- `glm` — GLM 5.3 Flash
- `deepseek` / `pro` — DeepSeek API aliases
- `ds-abl-free` — Refuseless alias

## Configuration

`config.discord.json` holds non-secret settings. Important keys:

| Key | Meaning |
|---|---|
| `dataDir` | Context, logs and rate-limit state directory |
| `discord.guildId` | Optional guild id; empty registers global commands |
| `discord.allowedChannelIds` | Allowed channels; empty allows all |
| `discord.respondToAllChannelIds` | Channels where every message is answered |
| `discord.stickers` | Server sticker command/tool settings |
| `discord.presence` | Bot activity on startup |
| `nim` / `deepseek` / `refuseless` | Provider endpoints, model ids and sampling |
| `model.defaultAlias` / `fallbackAlias` / `visionAlias` | Text, fallback and image models |
| `ai.reasoning` / `ai.maxTokens` / `ai.maxToolRounds` | Generation controls |
| `context` | TTL, trimming, compaction and summary settings |
| `search` | Provider depth, result count, country and cache |
| `image.enabled` | Enable the image tool |
| `tone` | Default tone |
| `typing` / `progressive` | Typing indicator and streaming controls |
| `maxMessagesPerReply` | 0 = unlimited |
| `maxQueueDepth` | Global queue depth cap |
| `maxConcurrentChats` | Different chats that may run at once |
| `maxConcurrentPerChat` | Turns that may run at once inside one chat |
| `userRateLimitPerMinute` / `userRateLimits` | Per-sender limits |
| `responseTimeoutMs` | 0 = no deadline |
| `opsPort` | Optional local `/metrics` and `/healthz` server |

Unknown keys are reported at startup (never fatal).

## Architecture

- `src/discord.js` — thin entry point: env, config, Discord platform, runtime, banner, shutdown.
- `src/core/runtime.js` — platform-neutral engine: store, LLM adapters, tools, agent,
  reminders, warmup, ops/prune, shutdown.
- `src/platforms/contract.js` — the `Platform` contract.
- `src/platforms/discord/` — transport, event normalization, command router and handlers,
  UI (V2 answers/panels/modals), stickers, presence, message sync.
- `src/core/ai/agent/` — agent composition, per-chat parallel turn slots, turn loop,
  streaming, tools and fallback.
- `src/core/ai/llm/` — OpenAI-compatible adapter, model catalog, retries and error codes.
- `src/core/ai/prompt/` — prompt registry, shared rules/tones, runtime context and homework
  detection.
- `src/core/context/` — record schema, assembler, atomic store, token meter and compaction.
- `src/core/search/` — Firecrawl client, Tavily client and failover router.
- `src/core/media/validate.js` — SSRF-safe image download/validation and page text fetching.

## Testing

```bash
npm test          # unit tests, no network
npm run typecheck # tsc (checkJs, no emit)
npm run bench:models -- --models=id1,id2  # real NIM calls; 20s visible-content check
```

`bench:models` fails a model that emits no visible `content` within 20 seconds; reasoning does
not count. Override the timeout with `MODEL_TEST_TIMEOUT_MS` and the token budget with
`MODEL_TEST_MAX_TOKENS` (default 8192).

## Security

- `.env` contains secrets only; never commit it.
- Non-secret settings belong in `config.discord.json`.
- Image URLs pass SSRF-safe validation before upload; secrets are redacted from logs.
- Admin commands use Manage Server and are hidden from other members by default.
