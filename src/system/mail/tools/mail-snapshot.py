#!/usr/bin/env python3
"""mail-snapshot —— 把**邮件域**的状态快照写到 `<shared-dir>/mail.json`（宿主 `mail-view` 只读它）。

**为什么有这个工具**：`/ops/mail/` 专页与状态栏 `status.mail` 的数据源是 Python 侧写的 `mail.json`
（判定在事实层，宿主只渲染 —— ADR-0012）。它原来住在 `tools/refresh-ui-snapshots.py`：那个工具同时产出
**三域流水面板**（`pipeline.json`：谈判/FAQ/邮件计数与最近事件）用的快照。本批按
`docs/design/29-webui-gui-app.md` §2 + `AGENTS.md` 规则 12 **退役整个三域流水运维面**
（`/ops/` 的三域面板、`/api/pipeline`、`pipeline-view` 插件、`refresh-ui-snapshots.py`、`ui-seed-pipeline.py`），
但**邮件域是活功能**（§7.3 的邮件通道 + `mail-transport` 门）⇒ 只把邮件那一半**搬到归属插件**
（`system/mail/tools/`），旧工具与其三域产出一起删除（不留副本、不留第二份实现）。

纪律（与原工具同一套，一格未松）：

· **只读账本**（不新增、不修改任何账本行）；计数一律由账本行重建；
· 只有**计数、布尔、来源名与原因码**：**没有**任何凭据值，也没有邮件正文/主题/收件人；
· 不给\"看起来可用\"的值：`available` 由 `services/mail_transport` 按**证据**给（配置齐但没试过 →
  `mail-*-unprobed`；没配 → `mail-*-unconfigured`）；
· **确定性**：同一账本两次运行，除 `generated_at` 外逐字节一致（键全排序、原子写）；
· 找**不到**账本就不建文件（绝不为了读而创建账本），按空账本给全零计数。

形状（键名即契约，与 `code/mail-view.mjs` 的投影同形）::

    {"schema": 1, "generated_at": "<ISO8601>", "service": "mail",
     "views":  {"<view>": {"queued": 0, "refused": 0, "sent": 0, "parsed": 0}},
     "totals": {"queued": 0, "refused": 0, "sent": 0, "parsed": 0},
     "transport": {"smtp": {...}, "imap": {...}, "last_attempt": …, "attempts": [...], "state": …,
                   "note": "…"}}

视角 → 账本布局（`--shared-dir`，默认 `tmp/ui-shared`）：按固定顺序找
`<shared>/<view>/ledger.jsonl` → `<shared>/<view>.jsonl` → `<shared>` 下排序后的第一个 `*.jsonl`。

用法::

    python3 src/system/mail/tools/mail-snapshot.py                        # 两个视角，默认目录
    python3 src/system/mail/tools/mail-snapshot.py --views contractor
    python3 src/system/mail/tools/mail-snapshot.py --views contractor,supplier --shared-dir tmp/ui-shared
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.ledger import Ledger  # noqa: E402
from quotagent.services.mail_transport import MailTransport  # noqa: E402

#: 快照声明的两个视角（顺序固定 → 迭代顺序固定）
VIEWS = ("contractor", "supplier")
#: 默认共享目录 = 仓库内 `tmp/ui-shared`（账本 `<shared>/<view>/ledger.jsonl`，输出 `<shared>/mail.json`）
DEFAULT_SHARED = ROOT / "tmp" / "ui-shared"
LEDGER_NAME = "ledger.jsonl"
#: 邮件域快照读的四个计数键（键名即契约，`code/mail-view.mjs` 同形）
MAIL_COUNT_KEYS = ("queued", "refused", "sent", "parsed")


def _display(path: Path) -> str:
    """把路径显示成仓库相对路径（不在仓库内就原样显示）—— 输出里不出现机器相关的绝对前缀。"""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def _ledger_path(shared: Path, view: str) -> Path | None:
    for candidate in (shared / view / LEDGER_NAME, shared / f"{view}.jsonl"):
        if candidate.is_file():
            return candidate
    flat = sorted(item for item in shared.glob("*.jsonl") if item.is_file())
    return flat[0] if flat else None


def _open(path: Path | None) -> Ledger | None:
    """打开账本（只读）。哈希链校验失败时在 stderr 明说，但**不假装**没有数据。"""
    if path is None:
        return None
    ledger = Ledger(path, realm="mail-snapshot")
    if not ledger.healthy:
        print(f"mail-snapshot: 警告：账本 {path} 哈希链校验失败", file=sys.stderr)
    return ledger


def _body(row: dict) -> dict:
    body = row.get("body")
    return body if isinstance(body, dict) else {}


def _mail_counts(ledger: Ledger | None) -> dict:
    """每视角的四个计数：`mail/queued`（按 `message_id` 去重）/ `mail/refused` / `mail/sent` / `mail/parsed`。

    只数**账本行**（事实源），不做任何判定；`sent` 是"真发出去了"的事实行（由 `mail_transport.send` 落）。
    """
    counts = {key: 0 for key in MAIL_COUNT_KEYS}
    if ledger is None:
        return counts
    queued: set = set()
    for row in ledger.read():
        body = _body(row)
        type_ = str(row.get("type") or "")
        if type_ == "mail/queued":
            message_id = str(body.get("message_id") or "")
            if message_id and message_id not in queued:
                queued.add(message_id)
        elif type_ == "mail/refused":
            counts["refused"] += 1
        elif type_ == "mail/sent":
            counts["sent"] += 1
        elif type_ == "mail/parsed":
            counts["parsed"] += 1
    counts["queued"] = len(queued)
    return counts


def _mail_snapshot(shared: Path, selected: list, *, state_path: str = "", config_path: str = "") -> dict:
    """邮件域状态快照（`<shared>/mail.json`）：**队列计数（账本事实）+ 传输真实状态（mail_transport）**。

    纪律见模块 docstring：只有计数/布尔/来源/原因码；没有凭据值，也没有邮件正文。
    """
    views = {}
    for view in VIEWS:
        if view not in selected:
            continue
        views[view] = _mail_counts(_open(_ledger_path(shared, view)))
    totals = {key: sum(item[key] for item in views.values()) for key in MAIL_COUNT_KEYS}
    transport = MailTransport(**({"state_path": state_path} if state_path else {}),
                              **({"config_path": config_path} if config_path else {}))
    status = transport.status()
    return {
        "schema": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "service": "mail",
        "views": views,
        "totals": totals,
        "transport": {
            "smtp": status["smtp"],
            "imap": status["imap"],
            "last_attempt": status.get("last_attempt"),
            "attempts": list(status.get("attempts") or []),
            "state": status.get("state"),
            "note": "只有布尔/来源/计数/原因码与 message_id：不含任何凭据值、不含邮件正文",
        },
        "note": "队列计数来自 mail/* 账本行（事实源）；传输状态来自 services/mail_transport 的真实状态",
    }


def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mail-snapshot",
                                     description="把邮件域的状态快照写到 <shared-dir>/mail.json")
    parser.add_argument("--views", default=",".join(VIEWS),
                        help=f"逗号分隔的视角（默认 {'/'.join(VIEWS)}）")
    parser.add_argument("--shared-dir", default=str(DEFAULT_SHARED),
                        help="共享目录：账本在 <shared-dir>/<view>/ledger.jsonl，快照写 <shared-dir>/mail.json")
    parser.add_argument("--mail-state", dest="mail_state", default="",
                        help="mail_transport 状态文件（可选；空 = 用环境变量 QUOTAGENT_MAIL_STATE 或默认落点）")
    parser.add_argument("--mail-config", dest="mail_config", default="",
                        help="配置文件落点（可选；空 = QUOTAGENT_MAIL_CONFIG 或 /workspace/config.yaml）")
    args = parser.parse_args(argv)

    selected = [item.strip() for item in str(args.views).split(",") if item.strip()]
    if not selected:
        print(json.dumps({"ok": False, "error": "没有指定视角：--views 不能为空"}, ensure_ascii=False))
        return 2
    unknown = [item for item in selected if item not in VIEWS]
    if unknown:
        print(json.dumps({"ok": False, "error": f"未知视角 {unknown}；已声明: {list(VIEWS)}"},
                         ensure_ascii=False))
        return 2

    shared = Path(args.shared_dir).expanduser()
    payload = _mail_snapshot(shared, selected, state_path=str(args.mail_state or ""),
                             config_path=str(args.mail_config or ""))
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=1)
    target = shared / "mail.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".json.tmp")     # 原子写：先 .tmp 再 replace
    tmp.write_text(blob, encoding="utf-8")
    tmp.replace(target)
    print(json.dumps({"ok": True, "out": _display(target), "bytes": len(blob.encode("utf-8")),
                      "mail_totals": payload["totals"],
                      "mail_transport": {"smtp_available": payload["transport"]["smtp"]["available"],
                                         "smtp_reason": payload["transport"]["smtp"]["reason"],
                                         "imap_available": payload["transport"]["imap"]["available"],
                                         "imap_reason": payload["transport"]["imap"]["reason"]},
                      "views": {view: body for view, body in payload["views"].items()}},
                     ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
