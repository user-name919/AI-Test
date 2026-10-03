import assert from 'node:assert/strict'
import test from 'node:test'
import type { CaseDesign, DesignRun } from '@quality-ai/contracts/case-design'
import { checkDesignRules } from './quality-checker'

test('规则检查分别记录缺失依据、未覆盖、负例前置与重复，不改变草稿', () => {
  const design: CaseDesign = { id:'design', name:'合成设计', revision:1, inputHash:'hash', documents:[], createdAt:'now', updatedAt:'now' }
  const run: DesignRun = {
    id:'run', designId:'design', attempt:1, stage:'checking', status:'running', inputRevision:1, inputHash:'hash', model:'fixture', modelConfigHash:'hash', protocol:'openai-responses', promptVersion:'test', skills:[], createdAt:'now', updatedAt:'now', statistics:{calls:0,inputCharacters:0,outputCharacters:0},
    output: {
      facts:[], questions:[], processedBlockIds:[], unprocessedBlockIds:['unread'],
      factModel:{consolidatedFacts:[{id:'f1',sourceFactIds:['raw'],statement:'支持搜索',kind:'explicit',evidence:[],relatedQuestionIds:[]},{id:'f2',sourceFactIds:['raw2'],statement:'支持导出',kind:'inferred',evidence:[],relatedQuestionIds:[]}],conflicts:[]},
      scenarios:[{id:'s1',factIds:['f1'],questionIds:[],title:'搜索',testIntent:'验证搜索',coverage:'negative',requiresReview:true},{id:'s2',factIds:['f2'],questionIds:[],title:'导出',testIntent:'验证导出',coverage:'positive',requiresReview:true}],
      cases:[{id:'c1',scenarioId:'s1',factIds:['f1'],questionIds:[],title:'负例',verification:'browser',verificationReason:'浏览器观察',requiresReview:true,contract:{objective:'验证空结果',preconditions:[],steps:['输入负例'],expectedAssertions:['出现空态'],dataBindings:[{id:'data',label:'负例词',targetHint:'搜索框',businessIntent:'无匹配',mode:'runtime_dom',strategy:'non_matching_option_query',constraints:{mustComeFromCurrentDom:true}}],forbiddenBehaviors:[],uncertainties:[]}}],
    },
  }
  run.output.cases!.push({...structuredClone(run.output.cases![0]),id:'c2'})
  const original=JSON.stringify(run.output)
  const issues=checkDesignRules(design,run)
  assert.ok(issues.some(issue=>issue.targetId==='f1' && issue.kind==='missing_evidence'))
  assert.ok(issues.some(issue=>issue.targetId==='f2' && issue.kind==='missing_coverage'))
  assert.ok(issues.some(issue=>issue.targetId==='s2' && issue.kind==='missing_coverage'))
  assert.ok(issues.some(issue=>issue.targetId==='c1' && issue.kind==='unverifiable' && issue.severity==='blocking'))
  assert.ok(issues.some(issue=>issue.targetId==='c2' && issue.kind==='duplicate' && issue.severity==='warning'))
  assert.ok(issues.every(issue=>issue.checkedBy==='rule'))
  assert.equal(JSON.stringify(run.output),original)
})
