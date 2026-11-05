/**
 * Part thumbnails, drawn from the real sprite for the current body and colors,
 * only once a tile scrolls into view. Nothing is generated ahead of time, so a
 * thumbnail can never disagree with what wearing the part looks like.
 */
import m from "mithril";
import { getImageToDraw } from "../canvas/palette-recolor.ts";
import { customAnimations } from "../custom-animations.ts";
import type { CatalogReader } from "../state/catalog.ts";
import { FRAME_SIZE } from "../state/constants.ts";
import { getLayersToLoad } from "../state/meta.ts";
import type { State } from "../state/state.ts";

const THUMB_SIZE = 96;
const MAX_ZOOM = 3;
const MAX_CONCURRENT = 6;
const CACHE_LIMIT = 800;
const RETRY_DELAY_MS = 1500;

type ThumbAttrs = {
  catalog: CatalogReader;
  state: State;
  itemId: string;
  variant: string | null;
  recolors: Record<string, string> | null;
};

type ThumbState = {
  attrs: ThumbAttrs;
  key: string;
  visible: boolean;
  drawnKey: string | null;
};

const cache = new Map<string, HTMLCanvasElement | null>();
const waiting: (() => Promise<void>)[] = [];
let running = 0;

function pump(): void {
  while (running < MAX_CONCURRENT && waiting.length > 0) {
    const job = waiting.pop()!;
    running++;
    void job().finally(() => {
      running--;
      pump();
    });
  }
}

function loadImage(path: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = path;
  });
}

/** Bounds of the opaque pixels in a frame, or null when the frame is empty. */
function opaqueBounds(
  frame: CanvasRenderingContext2D,
  size: number,
): { x: number; y: number; w: number; h: number } | null {
  const { data } = frame.getImageData(0, 0, size, size);
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[(y * size + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0
    ? null
    : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

type Frame = { row: number; column: number };

/** Facing the viewer first; a part hidden from the front falls back to its sides. */
function framesToTry(previewRow: number, previewCol: number): Frame[] {
  return [previewRow, 2, 3, 1, 0].flatMap((row) => [
    { row, column: previewCol },
    { row, column: previewCol + 1 },
    { row, column: previewCol + 3 },
  ]);
}

/** Crops the first non-empty frame out of `images` and fits it to a thumbnail. */
function fitFirstFrame(
  images: readonly CanvasImageSource[],
  frameSize: number,
  frames: readonly Frame[],
  offsetX: number,
  offsetY: number,
): HTMLCanvasElement | null {
  const frame = document.createElement("canvas");
  frame.width = frame.height = frameSize;
  const frameCtx = frame.getContext("2d", { willReadFrequently: true })!;
  for (const { row, column } of frames) {
    frameCtx.clearRect(0, 0, frameSize, frameSize);
    for (const img of images) {
      frameCtx.drawImage(
        img,
        column * frameSize + offsetX,
        row * frameSize + offsetY,
        frameSize,
        frameSize,
        0,
        0,
        frameSize,
        frameSize,
      );
    }
    const bounds = opaqueBounds(frameCtx, frameSize);
    if (!bounds) continue;

    const out = document.createElement("canvas");
    out.width = out.height = THUMB_SIZE;
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    const fit = THUMB_SIZE / Math.max(bounds.w, bounds.h);
    const zoom = fit >= 1 ? Math.min(MAX_ZOOM, Math.floor(fit)) : fit;
    const w = Math.round(bounds.w * zoom);
    const h = Math.round(bounds.h * zoom);
    ctx.drawImage(
      frame,
      bounds.x,
      bounds.y,
      bounds.w,
      bounds.h,
      Math.floor((THUMB_SIZE - w) / 2),
      Math.floor((THUMB_SIZE - h) / 2),
      w,
      h,
    );
    return out;
  }
  return null;
}

async function loadRecolored(
  attrs: ThumbAttrs,
  paths: readonly string[],
): Promise<CanvasImageSource[]> {
  const images = await Promise.all(
    paths.map(async (path) => {
      const img = await loadImage(path);
      if (!img) return null;
      return getImageToDraw(
        attrs.catalog,
        img,
        attrs.itemId,
        attrs.recolors,
        path,
      );
    }),
  );
  return images.filter((img) => img !== null) as CanvasImageSource[];
}

async function renderThumbnail(
  attrs: ThumbAttrs,
): Promise<HTMLCanvasElement | null> {
  const { catalog, state, itemId, variant } = attrs;
  await catalog.ready.onLayersReady;
  const meta = catalog.getItemMerged(itemId).unwrapOr(null);
  if (!meta) return null;
  const extra = meta as typeof meta & {
    preview_column?: number;
    preview_x_offset?: number;
    preview_y_offset?: number;
  };

  const customLayers = Object.values(meta.layers).filter(
    (layer) => layer.custom_animation,
  );
  const customPaths = new Set(
    customLayers.map((layer) => `spritesheets/${layer[state.bodyType]}.png`),
  );
  const standard = getLayersToLoad(
    catalog,
    meta,
    state.bodyType,
    state.selections,
    variant,
  ).filter((layer) => !customPaths.has(layer.path));
  const images = await loadRecolored(
    attrs,
    standard.map((layer) => layer.path),
  );
  const drawn =
    images.length > 0
      ? fitFirstFrame(
          images,
          FRAME_SIZE,
          framesToTry(meta.preview_row ?? 2, extra.preview_column ?? 0),
          extra.preview_x_offset ?? 0,
          extra.preview_y_offset ?? 0,
        )
      : null;
  if (drawn) return drawn;

  // Tools and some weapons are only drawn on an oversized animation's own sheet.
  const name = customLayers[0]?.custom_animation;
  const def = name ? customAnimations[name] : undefined;
  if (!def) return null;
  const sheet = await loadRecolored(
    attrs,
    customLayers
      .filter(
        (layer) =>
          layer.custom_animation === name &&
          typeof layer[state.bodyType] === "string",
      )
      .map((layer) => `spritesheets/${layer[state.bodyType]}.png`),
  );
  return sheet.length > 0
    ? fitFirstFrame(sheet, def.frameSize, framesToTry(2, 0), 0, 0)
    : null;
}

function thumbKey(attrs: ThumbAttrs): string {
  return [
    attrs.itemId,
    attrs.state.bodyType,
    attrs.variant ?? "",
    JSON.stringify(attrs.recolors),
    attrs.state.selections.head?.itemId ?? "",
  ].join("|");
}

function drawInto(dom: Element, source: HTMLCanvasElement | null): void {
  const canvas = dom as HTMLCanvasElement;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
  canvas.dataset.thumb = source ? "drawn" : "empty";
  if (source) ctx.drawImage(source, 0, 0);
}

function request(vnode: m.VnodeDOM<ThumbAttrs, ThumbState>): void {
  const key = vnode.state.key;
  if (!vnode.state.visible || vnode.state.drawnKey === key) return;
  vnode.state.drawnKey = key;
  if (cache.has(key)) {
    drawInto(vnode.dom, cache.get(key) ?? null);
    return;
  }
  const attrs = vnode.state.attrs;
  waiting.push(async () => {
    if (!vnode.dom.isConnected || vnode.state.key !== key) {
      if (vnode.state.drawnKey === key) vnode.state.drawnKey = null;
      return;
    }
    // A second try before calling a part empty: a blank tile gets hidden, so one
    // slow or dropped request must not make a real part vanish from the list.
    let result = await renderThumbnail(attrs).catch(() => null);
    if (!result) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      result = await renderThumbnail(attrs).catch(() => null);
    }
    if (cache.size >= CACHE_LIMIT) {
      cache.delete(cache.keys().next().value as string);
    }
    cache.set(key, result);
    if (vnode.dom.isConnected && vnode.state.key === key) {
      drawInto(vnode.dom, result);
    }
  });
  pump();
}

const visibilityCallbacks = new WeakMap<Element, () => void>();
const observer =
  typeof IntersectionObserver === "undefined"
    ? null
    : new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) visibilityCallbacks.get(entry.target)?.();
          }
        },
        { rootMargin: "300px" },
      );

export const Thumb: m.Component<ThumbAttrs, ThumbState> = {
  oninit(vnode) {
    vnode.state.attrs = vnode.attrs;
    vnode.state.key = thumbKey(vnode.attrs);
    vnode.state.visible = false;
    vnode.state.drawnKey = null;
  },
  oncreate(vnode) {
    visibilityCallbacks.set(vnode.dom, () => {
      vnode.state.visible = true;
      observer?.unobserve(vnode.dom);
      request(vnode);
    });
    if (observer) observer.observe(vnode.dom);
    else {
      vnode.state.visible = true;
      request(vnode);
    }
  },
  onupdate(vnode) {
    vnode.state.attrs = vnode.attrs;
    vnode.state.key = thumbKey(vnode.attrs);
    request(vnode);
  },
  onremove(vnode) {
    observer?.unobserve(vnode.dom);
  },
  view() {
    return m("canvas.forge-thumb", {
      width: THUMB_SIZE,
      height: THUMB_SIZE,
    });
  },
};
