import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readJson } from '../../http/response'
import { listTestFixtures, saveTestFixture } from './store'

export async function handleTestFixtureRoutes(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (request.url !== '/api/test-fixtures') return false
  if (request.method === 'GET') return json(response, 200, await listTestFixtures())
  if (request.method === 'POST') {
    try { return json(response, 201, { fixture: await saveTestFixture(await readJson(request)) }) }
    catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : '登记测试附件失败' }) }
  }
  return json(response, 405, { error: '测试附件仅支持登记和查看；已有附件不可覆盖' })
}
