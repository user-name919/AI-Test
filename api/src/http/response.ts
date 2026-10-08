import type { IncomingMessage, ServerResponse } from 'node:http'

const maxBodySize = 30 * 1024 * 1024

export function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
  return true
}

export async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > maxBodySize) throw new Error('单次请求不能超过 30MB')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}
