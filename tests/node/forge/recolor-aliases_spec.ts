import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Recolor = { material: string; palettes: string[] };
type Definition = {
  recolors?: Recolor | { color_1: Recolor };
  aliases?: Record<string, string>;
};

const SHEETS = "sheet_definitions";
const PALETTES = "palette_definitions";

function definitions(dir: string, found: [string, Definition][] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) definitions(full, found);
    else if (entry.name.endsWith(".json") && !entry.name.startsWith("meta_")) {
      found.push([full, JSON.parse(readFileSync(full, "utf8")) as Definition]);
    }
  }
  return found;
}

/** Every color a part offers, spelled the way the metadata generator spells it. */
function offeredColors({ material, palettes }: Recolor): Set<string> {
  const keys = new Set<string>();
  for (const token of palettes) {
    const [first, second] = token.split(".");
    const other = second ? first : material;
    const version = second ?? first;
    const file = join(PALETTES, other, `${other}_${version}.json`);
    const colors = JSON.parse(readFileSync(file, "utf8")) as object;
    for (const color of Object.keys(colors)) {
      const prefix = other !== material ? `${other}.` : "";
      keys.add(`${prefix}${version !== "ulpc" ? `${version}.` : ""}${color}`);
    }
  }
  return keys;
}

test("an old color's link lands on a color its part still offers", () => {
  const broken: string[] = [];
  let checked = 0;
  for (const [file, definition] of definitions(SHEETS)) {
    const recolors = definition.recolors;
    if (!recolors || !definition.aliases) continue;
    const recolor = "color_1" in recolors ? recolors.color_1 : recolors;
    const offered = offeredColors(recolor);
    for (const [from, to] of Object.entries(definition.aliases)) {
      // Others forward to another part, which only that part can answer.
      if (to.includes("=") || to.includes("*") || !to.includes(".")) continue;
      checked++;
      // Some upstream links spell out the default version and the part's own material.
      const target = to
        .replace(".ulpc.", ".")
        .replace(`${recolor.material}.`, "");
      if (!offered.has(target)) broken.push(`${file}: ${from} -> ${to}`);
    }
  }
  assert.ok(checked > 100, `expected to check many links, found ${checked}`);
  assert.deepEqual(broken, []);
});
