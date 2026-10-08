import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readJson } from '../../http/response'
import { getProjectProvider, getProjectProviderRegistry } from '../../integrations/project-knowledge/registry'
import type { SourceScope } from '../../integrations/project-knowledge/types'
import { listLocalGitRefs } from '../../integrations/git/local-git'

const sourceScopes = new Set<SourceScope>(['route', 'page', 'component', 'api'])

export async function handleProjectRoutes(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const refsMatch = new URL(request.url ?? '/', 'http://localhost').pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/git\/refs$/)
  if (request.method === 'GET' && refsMatch) {
    const provider = (await getProjectProviderRegistry()).get(refsMatch[1]!)
    if (!provider) return json(response, 404, { error: '源码项目不存在' })
    const project = await provider.getProjectInfo()
    if (!project.connected || !project.resolvedRoot) return json(response, 422, { error: '源码项目未连接' })
    try { return json(response, 200, await listLocalGitRefs(project.resolvedRoot)) }
    catch (error) { return json(response, 422, { error: error instanceof Error ? error.message : '本地分支读取失败' }) }
  }
  if (request.method === 'GET' && request.url === '/api/projects') {
    const providers = [...(await getProjectProviderRegistry()).values()]
    return json(response, 200, { projects: await Promise.all(providers.map(provider => provider.getProjectInfo())) })
  }

  const validateProjectMatch = request.url?.match(/^\/api\/projects\/([a-z0-9-]+)\/validate$/)
  if (request.method === 'POST' && validateProjectMatch) {
    const project = await (await getProjectProvider(validateProjectMatch[1])).getProjectInfo()
    return json(response, project.connected ? 200 : 422, { project })
  }

  const resolveRouteMatch = request.url?.match(/^\/api\/projects\/([a-z0-9-]+)\/resolve-route$/)
  if (request.method === 'POST' && resolveRouteMatch) {
    const body = await readJson(request)
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    if (!url) return json(response, 400, { error: '页面 URL 不能为空' })
    const route = await (await getProjectProvider(resolveRouteMatch[1])).resolveRoute({ url })
    return json(response, 200, { route })
  }

  const searchSourceMatch = request.url?.match(/^\/api\/projects\/([a-z0-9-]+)\/search-source$/)
  if (request.method === 'POST' && searchSourceMatch) {
    const body = await readJson(request)
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    const invalidScope = Array.isArray(body.scopes)
      && body.scopes.some(scope => typeof scope !== 'string' || !sourceScopes.has(scope as SourceScope))
    if (invalidScope) return json(response, 400, { error: '源码搜索范围不合法' })
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((scope): scope is SourceScope => typeof scope === 'string' && sourceScopes.has(scope as SourceScope))
      : undefined
    const limit = typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0 ? body.limit : undefined
    if (!query) return json(response, 400, { error: '源码搜索词不能为空' })
    const matches = await (await getProjectProvider(searchSourceMatch[1])).searchSource({ query, scopes, limit })
    return json(response, 200, { matches })
  }

  const inspectSourceMatch = request.url?.match(/^\/api\/projects\/([a-z0-9-]+)\/inspect-source$/)
  if (request.method === 'POST' && inspectSourceMatch) {
    const body = await readJson(request)
    const paths = Array.isArray(body.paths) && body.paths.every(path => typeof path === 'string') ? body.paths : []
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!paths.length || !reason) return json(response, 400, { error: '源码文件和读取原因不能为空' })
    const context = await (await getProjectProvider(inspectSourceMatch[1])).inspectFiles({ paths, reason })
    return json(response, 200, { context })
  }

  return false
}
