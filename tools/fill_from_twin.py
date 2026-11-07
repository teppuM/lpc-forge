"""Fill a part's missing animations from a near-identical part that has them.

Laced and plain longsleeve shirts share a silhouette, so the plain shirt's run sheet shows where the laced shirt's run sheet
goes. Wherever the twin's frame exactly matches a stretch of a frame both parts have, this takes the part's own drawing of
that stretch, so its trim survives. Stretches nothing matches keep the twin's pixels, in the part's colors. Every sheet
written is listed in tools/filled-twins.csv, so real art can replace it later, and each part's credits name the twin's authors.

Overlap on the older animations predicts overlap on the newer ones closely: of pairs at 0.95 or better, about 98% stay at
0.90 or better. Few parts have a twin that close, so TWINS is short. A pair is used only if its hidden real sheets rebuild
at PASS or better; --check prints that score for every pair. Leather 2 scored 0.85 to 0.90 from leather armor. Drake's back
layer scored 0.88 and its female front 0.82 from the lizard tail, and a part's layers go together, so neither is listed.

usage: fill_from_twin.py <repo root> [--apply] [--check]
Without --apply or --check it only plans.
"""
import collections
import csv
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation, binary_opening

ROOT = sys.argv[1]
APPLY = "--apply" in sys.argv
CHECK = "--check" in sys.argv
ART = os.path.join(ROOT, "spritesheets")
DEFS = os.path.join(ROOT, "sheet_definitions")
MANIFEST = os.path.join(ROOT, "tools", "filled-twins.csv")
REBUILT = os.path.join(ROOT, "tools", "filled-animations.csv")

# Part definition: {the part's layer path: the twin's layer path}. The twin's definition supplies its credits.
TWINS = {
    "torso/shirts/longsleeve/torso_clothes_longsleeve_laced.json": ("torso/shirts/longsleeve/torso_clothes_longsleeve.json", {"torso/clothes/longsleeve/laced/male/": "torso/clothes/longsleeve/longsleeve/male/"}),
    "torso/shirts/torso_clothes_blouse_longsleeve.json": ("torso/shirts/longsleeve/torso_clothes_longsleeve.json", {"torso/clothes/blouse_longsleeve/female/": "torso/clothes/longsleeve/longsleeve/female/"}),
    "torso/shirts/sleeveless/torso_clothes_sleeveless.json": ("torso/shirts/sleeveless/torso_clothes_sleeveless1.json", {"torso/clothes/sleeveless/sleeveless/female/": "torso/clothes/sleeveless/sleeveless1/teen/"}),
}
PASS = 0.92
OLDER = ["spellcast", "thrust", "walk", "slash", "shoot", "hurt"]
NEWER = ["climb", "idle", "jump", "sit", "emote", "run", "combat_idle", "backslash", "halfslash"]
CLAIMS = {"combat_idle": "combat", "backslash": "1h_backslash", "halfslash": "1h_halfslash"}
DEFAULT_CLAIMS = ["spellcast", "thrust", "walk", "slash", "shoot", "hurt", "watering"]
ONE_ROW = {"climb": "n", "hurt": "s"}
FACINGS = "nwse"
SHIFTS = [(dy, dx) for dy in range(-4, 5) for dx in range(-2, 3)]
STRETCH = np.ones((5, 5), bool)  # The smallest stretch that counts as a match.
CANDIDATES = 30
MOST_SOURCES = 6
LEAST_GAIN = 10

with open(REBUILT, encoding="utf8", newline="") as f:
    MADE = {(r["path"], r["sheet"]) for r in csv.DictReader(f)}
with_twin_rows = []
if os.path.exists(MANIFEST):
    with open(MANIFEST, encoding="utf8", newline="") as f:
        with_twin_rows = list(csv.DictReader(f))
MADE |= {(r["path"], r["sheet"]) for r in with_twin_rows}
if os.path.exists(os.path.join(ROOT, "tools", "filled-from-body.csv")):
    with open(os.path.join(ROOT, "tools", "filled-from-body.csv"), encoding="utf8", newline="") as f:
        MADE |= {(r["path"], r["sheet"]) for r in csv.DictReader(f)}


def definition(rel):
    with open(os.path.join(DEFS, rel), encoding="utf8") as f:
        return json.load(f)


def sheet_file(path, sheet, color):
    return os.path.join(ART, path, sheet + ".png") if color is None else os.path.join(ART, path, sheet, color + ".png")


def colors_of(path, per_color):
    if not per_color:
        return [None]
    names = set()
    for sheet in OLDER + NEWER:
        folder = os.path.join(ART, path, sheet)
        if os.path.isdir(folder):
            names.update(n[:-4] for n in os.listdir(folder) if n.endswith(".png"))
    return sorted(names)


def load(path, sheet, color):
    f = sheet_file(path, sheet, color)
    if (path, sheet) in MADE or not os.path.exists(f):
        return None
    with Image.open(f) as image:
        pixels = np.asarray(image.convert("RGBA"))
    packed = (pixels[..., 0].astype(np.uint32) << 24) | (pixels[..., 1].astype(np.uint32) << 16) | (pixels[..., 2].astype(np.uint32) << 8) | pixels[..., 3]
    packed[pixels[..., 3] == 0] = 0
    return packed


def save(packed, path):
    pixels = np.stack([(packed >> 24) & 255, (packed >> 16) & 255, (packed >> 8) & 255, packed & 255], -1).astype(np.uint8)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(pixels, "RGBA").save(path, optimize=True)


def frames_of(image, sheet):
    columns = range(0, image.shape[1], 64)
    if sheet in ONE_ROW:
        return {ONE_ROW[sheet]: [image[:64, x:x + 64] for x in columns]}
    return {facing: [image[64 * row:64 * row + 64, x:x + 64] for x in columns] for row, facing in enumerate(FACINGS)}


def moved(frame, dy, dx):
    return np.roll(np.roll(frame, dy, 0), dx, 1)


def recolor_table(twin, twin_color, part, part_color, sheets):
    votes = collections.defaultdict(collections.Counter)
    for sheet in sheets:
        a, b = load(twin, sheet, twin_color), load(part, sheet, part_color)
        if a is None or b is None or a.shape != b.shape:
            continue
        both = (a > 0) & (b > 0)
        for x, y in zip(a[both].tolist(), b[both].tolist()):
            votes[x][y] += 1
    return {x: c.most_common(1)[0][0] for x, c in votes.items()}


def recolored(frame, table):
    def rgb(v):
        return np.array([(v >> 24) & 255, (v >> 16) & 255, (v >> 8) & 255], float)

    out = np.zeros_like(frame)
    known = sorted(set(table.values()))
    for v in np.unique(frame).tolist():
        if v:
            out[frame == v] = table[v] if v in table else min(known, key=lambda k: ((rgb(k) - rgb(v)) ** 2).sum())
    return out


def built_frame(frame, shared, table):
    out = recolored(frame, table)
    ink = frame > 0
    if not ink.any():
        return out
    scored = []
    for i, (a, _) in enumerate(shared):
        for dy, dx in SHIFTS:
            scored.append(((moved(a, dy, dx)[ink] == frame[ink]).sum(), i, dy, dx))
    scored.sort(key=lambda entry: -entry[0])
    near = binary_dilation(ink, iterations=3)
    candidates = []
    for _, i, dy, dx in scored[:CANDIDATES]:
        a, b = shared[i]
        match = binary_opening(moved(a, dy, dx) == frame, STRETCH) & near
        match &= ink | binary_dilation(match & ink, iterations=2)
        candidates.append((match, moved(b, dy, dx)))
    covered = np.zeros_like(ink)
    for _ in range(MOST_SOURCES):
        best, gain = None, LEAST_GAIN
        for candidate in candidates:
            added = (candidate[0] & ~covered & ink).sum()
            if added > gain:
                best, gain = candidate, added
        if best is None:
            break
        new = best[0] & ~covered
        out[new] = best[1][new]
        covered |= new
    return out


def build(part, part_color, twin, twin_color, sheet, known, table):
    image = load(twin, sheet, twin_color)
    out = np.zeros(image.shape, np.uint32)
    for facing, frames in frames_of(image, sheet).items():
        shared = []
        for other in known:
            a, b = load(twin, other, twin_color), load(part, other, part_color)
            if a is None or b is None or a.shape != b.shape:
                continue
            twin_frames, part_frames = frames_of(a, other), frames_of(b, other)
            if facing in twin_frames:
                shared += [(x, y) for x, y in zip(twin_frames[facing], part_frames[facing]) if (x > 0).any()]
        row = 0 if sheet in ONE_ROW else FACINGS.index(facing)
        for column, frame in enumerate(frames):
            out[64 * row:64 * row + 64, 64 * column:64 * column + 64] = built_frame(frame, shared, table)
    return out


def held_out_score(part, part_color, twin, twin_color):
    """Hide each older sheet both parts have, and rebuild it from the rest."""
    scores = []
    for sheet in ("walk", "slash", "thrust", "spellcast"):
        real, guide = load(part, sheet, part_color), load(twin, sheet, twin_color)
        if real is None or guide is None or real.shape != guide.shape:
            continue
        known = [s for s in OLDER if s != sheet]
        made = build(part, part_color, twin, twin_color, sheet, known, recolor_table(twin, twin_color, part, part_color, known))
        a, b = made > 0, real > 0
        scores.append((a & b).sum() / max(1, (a | b).sum()))
    return float(np.mean(scores)) if scores else 0.0


def fold_twin_credit(d, twin_d, paths, names):
    """Downloads list the first credit covering a path, so each credit covering a built sheet names the twin's authors."""
    twin_credit = twin_d["credits"][0]
    note = f"{names} built from {twin_d['name']}'s frames and this part's own; not drawn by hand. See tools/fill_from_twin.py."
    for credit in d["credits"]:
        if not any(path == credit["file"] + "/" or path.startswith(credit["file"] + "/") for path in paths):
            continue
        credit["authors"] += [a for a in twin_credit["authors"] if a not in credit["authors"]]
        credit["urls"] += [u for u in twin_credit.get("urls", []) if u not in credit.get("urls", [])]
        credit["licenses"] = [l for l in credit["licenses"] if l in twin_credit["licenses"]]
        credit["notes"] = f"{credit.get('notes', '')} {note}".strip()


def main():
    rows = list(with_twin_rows)
    for rel, (twin_rel, pairs) in TWINS.items():
        d, twin_d = definition(rel), definition(twin_rel)
        shared_licenses = [l for l in d["credits"][0]["licenses"] if l in twin_d["credits"][0]["licenses"]]
        written, built_paths = set(), set()
        for part, twin in pairs.items():
            part_colors = colors_of(part, bool(d.get("variants")))
            twin_color = colors_of(twin, bool(twin_d.get("variants")))[0]
            score = held_out_score(part, part_colors[0], twin, twin_color)
            verdict = "pass" if score >= PASS and shared_licenses else "fail"
            missing = [s for s in OLDER + NEWER if s != "hurt" and not os.path.exists(sheet_file(part, s, part_colors[0])) and load(twin, s, twin_color) is not None]
            print(d["name"], part, "from", twin, f"held-out {score:.3f} licenses {shared_licenses} {verdict} missing {missing}", flush=True)
            if CHECK or verdict == "fail" or not APPLY:
                continue
            for color in part_colors:
                table = recolor_table(twin, twin_color, part, color, OLDER)
                for sheet in missing:
                    save(build(part, color, twin, twin_color, sheet, OLDER, table), sheet_file(part, sheet, color))
                    rows.append({"part": rel, "path": part, "sheet": sheet, "color": color or "", "twin": twin, "held_out": round(score, 3)})
            written.update(missing)
            built_paths.add(part)
        if written:
            claims = list(d.get("animations") or DEFAULT_CLAIMS)
            claims += [CLAIMS.get(s, s) for s in OLDER + NEWER if s in written and CLAIMS.get(s, s) not in claims]
            d["animations"] = claims
            fold_twin_credit(d, twin_d, built_paths, ", ".join(s.replace("_", " ").capitalize() for s in OLDER + NEWER if s in written))
            with open(os.path.join(DEFS, rel), "w", encoding="utf8", newline="\n") as f:
                f.write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
    if APPLY:
        with open(MANIFEST, "w", encoding="utf8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["part", "path", "sheet", "color", "twin", "held_out"], lineterminator="\n")
            w.writeheader()
            w.writerows(sorted(rows, key=lambda r: (r["part"], r["path"], r["sheet"], r["color"])))


if __name__ == "__main__":
    main()
