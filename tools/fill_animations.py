"""Fill a head-worn part's missing animations from its own frames.

Hair, hats, helmets and similar parts move with the head. For each frame of a missing sheet, this finds the frame of the
same facing whose head drawing matches best, among the sheets the part does have, and moves the part's own frame by the
distance between the two heads. Nothing is drawn by hand and no art comes from outside the part, so its authors and
licenses stand. Every sheet written is listed in tools/filled-animations.csv, so real art can replace it later.

A sheet is filled only when no layer of the part has it on that body, and only when that body has the animation at all.

With --check it writes nothing. It takes complete parts, hides sheets, rebuilds them and scores them against the real art.

usage: fill_animations.py <repo root> [--apply] [--check]
Without --apply or --check it only plans.
"""
import collections
import csv
import glob
import json
from multiprocessing.pool import ThreadPool
import os
import sys

import numpy as np
from PIL import Image

ROOT = sys.argv[1]
APPLY = "--apply" in sys.argv
CHECK = "--check" in sys.argv
DEFS = os.path.join(ROOT, "sheet_definitions")
ART = os.path.join(ROOT, "spritesheets")
MANIFEST = os.path.join(ROOT, "tools", "filled-animations.csv")

SHEETS = ["spellcast", "thrust", "walk", "slash", "shoot", "hurt", "climb", "idle", "jump", "sit", "emote", "run", "combat_idle", "backslash", "halfslash"]
OLDER = SHEETS[:6]
NEWER = SHEETS[6:]
# The values a definition's animation list uses for each sheet. Watering borrows thrust and is claimed separately.
CLAIMS = {sheet: [sheet] for sheet in SHEETS}
CLAIMS["combat_idle"] = ["combat"]
CLAIMS["backslash"] = ["1h_slash", "1h_backslash"]
CLAIMS["halfslash"] = ["1h_halfslash"]
DEFAULT_CLAIMS = ["spellcast", "thrust", "walk", "slash", "shoot", "hurt", "watering"]
FACINGS = "nwse"
SCOPE = ("hair/", "head/", "headwear/")
OUT_OF_SCOPE = ("headwear/neck/", "head/heads/")
HEADS = {"male": "head/heads/human/male/", "female": "head/heads/human/female/", "child": "head/heads/human/child/"}
HEAD_OF_BODY = {"male": "male", "muscular": "male", "female": "female", "pregnant": "female", "teen": "female", "child": "child"}
BODIES = list(HEAD_OF_BODY)
NUDGE = 3  # Pixels searched around the shift that lines up the two heads' corners.
WEAK_MATCH = 0.90  # A head match below this is reported.


def load(path):
    with Image.open(path) as im:
        return np.asarray(im.convert("RGBA")).copy()


def facing_of(sheet, row, rows):
    if rows == 4:
        return FACINGS[row]
    return "n" if sheet == "climb" else "s"


def frames_of(image, sheet):
    rows = image.shape[0] // 64
    return {
        (facing_of(sheet, r, rows), c): image[r * 64:(r + 1) * 64, c * 64:(c + 1) * 64]
        for r in range(rows)
        for c in range(image.shape[1] // 64)
    }


def moved(frame, dx, dy):
    out = np.zeros_like(frame)
    h, w = frame.shape[:2]
    from_y, to_y = (0, dy) if dy >= 0 else (-dy, 0)
    from_x, to_x = (0, dx) if dx >= 0 else (-dx, 0)
    keep_h, keep_w = h - abs(dy), w - abs(dx)
    if keep_h > 0 and keep_w > 0:
        out[to_y:to_y + keep_h, to_x:to_x + keep_w] = frame[from_y:from_y + keep_h, from_x:from_x + keep_w]
    return out


def corner(mask):
    ys = np.where(mask.any(1))[0]
    xs = np.where(mask.any(0))[0]
    return (int(xs[0]), int(ys[0])) if len(ys) else None


class HeadTable:
    """For every frame of every sheet, how well each other sheet's frames of the same facing match its head."""

    def __init__(self, folder):
        self.images = {s: load(os.path.join(ART, folder, s + ".png")) for s in SHEETS}
        masks = {s: {k: f[..., 3] > 0 for k, f in frames_of(self.images[s], s).items()} for s in SHEETS}
        self.table = {}
        for target in SHEETS:
            for key, mask in masks[target].items():
                at = corner(mask)
                if at is None:
                    continue
                self.table[(target, key)] = options = []
                for source in SHEETS:
                    if source == target:
                        continue
                    for other_key, other in masks[source].items():
                        other_at = corner(other)
                        if other_key[0] != key[0] or other_at is None:
                            continue
                        top = (-1.0, 0, 0)
                        base_x, base_y = at[0] - other_at[0], at[1] - other_at[1]
                        for dy in range(base_y - NUDGE, base_y + NUDGE + 1):
                            for dx in range(base_x - NUDGE, base_x + NUDGE + 1):
                                shifted = moved(other, dx, dy)
                                union = np.count_nonzero(shifted | mask)
                                score = np.count_nonzero(shifted & mask) / union if union else 0
                                if score > top[0]:
                                    top = (score, dx, dy)
                        options.append((round(top[0], 3), SHEETS.index(source), source, other_key, top[1], top[2]))
                options.sort(key=lambda o: (-o[0], o[1]))

    def size(self, sheet):
        return self.images[sheet].shape


def rebuild(table, target, available):
    """A new sheet for target from {sheet: frames}, plus the weakest head match used. None if it would be empty."""
    h, w, _ = table.size(target)
    out = np.zeros((h, w, 4), np.uint8)
    rows = h // 64
    weakest = 1.0
    drawn = False
    for r in range(rows):
        for c in range(w // 64):
            key = (facing_of(target, r, rows), c)
            for score, _, source, other_key, dx, dy in table.table.get((target, key), []):
                frame = available.get(source, {}).get(other_key)
                if frame is None or not (frame[..., 3] > 0).any():
                    continue
                out[r * 64:(r + 1) * 64, c * 64:(c + 1) * 64] = moved(frame, dx, dy)
                weakest = min(weakest, score)
                drawn = True
                break
    return (out, weakest) if drawn else (None, weakest)


def expand(definition, value):
    if "${" not in value:
        return [value]
    paths = []
    for name, choices in definition.get("replace_in_path", {}).items():
        token = "${" + name + "}"
        if token in value:
            paths += [value.replace(token, choice) for choice in choices.values()]
    return paths


def layer_paths(definition, body):
    paths = []
    for n in range(1, 12):
        layer = definition.get(f"layer_{n}")
        if layer and "custom_animation" not in layer and isinstance(layer.get(body), str):
            paths += expand(definition, layer[body])
    return paths


def colors_of(path):
    """The color file names under a part with one image per color, or [None] for one flat image per sheet."""
    names = set()
    for sheet in SHEETS:
        if os.path.exists(os.path.join(ART, path, sheet + ".png")):
            return [None]
        folder = os.path.join(ART, path, sheet)
        if os.path.isdir(folder):
            names.update(n[:-4] for n in os.listdir(folder) if n.endswith(".png"))
    return sorted(names) or [None]


def sheet_file(path, sheet, color):
    return os.path.join(ART, path, sheet + ".png") if color is None else os.path.join(ART, path, sheet, color + ".png")


def has_sheet(path, sheet):
    if os.path.exists(os.path.join(ART, path, sheet + ".png")):
        return True
    folder = os.path.join(ART, path, sheet)
    return os.path.isdir(folder) and any(n.endswith(".png") for n in os.listdir(folder))


def read_sheets(path, color, sheets):
    out = {}
    for sheet in sheets:
        f = sheet_file(path, sheet, color)
        if os.path.exists(f):
            out[sheet] = frames_of(load(f), sheet)
    return out


def definitions():
    for p in sorted(glob.glob(DEFS + "/**/*.json", recursive=True)):
        rel = os.path.relpath(p, DEFS).replace("\\", "/")
        if os.path.basename(p).startswith("meta_") or not rel.startswith(SCOPE) or rel.startswith(OUT_OF_SCOPE):
            continue
        yield p, rel, json.load(open(p, encoding="utf8"))


def plan():
    """{(path, sheet): head}, {path: definition}, and the sheets skipped because the body has no such animation."""
    wanted, owner, skipped = {}, {}, collections.Counter()
    for _, rel, d in definitions():
        for body in BODIES:
            paths = layer_paths(d, body)
            if not paths:
                continue
            for sheet in SHEETS:
                # Parts fall over with the head in hurt, so a moved frame does not fit: 41% of frames pass the check.
                if sheet == "hurt" or any(has_sheet(p, sheet) for p in paths):
                    continue
                if not os.path.exists(os.path.join(ART, "body/bodies", body, sheet + ".png")):
                    skipped[(body, sheet)] += 1
                    continue
                for p in paths:
                    wanted.setdefault((p, sheet), HEAD_OF_BODY[body])
                    owner[p] = rel
    return wanted, owner, skipped


def blank(frames):
    return not any((f[..., 3] > 0).any() for f in frames.values())


def check(tables):
    """Hide sheets of complete parts, rebuild them and compare with the real art."""
    cases = {"newer sheets from the six older ones": (NEWER, OLDER), "each sheet from all the others": (SHEETS, None)}
    parts = []
    for _, rel, d in definitions():
        for p in layer_paths(d, "male"):
            if colors_of(p) == [None] and all(has_sheet(p, s) for s in SHEETS):
                parts.append((rel, p))
    print("complete layers tested", len(parts))
    for name, (targets, sources) in cases.items():
        scores = collections.defaultdict(list)

        def run(item):
            _, p = item
            sheets = read_sheets(p, None, SHEETS)
            out = []
            for t in targets:
                use = {s: f for s, f in sheets.items() if s != t and (sources is None or s in sources)}
                made, _ = rebuild(tables["male"], t, use)
                if made is None:
                    continue
                for key, real in sheets[t].items():
                    r, c = FACINGS.index(key[0]) if len(sheets[t]) > 20 or t not in ("hurt", "climb") else 0, key[1]
                    mine = made[r * 64:(r + 1) * 64, c * 64:(c + 1) * 64]
                    a, b = mine[..., 3] > 0, real[..., 3] > 0
                    if b.any():
                        out.append((t, np.count_nonzero(a & b) / np.count_nonzero(a | b)))
            return out

        with ThreadPool(6) as pool:
            for result in pool.imap_unordered(run, parts):
                for t, v in result:
                    scores[t].append(v)
        print(name)
        for t in targets:
            v = np.array(scores[t])
            if len(v):
                print(f"  {t:12s} frames {len(v):6d} overlap {v.mean():.3f} at 0.9 or better {(v >= .9).mean():.0%}")


def add_claims(definition, sheets):
    claims = list(definition.get("animations") or DEFAULT_CLAIMS)
    for sheet in sheets:
        for value in CLAIMS[sheet]:
            if value not in claims:
                claims.append(value)
    return claims


def main():
    tables = {name: HeadTable(folder) for name, folder in HEADS.items()}
    for name, table in tables.items():
        weak = [(k[0], k[1], o[0][0]) for k, o in table.table.items() if o and o[0][0] < WEAK_MATCH]
        print(f"{name} head: frames {len(table.table)}, weak matches {weak}")
    if CHECK:
        check(tables)
        return
    wanted, owner, skipped = plan()
    print("sheets to fill (one per layer path)", len(wanted), "parts", len(set(owner.values())))
    print("by sheet", collections.Counter(s for _, s in wanted).most_common())
    print("skipped, body has no such animation", sum(skipped.values()), sorted({k for k in skipped}))

    written = collections.defaultdict(set)
    report, empty = [], []

    def fill(item):
        (path, sheet), head = item
        rows = []
        # Only the part's own art is a source, never a sheet this run writes.
        sources = [s for s in SHEETS if (path, s) not in wanted]
        for color in colors_of(path):
            available = read_sheets(path, color, sources)
            if not available or blank({k: f for frames in available.values() for k, f in frames.items()}):
                return rows, (path, sheet, color)
            made, weakest = rebuild(tables[head], sheet, available)
            if made is None:
                rows.append((path, sheet, color, None, None))
                continue
            f = sheet_file(path, sheet, color)
            if APPLY:
                os.makedirs(os.path.dirname(f), exist_ok=True)
                Image.fromarray(made, "RGBA").save(f, optimize=True)
            rows.append((path, sheet, color, head, weakest))
        return rows, None

    with ThreadPool(6) as pool:
        for rows, nothing in pool.imap_unordered(fill, sorted(wanted.items())):
            if nothing:
                empty.append(nothing)
            for path, sheet, color, head, weakest in rows:
                if head is None:
                    empty.append((path, sheet, color))
                    continue
                written[owner[path]].add(sheet)
                report.append({"part": owner[path], "path": path, "sheet": sheet, "color": color or "", "head": head, "weakest_head_match": weakest})
    report.sort(key=lambda r: (r["part"], r["path"], r["sheet"], r["color"]))
    print("sheets written" if APPLY else "sheets planned", len(report), "| nothing to draw", len(empty), "| parts", len(written))
    print("weakest head match used", sorted(collections.Counter(r["weakest_head_match"] < WEAK_MATCH for r in report).items()))
    if not APPLY:
        return
    for p, rel, d in definitions():
        sheets = written.get(rel)
        if not sheets:
            continue
        d["animations"] = add_claims(d, [s for s in SHEETS if s in sheets])
        names = ", ".join(s.replace("_", " ") for s in SHEETS if s in sheets)
        note = f"Rebuilt from this part's own frames to follow the head: {names}."
        for credit in d.get("credits", []):
            credit["notes"] = (credit.get("notes", "") + " " + note).strip()
        with open(p, "w", encoding="utf8", newline="\n") as f:
            f.write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
    with open(MANIFEST, "w", encoding="utf8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["part", "path", "sheet", "color", "head", "weakest_head_match"], lineterminator="\n")
        w.writeheader()
        w.writerows(report)


main()
