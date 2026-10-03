// This function is serialized by Playwright and runs in the inspected page.
// Keep it as plain JavaScript so Node-side transpiler helpers never leak into the browser context.
export function observePageInBrowser({ selector, snapshotId, refAttribute, maxElements, maxTextLength, maxTableRows }) {
  const normalize = value => (value ?? '').replace(/\s+/g, ' ').trim()
  const compact = value => normalize(value).slice(0, maxTextLength)
  const isVisible = element => {
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && element.getAttribute('aria-hidden') !== 'true'
      && rect.width > 0
      && rect.height > 0
  }
  const labelledBy = element => normalize(element.getAttribute('aria-labelledby')
    ?.split(/\s+/)
    .map(id => document.getElementById(id)?.textContent ?? '')
    .join(' '))
  const explicitLabel = element => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      return normalize([...element.labels ?? []].map(label => label.textContent ?? '').join(' '))
    }
    return ''
  }
  const inferRole = element => {
    const explicit = element.getAttribute('role')
    if (explicit) return explicit
    const tag = element.tagName.toLowerCase()
    if (tag === 'button') return 'button'
    if (tag === 'a') return 'link'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return 'combobox'
    if (tag === 'table') return 'table'
    if (tag === 'tr') return 'row'
    if (tag === 'dialog' || element.matches('.el-dialog,.el-drawer')) return 'dialog'
    if (element instanceof HTMLInputElement) {
      if (element.type === 'checkbox') return 'checkbox'
      if (element.type === 'radio') return 'radio'
      if (['button', 'submit', 'reset'].includes(element.type)) return 'button'
      return 'textbox'
    }
    return element.getAttribute('contenteditable') === 'true' ? 'textbox' : tag
  }
  const containerName = element => {
    const container = element.closest('[role="dialog"],.el-dialog,.el-drawer,form,table,[role="table"]')
    if (!container) return undefined
    const heading = container.querySelector('[role="heading"],h1,h2,h3,.el-dialog__title,.el-drawer__title,legend,caption')
    return compact(heading?.textContent) || compact(container.getAttribute('aria-label')) || container.tagName.toLowerCase()
  }
  document.querySelectorAll(`[${refAttribute}]`).forEach(element => element.removeAttribute(refAttribute))
  const containerSelector = 'dialog,[role="dialog"],.el-dialog,.el-drawer,form,table,[role="table"],tr,[role="row"]'
  // 原交互元素优先保留预算；容器也注册为 e 引用，而不是不可操作的 d/t 摘要编号。
  const candidates = [...new Set([...document.querySelectorAll(selector), ...document.querySelectorAll(containerSelector)])]
  const visibleCandidates = candidates.filter(isVisible)
  const selectedElements = visibleCandidates.slice(0, maxElements)
  const references = new Map(selectedElements.map((element, index) => [element, `e${index + 1}`]))
  const elements = selectedElements.map(element => {
    const ref = references.get(element)
    element.setAttribute(refAttribute, `${snapshotId}:${ref}`)
    const label = explicitLabel(element) || labelledBy(element) || compact(element.getAttribute('aria-label'))
    const placeholder = compact(element.getAttribute('placeholder')) || undefined
    const rawText = normalize(element.innerText || element.textContent)
    const text = compact(rawText) || undefined
    const name = label || placeholder || compact(element.getAttribute('title')) || text || compact(element.getAttribute('name'))
    const value = 'value' in element && !(element instanceof HTMLInputElement && element.type === 'password')
      ? compact(String(element.value)) || undefined
      : undefined
    const disabled = 'disabled' in element && Boolean(element.disabled)
    const ariaDisabled = element.getAttribute('aria-disabled') === 'true'
    const rawChecked = element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)
      ? element.indeterminate ? 'mixed' : element.checked ? 'true' : 'false'
      : element.getAttribute('aria-checked')
    const checked = rawChecked === 'true' ? true : rawChecked === 'false' ? false : undefined
    const checkedState = rawChecked === null ? undefined : rawChecked === 'true' ? 'checked' : rawChecked === 'false' ? 'unchecked' : rawChecked === 'mixed' ? 'mixed' : 'unknown'
    const selected = element instanceof HTMLOptionElement
      ? element.selected
      : element.getAttribute('aria-selected') === null ? undefined : element.getAttribute('aria-selected') === 'true'
    const expanded = element.getAttribute('aria-expanded') === null ? undefined : element.getAttribute('aria-expanded') === 'true'
    const required = 'required' in element
      ? Boolean(element.required)
      : element.getAttribute('aria-required') === 'true' || undefined
    return {
      ref,
      tag: element.tagName.toLowerCase(),
      role: inferRole(element),
      name,
      label: label || undefined,
      placeholder,
      value,
      text,
      textTruncated: rawText.length > maxTextLength,
      nameTruncated: normalize(element.getAttribute('aria-label')).length > maxTextLength
        || normalize(element.getAttribute('title')).length > maxTextLength
        || normalize(element.getAttribute('name')).length > maxTextLength
        || normalize(element.getAttribute('placeholder')).length > maxTextLength,
      visible: true,
      enabled: !disabled && !ariaDisabled,
      checked,
      checkedState,
      selected,
      expanded,
      required,
      container: containerName(element),
      containerRef: references.get(element.parentElement?.closest(containerSelector)),
    }
  })
  const dialogs = [...document.querySelectorAll('dialog,[role="dialog"],.el-dialog,.el-drawer')]
    .filter(isVisible)
    .slice(0, 10)
    .map((dialog, index) => ({
      ref: `d${index + 1}`,
      elementRef: references.get(dialog),
      title: compact(dialog.querySelector('[role="heading"],h1,h2,h3,.el-dialog__title,.el-drawer__title')?.textContent)
        || compact(dialog.getAttribute('aria-label')),
      modal: dialog.getAttribute('aria-modal') === 'true' || dialog.classList.contains('el-dialog'),
    }))
  const tableCandidates = [...document.querySelectorAll('table,[role="table"],.el-table')]
    .filter(isVisible)
    .filter(table => !table.parentElement?.closest('table,[role="table"],.el-table'))
  const tables = tableCandidates.slice(0, 10).map((table, index) => {
    const columns = [...table.querySelectorAll('thead th,[role="columnheader"]')]
      .map(column => compact(column.textContent))
      .filter(Boolean)
    const rows = [...table.querySelectorAll('tbody tr,[role="row"]')]
      .filter(row => !row.closest('thead'))
    const sampleRows = rows.slice(0, maxTableRows).map(row => [...row.querySelectorAll('td,[role="cell"],[role="gridcell"]')]
      .map(cell => compact(cell.textContent)))
      .filter(row => row.length > 0)
    return {
      ref: `t${index + 1}`,
      elementRef: references.get(table),
      name: compact(table.getAttribute('aria-label')) || compact(table.querySelector('caption')?.textContent),
      columns,
      rowCount: rows.length,
      sampleRows,
    }
  })
  const messages = [...document.querySelectorAll('[role="alert"],[role="status"],.el-message,.el-notification,.el-form-item__error')]
    .filter(isVisible)
    .map(element => {
      const classes = element.className.toString()
      const type = element.getAttribute('role') === 'alert'
        ? 'alert'
        : element.getAttribute('role') === 'status'
          ? 'status'
          : classes.includes('el-form-item__error')
            ? 'error'
            : classes.includes('notification') ? 'notification' : 'message'
      return { type, text: compact(element.textContent) }
    })
    .filter(message => message.text)
    .slice(0, 20)
  const loading = [...document.querySelectorAll('[aria-busy="true"],.el-loading-mask')].some(isVisible)
  return { loading, discoveredElements: visibleCandidates.length, elements, dialogs, tables, messages }
}
