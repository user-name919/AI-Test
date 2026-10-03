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
  let jobInput:Record<string,unknown>|undefined
  const job={id:'synthetic-job',status:'queued',mode:'agent',targetUrl:'https://example.test/exams',snapshots:[],createdAt:analysis.createdAt,updatedAt:analysis.createdAt}
  const historicalExecution = { id: '44444444-4444-4444-8444-444444444444', name: '历史执行', targetUrl: 'https://example.test', status: 'passed', mode: 'plan', startedAt: analysis.createdAt, finishedAt: analysis.createdAt, durationMs: 1, steps: [], screenshots: [], caseKeys: ['0-TC-0'], caseSnapshots: [{ caseId: asset.id, revision: 1, analysisId: analysis.id, capturedAt: analysis.createdAt, resolved }] }
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
      if(path==='/api/executions/missing'){await route.fulfill({status:404,json:{error:'执行记录不存在'}});return}
      if(path==='/api/execution-jobs'&&route.request().method()==='POST'){
        jobInput=route.request().postDataJSON()
        await route.fulfill({status:202,json:{job}})
        return
      }
      if(path==='/api/automation/generate'){
        const steps=[{action:'expectText',assertionIndex:0,text:'合成期望'}]
        await route.fulfill({status:201,json:{automationPlan:{id:'confirmed-plan',analysisId:analysis.id,caseKeys:['0-TC-0'],createdAt:analysis.createdAt,plan:{name:'待确认固定计划',targetUrl:'https://example.test/exams',steps,casePlans:[{caseKey:'0-TC-0',title:asset.title,contractFingerprint:asset.resolved.contractFingerprint,contract:asset.resolved.contract,steps}]}}}})
        return
      }
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
        [`/api/analyses/${analysis.id}`]: { analysis },
        '/api/executions/latest': { execution: null }, '/api/executions': { executions: [historicalExecution] },
        [`/api/executions/${historicalExecution.id}`]: {execution:historicalExecution},
        [`/api/executions/${historicalExecution.id}/artifacts`]: {artifacts:[]},
        '/api/environments/latest': { environment: { id: 'env', name: '合成环境', targetUrl: 'https://example.test/exams' } },
        '/api/projects': { projects: [{ id: 'project', name: '合成项目', connected: true, targetOrigins: ['https://example.test'] }] },
        '/api/cases': { cases: [asset] },
        '/api/environments': {environment:{id:'env',name:'合成环境',targetUrl:'https://example.test/exams'}},
        '/api/execution-jobs/synthetic-job': {job},
        '/api/execution-jobs/synthetic-job/events': {events:[],nextCursor:0,frame:null},
        [`/api/analyses/${analysis.id}/case-contracts`]: { caseContracts: [resolveCaseExecutionContract(analysis, '0-TC-0')] },
      }
      await route.fulfill({ status: path in payload ? 200 : 404, json: payload[path] ?? { error: '未配置的夹具路由' } })
    })
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.locator('.sidebar nav button').filter({ hasText: '用例资产' }).click()
    await page.getByText('人工确认：验证真实考试的部分搜索', { exact: true }).waitFor()
    assert.match(await page.locator('.case-contract-details').innerText(), /历史关联待复核/)
    assert.doesNotMatch(await page.locator('.case-contract-details').innerText(), /运行时数据“搜索词”需要预检解析/)
    assert.equal(await page.getByText('旧示例步骤，不应再展示为执行口径', { exact: true }).isVisible(), false)
    await page.getByRole('button', { name: '编辑最终口径', exact: true }).click()
    await page.getByLabel('搜索策略', { exact: true }).selectOption('visible_option_full')
    assert.equal(await page.getByLabel('搜索策略', { exact: true }).inputValue(), 'visible_option_full')
    await page.getByLabel('搜索策略', { exact: true }).selectOption('non_matching_option_query')
    assert.equal(await page.getByLabel('候选范围', { exact: true }).inputValue(), 'unknown')
    await page.getByLabel('候选范围', { exact: true }).selectOption('complete_local')
    await page.getByLabel('完整候选名称（每行一项）', { exact: true }).fill('合成考试甲\n合成考试乙')
    await page.getByLabel('完整性依据', { exact: true }).fill('本地合成固定数据')
    await page.getByLabel('搜索策略', { exact: true }).selectOption('visible_option_substring')
    assert.equal(await page.getByLabel('候选范围', { exact: true }).count(), 0)
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
    assert.equal(await page.getByRole('button', { name: '生成固定计划', exact: true }).isEnabled(), true)
    assert.match(await page.locator('.target-config').innerText(), /生成固定计划/)
    await agent.click()
    await page.waitForURL('**/#/execution-jobs/synthetic-job')
    assert.deepEqual(jobInput,{mode:'agent',targetUrl:'https://example.test/exams',environmentId:'env',projectId:'project',cases:[{caseId:asset.id,revision:asset.revision,contractFingerprint:asset.resolved.contractFingerprint}]})
    await page.reload()
    await page.getByText('排队中 · 动态 Agent', {exact:false}).waitFor()
    await page.goBack()
    await page.getByRole('button', { name: '需求中心', exact: true }).waitFor()
    await page.getByRole('button',{name:'生成固定计划',exact:true}).click()
    await page.getByRole('button',{name:'确认并执行',exact:true}).click()
    await page.waitForURL('**/#/execution-jobs/synthetic-job')
    assert.deepEqual(jobInput,{mode:'plan',automationPlanId:'confirmed-plan',targetUrl:'https://example.test/exams',environmentId:'env',cases:[{caseId:asset.id,revision:asset.revision,contractFingerprint:asset.resolved.contractFingerprint}]})
    await page.goBack()
    await page.getByRole('button', { name: '需求中心', exact: true }).click()
    await page.waitForURL('**/#/requirements?**')
    await page.getByRole('button', { name: '查看需求详情 →', exact: true }).click()
    await page.waitForURL(`**/#/requirements/${analysis.id}?**`)
    await page.reload()
    await page.getByRole('button', { name: '需求概览', exact: true }).waitFor()
    await page.getByRole('button', { name: '需求中心', exact: true }).click()
    await page.waitForURL('**/#/requirements?**')
    await page.getByRole('button', { name: '用例资产', exact: true }).click()
    await page.waitForURL('**/#/cases?**')
    await page.goBack()
    await page.getByRole('heading', { name: '需求中心', exact: true }).waitFor()
    await page.goForward()
    await page.getByRole('heading', { name: '用例资产', exact: true }).waitFor()
    await page.goto(`http://127.0.0.1:${address.port}/#/cases?sourceId=${analysis.id}&caseId=fixture-case&caseStatus=ready`)
    await page.getByRole('heading', { name: '部分关键词搜索', exact: true }).waitFor()
    await page.reload()
    await page.getByRole('heading', { name: '部分关键词搜索', exact: true }).waitFor()
    assert.equal(await page.getByLabel('筛选', { exact: true }).inputValue(), 'ready')
    await page.goto(`http://127.0.0.1:${address.port}/#/executions/${historicalExecution.id}?sourceId=${analysis.id}`)
    const evidence = page.getByRole('region', { name: '本次执行的用例版本' })
    await evidence.getByText('部分关键词搜索 · v1', { exact: true }).waitFor()
    await evidence.locator('summary').click()
    await evidence.getByText('人工确认：验证真实考试的部分搜索', { exact: true }).waitFor()
    assert.equal(await evidence.getByText('人工编辑后的搜索目标', { exact: true }).count(), 0)
    await page.goto(`http://127.0.0.1:${address.port}/#/executions/missing?sourceId=${analysis.id}`)
    await page.getByRole('alert').filter({hasText:'执行记录不存在。未自动替换为其他报告。'}).waitFor()
    await page.goto(`http://127.0.0.1:${address.port}/#/cases?sourceId=missing`)
    await page.getByRole('heading', { name: '记录无法打开' }).waitFor()
    await page.getByRole('button', { name: '返回版本中心', exact: true }).click()
    await page.getByRole('heading', { name: '测试平台 · 合成演示' }).waitFor()
    await page.goto(`http://127.0.0.1:${address.port}/#/requirements/${analysis.id}?requirement=99`)
    await page.getByRole('heading', { name: '需求编号不存在' }).waitFor()
    await page.getByRole('button', { name: '返回需求列表', exact: true }).click()
    await page.getByRole('heading', { name: '需求中心', exact: true }).waitFor()
    await page.goto(`http://127.0.0.1:${address.port}/#/not-found`)
    await page.getByRole('heading', { name: '页面不存在' }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await browser?.close(); await server.close() }
})
