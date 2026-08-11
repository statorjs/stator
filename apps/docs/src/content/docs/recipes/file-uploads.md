---
title: File uploads
description: "Uploads are standard web FormData and File. The only framework rule is that the bytes go to storage and only a key goes in a machine."
sidebar:
  order: 8
---

There is no Stator upload API, and that's the recipe. A file upload is a
multipart `POST`, and an API route hands you the **web-standard `FormData` and
`File`** — the same objects you'd use anywhere. The one framework-shaped
decision is where the bytes go, and the answer is never "a machine."

## Read the file: `request.formData()`

`form.get(field)` returns a web `File` for a file input, with `.name`, `.type`,
`.size`, and `.arrayBuffer()` / `.stream()`. Validate it *before* you touch
storage — reject early rather than writing then deleting.

```ts
// routes/profile/avatar.ts
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export const POST = defineApiRoute({
  reads: [ProfileMachine],
  handler: async (request, { dispatch }) => {
    const form = await request.formData()
    const file = form.get('avatar')

    if (!(file instanceof File)) return new Response('no file', { status: 400 })
    if (file.size > 2_000_000) return new Response('too large', { status: 413 })
    if (!file.type.startsWith('image/')) return new Response('not an image', { status: 415 })

    // Bytes go to storage; only a key comes back.
    const key = `avatars/${randomUUID()}-${file.name}`
    await writeFile(`./uploads/${key}`, Buffer.from(await file.arrayBuffer()))

    await dispatch(ProfileMachine, { type: 'AVATAR_SET', key })
    return { directives: [{ type: 'reload' }] }
  },
})
```

## Bytes go to storage, keys go to machines

The machine stores the **key** — a short string — and the page renders the URL.
The file itself lives on disk or in object storage.

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
Machine context is [`structuredClone`d per transition and serialized to the
store per touch](/recipes/where-data-lives/). A file in context is the *whole
file* re-cloned and re-serialized on every unrelated event — a megabyte-sized
tax on a checkbox toggle. Keep the key in context, the bytes in storage. Always.
:::

## Large files: stream instead of buffer

`await file.arrayBuffer()` pulls the entire file into memory before writing —
fine for avatars, a memory hazard for big uploads. For those, pipe the file's
stream straight to disk so you never hold it whole:

```ts
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

await pipeline(Readable.fromWeb(file.stream()), createWriteStream(`./uploads/${key}`))
```

## In production you'd add

- **A size limit at the edge.** The `file.size` check runs *after* the body is
  received — real DoS protection caps the request body at your proxy or platform,
  before it reaches the handler.
- **Content sniffing, not trust.** `file.type` is set by the client and can lie.
  If the file type matters for safety, inspect the magic bytes rather than
  believing the header.
- **Object storage + signed URLs** at any real scale — write to S3-compatible
  storage and serve via signed URLs instead of your app process.
- **Orphan cleanup.** An upload whose follow-up dispatch never lands (the user
  closed the tab) leaves bytes with no key pointing at them. Sweep unreferenced
  uploads on a schedule, or upload-then-commit in one flow.
