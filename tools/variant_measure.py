"""Read every sheet of every part defined with color `variants` and record, per part,
how each color maps from the part's richest color, across all layers, bodies and animations.

The result is a cache the conversion planner reads, so the planner can be rerun without
touching 70,000 images.

usage: variant_measure.py <repo root> <output json>
"""
import collections, glob, json, multiprocessing, os, re, sys
import numpy as np
from PIL import Image

ROOT, OUT = sys.argv[1:3]
DEFS = os.path.join(ROOT, "sheet_definitions")
SHEETS = os.path.join(ROOT, "spritesheets")


def filename(variant):
    return variant.replace(" ", "_")


def layer_paths(d):
    """{(layer key, path): custom animation or None}, with path templates expanded."""
    out = {}
    for n in range(1, 10):
        layer = d.get(f"layer_{n}")
        if not layer:
            break
        custom = layer.get("custom_animation")
        for key, value in layer.items():
            if key in ("zPos", "custom_animation") or not isinstance(value, str):
                continue
            paths = [value]
            if "${" in value:
                paths = []
                for name, table in d.get("replace_in_path", {}).items():
                    token = "${" + name + "}"
                    if token in value:
                        paths += [value.replace(token, r) for r in table.values()]
            for p in paths:
                out[(f"layer_{n}", p)] = custom
    return out


def load(path):
    with Image.open(path) as im:
        return np.asarray(im.convert("RGBA"))


def pack(a):
    return a[..., 0].astype(np.uint32) << 16 | a[..., 1].astype(np.uint32) << 8 | a[..., 2]


def measure(defpath):
    d = json.load(open(defpath, encoding="utf8"))
    rel = os.path.relpath(defpath, DEFS).replace("\\", "/")
    variants = d["variants"]
    result = {
        "definition": rel,
        "name": d.get("name"),
        "type_name": d.get("type_name"),
        "variants": variants,
        "unreadable": [],
    }
    # Every sheet slot: (path, animation or None for a custom animation's direct file).
    slots = []
    for (layer, path), custom in layer_paths(d).items():
        full = os.path.join(SHEETS, path)
        if custom:
            slots.append((path, None))
        elif os.path.isdir(full):
            for entry in sorted(os.listdir(full)):
                if os.path.isdir(os.path.join(full, entry)):
                    slots.append((path, entry))
    slots = sorted(set(slots), key=str)
    result["slots"] = len(slots)
    if not slots or len(variants) < 2:
        return result

    color_counts = collections.Counter()
    present = {v: 0 for v in variants}
    missing = collections.defaultdict(list)
    images = {}
    for slot in slots:
        path, anim = slot
        images[slot] = {}
        for v in variants:
            f = (
                os.path.join(SHEETS, path, filename(v) + ".png")
                if anim is None
                else os.path.join(SHEETS, path, anim, filename(v) + ".png")
            )
            if not os.path.exists(f):
                missing[v].append(f"{path}{anim or ''}")
                continue
            try:
                a = load(f)
            except Exception as e:  # noqa: BLE001 - a broken image is a finding
                result["unreadable"].append(f"{f}: {e}")
                continue
            images[slot][v] = a
            present[v] += 1
            color_counts[v] = max(color_counts[v], 0)
    # Richest color: the most distinct colors across all of its sheets.
    distinct = {}
    for v in variants:
        seen = set()
        for slot in slots:
            a = images[slot].get(v)
            if a is not None:
                seen.update(np.unique(pack(a)[a[..., 3] > 0]).tolist())
        distinct[v] = seen
    usable = [v for v in variants if present[v]]
    if len(usable) < 2:
        result["usable"] = usable
        return result
    richest = max(usable, key=lambda v: (len(distinct[v]), present[v]))
    result["richest"] = richest
    result["present"] = present
    result["distinct"] = {v: len(distinct[v]) for v in variants}
    result["missing"] = {v: sorted(m)[:6] for v, m in missing.items()}
    result["missing_count"] = {v: len(m) for v, m in missing.items()}

    maps = {v: collections.defaultdict(collections.Counter) for v in usable}
    bad_shape = collections.defaultdict(list)
    bad_alpha = collections.Counter()
    all_slots_for_richest = 0
    for slot in slots:
        A = images[slot].get(richest)
        if A is None:
            continue
        all_slots_for_richest += 1
        am = A[..., 3] > 0
        ac = pack(A)
        for v, B in images[slot].items():
            if B.shape != A.shape:
                bad_shape[v].append(f"{slot[0]}{slot[1] or ''} size")
                continue
            bm = B[..., 3] > 0
            if not (bm == am).all():
                bad_shape[v].append(f"{slot[0]}{slot[1] or ''} {int((bm != am).sum())}px")
            both = am & bm
            if (A[..., 3][both] != B[..., 3][both]).any():
                bad_alpha[v] += 1
            bc = pack(B)
            pairs, counts = np.unique(
                np.stack([ac[both], bc[both]]), axis=1, return_counts=True
            )
            for (s, t), c in zip(pairs.T.tolist(), counts.tolist()):
                maps[v][s][t] += c
    result["bad_shape"] = {v: m[:6] for v, m in bad_shape.items()}
    result["bad_shape_count"] = {v: len(m) for v, m in bad_shape.items()}
    result["bad_alpha"] = dict(bad_alpha)
    result["maps"] = {
        v: {f"{s:06x}": {f"{t:06x}": c for t, c in m.items()} for s, m in table.items()}
        for v, table in maps.items()
    }
    return result


if __name__ == "__main__":
    files = []
    for p in glob.glob(DEFS + "/**/*.json", recursive=True):
        if os.path.basename(p).startswith("meta_"):
            continue
        j = json.load(open(p, encoding="utf8"))
        if j.get("variants") and "layer_1" in j:
            files.append(p)
    print("parts", len(files), flush=True)
    with multiprocessing.Pool(6) as pool:
        out = []
        for i, r in enumerate(pool.imap_unordered(measure, files)):
            out.append(r)
            if i % 20 == 0:
                print(i, r["definition"], flush=True)
    out.sort(key=lambda r: r["definition"])
    json.dump(out, open(OUT, "w", encoding="utf8"))
    print("done", len(out))
