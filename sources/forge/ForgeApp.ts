// LPC Forge interface: character list, live preview, and part browser side by side.
import m from "mithril";
import { downloadFile } from "../canvas/download.ts";
import { applyTransparencyMaskToCanvas } from "../canvas/mask.ts";
import { canvas, ctx, renderCharacter } from "../canvas/renderer.ts";
import {
  getCustomAnimations,
  paintStillPreviewFrame,
  setPreviewAnimation,
  startPreviewAnimation,
  stepPreviewFrame,
  stopPreviewAnimation,
} from "../canvas/preview-animation.ts";
import { initPreviewCanvas } from "../canvas/preview-canvas.ts";
import { AdvancedTools } from "../components/advanced/AdvancedTools.ts";
import { FullSpritesheetPreview } from "../components/preview/FullSpritesheetPreview.ts";
import type { ApplicationModels } from "../models/application.ts";
import type { CatalogReader, ItemLite } from "../state/catalog.ts";
import { ANIMATIONS, BODY_TYPES, FRAME_SIZE } from "../state/constants.ts";
import {
  isItemAnimationCompatible,
  isItemLicenseCompatible,
} from "../state/filters.ts";
import {
  createHashStringFromParams,
  getHashParamsforSelections,
  setHash,
  syncSelectionsToHash,
} from "../state/hash.ts";
import {
  fixMissingRecolor,
  getMultiRecolors,
  getPaletteOptions,
} from "../state/palettes.ts";
import {
  resetAll,
  selectItem,
  type Selection,
  type Selections,
  type State,
} from "../state/state.ts";
import { capitalize } from "../utils/helpers.ts";
import { setZipSink } from "../utils/zip-helpers.ts";
import {
  canSetEyeColor,
  chipColor,
  defaultHairColor,
  getEyeColor,
  getHairColor,
  getSkinColor,
  materialForGroup,
  setEyeColor,
  setHairColor,
  setSkinColor,
  swatchGroupsFor,
  swatchGroupsForColorGroup,
  type ColorGroup,
  type SwatchGroup,
} from "./colors.ts";
import {
  customColorKey,
  customKeyToHex,
  isCustomColorKey,
} from "./custom-color.ts";
import { downloadZipBlob } from "../utils/zip-helpers.ts";
import {
  buildAnimationZip,
  planAnimationExport,
  DEFAULT_ANIMATION_EXPORT_OPTIONS,
  type AnimationExportOptions,
} from "./animation-export.ts";
import {
  addOnParents,
  hasParentWorn,
  isFittedToHead,
  isHumanShapedHead,
  isParentOf,
  partLabel,
  type WornPart,
} from "./part-rules.ts";
import {
  buildPartCategories,
  humanize,
  matchesPartSearch,
  type PartCategory,
  type PartSection,
} from "./parts-index.ts";
import {
  RECIPE_GROUPS,
  RECIPES,
  ROLLED_SLOTS,
  type Recipe,
} from "./recipes.ts";
import {
  colorKey,
  matchingVariant,
  recipeFitsBody,
  rollRecipe,
  type RollContext,
} from "./roll.ts";
import {
  mergeSavedLists,
  newSavedCharacter,
  readSavedList,
  savedListFromFile,
  savedListToFile,
  writeSavedList,
  type SavedCharacter,
} from "./saved.ts";
import { cropPortrait, Thumb, type PortraitPart } from "./thumbnails.ts";

const FORK_URL = "https://github.com/teppuM/lpc-forge";
const SOURCES = {
  universal: {
    label: "Universal LPC Spritesheet Character Generator",
    short: "Universal LPC",
    url: "https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator",
  },
  vitruvian: {
    label: "Vitruvian LPC Studio",
    short: "Vitruvian LPC Studio",
    url: "https://vitruvianstudio.github.io/",
  },
  pflat: {
    label: "pflat's LPC Character Generator",
    short: "pflat's Character Generator",
    url: "https://pflat.itch.io/lpc-character-generator",
  },
};

type Subject =
  | { readonly kind: "group"; readonly group: ColorGroup }
  | { readonly kind: "slot"; readonly key: string };

type Snapshot = { selections: Selections; bodyType: string; hash: string };

const LOCK_BODY = "body-type";
const lockForColor = (group: ColorGroup) => `color:${group}`;

type Ui = {
  panel: "parts" | "presets" | "saved";
  /** The preset Roll again uses; it stays until another is chosen. */
  recipe: string | null;
  /** Slots, plus the body and colors, that a roll leaves alone. */
  locks: Set<string>;
  saved: SavedCharacter[];
  saveName: string;
  /** Why the last save or file load did not work, for the Saved panel to say. */
  savedNote: string | null;
  /** The saved character whose Delete has been pressed once. */
  confirmingDelete: string | null;
  category: string;
  /** Narrows the category to one group of sections; null shows them all. */
  group: string | null;
  search: string;
  subject: Subject;
  tab: "character" | "colors" | "parts";
  drawer: "download" | "about" | "filters" | null;
  showUnfit: boolean;
  animationOptions: AnimationExportOptions;
  animationBusy: boolean;
  animationNote: string;
  hairFallback: string;
  remembered: Record<string, string>;
  hovered: string | null;
  playing: boolean;
  sending: boolean;
  tryOnTimer: number | null;
  undo: Snapshot[];
  redo: Snapshot[];
  lastHash: string;
  renderBusy: boolean;
  renderAgain: boolean;
  /** A character has reached the sheet at least once since the page opened. */
  drawnOnce: boolean;
  categories: PartCategory[] | null;
};

type Env = {
  catalog: CatalogReader;
  state: State;
  models: ApplicationModels;
  ui: Ui;
};

function lite(catalog: CatalogReader, itemId: string): ItemLite | null {
  return catalog.getItemLite(itemId).unwrapOr(null);
}

function slotLabel(key: string): string {
  return humanize(key);
}

function hairColorOf({ catalog, state, ui }: Env): string {
  return getHairColor(catalog, state, ui.hairFallback);
}

/** The color a part should arrive in, given the shared colors and its slot. */
function arrivalColor(env: Env, target: State, itemId: string): string {
  const { catalog, ui } = env;
  const meta = lite(catalog, itemId)!;
  const first = meta.recolors[0];
  let wanted: string | undefined;
  if (first.material === "hair") {
    wanted = hairColorOf(env);
  } else if (first.material === "eye") {
    wanted = getEyeColor(target);
  } else if (first.material === "body" && meta.matchBodyColor) {
    wanted = getSkinColor(catalog, target);
  } else {
    wanted =
      target.selections[meta.type_name]?.recolor ||
      ui.remembered[meta.type_name];
  }
  const valid = wanted
    ? fixMissingRecolor(catalog, itemId, wanted).unwrapOr(null)
    : null;
  return valid ?? first.variants?.[0] ?? "";
}

/** Puts a part in its slot on `target`, replacing whatever the slot held. */
function equip(env: Env, target: State, itemId: string): void {
  const meta = lite(env.catalog, itemId);
  if (!meta) return;
  const current = target.selections[meta.type_name];
  if (meta.variants.length > 0) {
    const variant =
      current?.variant && meta.variants.includes(current.variant)
        ? current.variant
        : firstVariant(meta);
    selectItem(target, itemId, variant);
  } else if (meta.recolors.length > 0) {
    selectItem(target, itemId, arrivalColor(env, target, itemId));
  } else {
    target.selections[meta.type_name] = { itemId, name: meta.name };
  }
}

/**
 * The version a part arrives in. A "base" entry is often just the uncolored
 * template with no sheet of its own, so a named color is the safer default.
 */
function firstVariant(meta: ItemLite): string {
  return (
    meta.variants.find((variant) => variant !== "base") ?? meta.variants[0]
  );
}

function removeSlot(env: Env, key: string): void {
  const { state, ui } = env;
  const itemId = state.selections[key]?.itemId;
  delete state.selections[key];
  ui.locks.delete(key);
  for (const [otherKey, other] of Object.entries(state.selections)) {
    if (other.itemId === itemId && other.subId && otherKey !== "eyes") {
      delete state.selections[otherKey];
    }
  }
  if (ui.subject.kind === "slot" && ui.subject.key === key) {
    ui.subject = { kind: "group", group: "skin" };
  }
  dropOrphanAddOns(env);
}

function wornParts({ catalog, state }: Env): WornPart[] {
  return Object.values(state.selections).flatMap((selection) => {
    const path = lite(catalog, selection.itemId)?.path;
    return path ? [{ itemId: selection.itemId, path }] : [];
  });
}

/** An add-on whose part has just gone goes with it. */
function dropOrphanAddOns(env: Env): void {
  const { state, ui } = env;
  const worn = wornParts(env);
  for (const [key, selection] of Object.entries(state.selections)) {
    if (hasParentWorn(selection.itemId, worn)) continue;
    delete state.selections[key];
    ui.locks.delete(key);
    if (ui.subject.kind === "slot" && ui.subject.key === key) {
      ui.subject = { kind: "group", group: "skin" };
    }
  }
}

/** Head parts are drawn for human-shaped heads. With no head, nothing is at odds. */
function fitsWornHead({ state }: Env, meta: ItemLite): boolean {
  const head = state.selections.head?.itemId;
  return !head || isHumanShapedHead(head) || !isFittedToHead(meta.path);
}

/** How many add-ons go on this worn part. */
function addOnCount(env: Env, part: WornPart): number {
  return (env.ui.categories ?? [])
    .flatMap((category) => category.sections)
    .flatMap((section) => section.itemIds)
    .filter((itemId) => isParentOf(itemId, part)).length;
}

function isWorn(state: State, meta: ItemLite, itemId: string): boolean {
  return state.selections[meta.type_name]?.itemId === itemId;
}

/** Colors a thumbnail should show: what wearing the part right now would give. */
function thumbRecolors(
  env: Env,
  itemId: string,
  meta: ItemLite,
): Record<string, string> | null {
  const { catalog, state } = env;
  if (meta.recolors.length === 0) return null;
  const recolors =
    getMultiRecolors(catalog, itemId, state.selections, true) ?? {};
  if (!recolors[meta.type_name]) {
    const color = arrivalColor(env, state, itemId);
    if (color) recolors[meta.type_name] = color;
  }
  return Object.keys(recolors).length > 0 ? recolors : null;
}

function thumbVariant(state: State, itemId: string, meta: ItemLite) {
  if (meta.variants.length === 0) return null;
  const current = state.selections[meta.type_name];
  if (current?.itemId === itemId && current.variant) return current.variant;
  if (current?.variant && meta.variants.includes(current.variant)) {
    return current.variant;
  }
  return firstVariant(meta);
}

function partThumb(env: Env, itemId: string, meta: ItemLite) {
  return m(Thumb, {
    catalog: env.catalog,
    state: env.state,
    itemId,
    variant: thumbVariant(env.state, itemId, meta),
    recolors: thumbRecolors(env, itemId, meta),
  });
}

/** Keeps at most one render queued, so dragging a color picker stays responsive. */
function requestRender(env: Env, selections: () => Selections): void {
  const { catalog, state, ui } = env;
  if (ui.renderBusy) {
    ui.renderAgain = true;
    return;
  }
  ui.renderBusy = true;
  const drawn = selections();
  void renderCharacter(catalog, state, drawn, state.bodyType)
    .then(() => {
      eraseCutOuts(env, drawn);
      if (Object.keys(drawn).length > 0) ui.drawnOnce = true;
    })
    .finally(() => {
      ui.renderBusy = false;
      if (ui.renderAgain) {
        ui.renderAgain = false;
        requestRender(env, () => currentPreviewSelections(env));
      }
      m.redraw();
    });
}

/**
 * Parts such as a peg leg paint magenta over what they replace. Erasing it on the
 * drawn sheet means the preview and every download built from that sheet agree.
 */
function eraseCutOuts(env: Env, drawn: Selections): void {
  const { catalog, state } = env;
  const hasCutOut = Object.values(drawn).some((selection) => {
    const meta = catalog.getItemMerged(selection.itemId).unwrapOr(null);
    return (
      meta !== null &&
      Object.values(meta.layers).some(
        (layer) => (layer as { is_mask?: boolean }).is_mask === true,
      )
    );
  });
  if (!hasCutOut || !canvas || !ctx) return;
  applyTransparencyMaskToCanvas(canvas, ctx);
  paintStillPreviewFrame(state);
}

/** What the preview should show: the character, plus the part under the pointer. */
function currentPreviewSelections(env: Env): Selections {
  const { state, ui } = env;
  if (!ui.hovered) return state.selections;
  const trial = {
    ...state,
    selections: JSON.parse(JSON.stringify(state.selections)) as Selections,
  } as State;
  equip(env, trial, ui.hovered);
  return trial.selections;
}

function hoverPart(env: Env, itemId: string | null): void {
  const { ui } = env;
  ui.hovered = itemId;
  if (ui.tryOnTimer !== null) clearTimeout(ui.tryOnTimer);
  ui.tryOnTimer = window.setTimeout(() => {
    ui.tryOnTimer = null;
    requestRender(env, () => currentPreviewSelections(env));
  }, 120);
}

function hashOf({ catalog, state }: Env): string {
  return createHashStringFromParams(
    getHashParamsforSelections(catalog, state.selections, state.bodyType),
  );
}

function restore(env: Env, from: Snapshot[], to: Snapshot[]): void {
  const { state, ui } = env;
  const snapshot = from.pop();
  if (!snapshot) return;
  to.push({
    selections: state.selections,
    bodyType: state.bodyType,
    hash: ui.lastHash,
  });
  state.selections = JSON.parse(
    JSON.stringify(snapshot.selections),
  ) as Selections;
  state.bodyType = snapshot.bodyType;
  ui.lastHash = snapshot.hash;
  syncSelectionsToHash(env.catalog, state);
  requestRender(env, () => currentPreviewSelections(env));
}

function swatchTiles(
  groups: readonly SwatchGroup[],
  activeKey: string | null,
  pick: (key: string) => void,
) {
  return groups.map((group) =>
    m("div.forge-swatch-group", { key: group.key }, [
      group.label ? m("h4.forge-mini-heading", group.label) : null,
      m(
        "div.forge-swatches",
        group.tiles.map((tile) =>
          m(
            "button.forge-swatch",
            {
              key: tile.key,
              class: tile.key === activeKey ? "is-on" : "",
              title: tile.label,
              "aria-label": tile.label,
              onclick: () => pick(tile.key),
            },
            tile.colors.map((color) =>
              m("span", { style: { background: color } }),
            ),
          ),
        ),
      ),
    ]),
  );
}

function customPicker(
  catalog: CatalogReader,
  material: string,
  activeKey: string | null,
  pick: (key: string) => void,
) {
  const value =
    activeKey && isCustomColorKey(activeKey)
      ? customKeyToHex(activeKey)
      : activeKey
        ? chipColor(catalog, material, activeKey)
        : "#888888";
  return m("label.forge-custom", [
    m("input[type=color]", {
      value: /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : "#888888",
      oninput: (e: Event) =>
        pick(customColorKey((e.target as HTMLInputElement).value)),
    }),
    m("span", "Any color"),
    activeKey && isCustomColorKey(activeKey)
      ? m("code", customKeyToHex(activeKey).toUpperCase())
      : null,
  ]);
}

const GROUP_NOTES: Record<ColorGroup, string> = {
  skin: "Body, head, ears, nose and other skin parts all follow this.",
  hair: "Hair, beards, eyebrows and other hair parts follow this. Give any one of them its own color from its row on the left, and it stops following.",
  eyes: "Every eye on the character uses this.",
};

function groupEditor(env: Env, group: ColorGroup) {
  const { catalog, state, ui } = env;
  const hair = hairColorOf(env);
  const active =
    group === "skin"
      ? getSkinColor(catalog, state)
      : group === "hair"
        ? hair
        : getEyeColor(state);
  const pick = (key: string) => {
    if (group === "skin") setSkinColor(state, key);
    else if (group === "hair") {
      setHairColor(catalog, state, hair, key);
      ui.hairFallback = key;
    } else setEyeColor(catalog, state, key);
  };
  const eyesBlocked = group === "eyes" && !canSetEyeColor(catalog, state);
  return [
    m("h3.forge-heading", `${capitalize(group)} color`),
    m(
      "p.forge-note",
      eyesBlocked
        ? "This character's head has no separate eye color. Human heads do, and so do the Cyclops eyes under Head."
        : GROUP_NOTES[group],
    ),
    eyesBlocked
      ? null
      : [
          customPicker(catalog, materialForGroup(group), active, pick),
          swatchTiles(
            swatchGroupsForColorGroup(catalog, state, group),
            active,
            pick,
          ),
        ],
  ];
}

function slotEditor(env: Env, key: string) {
  const { catalog, state, ui } = env;
  const selection = state.selections[key];
  const meta = selection && lite(catalog, selection.itemId);
  if (!selection || !meta) return groupEditor(env, "skin");
  const itemId = selection.itemId;
  const [options, selectedColors] =
    meta.recolors.length > 0
      ? getPaletteOptions(catalog, state, itemId, meta)
      : [[], {} as Record<string, string>];
  const hair = hairColorOf(env);

  return [
    m("h3.forge-heading", [
      meta.name,
      m("span.forge-heading-slot", ` ${slotLabel(key)} slot`),
    ]),
    meta.variants.length > 0
      ? [
          m("h4.forge-mini-heading", "Versions"),
          m(
            "div.forge-variants",
            meta.variants.map((variant) =>
              m(
                "button.forge-variant",
                {
                  key: variant,
                  class: selection.variant === variant ? "is-on" : "",
                  title: capitalize(variant.replaceAll("_", " ")),
                  onclick: () => selectItem(state, itemId, variant),
                },
                [
                  m(Thumb, {
                    catalog,
                    state,
                    itemId,
                    variant,
                    recolors: null,
                  }),
                  m("span", capitalize(variant.replaceAll("_", " "))),
                ],
              ),
            ),
          ),
        ]
      : null,
    meta.recolors.length === 0 && meta.variants.length === 0
      ? m("p.forge-note", "This part has one fixed color.")
      : null,
    options.map((option, index) => {
      const group = index === 0 ? meta.type_name : (option.type_name ?? "");
      const active = selectedColors[group] ?? null;
      const isHair = option.material === "hair" && index === 0;
      const followsSkin =
        index === 0 && option.material === "body" && meta.matchBodyColor;
      const pick = (color: string) => {
        if (key === "hair" && index === 0) {
          setHairColor(catalog, state, hair, color);
          ui.hairFallback = color;
          return;
        }
        ui.remembered[meta.type_name] = color;
        selectItem(
          state,
          itemId,
          color,
          false,
          option.type_name ? index : null,
        );
      };
      return m("div.forge-option", { key: index }, [
        option.label ? m("h4.forge-mini-heading", option.label) : null,
        followsSkin
          ? m("p.forge-note", [
              "Follows the shared Skin color. ",
              m(
                "button.forge-link",
                {
                  onclick: () => {
                    ui.subject = { kind: "group", group: "skin" };
                  },
                },
                "Change Skin",
              ),
            ])
          : [
              isHair && key !== "hair"
                ? m("p.forge-note", [
                    active === hair
                      ? "Following the shared Hair color. Pick a color below to give it its own."
                      : "Has its own color. ",
                    active === hair
                      ? null
                      : m(
                          "button.forge-link",
                          { onclick: () => pick(hair) },
                          "Match Hair again",
                        ),
                  ])
                : null,
              customPicker(catalog, option.material, active, pick),
              swatchTiles(
                swatchGroupsFor(catalog, itemId, option),
                active,
                pick,
              ),
            ],
      ]);
    }),
  ];
}

const DEFAULT_HEADS: Record<string, string> = {
  child: "heads_human_child",
  female: "heads_human_female",
  pregnant: "heads_human_female",
};

/** Changes body type, swapping a head that isn't drawn for the new body. */
function changeBody(env: Env, type: string): void {
  const { catalog, state } = env;
  state.bodyType = type;
  const head = state.selections.head;
  const headMeta = head && lite(catalog, head.itemId);
  if (headMeta && !headMeta.required.includes(type)) {
    equip(env, state, DEFAULT_HEADS[type] ?? "heads_human_male");
  }
  const expression = state.selections.expression;
  const expressionMeta = expression && lite(catalog, expression.itemId);
  if (expressionMeta && !expressionMeta.required.includes(type)) {
    delete state.selections.expression;
  }
}

/** Whether a part can be used right now, on a body, under the viewer's filters. */
function isUsable(env: Env, itemId: string, body: string): boolean {
  const { catalog, state } = env;
  const meta = lite(catalog, itemId);
  return (
    !!meta &&
    meta.required.includes(body) &&
    isItemLicenseCompatible(catalog, state, itemId) &&
    isItemAnimationCompatible(catalog, state, itemId)
  );
}

function rollContext(env: Env): RollContext {
  const { catalog, state, ui } = env;
  const indexes = catalog.getMetadataIndexes().unwrapOr(null);
  return {
    currentBody: state.bodyType,
    bodyLocked: ui.locks.has(LOCK_BODY),
    colorLocked: (group) => ui.locks.has(lockForColor(group)),
    slotLocked: (slot) => ui.locks.has(slot),
    usable: (itemId, body) => isUsable(env, itemId, body),
    anyInSlot: (slot, body) =>
      (indexes?.byTypeName[slot] ?? [])
        .map((row) => row.itemId)
        .filter(
          (itemId) =>
            isUsable(env, itemId, body) &&
            lite(catalog, itemId)?.animations.includes("run"),
        ),
    slotOf: (itemId) => lite(catalog, itemId)?.type_name ?? null,
    variantsOf: (itemId) => lite(catalog, itemId)?.variants ?? [],
    keptParts: Object.entries(state.selections)
      .filter(
        ([key, selection]) =>
          !selection.subId &&
          key !== "body" &&
          (!ROLLED_SLOTS.includes(key) || ui.locks.has(key)),
      )
      .map(([, selection]) => selection.itemId),
  };
}

/** Rolls a new character from a recipe, leaving locked things and clothes alone. */
function applyRecipe(env: Env, recipe: Recipe): void {
  const { catalog, state, ui } = env;
  const plan = rollRecipe(recipe, rollContext(env));
  const keptSkin = getSkinColor(catalog, state);
  const keptHair = hairColorOf(env);
  const keptEyes = getEyeColor(state);

  state.bodyType = plan.bodyType;
  for (const key of Object.keys(state.selections)) {
    if (ROLLED_SLOTS.includes(key) && !ui.locks.has(key)) {
      delete state.selections[key];
    }
  }
  delete state.selections.body;

  const skin = plan.skin ?? (recipe.skin ? keptSkin : null);
  const validSkin =
    skin && fixMissingRecolor(catalog, plan.bodyItem, skin).unwrapOr(null);
  if (validSkin) selectItem(state, plan.bodyItem, validSkin);
  else equip(env, state, plan.bodyItem);

  ui.hairFallback = plan.hair ?? keptHair;
  for (const { itemId, color } of plan.parts) {
    // Expressions are only drawn for human heads, which a locked head may not be.
    if (
      lite(catalog, itemId)?.type_name === "expression" &&
      !state.selections.head?.itemId.startsWith("heads_human")
    ) {
      continue;
    }
    equip(env, state, itemId);
    const meta = lite(catalog, itemId);
    // A few heads, such as the zombie's and skeleton's, do not follow the body.
    if (meta?.type_name === "head" && validSkin) {
      const valid = fixMissingRecolor(catalog, itemId, validSkin).unwrapOr(
        null,
      );
      if (valid) selectItem(state, itemId, valid);
    }
    if (!color) continue;
    if (meta && meta.variants.length > 0) {
      selectItem(state, itemId, color);
    } else {
      const valid = fixMissingRecolor(catalog, itemId, color).unwrapOr(null);
      if (valid) selectItem(state, itemId, valid);
    }
  }

  const eyes =
    plan.eyes ?? (ui.locks.has(lockForColor("eyes")) ? keptEyes : null);
  if (eyes && canSetEyeColor(catalog, state)) {
    setEyeColor(catalog, state, eyes);
  }

  ui.recipe = recipe.id;
  ui.subject = { kind: "group", group: "skin" };
}

function lockButton(env: Env, key: string, label: string) {
  const { ui } = env;
  const locked = ui.locks.has(key);
  const help = locked
    ? `${label} stays when rolling a preset. Click to let it roll.`
    : `Keep ${label} when rolling a preset.`;
  return m(
    "button.forge-lock",
    {
      class: locked ? "is-on" : "",
      title: help,
      "aria-label": help,
      "aria-pressed": String(locked),
      onclick: () => {
        if (locked) ui.locks.delete(key);
        else ui.locks.add(key);
      },
    },
    locked ? "\u{1F512}" : "\u{1F513}",
  );
}

function characterPanel(env: Env) {
  const { catalog, state, ui } = env;
  const order = new Map<string, number>();
  (ui.categories ?? []).forEach((category, c) =>
    mainSlotFirst(catalog, category).forEach((section, s) =>
      section.itemIds.forEach((id, i) => {
        order.set(id, c * 1_000_000 + s * 1_000 + i);
      }),
    ),
  );
  const slots = Object.entries(state.selections)
    .filter(([, selection]) => !selection.subId)
    .sort(
      ([, a], [, b]) => (order.get(a.itemId) ?? 0) - (order.get(b.itemId) ?? 0),
    );

  const groupChip = (group: ColorGroup, color: string) =>
    m("div.forge-group-cell", { key: group }, [
      m(
        "button.forge-group-chip",
        {
          class:
            ui.subject.kind === "group" && ui.subject.group === group
              ? "is-on"
              : "",
          onclick: () => {
            ui.subject = { kind: "group", group };
            ui.tab = "colors";
          },
        },
        [
          m("span.forge-chip", {
            style: {
              background: chipColor(catalog, materialForGroup(group), color),
            },
          }),
          capitalize(group),
        ],
      ),
      lockButton(env, lockForColor(group), `${capitalize(group)} color`),
    ]);

  return m("section.forge-character", [
    m("h2.forge-panel-title.forge-title-row", [
      "Body",
      lockButton(env, LOCK_BODY, "This body"),
    ]),
    m(
      "div.forge-pills",
      BODY_TYPES.map((type) =>
        m(
          "button.forge-pill",
          {
            key: type,
            class: state.bodyType === type ? "is-on" : "",
            onclick: () => changeBody(env, type),
          },
          capitalize(type),
        ),
      ),
    ),
    m("h2.forge-panel-title", "Colors"),
    m("div.forge-group-chips", [
      groupChip("skin", getSkinColor(catalog, state)),
      groupChip("hair", hairColorOf(env)),
      groupChip("eyes", getEyeColor(state)),
    ]),
    m("h2.forge-panel-title", [
      "Wearing ",
      m("span.forge-count", String(slots.length)),
    ]),
    slots.length === 0
      ? m("p.forge-note", "Nothing yet. Pick parts from the browser.")
      : m(
          "ul.forge-slots",
          slots.map(([key, selection]) => slotRow(env, key, selection)),
        ),
  ]);
}

function slotRow(env: Env, key: string, selection: Selection) {
  const { catalog, state, ui } = env;
  const meta = lite(catalog, selection.itemId);
  if (!meta) return null;
  const fits = meta.required.includes(state.bodyType);
  const fitsHead = fitsWornHead(env, meta);
  const addOns = addOnCount(env, {
    itemId: selection.itemId,
    path: meta.path,
  });
  const isActive = ui.subject.kind === "slot" && ui.subject.key === key;
  const material = meta.recolors[0]?.material;
  const color = selection.recolor;
  return m(
    "li.forge-slot",
    {
      key,
      class: `${isActive ? "is-on" : ""} ${fits && fitsHead ? "" : "is-unfit"}`,
    },
    [
      m(
        "button.forge-slot-main",
        {
          title: `Edit ${meta.name}`,
          onclick: () => {
            ui.subject = { kind: "slot", key };
            ui.tab = "colors";
          },
        },
        [
          partThumb(env, selection.itemId, meta),
          m("span.forge-slot-text", [
            m("strong", partLabel(meta.name)),
            m(
              "small",
              !fits
                ? `${slotLabel(key)}: not drawn for this body`
                : !fitsHead
                  ? `${slotLabel(key)}: may not line up with this head`
                  : addOns > 0
                    ? `${slotLabel(key)}: ${addOns} add-on${addOns === 1 ? "" : "s"} in the parts list`
                    : slotLabel(key),
            ),
          ]),
          material && color
            ? m("span.forge-chip", {
                style: { background: chipColor(catalog, material, color) },
              })
            : null,
        ],
      ),
      ROLLED_SLOTS.includes(key) ? lockButton(env, key, meta.name) : null,
      m(
        "button.forge-remove",
        {
          title: `Remove ${meta.name}`,
          "aria-label": `Remove ${meta.name}`,
          onclick: () => removeSlot(env, key),
        },
        "×",
      ),
    ],
  );
}

/** Holds still unless the viewer has pressed Play; nothing moves on its own. */
const PreviewCanvas: m.Component<
  { state: State; animation: string; playing: boolean },
  { last: string; wasPlaying: boolean }
> = {
  oncreate(vnode) {
    const { state, animation, playing } = vnode.attrs;
    initPreviewCanvas(vnode.dom as HTMLCanvasElement);
    setPreviewAnimation(animation);
    if (playing) startPreviewAnimation(state);
    else paintStillPreviewFrame(state);
    vnode.state.last = animation;
    vnode.state.wasPlaying = playing;
  },
  onupdate(vnode) {
    const { state, animation, playing } = vnode.attrs;
    const animationChanged = vnode.state.last !== animation;
    if (animationChanged || vnode.state.wasPlaying !== playing) {
      stopPreviewAnimation();
      if (animationChanged) setPreviewAnimation(animation);
      initPreviewCanvas(vnode.dom as HTMLCanvasElement);
      if (playing) startPreviewAnimation(state);
      vnode.state.last = animation;
      vnode.state.wasPlaying = playing;
    }
    if (!playing) paintStillPreviewFrame(state);
  },
  onremove() {
    stopPreviewAnimation();
  },
  view(vnode) {
    const custom = getCustomAnimations()?.[vnode.attrs.animation];
    const size = custom?.frameSize ?? FRAME_SIZE;
    return m("canvas#previewAnimations.forge-preview-canvas", {
      width: 4 * size,
      height: size,
    });
  },
};

function previewPanel(env: Env) {
  const { catalog, state, ui } = env;
  const custom = Object.keys(getCustomAnimations() ?? {});
  const animations = [
    ...ANIMATIONS.map((a) => ({ value: a.value, label: a.label })),
    ...custom.map((value) => ({ value, label: humanize(value) })),
  ];
  if (!animations.some((a) => a.value === state.selectedAnimation)) {
    state.selectedAnimation = "walk";
  }
  const selected = state.selectedAnimation;
  const activeRecipe = RECIPES.find((recipe) => recipe.id === ui.recipe);
  const missing = Object.values(state.selections)
    .filter((selection) => !selection.subId)
    .map((selection) => lite(catalog, selection.itemId))
    .filter(
      (meta): meta is ItemLite =>
        !!meta &&
        meta.animations.length > 0 &&
        ANIMATIONS.some((a) => a.value === selected) &&
        !meta.animations.includes(selected),
    )
    .map((meta) => meta.name);

  return m("section.forge-preview", [
    m(
      "div.forge-stage",
      m(PreviewCanvas, { state, animation: selected, playing: ui.playing }),
    ),
    m("div.forge-playback", [
      m(
        "button.forge-pill.forge-play",
        {
          class: ui.playing ? "" : "is-primary",
          onclick: () => {
            ui.playing = !ui.playing;
          },
        },
        ui.playing ? "\u25A0 Stop animation" : "\u25B6 Play animation",
      ),
      ui.playing
        ? null
        : [
            m(
              "button.forge-pill",
              { onclick: () => stepPreviewFrame(state, -1) },
              "Previous frame",
            ),
            m(
              "button.forge-pill",
              { onclick: () => stepPreviewFrame(state, 1) },
              "Next frame",
            ),
          ],
    ]),
    activeRecipe
      ? m("div.forge-roll", [
          m(
            "button.forge-pill.is-primary",
            { onclick: () => applyRecipe(env, activeRecipe) },
            `Roll another ${activeRecipe.name}`,
          ),
          m(
            "span.forge-roll-note",
            "Press the lock beside any part or color to keep it. Clothes never change.",
          ),
        ])
      : null,
    m(
      "div.forge-anim-pills",
      animations.map((animation) =>
        m(
          "button.forge-pill",
          {
            key: animation.value,
            class: selected === animation.value ? "is-on" : "",
            onclick: () => {
              state.selectedAnimation = animation.value;
            },
          },
          animation.label,
        ),
      ),
    ),
    missing.length > 0
      ? m(
          "p.forge-warning",
          `Not drawn for this animation, so missing from it: ${missing.join(", ")}.`,
        )
      : null,
    ui.hovered
      ? m(
          "p.forge-trying",
          `Trying on ${lite(catalog, ui.hovered)?.name ?? ""}. Click to keep it.`,
        )
      : null,
  ]);
}

function colorsPanel(env: Env) {
  const { ui } = env;
  return m(
    "section.forge-editor",
    ui.subject.kind === "group"
      ? groupEditor(env, ui.subject.group)
      : slotEditor(env, ui.subject.key),
  );
}

/** Puts the sections for a category's own slot first: hairstyles before beards. */
function mainSlotFirst(
  catalog: CatalogReader,
  category: PartCategory,
): readonly PartSection[] {
  const isMain = (section: PartSection) =>
    section.itemIds.some((id) => lite(catalog, id)?.type_name === category.key);
  return [
    ...category.sections.filter(isMain),
    ...category.sections.filter((section) => !isMain(section)),
  ];
}

/** The group a section belongs to: the first level of its path. */
function sectionGroup(category: PartCategory, section: PartSection): string {
  return section.label.split(" / ")[0] || category.label;
}

function partGroups(catalog: CatalogReader, category: PartCategory): string[] {
  return [
    ...new Set(
      mainSlotFirst(catalog, category).map((section) =>
        sectionGroup(category, section),
      ),
    ),
  ];
}

function partsPanel(env: Env) {
  const { catalog, state, ui } = env;
  const categories = ui.categories ?? [];
  const query = ui.search.trim();
  const shown = query
    ? categories
    : categories.filter((category) => category.key === ui.category);

  const wornNow = wornParts(env);
  let hiddenByHead = 0;
  const announcedSlots = new Set<string>();
  const sectionViews = shown.flatMap((category) =>
    mainSlotFirst(catalog, category).flatMap((section) => {
      if (
        !query &&
        ui.group !== null &&
        sectionGroup(category, section) !== ui.group
      ) {
        return [];
      }
      const parts = section.itemIds
        .map((itemId) => ({ itemId, meta: lite(catalog, itemId) }))
        .filter(
          (p): p is { itemId: string; meta: ItemLite } =>
            !!p.meta &&
            isItemLicenseCompatible(catalog, state, p.itemId) &&
            isItemAnimationCompatible(catalog, state, p.itemId) &&
            (ui.showUnfit || p.meta.required.includes(state.bodyType)) &&
            (ui.showUnfit ||
              query !== "" ||
              hasParentWorn(p.itemId, wornNow)) &&
            matchesPartSearch(query, [
              p.meta.name,
              p.meta.type_name,
              section.label,
              category.label,
            ]),
        )
        .filter((p) => {
          if (ui.showUnfit || fitsWornHead(env, p.meta)) return true;
          hiddenByHead++;
          return false;
        });
      if (parts.length === 0) return [];

      const slots = [...new Set(parts.map((p) => p.meta.type_name))];
      const oneSlot = slots.length === 1 ? slots[0] : null;
      const wornSelection = oneSlot ? state.selections[oneSlot] : null;
      const worn = wornSelection && lite(catalog, wornSelection.itemId);
      const announce = oneSlot !== null && !announcedSlots.has(oneSlot);
      if (oneSlot) announcedSlots.add(oneSlot);
      const title = query
        ? [category.label, section.label].filter(Boolean).join(" / ")
        : section.label;
      return [
        m(
          "div.forge-section",
          {
            key: `${category.key}/${section.key}`,
            "data-anchor": `${category.key}/${section.key}`,
          },
          [
            m("div.forge-section-head", [
              title ? m("h3.forge-heading", title) : null,
              oneSlot && announce
                ? m(
                    "span.forge-slot-rule",
                    worn
                      ? [
                          "One at a time. Wearing ",
                          m("strong", worn.name),
                          " ",
                          m(
                            "button.forge-link",
                            { onclick: () => removeSlot(env, oneSlot) },
                            "Remove",
                          ),
                        ]
                      : "One at a time",
                  )
                : null,
            ]),
            m(
              "div.forge-grid",
              parts.map(({ itemId, meta }) =>
                partTile(env, itemId, meta, oneSlot === null),
              ),
            ),
          ],
        ),
      ];
    }),
  );

  const groups = shown[0] ? partGroups(catalog, shown[0]) : [];

  return m("section.forge-parts", [
    m("div.forge-parts-top", [
      m("input.forge-search[type=search]", {
        placeholder: "Search every part",
        "aria-label": "Search every part",
        value: ui.search,
        oninput: (e: Event) => {
          ui.search = (e.target as HTMLInputElement).value;
        },
      }),
      m(
        "button.forge-pill",
        {
          onclick: () => {
            ui.drawer = "filters";
          },
        },
        "Filters",
      ),
    ]),
    query
      ? null
      : m(
          "div.forge-pills.forge-categories",
          categories.map((category) =>
            m(
              "button.forge-pill",
              {
                key: category.key,
                class: ui.category === category.key ? "is-on" : "",
                onclick: () => {
                  ui.category = category.key;
                  ui.group = null;
                },
              },
              category.label,
            ),
          ),
        ),
    !query && groups.length > 1
      ? m("div.forge-pills.forge-groups", [
          m(
            "button.forge-pill",
            {
              key: "__all",
              class: ui.group === null ? "is-on" : "",
              onclick: () => {
                ui.group = null;
              },
            },
            "All",
          ),
          ...groups.map((group) =>
            m(
              "button.forge-pill",
              {
                key: group,
                class: ui.group === group ? "is-on" : "",
                onclick: () => {
                  ui.group = group;
                },
              },
              group,
            ),
          ),
        ])
      : null,
    m(
      "div.forge-parts-scroll",
      sectionViews.length > 0
        ? sectionViews
        : m(
            "p.forge-note",
            query
              ? hiddenByHead > 0
                ? `The parts matching "${query}" are drawn for human-shaped heads, so they would not line up with this one. Filters can show them anyway.`
                : `No parts match "${query}" on this body. Try another word, or show parts for other bodies under Filters.`
              : !catalog.isLiteReady()
                ? "Loading parts…"
                : hiddenByHead > 0
                  ? "These parts are drawn for human-shaped heads, so they would not line up with this one. Filters can show them anyway."
                  : "No parts here for this body.",
          ),
    ),
  ]);
}

/** The parts a preset's picture shows, colored as the recipe describes. */
function recipePortrait(env: Env, recipe: Recipe): PortraitPart[] {
  const { catalog } = env;
  const { picture } = recipe;
  const skin = picture.skin ? colorKey(picture.skin, () => 0) : null;
  const hair = picture.hair ? colorKey(picture.hair, () => 0) : null;
  const parts: PortraitPart[] = [];
  for (const itemId of [recipe.bodyItem ?? "body", ...picture.parts]) {
    const meta = lite(catalog, itemId);
    if (!meta) continue;
    if (meta.variants.length > 0) {
      const variant =
        (hair && matchingVariant(meta.variants, hair)) ||
        (skin && matchingVariant(meta.variants, skin)) ||
        firstVariant(meta);
      parts.push({ itemId, variant, recolors: null });
      continue;
    }
    const material = meta.recolors[0]?.material;
    const color =
      material === "hair"
        ? hair
        : material === "body" || recipe.bodyItem
          ? skin
          : null;
    parts.push({
      itemId,
      variant: null,
      recolors: color ? { [meta.type_name]: color } : null,
    });
  }
  return parts;
}

function presetsPanel(env: Env) {
  const { state, ui } = env;
  const shown = (recipe: Recipe) =>
    !ui.locks.has(LOCK_BODY) ||
    recipeFitsBody(recipe, state.bodyType, (itemId, body) =>
      isUsable(env, itemId, body),
    );
  const hidden = RECIPES.filter((recipe) => !shown(recipe)).length;
  return m("section.forge-parts", [
    m("div.forge-parts-scroll", [
      m(
        "p.forge-note",
        "A preset rolls a new character each time: its body, skin, hair and features. Clothes stay as they are. Press Roll another under the preview to go again, and Undo to go back. Rolls land on Male, Female or Teen; lock Body to roll on another.",
      ),
      RECIPE_GROUPS.map((group) =>
        m("div.forge-section", { key: group }, [
          m("div.forge-section-head", m("h3.forge-heading", group)),
          m(
            "div.forge-grid",
            RECIPES.filter(
              (recipe) => recipe.group === group && shown(recipe),
            ).map((recipe) =>
              m(
                "button.forge-tile",
                {
                  key: recipe.id,
                  "data-recipe": recipe.id,
                  class: ui.recipe === recipe.id ? "is-on" : "",
                  title: `Roll a ${recipe.name}`,
                  onclick: () => applyRecipe(env, recipe),
                },
                [
                  m(Thumb, {
                    catalog: env.catalog,
                    state,
                    itemId: `recipe:${recipe.id}`,
                    variant: null,
                    recolors: null,
                    portrait: recipePortrait(env, recipe),
                  }),
                  m("span.forge-tile-name", recipe.name),
                ],
              ),
            ),
          ),
        ]),
      ),
      hidden > 0
        ? m(
            "p.forge-note",
            `${hidden} more cannot be made on this body. Unlock Body on the left to see them.`,
          )
        : null,
    ]),
  ]);
}

/** The character facing the viewer, from the finished sheet, for the saved list. */
function characterPicture(): string {
  if (!canvas || canvas.height < 11 * FRAME_SIZE) return "";
  const walkingTowardViewer = 10 * FRAME_SIZE;
  return cropPortrait(canvas, 0, walkingTowardViewer).toDataURL("image/png");
}

function storeSaved(env: Env, list: SavedCharacter[]): void {
  const { ui } = env;
  ui.saved = list;
  ui.savedNote = writeSavedList(list)
    ? null
    : "This browser would not keep the list, so it will be gone when the page closes. Private windows do this.";
}

async function saveCharacter(env: Env, over?: SavedCharacter): Promise<void> {
  const { ui } = env;
  while (ui.renderBusy) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const hash = hashOf(env);
  const picture = characterPicture();
  if (over) {
    storeSaved(
      env,
      ui.saved.map((entry) =>
        entry.id === over.id
          ? { ...entry, hash, picture, savedAt: new Date().toISOString() }
          : entry,
      ),
    );
  } else {
    const name = ui.saveName.trim() || `Character ${ui.saved.length + 1}`;
    storeSaved(env, [newSavedCharacter(name, hash, picture), ...ui.saved]);
    ui.saveName = "";
  }
  m.redraw();
}

async function loadSavedFile(env: Env, file: File): Promise<void> {
  const { ui } = env;
  const incoming = savedListFromFile(await file.text());
  if (incoming === null) {
    ui.savedNote = "That file is not a saved character list.";
  } else {
    storeSaved(env, mergeSavedLists(ui.saved, incoming));
  }
  m.redraw();
}

function savedRow(env: Env, entry: SavedCharacter, currentHash: string) {
  const { ui } = env;
  const isCurrent = entry.hash === currentHash;
  const confirming = ui.confirmingDelete === entry.id;
  return m(
    "li.forge-saved",
    { key: entry.id, class: isCurrent ? "is-on" : "" },
    [
      entry.picture
        ? m("img.forge-saved-picture", { src: entry.picture, alt: "" })
        : m("span.forge-saved-picture"),
      m("div.forge-saved-body", [
        m("input.forge-saved-name[type=text]", {
          value: entry.name,
          "aria-label": "Character name",
          onchange: (e: Event) => {
            const name = (e.target as HTMLInputElement).value.trim();
            if (!name) return;
            storeSaved(
              env,
              ui.saved.map((other) =>
                other.id === entry.id ? { ...other, name } : other,
              ),
            );
          },
        }),
        m("div.forge-pills", [
          m(
            "button.forge-pill",
            {
              disabled: isCurrent,
              onclick: () => {
                ui.recipe = null;
                ui.subject = { kind: "group", group: "skin" };
                ui.confirmingDelete = null;
                setHash(entry.hash);
              },
            },
            isCurrent ? "Showing now" : "Open",
          ),
          m(
            "button.forge-pill",
            {
              disabled: isCurrent,
              title: "Replace this saved character with the one on screen",
              onclick: () => void saveCharacter(env, entry),
            },
            "Save over",
          ),
          m(
            "button.forge-pill",
            {
              class: confirming ? "is-danger" : "",
              onclick: () => {
                if (!confirming) {
                  ui.confirmingDelete = entry.id;
                  return;
                }
                ui.confirmingDelete = null;
                storeSaved(
                  env,
                  ui.saved.filter((other) => other.id !== entry.id),
                );
              },
            },
            confirming ? "Press again to delete" : "Delete",
          ),
        ]),
      ]),
    ],
  );
}

function savedPanel(env: Env) {
  const { ui } = env;
  const currentHash = hashOf(env);
  const count = ui.saved.length;
  return m("section.forge-parts", [
    m("div.forge-parts-top", [
      m("input.forge-search[type=text]", {
        placeholder: `Character ${count + 1}`,
        "aria-label": "Name for this character",
        value: ui.saveName,
        oninput: (e: Event) => {
          ui.saveName = (e.target as HTMLInputElement).value;
        },
      }),
      m(
        "button.forge-pill.is-primary",
        { onclick: () => void saveCharacter(env) },
        "Save this character",
      ),
    ]),
    m("div.forge-parts-scroll", [
      ui.savedNote ? m("p.forge-warning", ui.savedNote) : null,
      count === 0
        ? m(
            "p.forge-note",
            "Nothing saved yet. Saved characters stay exactly as they are, unlike presets, which roll something new each time.",
          )
        : m(
            "ul.forge-saved-list",
            ui.saved.map((entry) => savedRow(env, entry, currentHash)),
          ),
      m(
        "p.forge-note",
        "This list lives in this browser on this device. To move it to another device, download it as a file and load the file there.",
      ),
      m("div.forge-pills", [
        m(
          "button.forge-pill",
          {
            disabled: count === 0,
            onclick: () =>
              downloadFile(
                savedListToFile(ui.saved),
                "lpc-forge-saved-characters.json",
                "application/json",
              ),
          },
          `Download ${count} saved as a file`,
        ),
        m("label.forge-pill.forge-file", [
          "Load a saved list file",
          m("input[type=file]", {
            accept: ".json,application/json",
            onchange: (e: Event) => {
              const input = e.target as HTMLInputElement;
              const file = input.files?.[0];
              if (file) void loadSavedFile(env, file);
              input.value = "";
            },
          }),
        ]),
      ]),
    ]),
  ]);
}

function rightPanel(env: Env) {
  const { ui } = env;
  const choice = (key: Ui["panel"], label: string) =>
    m(
      "button.forge-pill",
      {
        key,
        class: ui.panel === key ? "is-on" : "",
        onclick: () => {
          ui.panel = key;
        },
      },
      label,
    );
  return [
    m("div.forge-pills.forge-panel-switch", [
      choice("parts", "Parts"),
      choice("presets", "Presets"),
      choice("saved", `Saved (${ui.saved.length})`),
    ]),
    ui.panel === "presets"
      ? presetsPanel(env)
      : ui.panel === "saved"
        ? savedPanel(env)
        : partsPanel(env),
  ];
}

function partTile(env: Env, itemId: string, meta: ItemLite, showSlot: boolean) {
  const { catalog, state, ui } = env;
  const worn = isWorn(state, meta, itemId);
  const parents = addOnParents(itemId);
  const parentWorn = hasParentWorn(itemId, wornParts(env));
  const fits = meta.required.includes(state.bodyType) && parentWorn;
  const fitsHead = fitsWornHead(env, meta);
  const occupant = state.selections[meta.type_name];
  const occupantName =
    occupant && !worn ? lite(catalog, occupant.itemId)?.name : null;
  const lacksAnimation =
    meta.animations.length > 0 &&
    ANIMATIONS.some((a) => a.value === state.selectedAnimation) &&
    !meta.animations.includes(state.selectedAnimation);
  const help = [
    meta.name,
    worn ? "Worn now. Click to remove." : null,
    occupantName ? `Replaces ${occupantName}.` : null,
    parentWorn
      ? null
      : `Goes on ${(parents ?? []).map((id) => (id === "helmet" ? "a helmet" : partLabel(lite(catalog, id)?.name ?? id))).join(" or ")}. Wear that first.`,
    meta.required.includes(state.bodyType) ? null : "Not drawn for this body.",
    fitsHead
      ? null
      : "Drawn for human-shaped heads. May not line up with this one.",
    lacksAnimation
      ? `Not drawn for ${humanize(state.selectedAnimation)}.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  return m(
    "button.forge-tile",
    {
      key: itemId,
      "data-item": itemId,
      class: `${worn ? "is-on" : ""} ${fits && fitsHead ? "" : "is-unfit"}`,
      title: help,
      disabled: !fits,
      onclick: () => {
        if (ui.tryOnTimer !== null) clearTimeout(ui.tryOnTimer);
        ui.tryOnTimer = null;
        ui.hovered = null;
        if (worn) removeSlot(env, meta.type_name);
        else {
          equip(env, state, itemId);
          dropOrphanAddOns(env);
        }
      },
      onpointerenter: (e: PointerEvent) => {
        if (e.pointerType === "mouse" && fits && !worn) hoverPart(env, itemId);
      },
      onpointerleave: (e: PointerEvent) => {
        if (e.pointerType === "mouse" && ui.hovered === itemId) {
          hoverPart(env, null);
        }
      },
    },
    [
      partThumb(env, itemId, meta),
      m("span.forge-tile-name", partLabel(meta.name)),
      showSlot ? m("small.forge-tile-slot", slotLabel(meta.type_name)) : null,
      lacksAnimation
        ? m(
            "span.forge-tile-flag",
            { title: `Not drawn for ${humanize(state.selectedAnimation)}` },
            "!",
          )
        : null,
    ],
  );
}

/** False until the character from the link is drawn, so nothing exports blank. */
function canExport({ catalog, state, ui }: Env): boolean {
  return (
    catalog.isLiteReady() &&
    ui.drawnOnce &&
    Object.keys(state.selections).length > 0
  );
}

const NOT_READY = "Waiting for the character to finish loading";

function header(env: Env) {
  const { state, ui } = env;
  const ready = canExport(env);
  return m("header.forge-header", [
    m("div.forge-brand", [
      m("h1", "LPC Forge"),
      m("p.forge-credit-line", [
        "Built on ",
        m(
          "a",
          { href: SOURCES.universal.url, target: "_blank", rel: "noopener" },
          SOURCES.universal.short,
        ),
        ", with thanks to ",
        m(
          "a",
          { href: SOURCES.vitruvian.url, target: "_blank", rel: "noopener" },
          SOURCES.vitruvian.short,
        ),
        " and ",
        m(
          "a",
          { href: SOURCES.pflat.url, target: "_blank", rel: "noopener" },
          SOURCES.pflat.short,
        ),
        ". ",
        m(
          "button.forge-link",
          {
            onclick: () => {
              ui.drawer = "about";
            },
          },
          "About and credits",
        ),
      ]),
    ]),
    m("div.forge-actions", [
      m(
        "button.forge-pill",
        {
          disabled: ui.undo.length === 0,
          onclick: () => restore(env, ui.undo, ui.redo),
        },
        "Undo",
      ),
      m(
        "button.forge-pill",
        {
          disabled: ui.redo.length === 0,
          onclick: () => restore(env, ui.redo, ui.undo),
        },
        "Redo",
      ),
      m(
        "button.forge-pill",
        {
          onclick: () => {
            ui.subject = { kind: "group", group: "skin" };
            ui.recipe = null;
            ui.locks.clear();
            void resetAll(state);
          },
        },
        "Start over",
      ),
      window.parent !== window
        ? m(
            "button.forge-pill.is-primary",
            {
              disabled: ui.sending || !ready,
              title: ready ? undefined : NOT_READY,
              onclick: () => void sendToFoundry(env),
            },
            ui.sending ? "Sending…" : "Send to Foundry",
          )
        : null,
      m(
        "button.forge-pill.is-primary",
        {
          disabled: !ready,
          title: ready ? undefined : NOT_READY,
          onclick: () => {
            ui.drawer = "download";
          },
        },
        "Download",
      ),
    ]),
  ]);
}

/** Hands the page hosting Forge the same ZIP the "ZIP by animation" download makes. */
async function sendToFoundry(env: Env) {
  const { models, ui } = env;
  ui.sending = true;
  m.redraw();
  window.parent.postMessage({ type: "lpc-forge-export-started" }, "*");
  let sent = false;
  setZipSink((blob, filename) => {
    sent = true;
    window.parent.postMessage(
      { type: "lpc-forge-export", blob, filename },
      "*",
    );
  });
  try {
    await models.createDownloadModel().exportZipByAnimation();
  } finally {
    setZipSink(null);
    if (!sent) {
      window.parent.postMessage({ type: "lpc-forge-export-failed" }, "*");
    }
    ui.sending = false;
    m.redraw();
  }
}

async function saveAnimations(env: Env): Promise<void> {
  const { catalog, state, ui } = env;
  ui.animationBusy = true;
  ui.animationNote = "";
  m.redraw();
  try {
    const result = await buildAnimationZip(catalog, state, ui.animationOptions);
    downloadZipBlob(result.blob, result.filename);
    ui.animationNote = `Saved ${result.included.length} animation${result.included.length === 1 ? "" : "s"}.`;
  } catch (error) {
    console.error(error);
    ui.animationNote = "The animations could not be built. Please try again.";
  } finally {
    ui.animationBusy = false;
    m.redraw();
  }
}

/** Ready-made animations, so nothing needs cutting out of a sheet afterwards. */
function animationSection(env: Env) {
  const { catalog, state, ui } = env;
  const options = ui.animationOptions;
  const plan = planAnimationExport(catalog, state, options.includeIncomplete);
  const held = ui.hovered !== null || ui.tryOnTimer !== null || ui.renderBusy;
  const nothingTicked =
    !options.gifs && !options.strips && !options.frames && !options.token;
  const absent = plan.missing.filter((row) => !row.included);
  const toggle = (
    key: "gifs" | "strips" | "frames" | "token" | "includeIncomplete",
    label: string,
  ) =>
    m("label.forge-check", [
      m("input[type=checkbox]", {
        checked: options[key],
        onchange: (e: Event) => {
          options[key] = (e.target as HTMLInputElement).checked;
        },
      }),
      label,
    ]);
  return [
    m("h3.forge-heading", "Animations, ready to use"),
    m(
      "p.forge-note",
      "One file per animation and facing, oversized weapon swings included, with the credits.",
    ),
    m("div.forge-animation-options", [
      m("label.forge-check", [
        "Size ",
        m(
          "select",
          {
            value: String(options.scale),
            onchange: (e: Event) => {
              options.scale = Number((e.target as HTMLSelectElement).value);
            },
          },
          [1, 2, 3, 4, 6, 8].map((scale) =>
            m("option", { value: String(scale) }, `${scale}x`),
          ),
        ),
      ]),
      m("label.forge-check", [
        "Frames per second ",
        m("input[type=number][min=1][max=30]", {
          value: options.fps,
          onchange: (e: Event) => {
            const value = Number((e.target as HTMLInputElement).value);
            options.fps = Math.min(30, Math.max(1, value || 8));
          },
        }),
      ]),
      toggle("gifs", "GIFs"),
      toggle("strips", "Strips"),
      toggle("frames", "Single frames"),
      toggle("token", "Still token"),
    ]),
    m(
      "div",
      toggle(
        "includeIncomplete",
        "Also save animations a part is missing from",
      ),
    ),
    m("div.forge-pills", [
      m(
        "button.forge-pill.is-primary",
        {
          disabled: ui.animationBusy || held || nothingTicked,
          title: held
            ? "Waiting for the character to finish drawing"
            : nothingTicked
              ? "Tick at least one kind of file"
              : undefined,
          onclick: () => void saveAnimations(env),
        },
        ui.animationBusy
          ? "Saving animations (working…)"
          : `Save ${plan.included.length} animation${plan.included.length === 1 ? "" : "s"}`,
      ),
    ]),
    ui.animationNote ? m("p.forge-note", ui.animationNote) : null,
    absent.length > 0
      ? m("details.forge-missing", [
          m(
            "summary",
            `${absent.length} animation${absent.length === 1 ? " is" : "s are"} left out because a worn part has no art for ${absent.length === 1 ? "it" : "them"}`,
          ),
          m(
            "ul",
            absent.map((row) =>
              m(
                "li",
                { key: row.animation },
                `${row.label}: no ${row.parts.join(", ")}`,
              ),
            ),
          ),
        ])
      : null,
    plan.partsNotDrawn.length > 0
      ? m(
          "p.forge-note",
          `Not drawn for this body at all: ${plan.partsNotDrawn.join(", ")}.`,
        )
      : null,
  ];
}

function downloadDrawer(env: Env) {
  const { state, models, catalog } = env;
  const download = models.createDownloadModel();
  const credits = models.createCreditsModel();
  const zipButton = (label: string, run: () => Promise<void>, busy: boolean) =>
    m(
      "button.forge-pill",
      {
        disabled: download.zipDisabled,
        title: download.zipTitle,
        onclick: run,
      },
      busy ? `${label} (working…)` : label,
    );
  return [
    m("h2.forge-drawer-title", "Download"),
    m("div.forge-pills", [
      m(
        "button.forge-pill.is-primary",
        { onclick: download.saveSpritesheet },
        "Sprite sheet image",
      ),
      zipButton(
        "ZIP by animation",
        download.exportZipByAnimation,
        download.zipByAnimationRunning,
      ),
      zipButton(
        "ZIP by part",
        download.exportZipByItem,
        download.zipByItemRunning,
      ),
      zipButton(
        "ZIP by animation and part",
        download.exportZipByAnimationAndItem,
        download.zipByAnimationAndItemRunning,
      ),
      zipButton(
        "ZIP of single frames",
        download.exportZipByAnimationAndFrame,
        download.zipIndividualFramesRunning,
      ),
    ]),
    animationSection(env),
    m("h3.forge-heading", "Credits for this character"),
    m(
      "p.forge-note",
      "You must credit these artists wherever you use the art. This list covers exactly the parts this character uses.",
    ),
    credits.kind === "ready"
      ? [
          m("div.forge-pills", [
            m(
              "button.forge-pill",
              { onclick: credits.downloadTxt },
              "Credits as text",
            ),
            m(
              "button.forge-pill",
              { onclick: credits.downloadCsv },
              "Credits as spreadsheet",
            ),
          ]),
          m(
            "ul.forge-credits",
            credits.credits.map((credit) =>
              m("li", { key: credit.key }, [
                m("strong", credit.fileName),
                credit.notes ? m("p", credit.notes) : null,
                m("p", `Licenses: ${credit.licenses.join(", ")}`),
                m("p", `Authors: ${credit.authors.join(", ")}`),
              ]),
            ),
          ),
        ]
      : m(
          "p.forge-note",
          credits.kind === "empty" ? "No parts selected." : "Loading credits…",
        ),
    m("h3.forge-heading", "Copy this character"),
    m("div.forge-pills", [
      m(
        "button.forge-pill",
        {
          onclick: async () => {
            const result = await download.exportJsonToClipboard();
            alert(
              result.kind === "success"
                ? "Copied to the clipboard."
                : "The browser would not allow copying.",
            );
          },
        },
        "Copy to clipboard",
      ),
      m(
        "button.forge-pill",
        {
          onclick: async () => {
            const result = await download.importJsonFromClipboard();
            alert(
              result.kind === "success"
                ? "Loaded from the clipboard."
                : "The clipboard does not hold a character, or the browser would not allow reading it.",
            );
          },
        },
        "Load from clipboard",
      ),
    ]),
    m(
      "p.forge-note",
      "The address of this page also holds the character, so saving or sharing the link saves it too.",
    ),
    m("div.forge-light", [
      m(FullSpritesheetPreview, { catalog, state }),
      m(AdvancedTools, { state }),
    ]),
  ];
}

function filtersDrawer(env: Env) {
  const { models, ui } = env;
  const licenses = models.createLicenseFiltersModel();
  const animations = models.createAnimationFiltersModel();
  const checkbox = (
    key: string,
    label: string,
    enabled: boolean,
    set: (value: boolean) => void,
  ) =>
    m("label.forge-check", { key }, [
      m("input[type=checkbox]", {
        checked: enabled,
        onchange: (e: Event) => set((e.target as HTMLInputElement).checked),
      }),
      label,
    ]);
  return [
    m("h2.forge-drawer-title", "Filters"),
    m("h3.forge-heading", "Body and head"),
    m(
      "div",
      checkbox(
        "unfit",
        "Also show parts that do not fit this body or head, add-ons waiting for their part, greyed out",
        ui.showUnfit,
        (value) => {
          ui.showUnfit = value;
        },
      ),
    ),
    m("h3.forge-heading", "Allowed licenses"),
    m(
      "p.forge-note",
      "Hides parts whose license is not ticked here. All are allowed to start with.",
    ),
    licenses.options.map((option) =>
      checkbox(option.key, option.label, option.enabled, option.setEnabled),
    ),
    m("h3.forge-heading", "Required animations"),
    m(
      "p.forge-note",
      "Tick an animation to hide parts not drawn for it. Nothing is ticked to start with.",
    ),
    animations.options.map((option) =>
      checkbox(option.value, option.label, option.enabled, option.setEnabled),
    ),
  ];
}

function aboutDrawer() {
  const link = (source: { label: string; url: string }) =>
    m(
      "a",
      { href: source.url, target: "_blank", rel: "noopener" },
      source.label,
    );
  return [
    m("h2.forge-drawer-title", "About and credits"),
    m(
      "p",
      "LPC Forge is a friendlier way to build Liberated Pixel Cup characters. It exists because of the people below, and all the art belongs to its artists.",
    ),
    m("h3.forge-heading", link(SOURCES.universal)),
    m(
      "p",
      "The foundation of this project. LPC Forge is a modified copy of its code, and uses its art library, palettes, draw rules, export and credit data. If you enjoy this, go and thank them.",
    ),
    m("h3.forge-heading", link(SOURCES.vitruvian)),
    m(
      "p",
      "The inspiration for this flat layout and for its shared color choices. No Vitruvian code or art is in LPC Forge at this time.",
    ),
    m("h3.forge-heading", link(SOURCES.pflat)),
    m(
      "p",
      "The source of 107 parts not found elsewhere, mostly helmets and hairstyles, converted to recolor here, and of the presets, which are built from its race files. These parts cover its six animations: spellcast, thrust, walk, slash, shoot and hurt.",
    ),
    m("h3.forge-heading", "The artists"),
    m("p", [
      "Every image keeps its own license and authors. The Download panel lists them for exactly the parts your character uses, and you must credit them wherever you use the art. The full list is in ",
      m(
        "a",
        {
          href: `${FORK_URL}/blob/forge/CREDITS.csv`,
          target: "_blank",
          rel: "noopener",
        },
        "CREDITS.csv",
      ),
      ".",
    ]),
    m("h3.forge-heading", "Source code"),
    m("p", [
      "LPC Forge is free software under the GNU General Public License version 3, the same license as Universal LPC. ",
      m(
        "a",
        { href: FORK_URL, target: "_blank", rel: "noopener" },
        "Read the source",
      ),
      ".",
    ]),
  ];
}

function drawer(env: Env) {
  const { ui } = env;
  if (!ui.drawer) return null;
  const close = () => {
    ui.drawer = null;
  };
  return m("div.forge-drawer-wrap", { onclick: close }, [
    m("aside.forge-drawer", { onclick: (e: Event) => e.stopPropagation() }, [
      m(
        "button.forge-drawer-close",
        { onclick: close, "aria-label": "Close" },
        "×",
      ),
      ui.drawer === "download"
        ? downloadDrawer(env)
        : ui.drawer === "filters"
          ? filtersDrawer(env)
          : aboutDrawer(),
    ]),
  ]);
}

export type ForgeAppAttrs = {
  catalog: CatalogReader;
  state: State;
  models: ApplicationModels;
};

type ForgeAppState = {
  ui: Ui;
  prevHash: string;
  prevCustomImage: HTMLImageElement | null;
  prevCustomZPos: number;
  prevSnapshot: Snapshot | null;
  onKey: (e: KeyboardEvent) => void;
};

function envOf(vnode: m.Vnode<ForgeAppAttrs, ForgeAppState>): Env {
  return { ...vnode.attrs, ui: vnode.state.ui };
}

export const ForgeApp: m.Component<ForgeAppAttrs, ForgeAppState> = {
  oninit(vnode) {
    const { state } = vnode.attrs;
    state.showTransparencyGrid = false;
    vnode.state.ui = {
      panel: "parts",
      recipe: null,
      locks: new Set(),
      saved: readSavedList(),
      saveName: "",
      savedNote: null,
      confirmingDelete: null,
      category: "body",
      group: null,
      search: "",
      subject: { kind: "group", group: "skin" },
      tab: "parts",
      drawer: null,
      showUnfit: false,
      animationOptions: { ...DEFAULT_ANIMATION_EXPORT_OPTIONS, scale: 2 },
      animationBusy: false,
      animationNote: "",
      hairFallback: defaultHairColor(),
      remembered: {},
      hovered: null,
      playing: false,
      sending: false,
      tryOnTimer: null,
      undo: [],
      redo: [],
      lastHash: "",
      renderBusy: false,
      renderAgain: false,
      drawnOnce: false,
      categories: null,
    };
    vnode.state.prevHash = "";
    vnode.state.prevCustomImage = state.customUploadedImage;
    vnode.state.prevCustomZPos = state.customImageZPos;
    vnode.state.prevSnapshot = null;
  },
  oncreate(vnode) {
    const env = envOf(vnode);
    vnode.state.onKey = (e) => {
      if (e.key === "Escape" && env.ui.drawer) {
        env.ui.drawer = null;
        m.redraw();
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.target instanceof HTMLInputElement) {
        return;
      }
      if (e.key === "z" && !e.shiftKey) restore(env, env.ui.undo, env.ui.redo);
      else if (e.key === "y" || (e.key === "z" && e.shiftKey)) {
        restore(env, env.ui.redo, env.ui.undo);
      } else return;
      e.preventDefault();
      m.redraw();
    };
    window.addEventListener("keydown", vnode.state.onKey);
  },
  onremove(vnode) {
    window.removeEventListener("keydown", vnode.state.onKey);
  },
  onupdate(vnode) {
    const { catalog, state } = vnode.attrs;
    const { ui } = vnode.state;
    if (!catalog.isLiteReady()) return;
    const env = envOf(vnode);
    const hash = hashOf(env);
    const selectionsChanged = hash !== vnode.state.prevHash;
    if (
      !selectionsChanged &&
      state.customUploadedImage === vnode.state.prevCustomImage &&
      state.customImageZPos === vnode.state.prevCustomZPos
    ) {
      return;
    }
    const hadCharacter = vnode.state.prevSnapshot !== null;
    if (selectionsChanged) {
      if (hadCharacter && hash !== ui.lastHash) {
        ui.undo.push(vnode.state.prevSnapshot!);
        if (ui.undo.length > 100) ui.undo.shift();
        ui.redo = [];
      }
      ui.lastHash = hash;
      vnode.state.prevSnapshot = {
        selections: JSON.parse(JSON.stringify(state.selections)) as Selections,
        bodyType: state.bodyType,
        hash,
      };
    }
    vnode.state.prevHash = hash;
    vnode.state.prevCustomImage = state.customUploadedImage;
    vnode.state.prevCustomZPos = state.customImageZPos;
    if (Object.keys(state.selections).length === 0 && !hadCharacter) return;
    syncSelectionsToHash(catalog, state);
    if (window.canvasRenderer) {
      requestRender(env, () => currentPreviewSelections(env));
    }
  },
  view(vnode) {
    const env = envOf(vnode);
    const { catalog } = env;
    const { ui } = env;
    if (!ui.categories) {
      const tree = catalog.getCategoryTree().unwrapOr(null);
      if (tree) ui.categories = buildPartCategories(tree);
    }
    const tab = (key: Ui["tab"], label: string) =>
      m(
        "button.forge-tab",
        {
          class: ui.tab === key ? "is-on" : "",
          onclick: () => {
            ui.tab = key;
          },
        },
        label,
      );
    return m("div.forge", { "data-tab": ui.tab }, [
      header(env),
      m("main.forge-main", [
        m("div.forge-column.forge-column-left", characterPanel(env)),
        m("div.forge-column.forge-column-center", [
          previewPanel(env),
          m("nav.forge-tabs", [
            tab("character", "Character"),
            tab("colors", "Colors"),
            tab("parts", "Parts"),
          ]),
          colorsPanel(env),
        ]),
        m("div.forge-column.forge-column-right", rightPanel(env)),
      ]),
      drawer(env),
    ]);
  },
};
