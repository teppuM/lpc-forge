/**
 * The three shared colors. Skin rides on Universal LPC's existing body-color
 * matching. Hair is by equality: a part follows Hair exactly while its color
 * equals Hair's, so picking a different color for a beard takes it out of the
 * group, picking the same color puts it back, and saved links need no new data.
 * Eyes are one selection that every part with an eye color reads.
 */
import type { CatalogReader, ItemLite } from "../state/catalog.ts";
import {
  compilePaletteKey,
  CUSTOM_KEY,
  CUSTOM_VERSION,
  fixMissingRecolor,
  getBodyColor,
  getPaletteOptions,
  getTargetPalette,
  type PaletteOption,
} from "../state/palettes.ts";
import { selectItem, type State } from "../state/state.ts";
import { ucwords } from "../utils/helpers.ts";
import { isCustomColorKey, customKeyToHex } from "./custom-color.ts";
import {
  arrangeSwatches,
  type SwatchGroup,
  type SwatchTile,
} from "./swatch-sort.ts";

export type { SwatchGroup };

export type ColorGroup = "skin" | "hair" | "eyes";

const GROUP_MATERIAL: Record<ColorGroup, string> = {
  skin: "body",
  hair: "hair",
  eyes: "eye",
};

const DEFAULT_COLOR: Record<ColorGroup, string> = {
  skin: "light",
  hair: "chestnut",
  eyes: "brown",
};

function lite(catalog: CatalogReader, itemId: string): ItemLite | null {
  return catalog.getItemLite(itemId).unwrapOr(null);
}

export function getSkinColor(catalog: CatalogReader, state: State): string {
  return (
    getBodyColor(catalog, "body", state.selections).unwrapOr(null) ??
    DEFAULT_COLOR.skin
  );
}

/** The hair slot defines Hair. Without one, the first hair-material part does. */
export function getHairColor(
  catalog: CatalogReader,
  state: State,
  fallback: string,
): string {
  const hairSlot = state.selections.hair?.recolor;
  if (hairSlot) return hairSlot;
  for (const selection of Object.values(state.selections)) {
    if (selection.subId) continue;
    const meta = lite(catalog, selection.itemId);
    if (meta?.recolors[0]?.material === "hair" && selection.recolor) {
      return selection.recolor;
    }
  }
  return fallback;
}

export function getEyeColor(state: State): string {
  return state.selections.eyes?.recolor || DEFAULT_COLOR.eyes;
}

/** The selected part that can carry an eye color, with its recolor index. */
function findEyeCarrier(
  catalog: CatalogReader,
  state: State,
): { itemId: string; index: number } | null {
  for (const selection of Object.values(state.selections)) {
    const index = lite(catalog, selection.itemId)?.recolors.findIndex(
      (r) => r.type_name === "eyes",
    );
    if (index !== undefined && index >= 0) {
      return { itemId: selection.itemId, index };
    }
  }
  return null;
}

export function canSetEyeColor(catalog: CatalogReader, state: State): boolean {
  return (
    findEyeCarrier(catalog, state) !== null ||
    lite(catalog, state.selections.eyes?.itemId ?? "")?.type_name === "eyes"
  );
}

export function setSkinColor(state: State, color: string): void {
  selectItem(state, state.selections.body?.itemId ?? "body", color);
}

/** Moves Hair and every part following it from `previous` to `color`. */
export function setHairColor(
  catalog: CatalogReader,
  state: State,
  previous: string,
  color: string,
): void {
  for (const selection of Object.values(state.selections)) {
    if (selection.recolor !== previous) continue;
    const meta = lite(catalog, selection.itemId);
    if (!meta) continue;
    const index = selection.subId ?? 0;
    if (meta.recolors[index]?.material !== "hair") continue;
    if (
      !selection.subId &&
      fixMissingRecolor(catalog, selection.itemId, color).isErr()
    ) {
      continue;
    }
    selectItem(
      state,
      selection.itemId,
      color,
      false,
      selection.subId ? selection.subId : null,
    );
  }
}

export function setEyeColor(
  catalog: CatalogReader,
  state: State,
  color: string,
): void {
  const carrier = findEyeCarrier(catalog, state);
  if (carrier) {
    selectItem(state, carrier.itemId, color, false, carrier.index);
    return;
  }
  const current = state.selections.eyes?.itemId;
  if (current) selectItem(state, current, color);
}

/**
 * Lists every palette an option offers as one arranged list.
 *
 * Keys are compiled against the part's own palette definition. `option.material`
 * follows the current selection, so a part wearing a color from the shared "all"
 * family would otherwise build wrong keys for every other color, and the hash
 * round trip then drops the selection and the part vanishes.
 */
export function swatchGroupsFor(
  catalog: CatalogReader,
  itemId: string,
  option: PaletteOption,
): SwatchGroup[] {
  const palette = catalog.getPaletteMetadata().unwrapOr(null);
  const own = lite(catalog, itemId)?.recolors[option.idx];
  if (!palette || !own) return [];
  const keyOption = { ...option, material: own.material, default: own.default };
  const tiles: SwatchTile[] = option.versions.flatMap((category) => {
    const [material, version] = category.split(".");
    let recolors = palette.materials[material]?.palettes?.[version] ?? {};
    if (version === CUSTOM_VERSION && option.sourceColors?.length) {
      recolors = { [CUSTOM_KEY]: option.sourceColors };
    }
    return Object.entries(recolors).map(([name, colors]) => ({
      key: compilePaletteKey(material, version, name, keyOption),
      label: ucwords(name.replaceAll("_", " ")),
      colors,
    }));
  });
  return arrangeSwatches(tiles, own.material);
}

/** Any part of the right material stands in for a group's palette listing. */
function findPartWithMaterial(
  catalog: CatalogReader,
  material: string,
): { itemId: string; index: number } | null {
  // Skin is applied through the body itself, so it must offer the body's list.
  if (material === "body" && lite(catalog, "body")) {
    return { itemId: "body", index: 0 };
  }
  const indexes = catalog.getMetadataIndexes().unwrapOr(null);
  for (const rows of Object.values(indexes?.byTypeName ?? {})) {
    for (const row of rows) {
      const index = lite(catalog, row.itemId)?.recolors.findIndex(
        (r) => r.material === material,
      );
      if (index !== undefined && index >= 0) {
        return { itemId: row.itemId, index };
      }
    }
  }
  return null;
}

export function swatchGroupsForColorGroup(
  catalog: CatalogReader,
  state: State,
  group: ColorGroup,
): SwatchGroup[] {
  const part = findPartWithMaterial(catalog, GROUP_MATERIAL[group]);
  const meta = part && lite(catalog, part.itemId);
  if (!part || !meta) return [];
  const [options] = getPaletteOptions(catalog, state, part.itemId, meta);
  const option = options[part.index];
  return option ? swatchGroupsFor(catalog, part.itemId, option) : [];
}

/** A color that previews a recolor key: the middle step of its ramp, as CSS. */
export function chipColor(
  catalog: CatalogReader,
  material: string,
  key: string,
): string {
  if (isCustomColorKey(key)) return customKeyToHex(key);
  const ramp = getTargetPalette(catalog, material, key).unwrapOr(null);
  return ramp ? ramp[Math.floor(ramp.length / 2)] : "transparent";
}

export function materialForGroup(group: ColorGroup): string {
  return GROUP_MATERIAL[group];
}

export function defaultHairColor(): string {
  return DEFAULT_COLOR.hair;
}
