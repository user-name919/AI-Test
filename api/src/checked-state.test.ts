import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'
import { readCheckedState } from './checked-state'
import { PageObserver } from './page-observer'
import { SingleActionExecutor } from './single-action-executor'
import { assertFixedLocator } from './fixed-locator-assertion'

test('两模式与快照区分原生半选、ARIA mixed、无效值和真实未选中', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<input id="native" aria-label="原生半选" type="checkbox">
      <div role="checkbox" aria-label="半选" aria-checked="mixed">半选</div>
      <div role="checkbox" aria-label="无效" aria-checked="invalid">无效</div>
      <div role="checkbox" aria-label="未选中" aria-checked="false">未选中</div>
      <input type="checkbox" aria-label="已选中" checked>`)
    await page.locator('#native').evaluate(element => { (element as HTMLInputElement).indeterminate = true })
    const observer = new PageObserver()
    const snapshot = await observer.observe(page)
    const element = (name: string) => {
      const item = snapshot.elements.find(candidate => candidate.name === name)
      assert.ok(item)
      return item
    }
    for (const name of ['原生半选', '半选']) {
      assert.equal(element(name).checked, undefined)
      assert.equal(element(name).checkedState, 'mixed')
      assert.equal(await readCheckedState(observer.registry.resolve(snapshot.snapshotId, element(name).ref)), 'mixed')
    }
    assert.equal(element('无效').checkedState, 'unknown')
    assert.equal(element('无效').checked, undefined)
    assert.equal(await readCheckedState(page.getByLabel('无效', { exact: true })), 'invalid')
    assert.equal(await readCheckedState(page.getByLabel('未选中', { exact: true })), false)
    assert.equal(await readCheckedState(page.getByLabel('已选中', { exact: true })), true)
    const executor = new SingleActionExecutor(page, observer.registry, 'http://localhost', '/private/tmp')
    const [dynamic] = await Promise.all([
      executor.execute(snapshot.snapshotId, { action: 'expectChecked', elementRef: element('半选').ref, checked: false, assertionId: 'wrong' }),
      assert.rejects(assertFixedLocator(page.locator('#native'), { action: 'expectChecked', locator: { by: 'css', value: '#native' }, checked: false }, undefined), /实际 "mixed"；预期 false/),
    ])
    assert.equal(dynamic.ok, false)
    assert.match(dynamic.message, /实际 mixed/)
    assert.equal((await executor.execute(snapshot.snapshotId, { action: 'expectChecked', elementRef: element('未选中').ref, checked: false, assertionId: 'right' })).ok, true)
  } finally { await browser.close() }
})
