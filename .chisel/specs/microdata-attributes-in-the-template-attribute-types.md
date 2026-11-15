---
title: Microdata attributes in the template attribute types
status: draft
created: 2026-11-15
updated: 2026-11-15
area: compiler
---

## What and Why

`template/html-attributes.ts` types the global attributes, ARIA and `role` but none of the microdata globals, so `itemscope`, `itemprop` and friends fail `stator check`. A theme ported to Stator had to drop its schema.org markup (IndiePub minimal theme, 2026-11-15).

## Success Criteria

- Global attributes gain `itemscope` (boolean), `itemprop`, `itemtype`, `itemid` and `itemref` (strings), per the HTML spec.
- A test template using schema.org microdata passes `stator check`.
- A quick audit of the other HTML global attributes (`inert`, `popover`, `enterkeyhint`, `translate`, `nonce`, …) adds any that are missing.
