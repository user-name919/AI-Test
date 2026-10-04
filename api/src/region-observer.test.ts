import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { PageObserver } from './automation/page-observer'
import { SingleActionExecutor } from './automation/single-action-executor'
import { agentActionSchema } from '@quality-ai/contracts'
import { describeAgentDecision } from '@quality-ai/contracts/live-execution'

test('密集页面可局部重观察真实容器，保留预算与范围，不重用旧引用或误点背景',async()=>{
  const browser=await chromium.launch({headless:true})
  try{
    const page=await browser.newPage()
    await page.setContent(`${'<button>背景</button>'.repeat(20)}<section role="dialog" aria-label="编辑"><div id="host"></div></section>`)
    await page.evaluate(()=>{document.querySelector('#host')!.attachShadow({mode:'open'}).innerHTML='<button id="target" onclick="this.dataset.clicked=\'yes\'">目标</button><div role="option">数学</div>'+ '<button>其他</button>'.repeat(10)})
    const observer=new PageObserver({maxElements:5})
    const original=await observer.observe(page)
    assert.equal(original.elements.some(item=>item.name==='目标'),false)
    assert.equal(original.stats.truncated,true)
    const container=original.elements.find(item=>item.role==='dialog')!
    assert.ok(container)
    const executor=new SingleActionExecutor(page,observer.registry,'http://localhost','/private/tmp')
    const action=agentActionSchema.parse({action:'observeRegion',elementRef:container.ref})
    assert.match(describeAgentDecision({type:'action',snapshotId:original.snapshotId,action,reason:'查看截断内容'},original,1).title,/局部观察.*编辑/)
    assert.equal((await executor.execute(original.snapshotId,action)).ok,true)
    assert.throws(()=>observer.registry.resolve(original.snapshotId,container.ref),/已失效/)
    const local=await observer.observe(page)
    assert.deepEqual(local.observationScope,{mode:'region',sourceElementRef:container.ref,sourceSnapshotId:original.snapshotId})
    assert.equal(local.stats.truncated,true)
    assert.equal(local.elements.length,5)
    assert.equal(local.elements.some(item=>item.name==='背景'),false)
    const target=local.elements.find(item=>item.name==='目标')!
    assert.ok(target)
    assert.equal((await executor.execute(local.snapshotId,{action:'click',elementRef:target.ref})).ok,true)
    assert.equal(await page.locator('#target').getAttribute('data-clicked'),'yes')
    const full=await observer.observe(page)
    assert.equal(full.observationScope,undefined)
    assert.equal(full.elements.some(item=>item.name==='背景'),true)
    assert.throws(()=>observer.registry.resolve(local.snapshotId,target.ref),/已失效/)
  }finally{await browser.close()}
})

test('局部观察固定实际节点身份，区域移除不得静默读取同名替身',async()=>{
  const browser=await chromium.launch({headless:true})
  try{
    const page=await browser.newPage()
    await page.setContent('<section role="dialog" aria-label="区域"><button>旧按钮</button></section>')
    const observer=new PageObserver()
    const snapshot=await observer.observe(page)
    const region=snapshot.elements.find(item=>item.role==='dialog')!
    await observer.registry.observeRegion(snapshot.snapshotId,region.ref)
    await page.locator('section').evaluate(element=>{const replacement=element.cloneNode(true);element.replaceWith(replacement)})
    await assert.rejects(observer.observe(page),/局部观察目标已失效/)
    assert.equal(observer.registry.activeSnapshotId,undefined)
    const full=await observer.observe(page)
    assert.equal(full.observationScope,undefined)
    await assert.rejects(observer.registry.observeRegion(snapshot.snapshotId,region.ref),/已失效/)
  }finally{await browser.close()}
})
