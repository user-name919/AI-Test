import { z } from 'zod'

export const evidenceRefSchema = z.object({ documentId: z.string().min(1), blockId: z.string().min(1), quote: z.string().min(1) })
export const documentBlockSchema = z.object({
  id: z.string().min(1), documentId: z.string().min(1),
  kind: z.enum(['heading', 'paragraph', 'table', 'image_placeholder']),
  page: z.number().int().positive().optional(), section: z.string().optional(),
  text: z.string(), warnings: z.array(z.string()),
})
export const designDocumentSchema = z.object({
  id: z.string().uuid(), fileName: z.string().min(1), role: z.enum(['prd', 'interface']),
  contentHash: z.string(), version: z.number().int().positive(),
  blocks: z.array(documentBlockSchema), warnings: z.array(z.string()),
})
export const requirementFactSchema = z.object({
  id: z.string().min(1), statement: z.string().min(1), kind: z.enum(['explicit', 'inferred', 'unresolved']),
  evidence: z.array(evidenceRefSchema), relatedQuestionIds: z.array(z.string()),
})
export interface CaseDesign {
  id: string
  name: string
  revision: number
  documents: DesignDocument[]
  inputHash: string
  createdAt: string
  updatedAt: string
}
export type DesignDocument = z.infer<typeof designDocumentSchema>
export type DocumentBlock = z.infer<typeof documentBlockSchema>
export type EvidenceRef = z.infer<typeof evidenceRefSchema>
export type RequirementFact = z.infer<typeof requirementFactSchema>
