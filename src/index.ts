import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createRoom,
  getRoom,
  giveClue,
  guess,
  guesserView,
  pass,
  restartRoom,
  spymasterView,
  sweepExpiredRooms,
} from "./game.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

// ---------- MCP server (the spymaster's side) ----------

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "codenames-mcp-server", version: "1.0.0" });

  const configShape = {
    agents: z.number().int().min(1).max(15).optional()
      .describe("Number of agent words to find (default 9)"),
    assassins: z.number().int().min(0).max(5).optional()
      .describe("Number of assassin words that instantly lose the game (default 2)"),
    turn_limit: z.number().int().min(1).max(15).optional()
      .describe("Number of clues you may give before the mission fails (default 8)"),
  };

  server.registerTool(
    "codenames_create_room",
    {
      title: "Create Codenames Room",
      description: `Start a new cooperative Codenames game where YOU are the spymaster and a human is the guesser.

Creates a 25-word board and returns: the room code, the URL the human should open in a browser, and the full spymaster key (which words are agents, bystanders, or assassins). The human's browser never sees the hidden identities.

How the game works:
1. You see all identities; the human sees only the 25 words.
2. You give a one-word clue plus a number via codenames_give_clue.
3. The human taps guesses in their browser. Agents let them keep guessing; a bystander ends the turn; an assassin loses the game instantly.
4. Win by revealing all agents before the clue limit runs out.

Returns JSON: { room_code, join_url, board: [{word, identity, revealed}], turn_limit }

After creating the room, tell the human the join URL and start thinking about your first clue.`,
      inputSchema: configShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ agents, assassins, turn_limit }) => {
      const room = createRoom({ agents, assassins, turnLimit: turn_limit });
      const output = {
        ...spymasterView(room),
        join_url: `${PUBLIC_URL}/room/${room.code}`,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }
  );

  server.registerTool(
    "codenames_get_state",
    {
      title: "Get Codenames Game State",
      description: `Fetch the current state of a Codenames room, including the full spymaster key, whose move it is, guesses made so far, and the game log.

Use this after the human tells you they finished guessing (phase will be back to "awaiting_clue"), or any time you need to re-read the board. phase is one of: awaiting_clue (your move — give a clue), guessing (human is still guessing), won, lost.

Returns JSON: { room_code, phase, turn, turn_limit, agents_left, last_clue, board: [{word, identity, revealed}], log }`,
      inputSchema: {
        room_code: z.string().min(3).describe('Room code, e.g. "AMBER-FOX"'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ room_code }) => {
      const room = getRoom(room_code);
      if (!room) {
        throw new Error(`Room ${room_code} not found. It may have expired (24h idle). Create a new one with codenames_create_room.`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(spymasterView(room), null, 2) }],
      };
    }
  );

  server.registerTool(
    "codenames_give_clue",
    {
      title: "Give Spymaster Clue",
      description: `Give your one-word clue and a count. The clue appears instantly on the human's browser board and their guessing turn begins (they may guess up to count + 1 words; count 0 grants unlimited guesses).

Rules enforced by the server: the clue must be a single word and must not match, contain, or be contained in any unrevealed board word. It can only be called when phase is "awaiting_clue".

The honor rules are yours to uphold: the clue should relate to the MEANING of your target words, and you must not smuggle in extra information (positions, spelling tricks, prior-conversation codes). Play it straight — that's the game.

Returns the updated spymaster view. After calling this, tell the human their clue is up and wait for them to report back (you cannot see their guesses until you next call codenames_get_state).`,
      inputSchema: {
        room_code: z.string().min(3).describe('Room code, e.g. "AMBER-FOX"'),
        clue: z.string().min(1).max(40).describe("A single word, not on the board"),
        count: z.number().int().min(0).max(9)
          .describe("How many board words relate to the clue (0 = unlimited guesses)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ room_code, clue, count }) => {
      const room = giveClue(room_code, clue, count);
      return {
        content: [{ type: "text", text: JSON.stringify(spymasterView(room), null, 2) }],
      };
    }
  );

  server.registerTool(
    "codenames_restart",
    {
      title: "Restart Codenames Game",
      description: `Deal a fresh board in an existing room, keeping the same room code and URL so the human's browser tab keeps working. Use after a game ends and the human wants a rematch. Optionally change difficulty via agents / assassins / turn_limit.

Returns the new spymaster view including the fresh key.`,
      inputSchema: {
        room_code: z.string().min(3).describe('Room code, e.g. "AMBER-FOX"'),
        ...configShape,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ room_code, agents, assassins, turn_limit }) => {
      const room = restartRoom(room_code, { agents, assassins, turnLimit: turn_limit });
      return {
        content: [{ type: "text", text: JSON.stringify(spymasterView(room), null, 2) }],
      };
    }
  );

  return server;
}

// ---------- HTTP app ----------

const app = express();
app.use(express.json());

// Stateless MCP endpoint: fresh transport per request.
app.post("/mcp", async (req, res) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// ---------- REST API for the human's browser ----------

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

app.get("/api/room/:code", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) {
    res.status(404).json({ error: "Room not found. Check the code with your Claude." });
    return;
  }
  res.json(guesserView(room));
});

app.post("/api/room/:code/guess", (req, res) => {
  try {
    const word = z.object({ word: z.string().min(1) }).parse(req.body).word;
    res.json(guesserView(guess(req.params.code, word)));
  } catch (err) {
    res.status(400).json({ error: asMessage(err) });
  }
});

app.post("/api/room/:code/pass", (req, res) => {
  try {
    res.json(guesserView(pass(req.params.code)));
  } catch (err) {
    res.status(400).json({ error: asMessage(err) });
  }
});

// ---------- Static UI ----------

const publicDir = path.resolve(__dirname, "..", "public");
app.use(express.static(publicDir));
app.get("/room/:code", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ---------- Start ----------

setInterval(sweepExpiredRooms, 60 * 60 * 1000).unref();

const port = parseInt(process.env.PORT ?? "3000", 10);
app.listen(port, () => {
  console.log(`codenames-mcp-server listening on port ${port}`);
  console.log(`MCP endpoint:  ${PUBLIC_URL}/mcp`);
  console.log(`Human boards:  ${PUBLIC_URL}/room/<CODE>`);
});
