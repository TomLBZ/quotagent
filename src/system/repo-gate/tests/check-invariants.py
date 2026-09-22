#!/usr/bin/env python3
"""宿主强制不变量的机检：H1 / H2 / H3（Python 侧）+ H5 / H6（Node 侧，见 `host/invariants.mjs`）。

依据：评审 C §4.2 的 H1..H10 与 `ADR-0014 §7`（P1 必须交付 H1/H2/H3/H5/H6 五条，**每条带一个会变红的负控**），
入口 `tools/verify.sh invariants`。

设计口径：
- 每条不变量都写成「正控（合规场景必须通过）+ **负控（违规场景必须被检出而变红）**」；
  负控不是声明，而是把违规场景真跑出来、断言检测器报红。
- 退出码：0 = 全部通过；1 = 有检查项失败；2 = 环境/用法错误（不得当作通过）。

H1 账本唯一写入口 + 哈希链（INV-001）
H2 事件声明表与 @mode（未声明事件 / 错模式 → 拒绝）
H3 承诺出口唯一化 + 批准校验（INV-005）
H5 冻结面：`kernel-*` 不可 patch + fiber 上的否决 hook（Node 侧）
H6 卸载残留审计：effect 数为 0 且资源计数器差分全 0（Node 侧）
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.events import EventBus, EventModeError, UnknownEventError  # noqa: E402
from quotagent.kernel.ledger import Ledger  # noqa: E402
from quotagent.paths import new_scratch  # noqa: E402
from quotagent.services.approval import ApprovalService, ApprovalRequired, AgentCannotApprove  # noqa: E402
from quotagent.services.commitments import CommitmentGate  # noqa: E402


def resolve_node() -> str | None:
    found = shutil.which("node")
    if found:
        return found
    for candidate in sorted(Path("/workspace/runtime/node").glob("*/bin/node")):
        return str(candidate)
    return None


def check_h1() -> list[dict]:
    out: list[dict] = []
    root = new_scratch("inv-h1")
    bus = EventBus()
    bus.install_defaults()
    ledger = Ledger(root / "ledger.jsonl", realm="contractor:con-B")
    ledger.append("demo/event", {"i": 1}, correlation_id="d1")
    report = ledger.verify_report()
    out.append({"name": "H1 正控：Python 侧 append 后哈希链自洽",
                "ok": report["ok"] is True and report["checked"] >= 1,
                "detail": f"checked={report['checked']} ok={report['ok']}"})
    # 负控 1：宿主侧直写账本（改文件一行）必须被发现
    text = (root / "ledger.jsonl").read_text(encoding="utf-8")
    tampered = text.replace('"i":1', '"i":999')
    (root / "ledger.jsonl").write_text(tampered, encoding="utf-8")
    bad = Ledger(root / "ledger.jsonl", realm="contractor:con-B")
    out.append({"name": "H1 负控：宿主直写账本一行被核对发现（哈希链失败）",
                "ok": bad.verify_report()["ok"] is False,
                "detail": json.dumps(bad.verify_report(), ensure_ascii=False)[:120]})
    # 负控 2：链失效后必须**停发**（拒绝继续 append）
    stopped = False
    try:
        bad.append("demo/event", {"i": 2}, correlation_id="d2")
    except Exception as err:  # noqa: BLE001
        stopped = "冻结" in str(err) or "校验失败" in str(err)
    out.append({"name": "H1 负控：链失效即冻结、拒绝继续写入（停发前置条件）",
                "ok": stopped, "detail": "append 被拒"})
    # 负控 3：桥面不得暴露任何写账本/承诺方法（OPEN_CLASSES 只开 read|compute；承诺面只声明不暴露）
    from quotagent.bridge import OPEN_CLASSES, REFUSED_SURFACE, MethodSurface
    exposed = {item['m'] for item in MethodSurface().exposed()}
    refused = {name for name, _cls in REFUSED_SURFACE}
    commit_names = {"quote.submit", "award.commit", "po.issue", "change.approve", "approval.decide"}
    out.append({"name": "H1 负控：桥只开 read/compute，承诺类方法只声明不暴露",
                "ok": set(OPEN_CLASSES) == {"read", "compute"} and not (commit_names & exposed)
                and commit_names <= refused,
                "detail": f"exposed={len(exposed)} 条，refused={sorted(refused)}"})
    return out


def check_h2() -> list[dict]:
    out: list[dict] = []
    root = new_scratch("inv-h2")
    bus = EventBus()
    bus.install_defaults()

    declared = bus.declared()
    emit_events = [name for name, mode in declared.items() if mode == "emit"]
    seen: list[str] = []
    dispose = bus.on(emit_events[0], lambda payload: seen.append(payload.get("x")))
    bus.emit(emit_events[0], {"x": "ok"})
    out.append({"name": "H2 正控：已声明事件按 mode 派发成功（监听器收到）",
                "ok": seen == ["ok"] and dispose is not None, "detail": f"event={emit_events[0]} seen={seen}[0]".replace("[0]", "") + f" seen={seen}"})
    dispose()

    undeclared_write = None
    try:
        bus.on("demo/not-declared", lambda *_: None)
    except UnknownEventError:
        undeclared_write = "UnknownEventError"
    emitted = None
    try:
        bus.emit("demo/not-declared", {})
    except UnknownEventError:
        emitted = "UnknownEventError"
    out.append({"name": "H2 负控：未声明的事件名无法订阅、也无法 emit（未声明即不可派发）",
                "ok": undeclared_write == emitted == "UnknownEventError",
                "detail": f"on={undeclared_write} emit={emitted}"})

    bail_events = [name for name, mode in declared.items() if mode == "bail"]
    mismatch = None
    if bail_events:
        try:
            bus.emit(bail_events[0], {})
        except EventModeError as err:
            mismatch = str(err)[:70]
    out.append({"name": "H2 负控：用 `emit` 派发声明为 `bail` 的事件被拒绝（模式不得错用）",
                "ok": bool(bail_events) and mismatch is not None,
                "detail": f"event={bail_events[0] if bail_events else None} error={mismatch}"})

    wrong_dispatch = None
    try:
        bus.dispatch("kernel/not-declared", {})
    except UnknownEventError:
        wrong_dispatch = "UnknownEventError"
    out.append({"name": "H2 负控：`dispatch` 对未声明事件同样拒绝（不走宽容分支）",
                "ok": wrong_dispatch == "UnknownEventError", "detail": f"result={wrong_dispatch}"})
    out.append({"name": "H2 正控：事件表本身可枚举（唯一真源在 Python 侧）",
                "ok": len(bus.declared()) > 20,
                "detail": f"declared={len(bus.declared())} 条"})
    return out


def check_h3() -> list[dict]:
    out: list[dict] = []
    root = new_scratch("inv-h3")
    bus = EventBus()
    bus.install_defaults()
    ledger = Ledger(root / "ledger.jsonl", realm="contractor:con-B")
    approvals = ApprovalService(ledger=ledger, events=bus)
    gate = CommitmentGate(approval=approvals, ledger=ledger, events=bus)

    quote = {"quote_id": "q-1", "package_id": "pkg-1", "rfq_rev": 1, "lines": [{"item_id": "L-001", "qty": 1}]}
    intent = {"intent_id": "awin-1", "package_id": "pkg-1", "quote_id": "q-1", "lines": quote["lines"]}
    paths = {"提交报价": lambda: gate.submit_quote(quote),
             "授标承诺": lambda: gate.commit_award(intent, supplier_confirmed=True),
             "发 PO": lambda: gate.issue_po("aw-0001", [{"ref_line": "L-001", "qty": 1}])}
    errors = {}
    for name, call in paths.items():
        try:
            call()
            errors[name] = ""
        except Exception as err:  # noqa: BLE001
            errors[name] = type(err).__name__
    out.append({"name": "H3 负控：三条承诺路径无批准记录时全部抛错（INV-005）",
                "ok": all(errors.values()), "detail": json.dumps(errors, ensure_ascii=False)})

    record = approvals.request("quote.submit", {"quote_id": "q-1"}, ref="q-1", approvers=["human:z"])
    agent_try = None
    try:
        approvals.decide(record["approval_id"], by="agent:planner", decision="granted")
    except AgentCannotApprove as err:
        agent_try = str(err)[:60]
    out.append({"name": "H3 负控：agent 代签被拒（批准只能由人产生）",
                "ok": agent_try is not None, "detail": f"error={agent_try}"})
    approvals.decide(record["approval_id"], by="human:z", decision="granted")
    cross = None
    try:
        gate.commit_award(intent, supplier_confirmed=True, approval_id=record["approval_id"])
    except ApprovalRequired as err:
        cross = str(err)[:60]
    out.append({"name": "H3 负控：批准绑定 scope（报价批准不能复用到授标承诺）",
                "ok": cross is not None, "detail": f"error={cross}"})
    granted = gate.submit_quote(quote, approval_id=record["approval_id"])
    out.append({"name": "H3 正控：有有效批准后承诺路径成功并落账",
                "ok": bool(granted.get("quote_id")) and len(ledger.read(type="quote/submitted")) == 1,
                "detail": f"submitted={granted.get('quote_id')}"})
    return out


def check_host() -> list[dict]:
    node = resolve_node()
    if node is None:
        return [{"name": "H5/H6（Node 侧）", "ok": False,
                 "detail": "未找到 node：宿主侧不变量无法检查（不得当作通过）"}]
    proc = subprocess.run([node, str(ROOT / "host" / "invariants.mjs")], cwd=str(ROOT / "host"),
                          capture_output=True, text=True, timeout=300)
    try:
        payload = json.loads(proc.stdout) if proc.stdout.strip() else {}
    except json.JSONDecodeError:
        payload = {}
    checks = payload.get("checks") or []
    if not checks:
        return [{"name": "H5/H6（Node 侧）", "ok": False,
                 "detail": f"宿主脚本无输出（rc={proc.returncode}）：{proc.stderr.strip()[-160:]}"}]
    return [{"name": item["name"], "ok": bool(item["ok"]), "detail": item.get("detail", "")} for item in checks]


def main() -> int:
    results = check_h1() + check_h2() + check_h3() + check_host()
    failed = [item for item in results if not item["ok"]]
    report = {"kind": "quotagent/invariants", "root": str(ROOT),
              "results": results, "passed": len(results) - len(failed), "total": len(results),
              "note": "H1/H2/H3/H5/H6 每条都有正控 + 负控（ADR-0014 §7 / 评审 C §4.2）"}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print("-" * 72)
    for item in results:
        print(f"[{'ok' if item['ok'] else 'FAIL'}] {item['name']}")
        if item["detail"]:
            print(f"        {item['detail']}")
    print("-" * 72)
    print(f"宿主强制不变量：{len(results) - len(failed)}/{len(results)} 通过"
          + (f"；失败 {[item['name'] for item in failed]}" if failed else ""))
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
