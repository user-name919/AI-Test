import { randomUUID } from 'node:crypto'
import type { CaseReview, ReviewState, SavedAnalysis } from '@quality-ai/contracts'
import type { CaseAsset, CaseAssetRevision } from '@quality-ai/contracts/cases'
import { database } from '../../storage/database'
import { getAnalysisById, saveReview } from '../requirements/repository'
import { resolveCaseExecutionContract } from '../../review-execution-context'

interface AssetRow {
  id: string
  analysis_id: string
  case_key: string
  original_json: string
  revision: number
  fingerprint: string
  created_at: string
  updated_at: string
}

function transaction<T>(operation: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

// 旧 analysis.review 仍是需求口径的唯一来源；资产保存稳定身份与不可变历史，不复制第二份可变 Review。
function synchronizeAsset(analysis: SavedAnalysis, caseKey: string): CaseAsset {
  const resolved = resolveCaseExecutionContract(analysis, caseKey)
  const review = analysis.review.caseReviews?.[caseKey] ?? null
  let row = database.prepare('SELECT * FROM case_assets WHERE analysis_id=? AND case_key=?').get(analysis.id, caseKey) as AssetRow | undefined
  const now = new Date().toISOString()
  if (!row) {
    const original = resolveCaseExecutionContract({ ...analysis, review: { ...analysis.review, caseReviews: {} } }, caseKey).contract
    row = { id: randomUUID(), analysis_id: analysis.id, case_key: caseKey, original_json: JSON.stringify(original), revision: 1,
      fingerprint: resolved.contractFingerprint, created_at: now, updated_at: now }
    database.prepare('INSERT INTO case_assets (id,analysis_id,case_key,original_json,revision,fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(row.id, row.analysis_id, row.case_key, row.original_json, row.revision, row.fingerprint, now, now)
  } else if (row.fingerprint !== resolved.contractFingerprint) {
    row = { ...row, revision: row.revision + 1, fingerprint: resolved.contractFingerprint, updated_at: now }
    database.prepare('UPDATE case_assets SET revision=?,fingerprint=?,updated_at=? WHERE id=?')
      .run(row.revision, row.fingerprint, now, row.id)
  }
  database.prepare('INSERT OR IGNORE INTO case_asset_revisions (case_id,revision,resolved_json,review_json,created_at) VALUES (?,?,?,?,?)')
    .run(row.id, row.revision, JSON.stringify(resolved), review ? JSON.stringify(review) : null, row.updated_at)
  return {
    id: row.id, title: resolved.title, source: { type: 'requirement', analysisId: analysis.id, caseKey }, revision: row.revision,
    reviewStatus: review?.status ?? 'legacy_unreviewed', originalSuggestion: JSON.parse(row.original_json),
    finalContract: resolved.contract, resolved, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

export function listCaseAssets(analysisId?: string): CaseAsset[] {
  return transaction(() => {
    const ids = analysisId ? [analysisId] : (database.prepare('SELECT id FROM analyses ORDER BY created_at DESC').all() as Array<{ id: string }>).map(row => row.id)
    return ids.flatMap(id => {
      const analysis = getAnalysisById(id)
      if (!analysis) return []
      return analysis.result.requirements.flatMap((requirement, index) => requirement.testCases.map((_, caseIndex) => synchronizeAsset(analysis, `${index}-TC-${caseIndex}`)))
    })
  })
}

function findAsset(id: string) {
  const row = database.prepare('SELECT * FROM case_assets WHERE id=?').get(id) as AssetRow | undefined
  const analysis = row ? getAnalysisById(row.analysis_id) : null
  return row && analysis ? { row, analysis } : null
}

export function getCaseAsset(id: string): CaseAsset | null {
  return transaction(() => {
    const source = findAsset(id)
    return source ? synchronizeAsset(source.analysis, source.row.case_key) : null
  })
}

export function saveCaseAssetReview(id: string, expectedRevision: number, review: Omit<CaseReview, 'updatedAt'>) {
  return transaction(() => {
    const source = findAsset(id)
    if (!source) return { kind: 'missing' as const }
    const current = synchronizeAsset(source.analysis, source.row.case_key)
    if (current.revision !== expectedRevision) return { kind: 'conflict' as const, asset: current }
    const updatedAt = new Date().toISOString()
    source.analysis.review = saveReview(source.analysis.id, {
      ...source.analysis.review,
      caseReviews: { ...source.analysis.review.caseReviews, [source.row.case_key]: { ...review, updatedAt } },
    })
    return { kind: 'saved' as const, asset: synchronizeAsset(source.analysis, source.row.case_key) }
  })
}

export function listCaseAssetRevisions(id: string): CaseAssetRevision[] | null {
  if (!getCaseAsset(id)) return null
  const rows = database.prepare('SELECT revision,resolved_json,review_json,created_at FROM case_asset_revisions WHERE case_id=? ORDER BY revision DESC')
    .all(id) as Array<{ revision: number; resolved_json: string; review_json: string | null; created_at: string }>
  return rows.map(row => ({ revision: row.revision, resolved: JSON.parse(row.resolved_json), review: row.review_json ? JSON.parse(row.review_json) : null, createdAt: row.created_at }))
}

// 兼容入口仍可保存问题口径和勾选状态；已建立资产的用例必须通过带版本号的入口修改。
export function saveAnalysisReviewWithHistory(analysis: SavedAnalysis, review: Omit<ReviewState, 'updatedAt'>) {
  return transaction(() => {
    const rows = database.prepare('SELECT case_key FROM case_assets WHERE analysis_id=?').all(analysis.id) as Array<{ case_key: string }>
    for (const row of rows) {
      if (JSON.stringify(analysis.review.caseReviews?.[row.case_key] ?? null) !== JSON.stringify(review.caseReviews?.[row.case_key] ?? null)) {
        return { kind: 'conflict' as const }
      }
    }
    const keys = analysis.result.requirements.flatMap((requirement, index) => requirement.testCases.map((_, caseIndex) => `${index}-TC-${caseIndex}`))
    keys.forEach(key => synchronizeAsset(analysis, key))
    const saved = saveReview(analysis.id, review)
    keys.forEach(key => synchronizeAsset({ ...analysis, review: saved }, key))
    return { kind: 'saved' as const, review: saved }
  })
}
