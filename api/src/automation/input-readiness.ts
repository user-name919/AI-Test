import type { Locator } from 'playwright'

type ValueInput = { action: 'fill' } | { action: 'uploadFile' }
  | { action: 'selectOption'; value: string; optionBy: 'value' | 'label' | 'valueOrLabel' }

/** Read-only preflight: failure here has not dispatched the requested input. */
export async function waitForInputReady(locator: Locator, input: ValueInput, signal?: AbortSignal, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let reason = '控件尚未就绪'
  do {
    signal?.throwIfAborted()
    const remaining = Math.max(1, deadline - Date.now())
    await locator.waitFor({ state: input.action === 'uploadFile' ? 'attached' : 'visible', timeout: remaining })
    const state = await locator.evaluate((element, input) => {
      const tag = element.tagName.toLowerCase()
      if (input.action === 'uploadFile') {
        return tag === 'input' && (element as HTMLInputElement).type === 'file'
          ? { ready: true } : { invalid: '上传目标不是原生文件输入框' }
      }
      if (input.action === 'fill') {
        if (tag !== 'input' && tag !== 'textarea' && !(element as HTMLElement).isContentEditable) return { invalid: '填值目标不是可编辑控件' }
        if (tag === 'input' && ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden', 'image', 'range', 'color'].includes((element as HTMLInputElement).type)) return { invalid: '该输入类型不支持 fill' }
        return { ready: true }
      }
      if (tag !== 'select') return { invalid: '选择目标不是原生 select' }
      const found = Array.from((element as HTMLSelectElement).options).some(option =>
        input.optionBy === 'value' ? option.value === input.value
          : input.optionBy === 'label' ? option.label === input.value
            : option.value === input.value || option.label === input.value)
      return { ready: found, reason: '原生下拉尚无指定选项，未派发选择操作' }
    }, input, { timeout: remaining })
    if (state.invalid) throw new Error(`${state.invalid}；未派发操作`)
    const enabled = input.action === 'uploadFile' || await locator.isEnabled({ timeout: Math.max(1, deadline - Date.now()) })
    const editable = input.action !== 'fill' || await locator.isEditable({ timeout: Math.max(1, deadline - Date.now()) })
    if (state.ready && enabled && editable) { signal?.throwIfAborted(); return }
    reason = !enabled ? '控件仍禁用，未派发操作' : !editable ? '控件仍只读，未派发操作' : state.reason ?? reason
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))))
  } while (Date.now() < deadline)
  throw new Error(`Timeout ${timeoutMs}ms：${reason}`)
}
