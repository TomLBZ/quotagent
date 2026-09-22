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

// 搬迁补丁（本批 `EV-177`）：实体从 `host/lib/ledger-view.mjs` 搬到 `src/system/kernel/code/`，
// 自相对 ROOT 由 `.. / ..`（host/lib → 仓库根）改为 `.. / .. / .. / ..`（src/system/kernel/code → 仓库根）。
// 不改的话 `repoRoot` 会解析到 `<repo>/src/system`，子进程 `python3 -c` 的 `sys.path` 指歪 ⇒ 链校验读不到。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

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
    /**
     * 本视角**自己**的 realm（= 身份）：取本账本里出现过的 realm 去重排序。
     * 用途：投递事实（RFQ 包）要按"发给谁"做收件人作用域过滤，而**身份只能来自本视角自己的账本**
     * （不能来自信封本身——那等于让发送方决定收件人是谁）。0 个 ⇒ 还没落过事实（`no-identity`）。
     */
    realms: () => [...new Set(read().map((row) => (typeof row.realm === 'string' ? row.realm.trim() : ''))
      .filter((item) => item !== ''))].sort(),
  }
}
