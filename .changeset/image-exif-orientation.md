---
"@statorjs/stator": minor
---

EXIF orientation is handled end-to-end: transforms bake the rotation into the pixels (re-encoding drops the orientation tag, so without this every variant of a portrait phone photo came out sideways) and `probeImage` reports *display* dimensions for transposing orientations, so stored width/height — and the CLS box rendered from them — are never sideways either.
