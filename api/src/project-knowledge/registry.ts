import { loadProjectConfigs } from './config'
import { LocalProjectKnowledgeProvider } from './local-project-provider'
import type { ProjectKnowledgeProvider } from './types'

let registryPromise: Promise<Map<string, ProjectKnowledgeProvider>> | undefined

export function getProjectProviderRegistry() {
  registryPromise ??= loadProjectConfigs().then(configs => new Map(
    configs.map(config => [config.id, new LocalProjectKnowledgeProvider(config)]),
  ))
  return registryPromise
}

export async function getProjectProvider(projectId: string) {
  const provider = (await getProjectProviderRegistry()).get(projectId)
  if (!provider) throw new Error(`项目配置不存在：${projectId}`)
  return provider
}

export function resetProjectProviderRegistry() {
  registryPromise = undefined
}
