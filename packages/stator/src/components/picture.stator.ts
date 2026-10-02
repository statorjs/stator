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
import Image from './image.stator.ts'
import { getPicture, type PictureProps, SOURCE_TYPES } from './images.ts'

export default function (props: PictureProps) {
  const p = props
  const { sources } = getPicture(p)
  return html`${sources.length === 0 ? html`${Image({ ...p })}` : html`<picture>${each(sources, (s) => html`<source media="${s.media}" type="${SOURCE_TYPES[s.format]}" srcset="${s.srcset}" sizes="${s.sizes}" />`)}${Image({ ...p })}</picture>`}`
}
