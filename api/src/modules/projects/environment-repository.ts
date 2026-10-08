import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { TestEnvironment } from '@quality-ai/contracts'
import { getRuntimePaths } from '../../config/paths'
import { database } from '../../storage/database'

function mapEnvironment(row: Record<string, string> | undefined): TestEnvironment | null {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    targetUrl: row.target_url || row.base_url,
    hasStorageState: Boolean(row.storage_state_path),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function saveEnvironment(input: { id?: string; name: string; baseUrl: string; targetUrl: string }): TestEnvironment {
  const now = new Date().toISOString()
  const id = input.id ?? randomUUID()
  database.prepare(`INSERT INTO test_environments (id,name,base_url,target_url,created_at,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,
      storage_state_path=CASE WHEN test_environments.base_url=excluded.base_url THEN test_environments.storage_state_path ELSE NULL END,
      base_url=excluded.base_url,target_url=excluded.target_url,updated_at=excluded.updated_at`)
    .run(id, input.name, input.baseUrl, input.targetUrl, now, now)
  const environment = getEnvironmentById(id)
  if (!environment) throw new Error('测试环境保存失败')
  return mapEnvironment({
    id: environment.id,
    name: environment.name,
    base_url: environment.baseUrl,
    target_url: environment.targetUrl,
    storage_state_path: environment.storageStatePath ?? '',
    created_at: environment.createdAt,
    updated_at: environment.updatedAt,
  }) as TestEnvironment
}

export function setEnvironmentStorageState(id: string, path: string): TestEnvironment {
  database.prepare('UPDATE test_environments SET storage_state_path=?, updated_at=? WHERE id=?').run(path, new Date().toISOString(), id)
  const environment = getEnvironmentById(id)
  if (!environment) throw new Error('测试环境不存在')
  return mapEnvironment({
    id: environment.id,
    name: environment.name,
    base_url: environment.baseUrl,
    target_url: environment.targetUrl,
    storage_state_path: environment.storageStatePath ?? '',
    created_at: environment.createdAt,
    updated_at: environment.updatedAt,
  }) as TestEnvironment
}

export function getEnvironmentById(id: string): (TestEnvironment & { storageStatePath?: string }) | null {
  const row = database.prepare('SELECT * FROM test_environments WHERE id=?').get(id) as Record<string, string> | undefined
  const environment = mapEnvironment(row)
  return environment ? { ...environment, storageStatePath: row?.storage_state_path ? resolve(getRuntimePaths().workspaceRoot, row.storage_state_path) : undefined } : null
}

export function getLatestEnvironment(): TestEnvironment | null {
  return mapEnvironment(database.prepare('SELECT * FROM test_environments ORDER BY updated_at DESC LIMIT 1').get() as Record<string, string> | undefined)
}

export function listEnvironments(): TestEnvironment[] {
  return (database.prepare('SELECT * FROM test_environments ORDER BY updated_at DESC').all() as Array<Record<string,string>>).map(row=>mapEnvironment(row)!)
}
