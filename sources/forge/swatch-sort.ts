/**
 * Arranges palettes for choosing rather than by where they came from: one list
 * with duplicates removed, human skin tones first when choosing a skin color,
 * and everything else ordered so similar colors sit together.
 */
import { hexToLab } from "./custom-color.ts";

export type SwatchTile = {
  readonly key: string;
  readonly label: string;
  readonly colors: readonly string[];
};

export type SwatchGroup = {
  readonly key: string;
  readonly label: string;
  readonly tiles: readonly SwatchTile[];
};

/** Named rather than detected: a tan fur and a tan skin can share the same hue. */
const HUMAN_SKIN_NAMES = new Set([
  "light",
  "amber",
  "olive",
  "taupe",
  "bronze",
  "brown",
  "black",
  "ivory",
  "porcelain",
  "peach",
  "tan",
  "tawny",
  "honey",
  "coffee",
]);

const NEUTRAL_CHROMA = 0.035;
const HUE_BAND_DEGREES = 30;

function middleLab(tile: SwatchTile) {
  return hexToLab(tile.colors[Math.floor(tile.colors.length / 2)]);
}

function byLightnessDescending(a: SwatchTile, b: SwatchTile): number {
  return middleLab(b).l - middleLab(a).l;
}

/** Neutrals from light to dark, then hue bands around the wheel, each light to dark. */
function bySimilarity(tiles: readonly SwatchTile[]): SwatchTile[] {
  const place = (tile: SwatchTile) => {
    const { l, a, b } = middleLab(tile);
    if (Math.hypot(a, b) < NEUTRAL_CHROMA) return { band: -1, l };
    const degrees = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
    return { band: Math.floor(degrees / HUE_BAND_DEGREES), l };
  };
  return [...tiles].sort((x, y) => {
    const px = place(x);
    const py = place(y);
    return px.band - py.band || py.l - px.l;
  });
}

/** Later palette families repeat earlier ramps under the same or a different name. */
function withoutDuplicateRamps(tiles: readonly SwatchTile[]): SwatchTile[] {
  const seen = new Set<string>();
  return tiles.filter((tile) => {
    const ramp = tile.colors.join(",").toLowerCase();
    if (seen.has(ramp)) return false;
    seen.add(ramp);
    return true;
  });
}

function lastKeyPart(key: string): string {
  return key.split(".").pop() ?? key;
}

export function arrangeSwatches(
  tiles: readonly SwatchTile[],
  material: string,
): SwatchGroup[] {
  const unique = withoutDuplicateRamps(tiles);
  if (material !== "body") {
    return [{ key: "all", label: "", tiles: bySimilarity(unique) }];
  }
  const human = unique.filter((t) => HUMAN_SKIN_NAMES.has(lastKeyPart(t.key)));
  const rest = unique.filter((t) => !human.includes(t));
  return [
    {
      key: "human",
      label: "Human skin tones",
      tiles: [...human].sort(byLightnessDescending),
    },
    { key: "other", label: "Other colors", tiles: bySimilarity(rest) },
  ];
}
