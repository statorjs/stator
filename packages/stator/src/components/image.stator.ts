import {
  classList,
  defer,
  each,
  html,
  itemBind,
  match,
  on,
  read,
  spreadAttrs,
  styleList,
  when,
} from '@statorjs/stator/template'
import { getImage, type ImageProps } from './images.ts'

export default function (props: ImageProps) {
  const p = props
  const {
    alt,
    class: className,
    sizes = '100vw',
    priority,
    loading = priority ? 'eager' : 'lazy',
    fetchpriority = priority ? 'high' : undefined,
    decoding = 'async',
  } = p
  const img = getImage(p)
  return html`<img src="${img.src}" srcset="${img.srcset ?? undefined}" sizes="${img.srcset ? sizes : undefined}" alt="${alt}" width="${img.width}" height="${img.height}" loading="${loading}" fetchpriority="${fetchpriority}" decoding="${decoding}" class="${className}" />`
}
