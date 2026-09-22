#!/usr/bin/env python3
"""g1 走查：按 ADR-0014 §3 的 MVP 判据，用**两个真进程 + 共享目录**走完一轮。
**位置（本批迁移）**：实体在 `src/system/repo-gate/tests/g1-walkthrough.py`；旧位置 `tools/g1-walkthrough.py` 只剩**薄转发**
（`runpy` 指到本文件）—— 门名、`tools/verify.sh` 的分支、`./run` 与文档里的既有命令**一行未改**。

一轮的八个动作（ADR-0014 §3 原文）：
    发布 → 澄清广播 → 升版 → 报价 → 比价与 Flag → 授标 → 变更 → 审计包独立验证

执行方式（本脚本是唯一入口，`tools/verify.sh g1` 会调用它）：
1. 建共享目录（`tmp/`，gitignored，用完自清理）；
2. **各起一个真进程**跑 `python -m quotagent.g1side contractor|supplier <shared>`，
   两侧各有自己的 realm 与账本，只通过共享目录交换文件；
3. 另起**两个桥 sidecar 真进程**（`python -m quotagent.bridge --serve`）做握手与方法面断言
   （含"commit 类调用必被拒且留痕"的对抗性检查）；
4. 判据逐条判定并打印结论；导出/篡改审计包，交给 `tools/audit-verify.py` 做**独立**验证；
5. 退出码：0 = 全部判据通过；1 = 有判据失败；2 = 环境/用法错误（不得当作通过）。

注意：本脚本**不做**任何"承诺"动作——承诺面（报价提交/授标承诺/发 PO/变更批准）只能在两侧各自的
人工门内发生，桥不暴露（ADR-0013）。这里只做**跨进程/共享目录**能证明的事。
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
def _shared_dir() -> Path:
    """共享目录：默认 tmp/g1-shared；可用 `--shared-dir <path>` 指定。

    为什么要能指定：`verify.sh g1` 每次都会**自清理并重建**这个目录（临时产物纪律），
    于是任何长期读者（例如 WebUI）都会被跟着清空。UI 因此用自己的 `tmp/ui-shared`。
    """
    argv = sys.argv
    if '--shared-dir' in argv:
        return Path(argv[argv.index('--shared-dir') + 1]).resolve()
    return ROOT / 'tmp' / 'g1-shared'


SHARED = _shared_dir()
SIDES = ("contractor", "supplier")


def run_side(role: str, phase: int) -> dict:
    """跑一侧的一个阶段：**每次调用都是一个真进程**（轮次是交替的，共享目录当信箱）。"""
    env = {**os.environ, "PYTHONPATH": str(ROOT / "src"),
           "G1_SHARED_SECRET": "g1-shared-secret"}
    proc = subprocess.run([sys.executable, "-m", "quotagent.g1side", role, str(SHARED), str(phase)],
                          cwd=str(ROOT), env=env, capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        raise SystemExit(f"[{role} phase {phase}] 单侧进程失败（退出码 {proc.returncode}）：\n"
                         f"{proc.stdout[-1200:]}\n{proc.stderr[-1200:]}")
    return json.loads(proc.stdout.strip().splitlines()[-1])


class Bridge:
    """一个真桥 sidecar（NDJSON/stdio），只用于握手与方法面断言。"""

    def __init__(self, profile: str, realm: str, ledger: Path):
        env = {**os.environ, "PYTHONPATH": str(ROOT / "src")}
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "quotagent.bridge", "--serve", "--realm", realm,
             "--ledger", str(ledger), "--profile", profile],
            cwd=str(ROOT), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1)
        self.hello = json.loads(self.proc.stdout.readline())["p"]

    def send(self, frame: dict) -> None:
        self.proc.stdin.write(json.dumps(frame) + "\n")
        self.proc.stdin.flush()

    def await_frame(self, names: tuple[str, ...], limit: int = 40) -> dict:
        for _ in range(limit):
            line = self.proc.stdout.readline().strip()
            if not line:
                return {}
            frame = json.loads(line)
            if frame["n"] in names:
                return frame
        return {}

    def call(self, name: str, params: dict) -> dict:
        self.send({"v": 1, "n": "method", "p": {"id": f"c-{name}", "m": name, "params": params}})
        return self.await_frame(("result", "error"))

    def close(self) -> int:
        try:
            self.send({"v": 1, "n": "bridge.shutdown", "p": {}})
            self.proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            self.proc.kill()
        return self.proc.returncode


KEEP_SHARED = "--keep-shared" in sys.argv  # 给 WebUI 复读用；默认仍自清理


def _reset_shared() -> None:
    """只清**本走查自己的**两个 side 目录，共享目录里别的租户一概不动。

    为什么不是整目录 `rmtree`（这是一个真实缺陷的修复）：WebUI 每次启动都会先跑一遍本走查
    （`--keep-shared`，见 `tools/webui-serve.py`），而 `<shared>/ui-feedback/` 里放的是**用户原话**的
    0600 待办件与版本状态（`versions.json`，由 Python 侧 `tools/ui-feedback-apply.py` 原子写）。
    整目录清空会把用户反馈连版本状态一起删掉 —— 闭环就断在「重启即丢件」，丢的是用户输入。
    本走查只往 `<shared>/<side>/` 写，所以只需要保证这两个目录是空的（确定性不受影响）。
    """
    SHARED.mkdir(parents=True, exist_ok=True)
    for side in SIDES:
        if (SHARED / side).exists():
            shutil.rmtree(SHARED / side)
        (SHARED / side).mkdir()


def main() -> int:
    _reset_shared()
    results: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        results.append((name, bool(ok), detail))

    # --- 判据 1：两个真进程 + 共享目录 ------------------------------------
    # 一轮八个动作按交替阶段推进（每段都是一个独立进程）
    timeline: list[dict] = []
    for role, phase in (("contractor", 1), ("supplier", 1), ("contractor", 2), ("supplier", 2),
                        ("contractor", 3), ("supplier", 3), ("contractor", 4)):
        timeline.append(run_side(role, phase))
    contractor_steps = [item for item in timeline if item["role"] == "contractor"]
    supplier_steps = [item for item in timeline if item["role"] == "supplier"]
    pids = {item["pid"] for item in timeline}
    check("判据1 两个真进程：7 个阶段进程交替推进，各自 realm / 账本",
          len(pids) >= 7 and {item["realm"] for item in contractor_steps} == {"contractor:g1"}
          and {item["realm"] for item in supplier_steps} == {"supplier:g1"}
          and {item["ledger"] for item in contractor_steps} != {item["ledger"] for item in supplier_steps},
          f"{len(timeline)} 个阶段进程，pid 去重 {len(pids)}")
    check("判据1 只通过共享目录交换（两侧账本互不读写，计数各自增长）",
          (SHARED / "contractor" / "ledger.jsonl").exists()
          and (SHARED / "supplier" / "ledger.jsonl").exists()
          and (SHARED / "contractor" / "01-package.json").exists()
          and (SHARED / "supplier" / "05-quote.json").exists(),
          f"共享目录条目 {sum(len(list((SHARED / side).rglob('*.json'))) for side in SIDES)} 个（只数本走查自己的两个 side 目录）；"
          f"contractor 账本 {contractor_steps[-1]['ledger_count']} 条 / "
          f"supplier 账本 {supplier_steps[-1]['ledger_count']} 条")

    # --- 判据 2：承诺动作无法绕过人工门（桥不暴露 commit 面） --------------
    bridge = Bridge("contractor-ops", "contractor:g1", SHARED / "contractor" / "ledger.jsonl")
    hello = bridge.hello
    refused = {item["m"]: item["cls"] for item in hello.get("methods_refused") or []}
    exposed = {item["m"] for item in hello.get("methods") or []}
    check("判据2 桥只开 read/compute；commit/fact 面只声明不暴露",
          exposed and not ({"quote.submit", "award.commit", "po.issue", "change.approve",
                            "approval.decide"} & exposed)
          and {"quote.submit", "award.commit", "po.issue", "change.approve"} <= set(refused),
          f"exposed={sorted(exposed)} refused={sorted(refused)}")
    bridge.send({"v": 1, "n": "bridge.init", "p": {"accept_bridge": ["1.0"], "profile": "contractor-ops"}})
    ready = bridge.await_frame(("bridge.ready", "error"))
    check("判据2 握手成功（内核自述版本与能力清单，唯一真源在 Python 侧）",
          ready.get("n") == "bridge.ready", json.dumps(ready.get("p"), ensure_ascii=False)[:120])
    supplier_quote = supplier_steps[1] if len(supplier_steps) > 1 else {}
    check("判据2 **供应商侧**的报价提交同样过人工门（无批准即抛错，有批准才落账）",
          supplier_quote.get("blocked_without_approval")
          and supplier_quote.get("quote_submitted") is True
          and int(supplier_quote.get("ledger_count") or 0) >= 3,
          f"无批准时: {str(supplier_quote.get('blocked_without_approval'))[:60]}；"
          f"账本 {supplier_quote.get('ledger_count')} 条")
    blocked = bridge.call("quote.submit", {"quote_id": "qg-fresh"})
    ledger_bytes = (SHARED / "contractor" / "ledger.jsonl").read_text(encoding="utf-8")
    check("判据2 commit 类调用被拒（commit-refused）且留痕于账本",
          blocked.get("n") == "error" and blocked["p"].get("code") == "commit-refused"
          and "bridge-rejected" in ledger_bytes,
          f"code={blocked.get('p', {}).get('code')}")
    healthy = bridge.call("ledger.healthy", {})
    verified = bridge.call("ledger.verify", {})
    healthy_body = healthy.get("p", {}).get("result", {}) or {}
    verify_body = (verified.get("p", {}).get("result", {}) or {}).get("report", {}) or {}
    check("判据2 经桥读账本：健康且哈希链自洽（`ledger.verify` 返回逐条报告）",
          healthy_body.get("healthy") is True and verify_body.get("ok") is True
          and int(verify_body.get("checked") or 0) > 0,
          f"healthy={healthy_body.get('healthy')} verify.checked={verify_body.get('checked')}")

    # --- 判据 3：私域不可见（含非空转负控） --------------------------------
    supplier_view = json.loads((SHARED / "supplier" / "05-quote.json").read_text(encoding="utf-8"))
    contractor_eval = json.loads((SHARED / "contractor" / "06-evaluation.json").read_text(encoding="utf-8"))
    private_leak = any(key in json.dumps(supplier_view, ensure_ascii=False)
                       for key in ("calendar:private", "cost_floor", "markup_pct"))
    check("判据3 供应商可见产物不含承包商私域字段（且不是空转：产物确实有内容）",
          not private_leak and len(json.dumps(supplier_view, ensure_ascii=False)) > 200
          and contractor_eval["rows"] >= 1,
          f"supplier 产物 {len(json.dumps(supplier_view, ensure_ascii=False))} 字符；"
          f"承包商比较表 {contractor_eval['rows']} 行")

    # --- 判据 4：场景与反例 --------------------------------------------------
    suite_codes = {}
    for name in ("s1", "s2", "s3", "s4"):
        proc = subprocess.run([str(ROOT / "tools" / "run.sh"), "-m", "quotagent.qa", "suite", name],
                              cwd=str(ROOT), capture_output=True, text=True, timeout=600)
        suite_codes[name] = proc.returncode
    check("判据4 S1..S4 场景集全绿",
          set(suite_codes.values()) == {0}, f"exit={suite_codes}")

    # --- 判据 5：审计包第三方独立验证（含篡改必失败） ----------------------
    pack_path = SHARED / "contractor" / "11-audit-pack.json"
    env = {**os.environ, "G1_SHARED_SECRET": "g1-shared-secret", "PYTHONPATH": str(ROOT / "src")}
    good = subprocess.run([sys.executable, str(ROOT / "tools" / "audit-verify.py"), str(pack_path),
                           "--require-signature", "--secret-env", "G1_SHARED_SECRET",
                           "--participant", "contractor:g1"],
                          cwd=str(ROOT), env=env, capture_output=True, text=True, timeout=120)
    tampered = SHARED / "contractor" / "11-audit-pack-tampered.json"
    pack = json.loads(pack_path.read_text(encoding="utf-8"))
    pack["events"][0]["body"]["note"] = "改过了"
    tampered.write_text(json.dumps(pack, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    bad = subprocess.run([sys.executable, str(ROOT / "tools" / "audit-verify.py"), str(tampered),
                          "--require-signature", "--secret-env", "G1_SHARED_SECRET",
                          "--participant", "contractor:g1"],
                         cwd=str(ROOT), env=env, capture_output=True, text=True, timeout=120)
    check("判据5 审计包可被第三方独立验证（只给包文件 + 验证方密钥）",
          good.returncode == 0, good.stdout.strip().splitlines()[-1][:120] if good.stdout else "")
    check("判据5 篡改任一条后独立验证失败（篡改必被发现）",
          bad.returncode == 1, bad.stdout.strip().splitlines()[-1][:120] if bad.stdout else "")
    chain_a = _chain_report(SHARED / "contractor" / "ledger.jsonl")
    chain_b = _chain_report(SHARED / "supplier" / "ledger.jsonl")
    check("判据5 全程可离线重放：两侧账本非空且哈希链自洽（空/缺失账本一律不算通过）",
          chain_a[0] and chain_b[0],
          f"contractor: {chain_a[1]}；supplier: {chain_b[1]}")

    # --- 判据 6：无 Node 时 P0 仍全绿 ---------------------------------------
    no_node = subprocess.run([str(ROOT / "tools" / "verify.sh"), "p0-no-node"],
                             cwd=str(ROOT), capture_output=True, text=True, timeout=900)
    docs = subprocess.run([str(ROOT / "tools" / "verify.sh"), "docs"],
                          cwd=str(ROOT), capture_output=True, text=True, timeout=300)
    check("判据6 无 Node 环境时 P0 的 AC 与文档门仍全绿（可复跑性不退化）",
          no_node.returncode == 0 and docs.returncode == 0,
          f"p0-no-node={no_node.returncode} docs={docs.returncode}")

    exit_code = bridge.close()
    check("判据2 桥可干净关闭（无孤儿、退出码 0）", exit_code == 0, f"exit={exit_code}")

    # --- 报告 ---------------------------------------------------------------
    failed = [item for item in results if not item[1]]
    print("=" * 72)
    print("g1 走查报告（ADR-0014 §3 的 MVP 判据逐条判定）")
    print("=" * 72)
    for name, ok, detail in results:
        print(f"[{'ok' if ok else 'FAIL'}] {name}")
        if detail:
            print(f"        {detail}")
    print("-" * 72)
    print("阶段时间线：" + " → ".join(f"{item['role']}#{item['phase']}"
                                      f"(pid {item['pid']}, 账本 {item['ledger_count']} 条)"
                                      for item in timeline))
    print(f"结论：{len(results) - len(failed)}/{len(results)} 条通过")
    if not KEEP_SHARED:
        shutil.rmtree(SHARED, ignore_errors=True)
    else:
        print(f"[keep-shared] 两侧账本保留在 {SHARED}（contractor/supplier）")
    return 0 if not failed else 1


def _chain_report(path: Path) -> tuple[bool, str]:
    """独立子进程验链，并回传详情。**空账本不算通过**（否则"什么都没写"会被判绿）。"""
    if not path.exists() or path.stat().st_size == 0:
        return False, f"{path.name} 不存在或为空（n/a）"
    code = ("import sys, json; sys.path.insert(0, sys.argv[2]);"
            "from quotagent.kernel.ledger import Ledger;"
            "ld = Ledger(sys.argv[1]); r = ld.verify_report();"
            "print(json.dumps({'ok': r['ok'], 'checked': r['checked'], 'count': ld.count}))")
    proc = subprocess.run([sys.executable, "-c", code, str(path), str(ROOT / 'src')],
                          cwd=str(ROOT), capture_output=True, text=True, timeout=120)
    if proc.returncode != 0 or not proc.stdout.strip():
        return False, f"{path.name} 验链子进程失败 rc={proc.returncode} {proc.stderr.strip()[-120:]}"
    payload = json.loads(proc.stdout.strip().splitlines()[-1])
    return bool(payload["ok"] and payload["count"] > 0), \
        f"{path.name} 条目 {payload['count']}，校验 {payload['checked']} 条，ok={payload['ok']}"


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] 走查异常（环境/用法错误，不得当作通过）：{type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(2)
