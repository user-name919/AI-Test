import { randomUUID } from 'node:crypto'
import { executionJobRequestSchema, type ExecutionJob } from '@quality-ai/contracts/cases'
import { automationPlanSchema, type LiveExecutionEvent } from '@quality-ai/contracts'
import { database } from '../../storage/database'
import { prepareAssetExecution } from '../cases/execution-preparation'
import { getEnvironmentById } from '../projects/environment-repository'
import { getProjectProviderRegistry } from '../../project-knowledge/registry'
import { runAgentTest } from '../../agent-test-runner'
import { runAutomationPlan } from '../../playwright-runner'
import { generateFixedPlan, proposeFixedPlanData } from '../cases/fixed-plan-model'
import { saveExecution } from './repository'
import { validateDeploymentForExecution } from '../regressions/deployments'
import { acquireChangeSetWorktree, releaseChangeSetWorktree } from '../../integrations/git/worktree-manager'
import { loadProjectConfigs } from '../../project-knowledge/config'
import { LocalProjectKnowledgeProvider } from '../../project-knowledge/local-project-provider'

let initialized = false
let working = false
const queue: Array<() => Promise<void>> = []
const active = new Map<string,{job:ExecutionJob;controller:AbortController}>()

export function initializeExecutionJobs() {
  if (initialized) return
  database.exec(`CREATE TABLE IF NOT EXISTS execution_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, job_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS execution_job_events (job_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(job_id,sequence));
    CREATE TABLE IF NOT EXISTS execution_job_frames (job_id TEXT PRIMARY KEY, event_json TEXT NOT NULL);`)
  const stale = database.prepare("SELECT job_json FROM execution_jobs WHERE status IN ('queued','running','cancelling')").all() as Array<{job_json:string}>
  for (const row of stale) {
    const job = JSON.parse(row.job_json) as ExecutionJob
    job.status = 'interrupted'
    job.error = '服务已重启，原浏览器上下文丢失；未自动重放可能有副作用的操作'
    writeJob(job)
  }
  initialized = true
}

function writeJob(job: ExecutionJob) {
  job.updatedAt = new Date().toISOString()
  database.prepare('INSERT OR REPLACE INTO execution_jobs (id,status,job_json) VALUES (?,?,?)').run(job.id,job.status,JSON.stringify(job))
}

export function getExecutionJob(id: string): ExecutionJob | null {
  const row = database.prepare('SELECT job_json FROM execution_jobs WHERE id=?').get(id) as {job_json:string}|undefined
  return row ? JSON.parse(row.job_json) : null
}

export function listExecutionJobs(): ExecutionJob[] {
  return (database.prepare('SELECT job_json FROM execution_jobs ORDER BY rowid DESC LIMIT 100').all() as Array<{job_json:string}>).map(row=>JSON.parse(row.job_json))
}

export function executionJobEvents(id: string, after: number) {
  const events = (database.prepare('SELECT sequence,event_json FROM execution_job_events WHERE job_id=? AND sequence>? ORDER BY sequence LIMIT 200').all(id,after) as Array<{sequence:number;event_json:string}>).map(row=>({sequence:row.sequence,event:JSON.parse(row.event_json) as LiveExecutionEvent}))
  const frame = database.prepare('SELECT event_json FROM execution_job_frames WHERE job_id=?').get(id) as {event_json:string}|undefined
  return { events, nextCursor: events.at(-1)?.sequence ?? after, frame: frame ? JSON.parse(frame.event_json) : null }
}

export function cancelExecutionJob(id: string) {
  const job = getExecutionJob(id)
  if (!job) throw new Error('执行任务不存在')
  if (job.status === 'cancelled' || job.status === 'cancelling') return job
  const running = active.get(id)
  if (running) {
    running.job.status = 'cancelling'
    running.job.error = '已请求取消，正在停止浏览器并等待当前请求收尾；已提交的业务操作不会回滚'
    writeJob(running.job)
    running.controller.abort(new Error('用户取消执行'))
    return structuredClone(running.job)
  }
  if (job.status !== 'queued') throw new Error('任务已经结束，不能取消')
  job.status = 'cancelled'
  writeJob(job)
  return job
}

async function drainQueue() {
  if (working) return
  working = true
  try { while (queue.length) await queue.shift()!() } finally { working = false }
}

export async function createExecutionJob(input: unknown): Promise<ExecutionJob> {
  const request = executionJobRequestSchema.parse(input)
  if (queue.length >= 20) throw new Error('执行队列已满，请等待当前任务完成')
  const environment = request.environmentId ? getEnvironmentById(request.environmentId) : null
  if (request.environmentId && !environment) throw new Error('测试环境不存在')
  const target = new URL(request.targetUrl)
  if (environment && new URL(environment.baseUrl).origin !== target.origin) throw new Error('测试地址与环境 Origin 不一致')
  const provider = request.projectId ? (await getProjectProviderRegistry()).get(request.projectId) : undefined
  if (request.projectId && !provider) throw new Error('源码项目不存在')
  if (request.mode === 'agent' && !provider) throw new Error('动态执行需要选择源码项目')
  const project = await provider?.getProjectInfo()
  if (project && (!project.connected || (project.targetOrigins.length && !project.targetOrigins.includes(target.origin)))) throw new Error('源码未连接或测试地址不属于该项目')
  // 所有异步配置查询之后重新固定资产，不接受客户端准备接口返回的快照。
  const preparation = prepareAssetExecution({ mode:request.mode,targetUrl:request.targetUrl,cases:request.cases,environmentId:request.environmentId,deploymentConfirmationId:request.deploymentConfirmationId })
  const deployment = preparation.deploymentConfirmation
  if (deployment && request.projectId !== deployment.projectId) throw new Error('回归执行必须选择变更范围对应的源码项目')
  const regressionProjectConfig = deployment ? (await loadProjectConfigs()).find(config => config.id === deployment.projectId) : undefined
  if (deployment && !regressionProjectConfig) throw new Error('回归源码项目配置不存在')
  if (queue.length >= 20) throw new Error('执行队列已满，请等待当前任务完成')
  const now = new Date().toISOString()
  const job: ExecutionJob = {id:randomUUID(),status:'queued',mode:request.mode,targetUrl:request.targetUrl,snapshots:preparation.snapshots,createdAt:now,updatedAt:now,
    environmentId:request.environmentId,projectId:request.projectId,deploymentConfirmation:deployment,
    sourceProject:deployment ? {id:deployment.projectId,commit:deployment.targetSha} : project ? {id:project.id,branch:project.branch,commit:project.commit} : undefined}
  writeJob(job)
  queue.push(async () => {
    if (getExecutionJob(job.id)?.status !== 'queued') return
    job.status = 'running'
    const controller = new AbortController()
    active.set(job.id,{job,controller})
    writeJob(job)
    let sequence = 0
    let sourceLease: Awaited<ReturnType<typeof acquireChangeSetWorktree>> | undefined
    let executionProvider = provider
    const checkDeployment = () => {
      if (deployment) validateDeploymentForExecution(deployment.id, { regressionId:deployment.regressionId,reviewRevision:deployment.reviewRevision,environmentId:deployment.environmentId,targetUrl:job.targetUrl })
    }
    const onEvent = (event: LiveExecutionEvent) => {
      if (event.type === 'browser_frame') database.prepare('INSERT OR REPLACE INTO execution_job_frames (job_id,event_json) VALUES (?,?)').run(job.id,JSON.stringify(event))
      else database.prepare('INSERT INTO execution_job_events (job_id,sequence,event_json) VALUES (?,?,?)').run(job.id,++sequence,JSON.stringify(event))
      writeJob(job)
    }
    try {
      checkDeployment()
      if (deployment && regressionProjectConfig) {
        sourceLease = await acquireChangeSetWorktree(deployment.changeSetId, job.id)
        executionProvider = new LocalProjectKnowledgeProvider({ ...regressionProjectConfig, root: sourceLease.projectPath })
        const snapshotInfo = await executionProvider.getProjectInfo()
        if (!snapshotInfo.connected || snapshotInfo.commit !== deployment.targetSha) throw new Error('回归源码快照与固定目标 SHA 不一致')
      } else if (provider && project) {
        const current = await provider.getProjectInfo()
        if (!current.connected || current.commit !== project.commit || current.branch !== project.branch) throw new Error('排队期间源码版本已变化，请重新确认项目版本再执行')
      }
      let plan
      if (request.mode === 'plan') {
        const casePlans = []
        for (const snapshot of job.snapshots) {
          controller.signal.throwIfAborted()
          const identity = {caseKey:snapshot.resolved.caseKey,title:snapshot.resolved.title,contractFingerprint:snapshot.resolved.contractFingerprint,contract:snapshot.resolved.contract}
          try {
            const generated = await generateFixedPlan(job.targetUrl,snapshot.resolved,controller.signal)
            controller.signal.throwIfAborted()
            casePlans.push({...identity,steps:generated.steps})
          } catch (error) {
            controller.signal.throwIfAborted()
            const preparationError = `固定计划生成受阻：${error instanceof Error ? error.message : String(error)}`
            casePlans.push({...identity,steps:[],preparationError})
            onEvent({type:'activity',executionId:job.id,caseKey:identity.caseKey,caseTitle:identity.title,
              activity:{id:`${identity.caseKey}:plan-blocked`,phase:'observing',title:'该用例计划生成受阻',purpose:'保留原因，继续其余用例；未执行该用例的业务操作',status:'info',message:preparationError}})
          }
        }
        plan = automationPlanSchema.parse({name:`${job.snapshots[0]!.resolved.title} · ${casePlans.length} 条用例`,targetUrl:job.targetUrl,steps:casePlans[0]!.steps,casePlans})
      }
      controller.signal.throwIfAborted()
      checkDeployment()
      const result = request.mode === 'agent'
        ? await runAgentTest(preparation.goals,environment?.storageStatePath,{projectProvider:executionProvider!,executionId:job.id,onEvent,signal:controller.signal})
        : await runAutomationPlan(plan,environment?.storageStatePath,{executionId:job.id,onEvent,signal:controller.signal,resolveTestData:(binding,snapshot)=>proposeFixedPlanData(binding,snapshot,controller.signal)})
      result.caseSnapshots = job.snapshots
      result.sourceProject = job.sourceProject
      result.deploymentConfirmation = deployment
      saveExecution(result,{environmentId:request.environmentId,projectId:request.projectId,caseKeys:job.snapshots.map(snapshot=>snapshot.resolved.caseKey),plan})
      job.executionId = result.id
      job.status = controller.signal.aborted ? 'cancelled' : 'completed' // 完成任务不等于用例通过。
      writeJob(job)
    } catch (error) {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      writeJob(job)
    } finally {
      if (sourceLease) releaseChangeSetWorktree(sourceLease.token)
      active.delete(job.id)
    }
  })
  setImmediate(() => { void drainQueue() })
  return structuredClone(job)
}
