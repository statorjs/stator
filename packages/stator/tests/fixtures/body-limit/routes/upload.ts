import { defineApiRoute } from '../../../../src/server/routing.ts'
import { calls } from '../calls.ts'

// No route limit: governed by requests.maxBodyBytes. `?read=` picks how the
// handler reads (or does not read) the body and what it does on failure.
export const POST = defineApiRoute({
  handler: async (request, { cookies }) => {
    calls.upload++
    cookies.set('handler', 'ran', { path: '/' })
    const read = request.query.read ?? 'text'
    if (read === 'none') return Response.json({ ignored: true }, { headers: { 'x-handler': '1' } })
    if (read === 'catch') {
      try {
        await request.text()
      } catch {
        return new Response('bad request', { status: 400, headers: { 'x-handler': '1' } })
      }
      return new Response('read')
    }
    if (read === 'stream') {
      // Reads through `request.raw` and returns its own Response even if the
      // read failed part way.
      let n = 0
      try {
        const reader = request.raw.body!.getReader()
        for (let r = await reader.read(); !r.done; r = await reader.read()) n += r.value.byteLength
      } catch {}
      return new Response(`streamed ${n}`, { headers: { 'x-handler': '1' } })
    }
    let size: number
    if (read === 'form') {
      const form = await request.formData()
      size = (form.get('file') as File).size
    } else if (read === 'json') {
      size = JSON.stringify(await request.json()).length
    } else if (read === 'buffer') {
      size = (await request.arrayBuffer()).byteLength
    } else {
      size = (await request.text()).length
    }
    return Response.json({ size }, { headers: { 'x-handler': '1' } })
  },
})
