import assert from 'node:assert/strict'
import test from 'node:test'
import type { DesignRun, DesignReview } from '@quality-ai/contracts/case-design'
import { buildReviewDraft, findBaselineReview } from './modules/case-design/review-draft'

function fixture() {
  const contract={objective:'原始目标',preconditions:[],steps:['搜索'],expectedAssertions:['匹配'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}
  const base:DesignRun={id:'base',designId:'d',attempt:1,stage:'checking',status:'completed',inputRevision:1,inputHash:'same',model:'fixture',modelConfigHash:'fixture',protocol:'fixture',promptVersion:'fixture',skills:[],createdAt:'now',updatedAt:'now',statistics:{calls:0,inputCharacters:0,outputCharacters:0},output:{facts:[],questions:[],processedBlockIds:[],unprocessedBlockIds:[],modelReviewCompleted:true,cases:['s1','s2'].map((id)=>({id,title:id,scenarioId:id,factIds:[],questionIds:[],contract:structuredClone(contract),verification:'browser',verificationReason:'页面',requiresReview:true}))}}
  const review:DesignReview={id:'human',designId:'d',runId:'base',revision:1,inputRevision:1,inputHash:'same',createdAt:'now',content:{cases:{s1:{title:'人工一',contract:{...contract,objective:'保留人工一'},verification:'browser',verificationReason:'页面',status:'confirmed'},s2:{title:'人工二',contract:{...contract,objective:'保留人工二'},verification:'browser',verificationReason:'页面',status:'excluded',exclusionReason:'范围外'}},questionDecisions:{},issueDecisions:{old:{status:'addressed',reason:'旧处理'}},excludedFacts:{}}}
  const next=structuredClone(base);next.id='next';next.regeneration={baseRunId:'base',scenarioIds:['s1']};next.output.cases![0].id='new';next.output.cases![0].contract.objective='新建议'
  return {base,review,next}
}

test('局部重生成仅继承精确未变化用例，保留人工排除和理由，不继承质量处置',()=>{
  const {base,review,next}=fixture()
  const original=structuredClone({base,review,next})
  const result=buildReviewDraft(next,[next,base],[review])
  assert.deepEqual(result.inheritedCaseIds,['s2'])
  assert.deepEqual(result.content.cases.s2,review.content.cases.s2)
  assert.equal(result.content.cases.new.status,'draft')
  assert.equal(result.content.cases.new.contract.objective,'新建议')
  assert.equal(result.content.cases.s1,undefined)
  assert.deepEqual(result.content.issueDecisions,{})
  result.content.cases.s2.contract.objective='新编辑'
  assert.deepEqual({base,review,next},original)
})

test('较新无关审核不挤掉基线口径，但保存必须校验全局最新版本',()=>{
  const {base,review,next}=fixture()
  const unrelated=structuredClone(base);unrelated.id='other';unrelated.output.cases![0].contract.objective='另外一次生成'
  const other={...structuredClone(review),id:'other-review',runId:'other',revision:2}
  const result=buildReviewDraft(next,[base,next,unrelated],[other,review])
  assert.equal(result.sourceReviewId,'human')
  assert.equal(result.expectedRevision,2)
  assert.equal(findBaselineReview(next,[base,next,unrelated],[other,review])?.id,'human')
})

test('材料、上游事实或同ID用例变化时不得沿用确认；已保存目标版本优先',()=>{
  const {base,review,next}=fixture()
  next.output.cases![1].contract.steps=['规则发生变化']
  assert.deepEqual(buildReviewDraft(next,[base,next],[review]).inheritedCaseIds,[])
  next.output.questions=[{id:'new-q',question:'新增问题',evidence:[]}]
  assert.deepEqual(buildReviewDraft(next,[base,next],[review]).content.questionDecisions,{})
  next.inputHash='changed'
  assert.equal(buildReviewDraft(next,[base,next],[review]).sourceReviewId,null)
  const saved={...structuredClone(review),id:'saved-next',runId:'next',revision:3,content:buildReviewDraft(next,[base,next],[]).content}
  saved.content.cases.new.contract.objective='已经保存的人工修改'
  const result=buildReviewDraft(next,[base,next],[saved,review])
  assert.equal(result.savedReviewId,'saved-next')
  assert.equal(result.content.cases.new.contract.objective,'已经保存的人工修改')
})
