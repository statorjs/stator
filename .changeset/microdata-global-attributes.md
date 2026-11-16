---
'@statorjs/stator': patch
---

Templates type the microdata attributes (`itemscope`, `itemtype`, `itemprop`, `itemid`, `itemref`) and the remaining HTML global attributes (`inert`, `translate`, `spellcheck`, `contenteditable`, `enterkeyhint`, `inputmode`, `autocapitalize`, `autocorrect`, `autofocus`, `accesskey`, `nonce`, `is`, `part`, `exportparts`, `slot`, `writingsuggestions`) on every element, so schema.org markup passes `stator check`. `inputmode` is now checked against its HTML keywords.
