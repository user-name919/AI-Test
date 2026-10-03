import { createHash, randomUUID } from 'node:crypto'
import type { DesignRun } from '@quality-ai/contracts/case-design'
import { getModelConfig, type ModelConfig } from '../../model-config'
import { extractFacts, factsPromptVersion } from './fact-extractor'
import { getCaseDesign, listDesignRuns, recoverInterruptedDesignRuns, saveDesignRun } from './repository'
import { loadStageSkills, type LoadedDesignSkill } from './skill-loader'
import { planFromFacts } from './scenario-planner'
import { generateCases, generatingPromptVersion } from './case-generator'
import { checkCaseQuality, checkingPromptVersion } from './quality-checker'

const queue: Array<{ run: DesignRun; config: ModelConfig; controller: AbortController; skills: LoadedDesignSkill[] }> = []
let active: typeof queue[number] | undefined
let initialized = false
export function initializeDesignJobs() {
  if (initialized) return
  recoverInterruptedDesignRuns()
  initialized = true
}
export function startDesignRun(designId: string, expectedRevision: number, skillsEnabled = true, stage: DesignRun['stage'] = 'extracting', upstreamRunId?: string, regeneration?: DesignRun['regeneration']) {
  const design = getCaseDesign(designId)
  if (!design) throw new Error('用例设计任务不存在')
  if (design.revision !== expectedRevision) throw new Error('材料版本已变化，请刷新后重试')
  if (queue.length >= 20) throw new Error('生成队列已满，请稍后重试')
  if (listDesignRuns(designId).some(run => run.status === 'queued' || run.status === 'running')) throw new Error('当前设计已有生成任务')
  const previousStage = stage === 'checking' ? 'generating' : stage === 'generating' ? 'planning' : stage === 'modeling' ? 'extracting' : 'modeling'
  const upstream = stage === 'extracting' ? undefined : listDesignRuns(designId).find(run => (!upstreamRunId || run.id === upstreamRunId) && run.stage === previousStage && run.status === 'completed' && run.inputHash === design.inputHash && run.inputRevision === design.revision)
  if (stage !== 'extracting' && !upstream) throw new Error(`缺少兼容的已完成 ${previousStage} 产物，请先完成上游阶段`)
  const base = regeneration && listDesignRuns(designId).find(run => run.id === regeneration.baseRunId)
  if (regeneration) {
    if (stage !== 'generating') throw new Error('局部重生成只适用于 generating 阶段')
    if (!base || !['generating', 'checking'].includes(base.stage) || base.status !== 'completed' || base.inputHash !== design.inputHash || base.inputRevision !== design.revision || !base.output.cases?.length || base.output.unprocessedScenarioIds?.length) throw new Error('局部重生成需要同材料版本的完整用例产物')
    if (JSON.stringify([base.output.factModel, base.output.scenarios, base.output.questions]) !== JSON.stringify([upstream!.output.factModel, upstream!.output.scenarios, upstream!.output.questions])) throw new Error('规则或场景已变化，不能沿用旧用例；请全量生成并重新审核')
    if (!regeneration.scenarioIds.length || new Set(regeneration.scenarioIds).size !== regeneration.scenarioIds.length || regeneration.scenarioIds.some(id => !upstream!.output.scenarios?.some(scenario => scenario.id === id))) throw new Error('局部重生成场景不存在或重复')
  }
  const config = getModelConfig()
  const skills = loadStageSkills(stage,skillsEnabled)
  const now = new Date().toISOString()
  const run: DesignRun = {
    id: randomUUID(), designId, attempt: listDesignRuns(designId).length + 1, stage, status: 'queued', upstreamRunId:upstream?.id,
    regeneration: regeneration ?? (stage === 'checking' ? upstream?.regeneration : undefined),
    inputRevision: design.revision, inputHash: design.inputHash, model: config.model, protocol: config.protocol,
    modelConfigHash: createHash('sha256').update(JSON.stringify({model:config.model,baseUrl:config.baseUrl,protocol:config.protocol,userAgent:config.userAgent,originator:config.originator})).digest('hex'),
    promptVersion: stage==='extracting'?factsPromptVersion:stage==='generating'?generatingPromptVersion:stage==='checking'?checkingPromptVersion:`${stage}-v1`, skills: skills.map(({id,version,hash})=>({id,version,hash})), createdAt: now, updatedAt: now,
    output: upstream ? structuredClone(upstream.output) : { facts: [], questions: [], processedBlockIds: [], unprocessedBlockIds: design.documents.flatMap(document=>document.blocks.map(block=>block.id)) },
    statistics: { calls: 0, inputCharacters: 0, outputCharacters: 0 },
  }
  if (base && regeneration) run.output.cases = structuredClone(base.output.cases!.filter(item => !regeneration.scenarioIds.includes(item.scenarioId)))
  saveDesignRun(run)
  queue.push({run,config,skills,controller:new AbortController()})
  queueMicrotask(() => { void drain() })
  return structuredClone(run)
}
async function drain() {
  if (active) return
  const next = queue.shift()
  if (!next) return
  active = next
  const {run,config,controller,skills} = next
  const checkpoint = () => {
    controller.signal.throwIfAborted()
    run.updatedAt = new Date().toISOString()
    saveDesignRun(run)
  }
  try {
    const design = getCaseDesign(run.designId)
    if (!design || design.inputHash !== run.inputHash || design.revision !== run.inputRevision) throw new Error('材料已变化，本 attempt 不再兼容，请重新生成')
    run.status = 'running'; checkpoint()
    if(run.stage==='extracting') await extractFacts(design,run,config,controller.signal,checkpoint,skills)
    else if (run.stage === 'generating') await generateCases(run,config,controller.signal,checkpoint,skills)
    else if (run.stage === 'checking') await checkCaseQuality(design,run,config,controller.signal,checkpoint,skills)
    else await planFromFacts(design,run,config,controller.signal,checkpoint,skills)
    controller.signal.throwIfAborted()
    run.status = 'completed'; checkpoint()
  } catch (error) {
    if (!controller.signal.aborted) {
      run.status = 'failed'; run.error = error instanceof Error ? error.message : '生成阶段失败'
      run.updatedAt = new Date().toISOString(); saveDesignRun(run)
    }
  } finally { active = undefined; void drain() }
}
export function cancelDesignRun(designId: string) {
  const queuedIndex = queue.findIndex(item=>item.run.designId === designId)
  const entry = active?.run.designId === designId ? active : queuedIndex >= 0 ? queue.splice(queuedIndex,1)[0] : undefined
  if (!entry) return false
  entry.controller.abort(new Error('用户取消'))
  entry.run.status = 'cancelled'; entry.run.error = '用户取消；保留此前批次结果，不代表已完成审核'
  entry.run.updatedAt = new Date().toISOString(); saveDesignRun(entry.run)
  return true
}
