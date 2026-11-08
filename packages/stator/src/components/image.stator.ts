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
  return html`<img src="${img.src}" srcset="${img.srcset ?? undefined}" sizes="${img.srcset ? sizes : undefined}" alt="${alt}" width="${img.width}" height="${img.height}" loading="${loading}" fetchpriority="${fetchpriority}" decoding="${decoding}" class="${className}" data-s-afd5216f>`
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImltYWdlLnN0YXRvciJdLCJzb3VyY2VzQ29udGVudCI6WyItLS1cbmltcG9ydCB7IGdldEltYWdlLCB0eXBlIEltYWdlUHJvcHMgfSBmcm9tICcuL2ltYWdlcy50cydcblxuY29uc3QgcCA9IFN0YXRvci5wcm9wczxJbWFnZVByb3BzPigpXG5jb25zdCB7XG4gIGFsdCxcbiAgY2xhc3M6IGNsYXNzTmFtZSxcbiAgc2l6ZXMgPSAnMTAwdncnLFxuICBwcmlvcml0eSxcbiAgbG9hZGluZyA9IHByaW9yaXR5ID8gJ2VhZ2VyJyA6ICdsYXp5JyxcbiAgZmV0Y2hwcmlvcml0eSA9IHByaW9yaXR5ID8gJ2hpZ2gnIDogdW5kZWZpbmVkLFxuICBkZWNvZGluZyA9ICdhc3luYycsXG59ID0gcFxuY29uc3QgaW1nID0gZ2V0SW1hZ2UocClcbi0tLVxuPGltZ1xuICBzcmM9e2ltZy5zcmN9XG4gIHNyY3NldD17aW1nLnNyY3NldCA/PyB1bmRlZmluZWR9XG4gIHNpemVzPXtpbWcuc3Jjc2V0ID8gc2l6ZXMgOiB1bmRlZmluZWR9XG4gIGFsdD17YWx0fVxuICB3aWR0aD17aW1nLndpZHRofVxuICBoZWlnaHQ9e2ltZy5oZWlnaHR9XG4gIGxvYWRpbmc9e2xvYWRpbmd9XG4gIGZldGNocHJpb3JpdHk9e2ZldGNocHJpb3JpdHl9XG4gIGRlY29kaW5nPXtkZWNvZGluZ31cbiAgY2xhc3M9e2NsYXNzTmFtZX1cbi8+XG5cbjxzdHlsZT5cbiAgLyogaGVpZ2h0OmF1dG8gcHJlc2VydmVzIHRoZSBhc3BlY3QgcmF0aW8gdGhlIHdpZHRoL2hlaWdodCBhdHRyaWJ1dGVzXG4gICAgIGRlY2xhcmU7IHJhZGl1cywgbWFyZ2luLCBvYmplY3QtZml0IGFyZSB0aGUgYXBwJ3MgY2FsbC4gKi9cbiAgOndoZXJlKGltZykge1xuICAgIGRpc3BsYXk6IGJsb2NrO1xuICAgIG1heC13aWR0aDogMTAwJTtcbiAgICBoZWlnaHQ6IGF1dG87XG4gIH1cbjwvc3R5bGU+XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUNBOzs7RUFFQSxVQUFVO0VBQ1Y7RUFDRTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtBQUNGO0VBQ0E7MEJBR08sb0JBQ0csbUNBQ0Qsd0NBQ0YsZUFDRSxzQkFDQyx3QkFDQywyQkFDTSw0QkFDTCxvQkFDSDs7In0=
