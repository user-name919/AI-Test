import { z } from 'zod'

export const projectConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  root: z.string().min(1),
  targetOrigins: z.array(z.string().url()).default([]),
  sourceRoots: z.array(z.string().min(1)).min(1).default(['.']),
  includeExtensions: z.array(z.string().regex(/^\.[a-z0-9]+$/i))
    .default(['.vue', '.ts', '.tsx', '.js', '.jsx', '.json']),
  excludeDirectories: z.array(z.string().min(1))
    .default(['node_modules', 'dist', '.git', 'coverage']),
  maxIndexedFiles: z.number().int().positive().max(50_000).default(20_000),
  maxSearchResults: z.number().int().positive().max(50).default(10),
  maxInspectFiles: z.number().int().positive().max(10).default(5),
  maxContextCharacters: z.number().int().positive().max(200_000).default(60_000),
})

export const projectConfigFileSchema = z.object({
  projects: z.array(projectConfigSchema),
}).superRefine((value, context) => {
  const ids = new Set<string>()
  for (const project of value.projects) {
    if (ids.has(project.id)) {
      context.addIssue({ code: 'custom', message: `项目 ID 重复：${project.id}` })
    }
    ids.add(project.id)
  }
})

export type ProjectConfig = z.infer<typeof projectConfigSchema>

export interface ProjectInfo {
  id: string
  name: string
  configuredRoot: string
  resolvedRoot?: string
  connected: boolean
  targetOrigins: string[]
  branch?: string
  commit?: string
  error?: string
}

export interface RouteKnowledge {
  url: string
  pathname: string
  routePath: string
  routeFile: string
  componentFile?: string
  confidence: 'exact' | 'pattern' | 'partial'
}

export type SourceScope = 'route' | 'page' | 'component' | 'api'

export interface SourceMatch {
  path: string
  line: number
  column: number
  preview: string
}

export interface SourceContextFile {
  path: string
  content: string
  truncated: boolean
}

export interface SourceContext {
  projectId: string
  reason: string
  files: SourceContextFile[]
  totalCharacters: number
}

export interface ProjectKnowledgeProvider {
  getProjectInfo(): Promise<ProjectInfo>
  resolveRoute(input: { url: string }): Promise<RouteKnowledge | null>
  searchSource(input: { query: string; scopes?: SourceScope[]; limit?: number }): Promise<SourceMatch[]>
  inspectFiles(input: { paths: string[]; reason: string }): Promise<SourceContext>
}
