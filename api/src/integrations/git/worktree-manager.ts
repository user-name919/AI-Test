import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, lstat } from 'node:fs/promises'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { database } from '../../storage/database'
import { getRuntimePaths } from '../../config/paths'
import { getChangeSet } from '../../modules/regressions/change-sets'
import type { ManagedWorktreeStatus } from '@quality-ai/contracts/regressions'

const execute = promisify(execFile)
interface SnapshotRow { change_set_id: string; path: string; source_root: string; sha: string; state: string; error: string | null }
const operations = new Map<string, Promise<unknown>>()

export function initializeManagedWorktrees() {
  database.exec(`CREATE TABLE IF NOT EXISTS regression_worktrees (
    change_set_id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, source_root TEXT NOT NULL,
    sha TEXT NOT NULL, state TEXT NOT NULL, error TEXT
  ); CREATE TABLE IF NOT EXISTS regression_worktree_leases (
    token TEXT PRIMARY KEY, change_set_id TEXT NOT NULL, owner TEXT NOT NULL, created_at TEXT NOT NULL
  )`)
}

async function git(root: string, args: string[]) {
  const options = {
    cwd: root, encoding: 'utf8' as const, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
  }
  const config = await execute('git', ['config', '--name-only', '--list'], options)
  const filterKeys = config.stdout.trim().split('\n').filter(key => /^filter\..*\.(clean|smudge|process|required)$/.test(key))
  const filterOverrides = filterKeys.flatMap(key => ['-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`])
  // 状态校验也可能触发 clean/process；分析只读用途不执行转换程序，LFS 保留指针。
  const { stdout } = await execute('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', ...filterOverrides, ...args], options)
  return stdout.trim()
}

async function serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const pending = (operations.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation)
  operations.set(id, pending)
  try { return await pending } finally { if (operations.get(id) === pending) operations.delete(id) }
}

async function validateSnapshot(row: SnapshotRow) {
  const managedRoot = await realpath(join(getRuntimePaths().dataRoot, 'regression-worktrees'))
  if (dirname(managedRoot) !== await realpath(getRuntimePaths().dataRoot)) throw new Error('平台快照根目录被重定向，拒绝操作')
  if (dirname(row.path) !== managedRoot || (await lstat(row.path)).isSymbolicLink() || await realpath(row.path) !== row.path) throw new Error('源码快照路径不在平台管理目录或被软链替换')
  if (await git(row.path, ['rev-parse', 'HEAD']) !== row.sha) throw new Error('源码快照 SHA 已变化，拒绝复用或清理')
  if (await git(row.path, ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'HEAD') throw new Error('源码快照不再处于 detached 状态')
  const sourceCommon = await realpath(await git(row.source_root, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  const snapshotCommon = await realpath(await git(row.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  if (sourceCommon !== snapshotCommon) throw new Error('源码快照所属仓库不匹配')
  if (await git(row.path, ['status', '--porcelain', '--untracked-files=all', '--ignored'])) throw new Error('源码快照存在修改或额外文件；为保护内容，拒绝复用或清理')
}

/** 引用令牌必须在任务 finally 释放；重启不自动清空遗留引用，宁可保留目录也不误删。 */
export async function acquireChangeSetWorktree(changeSetId: string, owner: string) {
  if (!owner.trim() || owner.length > 200) throw new Error('源码快照使用方标识不能为空或过长')
  return serialized(changeSetId, async () => {
    const changeSet = getChangeSet(changeSetId)
    if (!changeSet || changeSet.status !== 'frozen') throw new Error('必须先确认冻结变更范围')
    let row = database.prepare('SELECT * FROM regression_worktrees WHERE change_set_id=?').get(changeSetId) as SnapshotRow | undefined
    if (!row || row.state === 'removed') {
      const source = database.prepare('SELECT source_root FROM change_sets WHERE id=?').get(changeSetId) as { source_root: string }
      const sourceRoot = await realpath(source.source_root)
      const managedDirectory = join(getRuntimePaths().dataRoot, 'regression-worktrees')
      await mkdir(managedDirectory, { recursive: true })
      const managedRoot = await realpath(managedDirectory)
      if (dirname(managedRoot) !== await realpath(getRuntimePaths().dataRoot)) throw new Error('平台快照根目录被重定向，拒绝创建')
      const path = join(managedRoot, randomUUID())
      row = { change_set_id: changeSetId, path, source_root: sourceRoot, sha: changeSet.facts.targetSha, state: 'preparing', error: null }
      database.prepare('INSERT OR REPLACE INTO regression_worktrees (change_set_id,path,source_root,sha,state,error) VALUES (?,?,?,?,?,NULL)').run(changeSetId, path, sourceRoot, row.sha, row.state)
      try {
        await git(sourceRoot, ['worktree', 'add', '--detach', path, row.sha])
        await validateSnapshot(row)
        database.prepare("UPDATE regression_worktrees SET state='ready' WHERE change_set_id=?").run(changeSetId)
        row.state = 'ready'
      } catch {
        database.prepare("UPDATE regression_worktrees SET state='error',error=? WHERE change_set_id=?").run('创建或校验源码快照失败；保留登记及目录，不自动删除或重复创建', changeSetId)
        throw new Error('创建或校验源码快照失败；已保留登记，需要检查后恢复，原工作区未切换')
      }
    }
    if (row.state !== 'ready') throw new Error('源码快照未就绪或上次操作中断；保留现场，不自动重试创建')
    await validateSnapshot(row)
    // 配置可以指向仓库中的子项目；Provider 的相对 sourceRoots 不能被提升到仓库根。
    const repositoryRoot = await realpath(await git(row.source_root, ['rev-parse', '--show-toplevel']))
    const projectOffset = relative(repositoryRoot, row.source_root)
    if (isAbsolute(projectOffset) || projectOffset === '..' || projectOffset.startsWith('../')) throw new Error('源码项目不在原仓库内')
    const projectPath = await realpath(join(row.path, projectOffset))
    const snapshotOffset = relative(row.path, projectPath)
    if (isAbsolute(snapshotOffset) || snapshotOffset === '..' || snapshotOffset.startsWith('../')) throw new Error('目标版本的源码项目指向快照外部')
    const token = randomUUID()
    database.prepare('INSERT INTO regression_worktree_leases (token,change_set_id,owner,created_at) VALUES (?,?,?,?)').run(token, changeSetId, owner, new Date().toISOString())
    return { token, path: row.path, projectPath, sha: row.sha, changeSetId }
  })
}

export function releaseChangeSetWorktree(token: string) {
  database.prepare('DELETE FROM regression_worktree_leases WHERE token=?').run(token)
}

export async function getManagedWorktreeStatus(changeSetId:string):Promise<ManagedWorktreeStatus>{
  const row=database.prepare('SELECT * FROM regression_worktrees WHERE change_set_id=?').get(changeSetId) as SnapshotRow|undefined
  const references=(database.prepare('SELECT owner,created_at FROM regression_worktree_leases WHERE change_set_id=? ORDER BY created_at').all(changeSetId) as Array<{owner:string;created_at:string}>).map(item=>({owner:item.owner,createdAt:item.created_at}))
  if(!row)return {changeSetId,state:'not_created',references,canRemove:false,reason:'尚未创建平台源码快照'}
  const state=['preparing','ready','removed'].includes(row.state)?row.state as 'preparing'|'ready'|'removed':'error'
  const result:ManagedWorktreeStatus={changeSetId,state,sha:row.sha,references,canRemove:false,reason:''}
  if(state==='removed')return {...result,reason:'快照已清理；后续任务可从固定SHA重新创建，历史报告仍保留'}
  if(state!=='ready')return {...result,canRecover:!operations.has(changeSetId)&&!references.length,reason:operations.has(changeSetId)?'当前服务仍在处理该快照，请等待操作完成后刷新':references.length?'仍有引用登记，未经核实不恢复或清理':row.error??'创建未完成或状态异常，可手动校验现有快照；不自动重建或清理'}
  if(references.length)return {...result,reason:'仍有任务引用登记；可能包含中断遗留引用，未经核实不能清理'}
  try{await validateSnapshot(row);return {...result,canRemove:true,reason:'已核对无引用、版本正确且无改动；清理时仍会重新校验'}}
  catch(error){return {...result,reason:error instanceof Error?error.message:'快照校验失败，不能清理'}}
}

/** Reconcile a completed Git checkout whose durable ready transition was interrupted. */
export async function recoverChangeSetWorktree(changeSetId:string){
  if(operations.has(changeSetId))throw new Error('当前服务仍在处理该快照，不能同时恢复')
  return serialized(changeSetId,async()=>{
    const row=database.prepare('SELECT * FROM regression_worktrees WHERE change_set_id=?').get(changeSetId) as SnapshotRow|undefined
    const changeSet=getChangeSet(changeSetId)
    if(!row||!changeSet||changeSet.status!=='frozen'||row.sha!==changeSet.facts.targetSha)throw new Error('快照登记与冻结版本不一致，拒绝恢复')
    if(!['preparing','error'].includes(row.state))throw new Error('仅准备中或异常的快照需要恢复登记')
    if(database.prepare('SELECT token FROM regression_worktree_leases WHERE change_set_id=? LIMIT 1').get(changeSetId))throw new Error('仍有任务引用登记，不能恢复；不会自动清空引用')
    // Never remove partial files, recreate paths, change SHA, or release unknown leases.
    await validateSnapshot(row)
    database.prepare("UPDATE regression_worktrees SET state='ready',error=NULL WHERE change_set_id=?").run(changeSetId)
  })
}

export async function removeUnusedChangeSetWorktree(changeSetId: string) {
  return serialized(changeSetId, async () => {
    const row = database.prepare('SELECT * FROM regression_worktrees WHERE change_set_id=?').get(changeSetId) as SnapshotRow | undefined
    if (!row) throw new Error('没有平台登记的源码快照，拒绝清理')
    if (row.state === 'removed') return
    if (row.state !== 'ready') throw new Error('源码快照状态异常，保留现场，不自动清理')
    if (database.prepare('SELECT token FROM regression_worktree_leases WHERE change_set_id=? LIMIT 1').get(changeSetId)) throw new Error('仍有任务引用源码快照，不能清理')
    await validateSnapshot(row)
    await git(row.source_root, ['worktree', 'remove', row.path]) // 无 --force，Git 再次保护未提交文件。
    database.prepare("UPDATE regression_worktrees SET state='removed' WHERE change_set_id=?").run(changeSetId)
  })
}
