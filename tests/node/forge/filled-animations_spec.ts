import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

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

test("every built body sheet exists at its donor's size and has its own credit", () => {
  const [, ...lines] = readFileSync("tools/filled-bodies.csv", "utf8").trim().split("\n");
  assert.ok(lines.length > 0, "the manifest lists the built body sheets");
  const definition = JSON.parse(readFileSync("sheet_definitions/body/body.json", "utf8")) as {
    credits: { file: string; notes?: string; licenses: string[] }[];
  };
  for (const line of lines) {
    const [body, sheet, donor] = line.split(",");
    const built = readFileSync(`spritesheets/body/bodies/${body}/${sheet}.png`);
    const source = readFileSync(`spritesheets/body/bodies/${donor}/${sheet}.png`);
    assert.deepEqual(built.subarray(16, 24), source.subarray(16, 24), `${body} ${sheet} is not the size of ${donor}'s`);
    const named = `body/bodies/${body}/${CLAIMS[sheet] ?? sheet}.png`;
    const credit = definition.credits.find(({ file }) => file === named);
    const row = readFileSync("CREDITS.csv", "utf8")
      .split("\n")
      .find((line) => line.startsWith(`"${named}"`));
    assert.ok(row?.includes(`the ${donor} body`), `CREDITS.csv does not credit ${donor} for ${named}`);
    assert.ok(credit?.notes?.includes(`the ${donor} body`), `${body} ${sheet} does not credit ${donor}`);
    assert.ok(credit.licenses.length > 0, `${body} ${sheet} has no license`);
  }
});

test("a download shows everyone a sheet's credit names", () => {
  // A download lists the first credit covering a path, so a credit naming one sheet never appears on its own.
  type Credit = { file: string; notes?: string; authors: string[]; licenses: string[]; urls?: string[] };
  const folders = readdirSync("sheet_definitions", { recursive: true, encoding: "utf8" });
  let checked = 0;
  for (const name of folders.filter((file) => file.endsWith(".json"))) {
    const definition = JSON.parse(readFileSync(`sheet_definitions/${name}`, "utf8")) as { credits?: Credit[] };
    const credits = definition.credits ?? [];
    for (const sheet of credits.filter(({ file }) => /\/(?:[a-z_]+\/)?idle(?:\.png)?$|\/(?:shoot|climb|emote|1h_backslash|1h_halfslash)\.png$/.test(file))) {
      for (const covering of credits) {
        if (covering === sheet || !sheet.file.replace(/\.png$/, "").startsWith(`${covering.file}/`)) continue;
        checked += 1;
        for (const author of sheet.authors) assert.ok(covering.authors.includes(author), `${covering.file} omits ${author}`);
        for (const url of sheet.urls ?? []) assert.ok(covering.urls?.includes(url), `${covering.file} omits ${url}`);
        const unshared = covering.licenses.filter((license) => !sheet.licenses.includes(license));
        const stated = sheet.licenses.join(", ");
        assert.ok(unshared.length === 0 || covering.notes?.includes(`${stated} only`), `${covering.file} claims ${unshared.join(", ")} for ${sheet.file}`);
      }
    }
  }
  assert.ok(checked > 0, "the check found sheet credits");
});

test("neck parts and the hurt animation are not rebuilt", () => {
  for (const { part, sheet } of manifest()) {
    assert.ok(!part.startsWith("headwear/neck/"), `${part} is outside what the check covers`);
    assert.notEqual(sheet, "hurt");
  }
});
