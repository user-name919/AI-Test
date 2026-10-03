import { setTimeout } from 'node:timers/promises'
import type { Locator } from 'playwright'
import type { AutomationPlan } from '@quality-ai/contracts'

type Assertion=Extract<AutomationPlan['steps'][number],{action:'expectVisible'|'expectHidden'|'expectEnabled'|'expectDisabled'|'expectChecked'|'expectValue'|'expectElementText'|'expectAttribute'}>
export async function assertFixedLocator(locator:Locator,step:Assertion,expectedValue:string|undefined,signal?:AbortSignal){
  signal?.throwIfAborted()
  if(step.action==='expectVisible'||step.action==='expectHidden'){
    await locator.waitFor({state:step.action==='expectVisible'?'visible':'hidden',timeout:10000})
    return
  }
  await locator.waitFor({state:'visible',timeout:10000})
  const deadline=Date.now()+10000
  let actual:unknown
  while(true){
    signal?.throwIfAborted()
    let matches=false
    if(step.action==='expectEnabled'||step.action==='expectDisabled'){
      actual=await locator.isEnabled({timeout:1000});matches=actual===(step.action==='expectEnabled')
    }else if(step.action==='expectChecked'){
      const ariaChecked=await locator.getAttribute('aria-checked',{timeout:1000})
      // mixed/无效 aria 值不等于 false，避免把不确定状态当未选中通过。
      actual=ariaChecked===null?await locator.isChecked({timeout:1000}):ariaChecked==='true'?true:ariaChecked==='false'?false:ariaChecked
      matches=actual===step.checked
    }else if(step.action==='expectElementText'){
      actual=await locator.innerText({timeout:1000})
      matches=typeof actual==='string'&&(step.exact?actual===step.text:actual.includes(step.text))
    }else if(step.action==='expectValue'){
      actual=await locator.inputValue({timeout:1000});matches=actual===expectedValue
    }else{
      actual=await locator.getAttribute(step.name,{timeout:1000})
      matches=step.match==='token'?typeof actual==='string'&&actual.split(/\s+/).includes(step.value):actual===step.value
    }
    if(matches)return
    if(Date.now()>=deadline)throw new Error(`${step.action} 断言失败：实际 ${JSON.stringify(actual)}；预期 ${JSON.stringify(step.action==='expectAttribute'?step.value:step.action==='expectValue'?expectedValue:step.action==='expectChecked'?step.checked:step.action==='expectElementText'?step.text:step.action==='expectEnabled')}`)
    await setTimeout(100,undefined,{signal})
  }
}
