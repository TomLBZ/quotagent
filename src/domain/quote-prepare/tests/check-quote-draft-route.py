#!/usr/bin/env python3
"""check-quote-draft-route —— 「不要假成功」+ 报价草稿写闭环的**真 HTTP 端到端**
（`tools/verify.sh quote-draft` 的后半）。

真做十三件事（全部走真进程 + 真路由 + 真回读 + **真跑两个 Python 侧工具**，不是"看着像接上了"）：

  ① 造**两份真夹具账本**（用 `quotant.kernel.ledger.Ledger` 逐行 append ⇒ 哈希链**真有效**，
     `quote-draft.py` / `quote-sign.py` 才能往它追加）：供应商侧 3 行（`rfq/published` 带两个行项目 +
     `quote/submitted` 带参考单价（元）+ 一行**带哨兵的私域行**）；承包商侧 2 行；
  ② 起真 `cli.mjs webui` 进程（随机端口、私有前缀、私有 `--ui-shared`）；
  ③ **假成功杀死**（本门最核心的一条）：拿 `/api/routes` 里**每一条 `method=GET` 且没有同路径 POST 行**
     的只读路由发 POST ⇒ 状态码非 200（**405**）且体含 `method-not-allowed`、响应头 `Allow: GET`；
     **反向对照**：每一条 `method=POST` 的写路由发 POST ⇒ **不得**返回该 code（非空转）；
     并且实测「改前那条假成功」已经死了：同一路径 GET 与 POST 的响应体**不同**（改前两者逐字节相同）；
  ④ 准备页 `GET /supplier/quotes/prepare/` 200 且是**真页面**（行项目目录 + 字段与校验规则 +
     「下一步（签署）」`data-signature-required="1"` + 可复制的 `tools/quote-sign.py` 命令）；
     四份响应 **0 行脚本 / 0 内联事件**（扫描器非空转）；
  ⑤ **字段级**校验失败：单价越界/非整数、交期越界、`agent:` 发言人、行项目不存在各给**具体字段**的
     `{field, code, message, next_action}`（400），且**什么都没落盘**；
  ⑥ 合法提交 ⇒ **202** + 待办件 id + `next_action`；待办件**恰 0600**（目录 0700）、
     `note_sha256`/`lines_sha256`/`bytes` 由本脚本**独立重算**一致、`submitted_at` 为空；
     **宿主账本零新增**（两份夹具账本 POST 前后**逐字节**一致）；
  ⑦ 真跑 `tools/quote-draft.py`（**唯一落账本者**）：**两侧账本各 +1**（供应商自己的事实 + 承包商侧的
     「供应商已准备报价」），body **恰 12 键**且**不含备注正文**；待办件移入 `applied/`（不删）；
     真回读 `/api/status` 的计数（供应商 3 → 4）；
  ⑧ **双向可见**：`/supplier/quotes/` 与 `/contractor/quotes/` 都**回读**到那份草稿（行项目 / 单价 /
     状态恒为**待签署** / 引用），承包商侧读到「**供应商 X 已准备报价（待签署）**」；
  ⑨ **幂等**：同一份草稿再提交 ⇒ 同一个待办件 id（202）；再跑工具 ⇒ `duplicates`（`already-drafted`）、
     **账本零新增**、`exit 0`；
  ⑩ 拒绝路径：行项目不存在 ⇒ POST **400 `item-not-found`**；被改过的待办件 ⇒ `pending-tampered`；
     两例都**账本零新增**；
  ⑪ **签名只能由人**：`tools/quote-sign.py --actor agent:x` ⇒ 退出码 2 + `human-required` + 账本零新增；
     `--actor human:<人名>` ⇒ 真落 `approval/requested → approval/granted → quote/submitted`；
     已签后再跑 ⇒ `duplicates`（`already-signed`）+ 账本零新增；
  ⑫ 私域哨兵在两视角页面/JSON **0 命中**（**非空转对照**：哨兵确实写在夹具账本里）；
  ⑬ 既有路由没坏（首页/运维 200、未提权 `/admin/` 401 固定体）。

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
METHOD_CODE = "method-not-allowed"
PRIVATE_KEYS = ["cost_floor", "markup_pct", "reserve_price", "cost_model", "private:", "bidders_private"]
SENTINELS = ["COST-FLOOR-SENTINEL-9c", "RESERVE-PRICE-SENTINEL-4b", "PRIVATE-NOTE-SENTINEL-7f", "987654321"]
NOTE_TEXT = "周五下班前回你确切交期；含运费（原话逐字）"
PREPARED_BY = "human:zhang"
NOW = "2026-09-21T22:00:00Z"
SIGN_NOW = "2026-09-21T23:00:00Z"

SHARED = ROOT / "tmp" / "quote-draft-route"
UI_SHARED = SHARED / "ui-shared"
INBOX = UI_SHARED / "quote-drafts"
CONTRACTOR_LEDGER = SHARED / "contractor" / "ledger.jsonl"
SUPPLIER_LEDGER = SHARED / "supplier" / "ledger.jsonl"

SUPPLIER_ROWS = 3
CONTRACTOR_ROWS = 2
DRAFT_BODY_KEYS = ["currency", "item_id", "lead_time_days", "lines_sha256", "note_sha256", "ok",
                   "prepared_by", "quote_draft_id", "rfq_id", "supplier", "unit_price_cents", "view"]


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """**不跟** 303/302：身份门槛的「浏览器形状」判据就是那一次 303 本身（跟过去会变成 200 登录页）。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, D102
        return None


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)


def raw_request(url: str, data: bytes | None = None, timeout: float = 10.0,
                method: str | None = None, headers: dict | None = None,
                follow_redirects: bool = True) -> tuple[int, str, dict]:
    request = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        opener = urllib.request.urlopen if follow_redirects else _NO_REDIRECT_OPENER.open
        with opener(request, timeout=timeout) as response:
            return int(response.status), response.read().decode("utf-8", "replace"), dict(response.headers)
    except urllib.error.HTTPError as err:
        return int(err.code), err.read().decode("utf-8", "replace"), dict(err.headers)
    except Exception as err:  # noqa: BLE001
        return 0, f"<error {type(err).__name__}: {err}>", {}


# ---------------------------------------------------------------------------
# 身份会话（P3：`/contractor/**`、`/supplier/**` 有了**路由级身份门槛**）——
# 本门**先登录再取业务路由**：判据从「谁能打开」变成「**登录后按侧放行**」。
# 登录走**真入口** `POST /identity/login`（`format=json` ⇒ 200 + `Set-Cookie: qa_identity=…`）；
# 会话落在本门私有 `--ui-shared`（**不碰**真 `/workspace/config.yaml` 与真服务数据）。
# 纪律：断言**一条不删、一条不放松** —— 业务路由仍逐条要求 200/202/400，只是带上本侧 cookie。
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
        payload = urllib.parse.urlencode({"name": f"gate-quote-draft-{side}", "side": side}).encode("utf-8")
        code, body, headers = raw_request(f"{BASE}/identity/login?format=json", data=payload, method="POST")
        cookie = header_of(headers, "set-cookie").split(";")[0]
        if code != 200 or not cookie.startswith("qa_identity="):
            raise RuntimeError(f"门夹具登录失败：side={side} status={code} body={body[:200]}")
        COOKIES[side] = cookie
    return {"Cookie": COOKIES[side]}


def get(url: str) -> tuple[int, str, dict]:
    return raw_request(url, headers=cookie_of(url))


def post_form(url: str, fields: dict[str, str]) -> tuple[int, str, dict]:
    return raw_request(url, data=urllib.parse.urlencode(fields).encode("utf-8"),
                       method="POST", headers=cookie_of(url))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


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


def canonical_lines(record: dict) -> str:
    lines = {"currency": str(record.get("currency") or ""), "item_id": str(record.get("item_id") or ""),
             "lead_time_days": record.get("lead_time_days"), "rfq_id": str(record.get("rfq_id") or ""),
             "unit_price_cents": record.get("unit_price_cents")}
    return json.dumps(lines, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def ledger_rows(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    return rows


def drafted_events(path: Path) -> list[dict]:
    return [row for row in ledger_rows(path) if row.get("type") == "quote/drafted"]


def pending_files() -> list[Path]:
    return sorted(path for path in INBOX.glob("qd-*.json")) if INBOX.is_dir() else []


def applied_files() -> list[Path]:
    archive = INBOX / "applied"
    return sorted(archive.glob("*.json")) if archive.is_dir() else []


def run_tool(tool: str, *extra: str) -> tuple[int, dict, str]:
    proc = subprocess.run([sys.executable, str(ROOT / "src" / "domain" / "quote-prepare" / "tools" / tool), *extra,
                           "--ui-shared", str(UI_SHARED),
                           "--ledger-supplier", str(SUPPLIER_LEDGER),
                           "--ledger-contractor", str(CONTRACTOR_LEDGER)],
                          capture_output=True, text=True, timeout=120)
    try:
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        payload = {}
    return proc.returncode, payload, (proc.stderr or "").strip()[-200:]


# ---------------------------------------------------------------------------
# ① 夹具：**真哈希链**的账本（两个工具都要往它追加，手写行会被账本自检挡住）
# ---------------------------------------------------------------------------
def write_fixtures() -> dict:
    for path in (CONTRACTOR_LEDGER, SUPPLIER_LEDGER):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)
    supplier_rows = [
        ("rfq/published", "pkg-g1", "2026-09-21T10:00:00Z",
         {"package_id": "pkg-g1", "rev": 2, "quote_by": "2026-09-25T00:00:00Z",
          "items": [{"item_id": "L-001"}, {"item_id": "L-002"}], "items_count": 2,
          "hash": "sha256:" + "a" * 64, "payload_bytes": 892}),
        ("quote/submitted", "q-old-1", "2026-09-21T11:00:00Z",
         {"quote_id": "q-old-1", "package_id": "pkg-g1", "supplier": "supplier:g1",
          "lines": [{"item_id": "L-001", "unit_price": 86.0, "qty": 150},
                    {"item_id": "L-002", "unit_price": 11.5, "qty": 480}]}),
        # 私域行：带 `private:`/成本类键 → 宿主整行跳过；但**夹具文件里确实有哨兵**（非空转对照）
        ("quote/submitted", "q-private", "2026-09-21T11:30:00Z",
         {"quote_id": "q-private", "package_id": "pkg-g1", "item_id": "L-001", "supplier": SENTINELS[3],
          "cost_floor": SENTINELS[0], "markup_pct": 12.5, "reserve_price": SENTINELS[1],
          "cost_model": SENTINELS[0], "private:note": SENTINELS[2]}),
    ]
    contractor_rows = [
        ("rfq/published", "pkg-g1", "2026-09-21T10:00:00Z",
         {"package_id": "pkg-g1", "rev": 2, "quote_by": "2026-09-25T00:00:00Z", "items": 2,
          "hash": "sha256:" + "c" * 64, "payload_bytes": 892}),
        ("rfq/distributed", "pkg-g1", "2026-09-21T10:30:00Z",
         {"package_id": "pkg-g1", "rev": 2, "channel": "relay", "sent_at": "2026-09-22T09:00:00Z",
          "recipients": ["supplier:g1"]}),
    ]
    supplier_ledger = Ledger(SUPPLIER_LEDGER, realm="supplier:g1")
    for type_, correlation, ts, body in supplier_rows:
        supplier_ledger.append(type_, body, correlation_id=correlation, ts=ts, actor="agent:fixture")
    contractor_ledger = Ledger(CONTRACTOR_LEDGER, realm="contractor:con-B")
    for type_, correlation, ts, body in contractor_rows:
        contractor_ledger.append(type_, body, correlation_id=correlation, ts=ts, actor="agent:fixture")
    return {"supplier": supplier_ledger.count, "supplier_ok": bool(supplier_ledger.verify_report()["ok"]),
            "contractor": contractor_ledger.count, "contractor_ok": bool(contractor_ledger.verify_report()["ok"])}


def serve(port: int, prefix: str) -> subprocess.Popen:
    return subprocess.Popen(
        ["node", str(ROOT / "host" / "cli.mjs"), "webui", "--profile", "webui", "--port", str(port),
         "--host", "127.0.0.1", "--prefix", prefix, "--ui-shared", str(UI_SHARED),
         "--ledger-contractor", str(CONTRACTOR_LEDGER), "--ledger-supplier", str(SUPPLIER_LEDGER)],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        env={key: value for key, value in os.environ.items() if key != "QUOTAGENT_ADMIN_TOKEN"})


def wait_up(base: str, proc: subprocess.Popen) -> bool:
    for _ in range(40):
        code, _body, _headers = get(f"{base}/api/health")
        if code == 200:
            return True
        if proc.poll() is not None:
            return False
        time.sleep(0.5)
    return False


def counts_of(base: str) -> dict:
    doc = parse_json(get(f"{base}/api/status")[1])
    return {view: (entry or {}).get("count") for view, entry in (doc.get("ledgers") or {}).items()}


# 只读路由的 POST 探针：GET 模板参数换成真值。
ROUTE_SUBS = {"<view>": "supplier", "<id>": "pkg-g1", "<name>": "mail_smtp", "<ns>": "demo",
              "<plugin>": "demo-plugin", "<block_id>": "blk-1", "<load|unload|reload>": "load"}


def route_paths(routes: list[dict], prefix: str) -> tuple[list[str], list[str]]:
    """返回 `(只读路由, 写路由)`（**前缀已剥离**）；同路径既有 GET 又有 POST 的归到写路由。"""
    def fill(path: str) -> str:
        out = str(path)
        for key, value in ROUTE_SUBS.items():
            out = out.replace(key, value)
        return out[len(prefix):] if out.startswith(prefix) else out
    gets = [fill(item.get("path", "")) for item in routes if item.get("method") == "GET"]
    writes = [fill(item.get("path", "")) for item in routes if item.get("method") == "POST"]
    read_only = sorted({path for path in gets if path not in set(writes)})
    return read_only, sorted(set(writes))


def main() -> int:  # noqa: C901
    global BASE
    shutil.rmtree(SHARED, ignore_errors=True)
    fixture = write_fixtures()
    INBOX.mkdir(parents=True, exist_ok=True)
    sentinels_in_file = [needle for needle in SENTINELS if needle in SUPPLIER_LEDGER.read_text(encoding="utf-8")]
    check("① 夹具就绪（供应商 3 行 / 承包商 2 行，两份都是**真哈希链**；私有 ui-shared；哨兵在文件里）",
          fixture["supplier"] == SUPPLIER_ROWS and fixture["contractor"] == CONTRACTOR_ROWS
          and fixture["supplier_ok"] and fixture["contractor_ok"] and len(sentinels_in_file) >= 3,
          f"供应商 {fixture['supplier']} 行链自洽={fixture['supplier_ok']}；"
          f"承包商 {fixture['contractor']} 行链自洽={fixture['contractor_ok']}；哨兵命中={sentinels_in_file}")

    supplier_before = sha256_file(SUPPLIER_LEDGER)
    contractor_before = sha256_file(CONTRACTOR_LEDGER)
    port, prefix = free_port(), "/qdr"
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
        # 两种形状各验一次：API/JSON 客户端 ⇒ 401 + next；浏览器（Accept: text/html）⇒ 303 回登录页
        anon_json_code, anon_json_body, _ = raw_request(
            f"{base}/contractor/api/events", headers={"Accept": "application/json"})
        anon_html_code, _anon_html_body, anon_html_headers = raw_request(
            f"{base}/contractor/", headers={"Accept": "text/html"}, follow_redirects=False)
        cookie_contractor = cookie_of(f"{base}/contractor/")
        cookie_supplier = cookie_of(f"{base}/supplier/")     # noqa: F841（两侧各登录一次）
        same_side = raw_request(f"{base}/contractor/", headers=cookie_contractor)
        cross_side = raw_request(f"{base}/supplier/", headers=cookie_contractor)
        cross_json = raw_request(f"{base}/supplier/api/events", headers=cookie_contractor)
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

        # ---- ③ 假成功杀死 + 反向对照 ----
        routes = parse_json(get(f"{base}/api/routes")[1]).get("routes", [])
        read_only, writes = route_paths(routes, prefix)
        bad_read = []
        for path in read_only:
            code, body, headers = post_form(f"{base}{path}", {"probe": "1"})
            if code == 200 or METHOD_CODE not in body or str(headers.get("allow") or "").upper() != "GET":
                bad_read.append(f"POST {path}→{code}/{body[:40]}")
        bad_write = []
        for path in writes:
            code, body, _headers = post_form(f"{base}{path}", {})
            if METHOD_CODE in body:
                bad_write.append(f"POST {path}→{code} 竟然返回 {METHOD_CODE}")
        # 实测「改前那条假成功」已经死了：同一路径 GET 与 POST 的响应体**不同**
        fake_before_get = get(f"{base}/contractor/quotes/")
        fake_before_post = post_form(f"{base}/contractor/quotes/", {"item": "L-001", "price": "80"})
        check("③ **假成功杀死**：`/api/routes` 里**每一条只读 GET 路由**（{n} 条）收到 POST ⇒ 状态码非 200"
              "（**405**）、体含 `method-not-allowed`、响应头 `Allow: GET`；**反向对照**：**每一条写路由**"
              "（{m} 条）收到 POST ⇒ **不得**返回该 code（非空转）；并且实测「改前那条假成功」已死："
              "同一路径 GET 与 POST 的响应体**不同**（改前两者逐字节相同、bytes=3935、sha256 相同）"
              .format(n=len(read_only), m=len(writes)),
              len(read_only) > 20 and len(writes) >= 8 and not bad_read and not bad_write
              and fake_before_get[0] == 200 and fake_before_post[0] == 405
              and fake_before_get[1] != fake_before_post[1]
              and METHOD_CODE in fake_before_post[1]
              and str(fake_before_post[2].get("allow") or "").upper() == "GET",
              f"只读路由={len(read_only)} 写路由={len(writes)}；不合规只读={bad_read[:4]}；"
              f"写路由误报={bad_write[:4]}；假成功对照 GET={fake_before_get[0]}/{len(fake_before_get[1])}B "
              f"POST={fake_before_post[0]}/{len(fake_before_post[1])}B 体不同={fake_before_get[1] != fake_before_post[1]}")

        # 页面上的**表单 action 只能指向真的会处理写**的路径（本仓「不要假成功」的另一半：
        # 页面绝不给出一个提交后什么也不发生的按钮）
        form_pages = ['/supplier/quotes/prepare/', '/supplier/quotes/', '/contractor/quotes/', '/supplier/',
                      '/contractor/', '/contractor/gates/', '/supplier/gates/', '/supplier/feedback',
                      '/contractor/feedback', '/ops/', '/admin/']
        form_actions: list[str] = []
        for page_path in form_pages:
            for action in re.findall(r'<form[^>]*method="post"[^>]*action="([^"]+)"', get(f"{base}{page_path}")[1]):
                if action not in form_actions:
                    form_actions.append(action)
        fake_buttons = []
        for action in form_actions:
            target = action if action.startswith(('http://', 'https://')) else f"http://127.0.0.1:{port}{action}"
            code, body, _headers = post_form(target, {})
            if code == 405 or METHOD_CODE in body:
                fake_buttons.append(f"POST {action}→{code}")
        check("③b 页面上的**表单 action 只能指向真的会处理写**的路径：把每道首页/子视图/准备页里所有 "
              "`<form method=\"post\" action=…>` 的 action 逐个 POST 一遍 ⇒ **一个都不许**回 405 或 "
              "`method-not-allowed`（**非空转对照**：本次确实扫到了至少 3 个 POST 表单 action，"
              "且同一个探针发到只读路由上一定会命中该 code）",
              len(form_actions) >= 3 and not fake_buttons
              and post_form(f"{base}/supplier/quotes/", {})[1].find(METHOD_CODE) >= 0,
              f"扫到的 POST 表单 action={form_actions}；假按钮={fake_buttons or '无'}")

        # ---- ④ 准备页 + 契约 ----
        prepare_page = get(f"{base}/supplier/quotes/prepare/")
        prepare_json_routes = [item for item in routes if "/quotes/prepare/" in str(item.get("path", ""))]
        write_surface = (parse_json(get(f"{base}/api/routes")[1]).get("write_surface") or {})
        text = prepare_page[1]
        scripty = SCRIPT_NEEDLE in text or bool(INLINE_EVENT.search(text))
        check("④ 准备页 `GET /quotagent/supplier/quotes/prepare/`：**200 且是真页面**"
              "（行项目目录 `data-prep-item` + RFQ 引用 + 字段与校验规则表 `data-prep-field` + "
              "`data-prep-limits` + `GET|POST` 同路径表单 + 「下一步（签署）」`data-signature-required=\"1\"` "
              "+ 可复制的 `tools/quote-sign.py` 命令）；路由表登记两条、`auth` 是**真实值** "
              "`identity-session`（业务路由要身份会话：台账不再写 `none` 撒谎）、`write_surface` 含该路径；"
              "**0 行脚本 / 0 内联事件**（扫描器非空转）",
              prepare_page[0] == 200 and len(prepare_json_routes) == 2
              and sorted(item.get("method") for item in prepare_json_routes) == ["GET", "POST"]
              and all(item.get("auth") == "identity-session" for item in prepare_json_routes)
              and bool((parse_json(get(f"{base}/api/routes")[1]).get("auth_basis") or {}).get("identity-session"))
              and f"{prefix}/supplier/quotes/prepare/" in (write_surface.get("browser_writable") or [])
              and 'data-prep-item="L-001"' in text and 'data-prep-item="L-002"' in text
              and 'data-prep-rfq="pkg-g1"' in text and 'data-prep-field="unit_price_cents"' in text
              and 'data-prep-limits="1"' in text and '8600' in text
              and '<form method="post" action="/qdr/supplier/quotes/prepare/">' in text
              and 'data-signature-required="1"' in text and "本 APP 不代签" in text
              and "tools/quote-sign.py" in text and "data-can-sign=\"0\"" in text
              and not scripty and (SCRIPT_NEEDLE in f"<a {SCRIPT_NEEDLE}>" or INLINE_EVENT.search('<a onclick="x()">')),
              f"status={prepare_page[0]}；路由={[(i.get('method'), i.get('path')) for i in prepare_json_routes]}；"
              f"含签署命令={'tools/quote-sign.py' in text} 含 0 内联脚本={not scripty}")

        # ---- ⑤ 字段级校验失败 ----
        bad_cases = [
            ("unit_price_cents", "99999999999", "unit-price-out-of-range"),
            ("unit_price_cents", "86.00", "unit-price-not-integer"),
            ("lead_time_days", "99999", "lead-time-out-of-range"),
            ("prepared_by", "agent:bot", "prepared-by-required"),
            ("item_id", "L-999", "item-not-found"),
            ("rfq_id", "pkg-zzz", "rfq-not-found"),
        ]
        wrong = []
        detail_rows = []
        for field, value, code in bad_cases:
            form = {"rfq_id": "pkg-g1", "item_id": "L-001", "unit_price_cents": "8600",
                    "lead_time_days": "7", "prepared_by": PREPARED_BY, "currency": "CNY", "note": NOTE_TEXT}
            form[field] = value
            response = post_form(f"{base}/supplier/quotes/prepare/", form)
            body = parse_json(response[1])
            hit = next((item for item in (body.get("errors") or []) if item.get("field") == field), {})
            detail_rows.append(f"{field}={value}→{hit.get('code')}")
            if response[0] != 400 or hit.get("code") != code or not hit.get("next_action") or not hit.get("message"):
                wrong.append(f"{field}:{response[0]}/{hit.get('code')}")
        check("⑤ **字段级**校验失败：越界/非整数单价 ⇒ `unit-price-out-of-range`/`unit-price-not-integer`、"
              "交期越界 ⇒ `lead-time-out-of-range`、`agent:` 发言人 ⇒ `prepared-by-required`、"
              "行项目不存在 ⇒ `item-not-found`、RFQ 不存在 ⇒ `rfq-not-found`；每个错误都是 **400** + "
              "**具体字段**的 `{field, code, message, next_action}`（不吞成一句「参数错误」），"
              "且**什么都没落盘**（无待办件）",
              not wrong and pending_files() == []
              and sha256_file(SUPPLIER_LEDGER) == supplier_before,
              f"不达标={wrong}；逐条={detail_rows}；待办件={[p.name for p in pending_files()]}")

        # ---- ⑥ 合法提交：202 + 0600 待办件 + 宿主账本零新增 ----
        counts_before = counts_of(base)
        good_form = {"rfq_id": "pkg-g1", "item_id": "L-001", "unit_price_cents": "8600",
                     "lead_time_days": "7", "prepared_by": PREPARED_BY, "currency": "CNY", "note": NOTE_TEXT}
        accepted = post_form(f"{base}/supplier/quotes/prepare/", good_form)
        accepted_json = parse_json(accepted[1])
        files = pending_files()
        records = {path.name: json.loads(path.read_text(encoding="utf-8")) for path in files}
        record = next(iter(records.values()), {})
        digests_ok = bool(record) and record.get("note_sha256") == sha256_text(NOTE_TEXT) \
            and record.get("lines_sha256") == sha256_text(canonical_lines(record)) \
            and record.get("bytes") == len(NOTE_TEXT.encode("utf-8"))
        check("⑥ 合法提交 ⇒ **202** + 待办件 id + `next_action`；待办件**恰 0600**（文件 0600 / 目录 0700）、"
              "`note_sha256` 与 `lines_sha256` 由本脚本**独立重算**一致、`submitted_at` 为空、"
              "**原话逐字**与表单一致；**宿主账本零新增**（两份夹具账本前后**逐字节**一致）",
              accepted[0] == 202 and accepted_json.get("ok") is True
              and re.match(r"^qd-supplier-[0-9a-f]{12}$", str(accepted_json.get("id"))) is not None
              and "tools/quote-draft.py" in str(accepted_json.get("next_action"))
              and "tools/quote-sign.py" in str(accepted_json.get("next_action"))
              and len(files) == 1 and mode_of(files[0]) == 0o600 and mode_of(INBOX) == 0o700
              and digests_ok and record.get("note") == NOTE_TEXT
              and record.get("submitted_at") == "" and record.get("prepared_by") == PREPARED_BY
              and record.get("supplier") == "supplier:g1"
              and sha256_file(SUPPLIER_LEDGER) == supplier_before
              and sha256_file(CONTRACTOR_LEDGER) == contractor_before,
              f"status={accepted[0]} id={accepted_json.get('id')}；文件={[p.name for p in files]} "
              f"mode={[oct(mode_of(p)) for p in files]} 目录={oct(mode_of(INBOX))}；摘要重算一致={digests_ok}；"
              f"next_action 含两个工具名="
              f"{'tools/quote-draft.py' in str(accepted_json.get('next_action'))}/"
              f"{'tools/quote-sign.py' in str(accepted_json.get('next_action'))}；"
              f"prepared_by={record.get('prepared_by')} supplier={record.get('supplier')} "
              f"submitted_at={record.get('submitted_at')!r} 原话逐字={record.get('note') == NOTE_TEXT}；"
              f"账本未变={sha256_file(SUPPLIER_LEDGER) == supplier_before}")

        # ---- ⑦ 真跑唯一落账本者 ----
        code_run, payload_run, err_run = run_tool("quote-draft.py", "--now", NOW)
        supplier_drafted = drafted_events(SUPPLIER_LEDGER)
        contractor_drafted = drafted_events(CONTRACTOR_LEDGER)
        body = supplier_drafted[-1]["body"] if supplier_drafted else {}
        counts_after = counts_of(base)
        check("⑦ 真跑 `tools/quote-draft.py`（**唯一落账本者**）：**两侧账本各 +1**（供应商自己的事实 + "
              "承包商侧的「供应商已准备报价」），`quote/drafted` 的 body **恰 12 键**、"
              "**不含备注正文与凭据**（只有 `note_sha256`）；待办件移入 `applied/`（不删）；"
              "真回读 `/api/status` 的账本计数（供应商 3 → 4，承包商 2 → 3）",
              code_run == 0 and payload_run.get("ledger_added") == 2 and payload_run.get("ok") is True
              and sorted(body) == DRAFT_BODY_KEYS and body.get("ok") is True
              and body.get("item_id") == "L-001" and body.get("unit_price_cents") == 8600
              and body.get("lead_time_days") == 7 and body.get("prepared_by") == PREPARED_BY
              and body.get("supplier") == "supplier:g1" and body.get("rfq_id") == "pkg-g1"
              and body.get("view") == "supplier" and body.get("note_sha256") == sha256_text(NOTE_TEXT)
              and len(supplier_drafted) == 1 and len(contractor_drafted) == 1
              and contractor_drafted[0]["body"].get("view") == "contractor"
              and len(applied_files()) == 1 and pending_files() == []
              and NOTE_TEXT not in SUPPLIER_LEDGER.read_text(encoding="utf-8")
              and NOTE_TEXT not in CONTRACTOR_LEDGER.read_text(encoding="utf-8")
              and counts_before.get("supplier") == SUPPLIER_ROWS
              and counts_after.get("supplier") == SUPPLIER_ROWS + 1
              and counts_after.get("contractor") == CONTRACTOR_ROWS + 1,
              f"rc={code_run} err={err_run}；ledger_added={payload_run.get('ledger_added')}；"
              f"body 键={sorted(body)}；applied={[p.name for p in applied_files()]}；"
              f"计数 {counts_before} → {counts_after}；"
              f"账本里有原话={NOTE_TEXT in SUPPLIER_LEDGER.read_text(encoding='utf-8')}")

        # ---- ⑧ 双向可见 ----
        draft_id = str(accepted_json.get("id"))
        supplier_quotes = get(f"{base}/supplier/quotes/")
        contractor_quotes = get(f"{base}/contractor/quotes/")
        supplier_home = get(f"{base}/supplier/")
        contractor_home = get(f"{base}/contractor/")
        stext, ctext = supplier_quotes[1], contractor_quotes[1]
        check("⑧ **双向可见**：`/supplier/quotes/` 与 `/contractor/quotes/`（各自读**自己的**账本）都**回读**到"
              "那份草稿 —— 行项目 `L-001` / 单价 `8600` 分 / 状态恒为**待签署** / 引用 = 草稿 id；"
              "承包商侧读到「**供应商 X 已准备报价（待签署）**」；两道首页也显示草稿;"
              "四份响应 **0 行脚本 / 0 内联事件**",
              supplier_quotes[0] == 200 and contractor_quotes[0] == 200
              and f'data-prep-draft="{draft_id}"' in stext and f'data-prep-draft="{draft_id}"' in ctext
              and "L-001" in stext and "8600" in stext and "待签署" in stext
              and 'data-prep-headline="supplier"' in stext
              and 'data-prep-headline="contractor"' in ctext and "已准备报价" in ctext
              and "待签署" in ctext and "supplier:g1" in ctext and "8600" in ctext
              and 'data-prep-drafts="table"' in supplier_home[1] and 'data-prep-drafts="table"' in contractor_home[1]
              and "已准备报价" in contractor_home[1]
              and not any(SCRIPT_NEEDLE in page or INLINE_EVENT.search(page)
                          for page in (stext, ctext, supplier_home[1], contractor_home[1])),
              f"供应商页草稿={f'data-prep-draft=\"{draft_id}\"' in stext} "
              f"承包商页草稿={f'data-prep-draft=\"{draft_id}\"' in ctext}；"
              f"承包商标题={'data-prep-headline=\"contractor\"' in ctext}；"
              f"承包商首页含「已准备报价」={'已准备报价' in contractor_home[1]}")

        # ---- ⑨ 幂等 ----
        again = post_form(f"{base}/supplier/quotes/prepare/", good_form)
        again_json = parse_json(again[1])
        supplier_after_idem = sha256_file(SUPPLIER_LEDGER)
        code_dup, payload_dup, err_dup = run_tool("quote-draft.py", "--now", NOW)
        check("⑨ **幂等**：同一份草稿再提交 ⇒ **同一个待办件 id** 且 `payload_sha256` 相同（内容等价 ⇒ "
              "确定性 id，不重复落账）；再跑工具 ⇒ `duplicates`（`already-drafted`）、**账本零新增**、"
              "`exit 0`；账本里仍只有 1 条 `quote/drafted`、待办件仍被移入 `applied/`（不删）",
              again[0] == 202 and again_json.get("id") == draft_id
              and again_json.get("payload_sha256") == accepted_json.get("payload_sha256")
              and code_dup == 0 and payload_dup.get("ledger_added") == 0
              and payload_dup.get("refused") == []
              and (payload_dup.get("duplicates") or [{}])[0].get("reason") == "already-drafted"
              and len(drafted_events(SUPPLIER_LEDGER)) == 1
              and len(applied_files()) == 2 and pending_files() == []
              and sha256_file(SUPPLIER_LEDGER) == supplier_after_idem,
              f"rc={code_dup}；id 相同={again_json.get('id') == draft_id}；"
              f"payload_sha256 相同={again_json.get('payload_sha256') == accepted_json.get('payload_sha256')}；"
              f"duplicates={json.dumps(payload_dup.get('duplicates'), ensure_ascii=False)[:200]}；"
              f"applied={[p.name for p in applied_files()]}；err={err_dup}")

        # ---- ⑩ 拒绝路径（待办件被改过） ----
        tampered = INBOX / "qd-supplier-ffffffffffff.json"
        tampered.write_text(json.dumps({"schema": 1, "kind": "quote-draft", "view": "supplier",
                                        "requested_action": "draft", "rfq_id": "pkg-g1", "item_id": "L-001",
                                        "unit_price_cents": 8600, "lead_time_days": 7, "currency": "CNY",
                                        "prepared_by": PREPARED_BY, "supplier": "supplier:g1",
                                        "note": "被改过的原话", "note_sha256": "0" * 64,
                                        "lines_sha256": "0" * 64, "bytes": 18, "submitted_at": "",
                                        "quote_draft_id": "qd-supplier-ffffffffffff"},
                                       ensure_ascii=False) + "\n", encoding="utf-8")
        os.chmod(tampered, 0o600)
        lines_before = len(ledger_rows(SUPPLIER_LEDGER))
        code_t, payload_t, _err_t = run_tool("quote-draft.py", "--now", NOW)
        tampered.unlink(missing_ok=True)
        refused = (payload_t.get("refused") or [{}])[0]
        not_found = post_form(f"{base}/supplier/quotes/prepare/",
                              {**good_form, "item_id": "L-999"})
        not_found_json = parse_json(not_found[1])
        check("⑩ **拒绝路径**各自给具体 `code` + `next_action`，且**拒绝时账本零新增**："
              "行项目不存在 ⇒ POST **400 `item-not-found`**（具体字段 + next_action）；"
              "被改过的待办件 ⇒ `pending-tampered`（工具拒绝、账本行数不变）",
              not_found[0] == 400 and not_found_json.get("code") == "validation-failed"
              and any(item.get("code") == "item-not-found" and item.get("field") == "item_id"
                      and item.get("next_action") for item in (not_found_json.get("errors") or []))
              and code_t == 1 and refused.get("code") == "pending-tampered" and refused.get("next_action")
              and payload_t.get("ledger_added") == 0
              and len(ledger_rows(SUPPLIER_LEDGER)) == lines_before,
              f"not-found={not_found[0]}/{not_found_json.get('code')}；脚本 rc={code_t} "
              f"code={refused.get('code')}；账本行 {lines_before} → {len(ledger_rows(SUPPLIER_LEDGER))}")

        # ---- ⑪ 签名只能由人 ----
        hash_before_agent = sha256_file(SUPPLIER_LEDGER)
        agent_sign = run_tool("quote-sign.py", "--draft-id", draft_id, "--actor", "agent:bot",
                              "--now", SIGN_NOW)
        agent_no_write = sha256_file(SUPPLIER_LEDGER) == hash_before_agent
        human_sign = run_tool("quote-sign.py", "--draft-id", draft_id, "--actor", "human:liangzi",
                              "--comment", "同意提交", "--now", SIGN_NOW)
        sign_again = run_tool("quote-sign.py", "--draft-id", draft_id, "--actor", "human:liangzi",
                              "--now", SIGN_NOW)
        supplier_types = [row.get("type") for row in ledger_rows(SUPPLIER_LEDGER)]
        contractor_types = [row.get("type") for row in ledger_rows(CONTRACTOR_LEDGER)]
        check("⑪ **签名只能由人**（铁律的机检形态）：`tools/quote-sign.py --actor agent:x` ⇒ 退出码 **2** + "
              "`human-required` + **账本零新增**；`--actor human:<人名>` ⇒ 真落 "
              "`approval/requested → approval/granted → quote/submitted`（顺序不可颠倒，INV-005）"
              "并同步给承包商账本一条 `quote/submitted`；已签后再跑 ⇒ `duplicates`（`already-signed`）"
              "+ 账本零新增",
              agent_sign[0] == 2 and (agent_sign[1].get("refusal") or {}).get("code") == "human-required"
              and agent_no_write
              and human_sign[0] == 0 and human_sign[1].get("ledger_added") == 4
              and supplier_types[-3:] == ["approval/requested", "approval/granted", "quote/submitted"]
              and contractor_types[-1] == "quote/submitted"
              and sign_again[0] == 0 and sign_again[1].get("ledger_added") == 0
              and (sign_again[1].get("duplicates") or [{}])[0].get("reason") == "already-signed",
              f"agent rc={agent_sign[0]} code={(agent_sign[1].get('refusal') or {}).get('code')}；"
              f"human rc={human_sign[0]} added={human_sign[1].get('ledger_added')}；"
              f"supplier 尾部事件={supplier_types[-3:]}；contractor 尾部={contractor_types[-1]}；"
              f"再签 added={sign_again[1].get('ledger_added')}")

        # ---- ⑫ 私域哨兵 0 命中 ----
        # 口径：**键名**可能在文案里被提到（例如「`cost_floor` 读都不读」），所以键名只扫
        # 「业务页 / 准备页 / 两侧 JSON」；**值（哨兵串）在任何页面上都必须 0 命中**。
        key_scope = {"supplier_page": supplier_quotes[1], "contractor_page": contractor_quotes[1],
                     "prepare_page": text, "supplier_json": get(f"{base}/supplier/api/events")[1],
                     "contractor_json": get(f"{base}/contractor/api/events")[1]}
        value_scope = {**key_scope, "supplier_home": supplier_home[1], "contractor_home": contractor_home[1]}
        key_hits = {name: [needle for needle in PRIVATE_KEYS if needle in body]
                    for name, body in key_scope.items()}
        value_hits = {name: [needle for needle in SENTINELS if needle in body]
                      for name, body in value_scope.items()}
        check("⑫ 私域哨兵在两视角页面/JSON **0 命中**：私域**键名**在业务页/准备页/JSON 上 0 命中；"
              "**值（哨兵串）在包括两道首页在内的所有页面上 0 命中**"
              "（**非空转对照**：哨兵确实写在夹具账本里、且承包商子视图里可读到承包商侧公开行）",
              all(not value for value in key_hits.values()) and all(not value for value in value_hits.values())
              and len(sentinels_in_file) >= 3 and "L-001" in contractor_quotes[1],
              f"键名命中={json.dumps(key_hits, ensure_ascii=False)}；"
              f"哨兵命中={json.dumps(value_hits, ensure_ascii=False)}")

        # ---- ⑬ 既有路由没坏 ----
        home_code = get(f"{base}/contractor/")[0]
        ops_code = get(f"{base}/ops/")[0]
        admin_code, admin_body, _headers = get(f"{base}/admin/")
        check("⑬ 既有路由没坏：首页/运维 200、未提权 `/admin/` 401 固定体",
              home_code == 200 and ops_code == 200 and admin_code == 401
              and admin_body.strip() == '{"error":"unauthorized"}',
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
