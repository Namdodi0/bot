# Discord AI Bot

A Discord-native AI assistant powered by **DeepSeek Flash** (primary) with **NVIDIA NIM**
fallback and **Tavily** web search. It is slash-command-first: native embeds, buttons,
select menus, message context menus, ephemeral replies, optional answer threads and inline
image uploads — no Zalo-style text commands or multi-message behavior.

The repository also still contains the older **Zalo** process (`src/index.js`), but the two
run independently: separate entry points, configs, tokens, data directories and histories.
Nothing in the Discord code imports the Zalo integration.

- Node.js **>= 20.6**, ESM, no build step.
- One runtime dependency: `discord.js`.

---

## Highlights

- **Slash-first UX** — `/ask`, `/help`, `/status`, `/ping`, `/model`, `/settings`, `/reset`,
  `/compact`, `/summary`, `/catchup`, `/search`, `/image`, `/sticker`, `/remind`.
- **Message menus** — right-click a message → Apps → **Explain message** / **Summarize message**.
- **Live answers** — every model-generated reply streams into one edited message: `/ask`,
  @mention/reply chat, Explain/Summarize menus, Regenerate/Continue, `/summary` and
  `/catchup`. Tool-only outputs (`/search`, `/image`) are sent when ready.
- **Prompt form** — run `/ask` with no prompt (or `form:true`) to get a multi-line modal.
- **Server stickers** — `/sticker [name]` and the model's `send_sticker` tool send guild
  stickers; optional configured ids when the bot cannot list them.
- **Presence** — configurable activity/status (`WATCHING /ask` by default).
- **Vision** — attach an image to `/ask`, or @mention the bot with an image; the turn switches
  to the configured vision model and sends the image as an OpenAI `image_url` block.
- **Channel settings** — `/settings` (admin) controls model, tone, think effort, default
  privacy and auto-thread per channel.
- **Catch-up** — `/catchup [hours]` summarizes what happened in the channel since a time window.
- **Private or public** — `/ask private:true`, `/search private:true`, `/image private:true`.
- **Threads** — `/ask thread:true` creates a thread and answers there.
- **Model picker** — `/model` opens a select menu; `/model name:` autocompletes aliases.
- **Persistent context** per channel/thread (JSON, atomic writes), `/reset` to wipe it,
  `/compact` to compact now.
- **Reminders** with Discord timestamps: `/remind add|list|cancel`.
- **Web search and images** through Tavily; image bytes are validated (SSRF-safe, pinned DNS,
  size/type checks) and uploaded as proper image attachments.
- **Read pages** — share a link and the model calls `read_url`, which fetches public
  HTML/text/JSON/XML through the same SSRF-safe path and answers from the page text.
- **No artificial caps by default** — no `max_tokens` cap, no answer deadline, unlimited
  context and tool rounds. Set limits in config if you want them.
- **Reliability** — retry + per-provider circuit breaker, different-model fallback without
  tools, tool-call/result pairing, graceful shutdown, token redaction in logs.

---

## Quick start (Discord)

```powershell
git clone https://github.com/Namdodi0/bot.git
cd bot
npm install                 # runtime dependency: discord.js
npm install --include=dev   # only needed for npm run typecheck / development
copy .env.example .env
```

1. Create an application at <https://discord.com/developers/applications> → **Bot** →
   reset/copy the token. Put it in `.env`:

   ```env
   DISCORD_BOT_TOKEN=...
   DEEPSEEK_API_KEY=sk-...
   NIM_API_KEY=nvapi-...
   TAVILY_API_KEY=tvly-...
   ```

   At least the primary provider key and Tavily (if search is enabled) are required.

2. Enable **Message Content** under **Bot → Privileged Gateway Intents**. Slash commands work
   without it, but @mention/reply chat needs it.

3. Invite the bot with the `bot` + `applications.commands` scopes and these permissions:
   View Channels, Send Messages, Embed Links, Attach Files, Read Message History,
   Send Messages in Threads, Create Public Threads:

   ```
   https://discord.com/api/oauth2/authorize?client_id=<APP_ID>&permissions=327491374080&scope=bot%20applications.commands
   ```
   The integer also grants **Manage Threads** and **Manage Expressions**: the latter lets the
   bot list server stickers; without it, add sticker ids manually in
   `config.discord.stickers.ids`.

4. Edit `config.discord.json` (tracked; `config.discord.example.json` is a reference):

   ```json
   {
     "platform": "discord",
     "dataDir": "./data/discord",
     "discord": {
       "guildId": "",
       "allowedChannelIds": [],
       "respondToAllChannelIds": []
     }
   }
   ```

   - `guildId` — register commands instantly in one server; empty = global (can take ~1h).
   - `allowedChannelIds` — empty = every channel. DMs are always allowed, and a thread
     inherits its parent channel's entry.
   - `respondToAllChannelIds` — answer every message in these channels (threads inherit too).

5. Start it:

   ```powershell
   npm run start:discord      # or: node src/discord.js
   ```

   The log shows `discord commands registered ... count=16` (14 slash commands + 2 message
   context menus).

The bot also answers when it is **@mentioned** or someone **replies** to one of its messages.
DMs work as normal chat. **Typed text commands are ignored** — use the slash commands.
With `guildId` set, slash commands are server-scoped and do not appear in DMs; DM text chat
still works.

---

## Commands

| Command | What it does |
|---|---|
| `/ask <prompt> [form] [image] [private] [thread]` | Ask the AI; omit the prompt (or set `form:true`) for a multi-line modal. Attach an image for vision, answer publicly/ephemerally/in a thread. Streams into one message with Regenerate / Continue / Delete buttons. |
| `/help` | Ephemeral command list. |
| `/status` | Model, transport, uptime, context size, latency, traffic. |
| `/ping` | Gateway and interaction round-trip latency. |
| `/model [name]` | Admin: show a select menu or switch the channel model. Autocomplete for aliases. |
| `/settings` | Admin: model, tone, think effort, default privacy and auto-thread for this channel. |
| `/reset [all]` | Admin: clear the channel context; `all` also clears per-channel settings. |
| `/compact` | Admin: compact the context now. |
| `/summary [count]` | Summarize the last 2–200 messages (default 30). |
| `/catchup [hours]` | Summarize what happened in this channel in the last N hours (default 24, max 168). |
| `/search <query> [private]` | Web search, answered with an embed. |
| `/image <query> [count] [private]` | Find and upload images (default 1, max 25). |
| `/sticker [name]` | Send a server sticker by name/tag/id; omit to list. Uses the model's `send_sticker` tool too. |
| `/remind add <when> <text>` | Set a reminder (`20:00`, `20:00 tomorrow`, `20:00 25/12`, `+10m`, `+2h`, `+1d`; Vietnam time input). |
| `/remind list` | List this channel's reminders. |
| `/remind cancel <id>` | Cancel a reminder. |

**Message context menus:** `Explain message`, `Summarize message`.

Admin commands (`/model`, `/settings`, `/reset`, `/compact`) are hidden from non-admins by default
(Manage Server). In DMs, slash commands only exist when commands are registered globally
(no `guildId`); otherwise DM text chat still works.

Removed on purpose: `/tone`, `/split`, `/think`, `/id`, and the typed text-command
parser. Those were Zalo-shaped and do not fit Discord.

---

## How answers work

1. The gateway routes slash commands and message events.
2. `/ask` and the context menus call the shared engine through `agent.stream()`: deltas edit a
   single Discord message, so the turn renders natively (embed/edit reply, attachments,
   buttons) instead of posting its own. `/search` and `/image` call the tools directly and
   send the result when it is ready.
3. Ordinary @mention/reply chat goes through the same shared agent; its first delta creates a
   reply placeholder, later deltas edit it, and the final text is chunked only if needed.
4. Context is stored per **channel or thread id** under `data/discord/`.
5. Long answers are split at 2000 characters. A fence-aware split leaves room for code-fence
   balancing so a message never exceeds Discord's limit.
6. If the primary model fails, the engine retries and then falls back to a different model
   without tools; the bot still answers.

---

## Configuration

Only two files matter:

| File | Contents |
|---|---|
| `.env` (gitignored) | API keys/tokens only: `DISCORD_BOT_TOKEN`, `DEEPSEEK_API_KEY`, `NIM_API_KEY`, `TAVILY_API_KEY` (and `ZALO_BOT_TOKEN` for the legacy process). |
| `config.discord.json` (tracked) | Non-secret Discord settings. Never put API keys or a real `webhook.secret` here. |

Variables already set in the host panel/CI win over `.env`; an empty (or whitespace-only)
variable is filled from the file. Unknown config keys (for example a typo such as `allowChatId`)
are reported at startup instead of being silently ignored. `--config <path>` overrides the
default config file for either entry point.

Important settings:

| Setting | Meaning |
|---|---|
| `discord.guildId` | Instant guild command registration; empty = global. |
| `discord.allowedChannelIds` | Empty = all channels; DMs always allowed; threads inherit the parent. |
| `discord.respondToAllChannelIds` | Answer every message in these channels. |
| `discord.stickers` | `enabled` + optional `ids` (`"123456789012345678:wave,..."`) when the bot cannot list guild stickers. |
| `discord.presence` | `status` (`online/idle/dnd/invisible`), `type` (`PLAYING/STREAMING/LISTENING/WATCHING/COMPETING`), `text`, optional `url`. |
| `model.defaultAlias` / `fallbackAlias` | `deepseek`, `pro`, `nim`, `ultra`, `nim-light`. |
| `model.visionAlias` | Vision-capable alias used when an image is attached (default `nim`, the Super VL model). |
| `ai.reasoning` | `none`, `low`, `medium`, `high`, `auto`. |
| `ai.maxTokens` / `ai.maxToolRounds` | `null`/`0` = unlimited. |
| `responseTimeoutMs` | `0` = no deadline. |
| `context.maxTokens` / `maxMessages` | `0` = unlimited; compaction then runs on provider overflow. |
| `context.ttlHours` | `0` = keep context forever. |
| `search.enabled` / `search.auto` | Tavily on/off; `auto:false` disables model-initiated search. |
| `tone` | `friendly`, `shy`, `roast`, `roast-hard`, `roast-extreme`. |
| `typing` | Typing indicator for message chat. |
| `userRateLimitPerMinute` / `userRateLimits` | Global messages-per-minute per sender, plus `{ "userId": limit }` overrides (0 = exempt). |
| `logLevel` / `logFormat` / `logColor` | Pretty or JSON logs, with secret redaction. |

`config.discord.example.json` documents the full schema.

### CLI flags

```text
--config <path> --model <alias> --think <mode> --max-tokens <n>
--no-search --no-typing --dry-run --verbose --json --help
```

`--config` applies to both processes. `--dry-run` does not connect the gateway.

---

## Deployment

PM2 config is included (`ecosystem.config.cjs`) with two independent apps:

```powershell
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

- `discord-bot` → `src/discord.js` → `config.discord.json` / `data/discord/`
- `zalo-bot`   → `src/index.js`   → `config.json` / `data/` (legacy process)

Use a persistent data directory; never point `dataDir` at a temp folder.

---

## Logs

Pretty logs by default; JSON with `--json` or `logFormat: "json"`.

```
18:33:43 🤖 discord bot ready          version=1.2.0 id=... name=... guilds=1
18:33:44 🛠️ discord commands registered version=1.2.0 scope="guild ..." count=16
18:33:45 💬 Nam: how do I center a div? chatId=... kind=text len=24
18:33:46 🔍 web search                 query="center a div" results=4
18:33:47 🤖 bot: ...                   chatId=... part=1
18:33:47 ✅ replied · nim/... · 48.6 tok/s
```

Every line carries `version=` (read from `package.json`). Tokens and keys are always masked;
the full stack appears only in JSON mode. `--verbose` adds retry/cache/tool/context debug logs.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Bot does not answer a server message | It only answers when **@mentioned** or **replied to** (or uses `/ask`). Enable **Message Content** and check `discord.allowedChannelIds`. |
| Slash commands are missing | Invite with `applications.commands`; global commands can take up to an hour — set `discord.guildId`. |
| Typed `/ask` does nothing | The Discord bot is slash-only; use Discord's command picker. |
| `/ask thread:true` fails | Grant **Create Public Threads** and **Send Messages in Threads**, and use a channel that supports threads. |
| `/catchup` cannot read messages | The bot needs **Read Message History** in that channel. |
| The bot ignores an image | Check `model.visionAlias` points at the vision model (`nim` by default) and that the attachment is an image under 8 MB. Images are only used for the current turn. |
| Images arrive as files | Fixed in 1.2.0 by giving uploads an image extension. If it still happens, the source format (e.g. AVIF) may not preview on Discord. |
| Image upload rejected | The validator rejects non-images, private/internal URLs and files over 8 MB. |
| Admin commands missing | They are hidden from non-admins (Manage Server) by default. |
| Wrong settings are used | The Discord process loads `config.discord.json`, not `config.json`. Check `platform: "discord"`. |
| Context disappeared after upgrade | 1.2.0 uses raw channel/thread ids; contexts saved under the old `discord:` prefix are not reused. |
| Model errors / slow provider | With `responseTimeoutMs: 0` the bot waits; set a positive deadline to enable retry + different-model fallback. Run `/status` to inspect. |
| `429` | Provider or Tavily quota. The circuit breaker backs off automatically. |
| Warmup skipped at boot | Normal: warmup is an optimization only and does not affect real replies. |

---

## Security

- Secrets live only in `.env` (gitignored) and are redacted from logs.
- `config.discord.json` is tracked and must never contain tokens or real secrets.
- **Rotate any token/key that was pasted into chat.**
- Set `discord.allowedChannelIds` in real deployments; DMs are always allowed by design.
- Admin commands require **Manage Server**; they are hidden from other members.
- Image URLs are SSRF-checked with pinned DNS, redirect re-validation and a size limit.
- Mutating sends are never retried blindly; message dedupe prevents double answers.

---

## Architecture

```
Discord gateway ──► bot.js ──► native commands (commands.js, ui.js)
        │                └──► agent.collect() response sink ──► shared engine (src/core)
        └──► messageCreate ──► event normalization ──► shared agent ──► transport
                                                      │
                                        chat services · context store · model router · tools
```

| Path | Role |
|---|---|
| `src/discord.js` | Discord entry: config, platform, runtime, bot lifecycle. |
| `src/platforms/discord/specs.js` | Slash/context-menu surface. |
| `src/platforms/discord/commands/` | Routed native handlers: ask/streaming, settings, catchup, stickers, basic commands, shared helpers. |
| `src/platforms/discord/message-handler.js` | Admission + streaming reply for ordinary @mention/reply chat. |
| `src/platforms/discord/interaction-router.js` / `presence.js` | Interaction routing and startup presence. |
| `src/core/services/` | Shared chat settings/context/summary and reminder operations. |
| `src/core/ai/agent/turn/` | Turn fallback, tool round, final answer and reporting helpers. |
| `src/platforms/discord/ui.js` | Embeds, buttons, select menu, attachments, chunking. |
| `src/platforms/discord/bot.js` | Gateway events, admission, command registration. |
| `src/platforms/discord/transport.js` | Send/edit/react/typing/attachments. |
| `src/platforms/discord/events.js` | Message/interaction normalization and allow-list helpers. |
| `src/platforms/discord/prompt.js` | Discord prompt sections. |
| `src/core/` | Platform-neutral engine: agent/queue, LLM service, context, tools, HTTP, logs. |
| `src/platforms/zalo/` | Legacy Zalo process; not imported by Discord. |

---

## Development

```powershell
npm test          # node --test, no network
npm run typecheck # tsc checkJs over src/ and scripts/
```

- 324 unit tests; engine tests inject platform doubles and fake LLM/Tavily clients.
- `scripts/smoke.js` and `scripts/simulate.js` belong to the Zalo process and use real APIs.
- Keep platform behavior in `src/platforms/*`; `src/core` must not branch on platform names.
- No new runtime dependencies without approval.

---

## Legacy Zalo process

The Zalo bot still runs separately (`npm start`, `config.json`, `data/`). It keeps its own
command surface (`/help`, `/status`, `/id`, `/reset`, `/compact`, `/summary`, `/search`,
`/image`, `/sticker`, `/remind`, `/model`, `/tone`, `/think`, `/split`, `/ping`), polling or
webhook mode, stickers and Zalo markdown. Zalo group chat is in beta and only delivers
@mentions/replies. See `config.example.json` for its settings. Discord and Zalo never share
config, tokens, context or reminders.

---

## Known limitations

- No voice messages. Discord stickers are limited to **guild stickers**: listing needs Manage
  Expressions, otherwise configure ids manually; standard/Nitro stickers are not used.
- Presence is static config; it is set on startup and not updated dynamically.
- `read_url` fetches public HTML/text/JSON/XML only (no JavaScript rendering or PDF parsing),
  caps pages at 1 MB and passes only the first part of long pages to the model.
- Vision sees the image attached to the current turn; the durable context keeps a text note,
  so old images are not replayed on later questions.
- Slash commands are guild-scoped when `guildId` is set, so they are unavailable in DMs;
  DM text chat still works.
- Only the first image attachment of an incoming message is considered.
- Reminder input is parsed in Vietnam time; Discord displays local timestamps.
- The Zalo integration remains in the repository but is legacy and independent.
