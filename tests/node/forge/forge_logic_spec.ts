import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCustomRamp,
  customColorKey,
  customKeyToHex,
  isCustomColorKey,
} from "../../../sources/forge/custom-color.ts";
import {
  buildPartCategories,
  humanize,
  matchesPartSearch,
} from "../../../sources/forge/parts-index.ts";
import { arrangeSwatches } from "../../../sources/forge/swatch-sort.ts";
import palettes from "../../../palette_definitions/body/body_ulpc.json" with { type: "json" };

const LIGHT = palettes.light;

function lightness(hex: string): number {
  const v = parseInt(hex.slice(1), 16);
  return 0.2126 * (v >> 16) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255);
}

test("custom color keys round trip and reject palette names", () => {
  assert.equal(customColorKey("#A1B2C3"), "c-a1b2c3");
  assert.equal(customKeyToHex("c-a1b2c3"), "#a1b2c3");
  assert.equal(isCustomColorKey("c-a1b2c3"), true);
  for (const name of ["light", "c-a1b2c", "c-zzzzzz", "", null, undefined]) {
    assert.equal(isCustomColorKey(name), false);
  }
});

test("a custom ramp has the source length and contains the picked color", () => {
  const ramp = buildCustomRamp("#7A8C9E", LIGHT);
  assert.equal(ramp.length, LIGHT.length);
  assert.ok(ramp.includes("#7A8C9E"));
  for (const color of ramp) assert.match(color, /^#[0-9A-F]{6}$/);
});

test("a custom ramp keeps the source ramp's dark-to-light order", () => {
  for (const pick of ["#7A8C9E", "#C04040", "#30A050", "#E8D0F0"]) {
    const levels = buildCustomRamp(pick, LIGHT).map(lightness);
    for (let i = 1; i < levels.length; i++) {
      assert.ok(
        levels[i] >= levels[i - 1] - 1,
        `${pick} step ${i}: ${levels.join(", ")}`,
      );
    }
  }
});

test("a grey pick produces a grey ramp, not a tinted one", () => {
  for (const color of buildCustomRamp("#808080", LIGHT)) {
    const v = parseInt(color.slice(1), 16);
    const channels = [v >> 16, (v >> 8) & 255, v & 255];
    assert.ok(Math.max(...channels) - Math.min(...channels) <= 2, color);
  }
});

test("picking a color already in the ramp reproduces that step", () => {
  const ramp = buildCustomRamp(LIGHT[3], LIGHT);
  assert.equal(ramp[3], LIGHT[3].toUpperCase());
});

test("categories flatten to labeled sections in priority order", () => {
  const categories = buildPartCategories({
    items: [],
    children: {
      torso: {
        items: ["top_item"],
        children: {
          later: { items: ["b"], priority: 20 } as never,
          earlier: {
            items: ["a"],
            priority: 10,
            children: { deep: { items: ["c"] } },
          } as never,
          empty: { items: [] } as never,
        },
      },
    },
  });
  assert.equal(categories.length, 1);
  assert.equal(categories[0].label, "Torso");
  assert.deepEqual(
    categories[0].sections.map((s) => [s.label, s.itemIds]),
    [
      ["", ["top_item"]],
      ["Earlier", ["a"]],
      ["Earlier / Deep", ["c"]],
      ["Later", ["b"]],
    ],
  );
});

test("search needs every word somewhere in the part's text", () => {
  assert.equal(matchesPartSearch("", ["anything"]), true);
  assert.equal(matchesPartSearch("long hair", ["Long Bob", "hair"]), true);
  assert.equal(matchesPartSearch("LONG", ["long_bob"]), true);
  assert.equal(matchesPartSearch("long hat", ["Long Bob", "hair"]), false);
});

test("slot names read as words", () => {
  assert.equal(humanize("facial_eyes"), "Facial Eyes");
  assert.equal(humanize("hairextl"), "Hair Extension Left");
});

const tile = (key: string, ...colors: string[]) => ({
  key,
  label: key,
  colors,
});

test("skin lists human tones first, light to dark, then the rest", () => {
  const groups = arrangeSwatches(
    [
      tile("black", "#111111", "#221510", "#332015"),
      tile("all.lpcr.aegean", "#102030", "#2060A0", "#90C0E0"),
      tile("light", "#99423C", "#F9D5BA", "#FAECE7"),
      tile("fur_tan", "#604020", "#B08050", "#E0C090"),
    ],
    "body",
  );
  assert.deepEqual(
    groups.map((g) => [g.label, g.tiles.map((t) => t.key)]),
    [
      ["Human skin tones", ["light", "black"]],
      ["Other colors", ["fur_tan", "all.lpcr.aegean"]],
    ],
  );
});

test("the same ramp offered by two palette families appears once", () => {
  const [{ tiles }] = arrangeSwatches(
    [
      tile("lpcr.ivory", "#AABBCC", "#DDEEFF"),
      tile("all.lpcr.ivory", "#aabbcc", "#ddeeff"),
    ],
    "cloth",
  );
  assert.deepEqual(
    tiles.map((t) => t.key),
    ["lpcr.ivory"],
  );
});

test("other materials form one list with similar colors together", () => {
  const groups = arrangeSwatches(
    [
      tile("dark_red", "#300000", "#600000", "#900000"),
      tile("blue", "#000030", "#0000C0", "#6060FF"),
      tile("gray", "#303030", "#808080", "#C0C0C0"),
      tile("light_red", "#900000", "#E06060", "#FFC0C0"),
    ],
    "cloth",
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "");
  assert.deepEqual(
    groups[0].tiles.map((t) => t.key),
    ["gray", "light_red", "dark_red", "blue"],
  );
});
