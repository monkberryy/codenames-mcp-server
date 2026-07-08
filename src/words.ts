// Original word pool of common English nouns chosen for rich, overlapping
// associations (the property that makes clue-giving interesting).
export const WORD_POOL: readonly string[] = [
  "ANCHOR", "APPLE", "ARROW", "AVALANCHE", "BADGE", "BANK", "BARREL", "BAT",
  "BEACH", "BELL", "BLADE", "BLIZZARD", "BOOT", "BRIDGE", "BUTTON", "CABLE",
  "CANDLE", "CANYON", "CASTLE", "CELL", "CHAIN", "CHARGE", "CHEST", "CIRCLE",
  "CLOUD", "COMET", "COMPASS", "CORD", "COURT", "CRANE", "CROWN", "CRYSTAL",
  "CURRENT", "DESERT", "DIAMOND", "DOCK", "DRAGON", "DRILL", "DRUM", "ECHO",
  "ENGINE", "FALL", "FEATHER", "FENCE", "FIDDLE", "FILE", "FLAME", "FLEET",
  "FLOOD", "FOREST", "FORGE", "FOSSIL", "FRAME", "FROST", "GARDEN", "GATE",
  "GHOST", "GIANT", "GLASS", "GLOVE", "GRAIN", "GRAVE", "GUARD", "HARBOR",
  "HELMET", "HONEY", "HOOK", "HORN", "HOUND", "ICEBERG", "INK", "IRON",
  "ISLAND", "IVY", "JAM", "JET", "JUDGE", "KEY", "KING", "KITE",
  "KNIGHT", "LABYRINTH", "LADDER", "LANTERN", "LASER", "LAVA", "LEAD", "LETTER",
  "LIBRARY", "LIGHTNING", "LIMB", "LION", "LOCK", "LOG", "MAMMOTH", "MAP",
  "MARBLE", "MARCH", "MASK", "MATCH", "MEDIC", "MERCURY", "MILL", "MINE",
  "MIRROR", "MOLE", "MOSS", "MOTH", "MOUNT", "NEEDLE", "NET", "NIGHT",
  "NOTE", "NOVEL", "OAK", "OASIS", "OPERA", "ORBIT", "ORGAN", "OWL",
  "PALACE", "PALM", "PARACHUTE", "PARADE", "PATCH", "PEARL", "PHANTOM", "PIANO",
  "PILOT", "PIPE", "PIRATE", "PITCH", "PLAGUE", "PLANET", "PLATE", "POCKET",
  "POINT", "POLE", "PORT", "PRESS", "PRISM", "PUPPET", "PYRAMID", "QUARTZ",
  "QUEEN", "QUILL", "RAIL", "RANGER", "REEF", "RIDDLE", "RING", "RIVER",
  "ROBOT", "ROCKET", "ROOT", "ROSE", "ROUND", "RULER", "SADDLE", "SATELLITE",
  "SCALE", "SCARECROW", "SCHOOL", "SCOUT", "SEAL", "SHADOW", "SHARK", "SHELL",
  "SHIELD", "SIGNAL", "SIREN", "SKETCH", "SLIPPER", "SMOKE", "SNAKE", "SPARK",
  "SPHINX", "SPIDER", "SPINE", "SPRING", "SPY", "STAFF", "STAGE", "STAMP",
  "STATION", "STEAM", "STITCH", "STORM", "STREAM", "STRING", "SUBMARINE", "SUGAR",
  "SUMMIT", "SWITCH", "TANK", "TELESCOPE", "TEMPLE", "THEATER", "THORN", "THRONE",
  "TIDE", "TIGER", "TORCH", "TOWER", "TRACK", "TRAIL", "TRAIN", "TRAP",
  "TREASURE", "TRENCH", "TRIANGLE", "TRUNK", "TUNNEL", "TURTLE", "UMBRELLA", "VAULT",
  "VEIL", "VOLCANO", "WAGON", "WALL", "WATCH", "WAVE", "WELL", "WHALE",
  "WHEEL", "WHISTLE", "WIND", "WING", "WIRE", "WITCH", "WOLF", "YARN",
];

const ADJECTIVES = [
  "AMBER", "COBALT", "CRIMSON", "EMBER", "FROST", "GOLDEN", "HOLLOW", "IRON",
  "IVORY", "JADE", "LUNAR", "MIDNIGHT", "ONYX", "SCARLET", "SILENT", "SILVER",
  "SOLAR", "VELVET", "WILD", "ZERO",
] as const;

const ANIMALS = [
  "BADGER", "CONDOR", "CROW", "FALCON", "FOX", "HERON", "JACKAL", "LYNX",
  "MANTIS", "OCELOT", "OTTER", "PANTHER", "RAVEN", "SABLE", "SPARROW", "STOAT",
  "VIPER", "WALRUS", "WOLF", "WREN",
] as const;

/** Generates a memorable, spy-flavored room code like "AMBER-FOX". */
export function generateRoomCode(taken: (code: string) => boolean): string {
  for (let i = 0; i < 100; i++) {
    const code =
      ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] +
      "-" +
      ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    if (!taken(code)) return code;
  }
  // Extremely unlikely fallback: append a number.
  return `ROOM-${Math.floor(Math.random() * 100000)}`;
}
