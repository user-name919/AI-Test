import { isDeepStrictEqual } from 'node:util'
import type { DesignRun, DesignReview, DesignReviewDraft, DesignReviewContent } from '@quality-ai/contracts/case-design'

// Only the exact generation baseline is eligible; a newer, unrelated review is not a substitute.
export function findBaselineReview(run: DesignRun, runs: DesignRun[], reviews: DesignReview[]) {
  const base = runs.find(item => item.id === run.regeneration?.baseRunId)
  if (!base || base.designId !== run.designId || base.inputHash !== run.inputHash || base.inputRevision !== run.inputRevision) return undefined
  return [...reviews].sort((a, b) => b.revision - a.revision).find(review => {
    const source = runs.find(item => item.id === review.runId)
    return review.designId === run.designId && review.inputHash === run.inputHash && review.inputRevision === run.inputRevision && source &&
      isDeepStrictEqual(source.output.cases, base.output.cases) &&
      isDeepStrictEqual(source.output.factModel, base.output.factModel) &&
      isDeepStrictEqual(source.output.scenarios, base.output.scenarios) &&
      isDeepStrictEqual(source.output.questions, base.output.questions)
  })
}

export function buildReviewDraft(run: DesignRun, runs: DesignRun[], reviews: DesignReview[]): DesignReviewDraft {
  const ordered = [...reviews].sort((a, b) => b.revision - a.revision)
  const saved = ordered.find(item => item.runId === run.id)
  const content: DesignReviewContent = { cases: {}, questionDecisions: {}, issueDecisions: {}, excludedFacts: {} }
  for (const item of run.output.cases ?? []) content.cases[item.id] = {
    title: item.title, contract: structuredClone(item.contract), verification: item.verification,
    verificationReason: item.verificationReason, status: 'draft',
  }
  const result: DesignReviewDraft = { content, expectedRevision: ordered[0]?.revision ?? 0, inheritedCaseIds: [], sourceReviewId: null, sourceReviewRevision: null, savedReviewId: saved?.id ?? null }
  if (saved) {
    result.content = { ...structuredClone(saved.content), cases: { ...content.cases, ...structuredClone(saved.content.cases) } }
    return result
  }
  const sourceReview = findBaselineReview(run, runs, ordered)
  const sourceRun = runs.find(item => item.id === sourceReview?.runId)
  if (!sourceReview || !sourceRun) return result
  result.sourceReviewId = sourceReview.id; result.sourceReviewRevision = sourceReview.revision
  const changed = new Set(run.regeneration?.scenarioIds)
  const contextUnchanged = isDeepStrictEqual(run.output.factModel, sourceRun.output.factModel) &&
    isDeepStrictEqual(run.output.questions, sourceRun.output.questions) && isDeepStrictEqual(run.output.scenarios, sourceRun.output.scenarios)
  if (!contextUnchanged) return result
  for (const item of run.output.cases ?? []) {
    const old = sourceRun.output.cases?.find(candidate => candidate.id === item.id)
    const human = sourceReview.content.cases[item.id]
    if (!changed.has(item.scenarioId) && human && isDeepStrictEqual(old, item)) {
      content.cases[item.id] = structuredClone(human)
      result.inheritedCaseIds.push(item.id)
    }
  }
  content.questionDecisions = structuredClone(sourceReview.content.questionDecisions)
  content.excludedFacts = structuredClone(sourceReview.content.excludedFacts)
  // Checking is a new review pass. Even identical-looking issues require new disposition.
  return result
}
