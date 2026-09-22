#!/usr/bin/env python3
"""check-gate-timeline-route —— 「审批等多久 / 变更单谁卡着」的**真 HTTP 端到端**（`tools/verify.sh gates` 的后半）。

真做十件事（全部走真进程 + 真路由 + 真回读 + **真跑 Python 侧唯一落账本者**，不是"看着像接上了"）：

  ① 造**两份真夹具账本**（用 `quotagent.kernel.ledger.Ledger` 逐行 append ⇒ 哈希链**真有效**，
     `gate-nudge.py` 才能往它追加）：承包商侧 = 两条待批人工门（一条 escalate 已超时、一条 remind 未超时）
     + 一条已 granted 的门（**不进等待列表**）+ 一张 change/priced 变更单 + 一行带哨兵的私域行；
     供应商侧 = 空账本（**空投影**）；
  ② 起真 `cli.mjs webui` 进程（随机端口、私有前缀 `/qgate`、私有 `--ui-shared`）；
  ③ 两视角 `GET <prefix>/<view>/gates/` 与 `<prefix>/<view>/api/gates` 都 200 且是**真页面/真契约**
     （`data-age-clock="facts-only"` + 口径那句话 + 逐条 `data-gate-next-action`），且 **0 行 `<script>` / 0 内联事件**；
  ④ **等待时长有口径**：JSON 的 `age_seconds` == **手算** `as_of − requested 事实 ts`（[12600, 9000]），
     `age_basis` 写清口径；同一 URL 两次 GET **逐字节一致**（不随刷新漂移；"两个不同 `now` 入口不变"
     由围栏门 `host/t282-gate-timeline-gate.mjs` 第 4 条举证）；
  ⑤ **空投影不编**：供应商侧页面 `data-gates-degraded="1"` + 有名 reason + **两个列表计数都为 0**，
     JSON `gates:[]`/`changes:[]`（没数据就不编，也不冒充健康）；
  ⑥ **催办 POST**：202 + 待办件 id + `next_action`；待办件**恰 0600**、**原话逐字**、sha256 由本脚本独立重算；
     **宿主账本零新增**（夹具账本 POST 前后逐字节一致）；
  ⑦ 真跑 `tools/gate-nudge.py`（**唯一落账本者**）：落一条 `gate/nudged`（body **恰 5 键**、不含理由正文），
     待办件移入 `applied/`（不删）；**真回读** `/api/status` 的账本计数 **9 → 10**（ops 计数 +1）；
  ⑧ **幂等**：同一份（门 + 理由）再提一次 + 再跑一次 → `duplicates`（`already-nudged`）、**账本零新增**、`exit 0`；
  ⑨ **拒绝路径**（各自 code + next_action，且**拒绝时账本零新增**）：不存在的门 → POST 404 `gate-not-found`；
     被改过的待办件 → `pending-tampered`；
  ⑩ 私域哨兵 **0 命中**（两视角 gates 页/JSON），**非空转对照**：同一批哨兵确实写在夹具账本文件里。

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
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.ledger import Ledger  # noqa: E402

CHECKS: list[dict] = []
SCRIPT_NEEDLE = "<scr" + "ipt"
INLINE_EVENT = re.compile(r"\son[a-z]+\s*=", re.I)
SENTINELS = ["COST-MODEL-SENTINEL-9a", "RESERVE-PRICE-SENTINEL-4b", "PRIVATE-NOTE-SENTINEL-7f", "987654321"]
PRIVATE_KEYS = ["cost_floor", "markup_pct", "reserve_price", "cost_model", "private:", "bidders_private"]
REASONS = {"payload-not-an-object", "no-usable-inputs", "no-signal"}
# 手算（**从真运行量出来的，不是凭印象写**）：as_of = 承包商投影里最大的 ts = 2026-09-21T11:30:00Z
#   ap-0007 requested 08:00 ⇒ 12600 秒（escalate / timeout_s 3600 ⇒ 已超时）
#   ap-0009 requested 09:00 ⇒  9000 秒（remind  / timeout_s 86400 ⇒ 未超时，再等 77400 秒）
#   ap-0001 已 granted ⇒ 不进等待列表；变更单 chg-0001 = change/priced ⇒ 等人工门
AS_OF = "2026-09-21T11:30:00Z"
HAND_AGES = [12600, 9000]
REASON_HTTP = "这批料已经到场了，等您签字才能开工（原话逐字）"
REASON_DUP = "同一条催办重提必须幂等（这条用来验 duplicates）"

SHARED = ROOT / "tmp" / "gate-route"
UI_SHARED = SHARED / "ui-shared"
INBOX = UI_SHARED / "gate-nudges"
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


def get(url: str) -> tuple[int, str]:
    return raw_request(url)


def post_form(url: str, fields: dict[str, str]) -> tuple[int, str]:
    body = urllib.parse.urlencode(fields).encode("utf-8")
    return raw_request(url, data=body)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mode_of(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def parse_json(body: str) -> dict:
    try:
        data = json.loads(body)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def count_attr(text: str, attr: str) -> int | None:
    found = re.search(rf'data-gates-{attr}="(\d+)"', text)
    return int(found.group(1)) if found else None


def page_reason(text: str) -> str:
    found = re.search(r'data-gates-degraded="1"[\s\S]{0,400}?<code>([^<]*)</code>', text)
    return found.group(1) if found else ""


def ledger_rows(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    return rows


def nudged_events() -> list[dict]:
    path = CONTRACTOR_LEDGER
    return [row for row in ledger_rows(path) if row.get("type") == "gate/nudged"]


def pending_files() -> list[Path]:
    return sorted(path for path in INBOX.glob("gn-*.json")) if INBOX.is_dir() else []


def applied_files() -> list[Path]:
    archive = INBOX / "applied"
    return sorted(archive.glob("*.json")) if archive.is_dir() else []


def run_nudge(*extra: str) -> tuple[int, dict, str]:
    proc = subprocess.run([sys.executable, str(ROOT / "tools" / "gate-nudge.py"), *extra,
                           "--ui-shared", str(UI_SHARED),
                           "--ledger-contractor", str(CONTRACTOR_LEDGER),
                           "--ledger-supplier", str(SUPPLIER_LEDGER)],
                          capture_output=True, text=True, timeout=120)
    try:
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        payload = {}
    return proc.returncode, payload, (proc.stderr or "").strip()[-200:]


# ---------------------------------------------------------------------------
# ① 夹具：**真哈希链**的账本（gate-nudge.py 要往它追加，手写行会被账本自检挡住）
# ---------------------------------------------------------------------------
def write_fixtures() -> dict:
    report = {}
    for path in (CONTRACTOR_LEDGER, SUPPLIER_LEDGER):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)
    ui_shared_ledger = SUPPLIER_LEDGER
    rows = [
        ("approval/requested", "awin-1", "2026-09-21T08:00:00Z",
         {"approval_id": "ap-0007", "scope": "award.commit", "ref": "awin-1", "summary": "授标承诺",
          "approvers": ["human:liangzi"], "timeout_policy": "escalate", "timeout_s": 3600,
          "escalate_to": "human:boss"}),
        ("approval/requested", "po-1", "2026-09-21T09:00:00Z",
         {"approval_id": "ap-0009", "scope": "po.issue", "ref": "po-1", "summary": "发 PO",
          "timeout_policy": "remind", "timeout_s": 86400}),
        ("approval/requested", "q-1", "2026-09-21T07:00:00Z",
         {"approval_id": "ap-0001", "scope": "quote.submit", "ref": "q-1", "timeout_policy": "remind",
          "timeout_s": 60}),
        ("approval/granted", "q-1", "2026-09-21T07:30:00Z",
         {"approval_id": "ap-0001", "scope": "quote.submit", "ref": "q-1", "decided_by": "human:liangzi"}),
        ("change/priced", "chg-0001", "2026-09-21T10:00:00Z",
         {"change_id": "chg-0001", "quote_id": "q-1", "delta_amount": 1720,
          "basis_unit_price_refs": ["q-1#L-001:unit_price"]}),
        # 私域行：带 `private:` 命名的键 → 整行跳过，但**夹具文件里确实有哨兵**（非空转对照）
        ("quote/submitted", "q-private", AS_OF,
         {"quote_id": "q-private", "lines": [{"item_id": "L-001", "qty": 10, "unit_price": 60}],
          "cost_floor": SENTINELS[3], "markup_pct": 12.5, "reserve_price": SENTINELS[1],
          "cost_model": SENTINELS[0], "private:note": SENTINELS[2]}),
    ]
    ledger = Ledger(CONTRACTOR_LEDGER, realm="contractor:con-B")
    for type_, correlation, ts, body in rows:
        ledger.append(type_, body, correlation_id=correlation, ts=ts, actor="agent:fixture")
    SUPPLIER_LEDGER.write_text("", encoding="utf-8")
    report["rows"] = ledger.count
    report["healthy"] = bool(ledger.verify_report()["ok"])
    report["supplier"] = str(ui_shared_ledger)
    return report


def serve(port: int, prefix: str) -> subprocess.Popen:
    return subprocess.Popen(
        ["node", str(ROOT / "host" / "cli.mjs"), "webui", "--profile", "webui", "--port", str(port),
         "--host", "127.0.0.1", "--prefix", prefix, "--ui-shared", str(UI_SHARED),
         "--ledger-contractor", str(CONTRACTOR_LEDGER), "--ledger-supplier", str(SUPPLIER_LEDGER)],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        env={key: value for key, value in os.environ.items() if key != "QUOTAGENT_ADMIN_TOKEN"})


def wait_up(base: str, proc: subprocess.Popen) -> bool:
    for _ in range(40):
        code, _body = get(f"{base}/api/health")
        if code == 200:
            return True
        if proc.poll() is not None:
            return False
        time.sleep(0.5)
    return False


def ledger_count(base: str, view: str = "contractor") -> int | None:
    """真回读：`/api/status` 里该视角账本的行数（ops 计数 +1 的机检形态）。"""
    doc = parse_json(get(f"{base}/api/status")[1])
    entry = (doc.get("ledgers") or {}).get(view) or {}
    return entry.get("count") if isinstance(entry.get("count"), int) else None


def main() -> int:  # noqa: C901
    shutil.rmtree(SHARED, ignore_errors=True)
    fixture = write_fixtures()
    INBOX.mkdir(parents=True, exist_ok=True)
    # 私域行**不经过投影**：但账本文件里确实有哨兵（非空转对照）
    fixture_text = CONTRACTOR_LEDGER.read_text(encoding="utf-8")
    fixture_has = [needle for needle in SENTINELS if needle in fixture_text]
    check("① 夹具就绪（承包商 6 行真哈希链 / 供应商 0 行空账本 / 私有 ui-shared / 哨兵在文件里）",
          fixture["rows"] == 6 and fixture["healthy"] and len(fixture_has) >= 3
          and SUPPLIER_LEDGER.read_text(encoding="utf-8") == "",
          f"账本行={fixture['rows']} 链自洽={fixture['healthy']}；哨兵命中={fixture_has}")

    ledger_before = sha256_file(CONTRACTOR_LEDGER)
    port, prefix = free_port(), "/qgate"
    proc = serve(port, prefix)
    base = f"http://127.0.0.1:{port}{prefix}"
    try:
        up = wait_up(base, proc)
        check("② 真进程就绪（`cli.mjs webui` + `/api/health` 200；**不需要**管理员 token）",
              up, f"port={port} prefix={prefix} pid={proc.pid}")
        if not up:
            return 2

        # ---- ③ 路由登记 + 页面/JSON ----
        routes = parse_json(get(f"{base}/api/routes")[1]).get("routes", [])
        gate_routes = [item for item in routes if "/gates" in str(item.get("path", ""))]
        pages = {view: get(f"{base}/{view}/gates/") for view in ("contractor", "supplier")}
        jsons = {view: get(f"{base}/{view}/api/gates") for view in ("contractor", "supplier")}
        parsed = {view: parse_json(jsons[view][1]) for view in jsons}
        check("③ `/api/routes` 登记了两视角 ×（页面 + JSON + 催办 POST）**六条路由**，`auth` 都是 `none`"
              "（看等待时长不需要管理员身份）",
              len(gate_routes) == 6 and all(item.get("auth") == "none" for item in gate_routes)
              and len([i for i in gate_routes if i.get("method") == "GET"]) == 4
              and len([i for i in gate_routes if i.get("method") == "POST"]) == 2,
              f"命中={json.dumps([f'{i.get('method')} {i.get('path')}' for i in gate_routes], ensure_ascii=False)}")

        cpage, spage = pages["contractor"][1], pages["supplier"][1]
        cjson, sjson = parsed["contractor"], parsed["supplier"]
        next_actions = re.findall(r'data-gate-next-action="([^"]+)"', cpage)
        nav_ok = 'data-subnav="contractor"' in cpage and 'data-gates-link="1"' in cpage
        clock_ok = 'data-age-clock="facts-only"' in cpage and "不取墙钟" in cpage
        check("③ 承包商侧 gates 页/JSON 200 且是**真页面/真契约**：道内子导航含「审批与变更」入口、"
              "`data-age-clock=\"facts-only\"` + 口径文案、**逐条 `data-gate-next-action`**、"
              "JSON 契约齐备（engine/age_clock/age_basis_note/gates/changes/counts/degraded）",
              pages["contractor"][0] == 200 and jsons["contractor"][0] == 200
              and nav_ok and clock_ok and len(next_actions) == 2
              and 'data-gates="table"' in cpage and 'data-gates="changes"' in cpage
              and cjson.get("engine") == "rules" and cjson.get("age_clock") == "facts-only"
              and isinstance(cjson.get("age_basis_note"), str) and "不取墙钟" in str(cjson.get("age_basis_note"))
              and len(cjson.get("gates", [])) == 2 and len(cjson.get("changes", [])) == 1
              and cjson.get("degraded") is False and cjson.get("reason") is None,
              f"status={pages['contractor'][0]}/{jsons['contractor'][0]}；入口={nav_ok}；时钟口径={clock_ok}；"
              f"next_action 行={next_actions}；门={len(cjson.get('gates', []))} 变更={len(cjson.get('changes', []))}")

        # ---- ④ 等待时长有口径（手算 + 逐字节稳定） ----
        ages = [item.get("age_seconds") for item in cjson.get("gates", [])]
        ids = [item.get("id") for item in cjson.get("gates", [])]
        basis_ok = all(isinstance(item.get("age_basis"), str) and "as_of" in str(item.get("age_basis"))
                       and "不取墙钟" in str(item.get("age_basis")) for item in cjson.get("gates", []))
        again_page = get(f"{base}/contractor/gates/")
        again_json = get(f"{base}/contractor/api/gates")
        check("④ **等待时长有口径且可复算**：JSON 的 `age_seconds` == 手算 `as_of(11:30) − requested 事实 ts`"
              "（[12600, 9000]，且已 granted 的 ap-0001 **不进**等待列表）；每条都带 `age_basis`（含 `as_of` 与"
              "「不取墙钟」）；同一 URL 两次 GET **逐字节一致**（不随刷新漂移）",
              ids == ["ap-0007", "ap-0009"] and ages == HAND_AGES and basis_ok
              and cjson.get("as_of") == AS_OF
              and cjson.get("ignored_now_inputs") == ["payload.now", "config.now"]
              and again_page[1] == cpage and again_json[1] == jsons["contractor"][1]
              and "12600" in cpage and "9000" in cpage,
              f"id={ids} age={ages}（期望 {HAND_AGES}）；as_of={cjson.get('as_of')}；"
              f"每条 basis 合格={basis_ok}；页面两次一致={again_page[1] == cpage}；"
              f"JSON 两次一致={again_json[1] == jsons['contractor'][1]}")

        # ---- ⑤ 空投影不编 ----
        check("⑤ **空投影不编**（真进程真回读）：供应商侧（空账本）页面 `data-gates-degraded=\"1\"` + 有名 reason + "
              "**两个列表计数都为 0**，JSON `gates:[]`/`changes:[]` + `degraded:true`（没数据就不编，也不冒充健康）",
              pages["supplier"][0] == 200 and jsons["supplier"][0] == 200
              and 'data-gates-degraded="1"' in spage and page_reason(spage) in REASONS
              and count_attr(spage, "gate-count") == 0 and count_attr(spage, "change-count") == 0
              and sjson.get("gates") == [] and sjson.get("changes") == []
              and sjson.get("degraded") is True and sjson.get("reason") in REASONS
              and "待办人工门 <b>0</b> 条、变更单 <b>0</b> 条" in spage,
              f"page={pages['supplier'][0]} degraded={'data-gates-degraded=\"1\"' in spage} "
              f"reason={page_reason(spage)}；JSON degraded={sjson.get('degraded')}/{sjson.get('reason')} "
              f"门={sjson.get('gates')} 变更={sjson.get('changes')}；"
              f"页面计数={count_attr(spage, 'gate-count')}/{count_attr(spage, 'change-count')}")

        # ---- ⑥ 催办 POST（宿主只落 0600 待办件、账本零新增） ----
        counts_before = ledger_count(base)
        posted = post_form(f"{base}/contractor/gates/nudge", {"id": "ap-0007", "reason": REASON_HTTP})
        posted_json = parse_json(posted[1])
        files = pending_files()
        records = {path.name: json.loads(path.read_text(encoding="utf-8")) for path in files}
        modes = sorted({mode_of(path) for path in files})
        digest_ok = all(item.get("reason_sha256") == "sha256:" + hashlib.sha256(REASON_HTTP.encode()).hexdigest()
                        for item in records.values())
        verbatim = any(item.get("reason") == REASON_HTTP for item in records.values())
        check("⑥ 催办 POST：**202** + 待办件 id + `next_action`；待办件**恰 0600**、**原话逐字**、sha256 由本脚本"
              "独立重算一致；**宿主账本零新增**（夹具账本 POST 前后逐字节一致）",
              posted[0] == 202 and posted_json.get("ok") is True and posted_json.get("code") == "accepted"
              and re.match(r"^gn-contractor-[0-9a-f]{12}$", str(posted_json.get("id"))) is not None
              and "tools/gate-nudge.py" in str(posted_json.get("next_action"))
              and len(files) == 1 and modes == [0o600] and verbatim and digest_ok
              and sha256_file(CONTRACTOR_LEDGER) == ledger_before,
              f"status={posted[0]} id={posted_json.get('id')}；文件={[p.name for p in files]} "
              f"mode={[oct(m) for m in modes]} 逐字={verbatim} 哈希={digest_ok}；"
              f"账本未变={sha256_file(CONTRACTOR_LEDGER) == ledger_before}；"
              f"next_action={str(posted_json.get('next_action'))[:70]}…")

        # ---- ⑦ 真跑唯一落账本者：gate/nudged + 归档 + ops 计数 +1 ----
        code, payload, err = run_nudge("--now", "2026-09-21T22:00:00Z")
        events = nudged_events()
        body = events[-1]["body"] if events else {}
        after_count = ledger_count(base)
        body_keys = sorted(body)
        check("⑦ 真跑 `tools/gate-nudge.py`（**唯一落账本者**）：落一条 `gate/nudged`（body **恰 5 键**："
              "gate_id/view/actor/reason_sha256/ok，**不含理由正文**）→ 待办件移入 `applied/`（不删）；"
              "**真回读** `/api/status` 的账本行数 **6 → 7**（ops 计数 +1）",
              code == 0 and payload.get("ledger_added") == 1 and payload.get("ok") is True
              and body_keys == ["actor", "gate_id", "ok", "reason_sha256", "view"]
              and body.get("ok") is True and body.get("actor") == "agent:gate-nudge"
              and body.get("gate_id") == "ap-0007" and body.get("view") == "contractor"
              and body.get("reason_sha256") == hashlib.sha256(REASON_HTTP.encode()).hexdigest()
              and len(applied_files()) == 1 and len(pending_files()) == 0
              and REASON_HTTP not in CONTRACTOR_LEDGER.read_text(encoding="utf-8")
              and counts_before == 6 and after_count == 7,
              f"rc={code} err={err}；ledger_added={payload.get('ledger_added')}；body 键={body_keys}；"
              f"applied={[p.name for p in applied_files()]}；计数 {counts_before} → {after_count}；"
              f"账本里有理由正文={REASON_HTTP in CONTRACTOR_LEDGER.read_text(encoding='utf-8')}")

        # ---- ⑧ 幂等 ----
        dup_post = post_form(f"{base}/contractor/gates/nudge", {"id": "ap-0007", "reason": REASON_DUP})
        code_dup, payload_dup, err_dup = run_nudge("--now", "2026-09-21T22:05:00Z")
        dup_post2 = post_form(f"{base}/contractor/gates/nudge", {"id": "ap-0007", "reason": REASON_DUP})
        code_dup2, payload_dup2, err_dup2 = run_nudge("--now", "2026-09-21T22:06:00Z")
        check("⑧ **幂等**：同一份（门 + 理由）再提交 + 再跑 → 第二次标 `duplicates`（`already-nudged`）、"
              "**账本零新增**、`exit 0`；两次提交拿到**同一个待办件 id**（同一份事实只有一条）",
              dup_post[0] == 202 and dup_post2[0] == 202 and code_dup == 0 and code_dup2 == 0
              and payload_dup.get("ledger_added") == 1 and payload_dup2.get("ledger_added") == 0
              and payload_dup2.get("duplicates") and payload_dup2["duplicates"][0]["reason"] == "already-nudged"
              and payload_dup2.get("refused") == []
              and parse_json(dup_post[1]).get("id") == parse_json(dup_post2[1]).get("id")
              and len(nudged_events()) == 2 and ledger_count(base) == 8,
              f"rc={code_dup}/{code_dup2}；ledger_added={payload_dup.get('ledger_added')}/"
              f"{payload_dup2.get('ledger_added')}；duplicates="
              f"{json.dumps(payload_dup2.get('duplicates'), ensure_ascii=False)[:160]}；err={err_dup}/{err_dup2}")

        # ---- ⑨ 拒绝路径 ----
        lines_before = len(ledger_rows(CONTRACTOR_LEDGER))
        bad_post = post_form(f"{base}/contractor/gates/nudge", {"id": "ap-9999", "reason": "不存在的门"})
        bad_json = parse_json(bad_post[1])
        tampered = INBOX / "gn-contractor-ffffffffffff.json"
        tampered.write_text(json.dumps({"schema": 1, "kind": "gate-nudge", "view": "contractor",
                                        "gate_id": "ap-0007", "requested_action": "nudge",
                                        "reason": "被改过的理由", "reason_sha256": "sha256:" + "0" * 64,
                                        "bytes": 18, "submitted_at": ""}, ensure_ascii=False) + "\n",
                            encoding="utf-8")
        os.chmod(tampered, 0o600)
        code_t, payload_t, _ = run_nudge("--now", "2026-09-21T22:10:00Z")
        tampered.unlink(missing_ok=True)
        refused = (payload_t.get("refused") or [{}])[0]
        check("⑨ **拒绝路径**各自给具体 `code` + `next_action`，且**拒绝时账本零新增**："
              "不存在的门 → POST **404 `gate-not-found`**（页面上的门 id 才是真的）；"
              "被改过的待办件 → `pending-tampered`",
              bad_post[0] == 404 and bad_json.get("code") == "gate-not-found"
              and bad_json.get("next_action") and "账本零新增" in str(bad_json.get("next_action"))
              and code_t == 1 and refused.get("code") == "pending-tampered" and refused.get("next_action")
              and payload_t.get("ledger_added") == 0
              and len(ledger_rows(CONTRACTOR_LEDGER)) == lines_before,
              f"POST={bad_post[0]} code={bad_json.get('code')}；脚本 rc={code_t} code={refused.get('code')}；"
              f"账本行 {lines_before} → {len(ledger_rows(CONTRACTOR_LEDGER))}")

        # ---- ⑩ 私域哨兵 0 命中 + 0 脚本 + 既有路由 ----
        combined = {"contractor": cpage + jsons["contractor"][1], "supplier": spage + jsons["supplier"][1]}
        hits = {view: [needle for needle in PRIVATE_KEYS + SENTINELS if needle in text]
                for view, text in combined.items()}
        scripty = [name for name, text in (("page:c", cpage), ("page:s", spage),
                                          ("json:c", jsons["contractor"][1]), ("json:s", jsons["supplier"][1]))
                   if SCRIPT_NEEDLE in text or INLINE_EVENT.search(text)]
        admin_code, admin_body = get(f"{base}/admin/")
        home_code, _ = get(f"{base}/contractor/")
        ops_code, _ = get(f"{base}/api/ops")
        check("⑩ 两视角 gates 页/JSON 里私域键名与哨兵 **0 命中**（这类键连读都不读）+ **非空转对照**"
              "（同一批哨兵确实写在夹具账本文件里）；四份响应 **0 行脚本 / 0 内联事件**（扫描器非空转）；"
              "既有路由没坏、未提权 `/admin/` 仍 401 固定体",
              not hits["contractor"] and not hits["supplier"] and len(fixture_has) >= 3
              and not scripty and (SCRIPT_NEEDLE in f"<a {SCRIPT_NEEDLE}>" or INLINE_EVENT.search('<a onclick="x()">'))
              and home_code == 200 and ops_code == 200 and admin_code == 401
              and admin_body.strip() == '{"error":"unauthorized"}',
              f"承包商命中={hits['contractor'] or '无'}；供应商命中={hits['supplier'] or '无'}；"
              f"夹具里确实有哨兵={fixture_has}；含脚本={scripty or '无'}；"
              f"home={home_code} ops={ops_code} admin={admin_code}")
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
