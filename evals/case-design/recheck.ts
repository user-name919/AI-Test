import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import check, { assertionsVersion } from './assertions'

// 只重新检查已保存输出，不调用模型，不修改原始分数或人工状态。
export function recheckSavedResults(raw:string){
  const file=JSON.parse(raw)
  const rows=file.results?.results
  if(!Array.isArray(rows)||!rows.length)throw new Error('需要非空 Promptfoo 结果')
  const results=rows.map((row,index)=>{
    const original={index,sampleId:JSON.parse(row.vars.payload).sampleId,providerId:row.provider.id,originalPassed:row.success===true,originalReason:row.response?.error??row.error??row.gradingResult?.reason??null}
    if(row.response?.error||typeof row.response?.output!=='string')return {...original,status:'not_rechecked' as const,reason:'原调用错误或无输出，保留原失败，不补造结果'}
    return {...original,status:'rechecked' as const,check:check(row.response.output)}
  })
  return {sourceSha256:createHash('sha256').update(raw).digest('hex'),assertionsVersion,evidenceMode:'offline-recheck',humanReview:'pending',
    note:'仅对同一批保存输出重新检查，没有重新调用模型；结构通过不是语义通过或可执行证明。原结果保持不变。',results,
    summary:{total:results.length,originalPassed:results.filter(row=>row.originalPassed).length,recheckedPassed:results.filter(row=>row.status==='rechecked'&&row.check.pass).length,recheckedFailed:results.filter(row=>row.status==='rechecked'&&!row.check.pass).length,notRechecked:results.filter(row=>row.status==='not_rechecked').length}}
}

if(process.argv[1]&&resolve(process.argv[1])===import.meta.filename){
  const [source,destination]=process.argv.slice(2)
  if(!source||!destination)throw new Error('用法：recheck.ts 原始结果.json 新输出.json（不得已存在）')
  const result=recheckSavedResults(readFileSync(source,'utf8'))
  writeFileSync(destination,JSON.stringify(result,null,2)+'\n',{flag:'wx'})
  console.log(JSON.stringify({sourceSha256:result.sourceSha256,assertionsVersion:result.assertionsVersion,...result.summary}))
}
