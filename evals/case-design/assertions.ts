import { prdAnalysisSchema, caseExecutionContractSchema } from '@quality-ai/contracts'
import type { CaseDesign, DesignRun } from '@quality-ai/contracts/case-design'
import { validateFactEvidence } from '../../api/src/modules/case-design/evidence-validator'

export const assertionsVersion='case-design-checks-v2-deferred-negative'

// Machine checks only; pass never means semantic completeness or human acceptance.
export default function check(output:string){
  try{
    const value=JSON.parse(output)
    const problems:string[]=[]
    if(!['legacy','pipeline','skills'].includes(value.variant))problems.push('未知评估流程')
    if(value.humanReview!=='pending')problems.push('评估不得自动变成人工已审核')
    if(value.variant==='legacy'){
      if(!prdAnalysisSchema.safeParse(value.analysis).success)problems.push('旧流程 schema 不合法')
    }else{
      const design=value.design as CaseDesign
      const stages=value.stages as DesignRun[]
      if(stages.length!==5)problems.push('五阶段未完成')
      if(stages.map(run=>run.stage).join(',')!=='extracting,modeling,planning,generating,checking'||stages.some(run=>run.status!=='completed'))problems.push('阶段顺序或完成状态不合法')
      if(stages.some(run=>run.inputHash!==value.inputHash))problems.push('阶段输入版本不一致')
      const final=stages.at(-1)!
      if(JSON.stringify(value.output)!==JSON.stringify(final.output))problems.push('输出与最终阶段快照不一致')
      for(const issue of validateFactEvidence(final.output.factModel?.consolidatedFacts??[],design.documents))problems.push(`引用：${issue.reason}`)
      if(!final.output.cases?.length)problems.push('没有用例')
      for(const item of final.output.cases??[]){
        if(!caseExecutionContractSchema.safeParse(item.contract).success)problems.push(`契约无效：${item.id}`)
        if(!item.factIds.length||item.factIds.some(id=>!final.output.factModel?.consolidatedFacts.some(fact=>fact.id===id)))problems.push(`缺失或未知事实关联：${item.id}`)
        if(!final.output.scenarios?.some(scenario=>scenario.id===item.scenarioId))problems.push(`未知场景关联：${item.id}`)
        const questions=[...final.output.questions,...final.output.factModel?.conflicts??[]]
        if(item.questionIds.some(id=>!questions.some(question=>question.id===id)))problems.push(`未知问题关联：${item.id}`)
        for(const binding of item.contract.dataBindings){
          if(['full-search','partial-search'].includes(value.sampleId)&&binding.mode!=='runtime_dom')problems.push(`无账号夹具依据却固定搜索值：${item.id}/${binding.id}`)
          if(value.sampleId==='missing'&&(binding.manual?.value==='模考数学一'||binding.fixture?.value==='模考数学一'))problems.push(`将说明示例冒充真实账号数据：${item.id}/${binding.id}`)
          if(value.sampleId==='no-match'&&binding.optionUniverse?.completeness==='complete_local')problems.push(`把远程分页样本冒充完整本地候选：${item.id}/${binding.id}`)
        }
      }
      const expected:Record<string,string>={'full-search':'visible_option_full','partial-search':'visible_option_substring','no-match':'non_matching_option_query'}
      const hasStrategy=final.output.cases?.some(item=>item.contract.dataBindings.some(binding=>binding.strategy===expected[value.sampleId]))
      // 远程候选负例允许明确待准备，不迫使模型生成不存在的账号数据。
      // 这是受阻设计的结构候选，仍须负例场景、空值、解释、不确定项与阻塞审查同时存在。
      const deferredNegative=value.sampleId==='no-match'&&final.output.cases?.some(item=>
        final.output.scenarios?.some(scenario=>scenario.id===item.scenarioId&&scenario.coverage==='negative')
        &&item.contract.uncertainties.some(reason=>reason.trim())
        &&final.output.issues?.some(issue=>issue.targetType==='case'&&issue.targetId===item.id&&issue.severity==='blocking'&&issue.kind==='unverifiable')
        &&item.contract.dataBindings.some(binding=>binding.mode==='manual'&&binding.manual?.value===''&&binding.manual.rationale.trim()&&binding.constraints.mustComeFromCurrentDom===false))
      if(expected[value.sampleId]&&!hasStrategy&&!deferredNegative)problems.push('未观察到样本要求的搜索数据策略或明确受阻的负例数据准备')
    }
    return {pass:problems.length===0,score:problems.length?0:1,reason:problems.length?problems.join('；'):'机器结构检查通过；覆盖、业务准确性、固定值来源仍需人工审核'}
  }catch(error){return {pass:false,score:0,reason:`评估结果结构无法检查：${error instanceof Error?error.message:String(error)}`}}
}
