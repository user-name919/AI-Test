import type { Download, Page } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { AutomationPlan, DownloadEvidence } from '@quality-ai/contracts'

const maxBytes = 10 * 1024 * 1024
const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex')

export async function captureDownload(page: Page, trigger: () => Promise<unknown>, directory: string, downloadId: string, signal?: AbortSignal): Promise<DownloadEvidence> {
  signal?.throwIfAborted()
  let download: Download | undefined, finished = false, stopped = false
  let accept!: (download: Download) => void
  const ready = new Promise<Download>(resolve => { accept = resolve })
  const onDownload = (value: Download) => { download = value; accept(value) }
  page.once('download', onDownload)
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort = () => {}
  const boundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('下载未在 15 秒内完成；未自动重复点击')), 15000)
    abort = () => reject(signal?.reason ?? new Error('下载已取消'))
    signal?.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([boundary, (async () => {
      await trigger()
      const item = await ready
      const stream = await item.createReadStream()
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of stream) {
        signal?.throwIfAborted()
        if (stopped) throw new Error('下载已停止')
        const buffer = Buffer.from(chunk); size += buffer.length
        if (size > maxBytes) { stream.destroy(); throw new Error('下载文件超过 10MB 证据接收上限') }
        chunks.push(buffer)
      }
      if (stopped) throw new Error('下载已停止')
      signal?.throwIfAborted()
      const buffer = Buffer.concat(chunks)
      await mkdir(directory, { recursive: true })
      const path = resolve(directory, `${randomUUID()}.download`)
      await writeFile(path, buffer, { flag: 'wx', mode: 0o600 })
      finished = true
      return { downloadId, name: item.suggestedFilename(), size, sha256: hash(buffer), path }
    })()])
  } finally {
    stopped = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); page.off('download', onDownload)
    if (!finished && download) void download.cancel().catch(() => undefined)
  }
}

export async function assertDownload(evidence: DownloadEvidence | undefined, expected: Extract<AutomationPlan['steps'][number], { action: 'expectDownload' }>) {
  if (!evidence) throw new Error(`本用例尚未完成下载：${expected.downloadId}`)
  const buffer = await readFile(evidence.path)
  if (buffer.length !== evidence.size || hash(buffer) !== evidence.sha256) throw new Error('下载证据文件已改变，不能用当前内容验证原下载')
  if (expected.name !== undefined && evidence.name !== expected.name) throw new Error(`下载名称不符：预期 ${expected.name}，实际 ${evidence.name}`)
  if (evidence.size < expected.minBytes) throw new Error(`下载大小不符：预期至少 ${expected.minBytes} 字节，实际 ${evidence.size}`)
  if (expected.textIncludes !== undefined) {
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
    catch { throw new Error('下载内容不是可验证的 UTF-8 文本，不能以此证明文件内容正确') }
    if (!text.includes(expected.textIncludes)) throw new Error(`下载内容断言失败：未包含“${expected.textIncludes}”`)
  }
}
