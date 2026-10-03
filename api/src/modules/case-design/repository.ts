import { createHash, randomUUID } from 'node:crypto'
import type { CaseDesign, DesignDocument } from '@quality-ai/contracts/case-design'
import { database } from '../../storage/database'

export function createCaseDesign(name: string, documents: DesignDocument[]): CaseDesign {
  const now = new Date().toISOString()
  const design: CaseDesign = { id: randomUUID(), name, revision: 1, documents,
    inputHash: createHash('sha256').update(JSON.stringify(documents)).digest('hex'), createdAt: now, updatedAt: now }
  database.prepare('INSERT INTO case_designs (id,name,revision,documents_json,input_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(design.id, name, design.revision, JSON.stringify(documents), design.inputHash, now, now)
  return design
}
export function getCaseDesign(id: string): CaseDesign | null {
  const row = database.prepare('SELECT * FROM case_designs WHERE id=?').get(id) as { id: string; name: string; revision: number; documents_json: string; input_hash: string; created_at: string; updated_at: string } | undefined
  return row ? { id: row.id, name: row.name, revision: row.revision, documents: JSON.parse(row.documents_json), inputHash: row.input_hash, createdAt: row.created_at, updatedAt: row.updated_at } : null
}
export function listCaseDesigns() {
  const rows = database.prepare('SELECT id FROM case_designs ORDER BY created_at DESC LIMIT 100').all() as Array<{ id: string }>
  return rows.map(row => {
    const design = getCaseDesign(row.id)!
    return { id: design.id, name: design.name, revision: design.revision, documentCount: design.documents.length, createdAt: design.createdAt, updatedAt: design.updatedAt }
  })
}
