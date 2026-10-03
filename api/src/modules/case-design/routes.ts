import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readJson } from '../../http/response'
import { parseSourceDocuments } from '../../source-documents'
import { createEvidenceDocuments } from './documents'
import { createCaseDesign, getCaseDesign, listCaseDesigns, listDesignRuns } from './repository'
import { cancelDesignRun, startDesignRun } from './jobs'

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
  const operation = request.url?.match(/^\/api\/case-designs\/([^/?]+)\/(runs|cancel)$/)
  if (request.method === 'POST' && operation) {
    const id = decodeURIComponent(operation[1])
    if (!getCaseDesign(id)) return json(response,404,{error:'用例设计任务不存在'})
    if (operation[2] === 'cancel') return json(response,200,{cancelled:cancelDesignRun(id)})
    const body = await readJson(request)
    if (body.stage !== 'extracting' || !Number.isInteger(body.expectedRevision)) return json(response,400,{error:'请提供 extracting 阶段及 expectedRevision；其他阶段尚未接入'})
    try { return json(response,202,{run:startDesignRun(id,Number(body.expectedRevision))}) }
    catch (error) { return json(response,409,{error:error instanceof Error ? error.message : '无法创建生成任务'}) }
  }
  const match = request.url?.match(/^\/api\/case-designs\/([^/?]+)$/)
  if (request.method === 'GET' && match) {
    const design = getCaseDesign(decodeURIComponent(match[1]))
    return design ? json(response, 200, { design, runs: listDesignRuns(design.id) }) : json(response, 404, { error: '用例设计任务不存在' })
  }
  return false
}
