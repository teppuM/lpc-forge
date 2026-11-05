/**
 * Presets are recipes, not saved characters: each says what a kind of character
 * may look like, and a roll picks from it. Choices come from pflat's race files,
 * mapped onto Universal LPC's parts and palettes. Add or tune one here; the Node
 * spec checks every part and color named below against the catalog.
 *
 * A recipe decides who the character is. Clothes and gear are never rolled.
 */

/** A part, optionally with a relative likelihood and parts that come with it. */
export type PartChoice =
  | string
  | {
      readonly id: string;
      readonly weight?: number;
      readonly with?: readonly string[];
    };

/** A palette name, or any color between two others. */
export type ColorChoice =
  string | { readonly from: string; readonly to: string };

export type PartRule = {
  /** Named parts, or everything in a slot that holds all the usual animations. */
  readonly from: readonly PartChoice[] | { readonly anyInSlot: string };
  /** How often the part appears at all, from 0 to 1. Always, if left out. */
  readonly chance?: number;
  readonly bodies?: readonly string[];
  /** Wear the same color as the character's skin or hair. */
  readonly follow?: "skin" | "hair";
  /** Colors to pick from, for parts that do not follow anything. */
  readonly colors?: readonly string[];
};

export type Recipe = {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  readonly heads: {
    readonly male: readonly PartChoice[];
    readonly female: readonly PartChoice[];
    readonly teen?: readonly PartChoice[];
    readonly child?: readonly PartChoice[];
  };
  /** The body part, when not the ordinary skin-colored one. */
  readonly bodyItem?: string;
  /** Skin colors. Left out, the body keeps the color it arrives in. */
  readonly skin?: readonly ColorChoice[];
  readonly hair?: readonly string[];
  readonly eyes?: readonly string[];
  readonly parts: readonly PartRule[];
  /** What the preset's picture shows. */
  readonly picture: {
    readonly skin?: string;
    readonly hair?: string;
    readonly parts: readonly string[];
  };
};

/**
 * How often a roll lands on each body. At zero, only by locking Body there.
 * Muscular is zero because its art has no shoot, climb, emote, combat idle,
 * backslash or halfslash, which would leave a roll with a floating head in them.
 */
export const BODY_WEIGHTS: Readonly<Record<string, number>> = {
  male: 4,
  female: 4,
  muscular: 0,
  teen: 1,
  pregnant: 0,
  child: 0,
};

/** The slots a roll may change. Everything else on the character stays put. */
export const ROLLED_SLOTS: readonly string[] = [
  "head",
  "expression",
  "eyes",
  "ears",
  "ears_inner",
  "furry_ears",
  "furry_ears_skin",
  "horns",
  "fins",
  "nose",
  "eyebrows",
  "wrinkles",
  "hair",
  "hairextl",
  "hairextr",
  "ponytail",
  "updo",
  "beard",
  "mustache",
  "tail",
  "wings",
  "wings_dots",
  "wings_edge",
  "wound_arm",
  "wound_brain",
  "wound_eye_left",
  "wound_eye_right",
  "wound_face",
  "wound_mouth",
  "wound_ribs",
];

const HUMAN_SKIN = [
  "light",
  "amber",
  "olive",
  "taupe",
  "bronze",
  "brown",
  "black",
] as const;
const NATURAL_HAIR = [
  "black",
  "raven",
  "dark_brown",
  "chestnut",
  "light_brown",
  "blonde",
  "sandy",
  "ginger",
  "redhead",
  "ash",
  "platinum",
  "gray",
  "white",
] as const;
const BLOOD = ["maroon"] as const;
const NATURAL_EYES = ["brown", "blue", "green", "gray"] as const;
const FUR = [
  "fur_black",
  "fur_brown",
  "fur_copper",
  "fur_gold",
  "fur_grey",
  "fur_tan",
  "fur_white",
] as const;
const GREEN_SKIN = [
  "green",
  "dark_green",
  "bright_green",
  "pale_green",
] as const;
const SCALES = [
  "bright_green",
  "dark_green",
  "green",
  "#23AE71",
  "#CE6B5A",
  "#6C25A7",
] as const;

const POINTED_EARS: readonly PartChoice[] = [
  "head_ears_elven",
  "head_ears_medium",
  "head_ears_long",
  "head_ears_down",
  "head_ears_hang",
  "head_ears_dragon",
];
const NOSES = [
  "head_nose_big",
  "head_nose_button",
  "head_nose_straight",
  "head_nose_large",
];
const MEN = ["male", "muscular"] as const;

const HUMAN_HEADS = {
  male: [
    { id: "heads_human_male", weight: 6 },
    "heads_human_male_plump",
    "heads_human_male_gaunt",
    "heads_human_male_elderly",
  ],
  female: [
    { id: "heads_human_female", weight: 6 },
    "heads_human_female_small",
    "heads_human_female_elderly",
  ],
  teen: ["heads_human_male_small", "heads_human_female_small"],
  child: ["heads_human_child"],
} as const;

const NEUTRAL_FACE: PartRule = { from: ["face_neutral"] };
const ANY_HAIR: PartRule = { from: { anyInSlot: "hair" }, chance: 0.95 };
const BEARD: PartRule = {
  from: { anyInSlot: "beard" },
  chance: 0.25,
  bodies: MEN,
};
const MUSTACHE: PartRule = {
  from: { anyInSlot: "mustache" },
  chance: 0.15,
  bodies: MEN,
};
const SOME_NOSE: PartRule = { from: NOSES, chance: 0.25 };

/** The parts every human-headed recipe shares. */
const HUMAN_FEATURES = [
  NEUTRAL_FACE,
  ANY_HAIR,
  BEARD,
  MUSTACHE,
  SOME_NOSE,
] as const;

/** A beast whose head carries everything: one head, fur or skin, no hair. */
function beast(
  id: string,
  name: string,
  heads: Recipe["heads"],
  skin: readonly ColorChoice[],
  parts: readonly PartRule[] = [],
  pictureParts: readonly string[] = [],
): Recipe {
  const first = heads.male[0];
  return {
    id,
    name,
    group: "Beasts",
    heads,
    skin,
    parts,
    picture: {
      skin: typeof skin[0] === "string" ? skin[0] : undefined,
      parts: [typeof first === "string" ? first : first.id, ...pictureParts],
    },
  };
}

const samePart = (id: string, child?: string): Recipe["heads"] => ({
  male: [id],
  female: [id],
  ...(child ? { child: [child] } : {}),
});

export const RECIPES: readonly Recipe[] = [
  {
    id: "human",
    name: "Human",
    group: "People",
    heads: HUMAN_HEADS,
    skin: HUMAN_SKIN,
    hair: NATURAL_HAIR,
    eyes: NATURAL_EYES,
    parts: HUMAN_FEATURES,
    picture: {
      skin: "light",
      hair: "chestnut",
      parts: ["heads_human_male", "hair_plain"],
    },
  },
  {
    id: "darkelf",
    name: "Dark Elf",
    group: "People",
    heads: HUMAN_HEADS,
    skin: [{ from: "#C9D0EE", to: "#787C8F" }, "lavender"],
    hair: ["white", "platinum", "ash", "gray", "black", "raven"],
    eyes: ["red", "purple", "orange", "gray"],
    parts: [
      NEUTRAL_FACE,
      ANY_HAIR,
      { from: POINTED_EARS },
      { from: ["head_nose_straight"], chance: 0.25 },
    ],
    picture: {
      skin: "#A0A5BC",
      hair: "white",
      parts: ["heads_human_female", "head_ears_elven", "hair_long"],
    },
  },
  {
    id: "fairy",
    name: "Fairy",
    group: "People",
    heads: HUMAN_HEADS,
    skin: HUMAN_SKIN,
    hair: [...NATURAL_HAIR, "pink", "rose", "purple", "green", "blue"],
    eyes: [...NATURAL_EYES, "purple"],
    parts: [
      NEUTRAL_FACE,
      ANY_HAIR,
      { from: POINTED_EARS },
      {
        from: [
          "wings_monarch",
          "wings_pixie",
          "wings_pixie_transparent",
          "wings_dragonfly",
          "wings_dragonfly_transparent",
          "wings_lunar",
        ],
        colors: ["sky", "rose", "lavender", "teal", "gold", "pink", "white"],
      },
    ],
    picture: {
      skin: "light",
      hair: "rose",
      parts: [
        "heads_human_female",
        "head_ears_elven",
        "hair_pixie",
        "wings_pixie",
      ],
    },
  },
  {
    id: "halfcat",
    name: "Half-Cat",
    group: "People",
    heads: HUMAN_HEADS,
    skin: HUMAN_SKIN,
    hair: NATURAL_HAIR,
    eyes: ["green", "yellow", "brown", "blue"],
    parts: [
      NEUTRAL_FACE,
      ANY_HAIR,
      {
        from: [
          { id: "head_ears_cat", with: ["head_ears_cat_skin"] },
          { id: "head_ears_zabos", with: ["head_ears_zabos_skin"] },
        ],
      },
      { from: ["tail_cat"], follow: "hair" },
    ],
    picture: {
      skin: "light",
      hair: "ginger",
      parts: [
        "heads_human_female",
        "head_ears_cat",
        "head_ears_cat_skin",
        "hair_bangsshort",
        "tail_cat",
      ],
    },
  },
  {
    id: "halfwolf",
    name: "Half-Wolf",
    group: "People",
    heads: HUMAN_HEADS,
    skin: HUMAN_SKIN,
    hair: NATURAL_HAIR,
    eyes: ["yellow", "brown", "gray", "orange"],
    parts: [
      NEUTRAL_FACE,
      ANY_HAIR,
      BEARD,
      {
        from: [
          { id: "head_ears_wolf", with: ["head_ears_wolf_skin"] },
          { id: "head_ears_lykon", with: ["head_ears_lykon_skin"] },
        ],
      },
      { from: ["tail_wolf", "tail_wolf_fluffy"], follow: "hair" },
    ],
    picture: {
      skin: "olive",
      hair: "gray",
      parts: [
        "heads_human_male",
        "head_ears_wolf",
        "head_ears_wolf_skin",
        "hair_messy1",
        "tail_wolf",
      ],
    },
  },
  {
    id: "halfbird",
    name: "Half-Bird",
    group: "People",
    heads: HUMAN_HEADS,
    skin: HUMAN_SKIN,
    hair: [...NATURAL_HAIR, "blue", "red", "green"],
    eyes: ["yellow", "orange", "brown"],
    parts: [
      NEUTRAL_FACE,
      ANY_HAIR,
      { from: [{ id: "head_ears_avyon", with: ["head_ears_avyon_skin"] }] },
      { from: ["wings_feathered"], follow: "hair" },
    ],
    picture: {
      skin: "amber",
      hair: "blue",
      parts: [
        "heads_human_female",
        "head_ears_avyon",
        "head_ears_avyon_skin",
        "hair_swoop",
        "wings_feathered",
      ],
    },
  },
  {
    id: "faun",
    name: "Faun",
    group: "People",
    heads: HUMAN_HEADS,
    skin: HUMAN_SKIN,
    hair: NATURAL_HAIR,
    eyes: ["brown", "orange", "yellow", "green"],
    parts: [
      NEUTRAL_FACE,
      ANY_HAIR,
      BEARD,
      { from: POINTED_EARS },
      {
        from: ["head_horns_curled", "head_horns_backwards"],
        colors: ["taupe", "bronze", "brown", "black"],
      },
    ],
    picture: {
      skin: "amber",
      hair: "dark_brown",
      parts: [
        "heads_human_male",
        "head_ears_elven",
        "hair_curly_short",
        "head_horns_curled",
      ],
    },
  },
  {
    id: "vampire",
    name: "Vampire",
    group: "Monsters",
    heads: { male: ["heads_vampire"], female: ["heads_vampire"] },
    // Some degree of grey, warm or cool, never one fixed tone.
    skin: [
      { from: "#B4B0AD", to: "#6E6A68" },
      { from: "#ACAFB8", to: "#62666F" },
    ],
    hair: NATURAL_HAIR,
    eyes: ["red", "orange", "yellow", "purple"],
    parts: [
      ANY_HAIR,
      { from: POINTED_EARS },
      { from: ["wound_mouth"], chance: 0.15, colors: BLOOD },
    ],
    picture: {
      skin: "#8E8B89",
      hair: "black",
      parts: ["heads_vampire", "head_ears_elven", "hair_parted"],
    },
  },
  {
    id: "zombie",
    name: "Zombie",
    group: "Monsters",
    heads: { male: ["heads_zombie"], female: ["heads_zombie"] },
    skin: ["zombie", "zombie_green", "#92B08E"],
    hair: ["dark_gray", "gray", "dark_brown", "ash", "black"],
    parts: [
      { from: { anyInSlot: "hair" }, chance: 0.6 },
      { from: ["wound_mouth"], chance: 0.3, colors: BLOOD },
      {
        from: ["wound_eye_left", "wound_eye_right"],
        chance: 0.2,
        colors: BLOOD,
      },
      { from: ["wound_arm"], chance: 0.3, colors: BLOOD },
      { from: ["wound_brain"], chance: 0.1 },
    ],
    picture: {
      skin: "zombie_green",
      parts: ["heads_zombie"],
    },
  },
  {
    id: "skeleton",
    name: "Skeleton",
    group: "Monsters",
    heads: { male: ["heads_skeleton"], female: ["heads_skeleton"] },
    bodyItem: "body_skeleton",
    // Clean, old and radiated bone, as in pflat. These bones use cloth colors.
    skin: ["white", "#CBCAB0", "#8FA88A"],
    parts: [],
    picture: { skin: "white", parts: ["heads_skeleton"] },
  },
  {
    id: "frankenstein",
    name: "Frankenstein",
    group: "Monsters",
    heads: { male: ["heads_frankenstein"], female: ["heads_frankenstein"] },
    skin: ["zombie_green", "pale_green", "#92B08E", "light", "olive"],
    hair: ["black", "raven", "dark_gray"],
    eyes: ["yellow", "gray", "red"],
    parts: [
      {
        from: ["hair_plain", "hair_flat_top_straight", "hair_buzzcut"],
        chance: 0.7,
      },
    ],
    picture: { skin: "zombie_green", parts: ["heads_frankenstein"] },
  },
  {
    id: "demon",
    name: "Demon",
    group: "Monsters",
    heads: HUMAN_HEADS,
    skin: ["#CE6B5A", "#6C25A7", "#23AE71", "bright_green"],
    hair: ["black", "raven", "dark_gray", "red", "redhead", "white"],
    eyes: ["red", "yellow", "orange"],
    parts: [
      NEUTRAL_FACE,
      { from: { anyInSlot: "hair" }, chance: 0.8 },
      BEARD,
      { from: POINTED_EARS },
      {
        from: ["head_horns_curled", "head_horns_backwards"],
        chance: 0.85,
        colors: ["black", "brown", "bronze"],
      },
      {
        from: ["wings_bat"],
        chance: 0.5,
        colors: ["black", "fur_black", "red", "brown"],
      },
    ],
    picture: {
      skin: "#CE6B5A",
      hair: "black",
      parts: [
        "heads_human_male",
        "head_ears_elven",
        "hair_spiked",
        "head_horns_curled",
      ],
    },
  },
  {
    id: "goblin",
    name: "Goblin",
    group: "Monsters",
    heads: samePart("heads_goblin", "heads_goblin_child"),
    skin: [...GREEN_SKIN, "#939981"],
    parts: [],
    picture: { skin: "green", parts: ["heads_goblin"] },
  },
  {
    id: "orc",
    name: "Orc",
    group: "Monsters",
    heads: {
      male: ["heads_orc_male"],
      female: ["heads_orc_female"],
      child: ["heads_orc_child"],
    },
    skin: [...GREEN_SKIN, "#939981"],
    parts: [],
    picture: { skin: "dark_green", parts: ["heads_orc_male"] },
  },
  {
    id: "troll",
    name: "Troll",
    group: "Monsters",
    heads: samePart("heads_troll", "heads_troll_child"),
    skin: [...GREEN_SKIN, "#939981"],
    parts: [],
    picture: { skin: "pale_green", parts: ["heads_troll"] },
  },
  {
    id: "alien",
    name: "Alien",
    group: "Monsters",
    heads: samePart("heads_alien"),
    skin: [...GREEN_SKIN, "#939981"],
    parts: [],
    picture: { skin: "bright_green", parts: ["heads_alien"] },
  },
  beast(
    "wolf",
    "Wolf",
    {
      male: ["heads_wolf_male"],
      female: ["heads_wolf_female"],
      child: ["heads_wolf_child"],
    },
    ["fur_grey", ...FUR],
    [{ from: ["tail_wolf", "tail_wolf_fluffy"], follow: "skin" }],
    ["tail_wolf"],
  ),
  beast(
    "boarman",
    "Boarman",
    samePart("heads_boarman", "heads_boarman_child"),
    FUR,
  ),
  beast(
    "minotaur",
    "Minotaur",
    {
      male: ["heads_minotaur"],
      female: ["heads_minotaur_female"],
      child: ["heads_minotaur_child"],
    },
    ["fur_brown", ...FUR],
  ),
  beast("wartotaur", "Wartotaur", samePart("heads_wartotaur"), [
    "fur_brown",
    ...FUR,
  ]),
  beast("mouse", "Mouse", samePart("heads_mouse", "heads_mouse_child"), [
    "fur_grey",
    ...FUR,
  ]),
  beast("rat", "Rat", samePart("heads_rat", "heads_rat_child"), [
    "fur_tan",
    ...FUR,
  ]),
  beast("rabbit", "Rabbit", samePart("heads_rabbit", "heads_rabbit_child"), [
    "fur_white",
    ...FUR,
  ]),
  beast("pig", "Pig", samePart("heads_pig", "heads_pig_child"), [
    "light",
    "olive",
    "brown",
  ]),
  beast("sheep", "Sheep", samePart("heads_sheep", "heads_sheep_child"), [
    "fur_white",
    "fur_grey",
    "fur_black",
  ]),
  beast(
    "lizard",
    "Lizard",
    {
      male: ["heads_lizard_male"],
      female: ["heads_lizard_female"],
      child: ["heads_lizard_child"],
    },
    SCALES,
    [{ from: ["tail_lizard"], chance: 0.6 }],
    ["tail_lizard"],
  ),
  beast(
    "drake",
    "Drake",
    {
      male: ["heads_lizard_male"],
      female: ["heads_lizard_female"],
      child: ["heads_lizard_child"],
    },
    SCALES,
    [
      { from: ["tail_lizard"] },
      { from: ["wings_lizard", "wings_lizard_bat"], chance: 0.7 },
      {
        from: ["head_horns_curled", "head_horns_backwards"],
        follow: "skin",
      },
    ],
    ["head_horns_curled", "wings_lizard", "tail_lizard"],
  ),
];

/** The groups in the order the Presets panel lists them. */
export const RECIPE_GROUPS: readonly string[] = [
  "People",
  "Monsters",
  "Beasts",
];
