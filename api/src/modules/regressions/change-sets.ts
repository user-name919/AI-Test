import { createHash, randomUUID } from 'node:crypto'
import type { ChangeSet } from '@quality-ai/contracts/regressions'
import { changeSetPreviewSchema } from '@quality-ai/contracts/regressions'
import { database } from '../../storage/database'
import { collectLocalChangeFacts } from '../../integrations/git/local-git'
import { getProjectProviderRegistry } from '../../project-knowledge/registry'

export function initializeChangeSets() {
  database.exec(`CREATE TABLE IF NOT EXISTS change_sets (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_root TEXT NOT NULL,
    facts_hash TEXT NOT NULL, status TEXT NOT NULL, record_json TEXT NOT NULL
  )`)
}

export function getChangeSet(id: string): ChangeSet | null {
  const row = database.prepare('SELECT record_json FROM change_sets WHERE id=?').get(id) as { record_json: string } | undefined
  return row ? JSON.parse(row.record_json) : null
}

export function listChangeSets() {
  const rows = database.prepare('SELECT record_json FROM change_sets ORDER BY rowid DESC LIMIT 100').all() as Array<{ record_json: string }>
  return rows.map(row => {
    const { facts, ...record } = JSON.parse(row.record_json) as ChangeSet
    return { ...record, targetSha: facts.targetSha, comparison: facts.comparison, dirty: facts.dirty,
      fileCount: new Set(facts.diffs.flatMap(diff => diff.files.map(file => file.path))).size, warnings: facts.warnings }
  })
}

export async function previewChangeSet(input: unknown): Promise<ChangeSet> {
  const request = changeSetPreviewSchema.parse(input)
  const provider = (await getProjectProviderRegistry()).get(request.projectId)
  if (!provider) throw new Error('源码项目不存在，请先配置本地项目')
  const info = await provider.getProjectInfo()
  if (!info.connected || !info.resolvedRoot) throw new Error('源码项目未连接')
  const facts = await collectLocalChangeFacts(info.resolvedRoot, request.comparison)
  const factsHash = createHash('sha256').update(JSON.stringify(facts)).digest('hex')
  const record: ChangeSet = { id: randomUUID(), projectId: request.projectId, status: 'preview', factsHash, facts, createdAt: new Date().toISOString() }
  database.prepare('INSERT INTO change_sets (id,project_id,source_root,facts_hash,status,record_json) VALUES (?,?,?,?,?,?)')
    .run(record.id, record.projectId, info.resolvedRoot, factsHash, record.status, JSON.stringify(record))
  return record
}

/** 冻结用户看过的服务端事实，不重新解析可能已移动的分支，不接受客户端 patch。 */
export function freezeChangeSet(id: string, expectedHash: string): ChangeSet {
  const record = getChangeSet(id)
  if (!record) throw new Error('变更范围不存在')
  if (record.factsHash !== expectedHash) throw new Error('预览指纹不一致，请重新查看范围后确认')
  if (record.status === 'frozen') return record
  const frozen: ChangeSet = { ...record, status: 'frozen', frozenAt: new Date().toISOString() }
  database.prepare("UPDATE change_sets SET status='frozen',record_json=? WHERE id=? AND facts_hash=? AND status='preview'")
    .run(JSON.stringify(frozen), id, expectedHash)
  return frozen
}
