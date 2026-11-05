"""Convert parts from pflat's LPC Character Generator into this project's layout.

pflat's textures hold a shade number in the blue channel and pick a color channel with red and green: neither is the
primary color, green is the secondary and red is a fixed color. pflat's colormaps turn shades into real colors. This
writes real colors instead, using a Universal LPC palette for each recolorable channel so the normal recoloring works,
then splits each 832 by 1344 sheet into the six animations it holds and writes a sheet definition with per-file credits.

usage: import_chargen.py <CharGen zip> <license-audit.csv> <item-overlap.csv> <repo> [--dry-run]
"""
import collections, csv, io, json, os, re, sys, zipfile

import numpy as np
from PIL import Image

ZIP, AUDIT, OVERLAP, REPO = sys.argv[1:5]
DRY = "--dry-run" in sys.argv
sys.stdout.reconfigure(encoding="utf8")
Z = zipfile.ZipFile(ZIP)
NAMES = set(Z.namelist())
DATA = "LPC_Forge/source/pflat/data/"
ART = "LPC_Forge/assets/pflat/"
CUT_OUT = (0xff, 0x2c, 0xe6)  # Universal LPC's magenta mask.
DUPLICATE_IOU = 0.90
DUPLICATE_CONTAINED = 0.97
DUPLICATE_SLOTS = {"ears", "horns", "nose", "tail", "wings", "facial", "hairadd"}

# Rows and widths of each animation in the 832 by 1344 sheet.
ANIMATIONS = {
    "spellcast": (0, 4, 448),
    "thrust": (4, 4, 512),
    "walk": (8, 4, 576),
    "slash": (12, 4, 384),
    "shoot": (16, 4, 832),
    "hurt": (20, 1, 384),
}
HEAD_BODIES = {"male": "hm1", "muscular": "hm1", "female": "hf1", "pregnant": "hf1", "teen": "hf1", "child": "hc1"}
BODY_BODIES = {"male": "hm1", "muscular": "hm2", "female": "hf1", "pregnant": "hf2", "child": "hc1"}

# type_name, folder under sheet_definitions, front layer, back layer.
PLACES = {
    "hair": ("hair", "hair/more_styles", 120, 9),
    "hairadd": ("hairextl", "hair/extensions/bangs", 128, 9),
    "facial": ("beard", "hair/beards", 110, 9),
    "helmet": ("hat", "headwear/helmets/more_helmets", 130, 7),
    "hat": ("hat", "headwear/hats/more_hats", 130, 7),
    "mask": ("facial_mask", "headwear/accessories", 114, 7),
    "glasses": ("facial_eyes", "headwear/accessories/glasses", 115, 7),
    "cape": ("cape", "torso/cape", 85, 5),
    "back": ("backpack", "torso/backpack", 110, 5),
    "quiver": ("quiver", "torso/backpack", 8, 5),
    "belt": ("belt", "torso/waist", 70, 5),
    "neck": ("neck", "headwear/neck", 90, 5),
    "shirt": ("clothes", "torso/shirts/more_shirts", 35, 5),
    "jacket": ("jacket", "torso/jacket", 55, 5),
    "pants": ("legs", "legs/pants", 20, 5),
    "shoes": ("shoes", "feet/shoes", 15, 5),
    "suit": ("clothes", "torso/shirts/more_shirts", 35, 5),
    "add1": ("wound_face", "body/wounds", 115, 5),
    "add2": ("wound_ribs", "body/wounds", 15, 5),
    "add3": ("prosthesis_leg", "body/prostheses", 100, 5),
    "horns": ("horns", "head/appendages", 126, 7),
    "ears": ("ears", "head/ears", 126, 7),
    "nose": ("nose", "head/nose", 105, 7),
    "wings": ("wings", "body/wings", 105, 5),
    "tail": ("tail", "body/tails", 125, 5),
}
# Universal LPC has the same part under another name, cut differently enough to pass the overlap test.
SAME_AS_UNIVERSAL = {"tail/cattail", "tail/fluffytail"}
# Whole slots left out, each with its reason in the report.
SKIPPED_SLOTS = {
    "mainhand": "weapon: Universal LPC already has these by name",
    "offhand": "shield: Universal LPC already has these by name",
    "ammo": "ammunition: not drawn on the character",
    "body": "body: Universal LPC's bodies are the base",
    "head": "head: needs pflat's separate eyes joined to it",
    "eyes": "eyes: drawn for pflat's own heads",
    "shadow": "shadow: already present",
    "ears": "ears: Universal LPC already has these by name",
    "gloves": "gloves: already present",
}
METAL = ("metal_",)
HAIR = ("human_hair",)
SKIN = ("human_skin", "orc_skin", "lizard_skin", "beast", "zombie", "elf", "skeleton", "reptile", "wolf", "boar", "minotaur", "drake", "body")


def clean_json(raw):
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", raw.decode("latin-1")))


colormaps = {}
for entry in clean_json(Z.read(DATA + "colormaps/default.cm"))["items"]:
    c = entry["colors"]
    colormaps[entry["id"]] = {c[i]: ((c[i + 1] >> 24) & 255, (c[i + 1] >> 16) & 255, (c[i + 1] >> 8) & 255) for i in range(0, len(c), 2) if c[i]}

palettes = {}
for material in ("cloth", "metal", "hair", "body"):
    source = json.load(open(os.path.join(REPO, f"palette_definitions/{material}/{material}_ulpc.json"), encoding="utf8"))
    palettes[material] = {k: [tuple(int(h[i:i + 2], 16) for i in (1, 3, 5)) for h in v] for k, v in source.items() if isinstance(v, list)}


def luma(c):
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def shade_color(colormap, shade):
    if shade in colormap:
        return colormap[shade]
    return colormap[min(colormap, key=lambda k: abs(k - shade))]


def material_of(names):
    first = names[0] if names else ""
    if first.startswith(METAL):
        return "metal"
    if first.startswith(HAIR):
        return "hair"
    if first.startswith(SKIN):
        return "body"
    return "cloth"


def closest_palette(material, colormap, taken):
    """The palette that looks most like pflat's default color, avoiding ramps another channel already uses."""
    stops = [colormap[k] for k in sorted(colormap)]

    def cost(ramp):
        total = 0
        for i, r in enumerate(ramp):
            s = stops[round(i * (len(stops) - 1) / (len(ramp) - 1))]
            total += sum((a - b) ** 2 for a, b in zip(s, r))
        return total

    ranked = sorted(palettes[material], key=lambda name: cost(palettes[material][name]))
    for name in ranked:
        if (material, name) not in taken:
            return name
    return ranked[0]


def assign_shades(shades, colormap, ramp):
    """Map sorted shades onto the ramp by brightness, never letting a brighter shade land on a darker step."""
    if not shades:
        return {}
    targets = [luma(c) for c in ramp]
    values = [luma(shade_color(colormap, s)) for s in shades]
    best = {(-1, 0): (0.0, [])}
    for n, value in enumerate(values):
        for step in range(len(ramp)):
            options = [v for (i, j), v in best.items() if i == n - 1 and j <= step]
            if options:
                prior = min(options, key=lambda o: o[0])
                best[(n, step)] = (prior[0] + abs(value - targets[step]), prior[1] + [step])
    final = min((v for (i, _), v in best.items() if i == len(values) - 1), key=lambda o: o[0])
    return dict(zip(shades, final[1]))


def channel_masks(rgba):
    fixed = rgba[:, :, 0] > 128
    secondary = ~fixed & (rgba[:, :, 1] > 128)
    return {"fixed": fixed, "secondary": secondary, "primary": ~fixed & ~secondary}


def texture_image(path):
    with Image.open(io.BytesIO(Z.read(ART + path))) as im:
        return im.convert("RGBA")


audit = {r["texture"].lower(): r for r in csv.DictReader(open(AUDIT, encoding="utf8"))}
overlap = {(r["slot"], r["id"]): r for r in csv.DictReader(open(OVERLAP, encoding="utf8"))}
credits_by_file = {}
for name in ("character", "gear"):
    for c in clean_json(Z.read(f"{DATA}credits/{name}.credits"))["items"]:
        credits_by_file[c["filename"].lower()] = c

existing_names = collections.defaultdict(set)
for root, _, files in os.walk(os.path.join(REPO, "sheet_definitions")):
    for f in files:
        if f.startswith("meta_") or f.startswith("chargen_"):
            continue
        d = json.load(open(os.path.join(root, f), encoding="utf8"))
        existing_names[d.get("type_name")].add((d.get("name") or "").lower())


def place_for(slot, item):
    tags = item.get("tags", [])
    if slot == "hat":
        return "helmet" if str(item.get("id", "")).startswith("helmet") else "hat"
    if slot == "back":
        if "cape" in str(item["id"]):
            return "cape"
        if "quiver" in str(item["id"]):
            return "quiver"
        return "back"
    if slot == "shirt" and str(item["id"]).startswith("neck") or "cable" == item["id"]:
        return "neck"
    return slot


report = collections.Counter()
held = []
written = []
pngs = 0
used_names = collections.defaultdict(set)
seen_textures = set()
masked = set()
members = sorted(n for n in NAMES if n.startswith(DATA + "character/") or n.startswith(DATA + "gear/"))
for member in members:
    rel = member[len(DATA):]
    parts = rel.split("/")
    if member.endswith("/") or len(parts) < 3 or parts[1] == "race":
        continue
    slot = parts[1]
    item = clean_json(Z.read(member))
    label = f'{slot}/{item["id"]}'
    if item["id"] in ("none", "base") or not item.get("chargen"):
        report["placeholder or not offered by pflat"] += 1
        continue
    if label in SAME_AS_UNIVERSAL:
        report["already in Universal LPC"] += 1
        continue
    if slot in SKIPPED_SLOTS:
        report[SKIPPED_SLOTS[slot]] += 1
        continue

    # Which textures each body wears.
    selector = "head" if any("head" in t for t in item["textures"]) else "body"
    wanted = HEAD_BODIES if selector == "head" else BODY_BODIES
    per_body = {}
    for body, code in wanted.items():
        for t in item["textures"]:
            if t.get(selector) == code and t.get("spritesheet", "char_base") == "char_base":
                per_body[body] = (t.get("front", ""), t.get("back", ""))
                break
    files = sorted({p for pair in per_body.values() for p in pair if p.endswith(".png") and ART + p in NAMES})
    if not files:
        report["no drawn texture for Universal LPC's bodies"] += 1
        continue
    if any(Image.open(io.BytesIO(Z.read(ART + p))).size != (832, 1344) for p in files):
        report["not on a standard sheet"] += 1
        continue

    # Is this art new?
    o = overlap.get((slot, item["id"]))
    iou = float(o["best_iou"]) if o and o["best_iou"] else 0.0
    contained = float(o["best_containment"]) if o and o["best_containment"] else 0.0
    if iou >= DUPLICATE_IOU:
        report["already in Universal LPC"] += 1
        continue
    if slot in DUPLICATE_SLOTS and contained >= DUPLICATE_CONTAINED:
        report["already in Universal LPC"] += 1
        continue
    key = tuple(files)
    if key in seen_textures:
        report["same art as another pflat part"] += 1
        continue
    seen_textures.add(key)

    # Does every texture have a license that checks out?
    verdicts = {p: audit.get(p.lower(), {}).get("verdict", "held: no credit row") for p in files}
    bad = {p: v for p, v in verdicts.items() if v != "pass"}
    if bad:
        report["held: license"] += 1
        held.append((label, item.get("name"), sorted(set(bad.values()))[0]))
        continue

    # Gather the shades each color channel uses.
    shades = collections.defaultdict(set)
    images = {}
    for p in files:
        rgba = np.asarray(texture_image(p))
        images[p] = rgba
        drawn = (rgba[:, :, 3] > 0) & (rgba[:, :, 2] > 0)
        for ch, mask in channel_masks(rgba).items():
            shades[ch].update(int(v) for v in np.unique(rgba[:, :, 2][mask & drawn]))

    names = {
        "primary": item.get("primarycolors") or (["human_skin_light"] if item.get("parent") == "body" else []),
        "secondary": item.get("secondarycolors") or [],
        "fixed": item.get("fixedcolors") or [],
    }
    if any(shades[ch] and not [n for n in names[ch] if n in colormaps] for ch in shades):
        report["held: color channel with no colormap"] += 1
        held.append((label, item.get("name"), "color channel with no colormap"))
        continue

    recolors, mappings, taken = {}, {}, set()
    source_colors = []
    for number, ch in enumerate(("primary", "secondary"), 1):
        if not shades[ch]:
            continue
        listed = [n for n in names[ch] if n in colormaps]
        if len(listed) < 2 and item.get("parent") != "body":
            continue  # One color only means pflat treats it as fixed.
        material = material_of(listed)
        base = closest_palette(material, colormaps[listed[0]], taken)
        taken.add((material, base))
        ramp = palettes[material][base]
        steps = assign_shades(sorted(shades[ch]), colormaps[listed[0]], ramp)
        mappings[ch] = {s: ramp[i] for s, i in steps.items()}
        source_colors += ramp
        allowed = {"body": ["ulpc", "lpcr", "all.lpcr"], "hair": ["ulpc", "lpcr", "all.lpcr"], "metal": ["ulpc", "lpcr", "cloth.ulpc", "all.lpcr"], "cloth": ["ulpc", "all.lpcr"]}[material]
        entry = {"material": material, "base": base, "palettes": allowed}
        if number > 1 or recolors:
            place_type = PLACES[place_for(slot, item)][0]
            entry = {"type_name": f"{place_type}_second", "label": "Second color", **entry}
        recolors[f"color_{len(recolors) + 1}"] = entry
    for ch in ("primary", "secondary", "fixed"):
        if ch in mappings or not shades[ch]:
            continue
        listed = [n for n in names[ch] if n in colormaps]
        baked = {}
        for s in shades[ch]:
            c = shade_color(colormaps[listed[0]], s)
            # Stay clear of the recolor's one-step tolerance so baked colors never recolor.
            step = -2 if luma(c) > 127 else 2
            while any(all(abs(a - b) <= 1 for a, b in zip(c, r)) for r in source_colors):
                c = tuple(max(0, min(255, v + step)) for v in c)
            baked[s] = c
        mappings[ch] = baked

    # Names are the hash contract, so each must be unique within its type.
    place = PLACES[place_for(slot, item)]
    type_name = place[0]
    display = re.sub(r"[()]", "", item.get("name") or item["id"]).strip()
    display = display.replace(" w/ ", " with ").replace(" + ", " and ").replace("Googles", "Goggles")
    display = re.sub(r"\s+", " ", display)
    base_name = display + " alt" if display[-1].isdigit() else display
    n = 2
    while display.lower() in existing_names[type_name] or display.lower() in used_names[type_name]:
        display = base_name if n == 2 and display[-1].isdigit() else f"{base_name} {n}"
        n += 1
    used_names[type_name].add(display.lower())

    # Write each animation.
    out_dirs = {}
    item_dir = f'chargen/{slot}/{item["id"]}'
    for p in files:
        stem = os.path.splitext(os.path.basename(p))[0]
        out = f"{item_dir}/{stem}"
        out_dirs[p] = out
        if DRY:
            pngs += len(ANIMATIONS)
            continue
        src = images[p]
        result = np.zeros(src.shape, dtype=np.uint8)
        # Shade zero with some opacity is a plain shadow, which stays black.
        result[:, :, 3] = src[:, :, 3]
        for ch, mask in channel_masks(src).items():
            for shade, color in mappings.get(ch, {}).items():
                result[mask & (src[:, :, 2] == shade) & (src[:, :, 3] > 0), :3] = color
        # Red and green together with no shade is pflat's "erase what is beneath", such as a leg behind a peg.
        cut = (src[:, :, 0] > 128) & (src[:, :, 1] > 128) & (src[:, :, 2] == 0) & (src[:, :, 3] > 0)
        result[cut] = (0, 0, 0, 0)
        converted = Image.fromarray(result, "RGBA")
        folder = os.path.join(REPO, "spritesheets", out)
        os.makedirs(folder, exist_ok=True)
        for animation, (row, rows, width) in ANIMATIONS.items():
            target = os.path.join(folder, f"{animation}.png")
            if not recolors:
                # A part with no recolorable color is one fixed variant, which lives one folder deeper.
                os.makedirs(os.path.join(folder, animation), exist_ok=True)
                target = os.path.join(folder, animation, "default.png")
            converted.crop((0, row * 64, width, (row + rows) * 64)).save(target)
            pngs += 1
            if cut.any():
                # Universal LPC erases through a separate layer of this color, marked is_mask.
                mask_image = np.zeros(src.shape, dtype=np.uint8)
                mask_image[cut] = (*CUT_OUT, 255)
                os.makedirs(os.path.join(folder, "mask"), exist_ok=True)
                Image.fromarray(mask_image, "RGBA").crop((0, row * 64, width, (row + rows) * 64)).save(os.path.join(folder, "mask", f"{animation}.png"))
                pngs += 1
                masked.add(out)

    definition = {"name": display, "priority": 90}
    front = {"zPos": place[2]}
    back = {"zPos": place[3]}
    for body, (f, bk) in per_body.items():
        front[body] = out_dirs[f] + "/" if f in out_dirs else None
        back[body] = out_dirs[bk] + "/" if bk in out_dirs else None
    number = 1
    # A layer names every body the part fits; null marks a body with nothing on that layer.
    if any(front.get(body, "") and front[body].rstrip("/") in masked for body in per_body):
        definition["layer_1"] = {"zPos": place[2], "is_mask": True, **{b: f"{v}mask/" if v and v.rstrip("/") in masked else None for b, v in front.items() if b != "zPos"}}
        number = 2
    if any(v for k, v in front.items() if k != "zPos"):
        definition[f"layer_{number}"] = front
        number += 1
    if any(v for k, v in back.items() if k != "zPos"):
        definition[f"layer_{number}"] = back
    definition["animations"] = list(ANIMATIONS)
    if item.get("parent") == "body":
        definition["match_body_color"] = True
    if recolors:
        definition["recolors"] = recolors if len(recolors) > 1 else recolors["color_1"]
    else:
        definition["variants"] = ["default"]
    definition["type_name"] = type_name
    definition["credits"] = []
    for p in files:
        c = credits_by_file[p.lower()]
        definition["credits"].append(
            {
                "file": out_dirs[p],
                "notes": "Converted from pflat's LPC Character Generator: recolored from its shade format and split by animation.",
                "authors": c.get("authors", []),
                "licenses": c.get("licenses", []),
                "urls": c.get("urls", []),
            }
        )
    written.append((place[1], f'{slot}_{item["id"]}', definition))

folders_made = 0
if not DRY:
    for folder, item_id, definition in written:
        full = os.path.join(REPO, "sheet_definitions", folder)
        if not os.path.isdir(full):
            os.makedirs(full)
            with open(os.path.join(full, f"meta_{os.path.basename(folder)}.json"), "w", encoding="utf8") as fh:
                fh.write('{\n    "priority": 90\n}\n')
            folders_made += 1
        with open(os.path.join(full, f"chargen_{item_id}.json"), "w", encoding="utf8", newline="\n") as fh:
            json.dump(definition, fh, indent=2, ensure_ascii=False)
            fh.write("\n")

print("parts written", len(written), "images", pngs, "new folders", folders_made)
by_place = collections.Counter(w[0] for w in written)
for k, v in sorted(by_place.items()):
    print(f"  {v:4} {k}")
print("left out:")
for k, v in report.most_common():
    print(f"  {v:4} {k}")
print("held for license or color:")
for h in held:
    print("  ", h)
print("written:", [w[2]["name"] for w in written])
