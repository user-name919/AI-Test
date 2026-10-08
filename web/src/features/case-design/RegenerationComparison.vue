<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { DesignReviewContent, RegenerationComparison } from '@quality-ai/contracts/case-design'
import { designRequest } from './useCaseDesign'
import ContractView from './ContractView.vue'
const props=defineProps<{designId:string;runId:string;disabled:boolean}>()
const emit=defineEmits<{adopt:[value:{caseId:string;review:DesignReviewContent['cases'][string]}]}>()
const comparison=ref<RegenerationComparison>();const error=ref('');const loading=ref(false)
const sourceIds=ref<Record<string,string>>({})
let disposed=false
onBeforeUnmount(()=>{disposed=true})
async function load(){loading.value=true;error.value='';try{const result=await designRequest<{comparison:RegenerationComparison}>(`/api/case-designs/${props.designId}/runs/${props.runId}/comparison`);if(!disposed)comparison.value=result.comparison}catch(cause){if(!disposed)error.value=cause instanceof Error?cause.message:'读取对比失败'}finally{loading.value=false}}
onMounted(()=>{void load()})
function adopt(caseId:string,review:DesignReviewContent['cases'][string]){
  if(props.disabled||!window.confirm('将替换此用例当前编辑内容，并设为待审核草稿。其他用例与历史记录不变，是否继续？'))return
  emit('adopt',{caseId,review:{title:review.title,contract:JSON.parse(JSON.stringify(review.contract)),verification:review.verification,verificationReason:review.verificationReason,status:'draft'}})
}
</script>
<template>
  <section class="regeneration-comparison" aria-label="重生成三方比较">
    <h3>重生成三方比较</h3><p>新旧用例不一定一一对应。选择要保留的旧人工口径后，将其复制到指定新用例；关联场景与原文依据仍属于新用例，请重新核实。任何采纳都只修改当前草稿，需重新确认并保存。</p>
    <p v-if="loading">正在读取对比…</p><p v-if="error" role="alert">{{ error }} <button @click="load">重试对比</button></p>
    <p v-if="comparison">基线 {{ comparison.baseRunId }} · {{ comparison.reviewId?`人工审核 v${comparison.reviewRevision}`:'基线尚无匹配的人工审核' }}</p>
    <article v-for="scenario in comparison?.scenarios" :key="scenario.scenarioId">
      <h4>场景 {{ scenario.scenarioId }}</h4>
      <div class="comparison-columns">
        <div><h4>旧 AI 建议</h4><details v-for="item in scenario.before" :key="item.id"><summary>{{ item.title }}</summary><ContractView :contract="item.contract" /></details></div>
        <div><h4>旧人工口径</h4><template v-for="item in scenario.human" :key="item.caseId"><details v-if="item.review"><summary>{{ item.review.title }} · {{ {draft:'草稿',confirmed:'已确认',excluded:'已排除'}[item.review.status] }}</summary><p>{{ item.review.verificationReason }}</p><p v-if="item.review.exclusionReason">排除理由：{{ item.review.exclusionReason }}</p><ContractView :contract="item.review.contract" /></details></template><p v-if="!scenario.human.some(item=>item.review)">没有已保存人工口径</p></div>
        <div><h4>新 AI 建议</h4><section v-for="item in scenario.suggestions" :key="item.id" class="new-suggestion"><h5>{{ item.title }}</h5><details><summary>查看新建议完整内容</summary><ContractView :contract="item.contract" /></details><button :disabled="disabled" @click="adopt(item.id,{...item,status:'draft'})">采用此新建议到草稿</button>
          <label>为“{{ item.title }}”选择旧人工口径<select v-model="sourceIds[item.id]" :aria-label="`为“${item.title}”选择旧人工口径`"><option value="">请选择，不自动匹配</option><template v-for="old in scenario.human" :key="old.caseId"><option v-if="old.review" :value="old.caseId">{{ old.review.title }}（{{ old.caseId }}）</option></template></select></label>
          <button :disabled="disabled||!sourceIds[item.id]" @click="adopt(item.id,scenario.human.find(old=>old.caseId===sourceIds[item.id])!.review!)">保留所选人工口径到此草稿</button>
        </section><p v-if="!scenario.suggestions.length">暂无成功的新建议，不可采纳。</p></div>
      </div>
    </article>
  </section>
</template>
<style scoped>
.regeneration-comparison{margin:20px 0;padding:16px;background:#f7f8fc;border:1px solid #dce1eb;border-radius:8px;font-size:16px;overflow-wrap:anywhere}.comparison-columns{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.comparison-columns>div{min-width:0;padding:12px;background:white;border:1px solid #e0e4ed}h4,h5{font-size:16px}details{margin:12px 0}summary{cursor:pointer}button,select{font:inherit;padding:8px;max-width:100%;white-space:normal}button:disabled{opacity:.5}label{display:block;margin:12px 0}select{display:block;width:100%}.new-suggestion{border-bottom:1px solid #ddd;padding-bottom:16px}@media(max-width:1050px){.comparison-columns{grid-template-columns:1fr}}
</style>
