// This function is serialized by Playwright and runs in the inspected page.
// Keep it as plain JavaScript so Node-side transpiler helpers never leak into the browser context.
export function observePageInBrowser({ selector, snapshotId, refAttribute, maxElements, maxTextLength, maxTableRows }) {
  const normalize = value => (value ?? '').replace(/\s+/g, ' ').trim()
  const compact = value => normalize(value).slice(0, maxTextLength)
  // Match Playwright's open-shadow CSS traversal; closed roots remain inaccessible.
  const query = (root, selector) => {
    const result = [...root.querySelectorAll(selector)]
    const pending = [...root.querySelectorAll('*')].filter(element => element.shadowRoot)
    if (root instanceof Element && root.shadowRoot) pending.unshift(root)
    for (const host of pending) result.push(...query(host.shadowRoot, selector))
    return result
  }
  const parent = element => element.assignedSlot || element.parentElement || element.getRootNode().host
  const closest = (element, selector) => {
    for (let current = element; current; current = parent(current)) if (current.matches(selector)) return current
    return undefined
  }
  const isVisible = element => {
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    let hiddenAncestor = false
    for (let ancestor = parent(element); ancestor; ancestor = parent(ancestor)) {
      const ancestorStyle = window.getComputedStyle(ancestor)
      if (ancestor.getAttribute('aria-hidden') === 'true' || ancestorStyle.display === 'none' || ancestorStyle.opacity === '0') { hiddenAncestor = true; break }
    }
    return !hiddenAncestor && style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && element.getAttribute('aria-hidden') !== 'true'
      && rect.width > 0
      && rect.height > 0
  }
  const labelledBy = element => normalize(element.getAttribute('aria-labelledby')
    ?.split(/\s+/)
    .map(id => element.getRootNode().getElementById(id)?.textContent ?? '')
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
    const container = closest(element, '[role="dialog"],.el-dialog,.el-drawer,form,table,[role="table"]')
    if (!container) return undefined
    const heading = query(container, '[role="heading"],h1,h2,h3,.el-dialog__title,.el-drawer__title,legend,caption')[0]
    return compact(heading?.textContent) || compact(container.getAttribute('aria-label')) || container.tagName.toLowerCase()
  }
  query(document, `[${refAttribute}]`).forEach(element => element.removeAttribute(refAttribute))
  const containerSelector = 'dialog,[role="dialog"],.el-dialog,.el-drawer,form,table,[role="table"],tr,[role="row"]'
  // 原交互元素优先保留预算；容器也注册为 e 引用，而不是不可操作的 d/t 摘要编号。
  const candidates = [...new Set([...query(document, selector), ...query(document, containerSelector)])]
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
      containerRef: references.get(closest(parent(element), containerSelector)),
    }
  })
  const dialogs = query(document, 'dialog,[role="dialog"],.el-dialog,.el-drawer')
    .filter(isVisible)
    .slice(0, 10)
    .map((dialog, index) => ({
      ref: `d${index + 1}`,
      elementRef: references.get(dialog),
      title: compact(query(dialog, '[role="heading"],h1,h2,h3,.el-dialog__title,.el-drawer__title')[0]?.textContent)
        || compact(dialog.getAttribute('aria-label')),
      modal: dialog.getAttribute('aria-modal') === 'true' || dialog.classList.contains('el-dialog'),
    }))
  const tableCandidates = query(document, 'table,[role="table"],.el-table')
    .filter(isVisible)
    .filter(table => !closest(parent(table), 'table,[role="table"],.el-table'))
  const tables = tableCandidates.slice(0, 10).map((table, index) => {
    const columns = query(table, 'thead th,[role="columnheader"]')
      .map(column => compact(column.textContent))
      .filter(Boolean)
    const rows = query(table, 'tbody tr,[role="row"]')
      .filter(row => !closest(row, 'thead'))
    const sampleRows = rows.slice(0, maxTableRows).map(row => query(row, 'td,[role="cell"],[role="gridcell"]')
      .map(cell => compact(cell.textContent)))
      .filter(row => row.length > 0)
    return {
      ref: `t${index + 1}`,
      elementRef: references.get(table),
      name: compact(table.getAttribute('aria-label')) || compact(query(table, 'caption')[0]?.textContent),
      columns,
      rowCount: rows.length,
      sampleRows,
    }
  })
  const messages = query(document, '[role="alert"],[role="status"],.el-message,.el-notification,.el-form-item__error')
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
  const loading = query(document, '[aria-busy="true"],.el-loading-mask').some(isVisible)
  return { loading, discoveredElements: visibleCandidates.length, elements, dialogs, tables, messages }
}
