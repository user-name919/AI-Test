import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readJson } from '../../http/response'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { storageStateSchema } from '@quality-ai/contracts'
import { getEnvironmentById, getLatestEnvironment, saveEnvironment, setEnvironmentStorageState } from '../../database'
import { getRuntimePaths } from '../../config/paths'


export async function handleEnvironmentRoutes(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (request.method === 'GET' && request.url === '/api/environments/latest') return json(response, 200, { environment: getLatestEnvironment() })

  if (request.method === 'POST' && request.url === '/api/environments') {
    const body = await readJson(request)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const targetUrl = typeof body.targetUrl === 'string'
      ? body.targetUrl.trim()
      : typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
    const id = typeof body.id === 'string' ? body.id : undefined
    if (!name || !targetUrl) return json(response, 400, { error: '环境名称和测试页面地址不能为空' })
    const url = new URL(targetUrl)
    if (!['http:', 'https:'].includes(url.protocol)) return json(response, 400, { error: '环境地址只允许 HTTP 或 HTTPS' })
    return json(response, 200, { environment: saveEnvironment({ id, name, baseUrl: url.origin, targetUrl: url.href }) })
  }

  const stateMatch = request.url?.match(/^\/api\/environments\/([a-f0-9-]+)\/storage-state$/i)
  if (request.method === 'POST' && stateMatch) {
    const environment = getEnvironmentById(stateMatch[1])
    if (!environment) return json(response, 404, { error: '测试环境不存在' })
    const storageState = storageStateSchema.parse(await readJson(request))
    const directory = getRuntimePaths().authRoot
    await mkdir(directory, { recursive: true })
    const statePath = resolve(directory, `${environment.id}.json`)
    await writeFile(statePath, JSON.stringify(storageState), { mode: 0o600 })
    return json(response, 200, { environment: setEnvironmentStorageState(environment.id, statePath) })
  }

  return false
}
