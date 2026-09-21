/**
 * 只读账本视图（给 WebUI 用）：**不写**账本（H1：唯一写入者是 Python 侧），只读 NDJSON 并给投影。
 *
 * 健康性不自己算：链校验由 Python 侧 `ledger.verify_report()` 给出（子进程调用，缓存 mtime），
 * 因为"哈希链是否自洽"的判定权在账本模块，宿主不该有第二份实现。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function openLedger(path, { repoRoot = ROOT } = {}) {
  const read = () => {
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf-8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
  }

  let cache = { mtime: 0, report: null }
  const verify = () => {
    if (!existsSync(path)) return { ok: false, checked: 0, count: 0, reason: 'ledger-missing' }
    const mtime = statSync(path).mtimeMs
    if (cache.mtime === mtime && cache.report) return cache.report
    const code = 'import sys, json; sys.path.insert(0, sys.argv[2]);'
      + 'from quotagent.kernel.ledger import Ledger; ld = Ledger(sys.argv[1]); r = ld.verify_report();'
      + 'print(json.dumps({"ok": r["ok"], "checked": r["checked"], "count": ld.count, "head": ld.head_hash}))'
    const out = execFileSync('python3', ['-c', code, path, join(repoRoot, 'src')],
      { cwd: repoRoot, encoding: 'utf-8', env: { ...process.env, PYTHONPATH: join(repoRoot, 'src') } })
    const report = JSON.parse(out.trim().split('\n').pop())
    cache = { mtime, report }
    return report
  }

  return {
    path,
    /** 只读投影：只暴露视图需要的字段，**不返回整条记录**。 */
    rows: () => read().map((row) => ({
      seq: row.seq, type: row.type, correlation_id: row.correlation_id,
      actor: row.actor, ts: row.ts, body: row.body,
    })),
    count: () => read().length,
    verify,
    /** 按事件前缀过滤（视图用）。 */
    byType: (prefix) => read().filter((row) => String(row.type).startsWith(prefix)),
  }
}
