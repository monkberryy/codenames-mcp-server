import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createWindow,
  deliverFrame,
  getWindow,
  isOpen,
  poll,
  requestLook,
  sweepExpiredWindows,
} from "./eye.js";
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

  server.registerTool(
    "window_create",
    {
      title: "Open a Camera Window",
      description: `Create a Window: a page the human opens on their PHONE that, with their explicit consent (they must press START), lets Claude request single camera frames via window_look.

Privacy by design: the camera only runs while the page is open with START pressed; a frame is captured ONLY when window_look is called; every capture flashes visibly on their screen; frames are delivered once and never stored.

Returns { window_code, url }. Give the human the url to open on their phone.`,
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      const w = createWindow();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ window_code: w.code, url: `${PUBLIC_URL}/eye/${w.code}` }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    "window_look",
    {
      title: "Look Through the Window",
      description: `Request ONE camera frame from the human's phone through an open Window. The phone page captures a single photo (with a visible flash on their screen) and returns it as an image Claude can actually see, plus any note the human typed.

Requires the human to have the window page open with START pressed. Waits up to 30 seconds for the frame. Use sparingly and respectfully — each call takes a real photo of the human's surroundings.`,
      inputSchema: {
        window_code: z.string().min(3).describe('Window code, e.g. "EMBER-421"'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ window_code }) => {
      const frame = await requestLook(window_code);
      if (!frame) {
        return {
          content: [{ type: "text", text: "The look timed out — no frame arrived within 30s. The page may have lost focus; ask the human to check the window page is open and try again." }],
          isError: true,
        };
      }
      const content: any[] = [
        { type: "image", data: frame.imageBase64, mimeType: "image/jpeg" },
      ];
      const meta: string[] = [];
      if (frame.facing) meta.push(`camera: ${frame.facing}`);
      if (frame.note) meta.push(`note from the human: ${frame.note}`);
      if (meta.length) content.push({ type: "text", text: meta.join(" | ") });
      return { content };
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

// ---------- The Window (phone camera) ----------

app.get("/api/eye/:code/poll", (req, res) => {
  try {
    res.json(poll(req.params.code));
  } catch (err) {
    res.status(404).json({ error: asMessage(err) });
  }
});

app.post("/api/eye/:code/frame", express.json({ limit: "8mb" }), (req, res) => {
  try {
    const body = z.object({
      image: z.string().min(100),
      note: z.string().max(500).optional(),
      facing: z.string().max(20).optional(),
    }).parse(req.body);
    const delivered = deliverFrame(req.params.code, {
      imageBase64: body.image,
      note: body.note,
      facing: body.facing,
    });
    res.json({ delivered });
  } catch (err) {
    res.status(400).json({ error: asMessage(err) });
  }
});

app.get("/api/eye/:code/status", (req, res) => {
  const w = getWindow(req.params.code);
  if (!w) { res.status(404).json({ error: "Window not found." }); return; }
  res.json({ code: w.code, open: isOpen(w), looks: w.looks });
});

app.get("/eye/:code", (_req, res) => {
  res.sendFile(path.join(publicDir, "eye.html"));
});

// ---------- Static UI ----------

const publicDir = path.resolve(__dirname, "..", "public");
app.use(express.static(publicDir));
app.get("/room/:code", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ---------- Start ----------

setInterval(() => { sweepExpiredRooms(); sweepExpiredWindows(); }, 60 * 60 * 1000).unref();

const port = parseInt(process.env.PORT ?? "3000", 10);
app.listen(port, () => {
  console.log(`codenames-mcp-server v2 listening on port ${port}`);
  console.log(`MCP endpoint:  ${PUBLIC_URL}/mcp`);
  console.log(`Human boards:  ${PUBLIC_URL}/room/<CODE>`);
});
