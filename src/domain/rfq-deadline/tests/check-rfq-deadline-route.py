#!/usr/bin/env python3
"""check-rfq-deadline-route —— 「来不及回 RFQ」的**真 HTTP 端到端**（`tools/verify.sh rfq-deadline` 的后半）。

真做十一件事（全部走真进程 + 真路由 + 真回读 + **真跑 Python 侧唯一落账本者**，不是"看着像接上了"）：

  ① 造**两份真夹具账本**（用 `quotagent.kernel.ledger.Ledger` 逐行 append ⇒ 哈希链**真有效**，
     `rfq-promise.py` 才能往它追加）：承包商侧 = 两个已发布包（一个还有 3.5 天、一个**已过期**）
     + 一条分发事实（谁在何时收到哪个版本）+ 一条报价事实 + 一行**带哨兵的私域行**；供应商侧 = 空账本；
  ② 起真 `cli.mjs webui` 进程（随机端口、私有前缀 `/qrt`、私有 `--ui-shared`、**私有的邮件快照夹具**
     `available=false`）；
  ③ 两视角 `GET <prefix>/<view>/deadlines/` 与 `<prefix>/<view>/api/deadlines` 都 200，
     且是**真页面/真契约**（`data-due-clock="facts-only"` + 口径那句话 + 逐条 `data-deadline-next-action`），
     四道页面子导航含入口，**0 行 `<script>` / 0 内联事件**；
  ④ **剩余时长有口径**：JSON 的 `remaining_seconds` == **手算** `due_ts − as_of`
     （[302400, -1800]，已过期那条 severity=overdue）；`due_basis` 写清来源；同一 URL 两次 GET
     **逐字节一致**（不随刷新漂移；"两个不同 `now` 入口不变"由围栏门 `host/t285-rfq-deadline-gate.mjs` 举证）；
  ⑤ **没凭据不得假装能发**：通道 `available=false` ⇒ 页面与 JSON 都写「无法代发」，
     且**整个响应里**「已通知/已提醒/已发送/已发出/已催」**0 命中**（非空转对照：把这些词塞进一个探针串能命中）；
  ⑥ **空投影不编**：供应商侧（空账本）页面 `data-deadlines-degraded="1"` + 有名 reason + 条目 0 条，
     JSON `rfqs:[]`（没数据就不编，也不冒充健康）；
  ⑦ **登记承诺 POST**：202 + 待办件 id + `next_action`；待办件**恰 0600**、**原话逐字**、
     sha256 由本脚本独立重算；**宿主账本零新增**（夹具账本 POST 前后逐字节一致）；
  ⑧ 真跑 `tools/rfq-promise.py`（**唯一落账本者**）：落一条 `rfq/promised`（body **恰 6 键**、
     不含原话正文），待办件移入 `applied/`（不删）；**真回读** `/api/status` 的账本计数 **5 → 6**；
  ⑨ **承诺真的改变了页面上口径**：`/api/deadlines` 的回文时限从 `rfq/published.quote_by`
     变成 `rfq/promised.due_at`（手算剩余 352800 秒），`due_basis` 指名 `rfq/promised`；
  ⑩ **幂等**：同一份（包 + 发言人 + 时限 + 原话）再提交 + 再跑 → `duplicates`（`already-promised`）、
     **账本零新增**、`exit 0`；
  ⑪ 拒绝路径：不存在的包 → POST **404 `rfq-not-found`**；被改过的待办件 → `pending-tampered`；
     两例都**账本零新增**。私域哨兵在两视角页面/JSON **0 命中**（**非空转对照**：哨兵确实写在夹具账本里）。

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
SENTINELS = ["COST-FLOOR-SENTINEL-9c", "RESERVE-PRICE-SENTINEL-4b", "PRIVATE-NOTE-SENTINEL-7f",
             "SUPPLIER-SENTINEL-1a2b", "987654321"]
PRIVATE_KEYS = ["cost_floor", "markup_pct", "reserve_price", "cost_model", "private:", "bidders_private"]
CLAIM_WORDS = ["已通知", "已提醒", "已发送", "已发出", "已催"]
REASONS = {"payload-not-an-object", "no-usable-inputs", "no-signal"}

# 手算（**从真运行量出来的，不是凭印象写**）：as_of = 承包商投影里最大的 ts = 2026-09-21T12:00:00Z
#   pkg-g1：发布事实 quote_by 2026-09-25T00:00:00Z ⇒ 302400 秒 → scheduled；名册 邀请 2 / 已回 1 / 未回 1
#   pkg-g2：发布事实 quote_by 2026-09-21T11:30:00Z ⇒ -1800 秒 → overdue
AS_OF = "2026-09-21T12:00:00Z"
HAND_REMAINING = {"pkg-g2": -1800, "pkg-g1": 302400}
PROMISE_NOTE = "周五下班前一定把这版的报价回过去（原话逐字）"
PROMISE_DUE = "2026-09-26T00:00:00Z"
PROMISE_BY = "human:liangzi"
NOW = "2026-09-21T22:00:00Z"
HAND_AFTER = {"as_of": NOW, "pkg-g1_remaining": 352800, "pkg-g2_remaining": -37800}
MAIL_REASON = "mail-transport-unavailable（缺 SMTP/IMAP 凭据 —— 夹具）"

SHARED = ROOT / "tmp" / "rfq-deadline-route"
UI_SHARED = SHARED / "ui-shared"
INBOX = UI_SHARED / "rfq-promises"
MAIL_SNAPSHOT = SHARED / "mail.json"
CONTRACTOR_LEDGER = SHARED / "contractor" / "ledger.jsonl"
SUPPLIER_LEDGER = SHARED / "supplier" / "ledger.jsonl"


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def raw_request(url: str, data: bytes | None = None, timeout: float = 10.0,
                headers: dict | None = None, follow_redirects: bool = True) -> tuple[int, str]:
    code, body, _headers = raw_request_full(url, data=data, timeout=timeout, headers=headers,
                                            follow_redirects=follow_redirects)
    return code, body


def raw_request_full(url: str, data: bytes | None = None, timeout: float = 10.0,
                     headers: dict | None = None, follow_redirects: bool = True) -> tuple[int, str, dict]:
    """底层请求（返回状态码 / 文本 / 响应头）。"""
    try:
        request = urllib.request.Request(url, data=data, headers=headers or {})
        opener = urllib.request.urlopen if follow_redirects else _NO_REDIRECT_OPENER.open
        with opener(request, timeout=timeout) as response:
            return int(response.status), response.read().decode("utf-8", "replace"), dict(response.headers)
    except urllib.error.HTTPError as err:
        return int(err.code), err.read().decode("utf-8", "replace"), dict(err.headers)
    except Exception as err:  # noqa: BLE001
        return 0, f"<error {type(err).__name__}: {err}>", {}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """**不跟** 303：身份门槛的「浏览器形状」判据就是那一次 303 本身（跟过去会变成 200 登录页）。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)

# ---------------------------------------------------------------------------
# 身份会话（P3：`/contractor/**`、`/supplier/**` 有了**路由级身份门槛**）——
# 本门**先登录再取业务路由**：判据从「谁能打开」变成「**登录后按侧放行**」。
# 登录走**真入口** `POST /identity/login`（`format=json` ⇒ 200 + `Set-Cookie: qa_identity=…`）；
# 会话落在本门私有 `--ui-shared`（**不碰**真 `/workspace/config.yaml` 与真服务数据）。
# 纪律：断言**一条不删、一条不放松** —— 业务路由仍逐条要求 200/202/404，只是带上本侧 cookie。
# ---------------------------------------------------------------------------
BASE = ""                        # main() 起完服务后填（`http://127.0.0.1:<port><prefix>`）
COOKIES: dict[str, str] = {}     # side → 'qa_identity=…'


def header_of(headers: dict, name: str) -> str:
    """大小写无关地取响应头（`dict(response.headers)` 保留服务端发出时的大小写）。"""
    for key, value in headers.items():
        if str(key).lower() == name.lower():
            return str(value)
    return ""


def side_of(url: str) -> str:
    """这条 URL 属于哪一侧的业务路由（`/contractor/**` / `/supplier/**`）；其它路径 ⇒ 空串（不带身份）。"""
    hit = re.search(r"/(contractor|supplier)(?:/|$)", urllib.parse.urlsplit(url).path)
    return hit.group(1) if hit else ""


def cookie_of(url: str) -> dict:
    """业务路由要带的 cookie（按侧登录一次就缓存；每侧的会话只作用于本侧）。"""
    side = side_of(url)
    if not side:
        return {}
    if side not in COOKIES:
        payload = urllib.parse.urlencode({"name": f"gate-rfq-deadline-{side}", "side": side}).encode("utf-8")
        code, body, headers = raw_request_full(f"{BASE}/identity/login?format=json", data=payload)
        cookie = header_of(headers, "set-cookie").split(";")[0]
        if code != 200 or not cookie.startswith("qa_identity="):
            raise RuntimeError(f"门夹具登录失败：side={side} status={code} body={body[:200]}")
        COOKIES[side] = cookie
    return {"Cookie": COOKIES[side]}


def get(url: str) -> tuple[int, str]:
    return raw_request(url, headers=cookie_of(url))


def post_form(url: str, fields: dict[str, str]) -> tuple[int, str]:
    return raw_request(url, data=urllib.parse.urlencode(fields).encode("utf-8"), headers=cookie_of(url))


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
    found = re.search(rf'data-deadline-{attr}="(\d+)"', text)
    return int(found.group(1)) if found else None


def page_reason(text: str) -> str:
    found = re.search(r'data-deadlines-degraded="1"[\s\S]{0,400}?<code>([^<]*)</code>', text)
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


def promised_events() -> list[dict]:
    return [row for row in ledger_rows(CONTRACTOR_LEDGER) if row.get("type") == "rfq/promised"]


def pending_files() -> list[Path]:
    return sorted(path for path in INBOX.glob("rp-*.json")) if INBOX.is_dir() else []


def applied_files() -> list[Path]:
    archive = INBOX / "applied"
    return sorted(archive.glob("*.json")) if archive.is_dir() else []


def run_promise(*extra: str) -> tuple[int, dict, str]:
    proc = subprocess.run([sys.executable, str(ROOT / "tools" / "rfq-promise.py"), *extra,
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
# ① 夹具：**真哈希链**的账本（rfq-promise.py 要往它追加，手写行会被账本自检挡住）
# ---------------------------------------------------------------------------
def write_fixtures() -> dict:
    report = {}
    for path in (CONTRACTOR_LEDGER, SUPPLIER_LEDGER):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)
    rows = [
        ("rfq/published", "pkg-g1", "2026-09-21T10:00:00Z",
         {"package_id": "pkg-g1", "rev": 2, "quote_by": "2026-09-25T00:00:00Z", "items": 2,
          "hash": "sha256:" + "a" * 64, "payload_bytes": 892}),
        ("rfq/distributed", "pkg-g1", "2026-09-21T10:30:00Z",
         {"package_id": "pkg-g1", "rev": 2, "channel": "relay", "sent_at": "2026-09-22T09:00:00Z",
          "recipients": ["supplier:g1", "supplier:g2"]}),
        ("quote/submitted", "pkg-g1", "2026-09-21T11:10:00Z",
         {"package_id": "pkg-g1", "quote_id": "q-1", "rfq_rev": 2, "supplier": "supplier:g2"}),
        ("rfq/published", "pkg-g2", "2026-09-21T11:00:00Z",
         {"package_id": "pkg-g2", "rev": 1, "quote_by": "2026-09-21T11:30:00Z", "items": 1,
          "hash": "sha256:" + "b" * 64, "payload_bytes": 120}),
        # 私域行：带 `private:`/成本类键 → 宿主整行跳过；但**夹具文件里确实有哨兵**（非空转对照）
        ("quote/submitted", "pkg-g1", AS_OF,
         {"package_id": "pkg-g1", "quote_id": "q-private", "supplier": SENTINELS[3],
          "cost_floor": SENTINELS[0], "markup_pct": 12.5, "reserve_price": SENTINELS[1],
          "cost_model": SENTINELS[0], "private:note": SENTINELS[2]}),
    ]
    ledger = Ledger(CONTRACTOR_LEDGER, realm="contractor:con-B")
    for type_, correlation, ts, body in rows:
        ledger.append(type_, body, correlation_id=correlation, ts=ts, actor="agent:fixture")
    SUPPLIER_LEDGER.write_text("", encoding="utf-8")
    MAIL_SNAPSHOT.write_text(json.dumps({
        "schema": 1, "generated_at": AS_OF, "service": "mail",
        "totals": {"queued": 0, "refused": 1, "sent": 0, "parsed": 0},
        "views": {"contractor": {"queued": 0, "refused": 1, "sent": 0, "parsed": 0},
                  "supplier": {"queued": 0, "refused": 0, "sent": 0, "parsed": 0}},
        "transport": {
            "smtp": {"configured": False, "connected": False, "available": False, "reason": MAIL_REASON,
                     "next_action": "在 /admin/config/ 里配 SMTP 凭据"},
            "imap": {"configured": False, "connected": False, "available": False, "reason": MAIL_REASON,
                     "next_action": "在 /admin/config/ 里配 IMAP 凭据"},
        },
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    report["rows"] = ledger.count
    report["healthy"] = bool(ledger.verify_report()["ok"])
    return report


def serve(port: int, prefix: str) -> subprocess.Popen:
    return subprocess.Popen(
        ["node", str(ROOT / "host" / "cli.mjs"), "webui", "--profile", "webui", "--port", str(port),
         "--host", "127.0.0.1", "--prefix", prefix, "--ui-shared", str(UI_SHARED),
         "--mail-snapshot", str(MAIL_SNAPSHOT),
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
    """真回读：`/api/status` 里该视角账本的行数（唯一落账本者落一行 → 计数 +1 的机检形态）。"""
    doc = parse_json(get(f"{base}/api/status")[1])
    entry = (doc.get("ledgers") or {}).get(view) or {}
    return entry.get("count") if isinstance(entry.get("count"), int) else None


def main() -> int:  # noqa: C901
    global BASE
    shutil.rmtree(SHARED, ignore_errors=True)
    fixture = write_fixtures()
    INBOX.mkdir(parents=True, exist_ok=True)
    fixture_text = CONTRACTOR_LEDGER.read_text(encoding="utf-8")
    fixture_has = [needle for needle in SENTINELS if needle in fixture_text]
    check("① 夹具就绪（承包商 5 行真哈希链 / 供应商 0 行空账本 / 私有 ui-shared 与邮件快照 / 哨兵在文件里）",
          fixture["rows"] == 5 and fixture["healthy"] and len(fixture_has) >= 4
          and SUPPLIER_LEDGER.read_text(encoding="utf-8") == ""
          and MAIL_SNAPSHOT.is_file(),
          f"账本行={fixture['rows']} 链自洽={fixture['healthy']}；哨兵命中={fixture_has}")

    ledger_before = sha256_file(CONTRACTOR_LEDGER)
    port, prefix = free_port(), "/qrt"
    proc = serve(port, prefix)
    base = f"http://127.0.0.1:{port}{prefix}"
    BASE = base
    try:
        up = wait_up(base, proc)
        check("② 真进程就绪（`cli.mjs webui` + `/api/health` 200；**不需要**管理员 token）",
              up, f"port={port} prefix={prefix} pid={proc.pid}")
        if not up:
            return 2

        # ---- ②b 身份门槛（P3 的判据本身也要机检；下面所有业务路由都**登录后再取**）----
        anon_json_code, anon_json_body, _h = raw_request_full(
            f"{base}/contractor/api/deadlines", headers={"Accept": "application/json"})
        anon_html_code, _b, anon_html_headers = raw_request_full(
            f"{base}/supplier/deadlines/", headers={"Accept": "text/html"}, follow_redirects=False)
        cookie_contractor = cookie_of(f"{base}/contractor/deadlines/")
        cookie_supplier = cookie_of(f"{base}/supplier/deadlines/")     # noqa: F841（两侧各登录一次）
        same_side = raw_request_full(f"{base}/contractor/deadlines/", headers=cookie_contractor)
        cross_side = raw_request_full(f"{base}/supplier/deadlines/", headers=cookie_contractor)
        cross_json = raw_request_full(f"{base}/supplier/api/deadlines", headers=cookie_contractor)
        check("②b 身份门槛负控：**未登录**取业务路由一律拒 —— API/JSON ⇒ 401 `identity-required` + `next`；"
              "浏览器形状（`Accept: text/html`）⇒ 303 回 `<前缀>/identity/?next=<原地址>`（不是 200、不是 404）",
              anon_json_code == 401 and "identity-required" in anon_json_body and '"next"' in anon_json_body
              and anon_html_code == 303 and "/identity/?next=" in header_of(anon_html_headers, "location"),
              f"JSON={anon_json_code} 含 identity-required={'identity-required' in anon_json_body}；"
              f"HTML={anon_html_code} location={header_of(anon_html_headers, 'location')[:80]}")
        check("②b' 身份门槛正控：**登录后按侧放行** —— 同侧页面 200；拿承包商 cookie 去 `/supplier/`"
              "（页面与 JSON 两条形状）都 ⇒ **403 `side-mismatch`**（不许回落成「能看」）",
              same_side[0] == 200 and cross_side[0] == 403 and "side-mismatch" in cross_side[1]
              and cross_json[0] == 403 and "side-mismatch" in cross_json[1],
              f"同侧={same_side[0]} 越侧页面={cross_side[0]} 越侧 JSON={cross_json[0]} "
              f"含 side-mismatch={'side-mismatch' in cross_side[1]}")

        # ---- ③ 路由登记 + 页面/JSON + 0 内联脚本 ----
        routes = parse_json(get(f"{base}/api/routes")[1]).get("routes", [])
        deadline_routes = [item for item in routes if "/deadlines" in str(item.get("path", ""))]
        pages = {view: get(f"{base}/{view}/deadlines/") for view in ("contractor", "supplier")}
        jsons = {view: get(f"{base}/{view}/api/deadlines") for view in ("contractor", "supplier")}
        parsed = {view: parse_json(jsons[view][1]) for view in jsons}
        write_surface = (parse_json(get(f"{base}/api/routes")[1]).get("write_surface") or {})
        cpage, spage = pages["contractor"][1], pages["supplier"][1]
        next_actions = re.findall(r'data-deadline-next-action="([^"]+)"', cpage)
        scripty = [name for name, text in (("page:c", cpage), ("page:s", spage),
                                           ("json:c", jsons["contractor"][1]), ("json:s", jsons["supplier"][1]))
                   if SCRIPT_NEEDLE in text or INLINE_EVENT.search(text)]
        check("③ 三条新路由登记（两视角 ×「页面 GET / JSON GET / 登记承诺 POST」六条），`auth` 都是 `none`；"
              "`write_surface` 含登记承诺路由；承包商页 200 且是**真页面**"
              "（`data-due-clock=\"facts-only\"` + 口径文案 + 逐条 `data-deadline-next-action`）；"
              "四份响应 **0 行脚本 / 0 内联事件**（扫描器非空转）",
              len(deadline_routes) == 6 and all(item.get("auth") == "none" for item in deadline_routes)
              and len([i for i in deadline_routes if i.get("method") == "GET"]) == 4
              and len([i for i in deadline_routes if i.get("method") == "POST"]) == 2
              and f"{prefix}/<view>/deadlines/promise" in (write_surface.get("browser_writable") or [])
              and pages["contractor"][0] == 200 and jsons["contractor"][0] == 200
              and 'data-due-clock="facts-only"' in cpage and "不取墙钟" in cpage
              and 'data-subnav="contractor"' in cpage and 'data-deadlines-link="1"' in cpage
              and 'data-deadlines="table"' in cpage and next_actions == ["pkg-g2", "pkg-g1"]
              and 'data-cannot-send="1"' in cpage
              and not scripty and (SCRIPT_NEEDLE in f"<a {SCRIPT_NEEDLE}>" or INLINE_EVENT.search('<a onclick="x()">')),
              f"命中={json.dumps([f'{i.get('method')} {i.get('path')}' for i in deadline_routes], ensure_ascii=False)}；"
              f"status={pages['contractor'][0]}/{jsons['contractor'][0]}；next_action 行={next_actions}；"
              f"含脚本={scripty or '无'}")

        # ---- ④ 剩余时长有口径（手算 + 逐字节稳定） ----
        cjson = parsed["contractor"]
        remaining = {item.get("rfq_id"): item.get("remaining_seconds") for item in cjson.get("rfqs", [])}
        severity = {item.get("rfq_id"): item.get("severity") for item in cjson.get("rfqs", [])}
        basis_ok = all(isinstance(item.get("due_basis"), str) and "不取墙钟" in item["due_basis"]
                       for item in cjson.get("rfqs", []))
        names = {item.get("rfq_id"): [item.get("responded"), item.get("silent")]
                 for item in cjson.get("rfqs", [])}
        again_page = get(f"{base}/contractor/deadlines/")
        again_json = get(f"{base}/contractor/api/deadlines")
        check("④ **剩余时长有口径且可复算**：`remaining_seconds` == 手算 `due_ts − as_of`"
              "（pkg-g1 302400 / pkg-g2 -1800，过期那条 `overdue=true` 且 severity=overdue）；"
              "`due_basis` 指名事实来源并写清「不取墙钟」；名册与手算一致（邀请 2 / 已回 1 / 未回 1）；"
              "同一 URL 两次 GET **逐字节一致**（不随刷新漂移）",
              remaining == HAND_REMAINING and severity == {"pkg-g2": "overdue", "pkg-g1": "scheduled"}
              and basis_ok and cjson.get("as_of") == AS_OF
              and cjson.get("due_clock") == "facts-only"
              and cjson.get("ignored_now_inputs") == ["payload.now", "config.now"]
              and names.get("pkg-g1") == [["supplier:g2"], ["supplier:g1"]]
              and names.get("pkg-g2") == [[], []]
              and cjson.get("counts", {}).get("invited") == 2
              and cjson.get("counts", {}).get("silent") == 1
              and again_page[1] == cpage and again_json[1] == jsons["contractor"][1]
              and "302400" in cpage,
              f"remaining={json.dumps(remaining, ensure_ascii=False)}（期望 {json.dumps(HAND_REMAINING)}）；"
              f"severity={json.dumps(severity, ensure_ascii=False)}；as_of={cjson.get('as_of')}；"
              f"名册={json.dumps(names, ensure_ascii=False)}；页面两次一致={again_page[1] == cpage}")

        # ---- ⑤ 没凭据不得假装能发 ----
        combined_doc = cpage + jsons["contractor"][1]
        hits = [word for word in CLAIM_WORDS if word in combined_doc]
        check("⑤ **没凭据不得假装能发**：通道 `available=false` ⇒ 页面与 JSON 都写「无法代发」+ 通道 reason，"
              "`can_send=false`；**整个响应里**「已通知/已提醒/已发送/已发出/已催」**0 命中**"
              "（非空转对照：把这些词塞进探针串能命中）",
              "无法代发" in cpage and "无法代发" in jsons["contractor"][1]
              and "mail-transport-unavailable" in combined_doc
              and cjson.get("can_send") is False
              and cjson.get("channel", {}).get("available") is False
              and not hits
              and all(word in "探针：已通知/已提醒/已发送/已发出/已催" for word in CLAIM_WORDS),
              f"命中={json.dumps(hits, ensure_ascii=False)}；can_send={cjson.get('can_send')}；"
              f"channel={json.dumps(cjson.get('channel'), ensure_ascii=False)[:160]}")

        # ---- ⑥ 空投影不编 + 名册白名单 ----
        sjson = parsed["supplier"]
        supp_names = {item.get("rfq_id"): [item.get("responded"), item.get("silent")]
                      for item in sjson.get("rfqs", [])}
        check("⑥ **空投影不编**（真进程真回读）：供应商侧（空账本）页面 `data-deadlines-degraded=\"1\"` + "
              "有名 reason + 条目计数 **0**，JSON `rfqs:[]` + `degraded:true`；"
              "供应商侧名册三列**恒空**（名册是业主私域，读都不读）",
              pages["supplier"][0] == 200 and jsons["supplier"][0] == 200
              and 'data-deadlines-degraded="1"' in spage and page_reason(spage) in REASONS
              and count_attr(spage, "count") == 0 and sjson.get("rfqs") == []
              and sjson.get("degraded") is True and sjson.get("reason") in REASONS
              and sjson.get("private_lists_visible") is False
              and all(value == [[], []] for value in supp_names.values()),
              f"page={pages['supplier'][0]} degraded={'data-deadlines-degraded=\"1\"' in spage} "
              f"reason={page_reason(spage)}；JSON degraded={sjson.get('degraded')}/{sjson.get('reason')} "
              f"rfqs={sjson.get('rfqs')}；页面计数={count_attr(spage, 'count')}")

        # ---- ⑦ 登记承诺 POST（宿主只落 0600 待办件、账本零新增） ----
        counts_before = ledger_count(base)
        posted = post_form(f"{base}/contractor/deadlines/promise",
                           {"id": "pkg-g1", "by": PROMISE_BY, "due_at": PROMISE_DUE, "note": PROMISE_NOTE})
        posted_json = parse_json(posted[1])
        files = pending_files()
        records = {path.name: json.loads(path.read_text(encoding="utf-8")) for path in files}
        modes = sorted({mode_of(path) for path in files})
        digest_ok = all(item.get("note_sha256") == "sha256:" + hashlib.sha256(PROMISE_NOTE.encode()).hexdigest()
                        for item in records.values())
        verbatim = any(item.get("note") == PROMISE_NOTE for item in records.values())
        record_keys = sorted(next(iter(records.values())).keys()) if records else []
        check("⑦ 登记承诺 POST：**202** + 待办件 id + `next_action`；待办件**恰 0600**、**原话逐字**、"
              "sha256 由本脚本独立重算一致，且含**发言人 / 承诺回文时限 / RFQ id**；"
              "**宿主账本零新增**（夹具账本 POST 前后逐字节一致）",
              posted[0] == 202 and posted_json.get("ok") is True and posted_json.get("code") == "accepted"
              and re.match(r"^rp-contractor-[0-9a-f]{12}$", str(posted_json.get("id"))) is not None
              and "tools/rfq-promise.py" in str(posted_json.get("next_action"))
              and len(files) == 1 and modes == [0o600] and verbatim and digest_ok
              and records and records[next(iter(records))].get("promised_by") == PROMISE_BY
              and records[next(iter(records))].get("due_at") == PROMISE_DUE
              and records[next(iter(records))].get("rfq_id") == "pkg-g1"
              and records[next(iter(records))].get("submitted_at") == ""
              and "promised_by" in record_keys and "note_sha256" in record_keys
              and sha256_file(CONTRACTOR_LEDGER) == ledger_before,
              f"status={posted[0]} id={posted_json.get('id')}；文件={[p.name for p in files]} "
              f"mode={[oct(m) for m in modes]} 逐字={verbatim} 哈希={digest_ok}；record 键={record_keys}；"
              f"账本未变={sha256_file(CONTRACTOR_LEDGER) == ledger_before}")

        # ---- ⑧ 真跑唯一落账本者：rfq/promised + 归档 + 计数 +1 ----
        code, payload, err = run_promise("--now", NOW)
        events = promised_events()
        body = events[-1]["body"] if events else {}
        after_count = ledger_count(base)
        check("⑧ 真跑 `tools/rfq-promise.py`（**唯一落账本者**）：落一条 `rfq/promised`（body **恰 6 键**："
              "rfq_id/view/actor/due_at/promise_sha256/ok，**不含原话正文**）→ 待办件移入 `applied/`（不删）；"
              "**真回读** `/api/status` 的账本计数 **5 → 6**",
              code == 0 and payload.get("ledger_added") == 1 and payload.get("ok") is True
              and sorted(body) == ["actor", "due_at", "ok", "promise_sha256", "rfq_id", "view"]
              and body.get("ok") is True and body.get("actor") == PROMISE_BY
              and body.get("rfq_id") == "pkg-g1" and body.get("view") == "contractor"
              and body.get("due_at") == PROMISE_DUE
              and body.get("promise_sha256") == hashlib.sha256(PROMISE_NOTE.encode()).hexdigest()
              and len(applied_files()) == 1 and len(pending_files()) == 0
              and PROMISE_NOTE not in CONTRACTOR_LEDGER.read_text(encoding="utf-8")
              and counts_before == 5 and after_count == 6,
              f"rc={code} err={err}；ledger_added={payload.get('ledger_added')}；body 键={sorted(body)}；"
              f"applied={[p.name for p in applied_files()]}；计数 {counts_before} → {after_count}；"
              f"账本里有原话={PROMISE_NOTE in CONTRACTOR_LEDGER.read_text(encoding='utf-8')}")

        # ---- ⑨ 承诺改变了页面上的口径（承诺回文时限真的生效） ----
        after = parse_json(get(f"{base}/contractor/api/deadlines")[1])
        after_rows = {item.get("rfq_id"): item for item in after.get("rfqs", [])}
        g1 = after_rows.get("pkg-g1") or {}
        g2 = after_rows.get("pkg-g2") or {}
        after_page = get(f"{base}/contractor/deadlines/")[1]
        check("⑨ **承诺真的改变了口径**：`/api/deadlines` 的 pkg-g1 时限从 `rfq/published.quote_by` "
              "变成 `rfq/promised.due_at`（手算剩余 352800 秒、`due_basis` 指名 `rfq/promised`），"
              "`as_of` 推进到承诺事实的 ts（事实时刻，不是墙钟）",
              g1.get("due_ts") == PROMISE_DUE and "rfq/promised" in str(g1.get("due_basis"))
              and g1.get("remaining_seconds") == HAND_AFTER["pkg-g1_remaining"]
              and g2.get("remaining_seconds") == HAND_AFTER["pkg-g2_remaining"]
              and after.get("as_of") == HAND_AFTER["as_of"]
              and "352800" in after_page and PROMISE_DUE in after_page,
              f"pkg-g1 due={g1.get('due_ts')} remaining={g1.get('remaining_seconds')}"
              f"（期望 {HAND_AFTER['pkg-g1_remaining']}）；pkg-g2 remaining={g2.get('remaining_seconds')}"
              f"（期望 {HAND_AFTER['pkg-g2_remaining']}）；as_of={after.get('as_of')}")

        # ---- ⑩ 幂等 ----
        dup_post = post_form(f"{base}/contractor/deadlines/promise",
                             {"id": "pkg-g1", "by": PROMISE_BY, "due_at": PROMISE_DUE, "note": PROMISE_NOTE})
        code_dup, payload_dup, err_dup = run_promise("--now", NOW)
        dup_post2 = post_form(f"{base}/contractor/deadlines/promise",
                              {"id": "pkg-g1", "by": PROMISE_BY, "due_at": PROMISE_DUE, "note": PROMISE_NOTE})
        code_dup2, payload_dup2, err_dup2 = run_promise("--now", "2026-09-21T22:05:00Z")
        dup_one = (payload_dup.get("duplicates") or [{}])[0]
        dup_two = (payload_dup2.get("duplicates") or [{}])[0]
        check("⑩ **幂等**：同一份（包 + 发言人 + 时限 + 原话）再提交 + 再跑 → 标 `duplicates`"
              "（`already-promised`）、**账本零新增**、`exit 0`；两次提交拿到**同一个待办件 id**；"
              "账本里仍只有 1 条 `rfq/promised`、计数停在 6",
              dup_post[0] == 202 and dup_post2[0] == 202 and code_dup == 0 and code_dup2 == 0
              and payload_dup.get("ledger_added") == 0 and payload_dup2.get("ledger_added") == 0
              and payload_dup.get("refused") == [] and payload_dup2.get("refused") == []
              and dup_one.get("reason") == "already-promised" and dup_two.get("reason") == "already-promised"
              and dup_one.get("matched") in ("ledger-note", "ledger-due", "applied-archive")
              and parse_json(dup_post[1]).get("id") == parse_json(dup_post2[1]).get("id")
              and len(promised_events()) == 1 and ledger_count(base) == 6,
              f"rc={code_dup}/{code_dup2}；ledger_added={payload_dup.get('ledger_added')}/"
              f"{payload_dup2.get('ledger_added')}；duplicates="
              f"{json.dumps([dup_one, dup_two], ensure_ascii=False)[:240]}；"
              f"promised 行={len(promised_events())} 计数={ledger_count(base)}；err={err_dup}/{err_dup2}")

        # ---- ⑪ 拒绝路径 + 私域哨兵 0 命中 + 既有路由没坏 ----
        lines_before = len(ledger_rows(CONTRACTOR_LEDGER))
        bad_post = post_form(f"{base}/contractor/deadlines/promise",
                            {"id": "pkg-zzz", "by": PROMISE_BY, "due_at": PROMISE_DUE, "note": "不存在的包"})
        bad_json = parse_json(bad_post[1])
        tampered = INBOX / "rp-contractor-ffffffffffff.json"
        tampered.write_text(json.dumps({"schema": 1, "kind": "rfq-promise", "view": "contractor",
                                        "rfq_id": "pkg-g1", "promised_by": PROMISE_BY,
                                        "requested_action": "promise", "due_at": PROMISE_DUE,
                                        "note": "被改过的原话", "note_sha256": "sha256:" + "0" * 64,
                                        "bytes": 18, "submitted_at": ""}, ensure_ascii=False) + "\n",
                            encoding="utf-8")
        os.chmod(tampered, 0o600)
        code_t, payload_t, _ = run_promise("--now", NOW)
        tampered.unlink(missing_ok=True)
        refused = (payload_t.get("refused") or [{}])[0]
        hits_doc = {view: [needle for needle in PRIVATE_KEYS + SENTINELS
                           if needle in (pages[view][1] + jsons[view][1])] for view in pages}
        home_code, _ = get(f"{base}/contractor/")
        ops_code, _ = get(f"{base}/api/ops")
        admin_code, admin_body = get(f"{base}/admin/")
        check("⑪ **拒绝路径**各自给具体 `code` + `next_action`，且**拒绝时账本零新增**：不存在的包 → POST "
              "**404 `rfq-not-found`**；被改过的待办件 → `pending-tampered`；"
              "两视角页面/JSON 里私域键名与哨兵 **0 命中**（**非空转对照**：哨兵确实在夹具账本里）；"
              "既有路由没坏、未提权 `/admin/` 仍 401 固定体",
              bad_post[0] == 404 and bad_json.get("code") == "rfq-not-found"
              and bad_json.get("next_action") and "账本零新增" in str(bad_json.get("next_action"))
              and code_t == 1 and refused.get("code") == "pending-tampered" and refused.get("next_action")
              and payload_t.get("ledger_added") == 0
              and len(ledger_rows(CONTRACTOR_LEDGER)) == lines_before
              and not hits_doc["contractor"] and not hits_doc["supplier"] and len(fixture_has) >= 4
              and home_code == 200 and ops_code == 200 and admin_code == 401
              and admin_body.strip() == '{"error":"unauthorized"}',
              f"POST={bad_post[0]} code={bad_json.get('code')}；脚本 rc={code_t} code={refused.get('code')}；"
              f"账本行 {lines_before} → {len(ledger_rows(CONTRACTOR_LEDGER))}；"
              f"哨兵命中={hits_doc}；home={home_code} ops={ops_code} admin={admin_code}")
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
