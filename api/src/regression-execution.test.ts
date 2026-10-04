import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RegressionAnalysis } from '@quality-ai/contracts/regressions'

const directory = mkdtempSync(join(tmpdir(), 'quality-ai-regression-execution-'))
const root = join(directory, 'repo')
const projectRoot = join(root, 'app')
mkdirSync(projectRoot, { recursive: true })
process.env.QUALITY_AI_DATA_ROOT = directory
process.env.QUALITY_AI_DATABASE_PATH = join(directory, 'db.sqlite')
process.env.PROJECTS_CONFIG_PATH = join(directory, 'projects.json')
writeFileSync(process.env.PROJECTS_CONFIG_PATH, JSON.stringify({ projects: [{ id: 'fixture', name: '合成子项目', root: projectRoot }] }))
const { createApiServer } = await import('./app')
const { database } = await import('./storage/database')
const { previewChangeSet, freezeChangeSet } = await import('./modules/regressions/change-sets')
const { saveRegressionReview } = await import('./modules/regressions/review')
const { listRegressionCaseAssets } = await import('./modules/cases/regression-assets')
const { saveDeploymentConfirmation } = await import('./modules/regressions/deployments')
const { saveEnvironment } = await import('./modules/projects/environment-repository')
const { acquireChangeSetWorktree, releaseChangeSetWorktree } = await import('./integrations/git/worktree-manager')
const { LocalProjectKnowledgeProvider } = await import('./integrations/project-knowledge/local-project-provider')
const { loadProjectConfigs } = await import('./integrations/project-knowledge/config')

test('回归审核经部署校验后实际执行，冻结子项目源码和报告不随分支移动', async t => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(projectRoot, 'page.ts'), 'export const value = "base"'); git('add', '.'); git('commit', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  writeFileSync(join(projectRoot, 'page.ts'), 'export const value = "frozen"'); git('add', '.'); git('commit', '-m', 'target')
  const sha = git('rev-parse', 'HEAD')
  const modelInputs: string[] = []
  const dynamicInputs:string[]=[]
  let release = () => {}
  let gate = Promise.resolve()
  let visits = 0
  const site = createServer(async (request, response) => {
    if (request.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const raw=Buffer.concat(chunks).toString()
      const body=JSON.parse(raw)
      if(String(body.instructions).includes('单步决策器')){
        dynamicInputs.push(raw)
        const content=String(body.input[0].content)
        const context=JSON.parse(content.slice(content.indexOf('当前输入：\n')+'当前输入：\n'.length).split('\n\nReturn only a valid json object.')[0]!)
        const snapshot=context.currentSnapshot
        const count=context.recentTrajectory.length
        const decision=count===0?{type:'action',snapshotId:snapshot.snapshotId,reason:'点击当前可见按钮',action:{action:'click',elementRef:snapshot.elements.find((item:{name:string})=>item.name==='继续').ref}}
          :count===1?{type:'action',snapshotId:snapshot.snapshotId,reason:'验证原始人工预期',action:{action:'expectText',text:'已继续',assertionId:context.goal.requiredAssertions[0].id}}
          :{type:'finish',summary:'真实页面已验证人工预期'}
        response.setHeader('content-type','application/json');response.end(JSON.stringify({output_text:JSON.stringify(decision)}));return
      }
      modelInputs.push(raw)
      await gate
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ output_text: JSON.stringify({ name: '公开合成回归', targetUrl: target, steps: [{ action: 'click', locator: { by: 'text', value: '继续' } }, { action:'expectText',assertionIndex:0, text: '已继续' }] }) }))
    } else {
      visits++
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end('<button onclick="this.textContent=\'已继续\'">继续</button>')
    }
  })
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))
  const target = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
  process.env.MODEL_API_KEY = 'synthetic-only'; process.env.MODEL_BASE_URL = target
  const api = createApiServer()
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
  t.after(async () => {
    release()
    await new Promise<void>(resolve => api.close(() => resolve()))
    await new Promise<void>(resolve => site.close(() => resolve()))
    database.close(); rmSync(directory, { recursive: true, force: true })
  })
  const preview = await previewChangeSet({ projectId: 'fixture', comparison: { mode: 'endpoints', baseRef: base, targetRef: 'main' } })
  const frozen = freezeChangeSet(preview.id, preview.factsHash)
  const contract = { objective: '点击继续', preconditions: [], steps: ['AI 原始操作'], expectedAssertions: ['显示已继续'], dataBindings: [], forbiddenBehaviors: [], uncertainties: [] }
  const analysis: RegressionAnalysis = { id: randomUUID(), projectId: 'fixture', changeSetId: frozen.id, factsHash: frozen.factsHash, targetSha: sha, status: 'completed', stage: 'finished', createdAt: 'now', updatedAt: 'now', generation: {
    promptVersion: 'fixture', model: 'fixture', reviewStatus: 'pending', pendingEvidenceIds: [], omittedEvidenceIds: [], limitations: [], batches: [{ id: 'b1', inputHash: 'fixture', evidence: [], suggestions: { risks: [{ id: 'r1', title: '按钮交互', reason: '合成风险', severity: 'medium', confidence: 'low', evidenceIds: ['e1'] }], cases: [{ title: '继续按钮', riskIds: ['r1'], verification: 'browser', verificationReason: '页面可观察', contract }], limitations: [] } }],
  } }
  database.prepare('INSERT INTO regression_analyses (id,request_id,record_json) VALUES (?,?,?)').run(analysis.id, randomUUID(), JSON.stringify(analysis))
  saveRegressionReview(analysis.id, { expectedRevision: 0, content: { status: 'confirmed', scopeNote: '合成回归范围', risks: [{ key: 'b1:r1', decision: 'include' }], cases: [{ key: 'b1:case-0', decision: 'include', title: '人工按钮回归', verification: 'browser', verificationReason: '页面文字可见', finalContract: { ...contract, steps: ['人工最终操作：点击继续'] } }] } })
  const asset = listRegressionCaseAssets(analysis.id)[0]!
  const environment = saveEnvironment({ name: '合成部署', baseUrl: target, targetUrl: target })
  const confirmationInput = { reviewRevision: 1, environmentId: environment.id, targetUrl: target, confirmedBy: '夹具审核人', note: '未核实真实部署，仅测试基础链路' }
  const confirmation = saveDeploymentConfirmation(analysis.id, confirmationInput)
  const input = { mode: 'plan', projectId: 'fixture', environmentId: environment.id, targetUrl: target, deploymentConfirmationId: confirmation.id, cases: [{ caseId: asset.id, revision: asset.revision, contractFingerprint: asset.resolved.contractFingerprint }] }
  const post = (body: unknown) => fetch(`${url}/api/execution-jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await post({ ...input, deploymentConfirmationId: undefined })).status, 409)
  assert.equal((await post({ ...input, projectId: undefined })).status, 409)
  const mismatch = saveDeploymentConfirmation(analysis.id, { ...confirmationInput, deployedSha: base })
  assert.equal((await post({ ...input, deploymentConfirmationId: mismatch.id })).status, 409)
  const accepted = saveDeploymentConfirmation(analysis.id, confirmationInput)
  input.deploymentConfirmationId = accepted.id
  writeFileSync(join(projectRoot, 'page.ts'), 'export const value = "newer"'); git('add', '.'); git('commit', '-m', 'branch moved')
  writeFileSync(join(projectRoot, 'draft.txt'), '保留用户未提交内容')
  const created = await post(input)
  assert.equal(created.status, 202, await created.clone().text())
  const job = (await created.json()).job
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)) }
    throw new Error('执行未及时到达预期状态')
  }
  const detail = async (id: string) => (await (await fetch(`${url}/api/execution-jobs/${id}`)).json()).job
  await waitFor(async () => ['completed', 'failed'].includes((await detail(job.id)).status))
  assert.equal((await detail(job.id)).status, 'completed', (await detail(job.id)).error)
  const result = (await (await fetch(`${url}/api/executions/${job.id}`)).json()).execution
  assert.equal(result.status, 'passed')
  assert.equal(result.sourceProject.commit, sha)
  assert.equal(result.sourceProject.worktree.status, 'clean')
  assert.ok(result.sourceProject.worktree.observedAt)
  assert.deepEqual(result.deploymentConfirmation, accepted)
  const legacyRerun=await fetch(`${url}/api/executions/${job.id}/rerun`,{method:'POST'})
  assert.equal(legacyRerun.status,409)
  assert.match((await legacyRerun.json()).error,/重新确认部署版本/)
  const legacyDirect=await fetch(`${url}/api/automation/run`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({plan:result.plan})})
  assert.equal(legacyDirect.status,409)
  assert.match((await legacyDirect.json()).error,/确认部署版本/)
  assert.match(modelInputs[0]!, /人工最终操作/)
  assert.doesNotMatch(modelInputs[0]!, /AI 原始操作/)
  assert.equal(database.prepare('SELECT count(*) AS count FROM regression_worktree_leases').get()!.count, 0)
  const lease = await acquireChangeSetWorktree(frozen.id, 'test-read')
  try {
    const config = (await loadProjectConfigs())[0]!
    const provider = new LocalProjectKnowledgeProvider({ ...config, root: lease.projectPath })
    const context = await provider.inspectFiles({ paths: ['page.ts'], reason: '核对目标源码' })
    assert.match(context.files[0]!.content, /frozen/)
    assert.equal((await provider.getProjectInfo()).commit, sha)
  } finally { releaseChangeSetWorktree(lease.token) }
  assert.equal(readFileSync(join(projectRoot, 'draft.txt'), 'utf8'), '保留用户未提交内容')
  assert.notEqual(git('rev-parse', 'HEAD'), sha)
  const markdown = await (await fetch(`${url}/api/executions/${job.id}/report.md`)).text()
  assert.match(markdown, /未核实，不得作为版本匹配证明/)
  assert.match(markdown, new RegExp(sha))
  const memoryPost=(path:string,body:unknown)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  const memoryResponse=await memoryPost('/api/memories',{executionId:job.id,caseKey:asset.resolved.caseKey,lesson:'先核对继续按钮可见，再按人工断言验证完成文字'})
  assert.equal(memoryResponse.status,201)
  const memory=(await memoryResponse.json()).memory
  assert.equal((await memoryPost(`/api/memories/${memory.id}/review`,{expectedRevision:1,status:'adopted',reason:'已核对当前合成页面与冻结源码，仅辅助操作'})).status,200)
  const withMemory=(await(await post(input)).json()).job
  await waitFor(async()=>['completed','failed'].includes((await detail(withMemory.id)).status))
  assert.equal((await detail(withMemory.id)).status,'completed')
  const memoryReport=(await(await fetch(`${url}/api/executions/${withMemory.id}`)).json()).execution
  assert.equal(memoryReport.status,'passed')
  assert.equal(memoryReport.memoryHints.length,1)
  assert.equal(memoryReport.memoryHints[0].id,memory.id)
  assert.equal(memoryReport.memoryHints[0].revision,2)
  assert.equal(memoryReport.memoryHints[0].sourceCommit,sha)
  assert.deepEqual((await detail(withMemory.id)).memoryHints,memoryReport.memoryHints)
  assert.match(modelInputs[1]!,/先核对继续按钮可见/)
  const memoryMarkdown=await(await fetch(`${url}/api/executions/${withMemory.id}/report.md`)).text()
  assert.match(memoryMarkdown,/本次提供给模型的历史经验/)
  assert.match(memoryMarkdown,/先核对继续按钮可见/)
  const dynamicJob=(await(await post({...input,mode:'agent'})).json()).job
  assert.ok(dynamicJob?.id,'动态任务应成功创建')
  await waitFor(async()=>['completed','failed'].includes((await detail(dynamicJob.id)).status))
  assert.equal((await detail(dynamicJob.id)).status,'completed',(await detail(dynamicJob.id)).error)
  const dynamicReport=(await(await fetch(`${url}/api/executions/${dynamicJob.id}`)).json()).execution
  assert.equal(dynamicReport.status,'passed',dynamicReport.error)
  assert.equal(dynamicReport.caseResults[0].passedAssertions.length,1)
  assert.deepEqual(dynamicReport.memoryHints,memoryReport.memoryHints)
  assert.ok(dynamicInputs.length>=2)
  for(const request of dynamicInputs)assert.match(request,/先核对继续按钮可见/)
  assert.equal((await memoryPost(`/api/memories/${memory.id}/review`,{expectedRevision:2,status:'invalid',reason:'停止自动参考，核对后再决定'})).status,200)
  const afterInvalid=(await(await post(input)).json()).job
  await waitFor(async()=>['completed','failed'].includes((await detail(afterInvalid.id)).status))
  assert.equal((await detail(afterInvalid.id)).status,'completed')
  const invalidReport=(await(await fetch(`${url}/api/executions/${afterInvalid.id}`)).json()).execution
  assert.deepEqual(invalidReport.memoryHints,[])
  assert.doesNotMatch(modelInputs[2]!,/先核对继续按钮可见/)
  assert.deepEqual((await(await fetch(`${url}/api/executions/${withMemory.id}`)).json()).execution,memoryReport,'经验失效不回写已保存报告')
  // 计划生成过程中部署确认发生变化，启动浏览器前必须再次校验。
  gate = new Promise<void>(resolve => { release = resolve })
  const pending = (await (await post(input)).json()).job
  await waitFor(async () => modelInputs.length === 4)
  const visitsBefore = visits
  saveDeploymentConfirmation(analysis.id, { ...confirmationInput, deployedSha: base })
  release()
  await waitFor(async () => (await detail(pending.id)).status === 'failed')
  assert.match((await detail(pending.id)).error, /更新的部署确认/)
  assert.equal(visits, visitsBefore, '过期部署不得启动浏览器')
  assert.equal(database.prepare('SELECT count(*) AS count FROM regression_worktree_leases').get()!.count, 0)
  assert.deepEqual((await (await fetch(`${url}/api/executions/${job.id}`)).json()).execution, result, '后续部署和分支移动不重写旧报告')
})
