import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

const prefix = '/__free-drawing-replay/'
const maxReportBytes = 128 * 1024
const localAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const unsafeKey = /landmark|coordinate|patient|^session_?id$|^points$|^pixels$|^[xyz]$/i

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

/** Aggregate diagnostics only: reject movement payloads even on this local dev endpoint. */
function aggregate(value: unknown, depth = 0): boolean {
  if (depth > 9) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= 4096
  if (Array.isArray(value)) return value.length <= 256 && value.every(item => aggregate(item, depth + 1))
  return typeof value === 'object' && Object.keys(value).length <= 128 && Object.entries(value).every(([key, item]) => !unsafeKey.test(key) && aggregate(item, depth + 1))
}

async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maxReportBytes) throw new Error('Report exceeds 128 KiB')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Only the explicit local replay command enables these endpoints; never emitted in a build. */
export function freeDrawingReplayPlugin(): Plugin {
  const configuredVideo = process.env.REHAB_DRAWING_REPLAY_VIDEO
  return {
    name: 'local-free-drawing-replay',
    apply: 'serve',
    configureServer(server) {
      if (!configuredVideo || !path.isAbsolute(configuredVideo)) return
      const sourcePath = path.resolve(configuredVideo)
      const reportsDirectory = path.resolve(server.config.root, '../reports')
      const enabledAt = Date.now()
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1')
        if (!url.pathname.startsWith(prefix)) { next(); return }
        if (!localAddresses.has(request.socket.remoteAddress || '')) { json(response, 403, { error: 'Local replay only' }); return }
        let host: string
        try { host = new URL(`http://${request.headers.host || ''}`).hostname }
        catch { json(response, 403, { error: 'Local hostname required' }); return }
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) { json(response, 403, { error: 'Local hostname required' }); return }
        const origin = request.headers.origin
        if (origin && origin !== `http://${request.headers.host}`) { json(response, 403, { error: 'Same-origin replay only' }); return }
        void (async () => {
          if (url.pathname === `${prefix}config` && request.method === 'GET') {
            await stat(sourcePath)
            json(response, 200, { sourcePath, videoUrl: `${prefix}video` })
          } else if (url.pathname === `${prefix}video` && ['GET', 'HEAD'].includes(request.method || '')) {
            const file = await stat(sourcePath)
            const range = request.headers.range
            const match = range?.match(/^bytes=(\d*)-(\d*)$/)
            let start = 0, end = file.size - 1
            if (range) {
              if (!match || (!match[1] && !match[2])) { response.writeHead(416, { 'Content-Range': `bytes */${file.size}` }); response.end(); return }
              start = match[1] ? Number(match[1]) : Math.max(0, file.size - Number(match[2]))
              end = match[1] && match[2] ? Math.min(file.size - 1, Number(match[2])) : file.size - 1
              if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.size) { response.writeHead(416, { 'Content-Range': `bytes */${file.size}` }); response.end(); return }
            }
            response.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${file.size}` } : {}) })
            if (request.method === 'HEAD') { response.end(); return }
            const stream = createReadStream(sourcePath, { start, end })
            stream.on('error', () => response.destroy())
            response.on('close', () => stream.destroy())
            stream.pipe(response)
          } else if (url.pathname === `${prefix}report` && request.method === 'POST') {
            const value = await body(request)
            if (!aggregate(value) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected aggregate report without movement coordinates')
            const report = value as Record<string, unknown>
            if (!Number.isInteger(report.run) || Number(report.run) < 1 || Number(report.run) > 20) throw new Error('run must be an integer from 1 to 20')
            await mkdir(reportsDirectory, { recursive: true })
            const name = `free-drawing-replay-${report.run}.json`
            await writeFile(path.join(reportsDirectory, name), `${JSON.stringify({ ...report, sourcePath }, null, 2)}\n`, 'utf8')
            json(response, 200, { ok: true, report: `reports/${name}` })
          } else if (url.pathname === `${prefix}status` && request.method === 'GET') {
            const run = Number(url.searchParams.get('run'))
            if (!Number.isInteger(run) || run < 1 || run > 20) throw new Error('Invalid run')
            try {
              const reportPath = path.join(reportsDirectory, `free-drawing-replay-${run}.json`)
              if ((await stat(reportPath)).mtimeMs < enabledAt) { json(response, 200, { done: false }); return }
              const report = JSON.parse(await readFile(reportPath, 'utf8'))
              json(response, 200, { done: true, report })
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              json(response, 200, { done: false })
            }
          } else json(response, 404, { error: 'Unknown replay endpoint' })
        })().catch(error => {
          if (!response.headersSent) json(response, 400, { error: error instanceof Error ? error.message : 'Replay request failed' })
          else response.destroy()
        })
      })
    },
  }
}
