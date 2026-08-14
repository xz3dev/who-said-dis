# `@xz3dev/who-said-dis`

The local companion client for [who-said-dis.com](https://who-said-dis.com), a party game where friends guess who wrote each LLM prompt.

The client finds memorable prompts in your local Codex and Claude Code history, lets you choose which ones to use, and imports only your selections into your game room.

## Play the game

1. Open [who-said-dis.com](https://who-said-dis.com) and create or join a room.
2. Enter your name, then copy the private CLI command shown in the room.
3. Paste the command into a terminal. It will look similar to:

   ```sh
   npx --yes @xz3dev/who-said-dis@0.4.2 import --room https://who-said-dis.com/room/... --token ...
   ```

4. Choose the prompts you want to add with Space, then press Enter.
5. Return to the browser and wait for everyone else to finish. The game will ask the room to guess who wrote each prompt.

The token embedded in the command is personal, expires after 30 minutes, and works once. The client
verifies that it is active before reading prompt history; this check does not consume it. Refresh
the room page to replace an expired token. Do not share the command with other players, and remove
it from your shell history if you share that account. The client refuses plaintext HTTP uploads
except to localhost.

## Requirements

- Node.js 18 or newer
- Codex or Claude Code installed locally
- Local prompt history from at least one supported client

There is nothing to install globally: the command shown by the game runs the right client version with `npx`.

## What leaves your computer?

Your history is read locally and is not modified. Attachments, model output, tool output, and system context are ignored.

The client reads all available prompts, discards those over 500 characters, and sends up to the 1,000 most recent remaining prompts through your locally authenticated Codex or Claude Code connection without local language-specific scoring. Only the prompts you explicitly keep, together with their local citations, are uploaded to your private game room.

## License

MIT
