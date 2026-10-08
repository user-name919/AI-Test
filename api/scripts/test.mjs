import { spawnSync } from 'node:child_process'

const files = process.argv.slice(2).filter(argument => argument !== '--')
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...(files.length ? files : ['src/**/*.test.ts'])], { stdio: 'inherit' })
if (result.error) console.error(result.error.message)
process.exitCode = result.status ?? 1
