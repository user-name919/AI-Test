import { createServer } from 'node:http'
import { json } from './http/response'
import { handleRequirementRoutes } from './modules/requirements/routes'
import { handleCaseRoutes } from './modules/cases/routes'
import { handleExecutionRoutes } from './modules/executions/routes'
import { handleProjectRoutes } from './modules/projects/routes'
import { handleEnvironmentRoutes } from './modules/projects/environments'

const handlers = [handleProjectRoutes, handleEnvironmentRoutes, handleCaseRoutes, handleRequirementRoutes, handleExecutionRoutes]

export function createApiServer() {
  return createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/api/health') {
        return json(response, 200, {
          ok: true,
          provider: 'company-responses',
          model: process.env.MODEL_NAME ?? 'gpt-5.6-terra',
          configured: Boolean(process.env.MODEL_API_KEY ?? process.env.DEEPSEEK_API_KEY),
        })
      }

      for (const handle of handlers) {
        if (await handle(request, response)) return
      }
      json(response, 404, { error: '接口不存在' })
    } catch (error) {
      const message = error instanceof Error ? error.message : '服务处理失败'
      console.error('[api]', message)
      json(response, 500, { error: message })
    }
  })
}
