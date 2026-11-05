/**
 * Free color choice. A custom color travels through selections and the URL hash
 * as a recolor key like `c-a1b2c3`, and is expanded into a full ramp only when a
 * palette is needed, so saved links stay short and contain no palette data.
 */
const CUSTOM_KEY_PATTERN = /^c-[0-9a-f]{6}$/;

export function isCustomColorKey(key: string | null | undefined): boolean {
  return !!key && CUSTOM_KEY_PATTERN.test(key);
}

/** `#A1B2C3` to `c-a1b2c3`. */
export function customColorKey(hex: string): string {
  return `c-${hex.replace("#", "").toLowerCase()}`;
}

/** `c-a1b2c3` to `#a1b2c3`. */
export function customKeyToHex(key: string): string {
  return `#${key.slice(2)}`;
}

type Lab = { l: number; a: number; b: number };

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(channel: number): number {
  const c =
    channel <= 0.0031308
      ? channel * 12.92
      : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

function hexToLab(hex: string): Lab {
  const value = parseInt(hex.replace("#", ""), 16);
  const r = toLinear((value >> 16) & 255);
  const g = toLinear((value >> 8) & 255);
  const b = toLinear(value & 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function labToHex({ l, a, b }: Lab): string {
  const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const channels = [
    4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp,
    -1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp,
    -0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp,
  ];
  return `#${channels
    .map((c) => fromLinear(c).toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

/**
 * Builds a ramp for `hex` shaped like `baseRamp`. The step of `baseRamp` closest
 * in lightness to `hex` becomes exactly `hex`. Every other step keeps its offset
 * in lightness, its proportional chroma, and half its hue drift from that step,
 * so shadows and highlights stay as the artist shaded them. Hue drift is what
 * keeps a ramp from looking like a flat tint, but kept whole it pulls a strongly
 * different color back toward the original material.
 */
export function buildCustomRamp(
  hex: string,
  baseRamp: readonly string[],
): string[] {
  const target = hexToLab(hex);
  const base = baseRamp.map(hexToLab);
  let anchor = 0;
  for (let i = 1; i < base.length; i++) {
    if (Math.abs(base[i].l - target.l) < Math.abs(base[anchor].l - target.l)) {
      anchor = i;
    }
  }
  const anchorLab = base[anchor];
  const anchorChroma = Math.hypot(anchorLab.a, anchorLab.b);
  const anchorHue = Math.atan2(anchorLab.b, anchorLab.a);
  const targetChroma = Math.hypot(target.a, target.b);
  const targetHue = Math.atan2(target.b, target.a);

  return base.map((step, i) => {
    if (i === anchor) return hex.toUpperCase();
    const chromaRatio =
      anchorChroma > 0.0001 ? Math.hypot(step.a, step.b) / anchorChroma : 1;
    const chroma = targetChroma * Math.min(chromaRatio, 2);
    let drift = Math.atan2(step.b, step.a) - anchorHue;
    if (drift > Math.PI) drift -= 2 * Math.PI;
    if (drift < -Math.PI) drift += 2 * Math.PI;
    const hue = targetHue + drift / 2;
    return labToHex({
      l: Math.min(1, Math.max(0, step.l + (target.l - anchorLab.l))),
      a: chroma * Math.cos(hue),
      b: chroma * Math.sin(hue),
    });
  });
}
