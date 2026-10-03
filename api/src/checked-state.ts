import type { Locator } from 'playwright'

// 一次读取区分未选中、半选与无效状态；不能把非 true 一律转换为 false。
export async function readCheckedState(locator: Locator): Promise<boolean | string> {
  return locator.evaluate(element => {
    if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
      return element.indeterminate ? 'mixed' : element.checked
    }
    const value = element.getAttribute('aria-checked')
    return value === 'true' ? true : value === 'false' ? false : value ?? 'unknown'
  }, undefined, { timeout: 1000 })
}
