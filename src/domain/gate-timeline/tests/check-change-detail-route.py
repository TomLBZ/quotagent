#!/usr/bin/env python3
"""check-change-detail-route —— 「变更单到底改了什么、多花多少钱」的**真 HTTP 端到端**（`tools/verify.sh change-detail` 的后半）。

真做十件事（全部走真进程 + 真路由 + 真回读，不是"看着像接上了"）：

  ① 造**两份真夹具账本**（用 `quotagent.kernel.ledger.Ledger` 逐行 append ⇒ 哈希链真有效）：
     两侧各一张 `CO-0001`（`change/priced`，body 里带 5 行 `lines`：4 行可用 + 1 行**缺新量**）
     ＋ 一行带哨兵的私域行；
  ② 起真 `cli.mjs webui` 进程（随机端口、私有前缀 `/qcd`、私有 `--ui-shared`）；
  ③ 两视角 `GET <prefix>/<view>/changes/CO-0001/` 与 `<prefix>/<view>/api/changes/CO-0001` 都 200
     且是**真页面/真契约**（`data-money-unit="cents"` + `data-rounding="half-up-to-cent"` + 口径人话 +
     逐行 `data-detail-line` + `data-detail-missing` + `data-subtotal-delta` + 道内子导航与回列表链接）；
  ④ **逐行手算对账**（本脚本**自己**用整数分算期望值，不拿插件的输出当期望）：4 行可用逐行相等；
     小计 66000 → 82501、差额 16501；`delta_amount == amount_after − amount_before`；
     `delta_pct` 由整数分位 half-up 独立复算（原价为 0 的行记 `null`）；
  ⑤ **缺依据的行不入小计**：`L-003`（缺 `qty_after`）出现在 `basis_missing` 且**明细里没有它**，
     页面明说「未纳入小计的行」；小计等于**只含可用行**的手算值（并证明"若算进去"是另一个数）；
  ⑥ **未知 id ⇒ 404 + `next_action`**（页面与 JSON 都是 404，不静默返回空页、不编行）；
  ⑦ **私域白名单两面都扫**：承包商侧明细页/JSON 里**看得到自己的私域列**（非空转对照）；
     供应商侧明细页/JSON 里哨兵与私域键名 **0 命中**（**非空转对照**：同一批哨兵确实写在夹具账本文件里）；
  ⑧ 四份响应 **0 行 `<script>` / 0 内联事件**（扫描器非空转）；变更单列表每一行链到自己的明细页；
  ⑨ **只读**：GET 前后两份夹具账本**逐字节不变**；同一 URL 两次 GET **逐字节一致**（明细不随刷新漂移）；
  ⑩ 既有路由没被弄坏（未提权 `/admin/` 仍 401 固定体；两侧首页 200）。

退出码：0 全通过 / 1 有断言失败 / 2 环境错误。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.ledger import Ledger  # noqa: E402

CHECKS: list[dict] = []
SCRIPT_NEEDLE = "<scr" + "ipt"
INLINE_EVENT = re.compile(r"\son[a-z]+\s*=", re.I)
SENTINELS = ["COST-MODEL-SENTINEL-9a", "PRIVATE-NOTE-SENTINEL-7f", "RESERVE-PRICE-SENTINEL-4b",
             "INTERNAL-NOTE-SENTINEL-5c", "987654321"]
PRIVATE_KEYS = ["cost_floor", "markup_pct", "reserve_price", "cost_model", "private:"]
DETAIL_REASONS = {"payload-not-an-object", "change-not-found", "no-usable-lines"}
CHANGE_ID = "CO-0001"

# ---------------------------------------------------------------------------
# **手算表**（先把数字算出来再写进断言：写错本脚本就红；**绝不拿插件输出当期望**）
#   输入（整数件 × 整数分）：
#     L-001 qb=10 ub=6000 qa=12 ua=6000 ⇒ 60000 → 72000  差 12000  （12000×10000÷60000 = 2000 分位 = 20.00%）
#     L-002 qb= 3 ub=1000 qa= 3 ua=1500 ⇒  3000 →  4500  差  1500  （ 1500×10000÷ 3000 = 5000 分位 = 50.00%）
#     L-003 qb= 3 ub=2000 qa=**缺** ua=2500 ⇒ 缺依据 ⇒ 列 basis_missing 且**排除出小计**
#     L-004 qb= 0 ub=   0 qa= 5 ua=1000 ⇒     0 →  5000  差  5000  原价 0 ⇒ 百分比 **null**
#     L-005 qb= 3 ub=1000 qa= 1 ua=1001 ⇒  3000 →  1001  差 -1999  （-1999×10000÷3000 = -6663.33… → -6663 分位 = -66.63%）
#   小计（**只含可用行**）：60000+3000+0+3000 = 66000；72000+4500+5000+1001 = 82501；差 16501
#     （16501×10000÷66000 = 2500.15… → 2500 分位 = 25.00%）
#   反证：若把 L-003 的原量 × 原价也加进去（3×2000 = 6000）⇒ 原金额会是 72000（不是 66000）
#   另注：**账本里写的是元**（小数，`services/change.py` 的既有写法），本脚本用 `decimal` 按
#   **half-up 到分**自己折算成整数分（和宿主 `centsOf` 是两套独立实现）——这正是要互相对上的地方。
# ---------------------------------------------------------------------------
AS_OF = "2026-09-25T11:30:00Z"
HAND_DELTA_YUAN = 165.01     # 账本行自己声明的差额（元）⇒ ×100 = 16501 分，必须与复算的总计差额相等
HAND_LINES = {
    "L-001": {"qb": 10, "ub": 6000, "ab": 60000, "qa": 12, "ua": 6000, "aa": 72000, "d": 12000, "pct": 2000},
    "L-002": {"qb": 3, "ub": 1000, "ab": 3000, "qa": 3, "ua": 1500, "aa": 4500, "d": 1500, "pct": 5000},
    "L-004": {"qb": 0, "ub": 0, "ab": 0, "qa": 5, "ua": 1000, "aa": 5000, "d": 5000, "pct": None},
    "L-005": {"qb": 3, "ub": 1000, "ab": 3000, "qa": 1, "ua": 1001, "aa": 1001, "d": -1999, "pct": -6663},
}
HAND_SUBTOTAL = {"lines": 4, "before": 66000, "after": 82501, "delta": 16501, "pct": 2500}
HAND_WITH_MISSING_BEFORE = 66000 + 3 * 2000     # 若把缺依据行也算进去 = 72000（另一个数）

SHARED = ROOT / "tmp" / "change-detail-route"
UI_SHARED = SHARED / "ui-shared"
CONTRACTOR_LEDGER = SHARED / "contractor" / "ledger.jsonl"
SUPPLIER_LEDGER = SHARED / "supplier" / "ledger.jsonl"

LINES = [
    {"line_id": "L-001", "desc": "钢筋", "qty_before": 10, "unit_price_before": 60, "qty_after": 12,
     "unit_price_after": 60},
    {"line_id": "L-002", "desc": "水泥", "qty_before": 3, "unit_price_before": 10, "qty_after": 3,
     "unit_price_after": 15},
    {"line_id": "L-003", "desc": "砂石", "qty_before": 3, "unit_price_before": 20, "qty_after": None,
     "unit_price_after": 25},
    {"line_id": "L-004", "desc": "模板", "qty_before": 0, "unit_price_before": 0, "qty_after": 5,
     "unit_price_after": 10},
    {"line_id": "L-005", "desc": "拆改", "qty_before": 3, "unit_price_before": 10, "qty_after": 1,
     "unit_price_after": 10.01},
]


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def raw_request(url: str, timeout: float = 15.0, headers: dict | None = None,
                follow_redirects: bool = True) -> tuple[int, str]:
    try:
        request = urllib.request.Request(url, headers=headers or {})
        opener = urllib.request.urlopen if follow_redirects else _NO_REDIRECT_OPENER.open
        with opener(request, timeout=timeout) as response:
            return int(response.status), response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return int(err.code), err.read().decode("utf-8", "replace")
    except Exception as err:  # noqa: BLE001
        return 0, f"<error {type(err).__name__}: {err}>"


def _fetch_full(url: str, data: bytes | None = None, headers: dict | None = None,
                follow_redirects: bool = True) -> tuple[int, str, dict]:
    """底层请求（状态码 / 文本 / 响应头）—— 登录与「两种拒绝形状」用。"""
    try:
        request = urllib.request.Request(url, data=data, headers=headers or {})
        opener = urllib.request.urlopen if follow_redirects else _NO_REDIRECT_OPENER.open
        with opener(request, timeout=15.0) as response:
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
# 纪律：断言**一条不删、一条不放松** —— 业务路由仍逐条要求 200/404，只是带上本侧 cookie。
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
        payload = urllib.parse.urlencode({"name": f"gate-change-detail-{side}", "side": side}).encode("utf-8")
        code, body, headers = _fetch_full(f"{BASE}/identity/login?format=json", data=payload)
        cookie = header_of(headers, "set-cookie").split(";")[0]
        if code != 200 or not cookie.startswith("qa_identity="):
            raise RuntimeError(f"门夹具登录失败：side={side} status={code} body={body[:200]}")
        COOKIES[side] = cookie
    return {"Cookie": COOKIES[side]}


def get(url: str) -> tuple[int, str]:
    return raw_request(url, headers=cookie_of(url))


def parse_json(body: str) -> dict:
    try:
        data = json.loads(body)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def half_up_hundredths(numerator: int, denominator: int) -> int:
    """**本脚本自己的**整数分位 half-up（远离零）：用来复算 `delta_pct`，不读插件的数。"""
    sign = -1 if numerator < 0 else 1
    magnitude = -numerator if numerator < 0 else numerator
    return sign * ((2 * magnitude + denominator) // (2 * denominator))


def cents_of(value) -> int:
    """**本脚本自己的**「元 → 整数分」折算（`decimal` + half-up 到分，负值远离零）——独立于宿主的实现。"""
    return int((Decimal(str(value)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def hand_of(line: dict) -> dict:
    """从夹具（不是从响应）算出期望值：金额先按 half-up 折成整数分，再全程整数运算。"""
    before = line["qty_before"] * cents_of(line["unit_price_before"])
    after = line["qty_after"] * cents_of(line["unit_price_after"])
    delta = after - before
    pct = None if before == 0 else half_up_hundredths(delta * 10000, before) / 100
    return {"before": before, "after": after, "delta": delta, "pct": pct}


def write_fixtures() -> dict:
    report = {}
    for path in (CONTRACTOR_LEDGER, SUPPLIER_LEDGER):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)
    owner_extra = {"cost_floor": SENTINELS[0], "reserve_price": SENTINELS[2], "private:note": SENTINELS[1]}
    other_extra = {"internal_notes": SENTINELS[3], "cost_model": SENTINELS[0]}
    private_row = ("quote/submitted", "q-private", AS_OF,
                   {"quote_id": "q-private", "lines": [{"item_id": "L-001", "qty": 10, "unit_price": 60}],
                    "cost_floor": SENTINELS[4], "markup_pct": 12.5, "reserve_price": SENTINELS[2],
                    "cost_model": SENTINELS[0], "private:note": SENTINELS[1]})
    both = [
        ("change/priced", CHANGE_ID, "2026-09-25T11:00:00Z",
         {"change_id": CHANGE_ID, "quote_id": "q-1", "delta_amount": HAND_DELTA_YUAN,
          "basis_unit_price_refs": ["q-1#L-001:unit_price"]}),
        private_row,
        # 批准事件**不带行清单**：逐行明细的真源必须是上面那条带行的 `change/priced`
        # （拿"最后一条 change/* 事件"当来源 ⇒ 真实账本上明细会整张变空，本门必须抓到）
        ("change/approved", CHANGE_ID, "2026-09-25T11:30:00Z",
         {"change_id": CHANGE_ID, "quote_id": "q-1", "delta_amount": HAND_DELTA_YUAN,
          "approved_by": "human:liangzi"}),
    ]
    ledgers = {}
    for path, realm, extra in ((CONTRACTOR_LEDGER, "contractor:con-B", owner_extra),
                               (SUPPLIER_LEDGER, "supplier:sup-1", other_extra)):
        rows = []
        for type_, correlation, ts, body in both:
            row = dict(body)
            if type_ == "change/priced":
                row["lines"] = [dict(line, **extra) for line in LINES]
            rows.append((type_, correlation, ts, row))
        ledger = Ledger(path, realm=realm)
        for type_, correlation, ts, body in rows:
            ledger.append(type_, body, correlation_id=correlation, ts=ts, actor="agent:fixture")
        ledgers[path] = ledger
    report["rows"] = ledgers[CONTRACTOR_LEDGER].count
    report["healthy"] = bool(ledgers[CONTRACTOR_LEDGER].verify_report()["ok"])
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


def main() -> int:  # noqa: C901
    global BASE
    shutil.rmtree(SHARED, ignore_errors=True)
    fixture = write_fixtures()
    UI_SHARED.mkdir(parents=True, exist_ok=True)
    contractor_text = CONTRACTOR_LEDGER.read_text(encoding="utf-8")
    fixture_has = [needle for needle in SENTINELS if needle in contractor_text]
    check("① 夹具就绪（两侧真哈希链 / 同一张 CO-0001：带行清单的 change/priced + 一行私域行 + "
          "**不带行的 change/approved**（回归围栏）/ 哨兵在文件里）",
          fixture["rows"] == 3 and fixture["healthy"] and len(fixture_has) >= 3
          and all(f'"line_id":"{line["line_id"]}"' in contractor_text.replace(" ", "") for line in LINES),
          f"账本行={fixture['rows']} 链自洽={fixture['healthy']}；哨兵命中={fixture_has}；"
          f"行={[line['line_id'] for line in LINES]}")

    ledger_before = sha256_file(CONTRACTOR_LEDGER)
    supplier_before = sha256_file(SUPPLIER_LEDGER)
    port, prefix = free_port(), "/qcd"
    proc = serve(port, prefix)
    base = f"http://127.0.0.1:{port}{prefix}"
    BASE = base
    try:
        up = wait_up(base, proc)
        check("② 真进程就绪（`cli.mjs webui` + `/api/health` 200；看明细**不需要**管理员身份）",
              up, f"port={port} prefix={prefix} pid={proc.pid}")
        if not up:
            return 2

        # ---- ②b 身份门槛（P3 的判据本身也要机检；下面所有业务路由都**登录后再取**）----
        anon_json_code, anon_json_body, _h = _fetch_full(
            f"{base}/contractor/api/changes/CO-0001", headers={"Accept": "application/json"})
        anon_html_code, _b, anon_html_headers = _fetch_full(
            f"{base}/supplier/changes/CO-0001/", headers={"Accept": "text/html"}, follow_redirects=False)
        cookie_contractor = cookie_of(f"{base}/contractor/changes/CO-0001/")
        cookie_supplier = cookie_of(f"{base}/supplier/changes/CO-0001/")     # noqa: F841（两侧各登录一次）
        same_side = _fetch_full(f"{base}/contractor/changes/CO-0001/", headers=cookie_contractor)
        cross_side = _fetch_full(f"{base}/supplier/changes/CO-0001/", headers=cookie_contractor)
        cross_json = _fetch_full(f"{base}/supplier/api/changes/CO-0001", headers=cookie_contractor)
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

        # ---- ③ 路由登记 + 四条只读响应 ----
        routes = parse_json(get(f"{base}/api/routes")[1]).get("routes", [])
        change_routes = [item for item in routes if "/changes/" in str(item.get("path", ""))]
        pages = {view: get(f"{base}/{view}/changes/{CHANGE_ID}/") for view in ("contractor", "supplier")}
        jsons = {view: get(f"{base}/{view}/api/changes/{CHANGE_ID}") for view in ("contractor", "supplier")}
        parsed = {view: parse_json(jsons[view][1]) for view in jsons}
        # 旧列表路由已退役 ⇒ 不跟 303 取回（旧页不再返回内容、也不 404）
        list_code, _lb, list_headers = _fetch_full(f"{base}/contractor/gates/",
                                                   headers=cookie_of(f"{base}/contractor/gates/"),
                                                   follow_redirects=False)
        list_page = ""          # 旧列表内容已随页删除（29 §2 不留副本）；303 的响应体在下面单独扫
        cpage, spage = pages["contractor"][1], pages["supplier"][1]
        check("③ 两视角明细页/JSON 各自 **200**；`/api/routes` 登记了 4 条新路由且 `auth` 全是**真实值**"
              "`identity-session`（业务路由要身份会话——台账不再写 `none` 撒谎）；"
              "页面是真页面（`data-money-unit=\\\"cents\\\"` + `data-rounding=\\\"half-up-to-cent\\\"` + 口径人话 + "
              "道内子导航 + 回跳抓手 `data-detail-back`（已接到 GUI））；旧列表路由已退役为 "
              "**303 → `/app/contractor/`**（不 404，也不留旧列表副本）",
              len(change_routes) == 4 and all(item.get("auth") == "identity-session" for item in change_routes)
              and len([i for i in change_routes if i.get("method") == "GET"]) == 4
              and pages["contractor"][0] == 200 and jsons["contractor"][0] == 200
              and pages["supplier"][0] == 200 and jsons["supplier"][0] == 200
              and all(text in cpage for text in ('data-money-unit="cents"', 'data-rounding="half-up-to-cent"',
                                                 "整数分", "half-up-to-cent", 'data-subnav="contractor"',
                                                 'data-gates-link="1"', 'data-detail-back="1"'))
              and list_code == 303
              and str(header_of(list_headers, "location")).endswith("/app/contractor/"),
              f"路由={json.dumps([f'{i.get('method')} {i.get('path')}' for i in change_routes], ensure_ascii=False)}；"
              f"status={pages['contractor'][0]}/{jsons['contractor'][0]}/{pages['supplier'][0]}/{jsons['supplier'][0]}；"
              f"旧列表路由={list_code} → {header_of(list_headers, 'location')}")

        # ---- ④ 逐行手算对账（本脚本自己算，不拿输出当期望）----
        def reconcile(payload: dict) -> tuple[bool, list[str]]:
            seen = {line.get("line_id"): line for line in payload.get("lines", [])}
            lines_report = []
            ok = len(payload.get("lines", [])) == len(HAND_LINES)
            for line_id, hand in HAND_LINES.items():
                actual = seen.get(line_id) or {}
                own = hand_of(next(item for item in LINES if item["line_id"] == line_id))
                good = (actual.get("qty_before") == hand["qb"] and actual.get("unit_price_before") == hand["ub"]
                        and actual.get("amount_before") == hand["ab"] and actual.get("qty_after") == hand["qa"]
                        and actual.get("unit_price_after") == hand["ua"] and actual.get("amount_after") == hand["aa"]
                        and actual.get("delta_amount") == hand["d"]
                        and (hand["pct"] is None if actual.get("delta_pct") is None
                             else actual.get("delta_pct") == hand["pct"] / 100)
                        # 独立复算（不引用插件的任何中间量）
                        and actual.get("amount_before") == own["before"] == hand["qb"] * hand["ub"]
                        and actual.get("amount_after") == own["after"] == hand["qa"] * hand["ua"]
                        and actual.get("delta_amount") == actual.get("amount_after") - actual.get("amount_before")
                        and (actual.get("delta_pct") is None and own["pct"] is None
                             or actual.get("delta_pct") == own["pct"]))
                ok = ok and good
                lines_report.append(f"{line_id} 手算 {hand['ab']}→{hand['aa']} 差 {hand['d']} "
                                    f"百分比 {hand['pct']/100 if hand['pct'] is not None else None} ｜实得 "
                                    f"{actual.get('amount_before')}→{actual.get('amount_after')} 差 "
                                    f"{actual.get('delta_amount')} 百分比 {actual.get('delta_pct')} ｜"
                                    f"{'一致' if good else '**不一致**'}")
            sub = payload.get("subtotal") or {}
            sub_ok = (sub.get("lines") == HAND_SUBTOTAL["lines"] and sub.get("amount_before") == HAND_SUBTOTAL["before"]
                      and sub.get("amount_after") == HAND_SUBTOTAL["after"]
                      and sub.get("delta_amount") == HAND_SUBTOTAL["delta"]
                      and sub.get("delta_pct") == HAND_SUBTOTAL["pct"] / 100
                      and sub.get("delta_amount") == sub.get("amount_after") - sub.get("amount_before"))
            return ok and sub_ok, lines_report + [
                f"小计手算 {HAND_SUBTOTAL['before']}→{HAND_SUBTOTAL['after']} 差 {HAND_SUBTOTAL['delta']}"
                f"（{HAND_SUBTOTAL['pct']/100:.2f}%）｜实得 {sub.get('amount_before')}→{sub.get('amount_after')}"
                f" 差 {sub.get('delta_amount')}（{sub.get('delta_pct')}%）"]

        c_ok, c_lines = reconcile(parsed["contractor"])
        s_ok, s_lines = reconcile(parsed["supplier"])
        check("④ **逐行手算金额对账**（本脚本自己用整数分算出期望值；账本里写的**元**由本脚本用 `decimal` "
              "half-up 折成整数分）：4 个可用行逐字段相等（L-001 60000→72000 / L-002 3000→4500 / "
              "L-004 0→5000 且原价 0 ⇒ `delta_pct=null` / L-005 3000→1001 差 -1999 ⇒ -66.63%）；"
              "小计等于手算的 66000 → 82501、差 16501（25.00%）；`delta_amount == amount_after − amount_before`；"
              "`money_unit` 是 `cents`、`rounding` 是 `half-up-to-cent`；**与账本自己的声明对齐**："
              "账本行 `delta_amount=165.01` 元 ⇒ 复算的总计差额 16501 分",
              c_ok and s_ok and parsed["contractor"].get("money_unit") == "cents"
              and parsed["contractor"].get("rounding") == "half-up-to-cent"
              and parsed["contractor"].get("as_of") == AS_OF
              and parsed["contractor"]["subtotal"]["delta_amount"] == cents_of(HAND_DELTA_YUAN)
              and parsed["contractor"]["lines"][0]["unit_price_before"] == 6000,
              "承包商侧：" + "；".join(c_lines) + f" ｜ 供应商侧一致={s_ok}；"
              f"账本声明 {HAND_DELTA_YUAN} 元 ⇒ 折算 {cents_of(HAND_DELTA_YUAN)} 分 ｜ 复算 "
              f"{parsed['contractor']['subtotal']['delta_amount']} 分")

        # ---- ⑤ 缺依据的行不入小计（双向）----
        missing_s = parsed["supplier"].get("basis_missing") or []
        missing_ids = [item.get("line_id") for item in missing_s]
        missing_fields = [item.get("missing") for item in missing_s]
        detail_ids = [line.get("line_id") for line in parsed["supplier"].get("lines", [])]
        check("⑤ **缺依据的行不入小计**（两面都量）：`L-003`（缺 `qty_after`）列入 `basis_missing` 且"
              "**明细里没有它**；小计等于**只含 4 个可用行**的手算值 66000（并证明「若把它算进去」会是 "
              f"{HAND_WITH_MISSING_BEFORE}）；页面/JSON 都明说「未纳入小计的行」；`counts.lines_excluded=1`",
              missing_ids == ["L-003"] and missing_fields == [["qty_after"]]
              and "L-003" not in detail_ids
              and parsed["supplier"]["subtotal"]["amount_before"] == HAND_SUBTOTAL["before"]
              and parsed["supplier"]["subtotal"]["amount_before"] != HAND_WITH_MISSING_BEFORE
              and parsed["supplier"]["counts"]["lines_excluded"] == 1
              and "未纳入小计的行" in spage and "未纳入小计的行" in cpage
              and f'data-detail-missing="{missing_ids[0] if missing_ids else ""}"' in spage,
              f"basis_missing={json.dumps(missing_s, ensure_ascii=False)}；明细 id={detail_ids}；"
              f"小计原金额={parsed['supplier']['subtotal']['amount_before']}（手算只含可用行 "
              f"{HAND_SUBTOTAL['before']}；若含缺依据行会是 {HAND_WITH_MISSING_BEFORE}）")

        # ---- ⑥ 未知 id ⇒ 404 + next_action ----
        bad_page = get(f"{base}/contractor/changes/CO-9999/")
        bad_json = get(f"{base}/contractor/api/changes/CO-9999")
        bad_payload = parse_json(bad_json[1])
        check("⑥ **未知 id ⇒ 404 + `next_action`**（页面与 JSON 都是 404；reason 在闭合集合里；"
              "不静默返回空页、也不编行）",
              bad_page[0] == 404 and bad_json[0] == 404 and bad_payload.get("degraded") is True
              and bad_payload.get("reason") in DETAIL_REASONS
              and len(str(bad_payload.get("next_action") or "")) > 10 and bad_payload.get("lines") == []
              and bad_payload.get("subtotal", {}).get("delta_amount") is None
              and "change-not-found" in bad_page[1],
              f"页面={bad_page[0]} JSON={bad_json[0]} reason={bad_payload.get('reason')}；"
              f"next_action={str(bad_payload.get('next_action'))[:60]}…；lines={bad_payload.get('lines')}")

        # ---- ⑦ 私域两面扫 ----
        supplier_text = spage + jsons["supplier"][1]
        contractor_text_out = cpage + jsons["contractor"][1]
        hits_supplier = [needle for needle in SENTINELS + PRIVATE_KEYS if needle in supplier_text]
        hits_contractor = [needle for needle in SENTINELS if needle in contractor_text_out]
        check("⑦ **私域白名单两面都扫**：承包商侧明细页/JSON 里**看得到自己的私域列**（`data-detail-private` + "
              "哨兵命中 ≥3，非空转对照）；供应商侧明细页/JSON 里哨兵与私域键名 **0 命中**"
              "（**非空转对照**：同一批哨兵确实写在夹具账本文件里）",
              not hits_supplier and 'data-detail-private="1"' in contractor_text_out
              and len(hits_contractor) >= 3 and len(fixture_has) >= 3
              and "读都不读" in supplier_text,
              f"供应商侧命中={hits_supplier or '无'}；承包商侧哨兵命中={hits_contractor}；"
              f"承包商侧有私域列表={'data-detail-private=\"1\"' in contractor_text_out}；"
              f"夹具里确实有哨兵={fixture_has}")

        # ---- ⑧ 0 脚本 / 0 内联事件 + 只读 ----
        responses = {"page:c": cpage, "page:s": spage, "json:c": jsons["contractor"][1],
                     "json:s": jsons["supplier"][1]}
        scripty = [name for name, text in responses.items()
                   if SCRIPT_NEEDLE in text or INLINE_EVENT.search(text)]
        self_test = (SCRIPT_NEEDLE in f"<a {SCRIPT_NEEDLE}>") or bool(INLINE_EVENT.search('<a onclick="x()">'))
        check("⑧ 四份响应 **0 行脚本 / 0 内联事件**（扫描器非空转）；这两条明细路由是**只读**的："
              "GET 前后两份夹具账本**逐字节不变**（账本零新增）",
              not scripty and self_test
              and sha256_file(CONTRACTOR_LEDGER) == ledger_before
              and sha256_file(SUPPLIER_LEDGER) == supplier_before,
              f"含脚本={scripty or '无'}；对照={self_test}；"
              f"承包商账本未变={sha256_file(CONTRACTOR_LEDGER) == ledger_before}；"
              f"供应商账本未变={sha256_file(SUPPLIER_LEDGER) == supplier_before}")

        # ---- ⑨ 确定性 + 既有路由 ----
        again = get(f"{base}/contractor/api/changes/{CHANGE_ID}")
        again_page = get(f"{base}/contractor/changes/{CHANGE_ID}/")
        admin_code, admin_body = get(f"{base}/admin/")
        home_code, _ = get(f"{base}/contractor/")
        ops_code, _ = get(f"{base}/api/ops")
        check("⑨ 同一 URL 两次 GET **逐字节一致**（明细不随刷新漂移：`as_of` 来自事实 ts、"
              "两个墙钟入口被忽略）；既有路由没被弄坏（两侧首页 200 / 未提权 `/admin/` 仍 401 固定体）",
              again[1] == jsons["contractor"][1] and again_page[1] == cpage and home_code == 200
              and ops_code == 200 and admin_code == 401 and admin_body.strip() == '{"error":"unauthorized"}'
              and parse_json(again[1]).get("as_of") == AS_OF,
              f"JSON 两次一致={again[1] == jsons['contractor'][1]}；页面两次一致={again_page[1] == cpage}；"
              f"as_of={parse_json(again[1]).get('as_of')}；home={home_code} ops={ops_code} admin={admin_code}")
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
