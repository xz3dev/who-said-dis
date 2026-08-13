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
TURNSTILE_SITE_KEY=your-public-site-key
TURNSTILE_SECRET=your-private-secret
```

For production, configure the Turnstile widget for `who-said-dis.com`, then run:

```sh
docker compose up --build -d
```

The service listens on port 3000 and persists its SQLite database in the
`who-said-dis-data` Docker volume. Put an HTTPS reverse proxy or Cloudflare Tunnel in front of it.
Room presence uses an authenticated WebSocket at `/api/rooms/*/socket`. Only participants with a
live socket are shown in the room. The server sends a WebSocket ping every 20 seconds and drops a
connection that misses the next pong; the browser reconnects automatically with exponential
backoff. Configure your reverse proxy to pass WebSocket upgrades and use an idle timeout above 20
seconds.

For local UI development with Turnstile deliberately bypassed:

```sh
TURNSTILE_BYPASS=1 npm run dev
```

Never enable `TURNSTILE_BYPASS` in production.
The lobby uses `npm run cli --` during local development and
`npx @xz3dev/who-said-dis` when `NODE_ENV=production` to build its private import command.
Set `CLI_COMMAND` to override the command prefix for another deployment environment.
Set `VOTE_TIMEOUT_SECONDS` to control the voting window (45 seconds by default).

After joining, each participant receives a private CLI command tied to their room name. The CLI
scans and analyzes local history, lets them select prompts, and imports only those selected prompt
texts and citations. A round shows one prompt with up to four possible authors. It reveals when
every participant has voted or the voting window expires, then any participant can continue.
Correct answers earn 100–200 points: the base 100 points are multiplied by a speed factor from
1× at the deadline to 2× at the start of the voting window. Wrong or missing answers earn 0.

## Client CLI

An interactive CLI that discovers locally installed Codex and Claude Code clients and helps you select memorable prompts from their local history.

History is read locally and without modification. Only user prompt text is considered—attachments, model output, tool output, and system context are ignored.

## Run

```sh
npx @xz3dev/who-said-dis
```

The wizard will:

1. Scan `PATH` and common installation directories for supported clients.
2. Print every installation as `provider: /path/to/executable` and use all of their prompt histories.
3. Scan up to 10,000 recent prompts across all distinct local data stores.
4. Use Codex with Luna for analysis when available, otherwise Claude with Haiku.
5. Analyze only prompts containing at most three lines and 400 characters.
6. Show five candidates in an interactive checkbox list. All are selected initially; use Space to toggle and Enter to confirm.
7. Print the chosen prompts under `Using these:`.

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
who-said-dis funny --scan 10000 --json
```

The `funny` command scores every prompt locally using broad signals such as comic frustration,
typo chaos, escalation, excessive punctuation, accidental phrasing, and deadpan brevity. It sends
a bounded shortlist (250 by default) to the selected provider's fast analyzer—Luna for Codex or
Haiku for Claude—at medium reasoning effort through the selected local CLI. The interactive wizard shows the five resulting prompt
texts without generated explanations, sentiment, or labels.

The analyzer subprocess cannot use tools and does not persist its analysis session. Codex runs
ephemerally in a read-only sandbox; Claude runs with tools disabled and session persistence off.
Model inference still uses the selected client's authenticated connection, so shortlisted prompt
text is sent to that provider's configured service.

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
npm pack --dry-run
```

## License

MIT
