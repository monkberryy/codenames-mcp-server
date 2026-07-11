# codenames-mcp-server

Play Codenames **with** your Claude — not against a bot, and not against an API call. In classic mode, the Claude instance in your chat is the spymaster: it sees the hidden key through MCP tools and gives you one-word clues while you guess on a live board in your browser. In **reversed mode**, you are the spymaster: your browser shows you the key and a clue form, and Claude does the guessing — the server never sends Claude the key, so its deductions are provably genuine.

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
| `codenames_create_room` | New room + board; returns the join URL. Options: `agents`, `assassins`, `turn_limit`, and `my_role` (`"spymaster"` default, `"guesser"` for reversed mode). |
| `codenames_get_state` | Role-aware view: includes the key only when Claude is spymaster. |
| `codenames_give_clue` | (Claude as spymaster) Post a clue (`clue`, `count`; `count: 0` = unlimited). Validated against board words. |
| `codenames_guess` | (Claude as guesser) Guess one board word against the human's clue. |
| `codenames_pass` | (Claude as guesser) Stop guessing and hand the turn back. |
| `codenames_restart` | Fresh board, same room code/URL; `my_role` here swaps who is spymaster. |

In reversed mode the human's board shows the key as colored card edges (green = agent, red = assassin) plus a clue form; ask Claude to *"restart the room with you as guesser"* to swap roles mid-session.

## Notes and limits

- **State is in memory.** Rooms expire after 24 h idle and vanish on redeploy. Perfect for pick-up games; add Redis/SQLite if you want persistence.
- **No auth.** Room codes are the only secret (~400 combinations — fine among friends, not adversaries). Don't expose anything sensitive through this server.
- The word pool is an original list of common English nouns; swap in your own in `src/words.ts` (any language works — the game is a great bilingual exercise).

## The Window (phone camera bridge)

The server also hosts **the Window**: Claude calls `window_create` and gives you a URL like `/eye/EMBER-421` to open **on your phone**. Press START, grant the camera, and Claude can then call `window_look` to receive a single frame as a true image it can see. Privacy rules, enforced by design: the camera runs only while the page is open and started; a photo is taken only when `window_look` is called; every capture flashes visibly on your screen; frames are delivered once and never stored. Close the page and the window is closed. An optional note field travels with the next frame.

MIT licensed. Built to be forked: Duet-style two-sided keys, competitive two-team mode, or entirely different turn-based games all fit the same referee-server pattern.
