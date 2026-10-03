import { z } from 'zod'

export const maxFixtureBytes = 10 * 1024 * 1024
export const fixtureMetadataSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(180).refine(name => !/[\\/]/.test(name) && ![...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && name !== '.' && name !== '..', '文件名不能包含路径或控制字符'),
  mimeType: z.string().min(1).max(120).regex(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/),
  size: z.number().int().min(0).max(maxFixtureBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
})
export const fixtureUploadSchema = fixtureMetadataSchema.pick({ name: true, mimeType: true }).extend({
  base64: z.string().max(Math.ceil(maxFixtureBytes / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
})
export type TestFixture = z.infer<typeof fixtureMetadataSchema>
