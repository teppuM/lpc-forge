/**
 * Ready-made animations from the character on screen: looping GIFs, strips,
 * single frames and a token, all cut from the sheet the renderer already drew.
 *
 * The first half of this file is pure and has no DOM dependency. Only
 * `buildAnimationZip` and its default dependencies touch the renderer's canvas.
 */

import {
  ANIMATIONS,
  ANIMATION_CONFIGS,
  DIRECTIONS,
  FRAME_SIZE,
  STANDARD_ANIMATION_FRAMES_PER_ROW,
} from "../state/constants.ts";
import {
  customAnimationBase,
  customAnimationSize,
  customAnimations,
  type CustomAnimationDefinition,
} from "../custom-animations.ts";
import {
  SHEET_HEIGHT,
  addedCustomAnimations,
  canvas,
  drawCalls,
  extractAnimationFromCanvas,
} from "../canvas/renderer.ts";
import { canvasToBlob, get2DContext } from "../canvas/canvas-utils.ts";
import {
  addCharacterJsonAndCredits,
  newAnimationFromSheet,
  zipExportTimestamp,
  zipGenerateBlobWithProfiler,
  type ZipFolder,
} from "../utils/zip-helpers.ts";
import { createZipExportProfiler } from "../performance-profiler.ts";
import {
  beginZipExportUiSuspend,
  endZipExportUiSuspend,
} from "../utils/zip-export-ui-suspend.ts";
import { humanize } from "./parts-index.ts";
import type { CatalogReader } from "../state/catalog.ts";
import type { Selections, State } from "../state/state.ts";

/** The shape of browser `ImageData`, usable without a DOM. */
export type RgbaImage = {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
};

export type AnimationKind = "standard" | "custom";

/** One animation in one facing. */
export type AnimationClip = {
  animation: string;
  kind: AnimationKind;
  facing: string;
  /** Row inside this animation's own sheet, not the full character sheet. */
  row: number;
  frameSize: number;
  /** Columns the row holds, drawn or not. */
  columns: number;
  /** Columns in the order they play. */
  order: readonly number[];
};

// ────────────────────────────────────────────────────────────────────────────
// Clips and play orders
// ────────────────────────────────────────────────────────────────────────────

const STANDARD_CONFIGS = ANIMATION_CONFIGS as Record<
  string,
  { row: number; num: number; cycle: number[] } | undefined
>;

/** The one-row standard animations, which were only ever drawn in one facing. */
const SINGLE_FACING: Readonly<Record<string, string>> = {
  hurt: "down",
  climb: "up",
};

const FACING_BY_SUFFIX: Readonly<Record<string, string>> = {
  n: "up",
  w: "left",
  s: "down",
  e: "right",
};

function range(count: number, from: number = 0): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => i + from);
}

function customOrder(
  definition: CustomAnimationDefinition,
  columns: number,
): number[] {
  return definition.skipFirstFrameInPreview
    ? range(columns - 1, 1)
    : range(columns);
}

/**
 * The columns an animation plays, in order: walk skips its standing frame, idle
 * holds a beat. Empty for a name that is not an animation.
 */
export function animationPlayOrder(animation: string): number[] {
  const custom = customAnimations[animation];
  if (custom) return customOrder(custom, custom.frames[0].length);
  return [...(STANDARD_CONFIGS[animation]?.cycle ?? [])];
}

/** Every clip of an animation, read from the same tables the renderer draws by. */
export function clipsForAnimation(animation: string): AnimationClip[] {
  const custom = customAnimations[animation];
  if (custom) {
    return custom.frames.map((frames, row) => ({
      animation,
      kind: "custom",
      // "slash-n,0" is the north row, wherever the definition placed it.
      facing:
        FACING_BY_SUFFIX[frames[0].split(",")[0].split("-")[1]] ??
        DIRECTIONS[row],
      row,
      frameSize: custom.frameSize,
      columns: frames.length,
      order: customOrder(custom, frames.length),
    }));
  }
  const config = STANDARD_CONFIGS[animation];
  if (!config) return [];
  return range(config.num).map((row) => ({
    animation,
    kind: "standard",
    facing: SINGLE_FACING[animation] ?? DIRECTIONS[row],
    row,
    frameSize: FRAME_SIZE,
    columns: STANDARD_ANIMATION_FRAMES_PER_ROW,
    order: config.cycle,
  }));
}

/**
 * The play order with undrawn columns taken out. A row whose drawn columns fall
 * wholly outside the order plays what it does have rather than nothing.
 */
export function playableColumns(
  order: readonly number[],
  drawnColumns: readonly number[],
): number[] {
  const drawn = new Set(drawnColumns);
  const playable = order.filter((column) => drawn.has(column));
  return playable.length > 0 ? playable : [...drawnColumns];
}

// ────────────────────────────────────────────────────────────────────────────
// Pixels
// ────────────────────────────────────────────────────────────────────────────

export function isBlankImage(image: RgbaImage): boolean {
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] > 0) return false;
  }
  return true;
}

/** One frame copied out of an animation sheet, or null if it lies off the sheet. */
export function frameFromSheet(
  sheet: RgbaImage,
  row: number,
  column: number,
  frameSize: number,
): RgbaImage | null {
  if (
    (row + 1) * frameSize > sheet.height ||
    (column + 1) * frameSize > sheet.width
  ) {
    return null;
  }
  const data = new Uint8ClampedArray(frameSize * frameSize * 4);
  for (let y = 0; y < frameSize; y++) {
    const start =
      ((row * frameSize + y) * sheet.width + column * frameSize) * 4;
    data.set(
      sheet.data.subarray(start, start + frameSize * 4),
      y * frameSize * 4,
    );
  }
  return { width: frameSize, height: frameSize, data };
}

/** A clip's drawn frames by column, ascending. Blank frames are left out. */
export function cutClipFrames(
  sheet: RgbaImage,
  clip: AnimationClip,
): Map<number, RgbaImage> {
  const frames = new Map<number, RgbaImage>();
  for (let column = 0; column < clip.columns; column++) {
    const frame = frameFromSheet(sheet, clip.row, column, clip.frameSize);
    if (frame && !isBlankImage(frame)) frames.set(column, frame);
  }
  return frames;
}

/** Nearest neighbour, so pixels stay sharp. */
export function scaleImage(image: RgbaImage, scale: number): RgbaImage {
  if (scale === 1) return image;
  const width = image.width * scale;
  const height = image.height * scale;
  const data = new Uint8ClampedArray(width * height * 4);
  const rowBytes = width * 4;
  for (let y = 0; y < image.height; y++) {
    const firstRow = y * scale * rowBytes;
    let at = firstRow;
    for (let x = 0; x < image.width; x++) {
      const from = (y * image.width + x) * 4;
      for (let repeat = 0; repeat < scale; repeat++) {
        data[at++] = image.data[from];
        data[at++] = image.data[from + 1];
        data[at++] = image.data[from + 2];
        data[at++] = image.data[from + 3];
      }
    }
    for (let repeat = 1; repeat < scale; repeat++) {
      data.copyWithin(
        firstRow + repeat * rowBytes,
        firstRow,
        firstRow + rowBytes,
      );
    }
  }
  return { width, height, data };
}

/** Equal-sized frames side by side, left to right. */
export function stripFromFrames(frames: readonly RgbaImage[]): RgbaImage {
  if (frames.length === 0) throw new RangeError("A strip needs a frame.");
  const { width: frameWidth, height } = frames[0];
  const width = frameWidth * frames.length;
  const data = new Uint8ClampedArray(width * height * 4);
  frames.forEach((frame, index) => {
    for (let y = 0; y < height; y++) {
      data.set(
        frame.data.subarray(y * frameWidth * 4, (y + 1) * frameWidth * 4),
        (y * width + index * frameWidth) * 4,
      );
    }
  });
  return { width, height, data };
}

// ────────────────────────────────────────────────────────────────────────────
// GIF: looping, transparent, one shared palette
// ────────────────────────────────────────────────────────────────────────────

const ALPHA_CUTOFF = 128;
const LZW_TABLE_SIZE = 4096;

function lzwEncode(pixels: Uint8Array, minCodeSize: number): number[] {
  const clear = 1 << minCodeSize;
  const endOfImage = clear + 1;
  const out: number[] = [];
  let size = minCodeSize + 1;
  let maxCode = (1 << size) - 1;
  let next = endOfImage + 1;
  let bitBuffer = 0;
  let bitCount = 0;
  let table = new Map<number, number>();

  const emit = (code: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      out.push(bitBuffer & 255);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
    if (next > maxCode && size < 12) {
      size++;
      maxCode = size === 12 ? LZW_TABLE_SIZE : (1 << size) - 1;
    }
  };

  emit(clear);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const pixel = pixels[i];
    const key = prefix * LZW_TABLE_SIZE + pixel;
    const known = table.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    emit(prefix);
    if (next < LZW_TABLE_SIZE) {
      table.set(key, next++);
    } else {
      emit(clear);
      table = new Map();
      next = endOfImage + 1;
      size = minCodeSize + 1;
      maxCode = (1 << size) - 1;
    }
    prefix = pixel;
  }
  emit(prefix);
  emit(endOfImage);
  if (bitCount > 0) out.push(bitBuffer & 255);
  return out;
}

/**
 * Colors for every frame in one table, with index 0 kept for transparent. A
 * character of more than 255 colors drops low bits until it fits.
 */
function sharedPalette(frames: readonly RgbaImage[]): {
  palette: [number, number, number][];
  indexOf: (data: Uint8ClampedArray, at: number) => number;
} {
  const keyAt = (data: Uint8ClampedArray, at: number, shift: number): number =>
    ((data[at] >> shift) << 16) |
    ((data[at + 1] >> shift) << 8) |
    (data[at + 2] >> shift);

  for (let shift = 0; ; shift++) {
    const palette: [number, number, number][] = [];
    const index = new Map<number, number>();
    let fits = true;
    for (const { data } of frames) {
      for (let i = 0; fits && i < data.length; i += 4) {
        if (data[i + 3] < ALPHA_CUTOFF) continue;
        const key = keyAt(data, i, shift);
        if (index.has(key)) continue;
        if (palette.length === 255) {
          fits = false;
          break;
        }
        index.set(key, palette.length + 1);
        palette.push([
          (data[i] >> shift) << shift,
          (data[i + 1] >> shift) << shift,
          (data[i + 2] >> shift) << shift,
        ]);
      }
      if (!fits) break;
    }
    if (fits) {
      return {
        palette,
        indexOf: (data, at) => index.get(keyAt(data, at, shift))!,
      };
    }
  }
}

/** Encodes equal-sized RGBA frames as a looping GIF. */
export function encodeGif(
  frames: readonly RgbaImage[],
  framesPerSecond: number,
): Uint8Array<ArrayBuffer> {
  if (frames.length === 0) throw new RangeError("A GIF needs a frame.");
  if (!(framesPerSecond > 0)) {
    throw new RangeError("Frames per second must be above zero.");
  }
  const { width, height } = frames[0];
  const { palette, indexOf } = sharedPalette(frames);

  let bits = 1;
  while (1 << bits < palette.length + 1) bits++;
  const minCodeSize = Math.max(2, bits);

  const out: number[] = [];
  const word = (value: number): void => {
    out.push(value & 255, (value >> 8) & 255);
  };
  const ascii = (text: string): void => {
    for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i));
  };

  ascii("GIF89a");
  word(width);
  word(height);
  out.push(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0);
  for (let i = 0; i < 1 << bits; i++) {
    const color = i === 0 || i > palette.length ? [0, 0, 0] : palette[i - 1];
    out.push(color[0], color[1], color[2]);
  }

  out.push(0x21, 0xff, 0x0b);
  ascii("NETSCAPE2.0");
  out.push(3, 1, 0, 0, 0);

  const delay = Math.max(2, Math.round(100 / framesPerSecond));
  for (const frame of frames) {
    // Disposal 2 clears each frame, so a transparent pixel never shows the last.
    out.push(0x21, 0xf9, 4, (2 << 2) | 1);
    word(delay);
    out.push(0, 0);

    out.push(0x2c);
    word(0);
    word(0);
    word(width);
    word(height);
    out.push(0);

    const pixels = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < frame.data.length; i += 4, p++) {
      pixels[p] = frame.data[i + 3] < ALPHA_CUTOFF ? 0 : indexOf(frame.data, i);
    }
    out.push(minCodeSize);
    const compressed = lzwEncode(pixels, minCodeSize);
    for (let i = 0; i < compressed.length; i += 255) {
      const count = Math.min(255, compressed.length - i);
      out.push(count);
      for (let j = 0; j < count; j++) out.push(compressed[i + j]);
    }
    out.push(0);
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

// ────────────────────────────────────────────────────────────────────────────
// File names
// ────────────────────────────────────────────────────────────────────────────

export function clipBaseName(animation: string, facing: string): string {
  return `${animation}_${facing}`;
}

export function gifPath(animation: string, facing: string): string {
  return `gifs/${clipBaseName(animation, facing)}.gif`;
}

export function stripPath(animation: string, facing: string): string {
  return `strips/${clipBaseName(animation, facing)}.png`;
}

/** `column` is the frame's place on the sheet, so a skipped frame leaves a gap. */
export function framePath(
  animation: string,
  facing: string,
  column: number,
): string {
  return `frames/${animation}/${facing}/${String(column).padStart(2, "0")}.png`;
}

export function animationZipFilename(
  bodyType: string,
  scale: number,
  timestamp: string,
): string {
  return `lpc_${bodyType}_animations_${scale}x_${timestamp}.zip`;
}

// ────────────────────────────────────────────────────────────────────────────
// What goes in, and what each animation is missing
// ────────────────────────────────────────────────────────────────────────────

export type WornPart = { name: string; animations: readonly string[] };

export type PlannedAnimation = {
  animation: string;
  label: string;
  kind: AnimationKind;
  /** False when a worn part is not drawn in this animation. */
  complete: boolean;
};

export type MissingAnimation = {
  animation: string;
  label: string;
  kind: AnimationKind;
  /** The worn parts this animation does not show. */
  parts: string[];
  /** Whether the animation went into the ZIP anyway. */
  included: boolean;
};

export type AnimationPlan = {
  included: PlannedAnimation[];
  missing: MissingAnimation[];
};

/**
 * Metadata names that put a part into a custom animation besides the custom
 * animation's own name: the standard row its body frames are extracted from.
 */
function baseAnimationNames(definition: CustomAnimationDefinition): string[] {
  const base = customAnimationBase(definition);
  return ANIMATIONS.filter((a) => (a.folderName ?? a.value) === base).map(
    (a) => a.value,
  );
}

/**
 * Decides which animations go in. A standard animation goes in when every worn
 * part lists it. A part listing no animations at all is not held against any of
 * them. Each custom animation in use always goes in, because it is often a
 * weapon's only attack; a part it does not show is still reported.
 */
export function planAnimations(
  parts: readonly WornPart[],
  customInUse: Iterable<string>,
  includeIncomplete: boolean = false,
): AnimationPlan {
  const plan: AnimationPlan = { included: [], missing: [] };
  const lacking = (names: readonly string[]): string[] =>
    parts
      .filter(
        (part) =>
          part.animations.length > 0 &&
          !names.some((name) => part.animations.includes(name)),
      )
      .map((part) => part.name);

  for (const { value: animation, label, noExport } of ANIMATIONS) {
    if (noExport) continue;
    const absent = lacking([animation]);
    const complete = absent.length === 0;
    const kind = "standard";
    if (complete || includeIncomplete) {
      plan.included.push({ animation, label, kind, complete });
    }
    if (!complete) {
      plan.missing.push({
        animation,
        label,
        kind,
        parts: absent,
        included: includeIncomplete,
      });
    }
  }

  for (const animation of new Set(customInUse)) {
    const definition = customAnimations[animation];
    if (!definition) continue;
    const label = humanize(animation);
    const absent = lacking([animation, ...baseAnimationNames(definition)]);
    const complete = absent.length === 0;
    const kind = "custom";
    plan.included.push({ animation, label, kind, complete });
    if (!complete) {
      plan.missing.push({
        animation,
        label,
        kind,
        parts: absent,
        included: true,
      });
    }
  }
  return plan;
}

/**
 * The worn parts, read the way the preview's missing-part note reads them:
 * recolor slots are not parts. A part with no art for this body type is drawn in
 * nothing, so it cannot make one animation better than another and is set apart.
 */
export function wornParts(
  catalog: Pick<CatalogReader, "getItemLite">,
  selections: Selections,
  bodyType: string,
): { drawn: WornPart[]; notDrawn: string[] } {
  const drawn: WornPart[] = [];
  const notDrawn: string[] = [];
  for (const selection of Object.values(selections)) {
    if (selection.subId) continue;
    const meta = catalog.getItemLite(selection.itemId).unwrapOr(null);
    if (!meta) continue;
    if (meta.required.includes(bodyType)) {
      drawn.push({ name: meta.name, animations: meta.animations });
    } else {
      notDrawn.push(meta.name);
    }
  }
  return { drawn, notDrawn };
}

/** Where each custom animation sits on the sheet: stacked below the standard rows. */
export function customAnimationRects(
  names: Iterable<string>,
  startY: number,
): Map<string, { x: number; y: number; width: number; height: number }> {
  const rects = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >();
  let y = startY;
  for (const name of names) {
    const definition = customAnimations[name];
    if (!definition) continue;
    const size = customAnimationSize(definition);
    rects.set(name, { x: 0, y, ...size });
    y += size.height;
  }
  return rects;
}

export type TokenCandidate = {
  animation: string;
  facing: string;
  complete: boolean;
  /** Drawn columns, ascending. */
  columns: readonly number[];
};

export type TokenFrame = { animation: string; facing: string; column: number };

/**
 * The front-facing standing frame. An animation showing every worn part beats
 * one that does not, so a token never loses the weapon to a nicer idle pose.
 */
export function chooseTokenFrame(
  candidates: readonly TokenCandidate[],
): TokenFrame | null {
  const poseRank = (animation: string): number => {
    const custom = customAnimations[animation];
    const pose = custom ? customAnimationBase(custom) : animation;
    return pose === "idle" ? 0 : pose === "walk" ? 1 : 2;
  };
  const rank = (candidate: TokenCandidate): number =>
    (candidate.facing === "down" ? 0 : 20) +
    (candidate.complete ? 0 : 10) +
    poseRank(candidate.animation);

  let best: TokenCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.columns.length === 0) continue;
    if (!best || rank(candidate) < rank(best)) best = candidate;
  }
  return best
    ? {
        animation: best.animation,
        facing: best.facing,
        column: best.columns[0],
      }
    : null;
}

// ────────────────────────────────────────────────────────────────────────────
// The ZIP
// ────────────────────────────────────────────────────────────────────────────

export type AnimationExportOptions = {
  /** Whole-number pixel multiple. */
  scale: number;
  fps: number;
  gifs: boolean;
  strips: boolean;
  frames: boolean;
  token: boolean;
  /** Also export animations a worn part is not drawn in. */
  includeIncomplete: boolean;
};

export const DEFAULT_ANIMATION_EXPORT_OPTIONS: Readonly<AnimationExportOptions> =
  {
    scale: 1,
    fps: 8,
    gifs: true,
    strips: true,
    frames: false,
    token: true,
    includeIncomplete: false,
  };

export type IncludedAnimation = {
  animation: string;
  label: string;
  kind: AnimationKind;
  complete: boolean;
  /** Before scaling, so an oversized animation reads 192. */
  frameSize: number;
  facings: string[];
  /** Frames in the longest clip's play order. */
  frameCount: number;
};

export type AnimationZipResult = {
  blob: Blob;
  filename: string;
  /** What is in the ZIP. An animation with nothing drawn is not listed here. */
  included: IncludedAnimation[];
  /** Every animation a worn part is not drawn in, exported or not. */
  missing: MissingAnimation[];
  /** Clips with no pixels at all, such as `climb_up`, which were not written. */
  blankClips: string[];
  /** Worn parts with no art for this body type, so they are in no animation. */
  partsNotDrawn: string[];
  /** The frame `token.png` came from; null when no token was written. */
  token: TokenFrame | null;
};

/** Seams for specs; the defaults read the renderer and use the browser. */
export type AnimationExportDeps = {
  customInUse: () => Iterable<string>;
  readSheets: (
    animations: readonly PlannedAnimation[],
  ) => Map<string, RgbaImage>;
  encodePng: (image: RgbaImage) => Promise<Blob>;
  createZip: () => ZipFolder;
};

const RENDER_POLL_MS = 50;
const RENDER_TIMEOUT_MS = 30000;

function readRenderedSheets(
  animations: readonly PlannedAnimation[],
): Map<string, RgbaImage> {
  const source = canvas;
  if (!source) throw new Error("The character has not been drawn yet.");
  const rects = customAnimationRects(addedCustomAnimations, SHEET_HEIGHT);
  const sheets = new Map<string, RgbaImage>();
  for (const { animation, kind } of animations) {
    const rect = rects.get(animation);
    let sheet: HTMLCanvasElement | null = null;
    if (kind === "standard") {
      sheet = extractAnimationFromCanvas(animation);
    } else if (rect) {
      sheet = newAnimationFromSheet(source, rect).unwrapOr(null);
    }
    if (!sheet) continue;
    sheets.set(
      animation,
      get2DContext(sheet, true).getImageData(0, 0, sheet.width, sheet.height),
    );
  }
  return sheets;
}

function encodePngInBrowser(image: RgbaImage): Promise<Blob> {
  const target = document.createElement("canvas");
  target.width = image.width;
  target.height = image.height;
  get2DContext(target).putImageData(
    new ImageData(image.data, image.width, image.height),
    0,
    0,
  );
  return canvasToBlob(target);
}

function createBrowserZip(): ZipFolder {
  if (!window.JSZip) throw new Error("JSZip library not loaded");
  return new window.JSZip();
}

const DEFAULT_DEPS: AnimationExportDeps = {
  customInUse: () => addedCustomAnimations,
  readSheets: readRenderedSheets,
  encodePng: encodePngInBrowser,
  createZip: createBrowserZip,
};

function normalizeOptions(
  options: Partial<AnimationExportOptions>,
): AnimationExportOptions {
  const merged = { ...DEFAULT_ANIMATION_EXPORT_OPTIONS, ...options };
  return {
    ...merged,
    scale: Math.max(1, Math.floor(merged.scale) || 1),
    fps: Math.min(30, Math.max(1, merged.fps || 8)),
  };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The canvas is cleared and refilled during a render, so never read it then. */
async function waitForDrawnSheet(state: State): Promise<void> {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  while (state.isRenderingCharacter) {
    if (Date.now() > deadline) {
      throw new Error("The character is still being drawn. Try again shortly.");
    }
    await pause(RENDER_POLL_MS);
  }
}

/**
 * What an export would hold for the character as drawn, without building it, so
 * a panel can state what is missing before the download starts.
 */
export function planAnimationExport(
  catalog: Pick<CatalogReader, "getItemLite">,
  state: Pick<State, "selections" | "bodyType">,
  includeIncomplete: boolean = false,
  customInUse: Iterable<string> = addedCustomAnimations,
): AnimationPlan & { partsNotDrawn: string[] } {
  const { drawn, notDrawn } = wornParts(
    catalog,
    state.selections,
    state.bodyType,
  );
  return {
    ...planAnimations(drawn, customInUse, includeIncomplete),
    partsNotDrawn: notDrawn,
  };
}

/**
 * Builds the ZIP from what the renderer already drew. Rejects if the sheet cannot
 * be read or encoded; the caller shows that and offers the download of `blob`.
 *
 * Layout: gifs/, strips/, frames/, token.png, character.json, credits/.
 */
export async function buildAnimationZip(
  catalog: CatalogReader,
  state: State,
  options: Partial<AnimationExportOptions> = {},
  deps: Partial<AnimationExportDeps> = {},
): Promise<AnimationZipResult> {
  const settings = normalizeOptions(options);
  const { customInUse, readSheets, encodePng, createZip } = {
    ...DEFAULT_DEPS,
    ...deps,
  };
  const profiler = createZipExportProfiler("animationClips");

  await waitForDrawnSheet(state);
  beginZipExportUiSuspend();
  try {
    const zip = createZip();
    const timestamp = zipExportTimestamp();

    // From here to the first await nothing can redraw, so the pixels, the plan
    // and the credits all describe one drawing even if a render starts later.
    const plan = planAnimationExport(
      catalog,
      state,
      settings.includeIncomplete,
      customInUse(),
    );
    const sheets = profiler.syncPhase("render_composite_readSheets", () =>
      readSheets(plan.included),
    );
    const creditsFolder = zip.folder("credits");
    profiler.syncPhase("staticFiles", () => {
      addCharacterJsonAndCredits(catalog, state, zip, creditsFolder, drawCalls);
    });
    const bodyType = state.bodyType;

    const included: IncludedAnimation[] = [];
    const blankClips: string[] = [];
    const tokenCandidates: TokenCandidate[] = [];
    const cutFrames = new Map<string, Map<number, RgbaImage>>();

    const addPng = async (path: string, image: RgbaImage): Promise<void> => {
      zip.file(path, await encodePng(image));
    };

    for (const planned of plan.included) {
      const { animation } = planned;
      const sheet = sheets.get(animation);
      const facings: string[] = [];
      let frameSize = 0;
      let frameCount = 0;

      for (const clip of clipsForAnimation(animation)) {
        const { facing } = clip;
        const cut = sheet
          ? cutClipFrames(sheet, clip)
          : new Map<number, RgbaImage>();
        if (cut.size === 0) {
          blankClips.push(clipBaseName(animation, facing));
          continue;
        }
        const columns = [...cut.keys()];
        const order = playableColumns(clip.order, columns);
        facings.push(facing);
        frameSize = clip.frameSize;
        frameCount = Math.max(frameCount, order.length);
        cutFrames.set(clipBaseName(animation, facing), cut);
        tokenCandidates.push({
          animation,
          facing,
          complete: planned.complete,
          columns,
        });

        if (settings.gifs || settings.strips) {
          const played = order.map((column) =>
            scaleImage(cut.get(column)!, settings.scale),
          );
          if (settings.gifs) {
            const gif = encodeGif(played, settings.fps);
            zip.file(
              gifPath(animation, facing),
              new Blob([gif], { type: "image/gif" }),
            );
          }
          if (settings.strips) {
            await addPng(stripPath(animation, facing), stripFromFrames(played));
          }
        }
        if (settings.frames) {
          for (const [column, frame] of cut) {
            await addPng(
              framePath(animation, facing, column),
              scaleImage(frame, settings.scale),
            );
          }
        }
        // GIF encoding never yields on its own, and a big pack takes a while.
        await pause(0);
      }

      if (facings.length > 0) {
        included.push({ ...planned, frameSize, facings, frameCount });
      }
    }

    let token: TokenFrame | null = null;
    if (settings.token) {
      token = chooseTokenFrame(tokenCandidates);
      if (token) {
        const frame = cutFrames
          .get(clipBaseName(token.animation, token.facing))!
          .get(token.column)!;
        await addPng("token.png", scaleImage(frame, settings.scale));
      }
    }

    creditsFolder.file(
      "metadata.json",
      JSON.stringify(
        {
          exportTimestamp: timestamp,
          bodyType,
          scale: settings.scale,
          fps: settings.fps,
          included,
          missing: plan.missing,
          blankClips,
          partsNotDrawn: plan.partsNotDrawn,
          token,
          performance: profiler.toMetadata(),
        },
        null,
        2,
      ),
    );

    const blob = await zipGenerateBlobWithProfiler(profiler, zip);
    return {
      blob,
      filename: animationZipFilename(bodyType, settings.scale, timestamp),
      included,
      missing: plan.missing,
      blankClips,
      partsNotDrawn: plan.partsNotDrawn,
      token,
    };
  } finally {
    endZipExportUiSuspend(state);
  }
}
