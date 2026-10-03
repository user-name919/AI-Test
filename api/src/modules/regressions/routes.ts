import type { IncomingMessage, ServerResponse } from 'node:http'
import { changeSetPreviewSchema, freezeChangeSetSchema, createRegressionSchema } from '@quality-ai/contracts/regressions'
import { json, readJson } from '../../http/response'
import { freezeChangeSet, getChangeSet, listChangeSets, previewChangeSet } from './change-sets'
import { createRegression, getRegression, listRegressions, cancelRegression } from './jobs'

export async function handleRegressionRoutes(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  if (request.method === 'GET' && pathname === '/api/regressions') return json(response, 200, { regressions: listRegressions() })
  if (request.method === 'POST' && pathname === '/api/regressions') {
    const parsed = createRegressionSchema.safeParse(await readJson(request))
    if (!parsed.success) return json(response, 400, { error: '需要冻结范围 ID、指纹与唯一请求 ID' })
    try { return json(response, 202, { regression: createRegression(parsed.data) }) }
    catch (error) { return json(response, 409, { error: error instanceof Error ? error.message : '无法创建分析' }) }
  }
  const regressionMatch = pathname.match(/^\/api\/regressions\/([a-f0-9-]{36})(\/cancel)?$/i)
  if (regressionMatch) {
    const regression = getRegression(regressionMatch[1]!)
    if (!regression) return json(response, 404, { error: '回归分析不存在' })
    if (request.method === 'GET' && !regressionMatch[2]) return json(response, 200, { regression })
    if (request.method === 'POST' && regressionMatch[2]) {
      try { return json(response, 200, { regression: cancelRegression(regression.id) }) }
      catch (error) { return json(response, 409, { error: error instanceof Error ? error.message : '取消失败' }) }
    }
  }
  if (request.method === 'GET' && pathname === '/api/change-sets') return json(response, 200, { changeSets: listChangeSets() })
  if (request.method === 'POST' && pathname === '/api/change-sets/preview') {
    const parsed = changeSetPreviewSchema.safeParse(await readJson(request))
    if (!parsed.success) return json(response, 400, { error: '请选择已配置项目、本地目标分支与明确比较范围', details: parsed.error.issues })
    try { return json(response, 201, { changeSet: await previewChangeSet(parsed.data) }) }
    catch (error) { return json(response, 422, { error: error instanceof Error ? error.message : '范围读取失败' }) }
  }
  const match = pathname.match(/^\/api\/change-sets\/([a-f0-9-]{36})(\/freeze)?$/i)
  if (!match) return false
  if (request.method === 'GET' && !match[2]) {
    const changeSet = getChangeSet(match[1]!)
    return changeSet ? json(response, 200, { changeSet }) : json(response, 404, { error: '变更范围不存在' })
  }
  if (request.method === 'POST' && match[2]) {
    const parsed = freezeChangeSetSchema.safeParse(await readJson(request))
    if (!parsed.success) return json(response, 400, { error: '必须提供当前服务端预览指纹，不能提交自定义范围事实' })
    if (!getChangeSet(match[1]!)) return json(response, 404, { error: '变更范围不存在' })
    try { return json(response, 200, { changeSet: freezeChangeSet(match[1]!, parsed.data.expectedHash) }) }
    catch (error) { return json(response, 409, { error: error instanceof Error ? error.message : '范围确认失败' }) }
  }
  return false
}
