import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 依据入口文件位置而非启动目录，避免从子工作空间启动时创建第二份数据库。
export const workspaceRoot = fileURLToPath(new URL('../', import.meta.url))

export function getRuntimePaths(env: NodeJS.ProcessEnv = process.env) {
  const dataRoot = resolve(workspaceRoot, env.QUALITY_AI_DATA_ROOT ?? 'data')
  return {
    workspaceRoot,
    dataRoot,
    databasePath: resolve(workspaceRoot, env.QUALITY_AI_DATABASE_PATH ?? resolve(dataRoot, 'quality-ai.sqlite')),
    artifactRoot: resolve(dataRoot, 'artifacts'),
    authRoot: resolve(dataRoot, 'auth'),
    projectConfigPath: resolve(workspaceRoot, env.PROJECTS_CONFIG_PATH ?? 'config/projects.local.json'),
  }
}
