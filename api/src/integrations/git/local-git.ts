import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { changeComparisonSchema, type GitCommitFact, type GitDiffFact, type GitFileChange, type LocalChangeFacts } from '@quality-ai/contracts/regressions'

const execute = promisify(execFile)
// 禁止 shell、外部 diff/textconv 和按需拉取；超限直接失败，不将截断文本当完整事实。
async function git(root: string, args: string[]): Promise<string> {
  try {
    const result = await execute('git', ['--no-optional-locks', '-c', 'core.quotePath=false', ...args], {
      cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_PAGER: 'cat' },
    })
    return result.stdout
  } catch {
    throw new Error(`本地 Git 读取失败或超过 15 秒/8 MiB 上限（${args[0]}）；未拉取远端，未保存不完整范围`)
  }
}

async function resolveCommit(root: string, ref: string): Promise<string> {
  // 分支只查 refs/heads，拒绝把远端 URL、路径或任意 revision 表达式作为输入。
  const name = /^[a-f0-9]{7,64}$/i.test(ref) ? ref : ref.startsWith('refs/heads/') ? ref : `refs/heads/${ref}`
  if (name.startsWith('refs/heads/')) await git(root, ['check-ref-format', name])
  const sha = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${name}^{commit}`])).trim()
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('无法解析本地提交')
  return sha
}

async function commitFact(root: string, sha: string): Promise<GitCommitFact> {
  const [parents = '', subject = ''] = (await git(root, ['show', '-s', '--format=%P%x00%s', sha, '--'])).trimEnd().split('\0')
  return { sha, parents: parents.split(' ').filter(Boolean), subject }
}

async function revisionList(root: string, args: string[]): Promise<string[]> {
  const list = (await git(root, ['rev-list', '--topo-order', '--reverse', '--max-count=1001', ...args])).trim().split('\n').filter(Boolean)
  if (list.length > 1000) throw new Error('比较范围超过 1000 个提交，请缩小范围；未截断保存')
  return list
}

async function diffFact(root: string, baseSha: string, targetSha: string): Promise<GitDiffFact> {
  const flags = ['--no-ext-diff', '--no-textconv', '--find-renames', baseSha, targetSha, '--']
  const tokens = (await git(root, ['diff', '--name-status', '-z', ...flags])).split('\0')
  const files: GitFileChange[] = []
  for (let index = 0; tokens[index];) {
    const status = tokens[index++]!
    const first = tokens[index++]!
    if (/^[RC]/.test(status)) files.push({ status, oldPath: first, path: tokens[index++]! })
    else files.push({ status, path: first })
  }
  const patch = await git(root, ['diff', '--patch', ...flags])
  return { baseSha, targetSha, files, patch }
}

/** 只读本地 Git 对象。返回固定 SHA 与逐 diff 事实；不 checkout、不自动选基线。 */
export async function collectLocalChangeFacts(root: string, input: unknown): Promise<LocalChangeFacts> {
  const comparison = changeComparisonSchema.parse(input)
  const targetSha = await resolveCommit(root, comparison.targetRef)
  const dirty = Boolean(await git(root, ['status', '--porcelain', '-z', '--untracked-files=normal']))
  const facts: LocalChangeFacts = { comparison, targetSha, commits: [], diffs: [], omittedCommitShas: [], omittedRangeBases: [], dirty, capturedAt: new Date().toISOString(), warnings: [] }
  if (dirty) facts.warnings.push('原工作区存在未提交内容；本次仅分析已提交 Git 对象，不包含未提交改动。')
  if (comparison.mode === 'selected_commits') {
    const selected = await Promise.all(comparison.commits.map(ref => resolveCommit(root, ref)))
    if (new Set(selected).size !== selected.length) throw new Error('指定提交重复，请去重后重试')
    const commits = await Promise.all(selected.map(sha => commitFact(root, sha)))
    for (const commit of commits) {
      if (commit.parents.length !== 1) throw new Error('指定提交模式暂不支持根提交或合并提交；请改用明确基线的端点比较')
      await git(root, ['merge-base', '--is-ancestor', commit.sha, targetSha])
    }
    const bases = [...new Set(commits.flatMap(commit => commit.parents))]
    // 最早父提交的祖先集作为范围下界；其他选中提交的父节点不能排除中间未选提交。
    const boundary = (await git(root, ['merge-base', '--octopus', ...bases, targetSha])).trim()
    const ordered = await revisionList(root, [targetSha, `^${boundary}`])
    facts.omittedRangeBases = [boundary]
    facts.omittedCommitShas = ordered.filter(sha => !selected.includes(sha))
    facts.commits = ordered.filter(sha => selected.includes(sha)).map(sha => commits.find(commit => commit.sha === sha)!)
    if (facts.commits.length !== selected.length) throw new Error('无法在目标版本中完整排列指定提交，请改用端点比较')
    let patchBytes = 0
    for (const commit of facts.commits) {
      const diff = await diffFact(root, commit.parents[0]!, commit.sha)
      patchBytes += Buffer.byteLength(diff.patch)
      if (patchBytes > 16 * 1024 * 1024) throw new Error('指定提交 patch 总量超过 16 MiB，请缩小范围；未截断保存')
      facts.diffs.push(diff)
    }
    facts.warnings.push('指定提交分别展示各自 patch，不把它们拼成连续范围；目标版本还包含范围下界之前的历史。')
    if (facts.omittedCommitShas.length) facts.warnings.push(`范围下界至目标版本还有 ${facts.omittedCommitShas.length} 个未选提交；执行环境仍包含这些变更。`)
  } else {
    facts.requestedBaseSha = await resolveCommit(root, comparison.baseRef)
    if (comparison.mode === 'merge_base') {
      const bases = (await git(root, ['merge-base', '--all', facts.requestedBaseSha, targetSha])).trim().split('\n')
      if (bases.length !== 1 || !bases[0]) throw new Error('没有唯一公共基线，请改用端点比较并明确基线 SHA')
      facts.effectiveBaseSha = bases[0]
    } else facts.effectiveBaseSha = facts.requestedBaseSha
    for (const sha of await revisionList(root, [targetSha, `^${facts.effectiveBaseSha}`])) facts.commits.push(await commitFact(root, sha))
    facts.diffs = [await diffFact(root, facts.effectiveBaseSha, targetSha)]
  }
  if (facts.diffs.every(diff => diff.files.length === 0)) facts.warnings.push('无可分析文件差异；不应调用模型虚构风险。')
  return facts
}
