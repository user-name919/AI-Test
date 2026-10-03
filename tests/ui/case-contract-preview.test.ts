import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import type { SavedAnalysis } from '@quality-ai/contracts'
import { resolveCaseExecutionContract } from '../../api/src/review-execution-context'

test('用例详情展示人工契约，动态与固定模式分别显示服务端就绪原因', async () => {
  const analysis: SavedAnalysis = {
    id: '11111111-1111-4111-8111-111111111111', fileName: '合成需求.md', fileNames: ['合成需求.md'], provider: 'fixture', model: 'fixture', createdAt: '2026-10-03T00:00:00Z',
    review: { confirmedQuestions: [], selectedCases: ['0-TC-0'], updatedAt: null, caseReviews: {
      '0-TC-0': { status: 'confirmed', updatedAt: null, finalContract: {
        objective: '人工确认：验证真实考试的部分搜索', preconditions: ['打开考试列表'],
        steps: ['从真实下拉选项提取部分关键词'], expectedAssertions: ['来源考试仍在结果中', '匹配部分高亮'],
        dataBindings: [{ id: 'search', label: '搜索词', mode: 'runtime_dom', targetHint: '选择考试', businessIntent: '部分搜索',
          strategy: 'visible_option_substring', constraints: { mustComeFromCurrentDom: true, mustBePartialOfSource: true } }],
        forbiddenBehaviors: ['不得编造考试名称'], uncertainties: [],
      } },
    } },
    result: { versionName: '合成演示', productName: '测试平台', overview: '契约预览验收', requirements: [{
      title: '考试搜索', summary: '从可见选项搜索', risk: '低风险', riskReason: '只读',
      businessRules: [{ description: '部分搜索', evidence: '合成 PRD' }], pageStates: [], questions: [],
      testCases: [{ title: '部分关键词搜索', type: '交互', priority: 'P1', preconditions: [], steps: ['旧示例步骤，不应再展示为执行口径'], expectedResult: '旧示例断言', blockedByQuestion: false }],
    }] },
  }
  const server = await createServer({ root: new URL('../../web', import.meta.url).pathname, configFile: false, plugins: [vue()], server: { host: '127.0.0.1', port: 0 } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer!.address()
    assert.ok(address && typeof address !== 'string')
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      const payload: Record<string, unknown> = {
        '/api/health': { configured: true }, '/api/analyses/latest': { analysis }, '/api/analyses': { analyses: [] },
        '/api/executions/latest': { execution: null }, '/api/executions': { executions: [] },
        '/api/environments/latest': { environment: { id: 'env', name: '合成环境', targetUrl: 'https://example.test/exams' } },
        '/api/projects': { projects: [{ id: 'project', name: '合成项目', connected: true, targetOrigins: ['https://example.test'] }] },
        [`/api/analyses/${analysis.id}/case-contracts`]: { caseContracts: [resolveCaseExecutionContract(analysis, '0-TC-0')] },
      }
      await route.fulfill({ status: path in payload ? 200 : 404, json: payload[path] ?? { error: '未配置的夹具路由' } })
    })
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.locator('.sidebar nav button').filter({ hasText: '用例资产' }).click()
    await page.locator('.case-contract-details summary').click()
    await page.getByText('人工确认：验证真实考试的部分搜索', { exact: true }).waitFor()
    assert.match(await page.locator('.case-contract-details').innerText(), /历史关联待复核/)
    assert.match(await page.locator('.case-contract-details').innerText(), /运行时数据“搜索词”需要预检解析/)
    assert.equal(await page.getByText('旧示例步骤，不应再展示为执行口径', { exact: true }).count(), 0)
    if (process.env.UI_SCREENSHOT_PATH) await page.screenshot({ path: process.env.UI_SCREENSHOT_PATH, fullPage: true })
    await page.getByRole('button', { name: '配置并执行', exact: true }).click()
    const agent = page.getByRole('button', { name: 'Agent 动态执行', exact: true })
    assert.equal(await agent.isEnabled(), true)
    assert.equal(await page.getByRole('button', { name: '生成固定计划', exact: true }).isDisabled(), true)
    assert.match(await page.locator('.target-config').innerText(), /生成固定计划/)
    assert.deepEqual(errors, [])
  } finally { await browser?.close(); await server.close() }
})
