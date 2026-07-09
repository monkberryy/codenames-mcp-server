import { WORD_POOL, generateRoomCode } from "./words.js";

export type Identity = "agent" | "neutral" | "assassin";
export type Phase = "awaiting_clue" | "guessing" | "won" | "lost";
/** Who holds the key: Claude (classic) or the human (reversed). */
export type Mode = "claude_spymaster" | "human_spymaster";

export interface Card {
  word: string;
  identity: Identity;
  revealed: boolean;
}

export interface Clue {
  word: string;
  count: number; // 0 means "unlimited guesses this turn"
  turn: number;
}

export interface Room {
  code: string;
  mode: Mode;
  cards: Card[];
  clues: Clue[];
  phase: Phase;
  turn: number;
  turnLimit: number;
  guessesLeft: number;
  log: string[];
  lostTo?: string;
  createdAt: number;
  updatedAt: number;
}

export interface GameConfig {
  agents?: number;
  assassins?: number;
  turnLimit?: number;
  mode?: Mode;
}

const DEFAULTS = { agents: 9, assassins: 2, turnLimit: 8 } as const;
const BOARD_SIZE = 25;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

const rooms = new Map<string, Room>();

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function touch(room: Room): void {
  room.updatedAt = Date.now();
}

export function sweepExpiredRooms(): void {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.updatedAt > ROOM_TTL_MS) rooms.delete(code);
  }
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code.trim().toUpperCase());
}

function buildBoard(agents: number, assassins: number): Card[] {
  const words = shuffle([...WORD_POOL]).slice(0, BOARD_SIZE);
  const identities: Identity[] = [
    ...Array<Identity>(agents).fill("agent"),
    ...Array<Identity>(assassins).fill("assassin"),
    ...Array<Identity>(BOARD_SIZE - agents - assassins).fill("neutral"),
  ];
  const shuffled = shuffle(identities);
  return words.map((word, i) => ({ word, identity: shuffled[i], revealed: false }));
}

function freshState(room: Room, config: GameConfig): void {
  const agents = config.agents ?? DEFAULTS.agents;
  const assassins = config.assassins ?? DEFAULTS.assassins;
  const turnLimit = config.turnLimit ?? DEFAULTS.turnLimit;
  if (agents < 1 || assassins < 0 || agents + assassins > BOARD_SIZE - 1) {
    throw new Error(
      `Invalid config: need agents >= 1, assassins >= 0, agents + assassins <= ${BOARD_SIZE - 1}.`
    );
  }
  room.cards = buildBoard(agents, assassins);
  room.clues = [];
  room.phase = "awaiting_clue";
  room.turn = 1;
  room.turnLimit = turnLimit;
  room.guessesLeft = 0;
  room.lostTo = undefined;
  const who = room.mode === "claude_spymaster" ? "Claude is the spymaster" : "The human is the spymaster";
  room.log = [
    `Room ${room.code}: ${who}. ${agents} agents, ${assassins} assassin(s), ${turnLimit} clues.`,
  ];
}

export function createRoom(config: GameConfig = {}): Room {
  const code = generateRoomCode((c) => rooms.has(c));
  const now = Date.now();
  const room = {
    code,
    mode: config.mode ?? "claude_spymaster",
    createdAt: now,
    updatedAt: now,
  } as Room;
  freshState(room, config);
  rooms.set(code, room);
  return room;
}

/** Fresh board on the same room code; mode can be switched for role reversal. */
export function restartRoom(code: string, config: GameConfig = {}): Room {
  const room = getRoom(code);
  if (!room) throw new Error(`Room ${code} not found.`);
  if (config.mode) room.mode = config.mode;
  freshState(room, config);
  touch(room);
  return room;
}

function normalize(word: string): string {
  return word.trim().toUpperCase();
}

export function clueViolation(room: Room, clue: string): string | null {
  const c = normalize(clue);
  if (!/^[A-Z][A-Z-]*$/.test(c)) {
    return "Clue must be a single word (letters and hyphens only, no spaces).";
  }
  for (const card of room.cards) {
    if (card.revealed) continue;
    if (c === card.word || c.includes(card.word) || card.word.includes(c)) {
      return `Clue "${c}" is too close to the unrevealed board word "${card.word}". Pick a different clue.`;
    }
  }
  return null;
}

export function giveClue(code: string, clueWord: string, count: number): Room {
  const room = getRoom(code);
  if (!room) throw new Error(`Room ${code} not found.`);
  if (room.phase === "won" || room.phase === "lost") {
    throw new Error(`The game in ${room.code} is over (${room.phase}). Start a new game to continue.`);
  }
  if (room.phase === "guessing") {
    throw new Error(
      `The guesser is still working on the previous clue ("${room.clues.at(-1)?.word}").`
    );
  }
  const violation = clueViolation(room, clueWord);
  if (violation) throw new Error(violation);
  if (!Number.isInteger(count) || count < 0 || count > 9) {
    throw new Error("Count must be an integer from 0 to 9 (0 = unlimited guesses this turn).");
  }
  const word = normalize(clueWord);
  room.clues.push({ word, count, turn: room.turn });
  room.phase = "guessing";
  room.guessesLeft = count === 0 ? Number.POSITIVE_INFINITY : count + 1;
  room.log.push(`Turn ${room.turn}/${room.turnLimit} — Spymaster's clue: ${word} ${count === 0 ? "∞" : count}`);
  touch(room);
  return room;
}

function endTurn(room: Room, reason: string): void {
  room.log.push(reason);
  room.guessesLeft = 0;
  if (room.turn >= room.turnLimit) {
    room.phase = "lost";
    room.log.push(`Out of clues. ${agentsLeft(room)} agent(s) were never found. Mission failed.`);
  } else {
    room.turn += 1;
    room.phase = "awaiting_clue";
  }
}

export function agentsLeft(room: Room): number {
  return room.cards.filter((c) => c.identity === "agent" && !c.revealed).length;
}

export function guess(code: string, word: string): Room {
  const room = getRoom(code);
  if (!room) throw new Error(`Room ${code} not found.`);
  if (room.phase !== "guessing") {
    throw new Error("A guess is only possible after the spymaster has given a clue.");
  }
  const w = normalize(word);
  const card = room.cards.find((c) => c.word === w);
  if (!card) throw new Error(`"${w}" is not on the board.`);
  if (card.revealed) throw new Error(`"${w}" was already revealed.`);

  card.revealed = true;
  room.guessesLeft -= 1;

  if (card.identity === "assassin") {
    room.phase = "lost";
    room.lostTo = w;
    room.log.push(`Guessed ${w} — the ASSASSIN. Mission failed.`);
  } else if (card.identity === "agent") {
    room.log.push(`Guessed ${w} — agent found! ✔`);
    if (agentsLeft(room) === 0) {
      room.phase = "won";
      room.log.push(`All agents found with ${room.turnLimit - room.turn} clue(s) to spare. Mission accomplished.`);
    } else if (room.guessesLeft <= 0) {
      endTurn(room, "No guesses left on this clue.");
    }
  } else {
    endTurn(room, `Guessed ${w} — a bystander. Turn over.`);
  }
  touch(room);
  return room;
}

export function pass(code: string): Room {
  const room = getRoom(code);
  if (!room) throw new Error(`Room ${code} not found.`);
  if (room.phase !== "guessing") throw new Error("There is no active clue to pass on.");
  endTurn(room, "Guesser stopped guessing.");
  touch(room);
  return room;
}

// ---------- Views ----------

function board(room: Room, withKey: boolean) {
  const over = room.phase === "won" || room.phase === "lost";
  return room.cards.map((c) => ({
    word: c.word,
    revealed: c.revealed,
    identity: withKey || c.revealed || over ? c.identity : null,
  }));
}

/**
 * View for Claude via MCP. Includes the key only in claude_spymaster mode —
 * in reversed games the server keeps Claude honest by never sending it.
 */
export function mcpView(room: Room) {
  const withKey = room.mode === "claude_spymaster";
  return {
    room_code: room.code,
    mode: room.mode,
    your_role: withKey ? "spymaster" : "guesser",
    phase: room.phase,
    turn: room.turn,
    turn_limit: room.turnLimit,
    agents_left: agentsLeft(room),
    guesses_left_on_current_clue:
      room.phase === "guessing"
        ? room.guessesLeft === Number.POSITIVE_INFINITY
          ? "unlimited"
          : room.guessesLeft
        : 0,
    last_clue: room.clues.at(-1) ?? null,
    board: board(room, withKey),
    log: room.log,
    ...(room.lostTo ? { lost_to_assassin: room.lostTo } : {}),
  };
}

/** View for the human's browser. Includes the key only in human_spymaster mode. */
export function browserView(room: Room) {
  const withKey = room.mode === "human_spymaster";
  return {
    code: room.code,
    mode: room.mode,
    phase: room.phase,
    turn: room.turn,
    turnLimit: room.turnLimit,
    agentsLeft: agentsLeft(room),
    guessesLeft:
      room.phase === "guessing"
        ? room.guessesLeft === Number.POSITIVE_INFINITY
          ? "unlimited"
          : room.guessesLeft
        : 0,
    clue: room.clues.at(-1) ?? null,
    board: board(room, withKey),
    log: room.log.slice(-12),
    lostTo: room.lostTo ?? null,
  };
}
