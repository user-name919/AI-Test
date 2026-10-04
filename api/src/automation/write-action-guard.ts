import type { Locator } from 'playwright'
import type { CaseExecutionContract, ExecutionWriteAuthorization, WriteGuardEvidence } from '@quality-ai/contracts'

export class WriteActionBlockedError extends Error {
  constructor(readonly evidence: WriteGuardEvidence) { super(evidence.reason) }
}

/** DOM heuristics are conservative evidence, not a proof that arbitrary page JavaScript is read-only. */
export async function guardWriteAction(
  locator: Locator,
  action: {action:string;key?:string;writeOperationIndex?:number},
  contract: CaseExecutionContract | undefined,
  authorization: ExecutionWriteAuthorization | undefined,
  targetUrl: string,
): Promise<WriteGuardEvidence | undefined> {
  const dom = await locator.evaluate((element, key) => {
    const control = element.closest('button,input,[role="button"],a[href]') ?? element
    const root = control.getRootNode() as Document | ShadowRoot
    const labelledBy = (control.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id=>root.getElementById(id)?.textContent ?? '').join(' ')
    const dialog=control.closest('[role="dialog"],[role="alertdialog"]')
    const dialogTitle=dialog ? [dialog.getAttribute('aria-label'),...(dialog.getAttribute('aria-labelledby')??'').split(/\s+/).map(id=>root.getElementById(id)?.textContent??''),dialog.querySelector('h1,h2,h3,[role="heading"]')?.textContent].filter(Boolean).join(' ') : ''
    const name = [control.getAttribute('aria-label'),labelledBy,control.getAttribute('title'),control.textContent,
      control instanceof HTMLInputElement && ['submit','button','reset'].includes(control.type) ? control.value : ''].filter(Boolean).join(' ').replace(/\s+/g,' ').trim()
    const label=name+(dialogTitle&&/(确定|确认|继续|执行|\b(confirm|ok|yes|continue)\b)/i.test(name)?` 弹窗：${dialogTitle}`:'')
    const form = control instanceof HTMLButtonElement || control instanceof HTMLInputElement ? control.form : null
    const editable = (element instanceof HTMLInputElement && !['button','submit','reset','checkbox','radio','file','image','hidden'].includes(element.type)) || element instanceof HTMLTextAreaElement || (element instanceof HTMLElement && element.isContentEditable)
    const submitButton = (control instanceof HTMLButtonElement && control.type==='submit') || (control instanceof HTMLInputElement && ['submit','image'].includes(control.type))
    const implicit = key==='Enter' && control instanceof HTMLInputElement && !['button','reset','checkbox','radio','file'].includes(control.type)
    return {label:label.slice(0,1000),labelTruncated:label.length>1000,role:control.getAttribute('role')??'',editable,
      formMethod:form ? ((submitButton && control.getAttribute('formmethod')) || form.method).toLowerCase() : undefined,
      submits:!!form && (submitButton || implicit),url:element.ownerDocument.location.href,searchForm:form?.getAttribute('role')==='search'||/^(查询|搜索|筛选|search|filter)(\s|$)/i.test(label)}
  }, action.action==='press'?action.key:undefined, {timeout:10000})
  const activates=action.action!=='press'||action.key==='Enter'||action.key==='Space'
  const option=dom.role==='option'||dom.role==='tab'
  // Ordinary typing/combobox Enter is not inferred to be a write without form evidence.
  const destructiveLabel=activates&&!option&&(!dom.editable||dom.submits)&&/(删除|清空|销毁|作废|撤销|发布|付款|支付|转账|退款|发送|保存|提交|审批|审核通过|批量执行|生成报告|\b(delete|remove|destroy|publish|pay|purchase|transfer|refund|send|save|submit|approve)\b)/i.test(dom.label)
  const reasons=[...(destructiveLabel?[`控件名称包含可能的业务写操作：${dom.label}`]:[]),
    ...(activates&&dom.labelTruncated?['控件名称过长，不能据截断内容确认是只读操作']:[]),
    ...(activates&&dom.submits&&!(dom.formMethod==='get'&&dom.searchForm)?[`原生表单可能通过 ${dom.formMethod?.toUpperCase()} 提交`]:[]),
    ...(action.action==='press'&&action.key==='Delete'&&!dom.editable?['非文本编辑控件的 Delete 可能删除业务记录']:[])]
  if(!reasons.length&&action.writeOperationIndex===undefined)return undefined
  const operation=action.writeOperationIndex===undefined?undefined:contract?.writeOperations?.[action.writeOperationIndex]
  const allowed=!!operation&&authorization?.targetUrl===targetUrl&&JSON.stringify(authorization.operations)===JSON.stringify(contract?.writeOperations)
  const evidence:WriteGuardEvidence={allowed,observedAt:new Date().toISOString(),pageUrl:dom.url,label:dom.label,
    operationIndex:action.writeOperationIndex,operation,
    reason:allowed?`允许尝试已授权操作 #${action.writeOperationIndex!+1}：${operation}。${reasons.join('；')||'动作主动声明写操作'}；许可不代表执行成功，也不证明自然语言范围已被完全验证。`
      :`业务写操作已阻止，未派发动作。${reasons.join('；')||'动作引用了写操作'}；动作引用：${action.writeOperationIndex===undefined?'未提供':action.writeOperationIndex}（从0开始）。缺少有效 writeOperationIndex 或本次授权，请回到用例声明操作范围并重新确认执行。`}
  if(!allowed)throw new WriteActionBlockedError(evidence)
  return evidence
}
