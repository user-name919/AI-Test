import assert from 'node:assert/strict'
import test from 'node:test'
import { summarize, failureCategory } from './report'

test('失败元数据可验证比较条件，但不能将失败计为通过或补造旧记录',()=>{
  const rows=['legacy','pipeline','skills'].flatMap(variant=>Array.from({length:3},()=>({provider:{id:`quality-ai-${variant}`},success:false,response:{error:'timeout',metadata:{failedStage:'generating',provenance:{evidenceMode:'stub',inputHash:'i',modelConfigHash:'m'}}},vars:{payload:JSON.stringify({sampleId:'full-search'})}})))
  assert.match(summarize(rows),/0\/3（期望3） \| 0\/3（期望3） \| 0\/3（期望3） \| 一致/)
  assert.match(summarize(rows),/失败时所在阶段：generating/)
  rows[0].response.metadata.provenance.inputHash='different'
  assert.match(summarize(rows),/缺失或不一致/)
  const legacy={provider:{id:'quality-ai-legacy'},success:false,error:'timeout',vars:{payload:JSON.stringify({sampleId:'full-search'})}}
  assert.match(summarize([...rows,legacy]),/证据类型：混合或缺失/)
})

test('报告明确区别机器通过与人工评审，不将缺失运行视为可比',()=>{
  const row={provider:{id:'quality-ai-legacy'},success:true,response:{output:JSON.stringify({evidenceMode:'stub',inputHash:'i',modelConfigHash:'m'})},vars:{payload:JSON.stringify({sampleId:'full-search'})}}
  const report=summarize([row])
  assert.match(report,/证据类型：stub/)
  assert.match(report,/1\/1（期望3）/)
  assert.match(report,/缺失或不一致/)
  assert.match(report,/待人工评审/)
  assert.match(report,/不能据此得出不存在业务语义错误/)
  assert.match(summarize(Array.from({length:9},()=>row)),/缺失或不一致/)
})
test('报告完整比较需要三种配置各三次，失败不能隐藏',()=>{
  const rows=['legacy','pipeline','skills'].flatMap(variant=>Array.from({length:3},()=>({provider:{id:`quality-ai-${variant}`},success:true,response:{output:JSON.stringify({evidenceMode:'stub',inputHash:'i',modelConfigHash:'m'})},vars:{payload:JSON.stringify({sampleId:'full-search'})}})))
  assert.match(summarize(rows),/3\/3（期望3） \| 3\/3（期望3） \| 3\/3（期望3） \| 一致/)
  rows[0].success=false
  rows[0].response.output='invalid'
  const report=summarize(rows)
  assert.match(report,/2\/3（期望3）/)
  assert.match(report,/full-search \/ quality-ai-legacy：失败原因缺失/)
})

test('真实模型的机器通过仍展示阻塞审查项和次数，不误标为夹具或执行成功',()=>{
  const row={provider:{id:'quality-ai-skills'},success:true,response:{output:JSON.stringify({evidenceMode:'real-model',output:{cases:[{},{}],issues:[{severity:'blocking',kind:'unverifiable',checkedBy:'rule',targetId:'c1',reason:'缺少高亮证据 | 需审核\n不是产品故障'}]}})},vars:{payload:JSON.stringify({sampleId:'full-search'})}}
  const report=summarize([row,row])
  assert.match(report,/quality-ai-skills \/ 2 \| 2 \| 审查层 1 项/)
  assert.match(report,/blocking \/ unverifiable \/ rule \/ c1/)
  assert.match(report,/缺少高亮证据 \\\| 需审核 不是产品故障/)
  assert.match(report,/执行层未在本评估中运行/)
  assert.doesNotMatch(report,/本地夹具故意/)
})

test('请求失败保留已完成阶段，断言失败不冒充模型失败',()=>{
  const vars={payload:JSON.stringify({sampleId:'full-search'})}
  const report=summarize([
    {provider:{id:'quality-ai-pipeline'},success:false,vars,response:{error:'请求超时',metadata:{completedStages:['extracting','modeling']}}},
    {provider:{id:'quality-ai-skills'},success:false,vars,gradingResult:{reason:'引用不存在'}},
  ])
  assert.match(report,/已完成阶段：extracting、modeling/)
  assert.match(report,/评估断言层：引用不存在/)
  assert.match(report,/具体失败层需核对错误/)
})

test('真实矩阵错误按保存的表现分类，兼容顶层错误且不把失败计为通过',()=>{
  const base={provider:{id:'quality-ai-pipeline'},success:false,vars:{payload:JSON.stringify({sampleId:'full-search'})}}
  const strategy={...base,error:JSON.stringify([{code:'custom',path:['cases',0,'contract','dataBindings',0,'strategy'],message:'运行时 DOM 数据必须声明搜索策略'}])}
  const value={...base,response:{error:JSON.stringify([{code:'invalid_type',path:['cases',0,'contract','dataBindings',0,'manual','value'],message:'expected string'}])}}
  const timeout={...base,provider:{id:'quality-ai-skills'},response:{error:'The operation was aborted due to timeout'}}
  assert.equal(failureCategory(strategy),'数据绑定缺少运行时策略')
  assert.equal(failureCategory(value),'数据绑定取值类型错误')
  const report=summarize([strategy,value,timeout])
  assert.match(report,/数据绑定缺少运行时策略 \| 0 \| 1 \| 0 \| 1/)
  assert.match(report,/请求超时 \| 0 \| 0 \| 1 \| 1/)
  assert.match(report,/0\/2（期望3）/)
  assert.match(report,/运行时 DOM 数据必须声明搜索策略/)
  assert.equal(failureCategory({...base,error:'未知错误'}),'其他调用或处理错误')
  assert.equal(failureCategory({...base,success:true}),'机器检查通过')
})
