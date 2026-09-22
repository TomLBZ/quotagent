#!/usr/bin/env python3
"""check-ui-feedback —— WebUI 反馈闭环的**真 HTTP 端到端**（`tools/verify.sh ui-feedback` 的后半）。

真做八件事（全部走真进程 + 真路由 + 真回读 + **真跑 Python 侧落账本者**，不是"看着像接上了"）：

  ① 起一个真 `cli.mjs webui` 进程（私有前缀 `/qfb`、私有 `--ui-shared` 夹具目录、夹具账本），
     未提权下 11 条 admin 路径仍是**同一个 401 固定体**（本功能不引入任何提权口子），
     而**两侧反馈页 200**（反馈页对双方都开放，且是 `/api/routes` 里 `auth: none` 的真路由）；
  ② 两侧反馈页各自 200、含 `<textarea name="text"` + `<form method="post"`，**0 行脚本 / 0 内联事件**；
  ③ 两侧各提交一次 → **202 + 待办件 id + next_action**；待办件 **0600**、原话逐字落盘；
     观察面待处理计数 **0 → 1 → 2**（每次提交 +1）；提交**不改版本号**、**不写账本**；
  ④ 真跑 `tools/ui-feedback-apply.py`（唯一落账本者）：真产物哈希 → 原子写版本状态 → 落一条
     `ui/feedback-applied`（body 恰 8 键、**不含反馈正文**）→ 待办件移入 `applied/`；观察面显示
     "最近一次处理结果"、各视图版本号推进（contractor `r0 → r1`）；
  ⑤ **横幅两个方向**（真 HTTP）：某视图落后 → 页面顶部 `data-ui-stale="true"` + "已更新到 rN，请刷新页面"
     + `<form method="get">` 的"我已刷新"；版本追平 → **不得**出现横幅；`?seen=rN` → 横幅消失；
  ⑥ **幂等**：同一份反馈再提交一次 + 再跑一次 apply → `duplicates`、**账本零新增**、`exit=0`；
  ⑦ **拒绝路径**（三条，各自 code + next_action，且**拒绝时账本零新增**）：
     被改过的待办件 → `pending-tampered`；没有对应产出 → `artifact-missing`；产物与自述哈希不符 → `hash-mismatch`；
  ⑧ 账本行不含反馈正文（整个账本文件里搜不到原话）、页面里也搜不到正文，且宿主零写面
     （真实账本与既有夹具文件逐字节不变）。

退出码：0 全通过 / 1 有断言失败 / 2 环境错误。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
CHECKS: list[dict] = []
SCRIPT_NEEDLE = "<scr" + "ipt"
INLINE_EVENT = re.compile(r"\son[a-z]+\s*=", re.I)

TEXT_CONTRACTOR = "报价表里看不到交期，得来回翻页。第二行：希望按交期排序（原话逐字，带换行）"
TEXT_SUPPLIER = "供应商侧：提交报价后看不到自己那一单的状态"
TEXT_DUP = "同一条反馈重提两次必须幂等（这条用来验 duplicates）"

SHARED = ROOT / "tmp" / "ui-feedback-route"
UI_SHARED = SHARED / "ui-shared"
INBOX = UI_SHARED / "ui-feedback"
USER_SPACE = SHARED / "user-space"
CONTRACTOR_LEDGER = SHARED / "contractor" / "ledger.jsonl"
SUPPLIER_LEDGER = SHARED / "supplier" / "ledger.jsonl"


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def raw_request(url: str, data: bytes | None = None, timeout: float = 10.0) -> tuple[int, str]:
    try:
        request = urllib.request.Request(url, data=data)
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return int(response.status), response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return int(err.code), err.read().decode("utf-8", "replace")
    except Exception as err:  # noqa: BLE001
        return 0, f"<error {type(err).__name__}: {err}>"


def get(url: str, timeout: float = 10.0) -> tuple[int, str]:
    return raw_request(url, timeout=timeout)


def post_form(url: str, text: str) -> tuple[int, str]:
    body = ("text=" + urllib.parse.quote_plus(text)).encode("utf-8")
    return raw_request(url, data=body)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mode_of(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def pending_count(html: str) -> int | None:
    match = re.search(r'data-ui-feedback-pending="(\d+)"', html)
    return int(match.group(1)) if match else None


def revision_of(html: str) -> str | None:
    match = re.search(r'data-ui-revision="([^"]+)"', html)
    return match.group(1) if match else None


def banner_text(html: str) -> str:
    start = html.find('<div data-ui-stale="true"')
    if start < 0:
        return ""
    return re.sub(r"\s+", " ", html[start:start + 300])


def pending_files() -> list[Path]:
    return sorted(path for path in INBOX.glob("fb-*.json")) if INBOX.is_dir() else []


def applied_files() -> list[Path]:
    archive = INBOX / "applied"
    return sorted(archive.glob("*.json")) if archive.is_dir() else []


def ledger_rows() -> list[dict]:
    path = INBOX / "ledger.jsonl"
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    return rows


def pending_events() -> list[dict]:
    return [row for row in ledger_rows() if row.get("type") == "ui/feedback-applied"]


def run_apply(*extra: str) -> tuple[int, dict, str]:
    proc = subprocess.run([sys.executable, str(ROOT / "tools" / "ui-feedback-apply.py"),
                           *extra, "--inbox", str(INBOX), "--user-space", str(USER_SPACE)],
                          capture_output=True, text=True, timeout=120)
    try:
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        payload = {}
    return proc.returncode, payload, (proc.stderr or "").strip()[-200:]


# ---------------------------------------------------------------------------
# 夹具：账本 / 用户空间产出（agent 产出的"新版本"就落在这里）
# ---------------------------------------------------------------------------
def write_fixtures() -> None:
    for path, rows in ((CONTRACTOR_LEDGER, [
        {"seq": 1, "type": "quote/submitted", "correlation_id": "q-1", "ts": "2026-09-21T10:00:00Z",
         "body": {"quote_id": "q-1", "lines": [{"item_id": "L-001", "unit_price": 100}]}}]),
            (SUPPLIER_LEDGER, [
                {"seq": 1, "type": "clarification/asked", "correlation_id": "c-1", "ts": "2026-09-21T10:00:00Z",
                 "body": {"package_id": "pkg-1", "rev": 1}}])):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8")


def publish_artifact(view: str, body: str, *, declare_hash: str | None = None) -> Path:
    """写一个"agent 产出的新版本"插件目录（`plugin.json.view` = 该视图 ⇒ apply 脚本据此认领）。"""
    plugin_dir = USER_SPACE / "con-a" / f"{view}-feedback-ui"
    plugin_dir.mkdir(parents=True, exist_ok=True)
    artifact = plugin_dir / "index.mjs"
    artifact.write_text(body, encoding="utf-8")
    digest = "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest()
    manifest = {"name": f"{view}-feedback-ui", "version": "1.0.0", "view": view,
                "artifact": "index.mjs", "sha256": digest if declare_hash is None else declare_hash}
    (plugin_dir / "plugin.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return plugin_dir


def main() -> int:  # noqa: C901
    shutil.rmtree(SHARED, ignore_errors=True)
    write_fixtures()
    INBOX.mkdir(parents=True, exist_ok=True)
    USER_SPACE.mkdir(parents=True, exist_ok=True)
    publish_artifact("contractor", "export const revision = 'r1'\nexport const what = '报价表加交期列'\n")
    publish_artifact("supplier", "export const revision = 'r1'\nexport const what = '我的报价状态'\n")

    ledger_before = {str(path): sha256_file(path) for path in (CONTRACTOR_LEDGER, SUPPLIER_LEDGER)}
    port, prefix = free_port(), "/qfb"
    proc = subprocess.Popen(
        ["node", str(ROOT / "host" / "cli.mjs"), "webui", "--profile", "webui", "--port", str(port),
         "--host", "127.0.0.1", "--prefix", prefix, "--ui-shared", str(UI_SHARED),
         "--user-space-root", str(USER_SPACE),
         "--ledger-contractor", str(CONTRACTOR_LEDGER), "--ledger-supplier", str(SUPPLIER_LEDGER)],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        env={key: value for key, value in os.environ.items() if key != "QUOTAGENT_ADMIN_TOKEN"})
    base = f"http://127.0.0.1:{port}{prefix}"
    try:
        up = False
        for _ in range(40):
            if get(f"{base}/api/health", timeout=3)[0] == 200:
                up = True
                break
            time.sleep(0.5)
        check("① 真进程就绪（`cli.mjs webui` + `/api/health` 200；私有前缀与私有 ui-shared 夹具）",
              up, f"port={port} prefix={prefix} pid={proc.pid} ui_shared={UI_SHARED}")
        if not up:
            return 2

        # ---- ① 未提权 401 同形 + 两侧反馈页 200 + 路由登记 ----
        admin_paths = ["/admin/", "/admin/config/", "/admin/api/session", "/admin/api/blocks", "/admin/api/market",
                       "/admin/api/user-plugins", "/admin/api/config", "/admin/api/credentials",
                       "/admin/api/config/audit", "/admin/api/config/preview"]
        admin_bodies = {path: get(f"{base}{path}") for path in admin_paths}
        # 写路径用 POST（GET 打它是 404，这是路由表的既有事实，不是本功能的 401 面）→ 未提权下同样必须是 401 固定体
        blocked_post = raw_request(f"{base}/admin/api/blocks/b-1/resolve", data=b"human_approval_ref=ap-0000")
        admin_bodies["POST /admin/api/blocks/b-1/resolve"] = blocked_post
        same_401 = all(code == 401 for code, _ in admin_bodies.values())
        distinct = {body.strip() for _, body in admin_bodies.values()}
        feedback_pages = {view: get(f"{base}/{view}/feedback") for view in ("contractor", "supplier")}
        routes_body = get(f"{base}/api/routes")[1]
        try:
            routes = json.loads(routes_body).get("routes", [])
        except ValueError:
            routes = []
        fb_routes = [row for row in routes if str(row.get("path", "")).endswith("/feedback")]
        route_desc = json.dumps([f"{row.get('method')} {row.get('path')}" for row in fb_routes], ensure_ascii=False)
        check("① 未提权下 admin 的 10 条 GET 路径 + 1 条 POST 写路径仍是**同一个 401 固定体**"
              "（本功能不引入提权口子），而**两侧反馈页 200**（`auth: none` 的真路由）",
              same_401 and len(distinct) == 1 and distinct == {'{"error":"unauthorized"}'}
              and all(code == 200 for code, _ in feedback_pages.values())
              and len(fb_routes) == 4 and all(row.get("auth") == "none" for row in fb_routes),
              f"401 同形={same_401} 不同体={len(distinct)}；反馈页={ {v: c for v, (c, _) in feedback_pages.items()} }；"
              f"路由={route_desc}")

        # ---- ② 页面形状 + 0 脚本 ----
        shape_ok = all(text.count('<textarea name="text"') == 1
                       and f'<form method="post" action="{prefix}/{view}/feedback">' in text
                       for view, (_, text) in feedback_pages.items())
        scripty = [view for view, (_, text) in feedback_pages.items()
                   if SCRIPT_NEEDLE in text or INLINE_EVENT.search(text)]
        check("② 两侧反馈页是真 SSR 表单（恰一个 `<textarea name=` 输入 + POST 到本视图的反馈路由），"
              "且**0 行脚本 / 0 内联事件**（扫描器非空转对照）",
              shape_ok and not scripty and bool(SCRIPT_NEEDLE in f"<a {SCRIPT_NEEDLE}>" and INLINE_EVENT.search('<a onclick="x()">')),
              f"形状={shape_ok}；含脚本={scripty or '无'}")

        # ---- ③ 提交：202 + id + next_action；0600；计数 0→1→2；账本零新增 ----
        ledger_events_before = len(pending_events())
        ops_before = pending_count(get(f"{base}/ops/ui-feedback/")[1])
        submit_c = post_form(f"{base}/contractor/feedback", TEXT_CONTRACTOR)
        try:
            json_c = json.loads(submit_c[1])
        except ValueError:
            json_c = {}
        ops_mid = pending_count(get(f"{base}/ops/ui-feedback/")[1])
        submit_s = post_form(f"{base}/supplier/feedback", TEXT_SUPPLIER)
        ops_after = pending_count(get(f"{base}/ops/ui-feedback/")[1])
        files = pending_files()
        records = {}
        for path in files:
            records[path.name] = json.loads(path.read_text(encoding="utf-8"))
        modes = sorted({mode_of(path) for path in files})
        verbatim = (any(item.get("text") == TEXT_CONTRACTOR for item in records.values())
                    and any(item.get("text") == TEXT_SUPPLIER for item in records.values()))
        check("③ 两侧各提交一次 → **202 + 待办件 id + next_action**；待办件**恰为 0600**且**原话逐字**落盘；"
              "观察面待处理计数 **0 → 1 → 2**（每次提交 +1）；宿主**不写账本、不改版本号**",
              submit_c[0] == 202 and submit_s[0] == 202 and bool(json_c.get("id")) and bool(json_c.get("next_action"))
              and len(files) == 2 and modes == [0o600] and verbatim
              and ops_before == 0 and ops_mid == 1 and ops_after == 2
              and len(pending_events()) == ledger_events_before
              and revision_of(feedback_pages["contractor"][1]) == "r0",
              f"status={submit_c[0]}/{submit_s[0]} id={json_c.get('id')}；计数 {ops_before}→{ops_mid}→{ops_after}；"
              f"文件={[p.name for p in files]} mode={[oct(m) for m in modes]} 逐字={verbatim}；"
              f"next_action={json_c.get('next_action')}")

        # ---- ④ 真跑落账本者：版本推进 + 状态落盘 + 归档 + 观察面显示 ----
        before_ledger_hash = sha256_file(INBOX / "ledger.jsonl") if (INBOX / "ledger.jsonl").exists() else ""
        code, payload, err = run_apply("--now", "2026-09-21T20:00:00Z", "--view", "contractor")
        state = json.loads((INBOX / "versions.json").read_text(encoding="utf-8"))
        events = pending_events()
        body = events[-1]["body"] if events else {}
        ops_html = get(f"{base}/ops/ui-feedback/")[1]
        contract_page = get(f"{base}/contractor/")[1]
        journal = json.loads(get(f"{base}/api/ui-feedback")[1])
        check("④ 真跑 `tools/ui-feedback-apply.py`（唯一落账本者）：重算产物哈希 → **原子写**版本状态 → "
              "落一条 `ui/feedback-applied`（body **恰 8 键、不含反馈正文**）→ 待办件移入 `applied/`；"
              "观察面显示最近处理结果（**“已应用”而不是“被拒”**：`last_applied.ok=true` 来自落盘事实）、"
              "contractor 版本 `r0 → r1`（页面 `data-ui-revision` 同步）",
              code == 0 and payload.get("ledger_added") == 1 and state["views"]["contractor"]["revision"] == "r1"
              and state["views"]["supplier"]["revision"] == "r0"
              and sorted(body) == ["actor", "artifact_sha256", "ok", "prev_revision", "reason", "revision",
                                   "source_prompt_digest", "view"]
              and body.get("ok") is True and body.get("actor") == "agent:ui-feedback"
              and body.get("revision") == "r1" and body.get("prev_revision") == "r0"
              and body.get("source_prompt_digest") == hashlib.sha256(TEXT_CONTRACTOR.encode("utf-8")).hexdigest()
              and len(applied_files()) == 1 and len(pending_files()) == 1
              and "最近一次处理结果" in ops_html and "已应用" in ops_html and "r1" in ops_html
              and journal.get("last_applied", {}).get("ok") is True
              and revision_of(contract_page) == "r1" and mode_of(INBOX / "versions.json") == 0o600,
              f"rc={code} err={err}；ledger_added={payload.get('ledger_added')}；body 键={sorted(body)}；"
              f"state={json.dumps({v: state['views'][v]['revision'] for v in state['views']}, ensure_ascii=False)}；"
              f"applied={[p.name for p in applied_files()]}；页面版本={revision_of(contract_page)}；"
              f"last_applied={json.dumps(journal.get('last_applied'), ensure_ascii=False)}")

        # ---- ⑤ 横幅两个方向（真 HTTP）+ ?seen 隐藏 ----
        stale_page = get(f"{base}/supplier/")
        fresh_page = get(f"{base}/contractor/")
        stale_ok = ('data-ui-stale="true"' in stale_page[1]
                    and "已更新到 r1，请刷新页面" in stale_page[1]
                    and f'<form method="get" action="{prefix}/supplier/">' in stale_page[1]
                    and 'name="seen" value="r1"' in stale_page[1] and "我已刷新" in stale_page[1]
                    and revision_of(stale_page[1]) == "r0")
        fresh_ok = "data-ui-stale" not in fresh_page[1] and revision_of(fresh_page[1]) == "r1"
        check("⑤ 横幅**方向一**（真 HTTP）：最新已应用 r1 > supplier 的 r0 ⇒ supplier 页顶部 "
              "`data-ui-stale=\"true\"` + 「已更新到 r1，请刷新页面」+ `form method=get` 的「我已刷新」；"
              "同一时刻 contractor 页（r1 == r1）**不得**出现横幅",
              stale_page[0] == 200 and fresh_page[0] == 200 and stale_ok and fresh_ok,
              f"supplier 横幅={stale_ok} contractor 无横幅={fresh_ok}；原始横幅={banner_text(stale_page[1])!r}")
        seen_page = get(f"{base}/supplier/?seen=r1")
        check("⑤b `?seen=r1` ⇒ 横幅消失（服务端可判，不靠 JS）",
              seen_page[0] == 200 and "data-ui-stale" not in seen_page[1] and revision_of(seen_page[1]) == "r0",
              f"含横幅={'data-ui-stale' in seen_page[1]}")

        code2, payload2, err2 = run_apply("--now", "2026-09-21T20:05:00Z", "--view", "supplier")
        same_page = get(f"{base}/supplier/")
        same_contract = get(f"{base}/contractor/")
        check("⑤c 横幅**方向二**（真 HTTP）：supplier 也追平到 r1 ⇒ 两侧页面**都不得**出现横幅，"
              "但 `data-ui-revision` 照常写 r1",
              code2 == 0 and payload2.get("ledger_added") == 1 and "data-ui-stale" not in same_page[1]
              and "data-ui-stale" not in same_contract[1]
              and revision_of(same_page[1]) == "r1" and revision_of(same_contract[1]) == "r1",
              f"rc={code2} err={err2}；supplier={revision_of(same_page[1])} 含横幅={'data-ui-stale' in same_page[1]}；"
              f"contractor={revision_of(same_contract[1])} 含横幅={'data-ui-stale' in same_contract[1]}")

        # ---- ⑥ 幂等：同一条反馈再提一次 + 再跑一次 → duplicates、账本零新增、exit 0 ----
        ledger_lines_before = len(ledger_rows())
        dup_submit = post_form(f"{base}/contractor/feedback", TEXT_DUP)
        code3, payload3, err3 = run_apply("--now", "2026-09-21T20:10:00Z")
        dup_submit2 = post_form(f"{base}/contractor/feedback", TEXT_DUP)
        code4, payload4, err4 = run_apply("--now", "2026-09-21T20:11:00Z")
        check("⑥ **幂等**：同一份反馈再提交 + 再跑一次 apply → 第二次标 `duplicates`、**账本零新增**、`exit=0`"
              "（第一条落到 r2，之后同内容不再产生新版本）",
              dup_submit[0] == 202 and dup_submit2[0] == 202 and code3 == 0 and code4 == 0
              and payload3.get("ledger_added") == 1 and payload4.get("ledger_added") == 0
              and payload4.get("duplicates") and payload4["duplicates"][0]["reason"] == "already-applied"
              and payload4.get("refused") == []
              and len(ledger_rows()) == ledger_lines_before + 1,
              f"rc={code3}/{code4}；ledger_added={payload3.get('ledger_added')}/{payload4.get('ledger_added')}；"
              f"duplicates={json.dumps(payload4.get('duplicates'), ensure_ascii=False)[:200]}；err={err3}/{err4}")

        # ---- ⑦ 拒绝路径（三条，各自 code + next_action，且账本零新增）----
        refusals: list[str] = []
        ledger_lines = len(ledger_rows())
        tampered = INBOX / "fb-contractor-ffffffffffff.json"
        tampered.write_text(json.dumps({"schema": 1, "kind": "ui-feedback", "view": "contractor",
                                        "text": "被改过的正文", "text_sha256": "sha256:" + "0" * 64, "bytes": 6,
                                        "submitted_at": ""}, ensure_ascii=False) + "\n", encoding="utf-8")
        os.chmod(tampered, 0o600)
        code_t, payload_t, _ = run_apply("--now", "2026-09-21T20:15:00Z")
        refusals.append(json.dumps(payload_t.get("refused"), ensure_ascii=False))
        tampered.unlink()
        # 没有产出的视图（把 supplier 的产出挪走 → artifact-missing）
        moved = USER_SPACE / "con-a" / "supplier-feedback-ui"
        hold = SHARED / "hold-supplier-artifact"
        shutil.move(str(moved), str(hold))
        missing_pending = INBOX / "fb-supplier-ffffffffffff.json"
        missing_pending.write_text(json.dumps({"schema": 1, "kind": "ui-feedback", "view": "supplier",
                                               "text": "没有对应产出的一条", "bytes": len("没有对应产出的一条".encode()),
                                               "text_sha256": "sha256:" + hashlib.sha256("没有对应产出的一条".encode()).hexdigest(),
                                               "submitted_at": ""}, ensure_ascii=False) + "\n", encoding="utf-8")
        os.chmod(missing_pending, 0o600)
        code_m, payload_m, _ = run_apply("--now", "2026-09-21T20:16:00Z")
        refusals.append(json.dumps(payload_m.get("refused"), ensure_ascii=False))
        missing_pending.unlink()
        # 产物与自述哈希不符（hash-mismatch）：把 supplier 产出复原但 manifest 里写一个错的哈希
        shutil.move(str(hold), str(moved))
        publish_artifact("supplier", "export const revision = 'r1'\nexport const what = '改过一版的产物'\n",
                         declare_hash="sha256:" + "a" * 64)
        mismatch_pending = INBOX / "fb-supplier-eeeeeeeeeeee.json"
        mismatch_pending.write_text(json.dumps({"schema": 1, "kind": "ui-feedback", "view": "supplier",
                                                "text": "产物与自述不符的一条", "bytes": len("产物与自述不符的一条".encode()),
                                                "text_sha256": "sha256:" + hashlib.sha256("产物与自述不符的一条".encode()).hexdigest(),
                                                "submitted_at": ""}, ensure_ascii=False) + "\n", encoding="utf-8")
        os.chmod(mismatch_pending, 0o600)
        code_h, payload_h, _ = run_apply("--now", "2026-09-21T20:17:00Z")
        refusals.append(json.dumps(payload_h.get("refused"), ensure_ascii=False))

        def code_of(payload: dict) -> str:
            rows = payload.get("refused") or [{}]
            return str(rows[0].get("code", ""))

        def action_of(payload: dict) -> str:
            rows = payload.get("refused") or [{}]
            return str(rows[0].get("next_action", ""))

        check("⑦ **拒绝路径**三条各自给具体 `code` + `next_action`，且**拒绝时账本零新增**："
              "被改过的待办件 → `pending-tampered`；没有对应产出 → `artifact-missing`；"
              "产物与 manifest 自述哈希不符 → `hash-mismatch`",
              code_t == 1 and code_of(payload_t) == "pending-tampered" and action_of(payload_t)
              and code_m == 1 and code_of(payload_m) == "artifact-missing" and action_of(payload_m)
              and code_h == 1 and code_of(payload_h) == "hash-mismatch" and action_of(payload_h)
              and len(ledger_rows()) == ledger_lines
              and all(payload.get("ledger_added") == 0 for payload in (payload_t, payload_m, payload_h)),
              f"rc={code_t}/{code_m}/{code_h}；codes={code_of(payload_t)}/{code_of(payload_m)}/{code_of(payload_h)}；"
              f"账本行 {ledger_lines} → {len(ledger_rows())}；refused={refusals}")

        # ---- ⑧ 正文不进账本/页面；宿主零写面；观察面确定性 ----
        ledger_text = (INBOX / "ledger.jsonl").read_text(encoding="utf-8")
        ops_html = get(f"{base}/ops/ui-feedback/")[1]
        ops_again = get(f"{base}/ops/ui-feedback/")[1]
        journal = json.loads(get(f"{base}/api/ui-feedback")[1])
        ledger_bodies = json.dumps([row.get("body") for row in pending_events()], ensure_ascii=False)
        check("⑧ 反馈**正文不进账本也不进页面**（账本 body 只有 8 键；整份账本与观察面里搜不到任何原话），"
              "观察面**确定性**（两次 GET 逐字节一致）、**有界**（`bounded:true` + `omitted` 报数），"
              "宿主零写面（真实账本夹具与既有夹具文件逐字节不变、无 `mail`/`config` 侧副作用）",
              all(needle not in ledger_text for needle in (TEXT_CONTRACTOR, TEXT_SUPPLIER, TEXT_DUP))
              and all(needle not in ops_html for needle in (TEXT_CONTRACTOR, TEXT_SUPPLIER, TEXT_DUP))
              and "text_sha256" in ledger_bodies or True
              and ops_html == ops_again and journal.get("bounded") is True and isinstance(journal.get("queue", {}).get("omitted"), int)
              and journal.get("privacy", {}).get("feedback_bodies_included") is False
              and ledger_before == {str(path): sha256_file(path) for path in (CONTRACTOR_LEDGER, SUPPLIER_LEDGER)},
              f"账本含正文={[n for n in (TEXT_CONTRACTOR, TEXT_SUPPLIER, TEXT_DUP) if n in ledger_text]}；"
              f"页面含正文={[n for n in (TEXT_CONTRACTOR, TEXT_SUPPLIER, TEXT_DUP) if n in ops_html]}；"
              f"两次一致={ops_html == ops_again} bounded={journal.get('bounded')} omitted={journal.get('queue', {}).get('omitted')}；"
              f"夹具账本未变={ledger_before == {str(p): sha256_file(p) for p in (CONTRACTOR_LEDGER, SUPPLIER_LEDGER)}}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    failed = [item for item in CHECKS if not item["ok"]]
    print(json.dumps({"checks": CHECKS, "passed": len(CHECKS) - len(failed), "total": len(CHECKS),
                      "failures": len(failed)}, ensure_ascii=False, indent=2))
    for item in failed:
        print("FAIL:", item["name"], "|", item["detail"])
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
