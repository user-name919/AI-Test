import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createApiServer } from './app'

export { createApiServer } from './app'

const port = Number(process.env.API_PORT ?? 8787)

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createApiServer().listen(port, '127.0.0.1', () => {
    console.log(`[api] http://127.0.0.1:${port}`)
  })
}
