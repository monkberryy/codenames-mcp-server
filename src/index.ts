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
  browserView,
  mcpView,
  pass,
  restartRoom,
  sweepExpiredRooms,
} from "./game.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

// ---------- MCP server (Claude's side, in either role) ----------

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "codenames-mcp-server", version: "2.0.0" });

  const configShape = {
    agents: z.number().int().min(1).max(15).optional()
      .describe("Number of agent words to find (default 9)"),
    assassins: z.number().int().min(0).max(5).optional()
      .describe("Number of assassin words that instantly lose the game (default 2)"),
    turn_limit: z.number().int().min(1).max(15).optional()
      .describe("Number of clues available before the mission fails (default 8)"),
  };

  const roleShape = {
    my_role: z.enum(["spymaster", "guesser"]).optional()
      .describe("Claude's role. 'spymaster' (default): Claude sees the key and gives clues; the human guesses in the browser. 'guesser' (reversed): the human sees the key in the browser and types clues; Claude guesses via codenames_guess and NEVER receives the hidden identities."),
  };

  server.registerTool(
    "codenames_create_room",
    {
      title: "Create Codenames Room",
      description: `Start a new cooperative Codenames game between YOU and a human, in either role.

Classic mode (my_role: "spymaster", default): you receive the full key (which of the 25 words are agents / bystanders / assassins) and give one-word clues with codenames_give_clue. The human guesses by tapping their browser board.

Reversed mode (my_role: "guesser"): the human is the spymaster. Their browser shows the key and a clue form; you guess with codenames_guess. In this mode the server NEVER sends you the hidden identities — you learn each card's identity only when it is revealed.

Rules in both modes: a clue is one word + a number; the guesser may guess up to number + 1 words; an agent lets them continue, a bystander ends the turn, an assassin loses the game. Win by finding all agents within the clue limit.

Returns JSON: { room_code, join_url, your_role, board, turn_limit }. Tell the human the join_url. In reversed mode, after they say a clue is posted, call codenames_get_state to read it, then guess.`,
      inputSchema: { ...configShape, ...roleShape },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ agents, assassins, turn_limit, my_role }) => {
      const room = createRoom({
        agents,
        assassins,
        turnLimit: turn_limit,
        mode: my_role === "guesser" ? "human_spymaster" : "claude_spymaster",
      });
      const output = {
        ...mcpView(room),
        join_url: `${PUBLIC_URL}/room/${room.code}`,
      };
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }
  );

  server.registerTool(
    "codenames_get_state",
    {
      title: "Get Codenames Game State",
      description: `Fetch the current state of a room: phase, board, last clue, log. Your view depends on your role — as spymaster it includes the key; as guesser it never does (identities appear only for revealed cards, or once the game is over).

phase: awaiting_clue (spymaster must give a clue), guessing (guesser's move), won, lost. Use this after the human reports activity on their side.`,
      inputSchema: {
        room_code: z.string().min(3).describe('Room code, e.g. "AMBER-FOX"'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ room_code }) => {
      const room = getRoom(room_code);
      if (!room) {
        throw new Error(`Room ${room_code} not found. It may have expired (24h idle) or the server restarted.`);
      }
      return { content: [{ type: "text", text: JSON.stringify(mcpView(room), null, 2) }] };
    }
  );

  server.registerTool(
    "codenames_give_clue",
    {
      title: "Give Spymaster Clue",
      description: `(Claude-as-spymaster mode only.) Give your one-word clue and count. Appears instantly on the human's board; their guessing turn begins (up to count + 1 guesses; count 0 = unlimited).

Server-enforced: single word, must not match/contain/be contained in an unrevealed board word, only when phase is "awaiting_clue". Honor rules: clue the MEANING of words; never smuggle extra information.`,
      inputSchema: {
        room_code: z.string().min(3).describe("Room code"),
        clue: z.string().min(1).max(40).describe("A single word, not on the board"),
        count: z.number().int().min(0).max(9).describe("How many board words relate (0 = unlimited guesses)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ room_code, clue, count }) => {
      const room = getRoom(room_code);
      if (!room) throw new Error(`Room ${room_code} not found.`);
      if (room.mode !== "claude_spymaster") {
        throw new Error("In this room the human is the spymaster — clues come from their browser. Your tool is codenames_guess.");
      }
      const updated = giveClue(room_code, clue, count);
      return { content: [{ type: "text", text: JSON.stringify(mcpView(updated), null, 2) }] };
    }
  );

  server.registerTool(
    "codenames_guess",
    {
      title: "Guess a Word",
      description: `(Claude-as-guesser mode only.) Guess one board word against the human spymaster's current clue. The reveal happens live on their screen.

Returns the outcome: agent (keep guessing if you have guesses left), bystander (turn ends), or assassin (game over). Guess one word at a time and reconsider after each reveal. You may stop early with codenames_pass — often wise. Only callable when phase is "guessing".`,
      inputSchema: {
        room_code: z.string().min(3).describe("Room code"),
        word: z.string().min(1).max(40).describe("The board word you are guessing"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ room_code, word }) => {
      const room = getRoom(room_code);
      if (!room) throw new Error(`Room ${room_code} not found.`);
      if (room.mode !== "human_spymaster") {
        throw new Error("In this room YOU are the spymaster — guessing happens in the human's browser. Your tool is codenames_give_clue.");
      }
      const updated = guess(room_code, word);
      return { content: [{ type: "text", text: JSON.stringify(mcpView(updated), null, 2) }] };
    }
  );

  server.registerTool(
    "codenames_pass",
    {
      title: "Stop Guessing",
      description: `(Claude-as-guesser mode only.) Voluntarily end your guessing turn, banking what you've found and handing the turn back to the human spymaster. Only callable when phase is "guessing".`,
      inputSchema: {
        room_code: z.string().min(3).describe("Room code"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ room_code }) => {
      const room = getRoom(room_code);
      if (!room) throw new Error(`Room ${room_code} not found.`);
      if (room.mode !== "human_spymaster") {
        throw new Error("In this room the human is the guesser — passing happens in their browser.");
      }
      const updated = pass(room_code);
      return { content: [{ type: "text", text: JSON.stringify(mcpView(updated), null, 2) }] };
    }
  );

  server.registerTool(
    "codenames_restart",
    {
      title: "Restart Codenames Game",
      description: `Deal a fresh board in an existing room, keeping the same code and URL so the human's browser tab keeps working. Optionally change difficulty (agents / assassins / turn_limit) or swap roles with my_role — e.g. restart with my_role: "guesser" to reverse who is spymaster.`,
      inputSchema: {
        room_code: z.string().min(3).describe("Room code"),
        ...configShape,
        ...roleShape,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ room_code, agents, assassins, turn_limit, my_role }) => {
      const room = restartRoom(room_code, {
        agents,
        assassins,
        turnLimit: turn_limit,
        mode: my_role ? (my_role === "guesser" ? "human_spymaster" : "claude_spymaster") : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(mcpView(room), null, 2) }] };
    }
  );

  return server;
}

// ---------- HTTP app ----------

const app = express();
app.use(express.json());

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
    res.status(404).json({ error: "Room not found. Ask your Claude to create one." });
    return;
  }
  res.json(browserView(room));
});

// Human guesses (classic mode only — in reversed mode Claude guesses via MCP).
app.post("/api/room/:code/guess", (req, res) => {
  try {
    const room = getRoom(req.params.code);
    if (!room) throw new Error("Room not found.");
    if (room.mode !== "claude_spymaster") throw new Error("You are the spymaster — Claude does the guessing.");
    const word = z.object({ word: z.string().min(1) }).parse(req.body).word;
    res.json(browserView(guess(req.params.code, word)));
  } catch (err) {
    res.status(400).json({ error: asMessage(err) });
  }
});

app.post("/api/room/:code/pass", (req, res) => {
  try {
    const room = getRoom(req.params.code);
    if (!room) throw new Error("Room not found.");
    if (room.mode !== "claude_spymaster") throw new Error("You are the spymaster — only Claude can stop guessing.");
    res.json(browserView(pass(req.params.code)));
  } catch (err) {
    res.status(400).json({ error: asMessage(err) });
  }
});

// Human gives a clue (reversed mode only).
app.post("/api/room/:code/clue", (req, res) => {
  try {
    const room = getRoom(req.params.code);
    if (!room) throw new Error("Room not found.");
    if (room.mode !== "human_spymaster") throw new Error("Claude is the spymaster in this room.");
    const body = z.object({
      clue: z.string().min(1).max(40),
      count: z.number().int().min(0).max(9),
    }).parse(req.body);
    res.json(browserView(giveClue(req.params.code, body.clue, body.count)));
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
  console.log(`codenames-mcp-server v2 listening on port ${port}`);
  console.log(`MCP endpoint:  ${PUBLIC_URL}/mcp`);
  console.log(`Human boards:  ${PUBLIC_URL}/room/<CODE>`);
});
