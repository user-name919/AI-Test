import type { CaseAsset, ExecutionJob } from '@quality-ai/contracts/cases'

interface RequirementExecutionInput {
  analysisId: string
  cases: Array<{caseKey:string;contractFingerprint:string}>
  targetUrl: string
  environmentId: string
  projectId: string
}

/** 将页面已展示的旧用例键转换为稳定资产身份，不静默接受新的执行口径。 */
export async function startRequirementExecution(input:RequirementExecutionInput,request:typeof fetch=fetch):Promise<ExecutionJob>{
  const response=await request(`/api/cases?sourceType=requirement&sourceId=${encodeURIComponent(input.analysisId)}`)
  const payload=await response.json() as {cases?:CaseAsset[];error?:string}
  if(!response.ok||!payload.cases)throw new Error(payload.error??'用例资产读取失败')
  const cases=input.cases.map(expected=>{
    const asset=payload.cases!.find(item=>item.source.type==='requirement'&&item.source.analysisId===input.analysisId&&item.source.caseKey===expected.caseKey)
    if(!asset||asset.resolved.contractFingerprint!==expected.contractFingerprint)throw new Error('用例口径已变化，请重新读取并核对完整用例后再执行')
    return {caseId:asset.id,revision:asset.revision,contractFingerprint:expected.contractFingerprint}
  })
  const started=await request('/api/execution-jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'agent',targetUrl:input.targetUrl,environmentId:input.environmentId,projectId:input.projectId,cases})})
  const result=await started.json() as {job?:ExecutionJob;error?:string}
  if(!started.ok||!result.job)throw new Error(result.error??'后台任务启动失败')
  return result.job
}
