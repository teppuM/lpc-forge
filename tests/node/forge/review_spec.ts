import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  flagState,
  isStillToCheck,
  reviewsToText,
  setReviewNote,
  toggleVerdict,
  type Reviews,
} from "../../../sources/forge/review.ts";

const CLAIMS: Record<string, string> = {
  combat_idle: "combat",
  backslash: "1h_backslash",
  halfslash: "1h_halfslash",
};

test("a verdict is set, replaced, and cleared by pressing it again", () => {
  let reviews: Reviews = {};
  reviews = toggleVerdict(reviews, "coat", "run", "good", "male");
  assert.equal(reviews.coat.run.verdict, "good");
  assert.equal(reviews.coat.run.body, "male");
  reviews = toggleVerdict(reviews, "coat", "run", "needs-work", "female");
  assert.equal(reviews.coat.run.verdict, "needs-work");
  assert.equal(reviews.coat.run.body, "female");
  reviews = toggleVerdict(reviews, "coat", "run", "needs-work", "female");
  assert.deepEqual(reviews, {});
});

test("a note survives clearing the verdict, and an empty entry goes away", () => {
  let reviews: Reviews = toggleVerdict({}, "coat", "run", "good", "male");
  reviews = setReviewNote(reviews, "coat", "run", "sleeve looks off", "male");
  reviews = toggleVerdict(reviews, "coat", "run", "good", "male");
  assert.equal(reviews.coat.run.note, "sleeve looks off");
  assert.equal(reviews.coat.run.verdict, undefined);
  reviews = setReviewNote(reviews, "coat", "run", "", "male");
  assert.deepEqual(reviews, {});
});

test("the flag turns green only when all is good, and red on any complaint", () => {
  const unchecked = ["run", "sit"];
  assert.equal(flagState(unchecked, undefined), "unchecked");
  assert.equal(flagState(unchecked, { run: { verdict: "good" } }), "unchecked");
  assert.equal(
    flagState(unchecked, {
      run: { verdict: "good" },
      sit: { verdict: "good" },
    }),
    "good",
  );
  assert.equal(
    flagState(unchecked, { run: { verdict: "needs-work" } }),
    "needs-work",
  );
});

test("a part is still to check until every flagged animation has a verdict", () => {
  const unchecked = ["run", "sit"];
  assert.equal(isStillToCheck(unchecked, { run: { note: "hm" } }), true);
  assert.equal(
    isStillToCheck(unchecked, {
      run: { verdict: "needs-work" },
      sit: { verdict: "good" },
    }),
    false,
  );
});

test("the text names each verdict with its part, animation, body, note and id", () => {
  const reviews: Reviews = {
    coat: { run: { verdict: "needs-work", note: "jagged", body: "male" } },
  };
  const text = reviewsToText(
    [
      { itemId: "coat", name: "Coat", unchecked: ["run", "1h_backslash"] },
      { itemId: "skirt", name: "Skirt", unchecked: ["sit"] },
    ],
    reviews,
    (animation) => animation.toUpperCase(),
  );
  assert.match(text, /1 of 2 flagged parts/);
  assert.match(text, /Coat \| RUN \| needs work \| male \| jagged \| coat/);
  assert.doesNotMatch(text, /Skirt/);
});

test("every sheet built from the body map exists, is claimed, flagged and credited", () => {
  const [header, ...lines] = readFileSync("tools/filled-from-body.csv", "utf8")
    .trim()
    .split("\n");
  assert.ok(lines.length > 0, "the manifest lists the built sheets");
  const names = header.split(",");
  for (const line of lines) {
    const row = Object.fromEntries(
      line.split(",").map((value, i) => [names[i], value]),
    ) as Record<string, string>;
    const file = row.color
      ? `spritesheets/${row.path}${row.sheet}/${row.color}.png`
      : `spritesheets/${row.path}${row.sheet}.png`;
    assert.ok(existsSync(file), `${file} is missing`);
    const definition = JSON.parse(
      readFileSync(`sheet_definitions/${row.part}`, "utf8"),
    ) as {
      animations?: string[];
      unchecked_animations?: string[];
      credits?: { notes?: string }[];
    };
    const claim = CLAIMS[row.sheet] ?? row.sheet;
    assert.ok(
      definition.animations?.includes(claim),
      `${row.part} does not claim ${claim}`,
    );
    assert.ok(
      definition.unchecked_animations?.includes(claim),
      `${row.part} does not flag ${claim}`,
    );
    assert.ok(
      definition.credits?.every((credit) =>
        credit.notes?.includes("Rebuilt from this part's own frames"),
      ),
      `${row.part} does not note the rebuild in its credits`,
    );
  }
});

test("every flagged animation is one the part claims", () => {
  const [, ...lines] = readFileSync("tools/filled-from-body.csv", "utf8")
    .trim()
    .split("\n");
  for (const part of new Set(lines.map((line) => line.split(",")[0]))) {
    const definition = JSON.parse(
      readFileSync(`sheet_definitions/${part}`, "utf8"),
    ) as {
      animations?: string[];
      unchecked_animations?: string[];
    };
    for (const animation of definition.unchecked_animations ?? []) {
      assert.ok(
        definition.animations?.includes(animation),
        `${part} flags ${animation} without claiming it`,
      );
    }
  }
});
