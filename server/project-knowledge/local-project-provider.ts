import { execFile } from 'node:child_process'
import { getRuntimePaths } from '../runtime-paths'
import { realpath, readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  ProjectConfig,
  ProjectInfo,
  ProjectKnowledgeProvider,
  RouteKnowledge,
  SourceContext,
  SourceMatch,
  SourceScope,
} from './types'

const execFileAsync = promisify(execFile)
const maxSourceFileBytes = 1024 * 1024

function isInside(parent: string, child: string) {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function normalizeRoutePath(path: string) {
  if (!path) return '/'
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`
  const withoutTrailingSlash = withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, '') : withLeadingSlash
  return withoutTrailingSlash || '/'
}

function matchRoute(routePath: string, pathname: string): RouteKnowledge['confidence'] | null {
  const normalizedRoute = normalizeRoutePath(routePath)
  const normalizedPathname = normalizeRoutePath(pathname)
  if (normalizedRoute === normalizedPathname) return 'exact'
  if (routePath.startsWith('/')) {
    const pattern = normalizedRoute
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:([A-Za-z0-9_]+)/g, '[^/]+')
      .replace(/\\\*+/g, '.*')
    if (new RegExp(`^${pattern}$`).test(normalizedPathname)) return 'pattern'
    if (normalizedRoute !== '/' && new RegExp(`${pattern}$`).test(normalizedPathname)) return 'partial'
  }
  if (!routePath.startsWith('/') && normalizedPathname.endsWith(normalizeRoutePath(routePath))) return 'partial'
  return null
}

function scopeMatches(relativePath: string, scopes: SourceScope[] | undefined) {
  if (!scopes?.length) return true
  const path = relativePath.toLowerCase()
  return scopes.some(scope => {
    if (scope === 'route') return path.includes('/router/') || /(^|\/)routes?\.[cm]?[jt]s$/.test(path)
    if (scope === 'page') return path.includes('/views/') || path.includes('/pages/')
    if (scope === 'component') return path.includes('/components/') || path.endsWith('.vue')
    return path.includes('/api/') || path.includes('/services/') || path.includes('/request/')
  })
}

function fuzzyChineseScore(query: string, candidate: string) {
  const queryCharacters = query.match(/\p{Script=Han}/gu) ?? []
  if (queryCharacters.length < 4) return 0
  const candidateCharacters = candidate.match(/\p{Script=Han}/gu) ?? []
  const queryPairs = new Set(queryCharacters.slice(0, -1).map((character, index) => character + queryCharacters[index + 1]))
  const candidatePairs = new Set(candidateCharacters.slice(0, -1).map((character, index) => character + candidateCharacters[index + 1]))
  const matchedPairs = [...queryPairs].filter(pair => candidatePairs.has(pair)).length
  return matchedPairs >= 3 ? matchedPairs / queryPairs.size : 0
}

export class LocalProjectKnowledgeProvider implements ProjectKnowledgeProvider {
  private resolvedRoot?: string
  private sourceRootPaths?: string[]
  private indexedFiles?: string[]

  constructor(private readonly config: ProjectConfig, private readonly workspaceRoot = getRuntimePaths().workspaceRoot) {}

  private async getRoot() {
    if (this.resolvedRoot) return this.resolvedRoot
    const configuredRoot = resolve(this.workspaceRoot, this.config.root)
    const root = await realpath(configuredRoot)
    const rootStat = await stat(root)
    if (!rootStat.isDirectory()) throw new Error(`项目根路径不是目录：${this.config.root}`)
    this.resolvedRoot = root
    return root
  }

  private async getSourceRoots() {
    if (this.sourceRootPaths) return this.sourceRootPaths
    const root = await this.getRoot()
    const roots = await Promise.all(this.config.sourceRoots.map(async sourceRoot => {
      if (isAbsolute(sourceRoot)) throw new Error(`sourceRoots 只允许相对路径：${sourceRoot}`)
      const candidate = await realpath(resolve(root, sourceRoot))
      if (!isInside(root, candidate)) throw new Error(`源码目录越过项目根路径：${sourceRoot}`)
      const candidateStat = await stat(candidate)
      if (!candidateStat.isDirectory()) throw new Error(`源码路径不是目录：${sourceRoot}`)
      return candidate
    }))
    this.sourceRootPaths = roots
    return roots
  }

  private isExcluded(path: string) {
    const segments = path.split(sep)
    return segments.some(segment => this.config.excludeDirectories.includes(segment))
  }

  private async getIndexedFiles() {
    if (this.indexedFiles) return this.indexedFiles
    const root = await this.getRoot()
    const sourceRoots = await this.getSourceRoots()
    const files: string[] = []
    const visit = async (directory: string): Promise<void> => {
      if (this.isExcluded(relative(root, directory))) return
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        const path = resolve(directory, entry.name)
        if (entry.isDirectory()) {
          if (!this.config.excludeDirectories.includes(entry.name)) await visit(path)
          continue
        }
        if (!entry.isFile() || !this.config.includeExtensions.includes(extname(entry.name).toLowerCase())) continue
        files.push(path)
        if (files.length > this.config.maxIndexedFiles) {
          throw new Error(`项目文件超过索引上限 ${this.config.maxIndexedFiles}，请缩小 sourceRoots`)
        }
      }
    }
    for (const sourceRoot of sourceRoots) await visit(sourceRoot)
    this.indexedFiles = files
    return files
  }

  private async resolveReadableFile(inputPath: string) {
    if (isAbsolute(inputPath)) throw new Error(`只允许项目内相对路径：${inputPath}`)
    const root = await this.getRoot()
    const sourceRoots = await this.getSourceRoots()
    const candidate = await realpath(resolve(root, inputPath))
    if (!sourceRoots.some(sourceRoot => isInside(sourceRoot, candidate))) throw new Error(`文件不在允许的源码目录：${inputPath}`)
    if (this.isExcluded(relative(root, candidate))) throw new Error(`文件位于排除目录：${inputPath}`)
    const fileStat = await stat(candidate)
    if (!fileStat.isFile()) throw new Error(`路径不是文件：${inputPath}`)
    if (!this.config.includeExtensions.includes(extname(candidate).toLowerCase())) throw new Error(`文件类型不允许读取：${inputPath}`)
    if (fileStat.size > maxSourceFileBytes) throw new Error(`文件超过 1MB，拒绝读取：${inputPath}`)
    return candidate
  }

  async getProjectInfo(): Promise<ProjectInfo> {
    const configuredRoot = resolve(this.workspaceRoot, this.config.root)
    try {
      const root = await this.getRoot()
      await this.getSourceRoots()
      const git = async (...args: string[]) => {
        try {
          return (await execFileAsync('git', ['-C', root, ...args], { timeout: 3_000 })).stdout.trim()
        } catch {
          return undefined
        }
      }
      return {
        id: this.config.id,
        name: this.config.name,
        configuredRoot,
        resolvedRoot: root,
        connected: true,
        targetOrigins: this.config.targetOrigins.map(value => new URL(value).origin),
        branch: await git('branch', '--show-current'),
        commit: await git('rev-parse', 'HEAD'),
      }
    } catch (error) {
      return {
        id: this.config.id,
        name: this.config.name,
        configuredRoot,
        connected: false,
        targetOrigins: this.config.targetOrigins,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async resolveRoute(input: { url: string }): Promise<RouteKnowledge | null> {
    const url = new URL(input.url)
    const allowedOrigins = this.config.targetOrigins.map(value => new URL(value).origin)
    if (allowedOrigins.length && !allowedOrigins.includes(url.origin)) throw new Error(`URL Origin 未配置到项目：${url.origin}`)
    const root = await this.getRoot()
    const files = (await this.getIndexedFiles()).filter(file => {
      const path = relative(root, file).replaceAll('\\', '/')
      return path.includes('/router/') || /(^|\/)routes?\.[cm]?[jt]s$/.test(path)
    })
    const matches: Array<RouteKnowledge & { score: number }> = []
    for (const file of files) {
      const content = await readFile(file, 'utf8')
      const routePattern = /\bpath\s*:\s*(['"`])([^'"`]+)\1/g
      for (const match of content.matchAll(routePattern)) {
        const confidence = matchRoute(match[2], url.pathname)
        if (!confidence || match.index === undefined) continue
        const nextPath = content.slice(match.index + match[0].length).search(/\bpath\s*:/)
        const blockEnd = nextPath === -1 ? match.index + 1_500 : match.index + match[0].length + nextPath
        const block = content.slice(match.index, Math.min(blockEnd, match.index + 1_500))
        const componentImport = block.match(/component\s*:\s*\(\)\s*=>\s*import\(\s*(?:\/\*[\s\S]*?\*\/\s*)?['"]([^'"]+)['"]\s*\)/)?.[1]
        const routeFile = relative(root, file).replaceAll('\\', '/')
        matches.push({
          url: input.url,
          pathname: url.pathname,
          routePath: match[2],
          routeFile,
          componentFile: componentImport ? this.resolveComponentPath(file, componentImport, root) : undefined,
          confidence,
          score: confidence === 'exact' ? 3 : confidence === 'pattern' ? 2 : 1,
        })
      }
    }
    const best = matches.sort((left, right) => right.score - left.score || right.routePath.length - left.routePath.length)[0]
    if (!best) return null
    return {
      url: best.url,
      pathname: best.pathname,
      routePath: best.routePath,
      routeFile: best.routeFile,
      componentFile: best.componentFile,
      confidence: best.confidence,
    }
  }

  private resolveComponentPath(routeFile: string, importPath: string, root: string) {
    let candidate: string
    if (importPath.startsWith('@/')) {
      let directory = dirname(routeFile)
      while (directory !== root && basename(directory) !== 'src') directory = dirname(directory)
      candidate = resolve(directory, importPath.slice(2))
    } else if (importPath.startsWith('.')) {
      candidate = resolve(dirname(routeFile), importPath)
    } else {
      return importPath
    }
    return relative(root, candidate).replaceAll('\\', '/')
  }

  async searchSource(input: { query: string; scopes?: SourceScope[]; limit?: number }): Promise<SourceMatch[]> {
    const query = input.query.trim()
    if (query.length < 2) throw new Error('源码搜索词至少需要 2 个字符')
    const root = await this.getRoot()
    const requestedLimit = Number.isInteger(input.limit) && (input.limit ?? 0) > 0
      ? input.limit as number
      : this.config.maxSearchResults
    const configuredLimit = Math.min(requestedLimit, this.config.maxSearchResults)
    const files = (await this.getIndexedFiles()).filter(file => scopeMatches(relative(root, file).replaceAll('\\', '/'), input.scopes))
    const lowerQuery = query.toLocaleLowerCase()
    const results: SourceMatch[] = []
    const fuzzyResults: Array<SourceMatch & { score: number }> = []
    for (const file of files) {
      const fileStat = await stat(file)
      if (fileStat.size > maxSourceFileBytes) continue
      const lines = (await readFile(file, 'utf8')).split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const column = lines[index].toLocaleLowerCase().indexOf(lowerQuery)
        const match = {
          path: relative(root, file).replaceAll('\\', '/'),
          line: index + 1,
          column: column + 1,
          preview: lines[index].trim().slice(0, 300),
        }
        if (column !== -1) {
          results.push(match)
          if (results.length >= configuredLimit) return results
          continue
        }
        const score = fuzzyChineseScore(query, lines[index])
        if (score >= 0.5) fuzzyResults.push({ ...match, column: Math.max(lines[index].indexOf(query[0]), 0) + 1, score })
      }
    }
    if (results.length) return results
    return fuzzyResults
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.line - right.line)
      .slice(0, configuredLimit)
      .map(match => ({ path: match.path, line: match.line, column: match.column, preview: match.preview }))
  }

  async inspectFiles(input: { paths: string[]; reason: string }): Promise<SourceContext> {
    const paths = [...new Set(input.paths)]
    if (!input.reason.trim()) throw new Error('读取源码时必须说明原因')
    if (!paths.length) throw new Error('至少需要一个源码文件')
    if (paths.length > this.config.maxInspectFiles) throw new Error(`单次最多读取 ${this.config.maxInspectFiles} 个文件`)
    const root = await this.getRoot()
    let remaining = this.config.maxContextCharacters
    const files = []
    for (const path of paths) {
      const file = await this.resolveReadableFile(path)
      const content = await readFile(file, 'utf8')
      const selected = content.slice(0, Math.max(remaining, 0))
      files.push({ path: relative(root, file).replaceAll('\\', '/'), content: selected, truncated: selected.length < content.length })
      remaining -= selected.length
      if (remaining <= 0) break
    }
    return {
      projectId: this.config.id,
      reason: input.reason,
      files,
      totalCharacters: files.reduce((total, file) => total + file.content.length, 0),
    }
  }
}
