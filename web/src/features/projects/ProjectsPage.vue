<script setup lang="ts">
import { computed,onMounted,ref } from 'vue'
import { useRoute } from 'vue-router'
import type { ProjectInfo } from '@quality-ai/contracts'
const route=useRoute()
const projects=ref<ProjectInfo[]>([]),busy=ref(false),error=ref(''),help=ref(false),checkedAt=ref('')
const selected=computed(()=>projects.value.find(item=>item.id===route.params.id))
async function refresh(){
  if(busy.value)return
  busy.value=true;error.value=''
  try{
    const response=await fetch('/api/projects');const result=await response.json()
    if(!response.ok)throw new Error(result.error??'项目读取失败')
    projects.value=result.projects;checkedAt.value=new Date().toLocaleString()
  }catch(cause){error.value=cause instanceof Error?cause.message:'项目状态读取失败'}finally{busy.value=false}
}
onMounted(refresh)
</script>
<template>
  <main class="projects-page">
    <nav><RouterLink to="/versions">版本中心</RouterLink><RouterLink to="/environments">测试环境与登录态</RouterLink><RouterLink to="/regressions">变更回归</RouterLink><RouterLink to="/execution-jobs">后台任务</RouterLink></nav>
    <header><h1>源码项目</h1><button @click="help=!help">使用指引</button><button :disabled="busy" @click="refresh">{{ busy?'读取中…':'刷新连接状态' }}</button></header>
    <section v-if="help"><h2>源码连接如何使用</h2><p>项目配置中的 root 可以指向本机目录或软链。平台按 URL 查路由，再按需读取局部源码辅助理解，最终仍须回真实页面验证，源码内容不代表测试通过。</p><p>本页仅检查已有配置，不创建软链、不切换分支。添加项目需由开发人员维护本地项目配置，完成后重启 API 以重新加载 Provider，再刷新此页。变更回归选择其他提交时使用受管理 worktree，不切换原工作区。</p><p>Origin 是协议、域名和端口，不含页面路径。连接成功只表示源码可读，不表示测试账号有权限，也不证明测试环境部署了该提交。</p></section>
    <p v-if="error" role="alert" class="error">{{ error }} · 下方若有旧状态，仅供参考，请重试刷新。</p><p v-if="checkedAt">最近读取：{{ checkedAt }}</p>
    <p v-if="help">默认配置文件：<code>config/projects.local.json</code>；若设置了 <code>PROJECTS_CONFIG_PATH</code>，以该路径为准。本地配置与软链不要提交到公开仓库。</p>
    <div class="columns"><section><h2>已配置项目</h2><p v-if="!projects.length&&!busy">未读取到项目。请查看使用指引检查本地配置。</p><RouterLink v-for="item in projects" :key="item.id" class="project" :to="`/projects/${encodeURIComponent(item.id)}`"><strong>{{ item.name }}</strong><span>{{ item.connected?'源码可读':'连接异常' }} · {{ item.branch||'无分支信息' }}</span></RouterLink></section>
    <section v-if="selected"><h2>{{ selected.name }}</h2><p :class="{error:!selected.connected}">{{ selected.connected?'源码目录可读':'连接异常：'+(selected.error??'未提供原因') }}</p><dl><dt>项目 ID</dt><dd>{{ selected.id }}</dd><dt>配置路径 / 软链入口</dt><dd>{{ selected.configuredRoot }}</dd><dt>实际读取目录</dt><dd>{{ selected.resolvedRoot??'未解析成功' }}</dd><dt>当前分支</dt><dd>{{ selected.branch||'无分支信息（可能为 detached HEAD 或非 Git 目录）' }}</dd><dt>当前提交 SHA</dt><dd>{{ selected.commit??'未读取到提交信息' }}</dd><dt>允许测试的 Origin</dt><dd><ul v-if="selected.targetOrigins.length"><li v-for="origin in selected.targetOrigins" :key="origin">{{ origin }}</li></ul><span v-else>未限制 Origin，请在执行时核对目标地址。</span></dd></dl><p>SHA 仅标识已提交版本，不包含本地未提交改动；本页没有证明工作区干净或部署版本一致。</p></section>
    <section v-else><h2>{{ route.params.id?'项目不存在或未能读取':'选择一个项目查看连接详情' }}</h2><p>切换左侧项目只改变查看对象，不会切换 Git 分支或修改源码。</p></section></div>
  </main>
</template>
<style scoped>
.projects-page{padding:24px;font-size:16px;line-height:1.7;background:#f5f7fb;min-height:100vh;box-sizing:border-box;color:#202a40}nav,header{display:flex;gap:20px;align-items:center;flex-wrap:wrap}h1{margin-right:auto}h2{font-size:21px}button{font:inherit;padding:10px;cursor:pointer}button:disabled{opacity:.6}.columns{display:grid;grid-template-columns:minmax(220px,1fr) minmax(0,2fr);gap:20px}section{margin-top:16px;padding:20px;border:1px solid #d7ddea;border-radius:10px;background:white;min-width:0}.project{display:block;padding:12px;border-bottom:1px solid #d7ddea}.project span{display:block}.router-link-active{font-weight:bold}dt{font-weight:600;margin-top:14px}dd{margin:4px 0;overflow-wrap:anywhere}p{overflow-wrap:anywhere}.error{color:#9e2525;background:#fff0f0;padding:12px;white-space:pre-wrap}@media(max-width:760px){.columns{grid-template-columns:1fr}.projects-page{padding:12px}}
</style>
