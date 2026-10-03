import { createHash, randomUUID } from 'node:crypto'
import type { DesignRun } from '@quality-ai/contracts/case-design'
import { getModelConfig, type ModelConfig } from '../../model-config'
import { extractFacts, factsPromptVersion } from './fact-extractor'
import { getCaseDesign, listDesignRuns, recoverInterruptedDesignRuns, saveDesignRun } from './repository'
import { loadStageSkills, type LoadedDesignSkill } from './skill-loader'

const queue: Array<{ run: DesignRun; config: ModelConfig; controller: AbortController; skills: LoadedDesignSkill[] }> = []
let active: typeof queue[number] | undefined
let initialized = false
export function initializeDesignJobs() {
  if (initialized) return
  recoverInterruptedDesignRuns()
  initialized = true
}
export function startDesignRun(designId: string, expectedRevision: number, skillsEnabled = true) {
  const design = getCaseDesign(designId)
  if (!design) throw new Error('用例设计任务不存在')
  if (design.revision !== expectedRevision) throw new Error('材料版本已变化，请刷新后重试')
  if (queue.length >= 20) throw new Error('生成队列已满，请稍后重试')
  if (listDesignRuns(designId).some(run => run.status === 'queued' || run.status === 'running')) throw new Error('当前设计已有生成任务')
  const config = getModelConfig()
  const skills = loadStageSkills('extracting',skillsEnabled)
  const now = new Date().toISOString()
  const run: DesignRun = {
    id: randomUUID(), designId, attempt: listDesignRuns(designId).length + 1, stage: 'extracting', status: 'queued',
    inputRevision: design.revision, inputHash: design.inputHash, model: config.model, protocol: config.protocol,
    modelConfigHash: createHash('sha256').update(JSON.stringify({model:config.model,baseUrl:config.baseUrl,protocol:config.protocol,userAgent:config.userAgent,originator:config.originator})).digest('hex'),
    promptVersion: factsPromptVersion, skills: skills.map(({id,version,hash})=>({id,version,hash})), createdAt: now, updatedAt: now,
    output: { facts: [], questions: [], processedBlockIds: [], unprocessedBlockIds: design.documents.flatMap(document=>document.blocks.map(block=>block.id)) },
    statistics: { calls: 0, inputCharacters: 0, outputCharacters: 0 },
  }
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
    await extractFacts(design,run,config,controller.signal,checkpoint,skills)
    controller.signal.throwIfAborted()
    run.status = 'completed'; checkpoint()
  } catch (error) {
    if (!controller.signal.aborted) {
      run.status = 'failed'; run.error = error instanceof Error ? error.message : '事实抽取失败'
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
