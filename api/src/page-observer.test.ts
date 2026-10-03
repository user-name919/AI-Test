import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'
import { PageObserver } from './page-observer'

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
    assert.equal(first.elements.length, 2)
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
