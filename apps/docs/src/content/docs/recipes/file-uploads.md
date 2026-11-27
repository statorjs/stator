---
title: File uploads
description: "Uploads are standard web FormData and File. The only framework rule is that the bytes go to storage and only a key goes in a machine."
sidebar:
  order: 10
---

There is no Stator upload API, and that's the recipe. A file upload is a multipart `POST`, and an API route hands you the **web-standard `FormData` and `File`** — the same objects you'd use anywhere. The one framework-shaped decision is where the bytes go, and the answer is never "a machine."

## Read the file: `request.formData()`

`form.get(field)` returns a web `File` for a file input, with `.name`, `.type`, `.size`, and `.arrayBuffer()` / `.stream()`. Validate it *before* you touch storage — reject early rather than writing then deleting. `.name` and `.type` come from the client, so neither goes into the storage key: the key is a fresh UUID plus an extension you chose from the types you accept.

```ts
// routes/profile/avatar.ts
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

// The types this route accepts, and the extension each is stored under.
// SVG is left out: it can carry script.
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export const POST = defineApiRoute({
  // The 2 MB file check below plus room for the multipart form around it.
  // A bigger body is refused with a 413 before it is buffered.
  maxBodyBytes: 2_100_000,
  reads: [ProfileMachine],
  handler: async (request, { dispatch }) => {
    const form = await request.formData()
    const file = form.get('avatar')

    if (!(file instanceof File)) return new Response('no file', { status: 400 })
    if (file.size > 2_000_000) return new Response('too large', { status: 413 })
    const ext = EXTENSIONS[file.type]
    if (!ext) return new Response('not a PNG, JPEG or WebP image', { status: 415 })

    // Bytes go to storage; only a key comes back.
    const key = `avatars/${randomUUID()}.${ext}`
    await writeFile(`./uploads/${key}`, Buffer.from(await file.arrayBuffer()))

    await dispatch(ProfileMachine, { type: 'AVATAR_SET', key })
    return { directives: [{ type: 'reload' }] }
  },
})
```

## Bytes go to storage, keys go to machines

The machine stores the **key** — a short string — and the page renders the URL. The file itself lives on disk or in object storage.

```ts
// machines/profile.ts
AVATAR_SET: { do: (ctx, ev) => { ctx.avatarKey = ev.key } },
```

```jsx
{when(read(profile, (p) => p.avatarKey), () => (
  <img src={read(profile, (p) => `/uploads/${p.avatarKey}`)} alt="avatar" />
))}
```

:::caution[Never put bytes in context]
Machine context is [`structuredClone`d per transition and serialized to the store per touch](/recipes/where-data-lives/). A file in context is the *whole file* re-cloned and re-serialized on every unrelated event — a megabyte-sized tax on a checkbox toggle. Keep the key in context, the bytes in storage. Always.
:::

## Serve uploads through the image endpoint

Don't serve the upload directory as plain static files from your app's origin. A file served from your origin with a type taken from its extension runs as your page: an HTML or SVG upload under a misleading name is stored XSS. Point Stator's [image endpoint](/reference/config/) at the directory instead:

```ts title="stator.config.ts"
export default defineConfig({
  images: { dir: 'uploads' }, // served at /uploads/…
})
```

It serves only image types, sends SVG with a `Content-Security-Policy` that blocks script, and resizes on request. For files that aren't images, serve them from a separate origin (an object-storage bucket's own domain), never your app's.

## Large files: stream instead of buffer

`await file.arrayBuffer()` pulls the entire file into memory before writing — fine for avatars, a memory hazard for big uploads. For those, pipe the file's stream straight to disk so you never hold it whole:

```ts
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

await pipeline(Readable.fromWeb(file.stream()), createWriteStream(`./uploads/${key}`))
```

The route's `maxBodyBytes` applies to a streamed body too: past the limit the stream errors mid-write with a `BodyTooLargeError`, and the client gets a 413. The partial file is yours to delete, as it is when a client disconnects mid-upload.

## In production you'd add

- **Keep the proxy's limit at or above the app's.** `maxBodyBytes` is what bounds the memory an upload can take; the `file.size` check only runs once the body is in. A proxy or platform in front applies its own limit first and answers with its own error page, so set it at or above the largest `maxBodyBytes` you use, or uploads near the limit get the proxy's error instead of the app's 413.
- **Content sniffing, not trust.** `file.type` is set by the client and can lie, so the allowlist above only stops honest mistakes. If the type matters for safety, check the file's magic bytes as well.
- **Object storage + signed URLs** at any real scale — write to S3-compatible storage and serve via signed URLs instead of your app process.
- **Orphan cleanup.** An upload whose follow-up dispatch never lands (the user closed the tab) leaves bytes with no key pointing at them. Sweep unreferenced uploads on a schedule, or upload-then-commit in one flow.
