import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { ok, err } from "neverthrow";
import {
  animationPlayOrder,
  animationZipFilename,
  buildAnimationZip,
  chooseTokenFrame,
  clipsForAnimation,
  customAnimationRects,
  cutClipFrames,
  encodeGif,
  framePath,
  frameFromSheet,
  gifPath,
  planAnimationExport,
  planAnimations,
  playableColumns,
  scaleImage,
  stripFromFrames,
  stripPath,
  wornParts,
  type AnimationExportDeps,
  type RgbaImage,
  type WornPart,
} from "../../../sources/forge/animation-export.ts";
import { ANIMATIONS } from "../../../sources/state/constants.ts";
import { setJsonDeps, resetJsonDeps } from "../../../sources/state/json.ts";
import type { ZipFolder } from "../../../sources/utils/zip-helpers.ts";
import type { CatalogReader } from "../../../sources/state/catalog.ts";
import type { State } from "../../../sources/state/state.ts";

const EXPORTABLE = ANIMATIONS.filter((a) => !a.noExport).map((a) => a.value);

function blankImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function paint(
  image: RgbaImage,
  x: number,
  y: number,
  [r, g, b, a]: readonly number[],
): void {
  image.data.set([r, g, b, a], (y * image.width + x) * 4);
}

function pixel(image: RgbaImage, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4;
  return [...image.data.subarray(at, at + 4)];
}

// ── A separate GIF reader, so the encoder is not marking its own work ───────

type ParsedGif = {
  version: string;
  width: number;
  height: number;
  palette: number[][];
  loops: boolean;
  frames: {
    delay: number;
    disposal: number;
    transparentFlag: boolean;
    transparentIndex: number;
    width: number;
    height: number;
    indexes: number[];
  }[];
};

function lzwDecode(data: number[], minCodeSize: number): number[] {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const reset = (): number[][] => {
    const table: number[][] = [];
    for (let i = 0; i < clear; i++) table[i] = [i];
    table[clear] = [];
    table[end] = [];
    return table;
  };
  let table = reset();
  let size = minCodeSize + 1;
  let previous: number[] | null = null;
  const out: number[] = [];
  let bitAt = 0;
  for (;;) {
    let code = 0;
    for (let i = 0; i < size; i++, bitAt++) {
      const byte = data[bitAt >> 3];
      assert.notEqual(byte, undefined, "ran out of bits before end of image");
      code |= ((byte >> (bitAt & 7)) & 1) << i;
    }
    if (code === end) return out;
    if (code === clear) {
      table = reset();
      size = minCodeSize + 1;
      previous = null;
      continue;
    }
    let entry: number[];
    if (code < table.length) {
      entry = table[code];
    } else {
      assert.equal(code, table.length, "code beyond the table");
      assert.ok(previous, "new code straight after a clear");
      entry = [...previous, previous[0]];
    }
    out.push(...entry);
    if (previous && table.length < 4096) {
      table.push([...previous, entry[0]]);
      if (table.length === 1 << size && size < 12) size++;
    }
    previous = entry;
  }
}

function parseGif(bytes: Uint8Array): ParsedGif {
  let at = 0;
  const u8 = (): number => bytes[at++];
  const u16 = (): number => bytes[at++] | (bytes[at++] << 8);
  const text = (count: number): string => {
    at += count;
    return String.fromCharCode(...bytes.subarray(at - count, at));
  };
  const subBlocks = (): number[] => {
    const out: number[] = [];
    for (let size = u8(); size > 0; size = u8()) {
      out.push(...bytes.subarray(at, at + size));
      at += size;
    }
    return out;
  };

  const version = text(6);
  const width = u16();
  const height = u16();
  const packed = u8();
  at += 2;
  assert.ok(packed & 0x80, "global color table flag");
  const palette: number[][] = [];
  for (let i = 0; i < 1 << ((packed & 7) + 1); i++) {
    palette.push([u8(), u8(), u8()]);
  }

  const parsed: ParsedGif = {
    version,
    width,
    height,
    palette,
    loops: false,
    frames: [],
  };
  let control = { delay: 0, disposal: 0, flag: false, index: 0 };
  for (;;) {
    const block = u8();
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        assert.equal(u8(), 4);
        const flags = u8();
        const delay = u16();
        control = {
          delay,
          disposal: (flags >> 2) & 7,
          flag: !!(flags & 1),
          index: u8(),
        };
        assert.equal(u8(), 0);
      } else {
        const size = u8();
        const name = text(size);
        const payload = subBlocks();
        if (name === "NETSCAPE2.0") {
          parsed.loops = payload[0] === 1 && (payload[1] | payload[2]) === 0;
        }
      }
    } else {
      assert.equal(block, 0x2c, `unexpected block ${block} at ${at - 1}`);
      u16();
      u16();
      const frameWidth = u16();
      const frameHeight = u16();
      assert.equal(u8() & 0x80, 0, "no local color table");
      const minCodeSize = u8();
      parsed.frames.push({
        delay: control.delay,
        disposal: control.disposal,
        transparentFlag: control.flag,
        transparentIndex: control.index,
        width: frameWidth,
        height: frameHeight,
        indexes: lzwDecode(subBlocks(), minCodeSize),
      });
    }
  }
  assert.equal(at, bytes.length, "nothing after the trailer");
  return parsed;
}

/** Decoded frame pixels are the source's: right color, or transparent. */
function assertGifFrameMatches(
  gif: ParsedGif,
  frameIndex: number,
  source: RgbaImage,
): void {
  const { indexes, transparentIndex } = gif.frames[frameIndex];
  assert.equal(indexes.length, source.width * source.height);
  for (let p = 0; p < indexes.length; p++) {
    const at = p * 4;
    if (source.data[at + 3] < 128) {
      assert.equal(indexes[p], transparentIndex, `pixel ${p} is transparent`);
    } else {
      assert.notEqual(indexes[p], transparentIndex, `pixel ${p} is opaque`);
      assert.deepEqual(gif.palette[indexes[p]], [
        source.data[at],
        source.data[at + 1],
        source.data[at + 2],
      ]);
    }
  }
}

// ── Play orders and clips ───────────────────────────────────────────────────

test("walk skips its standing frame and idle holds a beat", () => {
  assert.deepEqual(animationPlayOrder("walk"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(animationPlayOrder("idle"), [0, 0, 1]);
  assert.deepEqual(animationPlayOrder("slash"), [0, 1, 2, 3, 4, 5]);
});

test("custom play orders come from the custom definition", () => {
  assert.deepEqual(animationPlayOrder("slash_oversize"), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(animationPlayOrder("walk_128"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(animationPlayOrder("tool_whip").length, 8);
  assert.deepEqual(animationPlayOrder("no_such_animation"), []);
});

test("standard clips face up, left, down, right except hurt and climb", () => {
  const facings = (name: string): string[] =>
    clipsForAnimation(name).map((clip) => clip.facing);
  assert.deepEqual(facings("walk"), ["up", "left", "down", "right"]);
  assert.deepEqual(facings("hurt"), ["down"]);
  assert.deepEqual(facings("climb"), ["up"]);
  assert.equal(clipsForAnimation("walk")[2].frameSize, 64);
  assert.equal(clipsForAnimation("walk")[2].row, 2);
  assert.deepEqual(clipsForAnimation("no_such_animation"), []);
});

test("custom clips read their true frame size and row layout", () => {
  const clips = clipsForAnimation("slash_oversize");
  assert.deepEqual(
    clips.map(({ facing, row, frameSize, columns, kind }) => ({
      facing,
      row,
      frameSize,
      columns,
      kind,
    })),
    ["up", "left", "down", "right"].map((facing, row) => ({
      facing,
      row,
      frameSize: 192,
      columns: 6,
      kind: "custom",
    })),
  );
  assert.equal(clipsForAnimation("tool_rod")[0].frameSize, 128);
  assert.equal(clipsForAnimation("tool_rod")[0].columns, 13);
  assert.equal(clipsForAnimation("wheelchair")[3].facing, "right");
  assert.deepEqual(clipsForAnimation("walk_128")[0].order[0], 1);
});

test("a stray frame spec does not change a custom row's facing", () => {
  // whip_oversize's down row ends in "slash-w,1".
  assert.equal(clipsForAnimation("whip_oversize")[2].facing, "down");
});

test("playable columns drop blank frames and fall back to what is drawn", () => {
  assert.deepEqual(playableColumns([1, 2, 3], [0, 1, 3]), [1, 3]);
  assert.deepEqual(playableColumns([0, 0, 1], [0, 1]), [0, 0, 1]);
  assert.deepEqual(playableColumns([1, 2], [0]), [0]);
  assert.deepEqual(playableColumns([1, 2], []), []);
});

// ── Pixels ──────────────────────────────────────────────────────────────────

test("scaling is nearest neighbour and leaves scale 1 alone", () => {
  const source = blankImage(2, 2);
  paint(source, 0, 0, [10, 20, 30, 255]);
  paint(source, 1, 0, [40, 50, 60, 255]);
  paint(source, 0, 1, [70, 80, 90, 128]);
  assert.equal(scaleImage(source, 1), source);

  const big = scaleImage(source, 3);
  assert.equal(big.width, 6);
  assert.equal(big.height, 6);
  assert.equal(big.data.length, 6 * 6 * 4);
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) {
      assert.deepEqual(
        pixel(big, x, y),
        pixel(source, Math.floor(x / 3), Math.floor(y / 3)),
        `${x},${y}`,
      );
    }
  }
});

test("frames come off the sheet at the clip's own size, blanks left out", () => {
  const sheet = blankImage(192 * 6, 192 * 4);
  paint(sheet, 192 * 3 + 5, 192 * 2 + 7, [1, 2, 3, 255]);
  paint(sheet, 192 * 0 + 1, 192 * 2 + 1, [4, 5, 6, 255]);
  const clip = clipsForAnimation("slash_oversize")[2];
  const cut = cutClipFrames(sheet, clip);
  assert.deepEqual([...cut.keys()], [0, 3]);
  const frame = cut.get(3)!;
  assert.equal(frame.width, 192);
  assert.deepEqual(pixel(frame, 5, 7), [1, 2, 3, 255]);
  assert.equal(frameFromSheet(sheet, 4, 0, 192), null);
  assert.equal(frameFromSheet(sheet, 0, 6, 192), null);
});

test("a strip lays frames side by side in play order, repeats included", () => {
  const a = blankImage(2, 2);
  paint(a, 1, 1, [9, 9, 9, 255]);
  const b = blankImage(2, 2);
  paint(b, 0, 0, [7, 7, 7, 255]);
  const strip = stripFromFrames([a, a, b]);
  assert.equal(strip.width, 6);
  assert.equal(strip.height, 2);
  assert.deepEqual(pixel(strip, 1, 1), [9, 9, 9, 255]);
  assert.deepEqual(pixel(strip, 3, 1), [9, 9, 9, 255]);
  assert.deepEqual(pixel(strip, 4, 0), [7, 7, 7, 255]);
  assert.deepEqual(pixel(strip, 0, 0), [0, 0, 0, 0]);
  assert.throws(() => stripFromFrames([]), RangeError);
});

// ── GIF ─────────────────────────────────────────────────────────────────────

test("a GIF has its header, frame count, loop and transparent index", () => {
  const first = blankImage(4, 3);
  paint(first, 0, 0, [255, 0, 0, 255]);
  paint(first, 3, 2, [0, 255, 0, 255]);
  const second = blankImage(4, 3);
  paint(second, 1, 1, [0, 0, 255, 255]);
  paint(second, 2, 1, [255, 0, 0, 40]); // below the cutoff: transparent
  const bytes = encodeGif([first, second, first], 8);

  assert.equal(String.fromCharCode(...bytes.subarray(0, 6)), "GIF89a");
  assert.equal(bytes[bytes.length - 1], 0x3b);

  const gif = parseGif(bytes);
  assert.equal(gif.width, 4);
  assert.equal(gif.height, 3);
  assert.equal(gif.loops, true);
  assert.equal(gif.frames.length, 3);
  for (const frame of gif.frames) {
    assert.equal(frame.transparentFlag, true);
    assert.equal(frame.transparentIndex, 0);
    assert.equal(frame.disposal, 2);
    assert.equal(frame.delay, 13); // 100 / 8, rounded, in hundredths of a second
    assert.equal(frame.width, 4);
    assert.equal(frame.height, 3);
  }
  assertGifFrameMatches(gif, 0, first);
  assertGifFrameMatches(gif, 1, second);
  assertGifFrameMatches(gif, 2, first);
});

test("the frame delay follows frames per second, with a floor", () => {
  const frame = blankImage(1, 1);
  const delay = (fps: number): number =>
    parseGif(encodeGif([frame], fps)).frames[0].delay;
  assert.equal(delay(10), 10);
  assert.equal(delay(1), 100);
  assert.equal(delay(1000), 2);
  assert.throws(() => encodeGif([frame], 0), RangeError);
  assert.throws(() => encodeGif([], 8), RangeError);
});

test("a wholly transparent GIF still decodes", () => {
  const frame = blankImage(3, 3);
  const gif = parseGif(encodeGif([frame], 8));
  assert.equal(gif.frames.length, 1);
  assert.deepEqual(gif.frames[0].indexes, new Array(9).fill(0));
});

test("long noisy frames survive the LZW table filling and clearing", () => {
  const frame = blankImage(256, 256);
  let seed = 12345;
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const shade = (seed >> 16) & 15;
      paint(frame, x, y, [shade * 16, shade * 8, shade * 4, 255]);
    }
  }
  const gif = parseGif(encodeGif([frame], 8));
  assertGifFrameMatches(gif, 0, frame);
});

test("more than 255 colors reduces the palette instead of breaking", () => {
  const frame = blankImage(32, 32);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      paint(frame, x, y, [x * 8, y * 8, (x ^ y) * 8, 255]);
    }
  }
  const gif = parseGif(encodeGif([frame], 8));
  assert.ok(gif.palette.length <= 256);
  const { indexes } = gif.frames[0];
  assert.equal(indexes.length, 32 * 32);
  assert.ok(!indexes.includes(0), "nothing went transparent");
  assert.ok(indexes.every((index) => index < gif.palette.length));
  assert.ok(new Set(indexes).size > 16, "the reduction kept real variety");
});

// ── File names ──────────────────────────────────────────────────────────────

test("file names follow the layout", () => {
  assert.equal(gifPath("walk", "down"), "gifs/walk_down.gif");
  assert.equal(
    stripPath("slash_oversize", "left"),
    "strips/slash_oversize_left.png",
  );
  assert.equal(framePath("walk", "up", 3), "frames/walk/up/03.png");
  assert.equal(framePath("shoot", "up", 12), "frames/shoot/up/12.png");
  assert.equal(
    animationZipFilename("male", 2, "2026-11-06T10-00-00"),
    "lpc_male_animations_2x_2026-11-06T10-00-00.zip",
  );
});

test("custom animations stack below the standard sheet in drawn order", () => {
  const rects = customAnimationRects(
    ["slash_128", "nonsense", "slash_oversize"],
    3456,
  );
  assert.deepEqual(rects.get("slash_128"), {
    x: 0,
    y: 3456,
    width: 768,
    height: 512,
  });
  assert.deepEqual(rects.get("slash_oversize"), {
    x: 0,
    y: 3968,
    width: 1152,
    height: 768,
  });
  assert.equal(rects.has("nonsense"), false);
});

// ── What goes in ────────────────────────────────────────────────────────────

const BODY: WornPart = {
  name: "Body",
  animations: [...EXPORTABLE, "watering", "1h_slash"],
};
const MACE: WornPart = {
  name: "Mace",
  animations: ["walk", "hurt", "slash_oversize"],
};

test("a mace keeps walk, hurt and its oversized slash, and says what is gone", () => {
  const plan = planAnimations([BODY, MACE], ["slash_oversize"]);
  assert.deepEqual(
    plan.included.map((a) => a.animation),
    ["walk", "hurt", "slash_oversize"],
  );
  assert.ok(plan.included.every((a) => a.complete));
  assert.equal(plan.included[2].kind, "custom");

  const spellcast = plan.missing.find((a) => a.animation === "spellcast");
  assert.deepEqual(spellcast?.parts, ["Mace"]);
  assert.equal(spellcast?.included, false);
  assert.equal(spellcast?.label, "Spellcast");

  assert.deepEqual(
    plan.missing.map((a) => a.animation),
    EXPORTABLE.filter((name) => name !== "walk" && name !== "hurt"),
  );
  assert.ok(!plan.missing.some((a) => a.animation === "slash_oversize"));
});

test("the real Mace definition gives the same answer as the fixture", () => {
  const definition = JSON.parse(
    readFileSync(
      new URL(
        "../../../sheet_definitions/weapons/blunt/weapon_blunt_mace.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { name: string; animations: string[] };
  const plan = planAnimations(
    [BODY, { name: definition.name, animations: definition.animations }],
    ["slash_oversize"],
  );
  assert.deepEqual(
    plan.included.map((a) => a.animation),
    ["walk", "hurt", "slash_oversize"],
  );
});

test("includeIncomplete takes everything and still reports the gaps", () => {
  const plan = planAnimations([BODY, MACE], ["slash_oversize"], true);
  assert.deepEqual(
    plan.included.map((a) => a.animation),
    [...EXPORTABLE, "slash_oversize"],
  );
  const spellcast = plan.included.find((a) => a.animation === "spellcast");
  assert.equal(spellcast?.complete, false);
  const missing = plan.missing.find((a) => a.animation === "spellcast");
  assert.deepEqual(missing?.parts, ["Mace"]);
  assert.equal(missing?.included, true);
});

test("every part that lacks an animation is named", () => {
  const hat: WornPart = { name: "Hat", animations: ["walk", "idle"] };
  const plan = planAnimations([BODY, MACE, hat], []);
  assert.deepEqual(
    plan.included.map((a) => a.animation),
    ["walk"],
  );
  assert.deepEqual(plan.missing.find((a) => a.animation === "slash")?.parts, [
    "Mace",
    "Hat",
  ]);
  assert.deepEqual(plan.missing.find((a) => a.animation === "hurt")?.parts, [
    "Hat",
  ]);
});

test("a custom animation always goes in but owns up to a part it lacks", () => {
  const hat: WornPart = { name: "Hat", animations: ["walk", "idle"] };
  const helm: WornPart = { name: "Helm", animations: ["walk", "slash"] };
  const plan = planAnimations([BODY, MACE, hat, helm], ["slash_oversize"]);
  const custom = plan.included.find((a) => a.animation === "slash_oversize");
  assert.equal(custom?.complete, false);
  const missing = plan.missing.find((a) => a.animation === "slash_oversize");
  assert.deepEqual(missing?.parts, ["Hat"]);
  assert.equal(missing?.included, true);
});

test("a custom animation's base row counts under its metadata name", () => {
  const armor: WornPart = { name: "Armor", animations: ["1h_backslash"] };
  const plan = planAnimations([armor], ["backslash_128"]);
  assert.equal(
    plan.included.find((a) => a.animation === "backslash_128")?.complete,
    true,
  );
});

test("a part listing no animations holds nothing back, as the note has it", () => {
  const plain: WornPart = { name: "Plain", animations: [] };
  const plan = planAnimations([BODY, plain], []);
  assert.deepEqual(
    plan.included.map((a) => a.animation),
    EXPORTABLE,
  );
  assert.deepEqual(plan.missing, []);
});

test("rows flagged noExport and unknown custom names never appear", () => {
  const plan = planAnimations([BODY], ["nonsense"], true);
  const names = plan.included.map((a) => a.animation);
  assert.ok(!names.includes("watering"));
  assert.ok(!names.includes("1h_slash"));
  assert.ok(!names.includes("nonsense"));
});

// ── Worn parts ──────────────────────────────────────────────────────────────

function liteCatalog(
  items: Record<string, { name: string; animations: string[] }>,
  required: string[] = ["male"],
): Pick<CatalogReader, "getItemLite"> {
  return {
    getItemLite: (id: string) =>
      items[id]
        ? ok({
            ...items[id],
            type_name: id,
            required,
            recolors: [],
            matchBodyColor: false,
            variants: [],
            path: [],
          })
        : err({ kind: "not-found", itemId: id } as never),
  };
}

test("recolor slots and unknown items are not worn parts", () => {
  const catalog = liteCatalog({
    mace: { name: "Mace", animations: ["walk"] },
  });
  const { drawn, notDrawn } = wornParts(
    catalog,
    {
      weapon: { itemId: "mace", name: "Mace", variant: "mace" },
      trim: { itemId: "mace", name: "Mace", variant: "mace", subId: 1 },
      gone: { itemId: "gone", name: "Gone", variant: "x" },
    },
    "male",
  );
  assert.deepEqual(drawn, [{ name: "Mace", animations: ["walk"] }]);
  assert.deepEqual(notDrawn, []);
});

test("a part with no art for the body is set apart, not held against anything", () => {
  const catalog = liteCatalog(
    { mace: { name: "Mace", animations: ["walk"] } },
    ["male"],
  );
  const plan = planAnimationExport(
    catalog,
    {
      bodyType: "teen",
      selections: { weapon: { itemId: "mace", name: "Mace", variant: "mace" } },
    },
    false,
    [],
  );
  assert.deepEqual(plan.partsNotDrawn, ["Mace"]);
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.included.length, EXPORTABLE.length);
});

// ── Token ───────────────────────────────────────────────────────────────────

test("the token prefers a front-facing standing frame showing every part", () => {
  const candidate = (
    animation: string,
    facing: string,
    complete: boolean,
    columns: number[] = [0, 1],
  ) => ({ animation, facing, complete, columns });

  assert.deepEqual(
    chooseTokenFrame([
      candidate("walk", "up", true),
      candidate("walk", "down", true),
      candidate("idle", "down", true),
    ]),
    { animation: "idle", facing: "down", column: 0 },
  );
  // Idle would lose the mace, so walk wins even with includeIncomplete on.
  assert.deepEqual(
    chooseTokenFrame([
      candidate("idle", "down", false),
      candidate("walk", "down", true),
    ]),
    { animation: "walk", facing: "down", column: 0 },
  );
  assert.deepEqual(
    chooseTokenFrame([
      candidate("slash_oversize", "down", true),
      candidate("walk_128", "down", true),
    ]),
    { animation: "walk_128", facing: "down", column: 0 },
  );
  assert.deepEqual(chooseTokenFrame([candidate("climb", "up", true)]), {
    animation: "climb",
    facing: "up",
    column: 0,
  });
  assert.deepEqual(
    chooseTokenFrame([candidate("walk", "down", true, [3, 4])]),
    {
      animation: "walk",
      facing: "down",
      column: 3,
    },
  );
  assert.equal(chooseTokenFrame([candidate("walk", "down", true, [])]), null);
  assert.equal(chooseTokenFrame([]), null);
});

// ── The whole ZIP, with fake pixels in place of the renderer ────────────────

function drawnSheet(animation: string): RgbaImage {
  const clips = clipsForAnimation(animation);
  const { frameSize } = clips[0];
  const sheet = blankImage(
    frameSize * clips[0].columns,
    frameSize * clips.length,
  );
  clips.forEach((clip, row) => {
    for (let column = 0; column < clip.columns; column++) {
      // Only the columns the animation has: a standard row is 13 wide.
      if (clip.kind === "standard" && column > Math.max(...clip.order))
        continue;
      paint(sheet, column * frameSize + 1, row * frameSize + 1, [
        (column + 1) * 10,
        (row + 1) * 10,
        200,
        255,
      ]);
    }
  });
  return sheet;
}

/** JSZip cannot read a Blob in Node, where it has no FileReader; a browser can. */
function nodeZip(zip: JSZip = new JSZip()): ZipFolder {
  return {
    folder: (name) => nodeZip(zip.folder(name)!),
    file: (name, data) => {
      zip.file(name, data instanceof Blob ? data.arrayBuffer() : data);
    },
    generateAsync: (options) => zip.generateAsync(options),
  };
}

function pngStub(image: RgbaImage): Promise<Blob> {
  return Promise.resolve(new Blob([`${image.width}x${image.height}`]));
}

function fakeDeps(
  overrides: Partial<AnimationExportDeps> = {},
): Partial<AnimationExportDeps> {
  return {
    customInUse: () => ["slash_oversize"],
    readSheets: (animations) =>
      new Map(animations.map((a) => [a.animation, drawnSheet(a.animation)])),
    encodePng: pngStub,
    createZip: () => nodeZip(),
    ...overrides,
  };
}

const MACE_CREDIT = {
  file: "weapon/blunt/mace",
  notes: "",
  authors: ["A Mace Author"],
  licenses: ["CC-BY-SA 3.0"],
  urls: ["https://example.com/mace"],
};

function maceCatalog(): CatalogReader {
  const items: Record<string, { name: string; animations: string[] }> = {
    body: { name: "Body", animations: BODY.animations as string[] },
    mace: { name: "Mace", animations: MACE.animations as string[] },
  };
  const merged = (id: string) => ({
    ...items[id],
    type_name: id,
    required: ["male"],
    recolors: [],
    matchBodyColor: false,
    variants: [],
    path: [],
    layers: { layer_1: { zPos: 10, male: `${MACE_CREDIT.file}/` } },
    credits: id === "mace" ? [MACE_CREDIT] : [],
  });
  return {
    ...liteCatalog(items),
    getItemMerged: (id: string) => ok(merged(id)),
  } as unknown as CatalogReader;
}

function maceState(overrides: Partial<State> = {}): State {
  return {
    bodyType: "male",
    selectedAnimation: "walk",
    isRenderingCharacter: false,
    selections: {
      body: { itemId: "body", name: "Body", variant: "light" },
      weapon: { itemId: "mace", name: "Mace", variant: "mace" },
    },
    ...overrides,
  } as unknown as State;
}

function stubJsonDeps(): void {
  setJsonDeps({
    getHashParamsforSelections: () => ({}),
    createHashStringFromParams: () => "",
    getLocationOrigin: () => "http://localhost",
    getLocationPathname: () => "/",
  });
}

afterEach(() => resetJsonDeps());

async function entriesOf(blob: Blob): Promise<JSZip> {
  return JSZip.loadAsync(await blob.arrayBuffer());
}

test("the ZIP holds the oversized slash at its true size, and the credits", async () => {
  stubJsonDeps();
  const result = await buildAnimationZip(
    maceCatalog(),
    maceState(),
    { scale: 1, fps: 10, frames: true },
    fakeDeps(),
  );

  assert.match(result.filename, /^lpc_male_animations_1x_.*\.zip$/);
  assert.deepEqual(
    result.included.map((a) => [a.animation, a.frameSize, a.frameCount]),
    [
      ["walk", 64, 8],
      ["hurt", 64, 6],
      ["slash_oversize", 192, 6],
    ],
  );
  assert.deepEqual(result.included[1].facings, ["down"]);
  assert.deepEqual(result.included[2].facings, ["up", "left", "down", "right"]);
  assert.deepEqual(
    result.missing.find((a) => a.animation === "spellcast")?.parts,
    ["Mace"],
  );
  assert.deepEqual(result.blankClips, []);
  assert.deepEqual(result.token, {
    animation: "walk",
    facing: "down",
    column: 0,
  });

  const zip = await entriesOf(result.blob);
  const names = Object.keys(zip.files);
  const has = (name: string): boolean => names.includes(name);

  for (const facing of ["up", "left", "down", "right"]) {
    assert.ok(has(`gifs/slash_oversize_${facing}.gif`), facing);
    assert.ok(has(`strips/slash_oversize_${facing}.png`), facing);
    assert.ok(has(`frames/slash_oversize/${facing}/05.png`), facing);
    assert.ok(has(`gifs/walk_${facing}.gif`), facing);
  }
  assert.ok(has("gifs/hurt_down.gif"));
  assert.ok(!has("gifs/hurt_up.gif"));
  assert.ok(!names.some((name) => name.includes("spellcast")));
  assert.ok(!names.some((name) => name.startsWith("standard/")));
  // The frames folder keeps the standing frame the GIF skips.
  assert.ok(has("frames/walk/down/00.png"));

  const gifBytes = await zip
    .file("gifs/slash_oversize_down.gif")!
    .async("uint8array");
  const gif = parseGif(gifBytes);
  assert.equal(gif.width, 192);
  assert.equal(gif.height, 192);
  assert.equal(gif.frames.length, 6);
  assert.equal(gif.loops, true);
  assert.equal(gif.frames[0].delay, 10);

  const walkGif = parseGif(
    await zip.file("gifs/walk_down.gif")!.async("uint8array"),
  );
  assert.equal(walkGif.width, 64);
  assert.equal(walkGif.frames.length, 8);

  const strip = zip.file("strips/slash_oversize_down.png")!;
  assert.equal(await strip.async("string"), `${192 * 6}x192`);
  assert.equal(await zip.file("token.png")!.async("string"), "64x64");

  const credits = await zip.file("credits/credits.txt")!.async("string");
  assert.match(credits, /A Mace Author/);
  assert.ok(has("credits/credits.csv"));
  const character = JSON.parse(
    await zip.file("character.json")!.async("string"),
  );
  assert.equal(character.bodyType, "male");

  const metadata = JSON.parse(
    await zip.file("credits/metadata.json")!.async("string"),
  );
  assert.deepEqual(
    metadata.missing.find((a: { animation: string }) => a.animation === "shoot")
      .parts,
    ["Mace"],
  );
  assert.equal(metadata.included[2].frameSize, 192);
});

test("scale multiplies every output and switches turn folders off", async () => {
  stubJsonDeps();
  const result = await buildAnimationZip(
    maceCatalog(),
    maceState(),
    { scale: 2, gifs: true, strips: false, frames: false, token: false },
    fakeDeps(),
  );
  assert.match(result.filename, /_2x_/);
  assert.equal(result.token, null);
  assert.equal(result.included[2].frameSize, 192);

  const zip = await entriesOf(result.blob);
  const names = Object.keys(zip.files);
  assert.ok(!names.some((name) => name.startsWith("strips/")));
  assert.ok(!names.some((name) => name.startsWith("frames/")));
  assert.ok(!names.includes("token.png"));
  assert.ok(names.includes("credits/credits.txt"));

  const gif = parseGif(
    await zip.file("gifs/slash_oversize_up.gif")!.async("uint8array"),
  );
  assert.equal(gif.width, 384);
  assert.equal(gif.height, 384);
});

test("includeIncomplete writes the gaps too, and the token keeps the mace", async () => {
  stubJsonDeps();
  const result = await buildAnimationZip(
    maceCatalog(),
    maceState(),
    { includeIncomplete: true },
    fakeDeps(),
  );
  assert.ok(result.included.some((a) => a.animation === "spellcast"));
  assert.equal(
    result.missing.find((a) => a.animation === "spellcast")?.included,
    true,
  );
  // Idle is drawn but lacks the mace; walk has it.
  assert.deepEqual(result.token, {
    animation: "walk",
    facing: "down",
    column: 0,
  });
  const zip = await entriesOf(result.blob);
  assert.ok(zip.file("gifs/spellcast_down.gif"));
});

test("a clip with nothing drawn is reported and written nowhere", async () => {
  stubJsonDeps();
  const result = await buildAnimationZip(
    maceCatalog(),
    maceState(),
    {},
    fakeDeps({
      readSheets: (animations) => {
        const sheets = new Map<string, RgbaImage>();
        for (const { animation } of animations) {
          // Hurt has no sheet at all; walk has an empty up row.
          if (animation === "hurt") continue;
          const sheet = drawnSheet(animation);
          if (animation === "walk") sheet.data.fill(0, 0, 832 * 64 * 4);
          sheets.set(animation, sheet);
        }
        return sheets;
      },
    }),
  );
  assert.deepEqual(result.blankClips, ["walk_up", "hurt_down"]);
  assert.deepEqual(
    result.included.map((a) => a.animation),
    ["walk", "slash_oversize"],
  );
  assert.deepEqual(result.included[0].facings, ["left", "down", "right"]);
  const zip = await entriesOf(result.blob);
  assert.equal(zip.file("gifs/walk_up.gif"), null);
  assert.equal(zip.file("gifs/hurt_down.gif"), null);
});

test("the sheet is not read while the character is being drawn", async () => {
  stubJsonDeps();
  const state = maceState({ isRenderingCharacter: true });
  let readWhileDrawing = false;
  setTimeout(() => {
    state.isRenderingCharacter = false;
  }, 120);
  await buildAnimationZip(
    maceCatalog(),
    state,
    { gifs: false, strips: false, token: false },
    fakeDeps({
      readSheets: (animations) => {
        readWhileDrawing = state.isRenderingCharacter;
        return new Map(
          animations.map((a) => [a.animation, drawnSheet(a.animation)]),
        );
      },
    }),
  );
  assert.equal(readWhileDrawing, false);
});

test("a failure rejects rather than producing a partial ZIP", async () => {
  stubJsonDeps();
  await assert.rejects(
    buildAnimationZip(
      maceCatalog(),
      maceState(),
      {},
      fakeDeps({
        encodePng: () => Promise.reject(new Error("no blob")),
      }),
    ),
    /no blob/,
  );
});
