import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BODY_WEIGHTS,
  RECIPE_GROUPS,
  RECIPES,
  ROLLED_SLOTS,
  type PartChoice,
  type Recipe,
} from "../../../sources/forge/recipes.ts";
import {
  colorKey,
  matchingVariant,
  recipeFitsBody,
  rollRecipe,
  type RollContext,
} from "../../../sources/forge/roll.ts";
import {
  mergeSavedLists,
  newSavedCharacter,
  savedListFromFile,
  savedListToFile,
} from "../../../sources/forge/saved.ts";
import bodyPalettes from "../../../palette_definitions/body/body_ulpc.json" with { type: "json" };
import hairPalettes from "../../../palette_definitions/hair/hair_ulpc.json" with { type: "json" };
import eyePalettes from "../../../palette_definitions/eye/eye_ulpc.json" with { type: "json" };

type Definition = {
  type_name: string;
  animations?: string[];
  variants?: string[];
  layer_1: Record<string, unknown>;
};

function readDefinitions(): Map<string, Definition> {
  const items = new Map<string, Definition>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        entry.name.endsWith(".json") &&
        !entry.name.startsWith("meta_")
      ) {
        items.set(
          entry.name.slice(0, -5),
          JSON.parse(readFileSync(path, "utf8")) as Definition,
        );
      }
    }
  };
  walk("sheet_definitions");
  return items;
}

const ITEMS = readDefinitions();

const usable = (itemId: string, body: string) => {
  const layer = ITEMS.get(itemId)?.layer_1;
  return !!layer && typeof layer[body] === "string";
};

function context(overrides: Partial<RollContext> = {}): RollContext {
  return {
    currentBody: "male",
    bodyLocked: false,
    colorLocked: () => false,
    slotLocked: () => false,
    usable,
    anyInSlot: (slot, body) =>
      [...ITEMS.entries()]
        .filter(
          ([id, item]) =>
            item.type_name === slot &&
            usable(id, body) &&
            item.animations?.includes("run"),
        )
        .map(([id]) => id),
    slotOf: (itemId) => ITEMS.get(itemId)?.type_name ?? null,
    variantsOf: (itemId) => ITEMS.get(itemId)?.variants ?? [],
    keptParts: [],
    ...overrides,
  };
}

/** A repeatable stand-in for Math.random. */
function seeded(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

const idOf = (choice: PartChoice) =>
  typeof choice === "string" ? choice : choice.id;

function namedParts(recipe: Recipe): string[] {
  const { male, female, teen = [], child = [] } = recipe.heads;
  const ids = [...male, ...female, ...teen, ...child].map(idOf);
  for (const rule of recipe.parts) {
    if ("anyInSlot" in rule.from) continue;
    for (const choice of rule.from) {
      ids.push(idOf(choice));
      if (typeof choice !== "string") ids.push(...(choice.with ?? []));
    }
  }
  if (recipe.bodyItem) ids.push(recipe.bodyItem);
  ids.push(...recipe.picture.parts);
  return ids;
}

const vampire = RECIPES.find((recipe) => recipe.id === "vampire")!;

test("every part a recipe names exists and has a rolled slot", () => {
  for (const recipe of RECIPES) {
    for (const id of namedParts(recipe)) {
      const item = ITEMS.get(id);
      assert.ok(item, `${recipe.name} names unknown part ${id}`);
      if (id !== "body" && id !== recipe.bodyItem) {
        assert.ok(
          ROLLED_SLOTS.includes(item.type_name),
          `${recipe.name}: ${id} is in slot ${item.type_name}, which is never cleared`,
        );
      }
    }
    assert.ok(RECIPE_GROUPS.includes(recipe.group), recipe.name);
  }
});

test("every color a recipe names is a real palette or hex color", () => {
  const isHex = (color: string) => /^#[0-9a-fA-F]{6}$/.test(color);
  for (const recipe of RECIPES) {
    for (const color of recipe.skin ?? []) {
      if (typeof color !== "string" || recipe.bodyItem) continue;
      assert.ok(
        isHex(color) || color in bodyPalettes,
        `${recipe.name} ${color}`,
      );
    }
    for (const color of recipe.hair ?? []) {
      assert.ok(color in hairPalettes, `${recipe.name} hair ${color}`);
    }
    for (const color of recipe.eyes ?? []) {
      assert.ok(color in eyePalettes, `${recipe.name} eyes ${color}`);
    }
  }
});

test("every recipe rolls on its bodies and only draws parts for them", () => {
  for (const recipe of RECIPES) {
    const rng = seeded(recipe.id.length * 97 + 11);
    for (let i = 0; i < 40; i++) {
      const plan = rollRecipe(recipe, context(), rng);
      assert.ok(
        BODY_WEIGHTS[plan.bodyType] > 0,
        `${recipe.name} rolled ${plan.bodyType}`,
      );
      assert.ok(usable(plan.bodyItem, plan.bodyType), recipe.name);
      assert.ok(plan.parts.length > 0, `${recipe.name} planned no parts`);
      for (const { itemId } of plan.parts) {
        assert.ok(
          usable(itemId, plan.bodyType),
          `${recipe.name}: ${itemId} on ${plan.bodyType}`,
        );
      }
    }
  }
});

test("a vampire always has its head and pointed ears, and grey skin that varies", () => {
  const rng = seeded(5);
  const skins = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const plan = rollRecipe(vampire, context(), rng);
    const ids = plan.parts.map((part) => part.itemId);
    assert.ok(ids.includes("heads_vampire"));
    assert.ok(ids.some((id) => ITEMS.get(id)?.type_name === "ears"));
    assert.match(plan.skin!, /^c-[0-9a-f]{6}$/);
    const [r, g, b] = [2, 4, 6].map((at) =>
      parseInt(plan.skin!.slice(at, at + 2), 16),
    );
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 20, plan.skin!);
    skins.add(plan.skin!);
  }
  assert.ok(skins.size > 30, `only ${skins.size} skin colors`);
});

test("a roll on a child, pregnant or muscular body only happens when locked there", () => {
  const rng = seeded(9);
  const human = RECIPES.find((recipe) => recipe.id === "human")!;
  for (let i = 0; i < 200; i++) {
    const { bodyType } = rollRecipe(human, context(), rng);
    assert.ok(["male", "female", "teen"].includes(bodyType), bodyType);
  }
  const locked = context({ currentBody: "child", bodyLocked: true });
  assert.equal(rollRecipe(human, locked, rng).bodyType, "child");
  assert.equal(recipeFitsBody(vampire, "child", usable), false);
});

test("locks keep the body, colors and slots from rolling", () => {
  const rng = seeded(21);
  const locked = context({
    currentBody: "female",
    bodyLocked: true,
    colorLocked: () => true,
    slotLocked: (slot) => slot === "ears" || slot === "head",
  });
  for (let i = 0; i < 50; i++) {
    const plan = rollRecipe(vampire, locked, rng);
    assert.equal(plan.bodyType, "female");
    assert.equal(plan.skin, null);
    assert.equal(plan.hair, null);
    assert.equal(plan.eyes, null);
    for (const { itemId } of plan.parts) {
      const slot = ITEMS.get(itemId)?.type_name;
      assert.ok(slot !== "ears" && slot !== "head", itemId);
    }
  }
});

test("a body is only rolled if the parts staying on fit it", () => {
  const rng = seeded(33);
  const human = RECIPES.find((recipe) => recipe.id === "human")!;
  const femaleOnly = [...ITEMS.entries()].find(
    ([id]) =>
      usable(id, "female") && !usable(id, "male") && !usable(id, "muscular"),
  )?.[0];
  assert.ok(femaleOnly, "needs a part only drawn for some bodies");
  for (let i = 0; i < 50; i++) {
    const { bodyType } = rollRecipe(
      human,
      context({ keptParts: [femaleOnly] }),
      rng,
    );
    assert.ok(usable(femaleOnly, bodyType), `${femaleOnly} on ${bodyType}`);
  }
});

test("parts that follow hair or skin wear the matching version", () => {
  const halfWolf = RECIPES.find((recipe) => recipe.id === "halfwolf")!;
  const rng = seeded(41);
  for (let i = 0; i < 50; i++) {
    const plan = rollRecipe(halfWolf, context(), rng);
    const tail = plan.parts.find((part) => part.itemId.startsWith("tail_"));
    assert.ok(tail?.color, "tail has a color");
    assert.equal(tail.color.replaceAll(" ", "_"), plan.hair);
  }
  assert.equal(matchingVariant(["light brown"], "light_brown"), "light brown");
  assert.equal(matchingVariant(["fur_grey"], "fur_grey"), "fur_grey");
  assert.equal(matchingVariant(["red"], "c-123456"), null);
});

test("color choices turn into recolor keys", () => {
  assert.equal(
    colorKey("light", () => 0),
    "light",
  );
  assert.equal(
    colorKey("#A1B2C3", () => 0),
    "c-a1b2c3",
  );
  assert.equal(
    colorKey({ from: "#000000", to: "#ffffff" }, () => 0),
    "c-000000",
  );
  assert.equal(
    colorKey({ from: "#000000", to: "#ffffff" }, () => 1),
    "c-ffffff",
  );
});

test("a saved list survives a file and merges without duplicates", () => {
  const one = newSavedCharacter("One", "sex=male", "data:a");
  const two = newSavedCharacter("Two", "sex=female", "data:b");
  const read = savedListFromFile(savedListToFile([one, two]));
  assert.deepEqual(read, [one, two]);
  assert.deepEqual(mergeSavedLists([one], read!), [one, two]);
  assert.equal(savedListFromFile("not json"), null);
  assert.equal(savedListFromFile('{"format":"something else"}'), null);
});
