import { chromium } from 'playwright'
import type { PageSnapshot } from '@quality-ai/contracts'
import { PageObserver } from './page-observer'

export async function inspectTargetPage(targetUrl: string, storageStatePath?: string): Promise<PageSnapshot> {
  const url = new URL(targetUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('观察地址只允许 HTTP 或 HTTPS')
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      storageState: storageStatePath,
    })
    try {
      const page = await context.newPage()
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      return await new PageObserver().observe(page)
    } finally {
      await context.close()
    }
  } finally {
    await browser.close()
  }
}
