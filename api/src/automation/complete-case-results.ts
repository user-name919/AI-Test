import type { CaseExecutionResult } from '@quality-ai/contracts'

// 仅补充没有开始的用例；不得改写已存在的验证结论或伪造页面/断言证据。
export function completeCaseResults(
  selected: Array<{caseKey:string;title:string;contractFingerprint:string}>,
  executed: CaseExecutionResult[],
  reason: string,
): CaseExecutionResult[] {
  const byKey = new Map(executed.map(result => [result.caseKey,result]))
  return selected.map(item => byKey.get(item.caseKey) ?? {
    ...item,status:'not_run',error:reason,startedFromUrl:'',continuation:'not_started',
    resolvedDataBindings:[],passedAssertions:[],trajectory:[],steps:[],screenshots:[],
  })
}
