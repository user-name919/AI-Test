import type { ServerResponse } from 'node:http'
import { encodeNdjsonEvent } from '../shared/live-execution'

export function openNdjsonResponse(response: ServerResponse) {
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'x-accel-buffering': 'no',
  })
  response.flushHeaders?.()
  return {
    send(value: unknown) {
      if (!response.destroyed && !response.writableEnded) response.write(encodeNdjsonEvent(value))
    },
    close() {
      if (!response.destroyed && !response.writableEnded) response.end()
    },
  }
}
