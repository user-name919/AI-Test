import { prdAnalysisSchema, caseExecutionContractSchema } from '@quality-ai/contracts'
import type { CaseDesign, DesignRun } from '@quality-ai/contracts/case-design'
import { validateFactEvidence } from '../../api/src/modules/case-design/evidence-validator'

// Machine checks only; pass never means semantic completeness or human acceptance.
export default function check(output:string){
  try{
    const value=JSON.parse(output)
    const problems:string[]=[]
    if(value.humanReview!=='pending')problems.push('评估不得自动变成人工已审核')
    if(value.variant==='legacy'){
      if(!prdAnalysisSchema.safeParse(value.analysis).success)problems.push('旧流程 schema 不合法')
    }else{
      const design=value.design as CaseDesign
      const stages=value.stages as DesignRun[]
      if(stages.length!==5)problems.push('五阶段未完成')
      if(stages.some(run=>run.inputHash!==value.inputHash))problems.push('阶段输入版本不一致')
      const final=stages.at(-1)!
      for(const issue of validateFactEvidence(final.output.factModel?.consolidatedFacts??[],design.documents))problems.push(`引用：${issue.reason}`)
      if(!final.output.cases?.length)problems.push('没有用例')
      for(const item of final.output.cases??[]){
        if(!caseExecutionContractSchema.safeParse(item.contract).success)problems.push(`契约无效：${item.id}`)
        if(item.factIds.some(id=>!final.output.factModel?.consolidatedFacts.some(fact=>fact.id===id)))problems.push(`未知事实关联：${item.id}`)
      }
      const expected:Record<string,string>={'full-search':'visible_option_full','partial-search':'visible_option_substring','no-match':'non_matching_option_query'}
      if(expected[value.sampleId]&&!final.output.cases?.some(item=>item.contract.dataBindings.some(binding=>binding.strategy===expected[value.sampleId])))problems.push('未观察到样本要求的搜索数据策略')
    }
    return {pass:problems.length===0,score:problems.length?0:1,reason:problems.length?problems.join('；'):'机器结构检查通过；覆盖、业务准确性、固定值来源仍需人工审核'}
  }catch(error){return {pass:false,score:0,reason:`评估结果结构无法检查：${error instanceof Error?error.message:String(error)}`}}
}
