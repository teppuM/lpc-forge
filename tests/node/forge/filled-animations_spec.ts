import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

type Definition = { animations?: string[]; credits?: { notes?: string }[] };

const CLAIMS: Record<string, string> = {
  combat_idle: "combat",
  backslash: "1h_backslash",
  halfslash: "1h_halfslash",
};

function manifest() {
  const [header, ...lines] = readFileSync("tools/filled-animations.csv", "utf8").trim().split("\n");
  const names = header.split(",");
  return lines.map(
    (line) => Object.fromEntries(line.split(",").map((value, i) => [names[i], value])) as Record<string, string>,
  );
}

test("every rebuilt sheet exists, is claimed by its part, and is noted in its credits", () => {
  const rows = manifest();
  assert.ok(rows.length > 1000, "the manifest lists the rebuilt sheets");
  for (const { part, path, sheet, color } of rows) {
    const file = color ? `spritesheets/${path}${sheet}/${color}.png` : `spritesheets/${path}${sheet}.png`;
    assert.ok(existsSync(file), `${file} is missing`);
    const definition = JSON.parse(readFileSync(`sheet_definitions/${part}`, "utf8")) as Definition;
    assert.ok(definition.animations?.includes(CLAIMS[sheet] ?? sheet), `${part} does not claim ${sheet}`);
    assert.ok(
      definition.credits?.every((credit) => credit.notes?.includes("Rebuilt from this part's own frames")),
      `${part} does not note the rebuild in its credits`,
    );
  }
});

test("neck parts and the hurt animation are not rebuilt", () => {
  for (const { part, sheet } of manifest()) {
    assert.ok(!part.startsWith("headwear/neck/"), `${part} is outside what the check covers`);
    assert.notEqual(sheet, "hurt");
  }
});
