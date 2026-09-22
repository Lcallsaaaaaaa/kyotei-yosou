import { execSync } from 'node:child_process'
const o = execSync('wmic process where "name=\'node.exe\'" get processid,commandline /format:csv', { encoding: 'utf8' })
for (const l of o.split('\n')) {
  if (!l.includes('status.mjs')) continue
  const pid = l.trim().split(',').pop().trim()
  if (/^\d+$/.test(pid)) { try { execSync(`taskkill /F /PID ${pid} 2>nul`) } catch {} }
}
console.log('停止')
