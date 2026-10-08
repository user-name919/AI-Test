import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import test from 'node:test'
import { workspaceRoot } from '../../api/src/config/paths'

function terminateOwnedProcessGroup(pid: number) {
  try { process.kill(-pid, 'SIGTERM') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

test('根目录和 api 子目录的启动命令均可提供 API，使用隔离数据目录', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'quality-ai-workspace-start-'))
  try {
    for (const [cwd, command] of [[workspaceRoot, 'start:api'], [join(workspaceRoot, 'api'), 'start']] as const) {
      const reservation = createServer()
      reservation.listen(0, '127.0.0.1')
      await once(reservation, 'listening')
      const address = reservation.address()
      assert.ok(address && typeof address !== 'string')
      await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
      const child = spawn('pnpm', [command], {
        cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, API_PORT: String(address.port), QUALITY_AI_DATA_ROOT: dataRoot,
          QUALITY_AI_DATABASE_PATH: join(dataRoot, 'quality-ai.sqlite'), MODEL_API_KEY: 'synthetic-test-key' },
      })
      let output = ''
      child.stdout.on('data', chunk => { output += String(chunk) })
      child.stderr.on('data', chunk => { output += String(chunk) })
      const exited = once(child, 'exit')
      try {
        let healthy = false
        const deadline = Date.now() + 15000
        while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
          try {
            const response = await fetch(`http://127.0.0.1:${address.port}/api/health`)
            if (response.ok) { healthy = true; break }
          } catch { /* API 尚在启动 */ }
          await setTimeout(100)
        }
        assert.ok(healthy, `启动失败：${output}`)
        const response = await fetch(`http://127.0.0.1:${address.port}/api/analyses`)
        assert.equal(response.status, 200)
        assert.deepEqual((await response.json()).analyses, [])
      } finally {
        // 仅结束本测试刚创建的独立进程组，避免遗留 pnpm 的 API 子进程。
        if (child.pid) terminateOwnedProcessGroup(child.pid)
        await exited
      }
    }
  } finally { await rm(dataRoot, { recursive: true, force: true }) }
})
