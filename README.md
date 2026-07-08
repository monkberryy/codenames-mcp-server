# codenames-mcp-server

Play Codenames **with** your Claude — not against a bot, and not against an API call. The Claude instance in your chat is the spymaster: it sees the hidden key through MCP tools and gives you one-word clues. You guess on a live board in your browser. Every clue is a genuine decision by the model you're mid-conversation with.

One small Node server does both jobs: it speaks MCP to Claude on `/mcp` and serves the human's board on `/room/<CODE>`.

## The game

Cooperative, one-team Codenames:

- 25 words. 9 are your **agents**, 2 are **assassins**, the rest are bystanders. Only the spymaster (Claude) sees which is which.
- Claude gives a clue: one word + a number (e.g. `OCEAN 3`). You may guess up to number + 1 words.
- Reveal an agent → keep guessing. A bystander → turn ends. An assassin → game over.
- Find all 9 agents within 8 clues to win. Difficulty is configurable per game.

The server enforces the mechanical rules (clue can't match or contain a board word, phase order, guess limits). The *spirit* of the rules — clues about meaning only, no smuggled information — is on the players, as in the tabletop original.

## Run it locally

```bash
npm install
npm run build
npm start            # listens on :3000
```

Test the MCP side with the inspector:

```bash
npx @modelcontextprotocol/inspector
# connect to http://localhost:3000/mcp (Streamable HTTP)
```

## Deploy (so your Claude can reach it)

claude.ai connects to remote MCP servers over HTTPS, so deploy anywhere that runs Node and gives you a public URL. Fly.io example (a `Dockerfile` and `fly.toml` are included):

```bash
fly launch --no-deploy      # accept the generated app name or pick one
fly secrets set PUBLIC_URL=https://<your-app>.fly.dev
fly deploy
```

`PUBLIC_URL` is only used to build the join links Claude shows you — set it to wherever the server is reachable.

## Connect Claude

1. In claude.ai / the Claude app: **Settings → Connectors → Add custom connector**.
2. URL: `https://<your-app>.fly.dev/mcp` (no authentication).
3. In a chat, enable the connector and say: *"Create a Codenames room and be my spymaster."*

## How a session flows

1. Claude calls `codenames_create_room`, receives the secret key, and tells you the join URL (e.g. `/room/AMBER-FOX`). Open it on any device.
2. Claude calls `codenames_give_clue` — the clue types itself onto your board.
3. Tap words to guess (tap twice to confirm). Bystander or "stop guessing" ends your turn.
4. **Send Claude any message** ("done", "your turn", or your table talk). Chat models only act when you message them, so this is the drumbeat of the game. Claude calls `codenames_get_state`, reads what happened, and gives the next clue.
5. Win, lose, post-mortem, and `codenames_restart` for a rematch on the same URL.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `codenames_create_room` | New room + board; returns the spymaster key and join URL. Options: `agents`, `assassins`, `turn_limit`. |
| `codenames_get_state` | Full spymaster view: phase, board with identities, log. |
| `codenames_give_clue` | Post a clue (`clue`, `count`; `count: 0` = unlimited guesses). Validated against board words. |
| `codenames_restart` | Fresh board, same room code/URL. |

## Notes and limits

- **State is in memory.** Rooms expire after 24 h idle and vanish on redeploy. Perfect for pick-up games; add Redis/SQLite if you want persistence.
- **No auth.** Room codes are the only secret (~400 combinations — fine among friends, not adversaries). Don't expose anything sensitive through this server.
- The word pool is an original list of common English nouns; swap in your own in `src/words.ts` (any language works — the game is a great bilingual exercise).

MIT licensed. Built to be forked: Duet-style two-sided keys, competitive two-team mode, or entirely different turn-based games all fit the same referee-server pattern.
