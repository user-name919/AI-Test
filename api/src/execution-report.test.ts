import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecutionRecord } from '@quality-ai/contracts'
import { executionMarkdown } from './modules/executions/report'

const base:ExecutionRecord={id:'report',name:'<script> [报告]',targetUrl:'http://localhost',status:'cancelled',startedAt:'now',finishedAt:'now',durationMs:12,steps:[],screenshots:[],caseKeys:[]}

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
