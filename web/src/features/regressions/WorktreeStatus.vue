<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { ManagedWorktreeStatus } from '@quality-ai/contracts/regressions'
import { regressionRequest } from './api'
const props=defineProps<{changeSetId:string}>()
const status=ref<ManagedWorktreeStatus>(),error=ref(''),notice=ref(''),busy=ref(false)
const names={not_created:'未创建',preparing:'准备中',ready:'已登记就绪',error:'需检查',removed:'已清理'}
let generation=0
async function refresh(){
  const current=++generation;busy.value=true;error.value=''
  try{const payload=await regressionRequest<{worktree:ManagedWorktreeStatus}>(`/api/change-sets/${props.changeSetId}/worktree`);if(current===generation)status.value=payload.worktree}
  catch(cause){if(current===generation)error.value=cause instanceof Error?cause.message:'读取快照失败'}
  finally{if(current===generation)busy.value=false}
}
async function remove(){
  if(busy.value||!status.value?.canRemove)return
  if(!window.confirm('只清理平台创建的独立源码快照，不删除原项目、提交、变更范围或报告。后续任务会按固定SHA重新创建。确认清理？'))return
  const current=++generation;busy.value=true;error.value='';notice.value=''
  try{
    const payload=await regressionRequest<{worktree:ManagedWorktreeStatus}>(`/api/change-sets/${props.changeSetId}/worktree/remove`,{confirmed:true,expectedSha:status.value.sha})
    if(current===generation){status.value=payload.worktree;notice.value='平台快照已清理，历史报告仍保留；后续任务可从固定SHA重新创建。'}
  }catch(cause){if(current===generation)error.value=cause instanceof Error?cause.message:'清理失败；请刷新状态后再判断'}
  finally{if(current===generation)busy.value=false}
}
async function recover(){
  if(busy.value||!status.value?.canRecover)return
  if(!window.confirm('只校验已登记目录。固定版本、仓库归属、干净状态全部正确才恢复为就绪；不会重新创建、删除文件或清空引用。确认校验恢复？'))return
  const current=++generation;busy.value=true;error.value='';notice.value=''
  try{
    const payload=await regressionRequest<{worktree:ManagedWorktreeStatus}>(`/api/change-sets/${props.changeSetId}/worktree/recover`,{confirmed:true,expectedSha:status.value.sha})
    if(current===generation){status.value=payload.worktree;notice.value='现有快照已通过校验并恢复就绪；未改变源码或历史报告。'}
  }catch(cause){if(current===generation)error.value=cause instanceof Error?cause.message:'恢复失败；原登记和目录均保留'}
  finally{if(current===generation)busy.value=false}
}
watch(()=>props.changeSetId,()=>{status.value=undefined;notice.value='';void refresh()},{immediate:true})
onBeforeUnmount(()=>{generation++})
</script>
<template>
  <section class="reg-card">
    <h2>平台源码快照</h2><p>这里只管理本平台创建的独立 worktree，不切换或清理被测项目原目录。</p>
    <button :disabled="busy" @click="refresh">刷新快照状态</button>
    <p v-if="error" role="alert" class="reg-error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="status">
      <p>状态：{{ names[status.state] }} · {{ status.sha??'尚无快照版本' }}</p><p>{{ status.reason }}</p>
      <ul><li v-for="(item,index) in status.references" :key="index">引用方：{{ item.owner }} · 登记时间 {{ item.createdAt }}</li></ul>
      <p>引用登记不等于任务仍运行；异常遗留引用需要排查，当前不提供强制释放。</p>
      <template v-if="status.state==='preparing'||status.state==='error'">
        <button :disabled="busy||!status.canRecover" @click="recover">校验并恢复登记</button>
        <p>仅恢复已完整创建且版本正确的干净快照；目录缺失或不完整时保留现场，不自动重建。</p>
      </template>
      <button :disabled="busy||!status.canRemove" @click="remove">清理未使用快照</button>
      <p>仅无引用且内容/版本校验通过时可清理；点击后服务端再次检查，不强制删除修改内容。</p>
    </template>
  </section>
</template>
