"""Fill a body-worn part's missing animations by mapping each new frame back onto older frames of the body.

Every pixel of a newer frame asks where the base body, a plain long shirt and plain pants look most like this in the older
animations. Those answers are cleaned up into a few solid pieces per frame, and the part copies its own pixels from there.
The body, shirt and pants only steer the map, so nothing is drawn by hand and no art comes from outside the part. Its authors
and licenses stand.

Skirts do not follow each leg, so below the waist a long hem follows the torso instead and holds still. Capes and tails hang
from the upper body and hold their shape, so they follow the head the way backpacks do.

With real sheets hidden, 59 complete male garments overlap the real art by 0.66 to 0.79 depending on the animation, against
0.37 to 0.68 for copying one whole older frame. That is below the bar the other fill tools use, so every part filled here
carries unchecked_animations in its definition. The app flags those parts until a person has looked at them.

Every sheet written is listed in tools/filled-from-body.csv, so real art can replace it later.

usage: fill_from_body.py <repo root> [--apply]
Without --apply it only plans.
"""
import collections
import csv
import glob
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation, gaussian_filter, label
from scipy.spatial import cKDTree

import fill_animations as fa

ROOT = sys.argv[1]
APPLY = "--apply" in sys.argv
ART = fa.ART
DEFS = fa.DEFS
MANIFEST = os.path.join(ROOT, "tools", "filled-from-body.csv")
TWINS = os.path.join(ROOT, "tools", "filled-twins.csv")

SCOPE = ("torso/", "legs/", "feet/", "arms/", "body/")
OUT_OF_SCOPE = ("torso/backpack/", "body/wings/", "body/body.json", "body/shadow.json", "body/wheelchair.json")
FOLLOW_HEAD = ("torso/cape/", "body/tails/")
SOURCES = ["spellcast", "thrust", "walk", "slash", "shoot"]
TARGETS = [sheet for sheet in fa.SHEETS if sheet != "hurt"]  # Parts fall over with the body in hurt, and no method here fits.
BODIES = ["male", "female", "pregnant", "teen", "child"]  # Muscular is left for later; it shares the male path where it can.
SHIRTS = {"male": "torso/clothes/longsleeve/longsleeves/male/", "female": "torso/clothes/longsleeve/longsleeves/female/", "pregnant": "torso/clothes/longsleeve/longsleeves/female/", "teen": "torso/clothes/longsleeve/longsleeves/teen/"}
PANTS = {"male": "legs/pants/male/", "female": "legs/pants/thin/", "pregnant": "legs/pants/thin/", "teen": "legs/pants/thin/"}
TORSO_TABLES = {"male": "male", "female": "female", "pregnant": "female", "teen": "teen"}
PATCH = 3  # Pixels around each pixel that are compared.
GROW = 5  # How far past the body the map reaches, for baggy cloth.
POSITION = 0.03  # How much a pixel's place in the frame counts next to its surroundings.
DIMENSIONS = 32
MOVES = 16  # Solid pieces considered per frame.
AGREE = 0.6  # How strongly a pixel favors what its neighbors chose.
ROUNDS = 4
WAIST_DROP = 3  # The waist, in pixels below the top of the pants.
LEG_DROP = 9  # Below this far under the waist, cloth clear of the legs means a skirt.
SKIRT_PIXELS = 20  # Per frame of walk. Pantaloons reach 16, the slit dress 21.
# A detached scrap this small is a stray piece of the map. Small parts such as buttons are all scraps, so they are left alone.
SPECK_RULES = ((150, 10), (80, 4))  # (frame has at least this many pixels, remove scraps smaller than this)
WEIGHTS = np.exp(-((np.mgrid[-PATCH:PATCH + 1, -PATCH:PATCH + 1] ** 2).sum(0)) / (2 * 2.0 ** 2)).ravel() ** 0.5
BLANK = np.zeros((64, 64, 4), np.uint8)


def channel(frame):
    lum = (0.3 * frame[..., 0] + 0.59 * frame[..., 1] + 0.11 * frame[..., 2]) / 255
    return np.where(frame[..., 3] > 0, 0.3 + 0.7 * lum, 0).astype(np.float32)


def moved_channel(values, dx, dy):
    out = np.zeros_like(values)
    h, w = values.shape
    from_y, to_y = (0, dy) if dy >= 0 else (-dy, 0)
    from_x, to_x = (0, dx) if dx >= 0 else (-dx, 0)
    keep_h, keep_w = h - abs(dy), w - abs(dx)
    if keep_h > 0 and keep_w > 0:
        out[to_y:to_y + keep_h, to_x:to_x + keep_w] = values[from_y:from_y + keep_h, from_x:from_x + keep_w]
    return out


class BodyMap:
    """For one body and one set of source sheets: each target frame as solid pieces of older frames."""

    def __init__(self, body, sources):
        self.folders = [fa.BODY_GUIDES[body]] + ([SHIRTS[body], PANTS[body]] if body in SHIRTS else [])
        self.sheets = {f: fa.read_sheets(f, None, fa.SHEETS) for f in self.folders}
        lead = self.sheets[self.folders[0]]
        self.lead = lead
        self.order, self.trees, self.index, self.basis, self.mean = {}, {}, {}, {}, {}
        self.pieces = {}
        for facing in fa.FACINGS:
            order = [(s, k) for s in sources for k in sorted(lead.get(s, {})) if k[0] == facing and fa.has_art(lead[s][k])]
            self.order[facing] = order
            if not order:
                continue
            features, where = [], []
            for i, (s, k) in enumerate(order):
                f, ys, xs = self.features(s, k)
                features.append(f)
                where.append(np.c_[np.full(len(ys), i), ys, xs])
            features, where = np.vstack(features), np.vstack(where)
            mean = features[:, :-2].mean(0)
            sample = features[:: max(1, len(features) // 20000), :-2] - mean
            basis = np.linalg.svd(sample, full_matrices=False)[2][:DIMENSIONS]
            self.trees[facing] = cKDTree(np.c_[(features[:, :-2] - mean) @ basis.T, features[:, -2:]])
            self.index[facing], self.basis[facing], self.mean[facing] = where, basis, mean

    def channels(self, s, k):
        return np.stack([channel(self.sheets[f][s][k]) if s in self.sheets[f] and k in self.sheets[f][s] else np.zeros((64, 64), np.float32) for f in self.folders])

    def features(self, s, k):
        chs = self.channels(s, k)
        ys, xs = np.nonzero(binary_dilation((chs > 0).any(0), iterations=GROW))
        steps = np.arange(-PATCH, PATCH + 1)
        rows = []
        for c in chs:
            pad = np.pad(c, PATCH)
            rows.append(np.stack([pad[ys + PATCH + dy, xs + PATCH + dx] for dy in steps for dx in steps], 1) * WEIGHTS)
        return np.c_[np.hstack(rows), ys * POSITION, xs * POSITION], ys, xs

    def solve(self, s, k):
        facing = k[0]
        f, ys, xs = self.features(s, k)
        nearest = self.trees[facing].query(np.c_[(f[:, :-2] - self.mean[facing]) @ self.basis[facing].T, f[:, -2:]], workers=4)[1]
        src = self.index[facing][nearest]
        votes = collections.Counter(zip(src[:, 0].tolist(), (src[:, 1] - ys).tolist(), (src[:, 2] - xs).tolist()))
        moves = [move for move, _ in votes.most_common(MOVES)]
        here = self.channels(s, k)
        costs = []
        for i, dy, dx in moves:
            other = self.channels(*self.order[facing][i])
            shifted = np.stack([moved_channel(c, -dx, -dy) for c in other])
            costs.append(gaussian_filter(np.abs(shifted - here).sum(0), 1.2))
        costs = np.stack(costs)
        chosen = costs.argmin(0)
        for _ in range(ROUNDS):
            agree = np.stack([gaussian_filter((chosen == i).astype(np.float32), 1.5) for i in range(len(moves))])
            chosen = (costs - AGREE * agree).argmin(0)
        mask = np.zeros((64, 64), bool)
        mask[ys, xs] = True
        return mask, chosen, moves

    def frame(self, old, s, k):
        if k[0] not in self.trees or k not in self.lead.get(s, {}) or not fa.has_art(self.lead[s][k]):
            return BLANK
        if (s, k) not in self.pieces:
            self.pieces[(s, k)] = self.solve(s, k)
        mask, chosen, moves = self.pieces[(s, k)]
        out = np.zeros((64, 64, 4), np.uint8)
        for i, (fi, dy, dx) in enumerate(moves):
            source, key = self.order[k[0]][fi]
            frame = old.get(source, {}).get(key)
            if frame is not None:
                take = (chosen == i) & mask
                out[take] = fa.moved(frame, -dx, -dy)[take]
        return out


def without_specks(frame):
    solid = frame[..., 3] > 0
    total = np.count_nonzero(solid)
    smallest = next((size for least, size in SPECK_RULES if total >= least), 0)
    if not smallest:
        return frame
    parts, n = label(solid, structure=np.ones((3, 3), bool))
    out = frame.copy()
    for i in range(1, n + 1):
        if np.count_nonzero(parts == i) < smallest:
            out[parts == i] = 0
    return out


def is_skirted(old, pants):
    """True when walk shows cloth well below the waist and clear of the legs."""
    pixels = frames = 0
    for key, frame in old.get("walk", {}).items():
        leg = pants.get(key)
        if leg is None or not fa.has_art(leg):
            continue
        legs = leg[..., 3] > 0
        cloth = frame[..., 3] > 0
        cloth[: np.where(legs.any(1))[0][0] + LEG_DROP] = False
        pixels += np.count_nonzero(cloth & ~binary_dilation(legs, iterations=1))
        frames += 1
    return frames > 0 and pixels / frames > SKIRT_PIXELS


def waist(pants, sheet, key):
    leg = pants.get(sheet, {}).get(key)
    if leg is None or not fa.has_art(leg):
        return None
    return int(np.where((leg[..., 3] > 0).any(1))[0][0]) + WAIST_DROP


def made_by_tools():
    made = set()
    for name in (fa.MANIFEST, TWINS, MANIFEST):
        if os.path.exists(name):
            with open(name, encoding="utf8", newline="") as f:
                made |= {(r["path"], r["sheet"]) for r in csv.DictReader(f)}
    return made


def definitions():
    for p in sorted(glob.glob(DEFS + "/**/*.json", recursive=True)):
        rel = os.path.relpath(p, DEFS).replace("\\", "/")
        if os.path.basename(p).startswith("meta_") or not rel.startswith(SCOPE) or rel.startswith(OUT_OF_SCOPE):
            continue
        yield p, rel, json.load(open(p, encoding="utf8"))


def own_sheets():
    if not os.path.exists(MANIFEST):
        return set()
    with open(MANIFEST, encoding="utf8", newline="") as f:
        return {(r["path"], r["sheet"]) for r in csv.DictReader(f)}


def plan():
    """{(path, sheet): (body, part)}, and each path's fellow layers. Sheets this tool wrote before are rebuilt; any other sheet stands."""
    own = own_sheets()
    wanted, fellows = {}, {}
    for _, rel, d in definitions():
        for body in BODIES:
            paths = fa.layer_paths(d, body)
            if not paths:
                continue
            for sheet in TARGETS:
                if any(fa.has_sheet(p, sheet) and (p, sheet) not in own for p in paths):
                    continue
                if not os.path.exists(os.path.join(ART, "body/bodies", body, sheet + ".png")):
                    continue
                for p in paths:
                    wanted.setdefault((p, sheet), (body, rel))
                    fellows[p] = paths
    return wanted, fellows


def main():
    made = made_by_tools()
    wanted, fellows = plan()
    print("sheets to fill (one per layer path)", len(wanted), "parts", len({rel for _, rel in wanted.values()}), flush=True)
    print("by sheet", collections.Counter(s for _, s in wanted).most_common())
    print("by group", collections.Counter(rel.rsplit("/", 1)[0] for _, rel in wanted.values()).most_common())
    print("files, counting one per color", sum(len(fa.colors_of(p)) for p, _ in wanted), flush=True)
    if not APPLY:
        return
    maps, tables, leg_art = {}, {}, {}

    def body_map(body, sources):
        key = (body, tuple(sources))
        if key not in maps:
            maps[key] = BodyMap(body, sources)
            print("map ready", body, sources, flush=True)
        return maps[key]

    def table(name):
        if name not in tables:
            tables[name] = fa.HeadTable(name, TARGETS)
            print("table ready", name, flush=True)
        return tables[name]

    def pants_of(body):
        if body not in leg_art:
            leg_art[body] = fa.read_sheets(PANTS[body], None, fa.SHEETS) if body in PANTS else {}
        return leg_art[body]

    report, nothing = [], []
    written = collections.defaultdict(set)
    fa.MIN_MATCH = 0.0  # Every frame draws something; a person judges these by the flag.
    for done, ((path, sheet), (body, rel)) in enumerate(sorted(wanted.items())):
        if done % 200 == 0:
            print("working", done, "of", len(wanted), flush=True)
        real = lambda q: [s for s in SOURCES if fa.has_sheet(q, s) and (q, s) not in made]
        sources = real(path)
        if not sources:
            nothing.append((path, sheet, "no older sheets"))
            continue
        base = fa.load(os.path.join(ART, "body/bodies", body, sheet + ".png"))
        rows = base.shape[0] // 64
        cols = base.shape[1] // 64
        others = [fa.read_sheets(q, fa.colors_of(q)[0], real(q)) for q in fellows[path] if q != path]
        first = fa.read_sheets(path, fa.colors_of(path)[0], sources)
        follows_head = rel.startswith(FOLLOW_HEAD)
        skirted = not follows_head and body in PANTS and is_skirted(first, pants_of(body).get("walk", {}))
        method = "head" if follows_head else "map and hem" if skirted else "map"
        for color in fa.colors_of(path):
            old = fa.read_sheets(path, color, sources)
            if follows_head:
                out, _ = fa.rebuild(table(fa.HEADS[fa.HEAD_OF_BODY[body]]), sheet, old, [old] + others)
            else:
                mapper = body_map(body, sources)
                still = None
                if skirted:
                    still, _ = fa.rebuild(table(fa.TORSO_GUIDES[TORSO_TABLES[body]]), sheet, old, [old] + others)
                out = np.zeros((rows * 64, cols * 64, 4), np.uint8)
                for r in range(rows):
                    for c in range(cols):
                        key = (fa.facing_of(sheet, r, rows), c)
                        frame = mapper.frame(old, sheet, key)
                        line = waist(pants_of(body), sheet, key) if still is not None else None
                        if line is not None:
                            frame = frame.copy()
                            frame[line:] = still[r * 64 + line:(r + 1) * 64, c * 64:(c + 1) * 64]
                        out[r * 64:(r + 1) * 64, c * 64:(c + 1) * 64] = without_specks(frame)
            if out is None or not (out[..., 3] > 0).any():
                nothing.append((path, sheet, color or ""))
                continue
            f = fa.sheet_file(path, sheet, color)
            if APPLY:
                os.makedirs(os.path.dirname(f), exist_ok=True)
                Image.fromarray(out, "RGBA").save(f, optimize=True)
            written[rel].add(sheet)
            report.append({"part": rel, "path": path, "sheet": sheet, "color": color or "", "body": body, "method": method})
    print("sheets written" if APPLY else "sheets planned", len(report), "| nothing to draw", len(nothing), "| parts", len(written), flush=True)
    print("nothing to draw, first few", nothing[:12])
    print("by method", collections.Counter(r["method"] for r in report).most_common())
    if not APPLY:
        return
    for p, rel, d in definitions():
        sheets = [s for s in fa.SHEETS if s in written.get(rel, ())]
        if not sheets:
            continue
        d["animations"] = fa.add_claims(d, sheets)
        flagged = {*d.get("unchecked_animations", []), *(fa.CLAIMS[s][-1] for s in sheets)}
        d["unchecked_animations"] = [claim for s in fa.SHEETS for claim in fa.CLAIMS[s] if claim in flagged]
        names = ", ".join(s.replace("_", " ") for s in sheets)
        how = "to follow the head" if rel.startswith(FOLLOW_HEAD) else "guided by a map of the base body"
        note = f"Rebuilt from this part's own frames {how}: {names}."
        for credit in d.get("credits", []):
            if note not in credit.get("notes", ""):
                credit["notes"] = (credit.get("notes", "") + " " + note).strip()
        with open(p, "w", encoding="utf8", newline="\n") as f:
            f.write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
    earlier = []
    if os.path.exists(MANIFEST):
        with open(MANIFEST, encoding="utf8", newline="") as f:
            earlier = [r for r in csv.DictReader(f) if (r["path"], r["sheet"]) not in wanted]
    with open(MANIFEST, "w", encoding="utf8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["part", "path", "sheet", "color", "body", "method"], lineterminator="\n")
        w.writeheader()
        w.writerows(sorted(earlier + report, key=lambda r: (r["part"], r["path"], r["sheet"], r["color"])))


if __name__ == "__main__":
    main()
