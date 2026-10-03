import { randomUUID } from 'node:crypto'
import { createMemorySchema, reviewMemorySchema, type QualityMemory, type MemoryReference } from '@quality-ai/contracts/memories'
import type { SourceProjectSnapshot } from '@quality-ai/contracts'
import { database } from '../../storage/database'
import { getExecutionById } from '../executions/repository'

export function initializeMemories(){
  database.exec('CREATE TABLE IF NOT EXISTS quality_memories (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, project_id TEXT, memory_json TEXT NOT NULL)')
}

export function listMemories(projectId?:string):QualityMemory[]{
  const rows=projectId
    ? database.prepare('SELECT memory_json FROM quality_memories WHERE project_id=? ORDER BY rowid DESC').all(projectId)
    : database.prepare('SELECT memory_json FROM quality_memories ORDER BY rowid DESC').all()
  return rows.map(row=>JSON.parse(String(row.memory_json)) as QualityMemory)
}

// 自动引用只覆盖原页面与已核对的干净源码版本；跨版本适用性需后续明确审核，不能猜测。
export function selectMemoryHints(project:SourceProjectSnapshot|undefined,targetUrl:string):MemoryReference[]{
  if(!project?.commit||project.worktree?.status!=='clean')return []
  initializeMemories()
  return listMemories(project.id).filter(item=>item.status==='adopted'&&item.scope.targetUrl===targetUrl&&item.scope.sourceProject?.commit===project.commit&&item.scope.sourceProject?.worktree?.status==='clean').slice(0,5).map(item=>({
    id:item.id,revision:item.revision,lesson:item.lesson,executionId:item.source.executionId,caseKey:item.source.caseKey,
    projectId:project.id,targetUrl,sourceCommit:project.commit!,
  }))
}

export function createMemory(input:unknown):QualityMemory{
  const request=createMemorySchema.parse(input)
  const execution=getExecutionById(request.executionId)
  if(!execution)throw new Error('来源执行不存在，不能登记无依据的记忆')
  const result=request.caseKey?execution.caseResults?.find(item=>item.caseKey===request.caseKey):undefined
  if(request.caseKey&&!result)throw new Error('来源用例没有逐用例执行结果')
  const memory:QualityMemory={id:randomUUID(),revision:1,status:'candidate',origin:'human_note',lesson:request.lesson,createdAt:new Date().toISOString(),reviews:[],
    source:{executionId:execution.id,caseKey:result?.caseKey,title:result?.title??execution.name,status:result?.status??execution.status,error:result?result.error:execution.error,contractFingerprint:result?.contractFingerprint},
    scope:{projectId:execution.projectId??execution.sourceProject?.id,targetUrl:execution.targetUrl,sourceProject:execution.sourceProject}}
  database.prepare('INSERT INTO quality_memories VALUES (?,?,?,?)').run(memory.id,1,memory.scope.projectId??null,JSON.stringify(memory))
  return memory
}

export function reviewMemory(id:string,input:unknown):QualityMemory{
  const request=reviewMemorySchema.parse(input)
  const row=database.prepare('SELECT memory_json FROM quality_memories WHERE id=?').get(id)
  if(!row)throw new Error('记忆不存在')
  const memory=JSON.parse(String(row.memory_json)) as QualityMemory
  if(memory.revision!==request.expectedRevision)throw new Error('记忆已被更新，请刷新后重新审核')
  memory.revision++
  memory.status=request.status
  memory.reviews.push({revision:memory.revision,status:request.status,reason:request.reason,at:new Date().toISOString()})
  const saved=database.prepare('UPDATE quality_memories SET revision=?,memory_json=? WHERE id=? AND revision=?').run(memory.revision,JSON.stringify(memory),id,request.expectedRevision)
  if(saved.changes!==1)throw new Error('记忆已被更新，请刷新后重新审核')
  return memory
}
