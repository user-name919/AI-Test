import { z } from 'zod'
import type { CaseExecutionResult, SourceProjectSnapshot } from './contracts'

export const createMemorySchema = z.object({
  executionId:z.string().min(1),caseKey:z.string().min(1).optional(),
  lesson:z.string().trim().min(1).max(4000),
}).strict()
export const reviewMemorySchema = z.object({
  expectedRevision:z.number().int().positive(),status:z.enum(['adopted','invalid']),
  reason:z.string().trim().min(1).max(2000),
}).strict()
export const memoryReferenceSchema=z.object({
  id:z.string().uuid(),revision:z.number().int().positive(),lesson:z.string().max(4000),
  executionId:z.string(),caseKey:z.string().optional(),projectId:z.string(),targetUrl:z.string().url(),sourceCommit:z.string(),
})
export type MemoryReference=z.infer<typeof memoryReferenceSchema>
export interface QualityMemory {
  id:string
  revision:number
  status:'candidate'|'adopted'|'invalid'
  lesson:string
  origin:'human_note'
  createdAt:string
  source:{executionId:string;caseKey?:string;title:string;status:CaseExecutionResult['status'];error?:string;contractFingerprint?:string}
  scope:{projectId?:string;targetUrl:string;sourceProject?:SourceProjectSnapshot}
  reviews:Array<{revision:number;status:'adopted'|'invalid';reason:string;at:string}>
}
