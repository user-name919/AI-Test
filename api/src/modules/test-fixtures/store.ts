import { constants } from 'node:fs'
import { mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fixtureMetadataSchema, fixtureUploadSchema, maxFixtureBytes, type TestFixture } from '@quality-ai/contracts/test-fixtures'
import { getRuntimePaths } from '../../config/paths'
import type { CaseExecutionContract } from '@quality-ai/contracts'
import { RuntimeDataBindingBlockedError } from '../../test-data-binding'

const root = () => resolve(getRuntimePaths().dataRoot, 'test-fixtures')
const fingerprint = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex')

export function validateFixtureReference(id: string, contract?: CaseExecutionContract) {
  if (!contract?.dataBindings.some(binding => binding.mode === 'fixture'
    ? binding.fixture?.value === id && Boolean(binding.fixture.evidence.trim())
    : binding.mode === 'manual' && binding.manual?.value === id && Boolean(binding.manual.rationale.trim()))) {
    throw new RuntimeDataBindingBlockedError('上传附件 ID 必须来自最终契约有依据的 fixture/manual 数据，不能读取任意路径或借用其他附件')
  }
}

async function registeredPath(id: string, file: 'metadata.json' | 'payload') {
  if (!fixtureMetadataSchema.shape.id.safeParse(id).success) throw new Error('测试附件 ID 无效')
  const base = await realpath(root())
  const path = resolve(base, id, file)
  const real = await realpath(path)
  const rel = relative(base, real)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error('测试附件不在受控目录内')
  return path
}

export async function saveTestFixture(input: unknown): Promise<TestFixture> {
  const parsed = fixtureUploadSchema.parse(input)
  const buffer = Buffer.from(parsed.base64, 'base64')
  if (buffer.length > maxFixtureBytes || buffer.toString('base64') !== parsed.base64) throw new Error('测试附件编码无效或超过 10MB')
  const fixture = fixtureMetadataSchema.parse({ id: randomUUID(), name: parsed.name, mimeType: parsed.mimeType, size: buffer.length, sha256: fingerprint(buffer), createdAt: new Date().toISOString() })
  const directory = resolve(root(), fixture.id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(resolve(directory, 'payload'), buffer, { flag: 'wx', mode: 0o600 })
  // 元数据最后写入；中途中断的文件不出现在可用附件列表，不覆盖原附件。
  await writeFile(resolve(directory, 'metadata.json'), JSON.stringify(fixture), { flag: 'wx', mode: 0o600 })
  return fixture
}

export async function loadTestFixture(id: string) {
  const metadata = fixtureMetadataSchema.parse(JSON.parse(await readFile(await registeredPath(id, 'metadata.json'), 'utf8')))
  if (metadata.id !== id) throw new Error('测试附件元数据 ID 不一致')
  const handle = await open(await registeredPath(id, 'payload'), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxFixtureBytes || stat.size !== metadata.size) throw new Error('测试附件大小或类型已改变，请重新登记')
    const buffer = await handle.readFile()
    if (buffer.length !== metadata.size || fingerprint(buffer) !== metadata.sha256) throw new Error('测试附件内容已改变，请重新登记')
    return { metadata, buffer }
  } finally { await handle.close() }
}

export async function listTestFixtures() {
  let entries: string[]
  try { entries = await readdir(root()) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { fixtures: [], warnings: [] }
    throw error
  }
  const fixtures: TestFixture[] = [], warnings: string[] = []
  for (const id of entries.filter(id => fixtureMetadataSchema.shape.id.safeParse(id).success).sort()) {
    try { fixtures.push((await loadTestFixture(id)).metadata) }
    catch { warnings.push(`附件 ${id} 不可用，文件缺失、已改变或元数据无效`) }
  }
  return { fixtures, warnings }
}
