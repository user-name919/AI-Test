import { createHash } from 'node:crypto'
import { basename, relative, resolve, sep } from 'node:path'
import { realpathSync, statSync } from 'node:fs'
import type { ExecutionRecord } from '@quality-ai/contracts'
import type { ExecutionArtifact } from '@quality-ai/contracts/cases'
import { getRuntimePaths } from '../../config/paths'

function within(root:string,path:string){const rel=relative(root,path);return !!rel&&!rel.startsWith(`..${sep}`)&&rel!=='..'&&!rel.startsWith(sep)}

// URL 只携带报告登记的附件 ID，客户端路径不能扩大可读取范围。
export function executionArtifacts(execution:ExecutionRecord):Array<ExecutionArtifact & {path?:string}>{
  const root=resolve(getRuntimePaths().artifactRoot,execution.id)
  const registered=new Map<string,{caseKey?:string;kind:ExecutionArtifact['kind'];name?:string}>()
  for(const item of execution.caseResults??[]){
    for(const download of item.downloads??[])registered.set(download.path,{caseKey:item.caseKey,kind:'download',name:download.name})
    for(const path of item.screenshots)registered.set(path,{caseKey:item.caseKey,kind:'screenshot'})
    if(item.tracePath)registered.set(item.tracePath,{caseKey:item.caseKey,kind:'trace'})
  }
  for(const path of execution.screenshots)if(!registered.has(path))registered.set(path,{kind:'screenshot'})
  if(execution.tracePath&&!registered.has(execution.tracePath))registered.set(execution.tracePath,{kind:'trace'})
  return [...registered].flatMap(([stored,info])=>{
    const path=resolve(stored)
    if(!within(root,path)||!path.endsWith(info.kind==='trace'?'.zip':info.kind==='download'?'.download':'.png'))return []
    const id=createHash('sha256').update(relative(root,path)).digest('hex')
    let available=false
    try{available=within(realpathSync(getRuntimePaths().artifactRoot),realpathSync(root))&&within(realpathSync(root),realpathSync(path))&&statSync(path).isFile()}catch{/* 清理或缺失产物仍保留报告中的引用。 */}
    return [{...info,id,name:info.name??basename(path),url:`/api/executions/${execution.id}/artifacts/${id}`,available,path:available?path:undefined}]
  })
}
