/**
 * Turns a recipe into one concrete character. Nothing here touches the page: it
 * takes what it needs to know about parts and locks, and returns a plan.
 */
import { customColorKey } from "./custom-color.ts";
import {
  BODY_WEIGHTS,
  type ColorChoice,
  type PartChoice,
  type PartRule,
  type Recipe,
} from "./recipes.ts";

export type Rng = () => number;

export type RollContext = {
  readonly currentBody: string;
  /** Body may not change. */
  readonly bodyLocked: boolean;
  /** Skin, hair or eye color may not change. */
  readonly colorLocked: (group: "skin" | "hair" | "eyes") => boolean;
  /** A part in this slot is locked in place. */
  readonly slotLocked: (slot: string) => boolean;
  /** The part is drawn for this body and passes the viewer's filters. */
  readonly usable: (itemId: string, body: string) => boolean;
  /** Every usable part in a slot that holds all the usual animations. */
  readonly anyInSlot: (slot: string, body: string) => readonly string[];
  readonly slotOf: (itemId: string) => string | null;
  readonly variantsOf: (itemId: string) => readonly string[];
  /** Parts staying on the character, which a new body should still fit. */
  readonly keptParts: readonly string[];
};

export type PlannedPart = { readonly itemId: string; readonly color?: string };

export type RollPlan = {
  readonly bodyType: string;
  readonly bodyItem: string;
  /** Null keeps the color the character has, or the body's own. */
  readonly skin: string | null;
  readonly hair: string | null;
  readonly eyes: string | null;
  readonly parts: readonly PlannedPart[];
};

function idOf(choice: PartChoice): string {
  return typeof choice === "string" ? choice : choice.id;
}

function pickWeighted<T>(
  options: readonly T[],
  weightOf: (option: T) => number,
  rng: Rng,
): T | null {
  const total = options.reduce((sum, option) => sum + weightOf(option), 0);
  if (total <= 0) return null;
  let roll = rng() * total;
  for (const option of options) {
    roll -= weightOf(option);
    if (roll < 0) return option;
  }
  return options[options.length - 1];
}

function pickOne<T>(options: readonly T[], rng: Rng): T | null {
  return pickWeighted(options, () => 1, rng);
}

function headChoices(recipe: Recipe, body: string): readonly PartChoice[] {
  const { heads } = recipe;
  if (body === "child") return heads.child ?? [];
  if (body === "teen") return heads.teen ?? heads.female;
  return body === "male" || body === "muscular" ? heads.male : heads.female;
}

/** Whether this recipe can make a character on this body at all. */
export function recipeFitsBody(
  recipe: Recipe,
  body: string,
  usable: (itemId: string, body: string) => boolean,
): boolean {
  if (recipe.bodyItem && !usable(recipe.bodyItem, body)) return false;
  return headChoices(recipe, body).some((choice) => usable(idOf(choice), body));
}

function chooseBody(recipe: Recipe, context: RollContext, rng: Rng): string {
  const { currentBody, bodyLocked, keptParts, usable } = context;
  if (bodyLocked) return currentBody;
  const fits = (body: string) =>
    recipeFitsBody(recipe, body, usable) &&
    keptParts.every((itemId) => usable(itemId, body));
  const bodies = Object.keys(BODY_WEIGHTS).filter(fits);
  const picked = pickWeighted(bodies, (body) => BODY_WEIGHTS[body], rng);
  if (picked) return picked;
  // Worn parts may only fit a body rolls avoid; the one they are on still works.
  if (fits(currentBody)) return currentBody;
  const anyFit = Object.keys(BODY_WEIGHTS).filter((body) =>
    recipeFitsBody(recipe, body, usable),
  );
  return (
    pickWeighted(anyFit, (body) => BODY_WEIGHTS[body], rng) ??
    anyFit[0] ??
    currentBody
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function mixHex(from: string, to: string, amount: number): string {
  const channels = [1, 3, 5].map((start) => {
    const a = parseInt(from.slice(start, start + 2), 16);
    const b = parseInt(to.slice(start, start + 2), 16);
    return Math.round(a + (b - a) * amount)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

/** A color choice as a recolor key: a palette name, or a custom color. */
export function colorKey(choice: ColorChoice, rng: Rng): string {
  if (typeof choice !== "string") {
    return customColorKey(mixHex(choice.from, choice.to, rng()));
  }
  return HEX.test(choice) ? customColorKey(choice) : choice;
}

/** A part's own name for a color: its versions spell some with spaces. */
export function matchingVariant(
  variants: readonly string[],
  color: string,
): string | null {
  const spaced = color.replaceAll("_", " ");
  return variants.find((v) => v === color || v === spaced) ?? null;
}

function colorForPart(
  rule: PartRule,
  itemId: string,
  skin: string | null,
  hair: string | null,
  context: RollContext,
  rng: Rng,
): string | undefined {
  const variants = context.variantsOf(itemId);
  if (rule.follow) {
    const followed = rule.follow === "skin" ? skin : hair;
    if (followed && variants.length === 0) return followed;
    const matched = followed && matchingVariant(variants, followed);
    if (matched) return matched;
  }
  const offered = rule.colors?.flatMap((color) => {
    if (variants.length === 0) return [color];
    const matched = matchingVariant(variants, color);
    return matched ? [matched] : [];
  });
  return offered ? (pickOne(offered, rng) ?? undefined) : undefined;
}

export function rollRecipe(
  recipe: Recipe,
  context: RollContext,
  rng: Rng = Math.random,
): RollPlan {
  const bodyType = chooseBody(recipe, context, rng);
  const { colorLocked, slotLocked, usable } = context;
  const pickColor = (
    group: "skin" | "hair" | "eyes",
    options: readonly ColorChoice[] | undefined,
  ) => {
    if (colorLocked(group) || !options) return null;
    const choice = pickOne(options, rng);
    return choice === null ? null : colorKey(choice, rng);
  };
  const skin = pickColor("skin", recipe.skin);
  const hair = slotLocked("hair") ? null : pickColor("hair", recipe.hair);
  const eyes = pickColor("eyes", recipe.eyes);

  const parts: PlannedPart[] = [];
  const headChoice = pickWeighted(
    headChoices(recipe, bodyType).filter((c) => usable(idOf(c), bodyType)),
    (c) => (typeof c === "string" ? 1 : (c.weight ?? 1)),
    rng,
  );
  if (headChoice && !slotLocked("head")) {
    parts.push({ itemId: idOf(headChoice) });
  }
  for (const rule of recipe.parts) {
    if (rule.bodies && !rule.bodies.includes(bodyType)) continue;
    if (rng() >= (rule.chance ?? 1)) continue;
    const candidates: readonly PartChoice[] =
      "anyInSlot" in rule.from
        ? context.anyInSlot(rule.from.anyInSlot, bodyType)
        : rule.from.filter((choice) => usable(idOf(choice), bodyType));
    const choice = pickWeighted(
      candidates,
      (c) => (typeof c === "string" ? 1 : (c.weight ?? 1)),
      rng,
    );
    if (!choice) continue;
    const itemId = idOf(choice);
    if (slotLocked(context.slotOf(itemId) ?? "")) continue;
    const color = colorForPart(rule, itemId, skin, hair, context, rng);
    parts.push(color ? { itemId, color } : { itemId });
    const extras = typeof choice === "string" ? [] : (choice.with ?? []);
    for (const extra of extras) {
      if (usable(extra, bodyType) && !slotLocked(context.slotOf(extra) ?? "")) {
        parts.push({ itemId: extra });
      }
    }
  }
  return {
    bodyType,
    bodyItem: recipe.bodyItem ?? "body",
    skin,
    hair,
    eyes,
    parts,
  };
}
