import type { AutomationPlan, CaseExecutionContract } from '@quality-ai/contracts'

// 这里只证明映射完整，不能替代自然语言预期与具体断言含义的人工审核。
export function validateFixedAssertionCoverage(steps:AutomationPlan['steps'],contract:CaseExecutionContract){
  const covered=new Set<number>()
  for(const step of steps){
    if(!step.action.startsWith('expect'))continue
    if(!('assertionIndex' in step)||step.assertionIndex===undefined)throw new Error('固定计划断言缺少契约预期映射，请重新生成计划')
    const expected=contract.expectedAssertions[step.assertionIndex]
    if(expected===undefined)throw new Error('固定计划断言引用了不存在的契约预期')
    if(/高亮|highlight/i.test(expected)&&step.action!=='expectAttribute')throw new Error('高亮预期不能以文本或可见性断言替代，需要明确属性证据')
    covered.add(step.assertionIndex)
  }
  const missing=contract.expectedAssertions.map((_,index)=>index).filter(index=>!covered.has(index))
  if(missing.length)throw new Error(`固定计划遗漏契约预期：${missing.map(index=>`${index+1}. ${contract.expectedAssertions[index]}`).join('；')}`)
}
