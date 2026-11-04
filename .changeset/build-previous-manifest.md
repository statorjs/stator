---
'@statorjs/stator': patch
---

`stator build` no longer goes quiet about session resets. The "sessions reset on deploy for" line was computed only against a previous `dist/stator-manifest.json`, which a fresh CI checkout never has, so the report was silent exactly where it mattered and silence read as "nothing reset". The build now says `no previous manifest — cannot say which sessions this deploy resets` in that case, names the manifest it compared against otherwise, and takes `--previous <path>` (`buildApp({ previousManifest })`) so a pipeline can fetch the last deployed manifest and diff against what is actually running. A path given and not found fails the build.
