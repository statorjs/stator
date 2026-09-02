---
"@statorjs/stator": patch
---

The sharp transformer encodes AVIF at effort 2 (sharp defaults to 4). Effort is the encoder's CPU-vs-density trade, not a visual-quality knob: at effort 4 a cold variant took ~16s on a shared-cpu host — an on-demand endpoint has a real visitor waiting on that encode, and a few percent of file size is the wrong thing to charge them for. Pair with `images.concurrency` for small hosts.
