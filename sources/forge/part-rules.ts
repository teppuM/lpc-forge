/**
 * Two rules the part grid applies. Head parts are drawn for one head shape, so
 * they only line up on heads of that shape. Add-ons, such as a shield's chevron
 * or a hat's trim, mean nothing alone, so they wait until what they go on is worn.
 */

/** Heads whose outline matches the human head in all four facings. */
const HUMAN_SHAPED_HEADS: ReadonlySet<string> = new Set([
  "heads_human_child",
  "heads_human_elderly_small",
  "heads_human_female",
  "heads_human_female_elderly",
  "heads_human_female_small",
  "heads_human_male",
  "heads_human_male_elderly",
  "heads_human_male_gaunt",
  "heads_human_male_plump",
  "heads_human_male_small",
  "heads_frankenstein",
  "heads_jack",
  "heads_skeleton",
  "heads_vampire",
  "heads_zombie",
]);

export function isHumanShapedHead(itemId: string): boolean {
  return HUMAN_SHAPED_HEADS.has(itemId);
}

/** Horns and fins are left out: presets put them on lizard heads, and they sit fine. */
const FITTED_HEAD_FOLDERS: ReadonlySet<string> = new Set([
  "ears",
  "eyebrows",
  "eyes",
  "furry_ears",
  "nose",
]);

/** True when a part is drawn to sit on a human-shaped head. */
export function isFittedToHead(path: readonly string[]): boolean {
  const [top, next] = path;
  if (top === "hair") return true;
  if (top === "headwear") return next !== "neck";
  return top === "head" && FITTED_HEAD_FOLDERS.has(next ?? "");
}

const HELMET = "helmet";

const TOP_HATS: Readonly<Record<string, readonly string[]>> = {
  hat_bicorne_athwart_admiral: [
    "hat_bicorne_athwart_admiral_cockade",
    "hat_bicorne_athwart_admiral_trim",
  ],
  hat_bicorne_athwart_basic: ["hat_bicorne_athwart_basic_skull"],
  hat_bicorne_athwart_captain: ["hat_bicorne_athwart_captain_skull"],
  hat_bicorne_athwart_commodore: ["hat_bicorne_athwart_commodore_trim"],
  hat_bicorne_foreaft_commodore: ["hat_bicorne_foreaft_commodore_trim"],
  hat_cap_bonnie: ["hat_cap_bonnie_feather", "hat_cap_bonnie_trim"],
  hat_cap_cavalier: ["hat_cap_cavalier_feather"],
  hat_cap_leather: ["hat_cap_leather_feather"],
  hat_holiday_christmas: ["hat_holiday_elf", "hat_holiday_santa"],
  hat_magic_celestial: ["hat_magic_celestial_trim"],
  hat_magic_celestial_moon: ["hat_magic_celestial_moon_trim"],
  hat_magic_wizard: ["hat_magic_wizard_belt", "hat_magic_wizard_buckle"],
  hat_tricorne: ["hat_tricorne_stitched", "hat_tricorne_thatch"],
  hat_tricorne_captain: [
    "hat_tricorne_captain_skull",
    "hat_tricorne_captain_trim",
  ],
  hat_tricorne_lieutenant: ["hat_tricorne_lieutenant_trim"],
  hat_bandana_pirate: ["hat_bandana_pirate_skull"],
  hat_headband_hairtie: ["hat_headband_hairtie_rune"],
  hat_headband_thick: ["hat_headband_thick_rune"],
};

const OTHER_PARENTS: Readonly<Record<string, readonly string[]>> = {
  backpack: ["backpack_straps"],
  backpack_squarepack: ["backpack_straps"],
  backpack_basket: ["backpack_contents_ore", "backpack_contents_wood"],
  backpack_jetpack: ["backpack_jetpack_fins"],
  belt_obi: ["belt_obi_knot_left", "belt_obi_knot_right"],
  cape_solid: ["cape_trim"],
  cape_tattered: ["cape_trim"],
  dress_kimono: ["dress_kimono_trim"],
  dress_kimono_longsleeve: ["dress_kimono_longsleeve_trim"],
  dress_kimono_oversize: ["dress_kimono_oversize_trim"],
  dress_kimono_split: ["dress_kimono_split_trim"],
  facial_monocle_left: ["facial_monocle_left_frame"],
  facial_monocle_right: ["facial_monocle_right_frame"],
  head_ears_avyon: ["head_ears_avyon_skin"],
  head_ears_cat: ["head_ears_cat_skin"],
  head_ears_lykon: ["head_ears_lykon_skin"],
  head_ears_wolf: ["head_ears_wolf_skin"],
  head_ears_zabos: ["head_ears_zabos_skin"],
  shield_heater_revised_wood: [
    "shield_heater_revised_paint",
    "shield_heater_revised_trim",
  ],
  shield_heater_wood: ["shield_heater_paint", "shield_heater_trim"],
  shield_scutum: ["shield_scutum_trim"],
  shield_two_engrailed: ["shield_two_engrailed_trim"],
  torso_jacket_frock: [
    "torso_jacket_frock_buttons",
    "torso_jacket_frock_collar",
    "torso_jacket_frock_lace",
    "torso_jacket_frock_lapel",
  ],
  wings_monarch: ["wings_monarch_dots", "wings_monarch_edge"],
};

const PARENTS_BY_ADD_ON: ReadonlyMap<string, readonly string[]> = (() => {
  const parents = new Map<string, string[]>();
  for (const table of [TOP_HATS, OTHER_PARENTS]) {
    for (const [parent, addOns] of Object.entries(table)) {
      for (const addOn of addOns) {
        parents.set(addOn, [...(parents.get(addOn) ?? []), parent]);
      }
    }
  }
  return parents;
})();

/**
 * What an add-on goes on, as part ids. Null when the part stands alone. The
 * single entry "helmet" means any helmet.
 */
export function addOnParents(itemId: string): readonly string[] | null {
  if (itemId.startsWith("shield_heater_pattern_")) {
    return ["shield_heater_wood"];
  }
  if (itemId.startsWith("shield_heater_revised_pattern_")) {
    return ["shield_heater_revised_wood"];
  }
  if (itemId.startsWith("hat_visor_") || itemId.startsWith("hat_accessory_")) {
    return [HELMET];
  }
  return PARENTS_BY_ADD_ON.get(itemId) ?? null;
}

export type WornPart = {
  readonly itemId: string;
  readonly path: readonly string[];
};

function goesOn(parent: string, worn: WornPart): boolean {
  return parent === HELMET
    ? worn.path[0] === "headwear" && worn.path[1] === "helmets"
    : worn.itemId === parent;
}

/** True when an add-on's parent is worn, or the part needs none. */
export function hasParentWorn(
  itemId: string,
  worn: readonly WornPart[],
): boolean {
  const parents = addOnParents(itemId);
  if (!parents) return true;
  return parents.some((parent) => worn.some((part) => goesOn(parent, part)));
}

/** True when this worn part is what the add-on goes on. */
export function isParentOf(addOnId: string, worn: WornPart): boolean {
  return (addOnParents(addOnId) ?? []).some((parent) => goesOn(parent, worn));
}

/** Some upstream names are raw keys, such as "per_chevron_inverted". */
export function partLabel(name: string): string {
  if (!name.includes("_") && !/^[a-z]/.test(name)) return name;
  return name
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
