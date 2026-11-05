/**
 * Saved characters, kept in this browser on this device. A saved character is
 * the same text the page address holds, plus a name and a small picture, so
 * anything that opens from a link opens from here too.
 */
export type SavedCharacter = {
  readonly id: string;
  readonly name: string;
  readonly hash: string;
  readonly picture: string;
  readonly savedAt: string;
};

const STORAGE_KEY = "lpc-forge-saved";
const FILE_FORMAT = "lpc-forge-saved";

function isSavedCharacter(value: unknown): value is SavedCharacter {
  const entry = value as Partial<SavedCharacter> | null;
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    typeof entry.hash === "string" &&
    typeof entry.picture === "string" &&
    typeof entry.savedAt === "string"
  );
}

export function readSavedList(): SavedCharacter[] {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    return Array.isArray(parsed) ? parsed.filter(isSavedCharacter) : [];
  } catch {
    return [];
  }
}

/** False when the browser would not keep it: private window, or out of room. */
export function writeSavedList(list: readonly SavedCharacter[]): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function newSavedCharacter(
  name: string,
  hash: string,
  picture: string,
  now: Date = new Date(),
): SavedCharacter {
  return {
    id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    hash,
    picture,
    savedAt: now.toISOString(),
  };
}

export function savedListToFile(list: readonly SavedCharacter[]): string {
  return JSON.stringify(
    { format: FILE_FORMAT, version: 1, characters: list },
    null,
    1,
  );
}

/** The characters in a saved list file, or null when it is not one. */
export function savedListFromFile(text: string): SavedCharacter[] | null {
  try {
    const parsed = JSON.parse(text) as {
      format?: unknown;
      characters?: unknown;
    };
    if (parsed.format !== FILE_FORMAT || !Array.isArray(parsed.characters)) {
      return null;
    }
    return parsed.characters.filter(isSavedCharacter);
  } catch {
    return null;
  }
}

/** Adds `incoming` to `list`, skipping any character already there. */
export function mergeSavedLists(
  list: readonly SavedCharacter[],
  incoming: readonly SavedCharacter[],
): SavedCharacter[] {
  const merged = [...list];
  for (const entry of incoming) {
    if (!merged.some((other) => other.hash === entry.hash)) merged.push(entry);
  }
  return merged;
}
