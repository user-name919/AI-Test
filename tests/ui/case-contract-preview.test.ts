import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import type { SavedAnalysis } from '@quality-ai/contracts'
import type { CaseAsset } from '@quality-ai/contracts/cases'
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
  const resolved = resolveCaseExecutionContract(analysis, '0-TC-0')
  let asset: CaseAsset = { id: 'fixture-case', title: resolved.title, source: { type: 'requirement', analysisId: analysis.id, caseKey: '0-TC-0' }, revision: 1, reviewStatus: 'confirmed', originalSuggestion: { ...resolved.contract, objective: '原始建议', steps: ['旧示例步骤，不应再展示为执行口径'] }, finalContract: resolved.contract, resolved, createdAt: analysis.createdAt, updatedAt: analysis.createdAt }
  let conflictOnce = true
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
      if (path === '/api/cases/fixture-case/review') {
        const request = route.request().postDataJSON()
        if (conflictOnce) {
          conflictOnce = false
          asset = { ...asset, revision: 2 }
          await route.fulfill({ status: 409, json: { error: '版本冲突', asset } })
          return
        }
        assert.equal(request.expectedRevision, 2)
        analysis.review.caseReviews!['0-TC-0'] = { ...request.review, updatedAt: analysis.createdAt }
        asset = { ...asset, revision: 3, finalContract: request.review.finalContract, resolved: resolveCaseExecutionContract(analysis, '0-TC-0') }
        await route.fulfill({ json: { asset } })
        return
      }
      const payload: Record<string, unknown> = {
        '/api/health': { configured: true }, '/api/analyses/latest': { analysis }, '/api/analyses': { analyses: [] },
        '/api/executions/latest': { execution: null }, '/api/executions': { executions: [] },
        '/api/environments/latest': { environment: { id: 'env', name: '合成环境', targetUrl: 'https://example.test/exams' } },
        '/api/projects': { projects: [{ id: 'project', name: '合成项目', connected: true, targetOrigins: ['https://example.test'] }] },
        '/api/cases': { cases: [asset] },
        [`/api/analyses/${analysis.id}/case-contracts`]: { caseContracts: [resolveCaseExecutionContract(analysis, '0-TC-0')] },
      }
      await route.fulfill({ status: path in payload ? 200 : 404, json: payload[path] ?? { error: '未配置的夹具路由' } })
    })
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.locator('.sidebar nav button').filter({ hasText: '用例资产' }).click()
    await page.getByText('人工确认：验证真实考试的部分搜索', { exact: true }).waitFor()
    assert.match(await page.locator('.case-contract-details').innerText(), /历史关联待复核/)
    assert.match(await page.locator('.case-contract-details').innerText(), /运行时数据“搜索词”需要预检解析/)
    assert.equal(await page.getByText('旧示例步骤，不应再展示为执行口径', { exact: true }).isVisible(), false)
    await page.getByRole('button', { name: '编辑最终口径', exact: true }).click()
    await page.getByLabel('测试目标', { exact: true }).fill('人工编辑后的搜索目标')
    await page.getByRole('button', { name: '需求中心', exact: true }).click()
    await page.getByRole('button', { name: '用例资产', exact: true }).click()
    assert.equal(await page.getByLabel('测试目标', { exact: true }).inputValue(), '人工编辑后的搜索目标')
    await page.reload()
    await page.getByRole('button', { name: '用例资产', exact: true }).click()
    assert.equal(await page.getByLabel('测试目标', { exact: true }).inputValue(), '人工编辑后的搜索目标')
    await page.getByRole('button', { name: '保存并确认最终口径', exact: true }).click()
    await page.getByText('服务端版本已更新。草稿仍保留，请对照最新内容后再决定。', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('测试目标', { exact: true }).inputValue(), '人工编辑后的搜索目标')
    await page.getByRole('button', { name: '已对比，保留我的草稿并使用最新版本号' }).click()
    await page.getByRole('button', { name: '保存并确认最终口径', exact: true }).click()
    await page.getByText('人工最终口径已保存。执行就绪条件仍由服务端判断。', { exact: true }).waitFor()
    if (process.env.UI_SCREENSHOT_PATH) await page.screenshot({ path: process.env.UI_SCREENSHOT_PATH, fullPage: true })
    await page.getByRole('button', { name: '配置并执行', exact: true }).click()
    const agent = page.getByRole('button', { name: 'Agent 动态执行', exact: true })
    assert.equal(await agent.isEnabled(), true)
    assert.equal(await page.getByRole('button', { name: '生成固定计划', exact: true }).isDisabled(), true)
    assert.match(await page.locator('.target-config').innerText(), /生成固定计划/)
    assert.deepEqual(errors, [])
  } finally { await browser?.close(); await server.close() }
})
