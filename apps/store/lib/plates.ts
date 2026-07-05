/**
 * The catalog plates: flat side-profile SVG line art, one per silhouette.
 * Region fills are CSS variables (--plate-upper / --plate-sole /
 * --plate-accent) set by `plateStyle(colorway)` on a wrapper — which is what
 * lets the product page's variant island recolor a plate live, without a
 * server round-trip.
 *
 * All plates share a 260×150 viewBox and the same sole slab, so a grid of
 * mixed silhouettes sits on a common baseline.
 */
import type { Product } from './catalog-data.ts'

const INK = '#22262b'
const S = `stroke="${INK}" stroke-linejoin="round" stroke-linecap="round"`
const UPPER = 'var(--plate-upper)'
const SOLE = 'var(--plate-sole)'
const ACCENT = 'var(--plate-accent)'

/** The shared sole slab + stitch line. */
const sole = `
  <path d="M28 112 Q24 124 40 125 L212 125 Q236 125 234 111 Q232 101 214 99 L42 97 Q30 97 28 112 Z"
        fill="${SOLE}" ${S} stroke-width="2.5"/>
  <path d="M44 104 L212 106" fill="none" ${S} stroke-width="1.5" stroke-dasharray="4 4"/>`

const heelPatch = `
  <path d="M44 97 C41 84 41 66 50 52 Q56 52 60 56 C55 68 54 84 56 97 Z"
        fill="${ACCENT}" ${S} stroke-width="2"/>`

const PLATES: Record<Product['silhouette'], string> = {
  'low-top': `${sole}
  <path d="M44 97 C40 82 40 64 50 50 Q60 44 68 50 C74 54 82 56 88 52 C92 44 102 42 108 46 L114 52 L172 78 C192 86 206 92 216 99 L44 97 Z"
        fill="${UPPER}" ${S} stroke-width="2.5"/>
  ${heelPatch}
  <path d="M52 52 Q62 47 70 52" fill="none" ${S} stroke-width="1.7"/>
  <path d="M108 47 Q112 52 114 58" fill="none" ${S} stroke-width="1.7"/>
  <path d="M114 54 L170 79" fill="none" ${S} stroke-width="1.7"/>
  <path d="M110 64 L162 87" fill="none" ${S} stroke-width="1.7"/>
  <g ${S} stroke-width="2.3">
    <line x1="118" y1="64" x2="122" y2="56"/><line x1="128" y1="68" x2="132" y2="60"/>
    <line x1="138" y1="73" x2="142" y2="65"/><line x1="148" y1="77" x2="152" y2="69"/>
    <line x1="158" y1="82" x2="162" y2="74"/>
  </g>
  <path d="M184 84 Q196 92 202 99" fill="none" ${S} stroke-width="1.7"/>
  <path d="M104 60 C104 74 104 86 106 97" fill="none" ${S} stroke-width="1.7"/>`,

  'slip-on': `${sole}
  <path d="M44 97 C40 82 40 64 50 50 Q60 44 68 50 C82 58 98 62 112 64 C150 70 188 84 216 99 L44 97 Z"
        fill="${UPPER}" ${S} stroke-width="2.5"/>
  ${heelPatch}
  <path d="M52 52 Q62 47 70 52" fill="none" ${S} stroke-width="1.7"/>
  <g ${S} stroke-width="1.8">
    <line x1="98" y1="60" x2="100" y2="70"/><line x1="106" y1="62" x2="108" y2="72"/>
    <line x1="114" y1="64" x2="116" y2="74"/>
  </g>
  <path d="M184 84 Q196 92 202 99" fill="none" ${S} stroke-width="1.7"/>`,

  'high-top': `${sole}
  <path d="M44 97 C40 76 40 50 52 36 Q62 30 70 36 C76 40 84 42 90 38 C94 30 104 28 110 32 L116 38 L174 76 C194 86 206 92 216 99 L44 97 Z"
        fill="${UPPER}" ${S} stroke-width="2.5"/>
  <path d="M44 97 C41 80 41 56 52 38 Q58 38 62 42 C55 56 54 80 56 97 Z"
        fill="${ACCENT}" ${S} stroke-width="2"/>
  <path d="M54 38 Q64 33 72 38" fill="none" ${S} stroke-width="1.7"/>
  <path d="M116 40 L172 77" fill="none" ${S} stroke-width="1.7"/>
  <path d="M110 50 L162 86" fill="none" ${S} stroke-width="1.7"/>
  <g ${S} stroke-width="2.3">
    <line x1="118" y1="50" x2="123" y2="42"/><line x1="127" y1="56" x2="132" y2="48"/>
    <line x1="136" y1="62" x2="141" y2="54"/><line x1="145" y1="68" x2="150" y2="60"/>
    <line x1="154" y1="74" x2="159" y2="66"/><line x1="163" y1="80" x2="168" y2="72"/>
  </g>
  <path d="M184 84 Q196 92 202 99" fill="none" ${S} stroke-width="1.7"/>`,

  runner: `${sole}
  <path d="M44 97 C40 82 39 64 49 51 Q59 44 68 50 C74 54 82 56 88 52 C92 44 102 42 108 46 L114 52 L168 76 C190 85 205 92 216 99 L44 97 Z"
        fill="${UPPER}" ${S} stroke-width="2.5"/>
  ${heelPatch}
  <path d="M52 52 Q62 47 70 52" fill="none" ${S} stroke-width="1.7"/>
  <path d="M114 54 L166 78" fill="none" ${S} stroke-width="1.7"/>
  <g ${S} stroke-width="2.3">
    <line x1="120" y1="63" x2="124" y2="55"/><line x1="132" y1="68" x2="136" y2="60"/>
    <line x1="144" y1="73" x2="148" y2="65"/><line x1="156" y1="78" x2="160" y2="70"/>
  </g>
  <g ${S} stroke-width="1.4">
    <path d="M120 78 L136 88"/><path d="M132 76 L148 86"/><path d="M144 74 L160 84"/>
    <path d="M156 72 L172 84"/><path d="M168 74 L182 86"/>
  </g>`,

  deck: `${sole}
  <path d="M44 97 C40 84 40 68 50 58 Q60 52 68 56 C80 62 94 66 106 66 C144 72 182 84 210 97 L44 97 Z"
        fill="${UPPER}" ${S} stroke-width="2.5"/>
  <path d="M44 97 C42 84 42 70 50 60 Q55 60 58 63 C53 74 52 86 54 97 Z"
        fill="${ACCENT}" ${S} stroke-width="2"/>
  <path d="M52 58 Q60 54 68 58" fill="none" ${S} stroke-width="1.7"/>
  <path d="M118 68 C150 62 182 74 202 92" fill="none" ${S} stroke-width="1.8"/>
  <path d="M126 72 C152 67 178 77 196 92" fill="none" ${S} stroke-width="1.4" stroke-dasharray="3 3"/>
  <g ${S} stroke-width="2.3">
    <line x1="104" y1="74" x2="108" y2="66"/><line x1="116" y1="77" x2="120" y2="69"/>
  </g>`,

  sandal: `${sole}
  <path d="M40 97 Q38 84 54 83 L200 86 Q216 87 214 99 L40 97 Z"
        fill="${ACCENT}" ${S} stroke-width="2.2"/>
  <path d="M46 90 L206 92" fill="none" ${S} stroke-width="1.3" stroke-dasharray="3 3"/>
  <path d="M84 90 C94 52 158 52 170 90 L152 91 C144 66 108 67 102 90 Z"
        fill="${UPPER}" ${S} stroke-width="2.5"/>
  <line x1="122" y1="58" x2="128" y2="66" ${S} stroke-width="1.7"/>`,

  'boot-tall': `${sole}
  <path d="M44 97 L42 32 Q42 24 52 24 L94 24 Q102 24 103 32 L106 62 C148 70 190 84 216 99 L44 97 Z"
        fill="${UPPER}" ${S} stroke-width="2.5"/>
  <path d="M44 97 L42.5 34 Q43 27 50 26 L58 26 C55 50 54 76 56 97 Z"
        fill="${ACCENT}" ${S} stroke-width="2"/>
  <path d="M46 34 L100 34" fill="none" ${S} stroke-width="1.7"/>
  <path d="M84 26 Q90 18 96 26" fill="none" ${S} stroke-width="2"/>
  <path d="M104 64 C104 76 104 86 106 97" fill="none" ${S} stroke-width="1.7"/>
  <path d="M184 84 Q196 92 202 99" fill="none" ${S} stroke-width="1.7"/>`,

  'rain-shoe': `${sole}
  <path d="M44 97 C40 78 42 56 56 46 Q68 40 78 46 C90 54 104 58 116 60 C152 68 188 84 216 99 L44 97 Z"
        fill="${UPPER}" ${S} stroke-width="2.5"/>
  <path d="M58 48 Q68 43 78 48" fill="none" ${S} stroke-width="1.7"/>
  <circle cx="88" cy="52" r="3" fill="${ACCENT}" ${S} stroke-width="1.6"/>
  <path d="M50 78 C100 84 160 90 208 96" fill="none" ${S} stroke-width="1.8"/>
  <path d="M50 84 C100 90 156 95 204 99" fill="none" ${S} stroke-width="1.3" stroke-dasharray="4 4"/>`,

  sock: `
  <path d="M100 26 L152 26 L152 78 C152 84 156 88 164 92 L186 102 Q198 108 192 118 Q186 126 172 122 L118 104 Q100 98 100 80 Z"
        fill="${UPPER}" ${S} stroke-width="2.5"/>
  <path d="M100 26 L152 26 L152 44 L100 44 Z" fill="${ACCENT}" ${S} stroke-width="2.2"/>
  <g ${S} stroke-width="1.5">
    <line x1="108" y1="28" x2="108" y2="42"/><line x1="117" y1="28" x2="117" y2="42"/>
    <line x1="126" y1="28" x2="126" y2="42"/><line x1="135" y1="28" x2="135" y2="42"/>
    <line x1="144" y1="28" x2="144" y2="42"/>
  </g>
  <path d="M118 104 Q136 112 158 116" fill="none" ${S} stroke-width="1.7"/>`,

  laces: `
  <path d="M70 78 C70 48 130 48 130 78 C130 106 70 106 70 78 Z" fill="none" ${S} stroke-width="14"/>
  <path d="M70 78 C70 48 130 48 130 78 C130 106 70 106 70 78 Z" fill="none" stroke="${UPPER}" stroke-width="9"/>
  <path d="M130 78 C130 54 184 54 184 78 C184 102 130 102 130 78 Z" fill="none" ${S} stroke-width="14"/>
  <path d="M130 78 C130 54 184 54 184 78 C184 102 130 102 130 78 Z" fill="none" stroke="${UPPER}" stroke-width="9"/>
  <path d="M184 78 L206 70" ${S} stroke-width="14"/>
  <path d="M184 78 L206 70" stroke="${UPPER}" stroke-width="9" stroke-linecap="round"/>
  <path d="M198 73 L212 68" fill="none" stroke="${ACCENT}" stroke-width="9" stroke-linecap="round"/>
  <path d="M198 73 L212 68" fill="none" ${S} stroke-width="2"/>`,

  kit: `
  <rect x="134" y="68" width="82" height="42" rx="8" fill="${SOLE}" ${S} stroke-width="2.5"/>
  <path d="M134 82 L216 82" fill="none" ${S} stroke-width="1.7"/>
  <ellipse cx="175" cy="96" rx="16" ry="8" fill="none" ${S} stroke-width="1.5"/>
  <rect x="52" y="44" width="66" height="24" rx="10" transform="rotate(28 85 56)"
        fill="${UPPER}" ${S} stroke-width="2.5"/>
  <g ${S} stroke-width="2.2">
    <line x1="104" y1="86" x2="100" y2="100"/><line x1="112" y1="90" x2="108" y2="104"/>
    <line x1="96" y1="82" x2="92" y2="96"/><line x1="88" y1="78" x2="84" y2="92"/>
  </g>
  <rect x="76" y="60" width="46" height="18" rx="4" transform="rotate(28 99 69)"
        fill="${ACCENT}" ${S} stroke-width="2.2"/>`,
}

/** Full SVG markup for a silhouette. Colors come from the wrapper's CSS
 *  variables (see `plateStyle`). */
export function plateSvg(silhouette: Product['silhouette']): string {
  return `<svg viewBox="0 0 260 150" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">${PLATES[silhouette]}</svg>`
}
