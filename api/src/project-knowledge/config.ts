import { readFile } from 'node:fs/promises'
import { getRuntimePaths } from '../config/paths'
import { projectConfigFileSchema, type ProjectConfig } from './types'

export async function loadProjectConfigs(configPath = getRuntimePaths().projectConfigPath): Promise<ProjectConfig[]> {
  try {
    const content = await readFile(configPath, 'utf8')
    return projectConfigFileSchema.parse(JSON.parse(content)).projects
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT' && configPath === getRuntimePaths({}).projectConfigPath && !process.env.PROJECTS_CONFIG_PATH) return []
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`项目配置加载失败（${configPath}）：${message}`)
  }
}
