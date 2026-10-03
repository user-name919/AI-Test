import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'

test('固定计划展示全部用例、业务预期和完整参数，窄屏可以阅读',async()=>{
  const plan={name:'合成批次',targetUrl:'https://example.test',steps:[{action:'click',locator:{by:'text',value:'打开'}}],casePlans:[
    {caseKey:'0-TC-0',title:'打开列表',steps:[{action:'click',locator:{by:'text',value:'打开'}}]},
    {caseKey:'0-TC-1',title:'验证匹配项',contract:{expectedAssertions:['来源选项仍在结果中']},steps:[{action:'expectText',text:'示例选项',assertionIndex:0}]},
    {caseKey:'0-TC-2',title:'验证高亮',steps:[],preparationError:'缺少样式属性依据'},
  ]}
  const server=await createServer({root:new URL('../../web',import.meta.url).pathname,configFile:false,plugins:[vue(),{
    name:'fixed-plan-fixture',
    configureServer(server){server.middlewares.use('/preview-fixture',(_request,response)=>{
      response.setHeader('Content-Type','text/html');response.end('<div id="app"></div><script type="module" src="/@id/__x00__fixture-entry"></script>')
    })},
    resolveId(id){if(id==='fixture-entry')return '\0fixture-entry'},
    load(id){if(id==='\0fixture-entry')return 'import {createApp} from "vue";import Preview from "/src/features/executions/FixedPlanPreview.vue";createApp(Preview,'+JSON.stringify({plan})+').mount("#app")'},
  }],server:{host:'127.0.0.1',port:0}})
  const browser=await chromium.launch({headless:true})
  try{
    await server.listen()
    const address=server.httpServer!.address();assert.ok(address&&typeof address!=='string')
    const page=await browser.newPage({viewport:{width:390,height:844}})
    page.setDefaultTimeout(8000)
    const errors:string[]=[]
    page.on('pageerror',error=>errors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}/preview-fixture`)
    await page.locator('article').first().waitFor().catch(error=>{throw new Error(`${error.message}\n页面错误：${errors.join(';')}\n页面：${page.url()}`)})
    assert.match(await page.locator('article').nth(1).innerText(),/验证预期\s*1：\s*来源选项仍在结果中/)
    assert.equal(await page.locator('article').count(),3)
    assert.match(await page.locator('article').nth(2).innerText(),/计划受阻：\s*缺少样式属性依据/)
    const second=page.locator('article').nth(1)
    await second.getByText('查看完整动作参数',{exact:true}).click()
    assert.match(await second.locator('pre').first().innerText(),/"assertionIndex": 0/)
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1))
  }finally{await browser.close();await server.close()}
})
