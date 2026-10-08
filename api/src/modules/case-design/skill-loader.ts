import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { DesignRun } from '@quality-ai/contracts/case-design'
import { workspaceRoot } from '../../config/paths'

const root = resolve(workspaceRoot,'api/skills')
const catalogSchema = z.array(z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/), version: z.string().min(1),
  stages: z.array(z.enum(['extracting','modeling','planning','generating','checking'])),
  resources: z.array(z.string().min(1)).min(1),
}))
// 启动只读取清单，不读取全部技能正文。
export const designSkillCatalog = catalogSchema.parse(JSON.parse(readFileSync(resolve(root,'catalog.json'),'utf8')))
export interface LoadedDesignSkill { id: string; version: string; hash: string; content: string }
export function loadStageSkills(stage: DesignRun['stage'], enabled = true, skillRoot = root): LoadedDesignSkill[] {
  if (!enabled) return []
  return designSkillCatalog.filter(skill=>skill.stages.includes(stage)).map(skill=> {
    const directory = realpathSync(resolve(skillRoot,skill.id))
    const rootRelative = relative(realpathSync(skillRoot),directory)
    if (rootRelative.startsWith('..') || isAbsolute(rootRelative)) throw new Error('技能目录越界')
    const parts = skill.resources.map(resource=> {
      const path = realpathSync(resolve(directory,resource))
      const child = relative(directory,path)
      if (child.startsWith('..') || isAbsolute(child) || !path.endsWith('.md')) throw new Error('技能引用必须为技能目录内 Markdown 文件')
      const content = readFileSync(path,'utf8')
      if (content.length > 32000) throw new Error('技能资源超过长度上限')
      return `文件：${resource}\n${content}`
    })
    const content = parts.join('\n\n')
    return { id:skill.id,version:skill.version,hash:createHash('sha256').update(content).digest('hex'),content }
  })
}
