LPC Sprite Character Tools
=============================================

These assets are various tools to help generate sheets.

It is recommended to [use these in conjunction with lpctools.](LPCTOOLS.md)


### Masks

Masks are intended to aid in adjusting the positions of assets and cutouts. When mapping assets with a mask, it will handle cutouts automatically if you use lpctools.

The "references" sheet under Masks is for setting offsets in relation to the head. This is useful for positioning static assets on the head, such as heads themselves, appendages, facial assets, hats, hair, etc.


### Palettes

These palettes are designed to work with lpctools. Please see the palettes directly for more details on how to use them.

The base "palettes" directory contains the standard palettes used by this generator. However, some assets use "custom" palettes. In addition, LPC Revised Palettes are also available here, along with the ability to convert between LPC Revised Palettes or our standard palettes.

### Layouts

Layouts are for use in lpctools, like so:
```
lpctools arrange distribute --layout layout/universal-expanded.json --input /path/to/split/assets --output hat/helmet/bascinet/adult.png --offsets tools/masks/reference_points.png --mask tools/masks/masks_male_head.png
lpctools arrange separate --layout layout/universal-expanded.json --input hat/helmet/bascinet/adult.png --output characters/updates/hat/helmet/bascinet/_separated/
```

Arrange a set of assets to all frames with the correct layout. `universal-expanded.json` is the new set that includes idle, run, jump, climb, sit, emotes, backslash, and halfslash. In the future I'd also like to add grab/carry/lift. You can also separate the assets into individual animations using the "separate" comman.

These are also equivalent to the built-in lpctools layout's "universal" and "universal-expanded".



### Cutouts

These cutouts can be used on their own. It is recommended to use cutouts with Aseprite or another image editor. When generating assets, you can select these cutouts across the entire page on the "black" to remove any elements from a specific layer.

lpctools is probably a more viable option along with masks, but these cutouts are another potential option you can use instead.

### Converting color variants

`variant_measure.py` reads every sheet of every part defined with one image per color and records how each color maps onto the others. `convert_variants.py` turns those measurements into one base sheet per animation, plus palettes and `aliases` that keep old links working. It reports every part it leaves alone, and how far each named color moved.

### Weapon idle from Vitruvian

`import_vitruvian_idle.py` brings Vitruvian LPC Studio's idle art into the matching weapons and tools. It uses a layer only when its walk art lines up with the part's own, carries the colors across by comparing the two walk sheets, and adds credits for each sheet from Vitruvian's license review.

### Filling missing animations

`fill_animations.py` gives head-worn parts the animations they lack, by moving the part's own frames to follow the head. With `--check` it hides sheets of complete parts, rebuilds them and scores them against the real art, which is how the method was chosen: it does not suit the hurt animation, neck parts or tails, and for other body-worn parts only the idle animation, filled with `--idle`, holds up. Every sheet it writes is listed in `filled-animations.csv`, so real art can replace it later, and each part's credits say so.

It also fills wings in every missing animation, following the head, since wings ride on the back and flap regardless of pose. Backpacks and what they carry do the same, since they sit high on the back and hold their shape; no backpack has real art in those animations, so they were judged by eye rather than scored. Neck parts also follow the head; rebuilt frames land within two pixels of the real art in 78 to 100 percent of frames, depending on the animation, on the ten that have real art to compare. With `--emote` it fills the emote animation of torso parts without sleeves, following the torso. Other animations of clothes do not pass the check from a part's own frames, whether guided by the head, torso, waist, hips, shoulders, hands or whole body.

### Filling from a near-identical part

`fill_from_twin.py` fills a part from a near-identical part that has the animation. Across every part, overlap on the older animations closely predicts overlap on the newer ones, but few parts have a close twin. A pair is used only if its hidden real sheets rebuild at 0.92 or better. Sheets are listed in `filled-twins.csv` and each part's credits name the twin's authors.

### Filling missing body animations

`fill_from_body.py` fills body-worn parts. Every pixel of a newer frame asks where the base body, a plain long shirt and plain pants look most like this in the older animations, those answers are cleaned up into a few solid pieces, and the part copies its own pixels from there. The body, shirt and pants only steer the map, so the part's authors and licenses stand. A long hem follows the torso below the waist instead, and capes and tails follow the head. With real sheets hidden, 59 complete male garments overlap the real art by 0.66 to 0.79 depending on the animation, against 0.37 to 0.68 for copying one whole older frame. That is below the bar the other tools use, so each part filled here lists `unchecked_animations` in its definition and the app flags it. Remove an animation from that list once a person has looked at it. Every sheet is listed in `tools/filled-from-body.csv`, so real art can replace it later.

`fill_bodies.py` builds a base body's missing sheets from a body that has them. Wherever the donor's frame exactly matches a stretch of a frame both bodies share, it takes the target body's own drawing, and the rest stays the donor's. With `--check` it hides real sheets, rebuilds them and scores them. Muscular shoot, climb and emote and pregnant backslash and halfslash pass and are listed in `filled-bodies.csv`. The child body does not pass, nor does muscular from the thinner art used for combat idle, backslash and halfslash, so those stay missing.
