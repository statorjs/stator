// `<Image>`/`<Picture>` are real `.stator` components — imported from their
// COMPILED sibling, never the raw `.stator` source, so this package never
// depends on a `.stator` loader being registered at runtime. Keep fresh with
// `pnpm build:components` (wired into `prepublishOnly`).
export { default as Image } from './image.stator.ts'
export type {
  GetImageOptions,
  ImageFormat,
  ImageLoading,
  ImageProps,
  PictureProps,
  PictureSource,
  ResolvedImage,
  ResolvedPicture,
  ResolvedPictureSource,
} from './images.ts'
export { getImage, getPicture, SOURCE_TYPES } from './images.ts'
export type { JsonLdProps } from './json-ld.ts'
export { JsonLd, ldToString } from './json-ld.ts'
export { default as Picture } from './picture.stator.ts'
