"""Convert parts that ship one image per color into one base image plus palettes.

Reads the per-part color measurements made by variant_measure.py. For each part whose colors all
share a silhouette, it splits the colors into those that change with the chosen color and those
that never do, seats the changing ones on the six ramp slots of a palette, and writes the base
sheets. Old links keep working: a color whose name is on the part's palettes needs nothing, and
any other gets an alias to its nearest palette.

Parts are left alone when their colors differ in shape, when more than one ramp changes with the
color, or when they are listed in KEEP. Every decision and every color's shift is written to the
report.

usage: convert_variants.py <repo root> <measure json> <report csv> [--apply] [--limit=N]
Without --apply it only plans. A run may be stopped and repeated: it skips parts already converted,
and --limit stops after N more parts.
"""
import collections
import csv
import glob
import hashlib
import io
import json
import os
from multiprocessing.pool import ThreadPool
import statistics
import sys

import numpy as np
from PIL import Image

args = [a for a in sys.argv[1:] if not a.startswith("--")]
ROOT, MEASURE, REPORT = args
APPLY = "--apply" in sys.argv
LIMIT = next((int(a[8:]) for a in sys.argv if a.startswith("--limit=")), 10**9)
POOL = ThreadPool(6)
DEFS = os.path.join(ROOT, "sheet_definitions")
SHEETS = os.path.join(ROOT, "spritesheets")

RAMP = 6
STANDARD_STRIPS = {"walk", "thrust", "slash", "spellcast", "shoot", "hurt", "idle", "run", "jump", "sit", "emote", "climb", "backslash", "halfslash", "combat_idle", "watering"}
TOLERANCE = 1  # the recolor engine's source match, per channel
MAX_STRAY_PIXELS = 40  # a color may differ from the others by this much and still convert
NAME_ALIAS_LIMIT = 70  # how far "tiara_gold" may land from gold before nearest color wins instead

# The crown's named versions are two colors at once, which one ramp would lose.
KEEP = {"headwear/hats/formal/hat_formal_crown.json"}
# Only these parts may take the hair material, which makes a part follow Hair.
HAIR_FOLDERS = ("body/tails/", "body/wings/")
MATERIALS = ["cloth", "metal", "wood", "hair", "body"]
OTHER_ORDER = {
    "cloth": ["metal", "hair", "wood", "body"],
    "metal": ["cloth", "hair", "wood", "body"],
    "wood": ["metal", "cloth", "hair", "body"],
    "hair": ["body", "cloth", "metal", "wood"],
    "body": ["hair", "cloth", "metal", "wood"],
}

palettes = {}
for path in glob.glob(os.path.join(ROOT, "palette_definitions/*/*.json")):
    base = os.path.basename(path)
    if base.startswith("meta_"):
        continue
    material, version = base[:-5].split("_")
    palettes[(material, version)] = {
        k: [c.lstrip("#").lower()[:6] for c in ramp]
        for k, ramp in json.load(open(path, encoding="utf8")).items()
    }
META_BASE = {
    m: json.load(open(os.path.join(ROOT, f"palette_definitions/{m}/meta_{m}.json"), encoding="utf8"))["base"]
    for m in MATERIALS
}
HAS_LPCR = {m for m in MATERIALS if (m, "lpcr") in palettes}


def norm(name):
    return name.replace(" ", "_").lower()


def rgb(color):
    return int(color[:2], 16), int(color[2:4], 16), int(color[4:6], 16)


def dist(a, b):
    return max(abs(x - y) for x, y in zip(rgb(a), rgb(b)))


def luma(color):
    r, g, b = rgb(color)
    return 0.299 * r + 0.587 * g + 0.114 * b


def function_of(table):
    out, stray = {}, 0
    for source, targets in table.items():
        best = max(targets, key=targets.get)
        out[source] = best
        stray += sum(c for t, c in targets.items() if t != best)
    return out, stray


def options_for(name, material):
    """Palettes holding this color name, the part's own material first."""
    ordered = [(material, "ulpc")] + [(m, "ulpc") for m in OTHER_ORDER[material]]
    return [(key, palettes[key][name]) for key in ordered if name in palettes[key]]


def seat(colors, maps, weights, material):
    """Seat colors (dark to light) on ascending ramp slots, cheapest over every named color."""
    cost = [[0.0] * RAMP for _ in colors]
    for variant, table in maps.items():
        options = options_for(norm(variant), material)
        if not options:
            continue
        ramp = options[0][1]
        for i, color in enumerate(colors):
            if color in table:
                for slot in range(RAMP):
                    cost[i][slot] += dist(table[color], ramp[slot]) * weights.get(color, 1)
    best = {(-1, -1): (0.0, [])}
    for i in range(len(colors)):
        for slot in range(RAMP):
            prior = [v for (a, b), v in best.items() if a == i - 1 and b < slot]
            if prior:
                total, seats = min(prior, key=lambda p: p[0])
                best[(i, slot)] = (total + cost[i][slot], seats + [slot])
    finals = [v for (a, _), v in best.items() if a == len(colors) - 1]
    return min(finals, key=lambda p: p[0])[1] if finals else None


def off(table, moving, seats, ramp):
    return max((dist(table[d], ramp[s]) for d, s in zip(moving, seats) if d in table), default=0)


def key_for(material, palette_key, name):
    """How a part with this material spells a color, as the metadata generator does."""
    other, version = palette_key
    return (f"{other}." if other != material else "") + (f"{version}." if version != "ulpc" else "") + name


def plan_part(part):
    definition = part["definition"]
    if "maps" not in part:
        return {"verdict": "one color only" if len(part["variants"]) < 2 else "no sheets found"}
    if definition in KEEP:
        return {"verdict": "kept: named versions are two colors at once"}
    if sum(part["bad_alpha"].values()):
        return {"verdict": "kept: colors differ in transparency"}
    for sheets in part["bad_shape"].values():
        pixels = sum(int(s.rsplit(" ", 1)[1].replace("px", "")) if s.endswith("px") else 99999 for s in sheets)
        if pixels > MAX_STRAY_PIXELS:
            return {"verdict": "kept: colors differ in shape"}

    info = {v: function_of(t) for v, t in part["maps"].items()}
    maps = {v: i[0] for v, i in info.items()}
    richest = part["richest"]
    domain = list(maps[richest])
    weights = {s: sum(t.values()) for s, t in part["maps"][richest].items()}
    fixed = [d for d in domain if len({maps[v].get(d) for v in maps if d in maps[v]}) == 1]
    moving = sorted(
        (d for d in domain if d not in fixed),
        key=lambda d: statistics.mean(luma(maps[v][d]) for v in maps if d in maps[v]),
    )
    if not moving:
        return {"verdict": "kept: nothing changes with the color"}
    if len(moving) > RAMP:
        return {"verdict": "kept: more than one ramp changes with the color"}

    counts = collections.Counter()
    for variant in maps:
        for material in MATERIALS:
            if norm(variant) in palettes[(material, "ulpc")]:
                counts[material] += 1
    allowed = ["cloth", "metal", "wood"]
    if definition.startswith(HAIR_FOLDERS):
        allowed.append("hair")
    material = max(allowed, key=lambda m: (counts[m], m == "cloth"))
    seats = seat(moving, maps, weights, material)
    if seats is None:
        return {"verdict": "kept: colors do not fit the ramp"}

    used = {(material, "ulpc")}
    colors = {}
    for variant, table in maps.items():
        name = norm(variant)
        options = options_for(name, material)
        if options and options[0][0] == (material, "ulpc"):
            key, ramp = options[0]
        elif options:
            key, ramp = min(options, key=lambda o: off(table, moving, seats, o[1]))
        else:
            continue
        used.add(key)
        colors[variant] = {"key": key, "name": name, "off": off(table, moving, seats, ramp)}

    tokens = sorted(used, key=lambda k: (k != (material, "ulpc"), MATERIALS.index(k[0])))
    token_list = ["ulpc"]
    if material in HAS_LPCR:
        token_list.append("lpcr")
    token_list += [f"{m}.{v}" for m, v in tokens if m != material]
    token_list.append("all.lpcr")
    searchable = [(material, "ulpc")] + ([(material, "lpcr")] if material in HAS_LPCR else [])
    searchable += [k for k in tokens if k[0] != material] + [("all", "lpcr")]

    for variant, table in maps.items():
        if variant in colors:
            continue
        name = norm(variant)
        # "tiara_gold" and "base_black" say which color they mean.
        pick = None
        last = name.split("_")[-1]
        for key in searchable:
            if last in palettes[key]:
                distance = off(table, moving, seats, palettes[key][last])
                if distance <= NAME_ALIAS_LIMIT and (pick is None or distance < pick[0]):
                    pick = (distance, key, last)
        if pick is None:
            for key in searchable:
                for candidate, ramp in palettes[key].items():
                    if len(ramp) == RAMP:
                        distance = off(table, moving, seats, ramp)
                        if pick is None or distance < pick[0]:
                            pick = (distance, key, candidate)
        colors[variant] = {"key": pick[1], "name": pick[2], "off": pick[0], "stand_in": True}

    # The base ramp must keep its slots apart and must not touch a color that never changes.
    fixed_seen = {maps[richest][d] for d in fixed}
    order = [META_BASE[material]] + [k for k in palettes[(material, "ulpc")] if k != META_BASE[material]]
    base = None
    for candidate in order:
        ramp = palettes[(material, "ulpc")][candidate]
        apart = all(dist(a, b) > 2 * TOLERANCE for i, a in enumerate(ramp) for b in ramp[i + 1:])
        clear = all(dist(f, r) > TOLERANCE for f in fixed_seen for r in ramp)
        if len(ramp) == RAMP and apart and clear:
            base = candidate
            break
    if base is None:
        return {"verdict": "kept: every base ramp touches a color that never changes"}

    return {
        "verdict": "convert",
        "material": material,
        "base": base,
        "tokens": token_list,
        "moving": moving,
        "seats": seats,
        "fixed": fixed,
        "colors": colors,
        "maps": maps,
        "richest": richest,
    }


def layer_paths(definition):
    out = []
    for n in range(1, 10):
        layer = definition.get(f"layer_{n}")
        if not layer:
            break
        for key, value in layer.items():
            if key in ("zPos", "custom_animation") or not isinstance(value, str):
                continue
            paths = [value]
            if "${" in value:
                paths = []
                for name, table in definition.get("replace_in_path", {}).items():
                    token = "${" + name + "}"
                    if token in value:
                        paths += [value.replace(token, r) for r in table.values()]
            out.append((f"layer_{n}", key, value, paths, layer.get("custom_animation")))
    return out


def custom_path(path, custom):
    """Where a custom animation's base sheet lives. A folder named like a standard animation
    would make the file read as a standard strip, so it takes the custom animation's name."""
    path = path.rstrip("/")
    parent, _, last = path.rpartition("/")
    return f"{parent}/{custom}" if last in STANDARD_STRIPS else path


def pack(a):
    return a[..., 0].astype(np.uint32) << 16 | a[..., 1].astype(np.uint32) << 8 | a[..., 2]


def base_sheet(path, plan, variant):
    """One color's sheet with its changing colors moved onto the base ramp."""
    with Image.open(path) as im:
        a = np.array(im.convert("RGBA"))
    ramp = palettes[(plan["material"], "ulpc")][plan["base"]]
    packed = pack(a)
    table = plan["maps"].get(variant, {})
    out = a.copy()
    visible = a[..., 3] > 0
    for color, slot in zip(plan["moving"], plan["seats"]):
        shown = table.get(color)
        if shown is None:
            continue
        mask = visible & (packed == int(shown, 16))
        r, g, b = rgb(ramp[slot])
        out[mask, 0], out[mask, 1], out[mask, 2] = r, g, b
    return Image.fromarray(out)


def png_bytes(image):
    buffer = io.BytesIO()
    image.save(buffer, "PNG", compress_level=9)
    return buffer.getvalue()


def write_part(part, plan, written):
    """Writes the base sheets and the definition. Returns the per-color images replaced."""
    rel = part["definition"]
    full = os.path.join(DEFS, rel)
    definition = json.load(open(full, encoding="utf8"))
    if "variants" not in definition:
        return None  # converted by an earlier run
    variants = definition["variants"]
    richest = plan["richest"]
    jobs = []
    ordered = [richest] + [v for v in variants if v != richest]
    replaced = []
    for layer_key, body, template, paths, custom in layer_paths(definition):
        for path in paths:
            folder = os.path.join(SHEETS, path)
            if custom:
                entries = [(None, folder)]
            elif os.path.isdir(folder):
                entries = [(e, os.path.join(folder, e)) for e in sorted(os.listdir(folder)) if os.path.isdir(os.path.join(folder, e))]
            else:
                entries = []
            for animation, place in entries:
                files = {v: os.path.join(place, v.replace(" ", "_") + ".png") for v in variants}
                files = {v: f for v, f in files.items() if os.path.exists(f)}
                if not files:
                    continue
                source = next((v for v in ordered if v in files), None)
                if custom:
                    destination = os.path.join(SHEETS, custom_path(path, custom) + ".png")
                else:
                    destination = os.path.join(SHEETS, path, animation + ".png")
                jobs.append((destination, files[source], source))
                replaced += list(files.values())

    def render(job):
        return job[0], png_bytes(base_sheet(job[1], plan, job[2]))

    for destination, data in POOL.map(render, jobs):
        digest = hashlib.sha1(data).hexdigest()
        if destination in written and written[destination] != digest:
            raise RuntimeError(f"two different base sheets for {destination}")
        written[destination] = digest
        if APPLY:
            with open(destination, "wb") as f:
                f.write(data)

    new = {}
    aliases = dict(definition.get("aliases") or {})
    name = definition["name"].replace(" ", "_")
    for variant in variants:
        color = plan["colors"].get(variant)
        if color is None:
            continue
        key = key_for(plan["material"], color["key"], color["name"])
        if key != norm(variant):
            aliases[f"{name}_{variant.replace(' ', '_')}"] = key
            if " " in variant:
                aliases[f"{name}_{variant}"] = key
    recolors = {"material": plan["material"]}
    if plan["base"] != META_BASE[plan["material"]]:
        recolors["base"] = plan["base"]
    recolors["palettes"] = plan["tokens"]
    for key, value in definition.items():
        if key == "variants":
            new["recolors"] = recolors
            if aliases:
                new["aliases"] = aliases
        elif key == "aliases":
            continue
        elif key.startswith("layer_") and value.get("custom_animation"):
            new[key] = {
                k: (custom_path(v, value["custom_animation"]) if isinstance(v, str) and k != "custom_animation" else v)
                for k, v in value.items()
            }
        else:
            new[key] = value
    if APPLY:
        with open(full, "w", encoding="utf8", newline="\n") as f:
            f.write(json.dumps(new, indent=2, ensure_ascii=False) + "\n")
    return replaced


def main():
    parts = json.load(open(MEASURE, encoding="utf8"))
    plans = {p["definition"]: plan_part(p) for p in parts}
    rows, written, replaced = [], {}, []
    limit = LIMIT
    for part in parts:
        plan = plans[part["definition"]]
        row = {"definition": part["definition"], "name": part["name"], "colors": len(part["variants"]), "verdict": plan["verdict"]}
        if plan["verdict"] == "convert":
            offs = [c["off"] for c in plan["colors"].values()]
            stand_ins = {v: f"{c['name']} off {c['off']}" for v, c in plan["colors"].items() if c.get("stand_in")}
            far = {v: c["off"] for v, c in plan["colors"].items() if c["off"] > 30 and not c.get("stand_in")}
            row.update(
                material=plan["material"],
                base=plan["base"],
                palettes=" ".join(plan["tokens"]),
                changing_shades=len(plan["moving"]),
                fixed_shades=len(plan["fixed"]),
                exact=sum(o <= 2 for o in offs),
                within_30=sum(2 < o <= 30 for o in offs),
                over_30=sum(o > 30 for o in offs),
                stand_ins=json.dumps(stand_ins),
                moved_most=json.dumps(far),
            )
            if limit > 0:
                done = write_part(part, plan, written)
                if done is not None:
                    replaced += done
                    limit -= 1
        rows.append(row)
    fields = ["definition", "name", "colors", "verdict", "material", "base", "palettes", "changing_shades", "fixed_shades", "exact", "within_30", "over_30", "stand_ins", "moved_most"]
    with open(REPORT, "w", newline="", encoding="utf8") as f:
        writer = csv.DictWriter(f, fields)
        writer.writeheader()
        writer.writerows(rows)
    print(collections.Counter(r["verdict"] for r in rows))
    converted = [r for r in rows if r["verdict"] == "convert"]
    print("material", collections.Counter(r["material"] for r in converted))
    print("colors exact", sum(r["exact"] for r in converted), "within 30", sum(r["within_30"] for r in converted), "over 30", sum(r["over_30"] for r in converted))
    print("base sheets", len(written), "replaced images", len(set(replaced)))


main()
