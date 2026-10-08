import type { CaseAsset, ExecutionJob } from '@quality-ai/contracts/cases'

interface RequirementExecutionInput {
  authorizedWriteCaseKeys?: string[]
  analysisId: string
  cases: Array<{caseKey:string;contractFingerprint:string}>
  targetUrl: string
  environmentId: string
  projectId?: string
  automationPlanId?: string
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
  const authorizedWriteCaseIds=(input.authorizedWriteCaseKeys??[]).map(key=>{
    const index=input.cases.findIndex(item=>item.caseKey===key)
    if(index<0)throw new Error('写操作授权包含未选中的用例')
    return cases[index]!.caseId
  })
  const started=await request('/api/execution-jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:input.automationPlanId?'plan':'agent',automationPlanId:input.automationPlanId,targetUrl:input.targetUrl,environmentId:input.environmentId,projectId:input.projectId,cases,authorizedWriteCaseIds})})
  const result=await started.json() as {job?:ExecutionJob;error?:string}
  if(!started.ok||!result.job)throw new Error(result.error??'后台任务启动失败')
  return result.job
}
