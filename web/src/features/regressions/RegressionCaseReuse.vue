<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import type { CaseAsset } from '@quality-ai/contracts/cases'
import type { RegressionReuse, RegressionReuseCandidate, RegressionReuseSnapshot } from '@quality-ai/contracts/regressions'
import ContractView from '../case-design/ContractView.vue'
import { regressionRequest } from './api'

const props=defineProps<{regressionId:string;caseKey:string;reuse?:RegressionReuse;source?:RegressionReuseSnapshot;disabled:boolean}>()
const emit=defineEmits<{choose:[asset:CaseAsset,reason:string];clear:[]}>()
const query=ref('');const reason=ref('');const error=ref('');const loading=ref(false);const loaded=ref(false)
const candidates=ref<RegressionReuseCandidate[]>([]);const truncated=ref(false);const historyTruncated=ref(false)
let disposed=false
onUnmounted(()=>{disposed=true})
async function load(){
  if(loading.value||props.disabled)return
  loading.value=true;error.value=''
  try{
    const result=await regressionRequest<{candidates:RegressionReuseCandidate[];truncated:boolean;executionHistoryTruncated:boolean}>(`/api/regressions/${props.regressionId}/reuse-candidates?${new URLSearchParams({caseKey:props.caseKey,query:query.value})}`)
    if(disposed)return
    candidates.value=result.candidates;truncated.value=result.truncated;historyTruncated.value=result.executionHistoryTruncated;loaded.value=true
  }catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'候选读取失败'}finally{if(!disposed)loading.value=false}
}
function choose(asset:CaseAsset){
  if(props.disabled||!reason.value.trim())return
  if(window.confirm('使用此版本替换当前用例的标题与执行内容草稿？当前未保存的这些编辑将被替换，AI 原建议和历史审核不变。'))emit('choose',asset,reason.value.trim())
}
</script>
<template>
  <section class="reuse" aria-label="已有用例复用">
    <h4>复用已有用例</h4>
    <p>候选按项目依据和行为文字排序，不代表语义等价。选中后替换当前草稿，不修改来源资产；仍需核对本次风险、数据与断言。</p>
    <div v-if="reuse" class="chosen"><p>已选来源：{{ source?.provenance.title??reuse.caseId }} · v{{ reuse.revision }}</p><p>资产 {{ reuse.caseId }} · 指纹 {{ reuse.contractFingerprint }}</p><p>适用理由：{{ reuse.reason }}</p><p>保存后冻结来源版本，后续来源修改不会更新本次回归。下方最终口径可以继续人工修改。</p><details v-if="source"><summary>所选来源内容（只读，不是本次最终口径）</summary><ContractView :contract="source.contract" /><section v-for="question in source.resolvedQuestions" :key="question.questionKey"><p>来源人工决定：{{ question.finalStatement }}</p><p>目标：{{ question.objective??question.questionTitle }}</p><p>触发：{{ question.triggers.join("；")||"无" }}</p><p>行为：{{ question.behaviors.join("；")||"无" }}</p><p>追加断言：{{ question.assertions.join("；")||"无" }}</p><p>禁止：{{ question.forbiddenBehaviors.join("；")||"无" }}</p><p>不确定项：{{ question.uncertainties.join("；")||"无" }}</p></section></details><button :disabled="disabled" @click="emit('clear')">移除复用关联并保留当前编辑</button></div>
    <details><summary>查找并比较已确认资产</summary>
      <label>搜索候选文字<input v-model="query" maxlength="200" :disabled="disabled||loading" /></label><button :disabled="disabled||loading" @click="load">{{ loading?'正在读取候选…':'查找可复用用例' }}</button>
      <p v-if="error" role="alert">{{ error }}</p><p v-if="truncated">只展示排序前 50 条，请输入更具体的文字；未展示不等于没有。</p><p v-if="historyTruncated">项目关联仅参考最近 500 条执行；未找到不代表从未使用。</p><p v-if="loaded&&!candidates.length">没有符合条件的已确认资产；可继续审核本次 AI 建议。</p>
      <label v-if="candidates.length">复用适用理由<textarea v-model="reason" maxlength="2000" :disabled="disabled" placeholder="说明为何适用于当前风险，需调整哪些前置条件或数据" /></label>
      <article v-for="candidate in candidates" :key="candidate.asset.id"><h5>{{ candidate.asset.title }} · v{{ candidate.asset.revision }}</h5><p>{{ {same:'有同项目依据',unknown:'项目关联未知',other:'仅有其他项目依据'}[candidate.projectMatch] }}</p><ul><li v-for="line in candidate.reasons" :key="line">{{ line }}</li></ul><details><summary>比较完整执行内容</summary><ContractView :contract="candidate.asset.finalContract" /><p v-for="question in candidate.asset.resolved.resolvedQuestions" :key="question.questionKey">关联人工决定：{{ question.finalStatement }}</p></details><button :disabled="disabled||!reason.trim()" @click="choose(candidate.asset)">使用此版本替换当前草稿</button><p v-if="!reason.trim()">先填写适用理由，再选择来源版本。</p></article>
    </details>
  </section>
</template>
<style scoped>
.reuse{border:1px solid #dce1eb;border-radius:8px;padding:16px;margin:16px 0;overflow-wrap:anywhere}.reuse article{border-top:1px solid #dce1eb;padding:12px 0}.chosen{background:#f4f3ff;padding:12px}h4,h5{font-size:16px}.reuse p,.reuse li{font-size:14px}
</style>
