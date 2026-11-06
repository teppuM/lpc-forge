"""Bring Vitruvian LPC Studio's idle art for weapons and tools into the matching parts here.

Vitruvian draws the same weapons in the same walk poses, and also has them standing idle, which Universal lacks. A layer
is used only when its walk art lines up with the part's own walk. The colors are carried across by matching the two walk
sheets pixel by pixel, so recoloring keeps working. Items that fail its license check are left out; pass the check's csv.

Vitruvian's idle is one column, and Universal's is two with the second a pixel higher, as the hands are in that animation.

usage: import_vitruvian_idle.py <vitruvian spritesheets> <license audit csv> <repo root> [--apply]
Without --apply it only reports.
"""
import collections
import csv
import glob
import json
import os
import sys

import numpy as np
from PIL import Image

VIT, AUDIT, ROOT = sys.argv[1:4]
APPLY = "--apply" in sys.argv
ART = os.path.join(ROOT, "spritesheets")
DEFS = os.path.join(ROOT, "sheet_definitions")
MIN_WALK_MATCH = 0.90
MAX_UNMAPPED = 0.05
# Vitruvian item -> this project's definition.
ITEMS = {
    "bows/crossbow": "weapons/ranged/weapon_ranged_crossbow.json",
    "misc/halberd": "weapons/polearm/weapon_polearm_halberd.json",
    "misc/slingshot": "weapons/ranged/weapon_ranged_slingshot.json",
    "misc/waraxe": "weapons/blunt/weapon_blunt_waraxe.json",
    "shields/crusader": "weapons/shields/engrailed/shield_crusader.json",
    "shields/kite": "weapons/shields/shield_kite.json",
    "shields/round": "weapons/shields/shield_round.json",
    "shields/spartan": "weapons/shields/shield_spartan.json",
    "spears/spear": "weapons/polearm/weapon_polearm_spear.json",
    "staff_accessory/crystal": "weapons/magic/weapon_magic_crystal.json",
    "staffs/cane": "weapons/polearm/weapon_polearm_cane.json",
    "staffs/diamond": "weapons/magic/weapon_magic_diamond.json",
    "staffs/gnarled": "weapons/magic/weapon_magic_gnarled.json",
    "staffs/loop": "weapons/magic/weapon_magic_loop.json",
    "staffs/simple": "weapons/magic/weapon_magic_simple.json",
    "swords/dagger": "weapons/sword/weapon_sword_dagger.json",
    "swords/glowsword": "weapons/sword/weapon_sword_glowsword.json",
    "swords/longsword": "weapons/sword/weapon_sword_longsword.json",
    "swords/rapier": "weapons/sword/weapon_sword_rapier.json",
    "swords/saber": "weapons/sword/weapon_sword_saber.json",
    "tools/hoe": "tools/tool_hoe.json",
    "tools/scythe": "weapons/polearm/weapon_polearm_scythe.json",
    "tools/shovel": "tools/tool_shovel.json",
    "tools/watercan": "tools/tool_watering_can.json",
}


def load(path):
    with Image.open(path) as im:
        return np.asarray(im.convert("RGBA")).copy()


def pack(pixels):
    return pixels[..., 0].astype(np.int64) << 16 | pixels[..., 1].astype(np.int64) << 8 | pixels[..., 2]


def vit_layers(item):
    """{name: (walk, idle)} for each folder of the item holding both sheets."""
    out = {}
    base = os.path.join(VIT, "equipment", item)
    for folder, _, files in os.walk(base):
        if "walk.png" in files and "idle.png" in files:
            out[os.path.relpath(folder, base).replace("\\", "/")] = (load(os.path.join(folder, "walk.png")), load(os.path.join(folder, "idle.png")))
    return out


def part_layers(d):
    """{path: bodies} for layers drawn in standard animations."""
    out = collections.defaultdict(list)
    for n in range(1, 12):
        layer = d.get(f"layer_{n}")
        if layer and "custom_animation" not in layer:
            for body, value in layer.items():
                if body != "zPos" and isinstance(value, str):
                    out[value].append(body)
    return out


def walks_of(path, per_color):
    """{color or None: walk image} for a part's layer. The app reads one image per color for parts with variants."""
    if not per_color:
        flat = os.path.join(ART, path, "walk.png")
        return {None: load(flat)} if os.path.exists(flat) else {}
    folder = os.path.join(ART, path, "walk")
    if os.path.isdir(folder):
        return {n[:-4]: load(os.path.join(folder, n)) for n in sorted(os.listdir(folder)) if n.endswith(".png")}
    return {}


def has_idle(path, per_color):
    return os.path.isdir(os.path.join(ART, path, "idle")) if per_color else os.path.exists(os.path.join(ART, path, "idle.png"))


def overlap(ours, theirs):
    """Our walk has a standing column first; Vitruvian's does not."""
    a = ours[:, 64:576, :]
    b = theirs[:, :512, :]
    if a.shape != b.shape:
        return 0.0, a, b
    ma, mb = a[..., 3] > 0, b[..., 3] > 0
    union = np.count_nonzero(ma | mb)
    return (np.count_nonzero(ma & mb) / union if union else 0.0), a, b


def color_table(ours, theirs):
    both = (ours[..., 3] > 0) & (theirs[..., 3] > 0)
    votes = collections.defaultdict(collections.Counter)
    pairs, counts = np.unique(np.stack([pack(theirs[both]), pack(ours[both])], 1), axis=0, return_counts=True)
    for (t, o), n in zip(pairs, counts):
        votes[int(t)][int(o)] += int(n)
    return {t: c.most_common(1)[0][0] for t, c in votes.items()}


def recolored(idle, table):
    """The sheet in our colors, and the share of its pixels whose color the walk sheets did not settle."""
    out = idle.copy()
    mask = out[..., 3] > 0
    colors = pack(out[mask])
    unique, inverse = np.unique(colors, return_inverse=True)
    known = np.array(list(table.keys()), dtype=np.int64)
    rgb = np.stack([(known >> 16) & 255, (known >> 8) & 255, known & 255], 1)
    mapped = np.zeros((len(unique), 3), np.uint8)
    unmapped = 0
    for i, color in enumerate(unique):
        target = table.get(int(color))
        if target is None:
            unmapped += int((inverse == i).sum())
            near = ((rgb - np.array([(color >> 16) & 255, (color >> 8) & 255, color & 255])) ** 2).sum(1)
            target = table[int(known[near.argmin()])]
        mapped[i] = [(target >> 16) & 255, (target >> 8) & 255, target & 255]
    pixels = out[mask]
    pixels[:, :3] = mapped[inverse]
    out[mask] = pixels
    return out, unmapped / max(1, len(colors))


def two_columns(idle):
    """Vitruvian's column, then the same a pixel higher."""
    h = idle.shape[0]
    out = np.zeros((h, 128, 4), np.uint8)
    out[:, :64] = idle[:, :64]
    for r in range(h // 64):
        out[r * 64:(r + 1) * 64 - 1, 64:128] = idle[r * 64 + 1:(r + 1) * 64, :64]
    return out


def fold_into_covering(credits):
    """A download lists only the first credit covering a path, so a sheet's credit must also be in any credit covering it."""
    for sheet in credits:
        for covering in credits:
            if covering is sheet or not sheet["file"].removesuffix(".png").startswith(covering["file"] + "/"):
                continue
            covering["authors"] += [a for a in sheet["authors"] if a not in covering["authors"]]
            covering["urls"] += [u for u in sheet.get("urls", []) if u not in covering.get("urls", [])]
            shared = [l for l in covering["licenses"] if l in sheet["licenses"]]
            only = f"Those frames are {', '.join(sheet['licenses'])} only."
            note = sheet.get("notes", "")
            if only in covering.get("notes", ""):
                continue
            if not shared:
                covering["licenses"] += [l for l in sheet["licenses"] if l not in covering["licenses"]]
                note = f"{note} {only}".strip()
            else:
                covering["licenses"] = shared
            if note and note not in covering.get("notes", ""):
                covering["notes"] = f"{covering.get('notes', '')} {note}".strip()


def main():
    audit = {r["item"]: r for r in csv.DictReader(open(AUDIT, encoding="utf8"))}
    done = skipped = 0
    for item, rel in ITEMS.items():
        row = audit.get("equipment/" + item)
        if not row or row["verdict"] != "pass":
            print(f"{item}: left out, license check says {row and row['verdict']}")
            skipped += 1
            continue
        file = os.path.join(DEFS, rel)
        if not os.path.exists(file):
            print(f"{item}: no definition {rel}")
            skipped += 1
            continue
        d = json.load(open(file, encoding="utf8"))
        theirs = vit_layers(item)
        plan = []
        reasons = []
        for path in part_layers(d):
            if has_idle(path, bool(d.get("variants"))):
                continue
            walks = walks_of(path, bool(d.get("variants")))
            if not walks or not any((w[..., 3] > 0).any() for w in walks.values()):
                continue
            for color, walk in walks.items():
                scored = sorted(((overlap(walk, w)[0], name) for name, (w, _) in theirs.items()), reverse=True)
                if not scored or scored[0][0] < MIN_WALK_MATCH:
                    reasons.append(f"{path} walk match {scored[0][0]:.2f}" if scored else f"{path} nothing to compare")
                    continue
                score, name = scored[0]
                _, ours, vit_walk = overlap(walk, theirs[name][0])
                idle = theirs[name][1]
                if not (idle[..., 3] > 0).any():
                    continue
                made, unmapped = recolored(idle, color_table(ours, vit_walk))
                if unmapped > MAX_UNMAPPED:
                    reasons.append(f"{path} {unmapped:.0%} of idle colors unsettled")
                    continue
                plan.append((path, color, made, score, name))
        if reasons or not plan:
            print(f"{item}: left out, {reasons or 'no sheet to add'}")
            skipped += 1
            continue
        print(f"{item}: {d['name']}: " + ", ".join(f"{p[0]}{p[1] or ''} from {p[4]} at {p[3]:.2f}" for p in plan))
        done += 1
        if not APPLY:
            continue
        files = set()
        for path, color, made, _, _ in plan:
            target = os.path.join(ART, path, "idle.png") if color is None else os.path.join(ART, path, "idle", color + ".png")
            os.makedirs(os.path.dirname(target), exist_ok=True)
            Image.fromarray(two_columns(made), "RGBA").save(target, optimize=True)
            files.add(f"{path}idle.png" if color is None else f"{path}idle")
        animations = d.get("animations") or ["spellcast", "thrust", "walk", "slash", "shoot", "hurt", "watering"]
        d["animations"] = animations if "idle" in animations else animations + ["idle"]
        credits = d.setdefault("credits", [])
        for name in sorted(files):
            credits.append({
                "file": name,
                "notes": "Idle from Vitruvian LPC Studio, recolored to match this part.",
                "authors": [a.strip() for a in row["authors"].split(";") if a.strip()],
                "licenses": [l.strip() for l in row["stated"].split(";") if l.strip()],
                "urls": row["urls"].split(),
            })
        fold_into_covering(credits)
        with open(file, "w", encoding="utf8", newline="\n") as f:
            f.write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
    print("parts", done, "left out", skipped)


main()
