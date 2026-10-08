import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecutionRecord } from '@quality-ai/contracts'
import { executionMarkdown } from './modules/executions/report'

const base:ExecutionRecord={id:'report',name:'<script> [报告]',targetUrl:'http://localhost',status:'cancelled',startedAt:'now',finishedAt:'now',durationMs:12,steps:[],screenshots:[],caseKeys:[]}

test('导出保留局部观察的来源与边界，不将旧轨迹推断为整页观察',()=>{
  const record:ExecutionRecord={...base,caseResults:[{caseKey:'case',title:'查询',contractFingerprint:'original',status:'blocked',startedFromUrl:'http://localhost',continuation:'reused_current_page',resolvedDataBindings:[],passedAssertions:[],trajectory:[{iteration:1,snapshotId:'local',observation:{url:'http://localhost',title:'查询',elementCount:1,elements:[],dialogs:[],messages:[],observationScope:{mode:'region',sourceSnapshotId:'previous',sourceElementRef:'<e1>'}},decision:{type:'action',snapshotId:'local',action:{action:'click',elementRef:'e2'},reason:'选择候选'}}],steps:[],screenshots:[]}]}
  const before=JSON.stringify(record)
  const report=executionMarkdown(record,[])
  assert.match(report,/局部观察：来自快照 previous 的区域 &lt;e1&gt;/)
  assert.match(report,/未包含区域外元素，不代表整页或全部业务数据/)
  assert.match(report,/不改变断言自身的作用范围/)
  assert.equal(JSON.stringify(record),before)
  delete record.caseResults![0]!.trajectory[0]!.observation!.observationScope
  const legacy=executionMarkdown(record,[])
  assert.doesNotMatch(legacy,/局部观察|整页观察/)
})

test('恢复时观测失败保留操作原因且不冒充预算耗尽',()=>{
  const record:ExecutionRecord={...base,caseResults:[{caseKey:'case',title:'查询',contractFingerprint:'original',status:'blocked',startedFromUrl:'http://localhost',continuation:'reused_current_page',resolvedDataBindings:[],passedAssertions:[],trajectory:[{iteration:1,snapshotId:'before',decision:{type:'action',snapshotId:'before',action:{action:'click',elementRef:'e1'},reason:'打开查询'},result:{ok:false,code:'technical_action_failed',retryable:true,message:'timeout',durationMs:1,pageChanged:false},recovery:{attempt:1,limit:2,status:'observation_failed',reason:'页面上下文销毁'}}],steps:[],screenshots:[]}]}
  const report=executionMarkdown(record,[])
  assert.match(report,/技术恢复 1\/2：恢复时重新观察页面失败/)
  assert.match(report,/timeout/)
  assert.match(report,/页面上下文销毁/)
  assert.doesNotMatch(report,/恢复预算耗尽/)
})

test('历史报告不从成功步骤推断用例通过率，并转义业务文本',()=>{
  const report=executionMarkdown(base,[])
  assert.ok(report.includes('历史记录未采集逐用例结果'))
  assert.ok(!report.includes('已完成验证通过率'))
  assert.ok(report.includes('&lt;script&gt; \\[报告\\]'))
  assert.ok(!report.includes('<script>'))
})

test('报告保留当时工作区状态，历史缺失不解释为干净',()=>{
  const report=executionMarkdown({...base,sourceProject:{id:'project',branch:'feature/local',commit:'a'.repeat(40),worktree:{status:'dirty',observedAt:'2026-10-04T00:00:00Z'}}},[])
  assert.match(report,/存在本地未提交或未跟踪改动，SHA 不能代表全部读取内容/)
  assert.match(report,/2026-10-04T00:00:00Z/)
  assert.match(report,/不包括 Git 忽略文件/)
  assert.match(executionMarkdown({...base,sourceProject:{id:'old'}},[]),/历史未记录，不推断为干净/)
})

test('未执行报告不生成操作证据、运行数据或成功比例',()=>{
  const record:ExecutionRecord={...base,caseResults:[{caseKey:'0-TC-0',title:'未开始的搜索',contractFingerprint:'original',status:'not_run',startedFromUrl:'',continuation:'not_started',resolvedDataBindings:[],passedAssertions:[],trajectory:[],steps:[],screenshots:[],error:'用户取消'}]}
  const before=JSON.stringify(record)
  const report=executionMarkdown(record,[])
  assert.ok(report.includes('通过 / 选中总数：0 / 1'))
  assert.ok(report.includes('已完成验证通过率：暂无'))
  assert.ok(report.includes('未执行：1'))
  assert.ok(report.includes('没有操作证据'))
  assert.ok(report.includes('未保存该用例的契约快照'))
  assert.equal(JSON.stringify(record),before)
})
