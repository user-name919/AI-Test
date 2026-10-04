import { createHash, randomUUID } from 'node:crypto'
import type { CaseDesign, DesignPublication, DesignReview, DesignRun } from '@quality-ai/contracts/case-design'
import { caseExecutionContractSchema } from '@quality-ai/contracts'
import { database } from '../../storage/database'
import { getCaseDesign, listDesignRuns } from './repository'
import { listDesignReviews } from './review'
import { validateFactEvidence } from './evidence-validator'

export function publicationBlockers(design: CaseDesign, run: DesignRun, review: DesignReview): string[] {
  const reasons: string[] = []
  const drafts = run.output.cases ?? []
  const facts = run.output.factModel?.consolidatedFacts ?? []
  const final = review.content
  const included = drafts.filter(item => final.cases[item.id]?.status === 'confirmed')
  if (run.status !== 'completed' || run.stage !== 'checking' || !run.output.modelReviewCompleted) reasons.push('质量审查尚未完成')
  const batches=run.output.qualityBatches
  if(batches&&(!batches.length||batches.some(batch=>batch.status!=='completed')
    ||drafts.some(item=>!batches.some(batch=>batch.caseIds.includes(item.id)))
    ||facts.some(item=>!batches.some(batch=>batch.factIds.includes(item.id)))
    ||run.output.scenarios?.some(item=>!batches.some(batch=>batch.scenarioIds.includes(item.id)))
    ||run.output.questions.some(item=>!batches.some(batch=>batch.questionIds.includes(item.id)))
    ||run.output.factModel?.conflicts.some(item=>!batches.some(batch=>batch.conflictIds.includes(item.id)))
    ||design.documents.some(document=>document.blocks.some(block=>!batches.some(batch=>batch.blockIds.includes(block.id))))))reasons.push('质量审查批次或目标范围尚未完成')
  if(run.output.unreviewedBlockIds?.length)reasons.push('仍有未审查原文')
  if (run.inputHash !== design.inputHash || review.inputHash !== design.inputHash || review.inputRevision !== design.revision || run.inputRevision !== design.revision) reasons.push('材料版本变化，需要重新生成与审核')
  if (run.output.unprocessedBlockIds.length || run.output.unprocessedScenarioIds?.length) reasons.push('仍有未处理材料或场景')
  if (!included.length) reasons.push('至少确认一条用例才能发布')
  for (const item of drafts) {
    const edited = final.cases[item.id]
    if (!edited || edited.status === 'draft') { reasons.push(`用例“${item.title}”尚未确认或明确排除`); continue }
    if (edited.status === 'excluded') continue
    if (!item.factIds.length || item.factIds.some(id => !facts.some(fact => fact.id === id))) reasons.push(`用例“${edited.title}”缺少有效规则关联`)
    if (!caseExecutionContractSchema.safeParse(edited.contract).success) reasons.push(`用例“${edited.title}”最终契约无效`)
    if (edited.contract.uncertainties.length) reasons.push(`用例“${edited.title}”仍有未确定事项`)
    if (item.questionIds.some(id => !final.questionDecisions[id])) reasons.push(`用例“${edited.title}”的关联问题尚未决定`)
    if (item.factIds.some(id => final.excludedFacts[id])) reasons.push(`用例“${edited.title}”引用了已排除规则`)
    for (const binding of edited.contract.dataBindings) {
      if (binding.strategy === 'non_matching_option_query' && (!binding.optionUniverse || binding.optionUniverse.completeness !== 'complete_local' || !binding.optionUniverse.options.length || !binding.optionUniverse.evidence.trim())) reasons.push(`用例“${edited.title}”负例数据缺少完整候选依据`)
    }
  }
  const includedFactIds = new Set(included.flatMap(item => item.factIds))
  for (const issue of validateFactEvidence(facts.filter(fact => includedFactIds.has(fact.id)), design.documents)) reasons.push(`规则 ${issue.factId}：${issue.reason}`)
  for (const fact of facts) if (fact.kind === 'explicit' && !includedFactIds.has(fact.id) && !final.excludedFacts[fact.id]) reasons.push(`显式规则 ${fact.id} 尚未覆盖或明确排除`)
  for (const issue of run.output.issues ?? []) {
    const excluded = issue.targetType === 'case' ? final.cases[issue.targetId]?.status === 'excluded'
      : issue.targetType === 'fact' ? Boolean(final.excludedFacts[issue.targetId])
      : issue.targetType === 'scenario' ? drafts.some(item => item.scenarioId === issue.targetId) && drafts.filter(item => item.scenarioId === issue.targetId).every(item => final.cases[item.id]?.status === 'excluded') : false
    if (issue.severity === 'blocking' && !excluded && !final.issueDecisions[issue.id]) reasons.push(`审查问题未处理：${issue.reason}`)
  }
  return [...new Set(reasons)]
}

export function listDesignPublications(designId: string): DesignPublication[] {
  return (database.prepare('SELECT publication_json FROM case_design_publications WHERE design_id=? ORDER BY version DESC').all(designId) as Array<{publication_json:string}>).map(row => JSON.parse(row.publication_json))
}

export function publishDesign(designId: string, expectedRevision: number): { publication: DesignPublication } | { errors: string[] } {
  database.exec('BEGIN IMMEDIATE')
  try {
    const design = getCaseDesign(designId)
    const review = listDesignReviews(designId)[0]
    const run = review && listDesignRuns(designId).find(item => item.id === review.runId)
    const errors = !design || !review || !run ? ['缺少设计、人工审核或审查产物'] : review.revision !== expectedRevision ? ['审核版本已变化，请刷新后发布'] : publicationBlockers(design, run, review)
    if (errors.length) { database.exec('ROLLBACK'); return { errors } }
    if (!design || !review || !run) throw new Error('发布上下文缺失')
    const existing = listDesignPublications(designId)
    const duplicate = existing.find(item => item.snapshot.review.id === review.id)
    if (duplicate) { database.exec('COMMIT'); return { publication: duplicate } }
    const cases = run.output.cases!.filter(item => review.content.cases[item.id]?.status === 'confirmed').map(item => {
      const final = review.content.cases[item.id]
      return { id: item.id, scenarioId: item.scenarioId, factIds: item.factIds, questionIds: item.questionIds, title: final.title, contract: final.contract, verification: final.verification, verificationReason: final.verificationReason }
    })
    const snapshot: DesignPublication['snapshot'] = { design, run, review, cases }
    const publication: DesignPublication = { id: randomUUID(), designId, version: (existing[0]?.version ?? 0) + 1, createdAt: new Date().toISOString(), contentHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), snapshot }
    database.prepare('INSERT INTO case_design_publications (id,design_id,version,review_id,publication_json) VALUES (?,?,?,?,?)').run(publication.id, designId, publication.version, review.id, JSON.stringify(publication))
    database.exec('COMMIT'); return { publication }
  } catch (error) { database.exec('ROLLBACK'); throw error }
}

export function exportPublicationMarkdown(publication: DesignPublication): string {
  const { design, review, run, cases } = publication.snapshot
  const text = (value: string) => value.replace(/[&<>]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[char]!)).replace(/([\\`*_{}[\]()#+.!|~-])/g, '\\$1')
  const lines = [`# ${text(design.name)} · 用例版本 ${publication.version}`, '', `发布 ID：${publication.id}`, `内容 SHA256：${publication.contentHash}`, `审核版本：${review.revision}；材料版本：${design.revision}`, '', '这是已确认的设计范围，不代表自动化执行通过。', '']
  for (const item of cases) {
    const value = item
    lines.push(`## ${text(value.title)}`, '', `用例 ID：${item.id}`, `验证方式：${value.verification} — ${text(value.verificationReason)}`, `目标：${text(value.contract.objective)}`, '')
    for (const [label, values] of [['前置条件',value.contract.preconditions],['执行步骤',value.contract.steps],['预期断言',value.contract.expectedAssertions],['禁止行为',value.contract.forbiddenBehaviors],['未确定事项',value.contract.uncertainties]] as const) lines.push(`### ${label}`, '', ...values.map(entry => `- ${text(entry)}`), ...(values.length ? [] : ['无']), '')
    lines.push('### 数据策略', '')
    for (const binding of value.contract.dataBindings) lines.push(`- ${text(JSON.stringify(binding))}`)
    if (!value.contract.dataBindings.length) lines.push('无')
    lines.push('', '### 原文依据与人工决定', '')
    for (const fact of run.output.factModel?.consolidatedFacts.filter(fact => item.factIds.includes(fact.id)) ?? []) {
      lines.push(`- ${text(fact.id)}（${fact.kind}）：${text(fact.statement)}`)
      for (const ref of fact.evidence) {
        const document = design.documents.find(document => document.id === ref.documentId)
        const block = document?.blocks.find(block => block.id === ref.blockId)
        lines.push(`  - ${text(document?.fileName ?? ref.documentId)} / ${text(block?.section ?? ref.blockId)}${block?.page ? ` / 第 ${block.page} 页` : ''}：${text(ref.quote)}`)
      }
    }
    for (const id of item.questionIds) lines.push(`- ${text(id)}：${text(review.content.questionDecisions[id] ?? '未决定')}`)
    lines.push('')
  }
  lines.push('## 排除与审查处置', '')
  for (const [id, item] of Object.entries(review.content.cases)) if (item.status === 'excluded') lines.push(`- 排除用例 ${text(id)}：${text(item.exclusionReason ?? '')}`)
  for (const [id, reason] of Object.entries(review.content.excludedFacts)) lines.push(`- 排除规则 ${text(id)}：${text(reason)}`)
  for (const issue of run.output.issues ?? []) {
    const decision = review.content.issueDecisions[issue.id]
    lines.push(`- ${issue.checkedBy}/${issue.severity} ${text(issue.reason)}；人工处置：${decision ? text(`${decision.status}：${decision.reason}`) : '无单独处置，见排除范围或保留警告'}`)
  }
  return lines.join('\n') + '\n'
}
