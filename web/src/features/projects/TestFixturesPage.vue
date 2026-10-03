<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { maxFixtureBytes, type TestFixture } from '@quality-ai/contracts/test-fixtures'

const fixtures = ref<TestFixture[]>([]), warnings = ref<string[]>([])
const file = ref<File>(), busy = ref(false), loading = ref(false), error = ref(''), notice = ref(''), help = ref(false), inputKey = ref(0)
const canSave = computed(() => Boolean(file.value && file.value.size <= maxFixtureBytes && !busy.value))
async function refresh() {
  if (loading.value) return
  loading.value = true
  try {
    const response = await fetch('/api/test-fixtures'), result = await response.json()
    if (!response.ok) throw new Error(result.error ?? '附件列表读取失败')
    fixtures.value = result.fixtures; warnings.value = result.warnings
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '附件列表读取失败' }
  finally { loading.value = false }
}
function choose(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0]
  error.value = ''; notice.value = ''
  if (file.value && file.value.size > maxFixtureBytes) error.value = '文件超过 10MB，请选择更小的测试附件。'
}
async function save() {
  if (!canSave.value || !file.value) return
  const selected = file.value
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
      reader.onerror = () => reject(new Error('读取本地文件失败，请重新选择'))
      reader.readAsDataURL(selected)
    })
    const response = await fetch('/api/test-fixtures', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: selected.name, mimeType: selected.type || 'application/octet-stream', base64 }) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? '附件登记失败')
    file.value = undefined; inputKey.value++
    notice.value = `已登记 ${result.fixture.name}。原文件没有被覆盖，请将附件 ID 关联到需要上传的用例。`
    await refresh()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '附件登记失败；所选文件仍保留，可重试' }
  finally { busy.value = false }
}
async function copyId(id: string) {
  try { await navigator.clipboard.writeText(id); notice.value = '附件 ID 已复制；只在确认的上传用例中使用。' }
  catch { error.value = '无法访问剪贴板，请选择附件 ID 文本后手动复制。' }
}
function protectClose(event: BeforeUnloadEvent) { if (file.value || busy.value) { event.preventDefault(); event.returnValue = '' } }
onBeforeRouteLeave(() => busy.value ? false : !file.value || window.confirm('所选附件尚未登记，离开将丢弃本次选择。确认离开？'))
onMounted(() => { void refresh(); window.addEventListener('beforeunload', protectClose) })
onBeforeUnmount(() => window.removeEventListener('beforeunload', protectClose))
</script>
<template>
  <main class="fixtures-page">
    <nav><RouterLink to="/versions">版本中心</RouterLink><RouterLink to="/cases">用例资产</RouterLink><RouterLink to="/case-designs">用例设计</RouterLink><RouterLink to="/environments">测试环境</RouterLink></nav>
    <header><h1>测试附件</h1><button @click="help=!help">使用指引</button><button :disabled="loading||busy" @click="error='';refresh()">刷新附件列表</button></header>
    <section v-if="help"><h2>如何用于上传测试</h2><ol><li>选择允许用于测试的文件，点击登记；这里只保存到本地平台，不立即上传到被测网站。</li><li>复制附件 ID，在用例数据中选择 fixture 或 manual，把 ID 作为值，并填写使用依据，再确认最终用例。不要填写本机路径。</li><li>固定计划和动态 Agent 可使用已确认 ID 上传到真实文件输入框；网站可能在选文件时自动上传，确认用例前请核对目标环境和副作用。</li></ol><p>同名文件重新登记会产生新 ID，不覆盖历史附件。文件内容被改动时执行受阻，历史报告保留当时指纹。动态模式必须能观察到文件控件；隐藏输入、文件选择对话框和多文件尚未接入。上传失败不自动重复提交。</p></section>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status" class="notice">{{ notice }} <button @click="notice=''">关闭提示</button></p>
    <section><h2>登记文件</h2><label>选择测试附件<input :key="inputKey" type="file" :disabled="busy" @change="choose"></label><p>{{ file?`${file.name} · ${file.size} 字节`:'尚未选择文件' }}</p><button :disabled="!canSave" @click="save">{{ busy?'正在登记…':'登记测试附件' }}</button><p>单文件最多 10MB。尚未选择文件或超出大小时不能登记；登记中暂不能离开此页面。失败保留所选文件，可以重试。</p></section>
    <section><h2>已登记附件（{{ fixtures.length }}）</h2><p v-if="!fixtures.length&&!loading">暂无可用测试附件，请先登记。</p><p v-if="loading">正在核对附件文件及内容指纹…</p><p v-for="warning in warnings" :key="warning" role="alert" class="error">{{ warning }}</p>
      <article v-for="fixture in fixtures" :key="fixture.id"><h3>{{ fixture.name }}</h3><p>{{ fixture.size }} 字节 · {{ fixture.mimeType }} · 登记于 {{ new Date(fixture.createdAt).toLocaleString() }}</p><label>附件 ID<input readonly :value="fixture.id" @focus="($event.target as HTMLInputElement).select()"></label><button @click="copyId(fixture.id)">复制附件 ID</button><details><summary>查看内容指纹</summary><p>{{ fixture.sha256 }}</p></details></article>
    </section>
  </main>
</template>
<style scoped>
.fixtures-page{margin-left:0;width:100%}
.fixtures-page{padding:24px;min-height:100vh;background:#f5f7fb;color:#202a40;font-size:16px;line-height:1.7;box-sizing:border-box}nav,header{display:flex;gap:18px;align-items:center;flex-wrap:wrap}h1{margin-right:auto}h2{font-size:21px}h3{font-size:18px}section{background:white;border:1px solid #d7ddea;border-radius:10px;padding:20px;margin-top:16px;min-width:0}article{padding:16px 0;border-top:1px solid #d7ddea}button,input{font:inherit;max-width:100%;box-sizing:border-box}button{padding:9px 12px;cursor:pointer}button:disabled{opacity:.6;cursor:not-allowed}label{display:block}input{display:block;margin:8px 0;width:100%;padding:8px}p,h3{overflow-wrap:anywhere}.error,.notice{padding:12px;border-radius:8px;white-space:pre-wrap}.error{background:#fff0f0;color:#9e2525}.notice{background:#eaf5ee}summary{cursor:pointer;padding:8px 0}@media(max-width:760px){.fixtures-page{padding:12px}section{padding:14px}}
</style>
