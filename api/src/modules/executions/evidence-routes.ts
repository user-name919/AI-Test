import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { json } from '../../http/response'
import { getRuntimePaths } from '../../config/paths'
import { getExecutionById } from './repository'
import { executionArtifacts } from './artifacts'
import { executionMarkdown } from './report'

function sendArtifact(response: ServerResponse, artifact: ReturnType<typeof executionArtifacts>[number] | undefined, download: boolean) {
  if (!artifact?.available || !artifact.path) return json(response, 404, { error: '附件不存在、已清理或不在允许范围内' })
  const encoded = encodeURIComponent(artifact.name)
  response.writeHead(200, {
    'content-type': artifact.kind === 'trace' ? 'application/zip' : artifact.kind === 'download' ? 'application/octet-stream' : 'image/png',
    'content-disposition': `${artifact.kind !== 'screenshot' || download ? 'attachment' : 'inline'}; filename="${encoded}"; filename*=UTF-8''${encoded.replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  })
  const stream = createReadStream(artifact.path)
  response.once('close', () => stream.destroy())
  stream.on('error', () => response.destroy()).pipe(response)
  return true
}

// 证据读取只依赖已保存报告，不引入浏览器、模型或任务调度模块。
export function handleExecutionEvidenceRoutes(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method !== 'GET') return false
  const url = new URL(request.url ?? '/', 'http://localhost')
  const reportMatch = url.pathname.match(/^\/api\/executions\/([a-f0-9-]+)\/report\.md$/i)
  if (reportMatch) {
    const execution = getExecutionById(reportMatch[1])
    if (!execution) return json(response, 404, { error: '执行报告不存在' })
    response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="execution-${execution.id}.md"`, 'cache-control': 'no-store' })
    response.end(executionMarkdown(execution, executionArtifacts(execution)))
    return true
  }
  const evidenceMatch = url.pathname.match(/^\/api\/executions\/([a-f0-9-]+)\/artifacts(?:\/([a-f0-9]{64}))?$/i)
  if (evidenceMatch) {
    const execution = getExecutionById(evidenceMatch[1])
    if (!execution) return json(response, 404, { error: '执行记录不存在' })
    const artifacts = executionArtifacts(execution)
    if (!evidenceMatch[2]) return json(response, 200, { artifacts: artifacts.map(({ path, ...item }) => { void path; return item }) })
    return sendArtifact(response, artifacts.find(item => item.id === evidenceMatch[2]), url.searchParams.get('download') === '1')
  }
  const legacyMatch = url.pathname.match(/^\/api\/artifacts\/([a-f0-9-]+)\/([^/]+)$/i)
  if (legacyMatch) {
    let fileName: string
    try { fileName = decodeURIComponent(legacyMatch[2]) }
    catch { return json(response, 400, { error: '证据文件名编码不合法' }) }
    if (!/^(trace\.zip|failure\.png|[\w\u4e00-\u9fa5-]+\.png)$/.test(fileName)) return json(response, 400, { error: '证据文件名不合法' })
    const execution = getExecutionById(legacyMatch[1])
    if (!execution) return json(response, 404, { error: '执行记录不存在' })
    const expected = resolve(getRuntimePaths().artifactRoot, execution.id, fileName)
    // 旧URL保留，但同样必须是报告登记的合法产物，不能靠猜文件名读取目录。
    return sendArtifact(response, executionArtifacts(execution).find(item => item.path === expected), true)
  }
  return false
}
