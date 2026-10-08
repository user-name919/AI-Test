import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import { handleTestFixtureRoutes } from '../../api/src/modules/test-fixtures/routes'

test('附件页真实API登记、离开保护、失败重试、刷新恢复和窄屏', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quality-ai-fixture-ui-'))
  const previous = process.env.QUALITY_AI_DATA_ROOT
  process.env.QUALITY_AI_DATA_ROOT = directory
  let fail = false
  const api = createHttpServer(async (request, response) => {
    if (fail && request.method === 'POST') { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: '登记暂不可用' })); return }
    if (!await handleTestFixtureRoutes(request, response)) { response.writeHead(404); response.end() }
  })
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  const address = api.address(); assert.ok(address && typeof address !== 'string')
  const server = await createServer({ root: new URL('../../web', import.meta.url).pathname, configFile: false, plugins: [vue()], server: { host: '127.0.0.1', port: 0, proxy: { '/api': `http://127.0.0.1:${address.port}` } } })
  const browser = await chromium.launch({ headless: true })
  try {
    await server.listen(); const web = server.httpServer!.address(); assert.ok(web && typeof web !== 'string')
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.goto(`http://127.0.0.1:${web.port}/#/test-fixtures`)
    await page.getByText('暂无可用测试附件，请先登记。', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '登记测试附件', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: '使用指引', exact: true }).click()
    await page.getByText('如何用于上传测试', { exact: true }).waitFor()
    await page.getByLabel('选择测试附件').setInputFiles({ name: 'sample.txt', mimeType: 'text/plain', buffer: Buffer.from('safe fixture') })
    page.once('dialog', dialog => dialog.dismiss())
    await page.getByRole('link', { name: '测试环境', exact: true }).click()
    assert.match(page.url(), /test-fixtures/)
    fail = true
    await page.getByRole('button', { name: '登记测试附件', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '登记暂不可用' }).waitFor()
    assert.equal(await page.getByRole('button', { name: '登记测试附件', exact: true }).isEnabled(), true)
    fail = false
    await page.getByRole('button', { name: '登记测试附件', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '已登记 sample.txt' }).waitFor()
    await page.getByRole('heading', { name: 'sample.txt', exact: true }).waitFor()
    const id = await page.getByLabel('附件 ID', { exact: true }).inputValue()
    assert.match(id, /^[a-f0-9-]{36}$/)
    await page.reload()
    await page.getByRole('heading', { name: 'sample.txt', exact: true }).waitFor()
    assert.equal(await page.getByLabel('附件 ID', { exact: true }).inputValue(), id)
    await page.getByText('查看内容指纹', { exact: true }).click()
    assert.match(await page.locator('details p').innerText(), /^[a-f0-9]{64}$/)
    await page.getByLabel('选择测试附件').setInputFiles({ name: 'large.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) })
    await page.getByRole('alert').filter({ hasText: '超过 10MB' }).waitFor()
    assert.equal(await page.getByRole('button', { name: '登记测试附件', exact: true }).isDisabled(), true)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    assert.equal((await page.locator('main').boundingBox())?.x, 0)
    await page.screenshot({ path: '/private/tmp/quality-ai-test-fixtures-page.png', fullPage: true })
  } finally {
    await browser.close(); await server.close()
    await new Promise<void>(resolve => { api.closeAllConnections(); api.close(() => resolve()) })
    if (previous === undefined) delete process.env.QUALITY_AI_DATA_ROOT; else process.env.QUALITY_AI_DATA_ROOT = previous
    await rm(directory, { recursive: true, force: true })
  }
})
