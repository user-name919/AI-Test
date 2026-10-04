import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { PageObserver } from './automation/page-observer'
import { SingleActionExecutor } from './automation/single-action-executor'

test('开放嵌套Shadow DOM可观察、执行和关联跨宿主容器，隐藏与封闭节点不冒充可操作', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<span id="label">错误外层标签</span><button id="background">保存</button><section role="dialog" aria-label="编辑学生"><div id="host"></div></section><div id="hidden" aria-hidden="true"></div><div id="closed"></div>')
    await page.evaluate(() => {
      const root = document.querySelector('#host')!.attachShadow({ mode: 'open' })
      root.innerHTML = '<span id="label">考试名称</span><input aria-labelledby="label"><div id="nested"></div><table aria-label="成绩"><thead><tr><th>姓名</th></tr></thead><tbody><tr><td>甲</td></tr></tbody></table><div role="status">已加载</div>'
      root.querySelector('#nested')!.attachShadow({ mode: 'open' }).innerHTML = '<button id="save" onclick="this.dataset.saved=\'yes\'">保存</button><div role="option">数学模拟考试</div>'
      document.querySelector('#hidden')!.attachShadow({ mode: 'open' }).innerHTML = '<button>隐藏保存</button><div role="alert">隐藏错误</div>'
      document.querySelector('#closed')!.attachShadow({ mode: 'closed' }).innerHTML = '<button>封闭保存</button>'
    })
    const observer = new PageObserver()
    const snapshot = await observer.observe(page)
    const input = snapshot.elements.find(item => item.role === 'textbox')!
    assert.equal(input.name, '考试名称')
    const dialog = snapshot.dialogs[0].elementRef!
    assert.equal(input.containerRef, dialog)
    const save = snapshot.elements.find(item => item.name === '保存' && item.containerRef === dialog)!
    assert.ok(save)
    assert.equal(save.container, '编辑学生')
    assert.equal(snapshot.elements.some(item => /隐藏保存|封闭保存/.test(item.name)), false)
    assert.equal(snapshot.messages.some(item => item.text === '隐藏错误'), false)
    assert.deepEqual(snapshot.tables[0].sampleRows, [['甲']])
    assert.equal(snapshot.messages[0].text, '已加载')
    const executor = new SingleActionExecutor(page, observer.registry, 'http://localhost', '/private/tmp')
    assert.equal((await executor.execute(snapshot.snapshotId, { action: 'fill', elementRef: input.ref, value: '数学' })).ok, true)
    assert.equal((await executor.execute(snapshot.snapshotId, { action: 'expectValue', elementRef: input.ref, value: '数学', assertionId: 'value' })).ok, true)
    assert.equal((await executor.execute(snapshot.snapshotId, { action: 'click', elementRef: save.ref })).ok, true)
    assert.equal(await page.locator('#save').getAttribute('data-saved'), 'yes')
    assert.equal(await page.locator('#background').getAttribute('data-saved'), null)
    assert.equal((await executor.execute(snapshot.snapshotId, { action: 'expectCount', containerRef: dialog, role: 'button', name: '保存', exact: true, count: 1, assertionId: 'count' })).ok, true)
    const next = await observer.observe(page)
    assert.throws(() => observer.registry.resolve(snapshot.snapshotId, save.ref), /已失效/)
    assert.equal(await page.locator(`[data-quality-ai-element-ref^="${snapshot.snapshotId}:"]`).count(), 0)
    assert.ok(next.elements.find(item => item.role === 'option'))
    const limited = await new PageObserver({ maxElements: 1 }).observe(page)
    assert.equal(limited.stats.truncated, true)
    assert.equal(limited.elements.length, 1)
  } finally { await browser.close() }
})

test('分配到slot的控件继承真实渲染容器与隐藏状态', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="host"><button slot="action">提交</button><button slot="hidden">不可见提交</button></div>')
    await page.evaluate(() => {
      document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML = '<section role="dialog" aria-label="审批"><slot name="action"></slot><div aria-hidden="true"><slot name="hidden"></slot></div></section>'
    })
    const snapshot = await new PageObserver().observe(page)
    assert.equal(snapshot.elements.find(item => item.name === '提交')?.containerRef, snapshot.dialogs[0].elementRef)
    assert.equal(snapshot.elements.some(item => item.name === '不可见提交'), false)
  } finally { await browser.close() }
})
