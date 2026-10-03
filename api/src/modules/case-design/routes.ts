import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readJson } from '../../http/response'
import { parseSourceDocuments } from '../../source-documents'
import { createEvidenceDocuments } from './documents'
import { createCaseDesign, getCaseDesign, listCaseDesigns } from './repository'

export async function handleCaseDesignRoutes(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (request.url === '/api/case-designs' && request.method === 'GET') return json(response, 200, { designs: listCaseDesigns() })
  if (request.url === '/api/case-designs' && request.method === 'POST') {
    const body = await readJson(request)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > 200 || !Array.isArray(body.files)) return json(response, 400, { error: '请提供 1–200 字任务名称和需求材料' })
    let documents
    try { documents = createEvidenceDocuments(await parseSourceDocuments(body.files)) }
    catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : '材料解析失败' }) }
    return json(response, 201, { design: createCaseDesign(name, documents) })
  }
  const match = request.url?.match(/^\/api\/case-designs\/([^/?]+)$/)
  if (request.method === 'GET' && match) {
    const design = getCaseDesign(decodeURIComponent(match[1]))
    return design ? json(response, 200, { design }) : json(response, 404, { error: '用例设计任务不存在' })
  }
  return false
}
