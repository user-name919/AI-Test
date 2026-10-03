import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { samples } from './samples'

interface Row {provider:{id:string};success:boolean;error?:string;response?:{output?:string;error?:string;metadata?:{completedStages?:string[]}};gradingResult?:{reason?:string};vars:{payload:string}}
const cell=(value:unknown)=>String(value??'未记录').replace(/\|/g,'\\|').replace(/\r?\n/g,' ')

// 这是错误表现分类，不把校验发现层冒充模型推理或业务根因。
export function failureCategory(row:Row):string {
  if(row.success)return '机器检查通过'
  const error=row.response?.error??row.error
  if(!error)return row.gradingResult?.reason?'评估断言未通过':'原因缺失'
  if(/timeout|超时/i.test(error))return '请求超时'
  try{
    const issues=JSON.parse(error) as Array<{message?:string;path?:Array<string|number>;code?:string}>
    if(Array.isArray(issues)&&issues.length){
      if(issues.every(issue=>issue.path?.includes('dataBindings')&&issue.path.at(-1)==='strategy'&&issue.message==='运行时 DOM 数据必须声明搜索策略'))return '数据绑定缺少运行时策略'
      if(issues.every(issue=>issue.code==='invalid_type'&&issue.path?.includes('dataBindings')&&issue.path.at(-1)==='value'))return '数据绑定取值类型错误'
      return '其他结构校验错误'
    }
  }catch{/* 非结构化错误保留原文，不能猜测为某个输出字段。 */}
  return '其他调用或处理错误'
}

function issueRows(output:Record<string,unknown>|undefined):string[] {
  const result=output?.output as {issues?:Array<{severity?:string;kind?:string;checkedBy?:string;targetId?:string;reason?:string}>}|undefined
  return (result?.issues??[]).map(issue=>`${cell(issue.severity)} / ${cell(issue.kind)} / ${cell(issue.checkedBy)} / ${cell(issue.targetId)}：${cell(issue.reason)}`)
}
export function summarize(rows:Row[]){
  const entries=rows.map(row=>{
    let output:Record<string,unknown>|undefined
    try{output=JSON.parse(row.response?.output??'')}catch{/* Errors are retained as missing output. */}
    return {row,output,input:JSON.parse(row.vars.payload) as {sampleId:string}}
  })
  const modes=new Set(entries.map(entry=>entry.output?.evidenceMode).filter(Boolean))
  const mode=modes.size===1?[...modes][0]:'混合或缺失，不能比较'
  const lines=['# 用例生成评估结果','',`证据类型：${mode}；共 ${rows.length} 项。`,'','机器检查通过不代表设计质量通过。以下不计算语义总分，不把夹具结果推断为真实模型提升。人工期望全部待审核。','', '| 样本 | 旧流程机器通过 | 五阶段机器通过 | Skills 机器通过 | 同输入同模型 | 人工覆盖/预期准确性 |','|---|---|---|---|---|---|']
  for(const sample of samples){
    const subset=entries.filter(entry=>entry.input.sampleId===sample.id)
    const cells=['legacy','pipeline','skills'].map(variant=>{
      const selected=subset.filter(entry=>entry.row.provider.id===`quality-ai-${variant}`)
      return `${selected.filter(entry=>entry.row.success).length}/${selected.length}（期望3）`
    })
    const countsComplete=['legacy','pipeline','skills'].every(variant=>subset.filter(entry=>entry.row.provider.id===`quality-ai-${variant}`).length===3)
    const hashConsistent=countsComplete&&subset.length===9&&subset.every(entry=>typeof entry.output?.inputHash==='string'&&typeof entry.output?.modelConfigHash==='string')&&new Set(subset.map(entry=>entry.output?.inputHash)).size===1&&new Set(subset.map(entry=>entry.output?.modelConfigHash)).size===1
    lines.push(`| ${sample.id} · ${sample.title} | ${cells.join(' | ')} | ${hashConsistent?'一致':'缺失或不一致'} | 待人工评审 |`)
  }
  lines.push('','## 错误表现分类','','分类只依据保存的错误信息，不自动诊断模型为何生成错误，也不证明业务语义质量。','','| 分类 | 旧流程 | 五阶段 | Skills | 合计 |','|---|---|---|---|---|')
  const categories=[...new Set(rows.filter(row=>!row.success).map(failureCategory))]
  for(const category of categories){
    const counts=['legacy','pipeline','skills'].map(variant=>rows.filter(row=>row.provider.id===`quality-ai-${variant}`&&!row.success&&failureCategory(row)===category).length)
    lines.push(`| ${category} | ${counts.join(' | ')} | ${rows.filter(row=>!row.success&&failureCategory(row)===category).length} |`)
  }
  if(!categories.length)lines.push('| 本轮未记录机器错误 | 0 | 0 | 0 | 0 |')
  lines.push('','## 问题与能力边界','')
  for(const {row,input} of entries.filter(entry=>!entry.row.success))lines.push(`- ${input.sampleId} / ${row.provider.id}：${String(row.response?.error??row.error??row.gradingResult?.reason??'失败原因缺失').replace(/\n/g,' ')}`)
  if(entries.every(entry=>entry.row.success))lines.push('- 本轮未触发机器结构断言失败；不能据此得出不存在业务语义错误。')
  lines.push('- 旧生成器没有新流程的文档块引用结构，不能用新流程引用存在率直接冒充旧流程得分。','- 生成审查问题只代表模型/规则建议，人工是否采纳和能否实际执行仍未确定。','- 发布与执行契约一致性由闭环验收证明，不能由未执行的 Promptfoo 输出声称达到 100%。')
  if(mode==='stub')lines.push('- 本地夹具故意仅生成协议合法的通用结果，不覆盖真实语义推理，禁止将此报告作为公司模型效果结论。')
  else lines.push('- 真实模型输出仍需逐项人工复核；机器通过和审查问题数量不能直接证明质量改善，混合或缺失证据不得作为同条件对比。')
  lines.push('','## 逐次产物与问题分层','','次数按每个样本、每个配置的结果出现顺序编号。这里记录发现问题的层，不把审查发现直接当作根因；解析/推理/生成责任需结合原文与阶段产物人工判定。执行层未在本评估中运行。','','| 样本 / 配置 / 次数 | 生成用例数 | 审查问题 | 失败发现层 / 说明 |','|---|---|---|---|')
  const attempts=new Map<string,number>()
  const details:string[]=[]
  for(const {row,input,output} of entries){
    const key=`${input.sampleId} / ${row.provider.id}`
    const attempt=(attempts.get(key)??0)+1
    attempts.set(key,attempt)
    const final=output?.output as {cases?:unknown[]}|undefined
    const legacy=output?.analysis as {requirements?:Array<{testCases?:unknown[]}>}|undefined
    const count=final?.cases?.length??legacy?.requirements?.reduce((sum,item)=>sum+(item.testCases?.length??0),0)??'未记录'
    const issues=issueRows(output)
    const completed=row.response?.metadata?.completedStages
    const failure=row.success?'机器检查通过；非业务验收':row.response?.error??row.error
      ?`${failureCategory(row)}；生成流程/请求失败；已完成阶段：${completed?.join('、')||'未记录'}；具体失败层需核对错误：${row.response?.error??row.error}`
      :`评估断言层：${row.gradingResult?.reason??'原因缺失'}`
    lines.push(`| ${cell(key)} / ${attempt} | ${count} | ${issues.length?`审查层 ${issues.length} 项`:'未记录审查问题（不代表无问题）'} | ${cell(failure)} |`)
    if(issues.length)details.push('',`### ${cell(key)} / ${attempt} 的审查问题`,'',...issues.map(issue=>`- ${issue}`))
  }
  lines.push(...details,'', '## 人工复核候选','')
  for(const sample of samples)lines.push(`### ${sample.title}`,`- 显式材料：${sample.expectations.explicitFacts}`,`- 必须覆盖候选：${sample.expectations.mustCover}`,`- 禁止编造：${sample.expectations.forbidden}`,`- 允许多解：${sample.expectations.alternatives}`,'- 评审人 / 日期 / 逐项结论 / 改善或退化：待填写','')
  return lines.join('\n')
}
if(process.argv[1]&&resolve(process.argv[1])===import.meta.filename){
  const path=process.argv[2]
  if(!path)throw new Error('请提供 Promptfoo 导出的 results.json 路径')
  const file=JSON.parse(readFileSync(path,'utf8'))
  if(!Array.isArray(file.results?.results))throw new Error('不是可识别的 Promptfoo 结果')
  const report=summarize(file.results.results)
  const destination=process.argv[3]
  if(destination)writeFileSync(destination,report+'\n');else console.log(report)
}
