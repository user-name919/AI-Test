import type { CaseExecutionResult, ExecutionResult } from '@quality-ai/contracts'
import type { ExecutionJob } from '@quality-ai/contracts/cases'

// 只恢复已经落盘的最终结论；在途操作可能已经发生，既不重放，也不推断成功。
export function interruptedExecution(job: ExecutionJob): ExecutionResult {
  const recoveredAt = new Date().toISOString()
  const caseResults: CaseExecutionResult[] = job.snapshots.map(snapshot => {
    const {caseKey,title,contractFingerprint} = snapshot.resolved
    const completed = job.completedCases?.find(item=>item.caseKey===caseKey && item.contractFingerprint===contractFingerprint)
    if(completed) return structuredClone(completed)
    const uncertain = job.activeCase?.caseKey===caseKey || job.completedCases?.some(item=>item.caseKey===caseKey) || (job.completedCases===undefined && job.status!=='queued')
    return {caseKey,title,contractFingerprint,status:uncertain?'infrastructure_failed':'not_run',
      error:uncertain?'服务中断：本用例没有持久化最终结果，可能已产生业务操作，不能推断通过或安全重试':'服务中断前尚未开始本用例',
      startedFromUrl:job.activeCase?.caseKey===caseKey?job.activeCase.startedFromUrl:'',continuation:uncertain?'reused_current_page':'not_started',
      resolvedDataBindings:[],passedAssertions:[],trajectory:[],steps:[],screenshots:[]}
  })
  return {id:job.id,name:`${job.snapshots[0]?.resolved.title??'执行任务'} · 中断恢复报告`,targetUrl:job.targetUrl,mode:job.mode,status:'infrastructure_failed',
    writeAuthorizations:job.writeAuthorizations,
    startedAt:job.createdAt,finishedAt:recoveredAt,durationMs:0,interruptionRecovery:{recoveredAt,timingsUnknown:true},
    error:'服务重启后从逐用例检查点恢复。已完成结论保留；在途用例结论未知，不自动重放。实际执行起止时间及耗时未知。',
    steps:caseResults.flatMap(item=>item.steps),screenshots:caseResults.flatMap(item=>item.screenshots),caseResults,
    sourceProject:job.sourceProject,memoryHints:job.memoryHints,deploymentConfirmation:job.deploymentConfirmation,caseSnapshots:job.snapshots}
}
