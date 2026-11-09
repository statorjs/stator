/* @stator contract=1 compiler=3.0.0-next.1 */
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
  return html`${sources.length === 0 ? html`${Image({ ...p })}` : html`<picture>${each(sources, (s) => html`<source media="${s.media}" type="${SOURCE_TYPES[s.format]}" srcset="${s.srcset}" sizes="${s.sizes}">`)}${Image({ ...p })}</picture>`}`
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInBpY3R1cmUuc3RhdG9yIl0sInNvdXJjZXNDb250ZW50IjpbIi0tLVxuaW1wb3J0IHsgZ2V0UGljdHVyZSwgU09VUkNFX1RZUEVTLCB0eXBlIFBpY3R1cmVQcm9wcyB9IGZyb20gJy4vaW1hZ2VzLnRzJ1xuaW1wb3J0IEltYWdlIGZyb20gJy4vaW1hZ2Uuc3RhdG9yJ1xuXG5jb25zdCBwID0gU3RhdG9yLnByb3BzPFBpY3R1cmVQcm9wcz4oKVxuY29uc3QgeyBzb3VyY2VzIH0gPSBnZXRQaWN0dXJlKHApXG4tLS1cbntzb3VyY2VzLmxlbmd0aCA9PT0gMCA/IChcbiAgPEltYWdlIHsuLi5wfSAvPlxuKSA6IChcbiAgPHBpY3R1cmU+XG4gICAge2VhY2goc291cmNlcywgKHMpID0+IChcbiAgICAgIDxzb3VyY2UgbWVkaWE9e3MubWVkaWF9IHR5cGU9e1NPVVJDRV9UWVBFU1tzLmZvcm1hdF19IHNyY3NldD17cy5zcmNzZXR9IHNpemVzPXtzLnNpemVzfSAvPlxuICAgICkpfVxuICAgIDxJbWFnZSB7Li4ucH0gLz5cbiAgPC9waWN0dXJlPlxuKX1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUNBO0FBQ0E7OztFQUVBLFVBQVU7RUFDVjtnQkFFQztFQUNDLE9BQUEsV0FBVyxNQUFLO0FBQ2xCO0VBQ0UsZ0JBQ0c7TUFDQyxzQkFBZSxrQkFBZSxtQ0FBZ0Msb0JBQWlCLFdBQVc7SUFDNUYsS0FDQSxXQUFXLGdCQUNIO0FBQ1o7OyJ9
