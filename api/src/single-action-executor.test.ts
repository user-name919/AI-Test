import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import { agentActionSchema, type ResolvedDataBinding } from '@quality-ai/contracts'
import { PageObserver } from './page-observer'
import { SingleActionExecutor } from './single-action-executor'

test('executes B-end keyboard, hover, scroll and precise assertion actions', async testContext => {
  const artifactDirectory = await mkdtemp(join(tmpdir(), 'quality-ai-actions-'))
  testContext.after(() => rm(artifactDirectory, { recursive: true, force: true }))
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <button id="menu" aria-expanded="false" onmouseenter="this.setAttribute('aria-expanded', 'true')">考试菜单</button>
      <label for="search">考试名称</label>
      <input id="search" onkeydown="if(event.key === 'Enter') this.value='已提交'">
      <button id="enabled">可用操作</button>
      <button id="disabled" disabled>禁用操作</button>
      <label><input id="checked" type="checkbox" checked> 已选择</label>
      <div id="scroller" role="listbox" aria-label="考试列表" tabindex="0" style="height:40px;overflow:auto">
        <div style="height:500px"><div role="option">数学一</div><div role="option">数学二</div></div>
      </div>
      <div style="display:none">加载中</div>
    `)
    const observer = new PageObserver()
    const snapshot = await observer.observe(page)
    const executor = new SingleActionExecutor(page, observer.registry, 'http://localhost:5173', artifactDirectory)
    const ref = (name: string) => snapshot.elements.find(element => element.name === name)?.ref ?? ''
    const execute = (input: unknown) => executor.execute(snapshot.snapshotId, agentActionSchema.parse(input))

    const results = await Promise.all([
      execute({ action: 'hover', elementRef: ref('考试菜单') }),
      execute({ action: 'expectEnabled', elementRef: ref('可用操作'), assertionId: 'enabled' }),
      execute({ action: 'expectDisabled', elementRef: ref('禁用操作'), assertionId: 'disabled' }),
      execute({ action: 'expectChecked', elementRef: ref('已选择'), checked: true, assertionId: 'checked' }),
      execute({ action: 'expectHidden', target: { by: 'text', text: '加载中' }, assertionId: 'hidden' }),
      execute({ action: 'expectCount', containerRef: ref('考试列表'), role: 'option', count: 2, assertionId: 'count' }),
      execute({ action: 'expectElementText', elementRef: ref('数学一'), text: '数学', assertionId: 'element-text' }),
    ])
    assert.ok(results.every(result => result.ok), results.map(result => result.message).join('\n'))

    assert.equal((await execute({ action: 'press', elementRef: ref('考试名称'), key: 'Enter' })).ok, true)
    assert.equal(await page.locator('#search').inputValue(), '已提交')
    assert.equal((await execute({ action: 'expectAttribute', elementRef: ref('考试菜单'), name: 'aria-expanded', value: 'true', assertionId: 'expanded' })).ok, true)
    assert.equal((await execute({ action: 'scroll', elementRef: ref('考试列表'), deltaY: 200 })).ok, true)
    assert.ok(await page.locator('#scroller').evaluate(element => element.scrollTop > 0))
  } finally {
    await browser.close()
  }
})

test('rejects unsafe keyboard keys and arbitrary assertion attributes', () => {
  assert.equal(agentActionSchema.safeParse({ action: 'press', elementRef: 'e1', key: 'Meta+A' }).success, false)
  assert.equal(agentActionSchema.safeParse({
    action: 'expectAttribute', elementRef: 'e1', name: 'onclick', value: 'attack()', assertionId: 'safe',
  }).success, false)
  assert.equal(agentActionSchema.safeParse({ action: 'fill', elementRef: 'e1' }).success, false)
  assert.equal(agentActionSchema.safeParse({ action: 'fill', elementRef: 'e1', value: '数学', valueRef: 'exam-keyword' }).success, false)
  assert.equal(agentActionSchema.safeParse({ action: 'fill', elementRef: 'e1', valueRef: 'exam-keyword' }).success, true)
})

test('preserves initial target query parameters when navigating within the same origin', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.route('http://target.test/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<button>目标页面</button>',
    }))
    const targetUrl = 'http://target.test/lvworkbench/mock-exam/?workcode=V001&username=tester'
    await page.goto(targetUrl)
    const observer = new PageObserver()
    const snapshot = await observer.observe(page)
    const executor = new SingleActionExecutor(page, observer.registry, targetUrl, tmpdir())

    const result = await executor.execute(snapshot.snapshotId, {
      action: 'goto', path: '/lvworkbench/mock-exam-batch-manage/',
    })

    assert.equal(result.ok, true)
    assert.equal(page.url(), 'http://target.test/lvworkbench/mock-exam-batch-manage/?workcode=V001&username=tester')
  } finally {
    await browser.close()
  }
})

test('resolves valueRef before filling and asserting instead of passing a fabricated action literal', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<label for="search">考试搜索框</label><input id="search">')
    const observer = new PageObserver()
    const snapshot = await observer.observe(page)
    const executor = new SingleActionExecutor(page, observer.registry, 'http://localhost:5173', tmpdir())
    const inputRef = snapshot.elements.find(element => element.name === '考试搜索框')?.ref ?? ''
    const bindings = new Map<string, ResolvedDataBinding>([[
      'exam-keyword', {
        bindingId: 'exam-keyword', sourceElementRef: 'e2', sourceText: '模考数学一', value: '数学',
        snapshotId: snapshot.snapshotId, observedAt: snapshot.observedAt, reason: '真实 DOM option',
      },
    ]])

    assert.equal((await executor.execute(snapshot.snapshotId, agentActionSchema.parse({
      action: 'fill', elementRef: inputRef, valueRef: 'exam-keyword',
    }), bindings)).ok, true)
    assert.equal((await executor.execute(snapshot.snapshotId, agentActionSchema.parse({
      action: 'expectValue', elementRef: inputRef, valueRef: 'exam-keyword', assertionId: 'keyword',
    }), bindings)).ok, true)
    assert.equal(await page.locator('#search').inputValue(), '数学')
  } finally {
    await browser.close()
  }
})
