import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addOnParents,
  hasParentWorn,
  isFittedToHead,
  isHumanShapedHead,
  partLabel,
} from "../../../sources/forge/part-rules.ts";
import { RECIPES } from "../../../sources/forge/recipes.ts";

type Definition = {
  name: string;
  type_name: string;
  path?: string[];
  required_tags?: string[];
};

function readDefinitions(
  dir = "sheet_definitions",
  found = new Map<string, Definition & { folders: string[] }>(),
) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) readDefinitions(full, found);
    else if (entry.name.endsWith(".json") && !entry.name.startsWith("meta_")) {
      const definition = JSON.parse(readFileSync(full, "utf8")) as Definition;
      const folders = full.split(/[\\/]/).slice(1, -1);
      found.set(entry.name.slice(0, -5), { ...definition, folders });
    }
  }
  return found;
}

const ITEMS = readDefinitions();

test("every parent an add-on names is a real part", () => {
  const missing: string[] = [];
  for (const itemId of ITEMS.keys()) {
    for (const parent of addOnParents(itemId) ?? []) {
      if (parent !== "helmet" && !ITEMS.has(parent)) {
        missing.push(`${itemId} -> ${parent}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("every part the art says needs another part waits for it", () => {
  const loose: string[] = [];
  for (const [itemId, item] of ITEMS) {
    const needs = (item.required_tags ?? []).filter(
      (tag) => tag !== "human" && tag !== "adult",
    );
    if (needs.length > 0 && !addOnParents(itemId)) loose.push(itemId);
  }
  assert.deepEqual(loose, []);
});

test("all the shield's patterns wait for their own shield", () => {
  const patterns = [...ITEMS].filter(
    ([, item]) => item.type_name === "shield_pattern",
  );
  assert.equal(patterns.length, 48);
  for (const [itemId] of patterns) {
    const wanted = itemId.includes("revised")
      ? "shield_heater_revised_wood"
      : "shield_heater_wood";
    assert.deepEqual(addOnParents(itemId), [wanted], itemId);
  }
});

test("an add-on is available only with what it goes on", () => {
  const shield = {
    itemId: "shield_heater_wood",
    path: ["weapons", "shields", "heater"],
  };
  const pattern = "shield_heater_pattern_chevron";
  assert.equal(hasParentWorn(pattern, []), false);
  assert.equal(hasParentWorn(pattern, [shield]), true);
  assert.equal(hasParentWorn("hat_visor_grated", [shield]), false);
  const helmet = { itemId: "any", path: ["headwear", "helmets", "helmets"] };
  assert.equal(hasParentWorn("hat_visor_grated", [helmet]), true);
  assert.equal(hasParentWorn("hat_tricorne", []), true);
});

test("hair, hats and faces are fitted to a head; necks and bodies are not", () => {
  assert.equal(isFittedToHead(["hair", "short"]), true);
  assert.equal(isFittedToHead(["headwear", "helmets", "helmets"]), true);
  assert.equal(isFittedToHead(["headwear", "neck"]), false);
  assert.equal(isFittedToHead(["head", "ears"]), true);
  assert.equal(isFittedToHead(["head", "appendages"]), false);
  assert.equal(isFittedToHead(["torso", "shirts"]), false);
});

test("orc, goblin and troll heads are not human shaped", () => {
  for (const head of [
    "heads_orc_male",
    "heads_orc_female",
    "heads_goblin",
    "heads_troll",
    "heads_minotaur",
    "heads_wolf_male",
    "heads_lizard_male",
  ]) {
    assert.ok(ITEMS.has(head), head);
    assert.equal(isHumanShapedHead(head), false, head);
  }
  assert.equal(isHumanShapedHead("heads_human_male"), true);
  assert.equal(isHumanShapedHead("heads_zombie"), true);
});

test("no preset puts a head-fitted part on a head it does not fit", () => {
  const wrong: string[] = [];
  for (const recipe of RECIPES) {
    const heads = Object.values(recipe.heads)
      .flat()
      .map((choice) => (typeof choice === "string" ? choice : choice.id));
    if (heads.some(isHumanShapedHead)) continue;
    for (const rule of recipe.parts) {
      if (!Array.isArray(rule.from)) continue;
      for (const choice of rule.from as readonly (string | { id: string })[]) {
        const id = typeof choice === "string" ? choice : choice.id;
        const item = ITEMS.get(id);
        if (item && isFittedToHead(item.path ?? item.folders)) {
          wrong.push(`${recipe.id}: ${id}`);
        }
      }
    }
  }
  assert.deepEqual(wrong, []);
});

test("raw names read as words, and proper names are left alone", () => {
  assert.equal(partLabel("per_chevron_inverted"), "Per Chevron Inverted");
  assert.equal(partLabel("chevron"), "Chevron");
  assert.equal(partLabel("Heater Shield Base"), "Heater Shield Base");
});
