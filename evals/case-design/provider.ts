import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { analyzePrd, type SourceDocument } from '../../api/src/model'
import { getModelConfig } from '../../api/src/model-config'
import { createEvidenceDocuments } from '../../api/src/modules/case-design/documents'
import { extractFacts, factsPromptVersion } from '../../api/src/modules/case-design/fact-extractor'
import { planFromFacts, modelingPromptVersion, planningPromptVersion } from '../../api/src/modules/case-design/scenario-planner'
import { generateCases, generatingPromptVersion } from '../../api/src/modules/case-design/case-generator'
import { checkCaseQuality, checkingPromptVersion } from '../../api/src/modules/case-design/quality-checker'
import { loadStageSkills } from '../../api/src/modules/case-design/skill-loader'
import type { CaseDesign, DesignRun } from '@quality-ai/contracts/case-design'

type Variant='legacy'|'pipeline'|'skills'
export default class CaseDesignProvider {
  private variant:Variant
  private legacySourceHash?:string
  constructor(options:{config?:{variant?:Variant;legacySourceHash?:string}}={}){
    this.variant=options.config?.variant??'pipeline'
    if(!['legacy','pipeline','skills'].includes(this.variant))throw new Error('未知评估流程')
    if(this.variant==='legacy'){
      const actual=createHash('sha256').update(readFileSync(new URL('../../api/src/model.ts',import.meta.url))).digest('hex')
      if(!options.config?.legacySourceHash||options.config.legacySourceHash!==actual)throw new Error('旧生成器基线发生变化，必须先审核并重新固定版本，不能静默比较')
      this.legacySourceHash=actual
    }
  }
  id(){return `quality-ai-${this.variant}`}
  async callApi(prompt:string){
    const started=Date.now()
    const stages:DesignRun[]=[]
    let activeRun:DesignRun|undefined
    let provenance:Record<string,string>={variant:this.variant,humanReview:'pending',evidenceMode:process.env.QUALITY_AI_EVAL_MODE==='stub'?'stub':'real-model'}
    let failedStage:string='input'
    try{
      const input=JSON.parse(prompt) as {sampleId:string;documents:SourceDocument[]}
      if(!input.sampleId||!Array.isArray(input.documents)||!input.documents.length)throw new Error('评估输入需要 sampleId 和 documents')
      const inputHash=createHash('sha256').update(JSON.stringify(input.documents)).digest('hex')
      provenance={...provenance,sampleId:input.sampleId,inputHash}
      failedStage='configuration'
      const config=getModelConfig()
      provenance={...provenance,model:config.model,protocol:config.protocol,modelConfigHash:createHash('sha256').update(JSON.stringify({...config,apiKey:undefined})).digest('hex')}
      if(this.variant==='legacy'){
        provenance={...provenance,legacySourceHash:this.legacySourceHash!}
        failedStage='legacy'
        const result=await analyzePrd(input.documents)
        return {output:JSON.stringify({...provenance,analysis:result.result}),metadata:{durationMs:Date.now()-started},cached:false}
      }
      const now=new Date().toISOString()
      failedStage='documents'
      const documents=createEvidenceDocuments(input.documents)
      const design:CaseDesign={id:randomUUID(),name:input.sampleId,revision:1,inputHash,documents,createdAt:now,updatedAt:now}
      const run:DesignRun={id:randomUUID(),designId:design.id,attempt:1,stage:'extracting',status:'running',inputRevision:1,inputHash,model:config.model,modelConfigHash:provenance.modelConfigHash,protocol:config.protocol,promptVersion:'evaluation-production-pipeline-v1',skills:[],createdAt:now,updatedAt:now,statistics:{calls:0,inputCharacters:0,outputCharacters:0},output:{facts:[],questions:[],processedBlockIds:[],unprocessedBlockIds:documents.flatMap(document=>document.blocks.filter(block=>block.text.trim()).map(block=>block.id))}}
      activeRun=run
      const signal=AbortSignal.timeout(15*60*1000)
      for(const stage of ['extracting','modeling','planning','generating','checking'] as const){
        failedStage=stage
        run.stage=stage;run.status='running'
        run.promptVersion=stage==='generating'?generatingPromptVersion:stage==='extracting'?factsPromptVersion:stage==='checking'?checkingPromptVersion:stage==='modeling'?modelingPromptVersion:planningPromptVersion
        run.skills=[]
        const skills=loadStageSkills(stage,this.variant==='skills')
        run.skills=skills.map(({id,version,hash})=>({id,version,hash}))
        if(stage==='extracting')await extractFacts(design,run,config,signal,()=>{},skills)
        else if(stage==='modeling'||stage==='planning')await planFromFacts(design,run,config,signal,()=>{},skills)
        else if(stage==='generating')await generateCases(run,config,signal,()=>{},skills)
        else await checkCaseQuality(design,run,config,signal,()=>{},skills)
        run.status='completed';run.updatedAt=new Date().toISOString()
        stages.push(structuredClone(run))
      }
      return {output:JSON.stringify({...provenance,design,stages,output:run.output}),metadata:{durationMs:Date.now()-started,calls:run.statistics.calls},cached:false}
    }catch(error){
      const message=error instanceof Error?error.message:String(error)
      const failedRun=activeRun?{...structuredClone(activeRun),status:'failed' as const,error:message,updatedAt:new Date().toISOString()}:undefined
      return {error:message,metadata:{variant:this.variant,provenance,failedStage,completedStages:stages.map(run=>run.stage),stages,failedRun,durationMs:Date.now()-started},cached:false}
    }
  }
}
