import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'
import { PageObserver } from './automation/page-observer'
import { SingleActionExecutor } from './automation/single-action-executor'

test('builds a compact semantic snapshot and resolves element refs for its active snapshot', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <title>学生管理</title>
      <label for="student-name">学生姓名</label>
      <input id="student-name" placeholder="请输入姓名" required>
      <button id="hidden" style="display:none">隐藏按钮</button>
      <div role="dialog" aria-modal="true" aria-label="编辑学生">
        <button id="save" onclick="this.dataset.clicked='true'">保存</button>
      </div>
      <table aria-label="学生列表">
        <thead><tr><th>姓名</th><th>状态</th></tr></thead>
        <tbody><tr><td>张三</td><td>正常</td></tr></tbody>
      </table>
      <div role="alert">保存失败</div>
    `)
    const observer = new PageObserver()
    const first = await observer.observe(page)
    assert.equal(first.title, '学生管理')
    assert.equal(first.elements.filter(item=>item.role==='textbox'||item.role==='button').length, 2)
    assert.equal(first.elements[0].name, '学生姓名')
    assert.equal(first.elements[0].required, true)
    assert.equal(first.elements[1].container, '编辑学生')
    assert.deepEqual(first.tables[0].columns, ['姓名', '状态'])
    assert.deepEqual(first.tables[0].sampleRows, [['张三', '正常']])
    assert.equal(first.messages[0].text, '保存失败')

    await observer.registry.resolve(first.snapshotId, first.elements[1].ref).click()
    assert.equal(await page.locator('#save').getAttribute('data-clicked'), 'true')

    const second = await observer.observe(page)
    assert.notEqual(second.snapshotId, first.snapshotId)
    assert.throws(() => observer.registry.resolve(first.snapshotId, first.elements[0].ref), /页面快照已失效/)
  } finally {
    await browser.close()
  }
})

test('marks truncated option text so full-name and negative data strategies cannot trust partial labels', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<div role="option">一个超过观察预算的完整考试名称</div><div role="option">数学</div>')
    const snapshot = await new PageObserver({ maxTextLength: 4 }).observe(page)
    assert.equal(snapshot.elements[0].text, '一个超过')
    assert.equal(snapshot.elements[0].textTruncated, true)
    assert.equal(snapshot.elements[1].textTruncated, false)
  } finally { await browser.close() }
})

test('limits returned elements while reporting truncation', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<button>一</button><button>二</button><button>三</button>')
    const snapshot = await new PageObserver({ maxElements: 2 }).observe(page)
    assert.equal(snapshot.stats.discoveredElements, 3)
    assert.equal(snapshot.stats.returnedElements, 2)
    assert.equal(snapshot.stats.truncated, true)
  } finally {
    await browser.close()
  }
})

test('keeps an element ref bound to the observed DOM node when candidate indexes shift', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<button id="target" onclick="this.dataset.clicked=\'true\'">选择考试</button>')
    const observer = new PageObserver()
    const snapshot = await observer.observe(page)
    const target = snapshot.elements.find(element => element.name === '选择考试')
    assert.ok(target)

    await page.evaluate(() => {
      const inserted = document.createElement('button')
      inserted.id = 'inserted'
      inserted.textContent = '异步插入的控件'
      document.body.prepend(inserted)
    })
    await observer.registry.resolve(snapshot.snapshotId, target.ref).click()

    assert.equal(await page.locator('#target').getAttribute('data-clicked'), 'true')
    assert.equal(await page.locator('#inserted').getAttribute('data-clicked'), null)
  } finally {
    await browser.close()
  }
})

test('容器注册为真实引用，行按钮有父链，限定弹窗计数不会包含背景且预算缺失不伪造引用', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<button>保存</button><section role="dialog" aria-label="编辑">
      <button id="save" onclick="this.dataset.saved='yes'">保存</button></section>
      <table aria-label="订单"><tbody><tr><td>甲</td><td><button>保存</button></td></tr>
      <tr><td>乙</td><td><button>保存</button></td></tr></tbody></table>`)
    const observer = new PageObserver()
    const snapshot = await observer.observe(page)
    const dialogRef = snapshot.dialogs[0].elementRef
    const tableRef = snapshot.tables[0].elementRef
    assert.ok(dialogRef)
    assert.ok(tableRef)
    assert.equal(snapshot.elements.find(element => element.ref === dialogRef)?.role, 'dialog')
    const row = snapshot.elements.find(element => element.role === 'row' && element.text?.startsWith('乙'))
    assert.ok(row)
    assert.equal(row.containerRef, tableRef)
    assert.ok(snapshot.elements.some(element => element.role === 'button' && element.containerRef === row.ref))
    const save = snapshot.elements.find(element => element.role === 'button' && element.containerRef === dialogRef)
    assert.ok(save)
    const executor = new SingleActionExecutor(page, observer.registry, 'http://localhost', '/private/tmp')
    assert.equal((await executor.execute(snapshot.snapshotId, { action: 'expectCount', containerRef: dialogRef, role: 'button', name: '保存', exact: true, count: 1, assertionId: 'count' })).ok, true)
    assert.equal((await executor.execute(snapshot.snapshotId, { action: 'click', elementRef: save.ref })).ok, true)
    assert.equal(await page.locator('#save').getAttribute('data-saved'), 'yes')
    const incorrect = await executor.execute(snapshot.snapshotId, { action: 'expectCount', containerRef: dialogRef, role: 'button', name: '保存', exact: true, count: 4, assertionId: 'wrong-count' })
    assert.equal(incorrect.ok, false)
    assert.match(incorrect.message, /实际 1 个/)
    await observer.observe(page)
    assert.throws(() => observer.registry.resolve(snapshot.snapshotId, dialogRef), /已失效/)
    const limited = await new PageObserver({ maxElements: 1 }).observe(page)
    assert.equal(limited.stats.truncated, true)
    assert.equal(limited.dialogs[0].elementRef, undefined)
    for (const element of limited.elements) assert.ok(!element.containerRef || limited.elements.some(parent => parent.ref === element.containerRef))
  } finally { await browser.close() }
})
