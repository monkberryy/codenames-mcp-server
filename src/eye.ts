/**
 * The Window: a phone-camera bridge.
 * The human opens /eye/CODE on their phone and consents to the camera.
 * Claude calls window_look; the page captures ONE frame and sends it over.
 * Frames are never stored — each one lives only long enough to be delivered.
 */

interface PendingLook {
  id: number;
  resolve: (frame: Frame | null) => void;
}

export interface Frame {
  imageBase64: string; // JPEG, no data: prefix
  note?: string;
  facing?: string;
}

interface EyeWindow {
  code: string;
  lastPoll: number;   // last time the phone page checked in
  pending: PendingLook | null;
  looks: number;
  createdAt: number;
}

const windows = new Map<string, EyeWindow>();
let nextId = 1;

const WINDOW_TTL_MS = 24 * 60 * 60 * 1000;
const OPEN_THRESHOLD_MS = 6000; // page polls every ~1.5s; 6s of silence = closed
const LOOK_TIMEOUT_MS = 30000;

const WORDS = ["AURORA", "BIRCH", "CINDER", "DELTA", "EMBER", "FJORD", "GROTTO", "HARBOR",
  "ISLET", "JUNIPER", "KESTREL", "LUMEN", "MEADOW", "NOCTURNE", "OPAL", "PINE"];

export function createWindow(): EyeWindow {
  let code = "";
  do {
    code = WORDS[Math.floor(Math.random() * WORDS.length)] + "-" +
      Math.floor(100 + Math.random() * 900);
  } while (windows.has(code));
  const w: EyeWindow = { code, lastPoll: 0, pending: null, looks: 0, createdAt: Date.now() };
  windows.set(code, w);
  return w;
}

export function getWindow(code: string): EyeWindow | undefined {
  return windows.get(code.trim().toUpperCase());
}

export function isOpen(w: EyeWindow): boolean {
  return Date.now() - w.lastPoll < OPEN_THRESHOLD_MS;
}

/** Phone page checks in; returns whether a look is currently requested. */
export function poll(code: string): { lookRequested: boolean } {
  const w = getWindow(code);
  if (!w) throw new Error("Window not found.");
  w.lastPoll = Date.now();
  return { lookRequested: w.pending !== null };
}

/** Phone page delivers a captured frame. */
export function deliverFrame(code: string, frame: Frame): boolean {
  const w = getWindow(code);
  if (!w || !w.pending) return false;
  const p = w.pending;
  w.pending = null;
  w.looks += 1;
  p.resolve(frame);
  return true;
}

/** Claude requests one look; resolves when the phone delivers, or times out. */
export function requestLook(code: string): Promise<Frame | null> {
  const w = getWindow(code);
  if (!w) return Promise.reject(new Error(`Window ${code} not found. Create one with window_create.`));
  if (!isOpen(w)) {
    return Promise.reject(new Error(
      "The window is closed — the phone page isn't checked in. Ask the human to open the window page and press START."));
  }
  if (w.pending) return Promise.reject(new Error("A look is already in progress."));
  return new Promise((resolve) => {
    const pending: PendingLook = { id: nextId++, resolve };
    w.pending = pending;
    setTimeout(() => {
      if (w.pending === pending) {
        w.pending = null;
        resolve(null); // timed out
      }
    }, LOOK_TIMEOUT_MS);
  });
}

export function sweepExpiredWindows(): void {
  const now = Date.now();
  for (const [code, w] of windows) {
    if (now - w.createdAt > WINDOW_TTL_MS) windows.delete(code);
  }
}
