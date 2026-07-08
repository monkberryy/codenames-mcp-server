import { WORD_POOL, generateRoomCode } from "./words.js";

export type Identity = "agent" | "neutral" | "assassin";
export type Phase = "awaiting_clue" | "guessing" | "won" | "lost";

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
  cards: Card[];
  clues: Clue[];
  phase: Phase;
  turn: number; // 1-based index of the current clue turn
  turnLimit: number;
  guessesLeft: number; // Infinity when clue count is 0
  log: string[];
  lostTo?: string; // the assassin word, if the game was lost that way
  createdAt: number;
  updatedAt: number;
}

export interface GameConfig {
  agents?: number;
  assassins?: number;
  turnLimit?: number;
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

export function createRoom(config: GameConfig = {}): Room {
  const agents = config.agents ?? DEFAULTS.agents;
  const assassins = config.assassins ?? DEFAULTS.assassins;
  const turnLimit = config.turnLimit ?? DEFAULTS.turnLimit;
  if (agents < 1 || assassins < 0 || agents + assassins > BOARD_SIZE - 1) {
    throw new Error(
      `Invalid config: need agents >= 1, assassins >= 0, agents + assassins <= ${BOARD_SIZE - 1}.`
    );
  }
  const code = generateRoomCode((c) => rooms.has(c));
  const now = Date.now();
  const room: Room = {
    code,
    cards: buildBoard(agents, assassins),
    clues: [],
    phase: "awaiting_clue",
    turn: 1,
    turnLimit,
    guessesLeft: 0,
    log: [`Room ${code} created. ${agents} agents to find, ${assassins} assassin(s) on the board, ${turnLimit} clues available.`],
    createdAt: now,
    updatedAt: now,
  };
  rooms.set(code, room);
  return room;
}

/** Starts a fresh game on an existing room (same code/URL for the human). */
export function restartRoom(code: string, config: GameConfig = {}): Room {
  const room = getRoom(code);
  if (!room) throw new Error(`Room ${code} not found.`);
  const agents = config.agents ?? DEFAULTS.agents;
  const assassins = config.assassins ?? DEFAULTS.assassins;
  const turnLimit = config.turnLimit ?? DEFAULTS.turnLimit;
  room.cards = buildBoard(agents, assassins);
  room.clues = [];
  room.phase = "awaiting_clue";
  room.turn = 1;
  room.turnLimit = turnLimit;
  room.guessesLeft = 0;
  room.lostTo = undefined;
  room.log = [`New game started in room ${code}. ${agents} agents, ${assassins} assassin(s), ${turnLimit} clues.`];
  touch(room);
  return room;
}

function normalize(word: string): string {
  return word.trim().toUpperCase();
}

/** A clue is illegal if it equals, contains, or is contained in an unrevealed board word. */
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
  if (!room) throw new Error(`Room ${code} not found. Create one with codenames_create_room.`);
  if (room.phase === "won" || room.phase === "lost") {
    throw new Error(`The game in ${room.code} is over (${room.phase}). Use codenames_restart to play again.`);
  }
  if (room.phase === "guessing") {
    throw new Error(
      `The guesser is still working on your previous clue ("${room.clues.at(-1)?.word}"). Wait for them to finish, then check codenames_get_state.`
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
    throw new Error("You can only guess after the spymaster has given a clue.");
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

/** The human voluntarily stops guessing and hands the turn back. */
export function pass(code: string): Room {
  const room = getRoom(code);
  if (!room) throw new Error(`Room ${code} not found.`);
  if (room.phase !== "guessing") throw new Error("There is no active clue to pass on.");
  endTurn(room, "Guesser stopped guessing.");
  touch(room);
  return room;
}

// ---------- Views ----------

/** Full view for the spymaster (Claude). Includes hidden identities. */
export function spymasterView(room: Room) {
  return {
    room_code: room.code,
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
    board: room.cards.map((c) => ({
      word: c.word,
      identity: c.identity,
      revealed: c.revealed,
    })),
    log: room.log,
    ...(room.lostTo ? { lost_to_assassin: room.lostTo } : {}),
  };
}

/** Redacted view for the guesser's browser. Identities only for revealed cards. */
export function guesserView(room: Room) {
  return {
    code: room.code,
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
    board: room.cards.map((c) => ({
      word: c.word,
      revealed: c.revealed,
      // Hidden identities are disclosed only once the game is over.
      identity: c.revealed || room.phase === "won" || room.phase === "lost" ? c.identity : null,
    })),
    log: room.log.slice(-12),
    lostTo: room.lostTo ?? null,
  };
}
