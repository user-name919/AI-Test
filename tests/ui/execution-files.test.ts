import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import type { ExecutionRecord } from '@quality-ai/contracts'

test('失败报告保留上传快照与真实下载，附件读取可重试、刷新且支持中文文件名', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quality-ai-evidence-ui-'))
  const before = process.env.QUALITY_AI_DATA_ROOT
  const beforeDb = process.env.QUALITY_AI_DATABASE_PATH
  process.env.QUALITY_AI_DATA_ROOT = directory
  process.env.QUALITY_AI_DATABASE_PATH = join(directory, 'test.sqlite')
  const { handleExecutionRoutes } = await import('../../api/src/modules/executions/routes')
  const { saveExecution } = await import('../../api/src/modules/executions/repository')
  const { database } = await import('../../api/src/storage/database')
  const id = randomUUID()
  const root = join(directory, 'artifacts', id)
  await mkdir(root, { recursive: true })
  const path = join(root, 'captured.download')
  const body = '列名,结果\n示例,错误内容\n'
  await writeFile(path, body)
  const sha256 = createHash('sha256').update(body).digest('hex')
  const fixture = { id: randomUUID(), name: '输入样本.csv', mimeType: 'text/csv', size: 4, sha256: 'a'.repeat(64), createdAt: '2026-10-04' }
  const record: ExecutionRecord = {
    memoryHints:[{id:'11111111-1111-4111-8111-111111111111',revision:2,lesson:'导出后核对真实文件内容，不把下载完成视为业务通过',executionId:'22222222-2222-4222-8222-222222222222',projectId:'fixture',targetUrl:'https://example.test',sourceCommit:'a'.repeat(40)}],
    id, name: '合成导出失败报告', targetUrl: 'https://example.test', mode: 'agent', status: 'failed', startedAt: 'now', finishedAt: 'now', durationMs: 1, steps: [], screenshots: [], caseKeys: ['case'],
    caseResults: [{ caseKey: 'case', title: '核对导出内容', contractFingerprint: 'frozen', status: 'failed', startedFromUrl: 'https://example.test', continuation: 'reused_current_page', resolvedDataBindings: [], passedAssertions: [], trajectory: [], steps: [], screenshots: [join(root, 'missing.png')], error: '下载内容与原预期不符', usedFixtures: [fixture], downloads: [{ downloadId: 'report', name: '分析报告.csv', size: Buffer.byteLength(body), sha256, path }] }],
  }
  saveExecution(record, { caseKeys: record.caseKeys })
  const snapshots = [{ caseId: 'case', revision: 1, capturedAt: 'now', resolved: { caseKey: 'case', title: '核对导出内容', contractFingerprint: 'frozen', contract: { objective: '核对导出内容', preconditions: [], steps: ['上传后导出'], expectedAssertions: ['文件内容符合预期'], dataBindings: [], forbiddenBehaviors: [], uncertainties: [] } } }]
  let failArtifacts = true
  const requests: string[] = []
  const api = createHttpServer(async (request, response) => {
    requests.push(request.url ?? '')
    // 仅任务及事件为合成夹具；报告、附件及Markdown使用生产路由和临时数据库。
    if (request.url?.startsWith(`/api/execution-jobs/${id}`)) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(request.url.includes('/events') ? { events: [], nextCursor: 0 } : { job: { id, status: 'completed', mode: 'agent', snapshots, targetUrl: record.targetUrl, executionId: id } }))
      return
    }
    if (failArtifacts && request.url === `/api/executions/${id}/artifacts`) {
      response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: '附件暂不可用' })); return
    }
    if (!await handleExecutionRoutes(request, response)) { response.writeHead(404); response.end() }
  })
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  const address = api.address(); assert.ok(address && typeof address !== 'string')
  const server = await createServer({ root: new URL('../../web', import.meta.url).pathname, configFile: false, plugins: [vue()], server: { host: '127.0.0.1', port: 0, proxy: { '/api': `http://127.0.0.1:${address.port}` } } })
  const browser = await chromium.launch({ headless: true })
  try {
    await server.listen(); const web = server.httpServer!.address(); assert.ok(web && typeof web !== 'string')
    const page = await browser.newPage({ baseURL: `http://127.0.0.1:${web.port}`, viewport: { width: 1200, height: 900 } })
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${web.port}/#/execution-jobs/${id}`)
    await page.getByRole('alert').filter({ hasText: '附件暂不可用' }).waitFor()
    failArtifacts = false
    await page.getByRole('button', { name: '重试读取附件' }).click()
    await page.getByText('文件已清理、缺失或不可访问，历史报告仍保留引用。', { exact: true }).waitFor()
    await page.locator('summary').filter({ hasText: '核对导出内容 · 验证失败' }).click()
    await page.getByText('输入样本.csv', { exact: true }).waitFor()
    await page.getByText(`下载标识：report`, { exact: true }).waitFor()
    await page.getByText('下载内容与原预期不符', { exact: true }).waitFor()
    const downloadLink = page.getByRole('link', { name: '下载文件', exact: true })
    const href = await downloadLink.getAttribute('href'); assert.ok(href)
    const response = await page.request.get(href)
    assert.equal(response.headers()['content-type'], 'application/octet-stream')
    assert.equal(response.headers()['x-content-type-options'], 'nosniff')
    assert.match(response.headers()['content-disposition'], /^attachment;/)
    assert.equal(await response.text(), body)
    const pending = page.waitForEvent('download')
    await downloadLink.click()
    const download = await pending
    assert.equal(download.suggestedFilename(), '分析报告.csv')
    assert.equal(await readFile((await download.path())!, 'utf8'), body)
    const markdown = await page.request.get(`/api/executions/${id}/report.md`)
    const report = await markdown.text()
    assert.ok(report.includes('输入样本.csv') && report.includes(fixture.id) && report.includes(fixture.sha256))
    assert.ok(report.includes(sha256) && report.includes('不证明上传或业务处理成功'))
    assert.ok(!report.includes(directory))
    assert.equal((await page.request.get(`/api/executions/${id}/artifacts/${'0'.repeat(64)}`)).status(), 404)
    await page.reload()
    await page.getByRole('link', { name: '下载文件', exact: true }).waitFor()
    await page.locator('summary').filter({ hasText: '核对导出内容 · 验证失败' }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    await page.screenshot({ path: '/private/tmp/quality-ai-execution-files.png', fullPage: true })
    requests.length=0
    await page.goto(`http://127.0.0.1:${web.port}/#/executions/${id}`)
    await page.getByRole('heading',{name:'合成导出失败报告',exact:true}).waitFor()
    await page.getByText('本次模型参考经验（1 条）',{exact:true}).click()
    await page.getByText('导出后核对真实文件内容，不把下载完成视为业务通过 · 审核版本 2',{exact:true}).waitFor()
    assert.equal(await page.getByRole('link',{name:'查看当前记忆',exact:true}).getAttribute('href'),'#/memory?memoryId=11111111-1111-4111-8111-111111111111')
    assert.equal(await page.getByRole('link',{name:'查看来源报告',exact:true}).getAttribute('href'),'#/executions/22222222-2222-4222-8222-222222222222')
    await page.locator('summary').filter({hasText:'核对导出内容 · 验证失败'}).click()
    await page.getByText('输入样本.csv',{exact:true}).waitFor()
    await page.getByRole('link',{name:'下载文件',exact:true}).waitFor()
    assert.equal(await page.getByRole('button',{name:'创建独立重跑任务'}).isDisabled(),true)
    await page.getByText('历史报告没有用例版本快照，请从用例重新确认',{exact:true}).waitFor()
    await page.reload()
    await page.getByRole('heading',{name:'合成导出失败报告',exact:true}).waitFor()
    await page.getByRole('link',{name:'返回报告列表',exact:true}).click()
    await page.getByRole('link',{name:/合成导出失败报告/}).waitFor()
    await page.getByLabel('状态筛选').selectOption('passed')
    await page.getByText('当前筛选下没有执行记录。',{exact:true}).waitFor()
    await page.getByLabel('状态筛选').selectOption('failed')
    await page.getByRole('link',{name:/合成导出失败报告/}).click()
    await page.locator('summary').filter({hasText:'核对导出内容 · 验证失败'}).click()
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    assert.equal((await page.locator('main').boundingBox())?.x,0)
    await page.screenshot({path:'/private/tmp/quality-ai-execution-report-page.png',fullPage:true})
    await page.goto(`http://127.0.0.1:${web.port}/#/executions/${randomUUID()}`)
    await page.getByRole('alert').filter({hasText:'执行记录不存在'}).waitFor()
    assert.equal(await page.getByRole('heading',{name:'合成导出失败报告',exact:true}).count(),0)
    assert.ok(requests.every(url=>url.startsWith('/api/executions')),requests.join('\n'))
    assert.deepEqual(errors, [])
  } finally {
    await browser.close(); await server.close()
    await new Promise<void>(resolve => { api.closeAllConnections(); api.close(() => resolve()) })
    database.close()
    if (before === undefined) delete process.env.QUALITY_AI_DATA_ROOT; else process.env.QUALITY_AI_DATA_ROOT = before
    if (beforeDb === undefined) delete process.env.QUALITY_AI_DATABASE_PATH; else process.env.QUALITY_AI_DATABASE_PATH = beforeDb
    await rm(directory, { recursive: true, force: true })
  }
})
