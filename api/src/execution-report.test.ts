import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecutionRecord } from '@quality-ai/contracts'
import { executionMarkdown } from './modules/executions/report'

const base:ExecutionRecord={id:'report',name:'<script> [报告]',targetUrl:'http://localhost',status:'cancelled',startedAt:'now',finishedAt:'now',durationMs:12,steps:[],screenshots:[],caseKeys:[]}

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
