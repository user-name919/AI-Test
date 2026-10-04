import type { CaseExecutionContract, ExecutionCaseSnapshot, ExecutionWriteAuthorization } from '@quality-ai/contracts'

/** Only the server's frozen contracts supply operation descriptions and fingerprints. */
export function captureWriteAuthorizations(snapshots: ExecutionCaseSnapshot[], approvedIds: string[], targetUrl: string): ExecutionWriteAuthorization[] {
  if (new Set(approvedIds).size !== approvedIds.length) throw new Error('业务写操作授权不能重复')
  const required = snapshots.filter(snapshot => snapshot.resolved.contract.writeOperations?.length)
  if (approvedIds.some(id => !required.some(snapshot => snapshot.caseId === id))) throw new Error('业务写操作授权包含未选择或未声明写操作的用例，请重新预览')
  for (const snapshot of required) {
    if (!approvedIds.includes(snapshot.caseId)) throw new Error(`尚未授权业务写操作：${snapshot.resolved.title}。请核对最终口径，在本次执行配置中逐条确认；历史授权不能复用。`)
  }
  const confirmedAt = new Date().toISOString()
  return required.map(snapshot => ({caseId:snapshot.caseId,caseKey:snapshot.resolved.caseKey,
    contractFingerprint:snapshot.resolved.contractFingerprint,operations:[...snapshot.resolved.contract.writeOperations!],targetUrl,confirmedAt}))
}

/** Shared runner boundary also protects legacy direct execution and historical reruns. */
export function requireWriteAuthorization(cases: Array<{caseKey:string;contractFingerprint:string;contract?:CaseExecutionContract}>, targetUrl: string, authorizations: ExecutionWriteAuthorization[] = []) {
  for (const item of cases) {
    const operations = item.contract?.writeOperations
    if (!operations?.length) continue
    const authorization = authorizations.find(value => value.caseKey === item.caseKey && value.contractFingerprint === item.contractFingerprint && value.targetUrl === targetUrl)
    if (!authorization || JSON.stringify(authorization.operations) !== JSON.stringify(operations)) {
      throw new Error(`用例 ${item.caseKey} 的业务写操作缺少本次授权，请返回执行配置核对并确认；不能从历史记录自动授权`)
    }
  }
}
