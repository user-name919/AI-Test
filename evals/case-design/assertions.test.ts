import test from 'node:test'
import assert from 'node:assert/strict'
import check from './assertions'
import type { DesignRun, CaseDesign } from '@quality-ai/contracts/case-design'
import { createEvidenceDocuments } from '../../api/src/modules/case-design/documents'

function fixture(){
  const documents=createEvidenceDocuments([{fileName:'synthetic.md',role:'prd',content:'按当前账号实际选项的部分关键词搜索。'}])
  const design:CaseDesign={id:'d',name:'合成',revision:1,inputHash:'hash',documents,createdAt:'now',updatedAt:'now'}
  const run:DesignRun={id:'r',designId:'d',attempt:1,stage:'checking',status:'completed',inputRevision:1,inputHash:'hash',model:'fixture',modelConfigHash:'hash',protocol:'fixture',promptVersion:'fixture',skills:[],createdAt:'now',updatedAt:'now',statistics:{calls:0,inputCharacters:0,outputCharacters:0},output:{facts:[],questions:[],processedBlockIds:[],unprocessedBlockIds:[],factModel:{consolidatedFacts:[{id:'f',statement:'部分搜索',kind:'explicit',relatedQuestionIds:[],sourceFactIds:['raw'],evidence:[{documentId:documents[0].id,blockId:documents[0].blocks[0].id,quote:documents[0].blocks[0].text}]}],conflicts:[]},scenarios:[{id:'s',title:'部分搜索',testIntent:'匹配',factIds:['f'],questionIds:[],coverage:'positive',requiresReview:false}],cases:[{id:'c',title:'搜索',scenarioId:'s',factIds:['f'],questionIds:[],requiresReview:true,verification:'browser',verificationReason:'页面',contract:{objective:'搜索',preconditions:[],steps:['输入部分词'],expectedAssertions:['来源项存在'],forbiddenBehaviors:[],uncertainties:[],dataBindings:[{id:'b',label:'搜索',mode:'runtime_dom',strategy:'visible_option_substring',targetHint:'搜索框',businessIntent:'部分搜索',constraints:{mustComeFromCurrentDom:true,mustBePartialOfSource:true}}]}}]}}
  return {variant:'pipeline',humanReview:'pending',sampleId:'partial-search',inputHash:'hash',design,stages:(['extracting','modeling','planning','generating','checking'] as const).map(stage=>({...structuredClone(run),stage})),output:run.output}
}
test('合法夹具结构通过，但结果明确不等于人工审核',()=>{const result=check(JSON.stringify(fixture()));assert.equal(result.pass,true);assert.match(result.reason,/仍需人工审核/)})
test('分页无匹配允许明确待准备，但不能把缺失数据或其他场景冒充可用负例',()=>{
  const value=fixture();value.sampleId='no-match'
  const item=value.output.cases![0]!
  item.contract.dataBindings=[{id:'pending',label:'无匹配搜索词',mode:'manual',targetHint:'搜索框',businessIntent:'负例',manual:{value:'',rationale:'服务端范围未知，需人工准备并核实无匹配搜索词'},constraints:{mustComeFromCurrentDom:false}}]
  item.contract.uncertainties=['待准备服务端无匹配数据及证明']
  value.output.scenarios![0]!.coverage='negative'
  value.output.issues=[{id:'blocked',targetType:'case',targetId:item.id,kind:'unverifiable',severity:'blocking',reason:'缺少测试数据，不可发布',evidence:[],checkedBy:'rule'}]
  const sync=(input:typeof value)=>{input.stages[4]!.output=structuredClone(input.output);return check(JSON.stringify(input))}
  assert.equal(sync(value).pass,true)
  for(const attack of [
    (v:typeof value)=>{v.output.cases![0]!.contract.uncertainties=[]},
    (v:typeof value)=>{v.output.issues=[]},
    (v:typeof value)=>{v.output.issues![0]!.targetId='another-case'},
    (v:typeof value)=>{v.output.issues![0]!.severity='warning'},
    (v:typeof value)=>{v.output.scenarios![0]!.coverage='positive'},
    (v:typeof value)=>{v.output.cases![0]!.contract.dataBindings[0]!.manual!.value='猜测不存在的记录'},
    (v:typeof value)=>{v.output.cases![0]!.contract.dataBindings[0]!.manual!.rationale=''},
    (v:typeof value)=>{v.output.cases![0]!.contract.dataBindings=[]},
  ]){const changed=structuredClone(value);attack(changed);assert.equal(sync(changed).pass,false)}
  value.sampleId='partial-search';assert.equal(sync(value).pass,false,'正向搜索仍需来自当前DOM，不能用此例外绕过')
})
test('故意伪造引用、固定值、策略、版本及关联的反例全部拒绝',()=>{
  const attacks:Array<(value:ReturnType<typeof fixture>)=>void>=[
    value=>{value.output.factModel!.consolidatedFacts[0].evidence[0].quote='凭空编造依据'},
    value=>{value.output.factModel!.consolidatedFacts[0].evidence[0].blockId='unknown'},
    value=>{value.output.cases![0].factIds=[]},
    value=>{value.output.cases![0].scenarioId='unknown'},
    value=>{value.output.cases![0].questionIds=['unknown']},
    value=>{value.output.cases![0].contract.expectedAssertions=[]},
    value=>{value.output.cases![0].contract.dataBindings[0]={id:'fixed',label:'猜测账号记录',mode:'fixture',targetHint:'搜索框',businessIntent:'搜索',fixture:{value:'并不存在的账号记录',evidence:'模型自称已确认'},constraints:{mustComeFromCurrentDom:false}}},
    value=>{const binding=value.output.cases![0].contract.dataBindings[0];binding.strategy='visible_option_full';binding.constraints.mustBePartialOfSource=false},
    value=>{value.stages[0].inputHash='different'},
    value=>{value.stages[0].status='failed'},
    value=>{value.humanReview='approved'},
  ]
  for(const attack of attacks){const value=fixture();attack(value);value.stages[4].output=structuredClone(value.output);assert.equal(check(JSON.stringify(value)).pass,false)}
})
test('示例账号数据及远程候选负例不能冒充已验证夹具',()=>{
  const value=fixture();value.sampleId='missing'
  value.output.cases![0].contract.dataBindings[0]={id:'b',label:'示例值',mode:'manual',targetHint:'搜索框',businessIntent:'搜索',manual:{value:'模考数学一',rationale:'文档示例'},constraints:{mustComeFromCurrentDom:false}}
  value.stages[4].output=structuredClone(value.output)
  assert.equal(check(JSON.stringify(value)).pass,false)
  value.sampleId='no-match'
  value.output.cases![0].contract.dataBindings[0]={id:'b',label:'无匹配',mode:'runtime_dom',strategy:'non_matching_option_query',targetHint:'搜索框',businessIntent:'负例',constraints:{mustComeFromCurrentDom:true},optionUniverse:{completeness:'complete_local',options:['猜测选项'],evidence:'模型自称已读取完整'}}
  value.stages[4].output=structuredClone(value.output)
  assert.equal(check(JSON.stringify(value)).pass,false)
})
