import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { posix } from 'node:path'
import type { LocalChangeFacts, SourceImpact } from '@quality-ai/contracts/regressions'
import { getChangeSet } from './change-sets'
import { acquireChangeSetWorktree, releaseChangeSetWorktree } from '../../integrations/git/worktree-manager'

const execute = promisify(execFile)
const extensions = ['.vue', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']
const sourcePattern = /\.(vue|[cm]?[jt]sx?)$/
interface ImpactBudget { maxFiles: number; maxBytes: number; maxTrees: number }

async function readGit(root: string, args: string[], signal?: AbortSignal) {
  const { stdout } = await execute('git', ['--no-optional-locks', ...args], {
    cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, signal,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout
}

/** 词法候选图，不执行源码/构建配置，不承诺识别运行时注入或完整调用图。 */
export async function collectSourceImpact(root: string, facts: LocalChangeFacts, budget: ImpactBudget = { maxFiles: 400, maxBytes: 2 * 1024 * 1024, maxTrees: 8 }, signal?: AbortSignal): Promise<SourceImpact> {
  if (![budget.maxFiles, budget.maxBytes, budget.maxTrees].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('源码读取预算必须为正整数')
  const changes = new Map<string, Set<string>>()
  const add = (sha: string, paths: string[]) => { if (!changes.has(sha)) changes.set(sha, new Set()); for (const path of paths) changes.get(sha)!.add(path) }
  add(facts.targetSha, facts.diffs.flatMap(diff => diff.files.map(file => file.path)))
  for (const diff of facts.diffs) {
    add(diff.baseSha, diff.files.map(file => file.oldPath ?? file.path))
    add(diff.targetSha, diff.files.map(file => file.path))
  }
  const result: SourceImpact = { method: 'static-import-candidates-v1', trees: [], skippedShas: [], warnings: [
    '这是 import/re-export/require 的词法候选关系，可能包含注释或字符串误匹配；不是完整调用图，也不是页面业务通过证明。',
    '相对路径按常见扩展名解析；别名、包导出、自动组件注册、模板全局组件、运行时路由和依赖注入不假装已解析。',
    '受影响文件包含反向传递引用者；文件名像页面不等于已确认可访问路由。',
  ] }
  let filesRead = 0
  let bytesRead = 0
  for (const [sha, changed] of changes) {
    signal?.throwIfAborted()
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('源码分析只接受已固定 SHA')
    if (result.trees.length >= budget.maxTrees) { result.skippedShas.push(sha); continue }
    const tree: SourceImpact['trees'][number] = { sha, changedFiles: [...changed], scannedFiles: [], skippedFiles: [], edges: [], affectedFiles: [], unresolved: [] }
    result.trees.push(tree)
    const entries = (await readGit(root, ['ls-tree', '-r', '-z', '-l', sha], signal)).split('\0').filter(Boolean).map(record => {
      const tab = record.indexOf('\t')
      const [mode, type, oid, size] = record.slice(0, tab).trim().split(/\s+/)
      return { path: record.slice(tab + 1), mode, type, oid: oid!, size: Number(size) }
    })
    const paths = new Set(entries.filter(entry => entry.type === 'blob' && entry.mode !== '120000').map(entry => entry.path))
    entries.sort((left, right) => Number(changed.has(right.path)) - Number(changed.has(left.path)) || left.path.localeCompare(right.path))
    for (const entry of entries) {
      signal?.throwIfAborted()
      const skip = (reason: string) => tree.skippedFiles.push({ path: entry.path, reason })
      if (entry.mode === '120000' || entry.type !== 'blob') { skip('软链或子模块，不跟随读取'); continue }
      if (!sourcePattern.test(entry.path)) { skip('非脚本文件，未进行依赖分析'); continue }
      if (entry.path.split('/').some(part => ['node_modules', 'dist', 'vendor'].includes(part))) { skip('生成物或第三方目录'); continue }
      if (entry.size > 128 * 1024) { skip('单文件超过 128 KiB'); continue }
      if (filesRead >= budget.maxFiles || bytesRead + entry.size > budget.maxBytes) { skip('本次文件数或字节预算已用尽'); continue }
      const content = await readGit(root, ['cat-file', 'blob', entry.oid], signal)
      filesRead++; bytesRead += entry.size
      if (content.includes('\0') || content.startsWith('version https://git-lfs.github.com/spec/')) { skip('二进制或 LFS 指针，未展开'); continue }
      tree.scannedFiles.push(entry.path)
      const pattern = /\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?['"]([^'"\n]+)['"]|\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g
      for (const match of content.matchAll(pattern)) {
        const specifier = match[1] ?? match[2]!
        const line = content.slice(0, match.index).split('\n').length
        let resolved: string | undefined
        if (specifier.startsWith('.')) {
          const base = posix.normalize(posix.join(posix.dirname(entry.path), specifier))
          const candidates = [base, ...extensions.map(extension => base + extension), ...extensions.map(extension => `${base}/index${extension}`)]
          resolved = candidates.find(candidate => paths.has(candidate))
        }
        if (resolved) tree.edges.push({ from: entry.path, to: resolved, line, specifier })
        else tree.unresolved.push({ path: entry.path, line, expression: specifier, reason: specifier.startsWith('.') ? '相对依赖未在当前树解析' : '别名或外部包，未读取构建配置解析' })
      }
      for (const [index, line] of content.split('\n').entries()) {
        if (/\b(?:import|require)\s*\(\s*[^\s'")]|import\.meta\.glob|require\.context/.test(line)) tree.unresolved.push({ path: entry.path, line: index + 1, expression: line.trim().slice(0, 240), reason: '动态依赖表达式，需要人工或运行时验证' })
      }
    }
    const affected = new Set(changed)
    let expanded = true
    while (expanded) {
      expanded = false
      for (const edge of tree.edges) if (affected.has(edge.to) && !affected.has(edge.from)) { affected.add(edge.from); expanded = true }
    }
    tree.affectedFiles = [...affected].filter(path => paths.has(path))
  }
  if (result.skippedShas.length || result.trees.some(tree => tree.skippedFiles.length || tree.unresolved.length)) result.warnings.push('存在未读取版本、文件或未解析依赖；分析范围不完整，请查看逐项原因。')
  return result
}

export async function analyzeChangeSetSource(changeSetId: string, owner: string, signal?: AbortSignal): Promise<SourceImpact> {
  const changeSet = getChangeSet(changeSetId)
  if (!changeSet || changeSet.status !== 'frozen') throw new Error('必须先冻结变更范围')
  const lease = await acquireChangeSetWorktree(changeSetId, owner)
  try { signal?.throwIfAborted(); return await collectSourceImpact(lease.path, changeSet.facts, undefined, signal) }
  finally { releaseChangeSetWorktree(lease.token) }
}
