# who-said-dis

This repository contains three parts:

- `apps/web`: the no-login room creation, joining, and lobby frontend.
- `apps/server`: the HTTP API, Turnstile verification, and SQLite room storage.
- `apps/cli`: the local prompt-scanning CLI published as `@xz3dev/who-said-dis`.

## Web app

Creating a room requires Cloudflare Turnstile but does not ask for a name or create a participant.
The backend returns a private invite URL and the browser redirects to it. The creator then joins in
exactly the same way as every invitee: enter a name, pass a fresh Turnstile check, and submit the
private join token.

Private join tokens live in the URL fragment so they are not sent with the initial page request.
The backend stores only token hashes. Rooms expire after 24 hours and are limited to 20 people.

Copy `.env.example` to `.env` and configure at least:

```dotenv
PUBLIC_URL=https://who-said-dis.com
TURNSTILE_SITE_KEY=your-public-site-key
TURNSTILE_SECRET=your-private-secret
LEGAL_NAME=Full legal name or registered entity
LEGAL_ADDRESS=Street and number, postal code, city, country
LEGAL_EMAIL=legal@example.com
POSTHOG_PUBLIC_KEY=your-public-project-key
```

Production startup requires those three legal-contact values. If applicable, also set
`LEGAL_REPRESENTATIVE`, `LEGAL_REGISTER`, and `LEGAL_REGISTRATION_NUMBER`. They populate the linked
`/imprint` and `/privacy` pages; do not publish placeholder details.

For production, configure the Turnstile widget for `who-said-dis.com`, then run:

```sh
docker compose up --build -d
```

The service binds to `127.0.0.1:3000` by default and persists its SQLite database in the
`who-said-dis-data` Docker volume. Put an HTTPS reverse proxy or Cloudflare Tunnel in front of it.
If the proxy reaches Docker over another interface, set `BIND_ADDRESS` explicitly. Leave
`TRUST_PROXY=0` unless client-IP forwarding is required. When enabling it, set
`TRUSTED_PROXY_IPS` to the comma-separated IP addresses of the direct proxy peers; forwarded
addresses from any other peer are ignored.
Room presence uses an authenticated WebSocket at `/api/rooms/*/socket`. Only participants with a
live socket are shown in the room. The server sends a WebSocket ping every 20 seconds and drops a
connection that misses the next pong; the browser reconnects automatically with exponential
backoff. Configure your reverse proxy to pass WebSocket upgrades and use an idle timeout above 20
seconds.

For local UI development with Turnstile deliberately bypassed:

```sh
TURNSTILE_BYPASS=1 npm run dev
```

Production startup rejects `TURNSTILE_BYPASS=1`, plaintext `PUBLIC_URL`, and disabled secure
cookies.
The lobby uses `npm run cli --` during local development and
an exact, versioned `npx --yes @xz3dev/who-said-dis@<version>` command when
`NODE_ENV=production`.
Set `CLI_COMMAND` to override the command prefix for another deployment environment.
Set `VOTE_TIMEOUT_SECONDS` to control the voting window (45 seconds by default).
Set `POSTHOG_PUBLIC_KEY` to enable cookieless PostHog Cloud EU analytics. The browser SDK is
configured without person profiles, session replay, surveys, feature flags, or persistent storage.
Only page views and clicks on buttons explicitly marked with `data-capture-id` are collected.

After joining, each participant receives a private CLI command containing a one-time import token.
The token expires after 30 minutes, is replaced when a new one is issued, and is consumed by the
first successful import. Before reading any history, the CLI verifies that the token is active
without consuming it. The CLI then scans and analyzes local history, lets the participant select
prompts, and imports only those selected prompt texts and citations over HTTPS (or HTTP on
localhost for development). A round shows one prompt with up to four possible authors. It reveals when
every participant has voted or the voting window expires, then any participant can continue.
Correct answers earn 100–200 points: the base 100 points are multiplied by a speed factor from
1× at the deadline to 2× at the start of the voting window. Wrong or missing answers earn 0.

## Client CLI

An interactive CLI that discovers locally installed Codex and Claude Code clients and helps you select memorable prompts from their local history.

The npm-facing client guide lives in [`apps/cli/README.md`](apps/cli/README.md).

History is read locally and without modification. Only user prompt text is considered—attachments, model output, tool output, and system context are ignored.

## Run

```sh
npx --yes @xz3dev/who-said-dis@0.4.2
```

The wizard will:

1. Scan `PATH` and common installation directories for supported clients.
2. Print every installation as `provider: /path/to/executable` and use all of their prompt histories.
3. Read every available prompt across all distinct local data stores.
4. Discard prompts longer than 500 characters and keep up to the 1,000 most recent remaining prompts.
5. Use Codex with Luna for analysis when available, otherwise Claude with Haiku.
6. Send those prompts directly to the analyzer without local language-specific scoring.
7. Show up to five genuinely funny candidates in an interactive checkbox list. All are selected initially; use Space to toggle and Enter to confirm.
8. Print the chosen prompts under `Using these:`.

During local development:

```sh
npm run cli
```

The non-interactive inspection commands remain available for development:

```sh
who-said-dis --limit 20
who-said-dis --json
who-said-dis --codex-home /custom/codex/home
who-said-dis --history /path/to/history.jsonl
```

## Analysis

```sh
who-said-dis funny
who-said-dis funny --json
```

The `funny` command reads the complete history, removes prompts over 500 characters, and sends up to
1,000 of the most recent remaining prompts to the selected provider's fast
analyzer—Luna for Codex or Haiku for Claude—at medium reasoning effort through the selected local
CLI. There is no other local filtering or truncation of prompt text. The judge applies a strict humor threshold and may return fewer than five results—or none. The interactive wizard shows the resulting prompt
texts without generated explanations, sentiment, or labels.

The analyzer subprocess does not persist its analysis session. Both analyzers run from a fresh,
empty temporary directory. Codex ignores user configuration and execution rules, disables its
tool-capable features and web search, and runs ephemerally in a read-only sandbox. Claude uses safe
mode with tools, plugins, hooks, MCP configuration, project instructions, skills, and session
persistence disabled.
Model inference still uses the selected client's authenticated connection, so up to 1,000 eligible
prompts are sent to that provider's configured service.

The Codex directory is resolved in this order:

1. `--codex-home`
2. `CODEX_HOME`
3. `~/.codex`

The Claude directory is resolved from `CLAUDE_CONFIG_DIR`, then `~/.claude`. Prompt text is read
from `history.jsonl` and deduplicated project transcripts. Separate `pastedContents`, attachment,
tool-result, metadata, and subagent records are never included.

## Output and citations

Each prompt includes its originating client, timestamp, session ID, original text, and a local citation:

```text
codex://session/<session-id>/prompt/<ordinal>#sha256=<digest>
claude://session/<session-id>/prompt/<ordinal>#sha256=<digest>
```

JSON output also includes the originating surface plus the source file and line number. The digest can be used to verify that the prompt text has not changed.

## Library API

```js
import { readClaudePrompts, readCodexPrompts } from "@xz3dev/who-said-dis";

const { prompts } = await readCodexPrompts({ limit: 100 });
const { prompts: claudePrompts } = await readClaudePrompts({ limit: 100 });
```

## Adding another provider

Providers live in `apps/cli/src/providers/` and implement three operations:

- `scanInstallations()` returns executable and local-data locations.
- `readPrompts(installation, options)` returns normalized prompt records.
- `analyze(installation, prompts, options)` invokes that provider's configured analyzer.

Register the adapter in `apps/cli/src/providers/index.js`; the interactive flow does not need provider-specific changes.

## Limitations

- The selected client must have local history persistence enabled.
- The proof of concept relies on Codex and Claude Code's current JSONL record shapes and may need updates if either internal shape changes.
- Only the main text stored in each prompt record is returned. Files and attachments are not read.

## Development

Requires Node.js 18 or newer.

```sh
npm test
npm run pack:cli
```

## License

MIT
