<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import type { TestEnvironment } from '@quality-ai/contracts'
const environments=ref<TestEnvironment[]>([]),selected=ref<TestEnvironment>()
const name=ref(''),targetUrl=ref(''),error=ref(''),notice=ref(''),busy=ref(false),help=ref(false)
const dirty=computed(()=>name.value!==(selected.value?.name??'')||targetUrl.value!==(selected.value?.targetUrl??''))
const originChanged=computed(()=>{try{return !!selected.value&&new URL(targetUrl.value).origin!==selected.value.baseUrl}catch{return false}})
const reason=computed(()=>{if(!name.value.trim())return '请填写环境名称';try{if(!['http:','https:'].includes(new URL(targetUrl.value).protocol))return '仅支持 HTTP(S) 地址'}catch{return '请填写完整测试页面地址'}return ''})
async function request<T>(path:string,body?:unknown):Promise<T>{
  const response=await fetch(path,body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  const payload=await response.json();if(!response.ok)throw new Error(payload.error??'请求失败');return payload
}
async function load(){try{environments.value=(await request<{environments:TestEnvironment[]}>('/api/environments')).environments}catch{error.value='环境列表读取失败，请刷新页面重试；未保存草稿不会自动丢弃。'}}
function select(environment?:TestEnvironment){
  if(dirty.value&&!window.confirm('尚有未保存的环境修改，确定放弃并切换？'))return
  selected.value=environment;name.value=environment?.name??'';targetUrl.value=environment?.targetUrl??'';error.value='';notice.value=''
}
onBeforeRouteLeave(()=>!dirty.value||window.confirm('尚有未保存的环境修改，确定离开？'))
async function save(){
  if(reason.value||busy.value)return
  busy.value=true;error.value='';notice.value=''
  const changed=originChanged.value
  try{
    const result=await request<{environment:TestEnvironment}>('/api/environments',{id:selected.value?.id,name:name.value,targetUrl:targetUrl.value})
    selected.value=result.environment;name.value=result.environment.name;targetUrl.value=result.environment.targetUrl
    notice.value=changed?'环境已保存；域名已变化，旧登录态关联已解除，请重新导入。':'环境已保存。登录是否有效仍需实际执行验证。'
    await load()
  }catch(cause){error.value=cause instanceof Error?cause.message:'保存失败'}finally{busy.value=false}
}
async function importState(event:Event){
  const input=event.target as HTMLInputElement,file=input.files?.[0]
  if(!file||!selected.value||dirty.value||busy.value)return
  busy.value=true;error.value='';notice.value=''
  try{
    const state=JSON.parse(await file.text())
    selected.value=(await request<{environment:TestEnvironment}>(`/api/environments/${selected.value.id}/storage-state`,state)).environment
    notice.value='登录态已导入，仅供本地测试使用；导入成功不代表账号尚未过期。';await load()
  }catch(cause){error.value=cause instanceof Error?cause.message:'登录态导入失败'}finally{busy.value=false;input.value=''}
}
onMounted(load)
</script>
<template>
  <main class="environments-page">
    <nav><RouterLink to="/versions">版本中心</RouterLink><RouterLink to="/case-designs">用例设计</RouterLink><RouterLink to="/regressions">变更回归</RouterLink><RouterLink to="/execution-jobs">后台任务</RouterLink></nav>
    <header><h1>测试环境</h1><button @click="help=!help">使用指引</button></header>
    <section v-if="help"><h2>如何配置</h2><p>先保存环境名称和完整测试页面地址，再导入 Playwright 导出的 storageState JSON。无需导入需求文档即可配置环境。该文件含登录凭据，不要提交 Git 或公开分享。</p><p>同域名下修改页面路径保留登录态；更换 Origin（协议、域名或端口）会解除旧关联，但不会删除旧文件。平台不部署网站，也不通过“已导入”判断账号有效。</p></section>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <div class="columns"><section><h2>已保存环境</h2><button :disabled="busy" @click="select()">新建环境</button><p v-if="!environments.length">尚无环境，请在右侧填写。</p><button v-for="item in environments" :key="item.id" class="environment" :disabled="busy" :aria-pressed="selected?.id===item.id" @click="select(item)"><strong>{{ item.name }}</strong><span>{{ item.targetUrl }}</span><span>{{ item.hasStorageState?'已导入登录态（未验证有效性）':'未导入登录态' }}</span></button></section>
    <section><h2>{{ selected?'编辑环境':'新建环境' }}</h2><fieldset :disabled="busy"><label>环境名称<input v-model="name" aria-label="环境名称" /></label><label>测试页面地址<input v-model="targetUrl" aria-label="测试页面地址" type="url" placeholder="https://测试域名/页面" /></label><p v-if="originChanged" class="warning">保存后将解除旧登录态关联，需要为新域名重新导入。</p><p>{{ reason||'配置格式有效，保存后可用于执行。' }}</p><button :disabled="!!reason||!dirty" @click="save">保存环境</button><p v-if="dirty">有未保存修改，保存后才能导入登录态。</p><label>导入登录态 JSON<input type="file" accept=".json,application/json" :disabled="!selected||dirty" @change="importState" /></label><p v-if="selected">{{ selected.hasStorageState?'已导入登录态，实际有效性请运行测试确认。':'未导入登录态，受保护页面可能无法进入。' }}</p></fieldset></section></div>
  </main>
</template>
<style scoped>
.environments-page{padding:24px;font-size:16px;line-height:1.7;background:#f5f7fb;min-height:100vh;color:#202a40;box-sizing:border-box}nav,header{display:flex;gap:20px;align-items:center;flex-wrap:wrap}h1{margin-right:auto}h2{font-size:21px}section{background:white;border:1px solid #d7ddea;border-radius:10px;padding:20px;min-width:0;margin-top:16px}.columns{display:grid;grid-template-columns:minmax(240px,1fr) minmax(0,2fr);gap:20px}button,input{font:inherit;padding:10px;box-sizing:border-box}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.6}label{display:block;margin:16px 0}input{display:block;width:100%;min-width:0}fieldset{border:0;padding:0;min-width:0}.environment{display:block;text-align:left;width:100%;margin-top:12px;background:white;border:1px solid #bdc7db;overflow-wrap:anywhere}.environment span{display:block}.environment[aria-pressed=true]{border:2px solid #5343df}.error{background:#fff0f0;color:#9e2525;padding:12px;white-space:pre-wrap}.warning{color:#8b3e10}p{overflow-wrap:anywhere}@media(max-width:760px){.columns{grid-template-columns:1fr}.environments-page{padding:12px}}
</style>
