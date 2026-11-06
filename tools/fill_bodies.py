"""Build a base body's missing animations from a body that has them.

The donor body's frame is compared with every frame, in the same facing, that both bodies have. Wherever a stretch of it
matches exactly, this takes the target body's own drawing of that stretch, so a torso or a planted leg is the target's real
art. Stretches nothing matches keep the donor's pixels, so a limb in a new pose is the donor's limb. Every sheet written
is listed in tools/filled-bodies.csv, so real art can replace it later.

Only sheets that passed the check are listed in BUILDS. The child body scored 0.78 to 0.83 from its nearest donor and comes
out with arms too long. Muscular from the thin art used for male combat idle, backslash and halfslash scored 0.84 to 0.90
with visible blemishes.

With --check it writes nothing. It hides sheets the target body does have, rebuilds them and scores them against the real
art: first the silhouette overlap, then the share of pixels that match exactly.

usage: fill_bodies.py <repo root> [--apply] [--check]
Without --apply or --check it only plans.
"""
import csv
import os
import sys

import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation, binary_opening, label

ROOT = sys.argv[1]
APPLY = "--apply" in sys.argv
CHECK = "--check" in sys.argv
ART = os.path.join(ROOT, "spritesheets", "body", "bodies")
MANIFEST = os.path.join(ROOT, "tools", "filled-bodies.csv")

# Target body: the donor and the sheets to build.
BUILDS = {
    "muscular": ("male", ["shoot", "climb", "emote"]),
    "pregnant": ("female", ["backslash", "halfslash"]),
}
HOLDOUTS = {
    "muscular": ["slash", "spellcast", "thrust", "walk"],
    "pregnant": ["slash", "thrust"],
}
SHEETS = ["spellcast", "thrust", "walk", "slash", "shoot", "hurt", "climb", "idle", "jump", "sit", "emote", "run", "combat_idle", "backslash", "halfslash"]
ONE_ROW = {"climb": "n", "hurt": "s"}
FACINGS = "nwse"
PALETTE = [(39, 25, 32), (153, 66, 60), (204, 134, 101), (228, 164, 124), (249, 213, 186), (250, 236, 231)]
RGBA = np.array([(0, 0, 0, 0)] + [(*color, 255) for color in PALETTE], np.uint8)
SHIFTS = [(dy, dx) for dy in range(-6, 7) for dx in range(-3, 4)]
STRETCH = np.ones((5, 5), bool)  # The smallest stretch that counts as a match.
CANDIDATES = 40  # Best-matching frames and shifts looked at for each frame.
MOST_SOURCES = 6  # Frames that may contribute to one frame.
LEAST_GAIN = 10  # A source must add more pixels than this.


def load(body, sheet):
    path = os.path.join(ART, body, f"{sheet}.png")
    if not os.path.exists(path):
        return None
    with Image.open(path) as image:
        pixels = np.asarray(image.convert("RGBA"))
    indexed = np.zeros(pixels.shape[:2], np.int8)
    for i, color in enumerate(PALETTE, 1):
        indexed[(pixels[..., :3] == color).all(-1) & (pixels[..., 3] > 0)] = i
    return indexed


def frames_of(sheet_image, sheet):
    columns = range(0, sheet_image.shape[1], 64)
    if sheet in ONE_ROW:
        return {ONE_ROW[sheet]: [sheet_image[:64, x:x + 64] for x in columns]}
    return {facing: [sheet_image[64 * row:64 * row + 64, x:x + 64] for x in columns] for row, facing in enumerate(FACINGS)}


def moved(frame, dy, dx):
    return np.roll(np.roll(frame, dy, 0), dx, 1)


def shared_frames(donor, target, sheets, facing):
    shared = []
    for sheet in sheets:
        donor_image, target_image = load(donor, sheet), load(target, sheet)
        if donor_image is None or target_image is None:
            continue
        donor_frames = frames_of(donor_image, sheet)
        if facing not in donor_frames:
            continue
        for a, b in zip(donor_frames[facing], frames_of(target_image, sheet)[facing]):
            if (a > 0).any() and (b > 0).any():
                shared.append((a, b))
    return shared


def tidied(frame, donor_frame):
    """Ink outside the donor's silhouette that hangs by a thread or floats is a leftover, not a limb."""
    for _ in range(2):
        solid = frame > 0
        neighbors = sum(moved(solid, dy, dx).astype(np.int8) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx)
        frame = frame.copy()
        frame[solid & (donor_frame == 0) & (neighbors <= 2)] = 0
    pieces, count = label(frame > 0, structure=np.ones((3, 3)))
    for piece in range(1, count + 1):
        where = pieces == piece
        if where.sum() < 12 and not (donor_frame[where] > 0).any():
            frame[where] = 0
    return frame


def built_frame(donor_frame, shared):
    ink = donor_frame > 0
    if not ink.any():
        return donor_frame.copy()
    scored = []
    for i, (a, _) in enumerate(shared):
        for dy, dx in SHIFTS:
            scored.append(((moved(a, dy, dx)[ink] == donor_frame[ink]).sum(), i, dy, dx))
    scored.sort(key=lambda entry: -entry[0])
    near = binary_dilation(ink, iterations=3)
    candidates = []
    for _, i, dy, dx in scored[:CANDIDATES]:
        a, b = shared[i]
        match = binary_opening(moved(a, dy, dx) == donor_frame, STRETCH) & near
        # Empty space counts only right beside ink this same stretch matched, or a wider limb in the source leaves a stray outline.
        match &= ink | binary_dilation(match & ink, iterations=2)
        candidates.append((match, moved(b, dy, dx)))
    out = donor_frame.copy()
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
    return tidied(out, donor_frame)


def build(donor, target, sheet):
    # Sheets this tool wrote are not real art: as sources they would compound, and they would leak held-out art into the check.
    known = [other for other in SHEETS if other != sheet and other not in BUILDS[target][1]]
    donor_image = load(donor, sheet)
    out = np.zeros(donor_image.shape, np.int8)
    for facing, frames in frames_of(donor_image, sheet).items():
        shared = shared_frames(donor, target, known, facing)
        row = 0 if sheet in ONE_ROW else FACINGS.index(facing)
        for column, frame in enumerate(frames):
            out[64 * row:64 * row + 64, 64 * column:64 * column + 64] = built_frame(frame, shared)
    return out


def score(built, real):
    a, b = built > 0, real > 0
    either = (a | b).sum()
    return (a & b).sum() / either, ((built == real) & (a | b)).sum() / either


def main():
    if CHECK:
        for target, (donor, _) in BUILDS.items():
            for sheet in HOLDOUTS[target]:
                real = load(target, sheet)
                print(target, sheet, "copied from %s %.3f %.3f" % (donor, *score(load(donor, sheet), real)), "built %.3f %.3f" % score(build(donor, target, sheet), real), flush=True)
        return
    rows = []
    for target, (donor, sheets) in BUILDS.items():
        for sheet in sheets:
            rows.append((target, sheet, donor))
            path = os.path.join(ART, target, f"{sheet}.png")
            print(target, sheet, "from", donor, "replacing a sheet" if os.path.exists(path) else "new", flush=True)
            if APPLY:
                Image.fromarray(RGBA[build(donor, target, sheet).astype(int)], "RGBA").save(path, optimize=True)
    if APPLY:
        with open(MANIFEST, "w", newline="", encoding="utf-8") as file:
            writer = csv.writer(file, lineterminator="\n")
            writer.writerow(["body", "sheet", "donor"])
            writer.writerows(rows)


if __name__ == "__main__":
    main()
