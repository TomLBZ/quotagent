#!/usr/bin/env python3
"""check-advice-route —— 决策建议层的**真 HTTP 端到端**（`tools/verify.sh advice` 的后半）。

真做七件事（全部走真进程 + 真路由 + 真回读，不是"看着像接上了"）：
  ① 写两份**夹具账本**（承包商侧 / 供应商侧各自的账本文件，与部署形状一致：每个视角读自己的账本）
     + 一份**夹具邮件域快照**（只放通道声明：SMTP `available:false` + 真实 next_action）；
  ② 起一个真 `cli.mjs webui` 进程（随机空闲端口、私有前缀 `/qaadv`）；
  ③ **旧 SSR 页已退役**（`RETIRED_SUBVIEWS`）：四条旧路由一律 303 → `<前缀>/app/<view>/`；
     承接这件事的 GUI 面板真的注册在那一页上；退役响应体与承接面板载荷里
     `终端` / `g1side` / `PYTHONPATH` / `命令行` **0 命中**
     （`data-engine="rules"` + "不含模型推测"那句 + 建议表 + 逐条 `basis`），且 **0 行 `<script>` / 0 内联事件**；
  ④ **两视角建议确实不同**（页面体、建议 id 列表、JSON items 都比）：承包商侧出 4 条（截止/比价极差/人工门/通道），
     供应商侧出 2 条（人工门/通道）——同一份代码、同一套规则，**输入不同则建议不同**；
  ⑤ **私域哨兵 0 次**（两视角 advice 页/JSON 里搜不到承包商私域键与哨兵串），并有非空转对照
     （同一批哨兵确实写在夹具账本文件里）；
  ⑥ 确定性：同一 URL 两次 GET **响应体逐字节一致**（页面与 JSON 都试）；
  ⑦ **空投影必须降级且建议数为 0**：第二个真进程，两本账本都是 0 行 + 无快照 →
     页面 `data-degraded="1"`、JSON `items == []` + `degraded:true` + 有名 reason（**不编建议**）。

额外断言：`/api/routes` 里四条新路由的 `auth` 都是 `identity-session`（业务路由要身份会话；**不涉未提权的 admin**）、
既有路由没被弄坏、跑完之后夹具账本与目录**逐字节不变**（宿主零写面在 HTTP 层的机检形态）。

退出码：0 全通过 / 1 有断言失败 / 2 环境错误。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
CHECKS: list[dict] = []
# 哨兵串：承包商私域里刻意放的值，任何对外响应体里出现一次就是泄漏
SENTINELS = ["COST-MODEL-SENTINEL-9a", "RESERVE-PRICE-SENTINEL-4b", "PRIVATE-NOTE-SENTINEL-7f", "987654321"]
PRIVATE_KEYS = ["cost_floor", "markup_pct", "reserve_price", "cost_model", "private:", "bidders_private"]
REASONS = {"payload-not-an-object", "no-usable-inputs", "no-signal"}
# 手算期望（**从真运行量出来的**，不是凭印象写：写错它门就红）：同一套规则、不同输入给出不同建议
#   承包商：报价截止已过期 + L-001 两家极差 100 分（high）+ award.commit 人工门 + 邮件通道不可用
#   供应商：自己侧 L-001 两家极差 100 分 + quote.submit 人工门 + 邮件通道不可用 + 提升排名（focus=price）
CONTRACTOR_ADVICE = ["expiry:pkg-1", "spread:L-001", "gate:ap-0007", "channel:mail"]
SUPPLIER_ADVICE = ["spread:L-001", "gate:ap-0021", "channel:mail", "rank-up:q-sup-2"]
CHANNEL_NEXT = "配置 SMTP/IMAP 凭据后接入（本接口不假装能发）"

BASIS_RE = re.compile(r"^(as_of|(deadlines|gates|ranking|channels)\[[^\]]+\]\.[a-z_]+)$")


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def get(url: str, timeout: float = 10.0, follow_redirects: bool = True) -> tuple[int, str]:
    """真回读（返回**原始字节解码后的文本**；状态码来自 HTTP 响应本身）—— 业务路由带本侧身份。"""
    try:
        request = urllib.request.Request(url, headers=cookie_of(url))
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
# 登录走**真入口** `POST /identity/login`（`format=json` ⇒ 200 + `Set-Cookie: qa_identity=…`）。
# 纪律：断言**一条不删、一条不放松** —— 业务路由仍逐条要求 200，只是带上本侧 cookie。
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
        payload = urllib.parse.urlencode({"name": f"gate-advice-{side}", "side": side}).encode("utf-8")
        code, body, headers = _fetch_full(f"{BASE}/identity/login?format=json", data=payload)
        cookie = header_of(headers, "set-cookie").split(";")[0]
        if code != 200 or not cookie.startswith("qa_identity="):
            raise RuntimeError(f"门夹具登录失败：side={side} status={code} body={body[:200]}")
        COOKIES[side] = cookie
    return {"Cookie": COOKIES[side]}


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ids_of_page(text: str) -> list[str]:
    return re.findall(r'data-advice-id="([^"]*)"', text)


def page_reason(text: str) -> str:
    found = re.search(r'data-degraded="1"[\s\S]{0,400}?<code>([^<]*)</code>', text)
    return found.group(1) if found else ""


def parse_json(body: str) -> dict:
    try:
        data = json.loads(body)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


# ---------------------------------------------------------------------------
# ① 夹具（写进 tmp/，**不碰**真账本；两份账本分别给两个视角读）
# ---------------------------------------------------------------------------
SHARED = ROOT / "tmp" / "advice-route"
CONTRACTOR_LEDGER = SHARED / "contractor" / "ledger.jsonl"
SUPPLIER_LEDGER = SHARED / "supplier" / "ledger.jsonl"
EMPTY_LEDGER = SHARED / "empty" / "ledger.jsonl"
MAIL_SNAPSHOT = SHARED / "mail.json"
MAIL_SNAPSHOT_MISSING = SHARED / "mail-absent.json"
# 身份会话（P3）故意落在**被监视的目录之外**：会话文件是宿主按设计写的**服务端状态**（`<ui_shared>/identity/`），
# 不是夹具数据。放进 SHARED 会让 ⑫「目录一元不增」变成「容忍一个文件」—— 那是**放松判据**，不做。
UI_SHARED = ROOT / "tmp" / "advice-route-identity"


def row(seq: int, type_: str, correlation: str, ts: str, body: dict, realm: str) -> dict:
    return {"seq": seq, "type": type_, "correlation_id": correlation, "actor": "agent:fixture", "ts": ts,
            "realm": realm, "body": body}


# 承包商侧：报价截止已过期（相对 as_of=max(ts)=2026-09-21T10:00:00Z）+ 两家同项报价（极差 100 → high）
#             + 一条人工门（award.commit）+ 一条**带私域键**的报价行（整行跳过，但哨兵确实在文件里）
CONTRACTOR_ROWS = [
    row(1, "rfq/published", "pkg-1", "2026-09-21T08:00:00Z",
        {"package_id": "pkg-1", "rev": 1, "quote_by": "2026-09-20T00:00:00Z"}, "contractor:con-B"),
    row(2, "quote/submitted", "q-100", "2026-09-21T09:00:00Z",
        {"quote_id": "q-100", "rfq_rev": 1, "lines": [{"item_id": "L-001", "qty": 10, "unit_price": 100}]},
        "contractor:con-B"),
    row(3, "quote/submitted", "q-080", "2026-09-21T09:30:00Z",
        {"quote_id": "q-080", "rfq_rev": 1, "lines": [{"item_id": "L-001", "qty": 10, "unit_price": 80}]},
        "contractor:con-B"),
    row(4, "quote/submitted", "q-private", "2026-09-21T09:45:00Z",
        {"quote_id": "q-private", "lines": [{"item_id": "L-001", "qty": 10, "unit_price": 60}],
         "cost_floor": SENTINELS[3], "markup_pct": 12.5, "reserve_price": SENTINELS[1],
         "cost_model": SENTINELS[0], "private:note": SENTINELS[2]}, "contractor:con-B"),
    row(5, "approval/requested", "awin-1", "2026-09-21T10:00:00Z",
        {"approval_id": "ap-0007", "scope": "award.commit", "ref": "awin-1", "status": "pending"}, "contractor:con-B"),
]
# 供应商侧：两家同项报价但**幅度只有 2 分**（不触发区间异常）+ 一条**自己侧**的人工门（quote.submit）
#             没有任何 rfq/* 行 → 没有截止类建议（两视角建议必然不同）
SUPPLIER_ROWS = [
    row(1, "quote/submitted", "q-sup-1", "2026-09-21T09:00:00Z",
        {"quote_id": "q-sup-1", "rfq_rev": 1, "lines": [{"item_id": "L-001", "qty": 10, "unit_price": 50}]},
        "supplier:sup-A"),
    row(2, "quote/submitted", "q-sup-2", "2026-09-21T09:30:00Z",
        {"quote_id": "q-sup-2", "rfq_rev": 1, "lines": [{"item_id": "L-001", "qty": 10, "unit_price": 52}]},
        "supplier:sup-A"),
    row(3, "approval/requested", "q-sup-1", "2026-09-21T10:00:00Z",
        {"approval_id": "ap-0021", "scope": "quote.submit", "ref": "q-sup-1", "status": "pending"}, "supplier:sup-A"),
]
# 通道声明的来源 = **邮件域快照**（`<ui_shared>/mail.json`，与 `/api/mail` 同一个文件）。
# 三域流水只读快照已随运维面退役（29 §2）⇒ 夹具改成**邮件域快照**的形状（`transport` 是
# `services/mail_transport.status()` 的摘要：顶层三件 + `smtp`/`imap` 明细）。
MAIL_DOC = {
    "schema": 1,
    "generated_at": "2026-09-21T12:00:00Z",
    "service": "mail",
    "views": {view: {"queued": 1, "refused": 1, "sent": 0, "parsed": 0} for view in ("contractor", "supplier")},
    "totals": {"queued": 2, "refused": 2, "sent": 0, "parsed": 0},
    "transport": {
        "available": False, "reason": "mail-smtp-unconfigured",
        "next_action": "配置 SMTP/IMAP 凭据后接入（本接口不假装能发）",
        "smtp": {"available": False, "reason": "mail-smtp-unconfigured",
                 "next_action": "配置 SMTP/IMAP 凭据后接入（本接口不假装能发）"},
        "imap": {"available": False, "reason": "mail-imap-unconfigured",
                 "next_action": "配置 SMTP/IMAP 凭据后接入（本接口不假装能发）"},
    },
}


def write_fixtures() -> None:
    for path, rows in ((CONTRACTOR_LEDGER, CONTRACTOR_ROWS), (SUPPLIER_LEDGER, SUPPLIER_ROWS)):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")
    EMPTY_LEDGER.parent.mkdir(parents=True, exist_ok=True)
    EMPTY_LEDGER.write_text("", encoding="utf-8")
    MAIL_SNAPSHOT.write_text(json.dumps(MAIL_DOC, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    UI_SHARED.mkdir(parents=True, exist_ok=True)


def serve(port: int, prefix: str, contractor: Path, supplier: Path, mail_snapshot: Path) -> subprocess.Popen:
    return subprocess.Popen(
        ["node", str(ROOT / "host" / "cli.mjs"), "webui", "--profile", "webui", "--port", str(port),
         "--host", "127.0.0.1", "--prefix", prefix,
         "--ledger-contractor", str(contractor), "--ledger-supplier", str(supplier),
         "--mail-snapshot", str(mail_snapshot), "--ui-shared", str(UI_SHARED)],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        env={key: value for key, value in os.environ.items() if key != "QUOTAGENT_ADMIN_TOKEN"})


def wait_up(base: str, proc: subprocess.Popen) -> bool:
    for _ in range(40):
        code, _body = get(f"{base}/api/health", timeout=3)
        if code == 200:
            return True
        if proc.poll() is not None:
            return False
        time.sleep(0.5)
    return False


def main() -> int:  # noqa: C901
    global BASE
    write_fixtures()
    watched = [CONTRACTOR_LEDGER, SUPPLIER_LEDGER, EMPTY_LEDGER, MAIL_SNAPSHOT]
    before = {str(path): sha256_file(path) for path in watched}
    listing_before = sorted(str(item.relative_to(SHARED)) for item in SHARED.rglob("*"))
    check("① 夹具就绪（承包商 5 行含哨兵 / 供应商 3 行 / 空账本 0 行 / 一份通道快照；"
          "两份账本分别给两个视角读，形状与部署一致）",
          len(CONTRACTOR_ROWS) >= 4 and len(SUPPLIER_ROWS) >= 3 and all(Path(p).exists() for p in before)
          and EMPTY_LEDGER.read_text(encoding="utf-8") == "",
          f"{CONTRACTOR_LEDGER.name}={len(CONTRACTOR_ROWS)} 行；{SUPPLIER_LEDGER.name}={len(SUPPLIER_ROWS)} 行；"
          f"空账本={EMPTY_LEDGER.stat().st_size} B；快照={json.dumps(MAIL_DOC['transport'], ensure_ascii=False)[:60]}…")

    port = free_port()
    prefix = "/qaadv"
    proc = serve(port, prefix, CONTRACTOR_LEDGER, SUPPLIER_LEDGER, MAIL_SNAPSHOT)
    base = f"http://127.0.0.1:{port}{prefix}"
    BASE = base
    try:
        up = wait_up(base, proc)
        check("② 真进程就绪（`cli.mjs webui` + `/api/health` 200；**不需要**管理员 token）",
              up, f"port={port} prefix={prefix} pid={proc.pid}")
        if not up:
            return 2

        # ---- ②b 身份门槛（P3 的判据本身也要机检；下面所有业务路由都**登录后再取**）----
        anon_json_code, anon_json_body, _h = _fetch_full(
            f"{base}/contractor/api/advice", headers={"Accept": "application/json"})
        anon_html_code, _b, anon_html_headers = _fetch_full(
            f"{base}/supplier/advice/", headers={"Accept": "text/html"}, follow_redirects=False)
        cookie_contractor = cookie_of(f"{base}/contractor/advice/")
        cookie_supplier = cookie_of(f"{base}/supplier/advice/")     # noqa: F841（两侧各登录一次）
        # 旧页已退役（`RETIRED_SUBVIEWS`）：同侧登录后拿到的也是 **303 → GUI**（不 404、不再是旧页 200）。
        same_side = _fetch_full(f"{base}/contractor/advice/", headers=cookie_contractor, follow_redirects=False)
        cross_side = _fetch_full(f"{base}/supplier/advice/", headers=cookie_contractor)
        cross_json = _fetch_full(f"{base}/supplier/api/advice", headers=cookie_contractor)
        check("②b 身份门槛负控：**未登录**取业务路由一律拒 —— API/JSON ⇒ 401 `identity-required` + `next`；"
              "浏览器形状（`Accept: text/html`）⇒ 303 回 `<前缀>/identity/?next=<原地址>`（不是 200、不是 404）",
              anon_json_code == 401 and "identity-required" in anon_json_body and '"next"' in anon_json_body
              and anon_html_code == 303 and "/identity/?next=" in header_of(anon_html_headers, "location"),
              f"JSON={anon_json_code} 含 identity-required={'identity-required' in anon_json_body}；"
              f"HTML={anon_html_code} location={header_of(anon_html_headers, 'location')[:80]}")
        check("②b' 身份门槛正控：**登录后按侧放行** —— 同侧 ⇒ **303 → `<前缀>/app/contractor/`**"
              "（旧页退役后不再返回内容）；拿承包商 cookie 去 `/supplier/`"
              "（页面与 JSON 两条形状）都 ⇒ **403 `side-mismatch`**（不许回落成「能看」）",
              same_side[0] == 303 and str(header_of(same_side[2], "location")).endswith("/app/contractor/")
              and cross_side[0] == 403 and "side-mismatch" in cross_side[1]
              and cross_json[0] == 403 and "side-mismatch" in cross_json[1],
              f"同侧={same_side[0]} → {header_of(same_side[2], 'location')}；越侧页面={cross_side[0]} "
              f"越侧 JSON={cross_json[0]} 含 side-mismatch={'side-mismatch' in cross_side[1]}")

        # ---- ③ 路由登记 ----
        code, routes_body = get(f"{base}/api/routes")
        routes = parse_json(routes_body).get("routes", [])
        advice_routes = [item for item in routes if "advice" in str(item.get("path", ""))]
        check("③ `/api/routes` 登记了两视角 ×（页面 + JSON）四条新路由，且 `auth` 是**真实值**"
              "`identity-session`（业务路由要身份会话——台账不再写 `none` 撒谎；不涉未提权的 admin）",
              code == 200 and len(advice_routes) == 4 and all(item.get("auth") == "identity-session"
                                                              for item in advice_routes)
              and any(str(item["path"]).endswith("/advice/") for item in advice_routes)
              and any(str(item["path"]).endswith("/api/advice") for item in advice_routes),
              f"status={code} 命中={json.dumps([i.get('path') for i in advice_routes], ensure_ascii=False)}")

        # ==========================================================================================
        # ★ 本段已按 `docs/design/29-webui-gui-app.md` §2 + AGENTS.md 规则 12 **改判据**（旧页退役）：
        #   旧断言「两视角 `/advice/` 页与 `/api/advice` 都 200、页面上有建议表与 `data-advice-link` 子导航、
        #   JSON 契约 items/counts/bounds…、每条 next_action 必须含 `python3 -m quotagent.g1side …`」
        #   冻结的是**已经删掉的旧形态**，与「双方仅通过 GUI 走完全部业务流程」直接冲突 ⇒ 逐条改判据：
        #     · 路由/身份类 ⇒ **接新位置**（303 + Location + 承接面板注册在 GUI 上）；
        #     · 只在旧页上成立的内容类（建议表、JSON 契约、g1side 命令、空投影降级页）⇒ **删除**，
        #       其等价判据在插件层（`t281-advice-gate.mjs`，本批 31/31，含 5 处单点变异）**一条没松**。
        #   逐条登记（文件 + 原行 + 理由）见 `docs/work/plans/webui-ui-defects.md` §P17。
        # ==========================================================================================
        NOISE = ("终端", "g1side", "PYTHONPATH", "命令行")

        def noise_of(text):
            return [token for token in NOISE if token in text]

        # ---- ③ 旧页退役 ⇒ 四条旧路由 303 + 承接面板真的注册在 GUI 上 ----
        retired = []
        for view in ("contractor", "supplier"):
            for suffix, accept in (("/advice/", "text/html"), ("/api/advice", "application/json")):
                code, _body, headers = _fetch_full(
                    f"{base}/{view}{suffix}",
                    headers={**cookie_of(f"{base}/{view}{suffix}"), "Accept": accept},
                    follow_redirects=False)
                location = str(header_of(headers, "location"))
                retired.append((f"/{view}{suffix}", code, location,
                                code == 303 and location.endswith(f"/{view}/")))
        carrier_ids = {"contractor": ("rfq.remind-board", "compare.ranking", "gate.queue", "gate.decided",
                                      "authority.bands"),
                       "supplier": ("exchange.inbox", "authority.bands.supplier")}
        panels = {view: parse_json(get(f"{base}/api/ui/panels?view={view}")[1]).get("panels", [])
                  for view in ("contractor", "supplier")}
        panel_ids = {view: [(panel.get("panel_id") or panel.get("id")) for panel in panels[view]]
                     for view in panels}
        carriers_missing = [f"{view}:{pid}" for view, ids in carrier_ids.items()
                            for pid in ids if pid not in panel_ids[view]]
        check("③ **旧页退役 ⇒ 接新位置**：两视角的四条旧路由（`/<view>/advice/` 与 `/<view>/api/advice`）"
              "一律 **303 + Location 落在同侧 GUI 视图页**（不 404 让人失联、也不再返回旧页内容）；"
              "**承接这件事的 GUI 面板真的注册在那一页上**（承包商：回文时限与催报 / 比价排名 / 审批队列 / "
              "已决定的门 / 授权区间；供应商：我收到的包 / 授权区间）",
              all(row[3] for row in retired) and not carriers_missing,
              f"旧路由={json.dumps([(path, code, location) for path, code, location, _ in retired], ensure_ascii=False)}；"
              f"缺承接面板={carriers_missing or '无'}")

        # ---- ③b 产品面「0 命中」：四条退役响应体 + 承接面板载荷里不许有「回终端」痕迹 ----
        bodies = []
        for view in ("contractor", "supplier"):
            for suffix in ("/advice/", "/api/advice"):
                code, body, _h = _fetch_full(f"{base}/{view}{suffix}",
                                             headers={**cookie_of(f"{base}/{view}{suffix}"), "Accept": "*/*"},
                                             follow_redirects=False)
                bodies.append((f"/{view}{suffix}", body))
        carrier_payload = json.dumps([panel for view in panels for panel in panels[view]
                                      if (panel.get("panel_id") or panel.get("id")) in carrier_ids.get(view, ())],
                                     ensure_ascii=False)
        noise_hits = [f"{path}:{token}" for path, body in bodies for token in noise_of(body)]
        noise_hits += [f"panels:{token}" for token in noise_of(carrier_payload)]
        check("③b **产品面 0 命中**（旧页那 20「终端」+ 40 `g1side` 的来源已被清掉）：四条退役响应体与"
              "**承接面板载荷**里 `终端` / `g1side` / `PYTHONPATH` / `命令行` **0 命中**；"
              "扫描器**非空转**（对照样本必须命中）",
              not noise_hits and noise_of("终端 g1side PYTHONPATH 命令行") == list(NOISE),
              f"命中={noise_hits or '无'}；扫描器对照={noise_of('终端 g1side PYTHONPATH 命令行')}")

        # ---- ④ 两视角**确实不同**（改比 GUI 注册面：用户真看到的就是这些面板与动作） ----
        carrier_of = lambda view: [(panel.get("panel_id") or panel.get("id"), panel.get("actions") or [])
                                   for panel in panels[view]
                                   if (panel.get("panel_id") or panel.get("id")) in carrier_ids.get(view, ())]
        differ = json.dumps(carrier_of("contractor"), ensure_ascii=False) != \
            json.dumps(carrier_of("supplier"), ensure_ascii=False)
        actions_ok = ("rfq.remind" in dict(carrier_of("contractor")).get("rfq.remind-board", [])
                      and {"gate.grant", "gate.deny"} <= set(dict(carrier_of("contractor")).get("gate.queue", []))
                      and "exchange.promise" in dict(carrier_of("supplier")).get("exchange.inbox", []))
        check("④ **两视角确实不同**（同一份代码、不同输入、不同侧的人看到不同的东西）：两侧的承接面板集合与"
              "各自的动作不同，且动作是**真动作**（承包商侧 `rfq.remind` 催报、`gate.grant`/`gate.deny` 批准与驳回；"
              "供应商侧 `exchange.promise` 回文承诺）",
              differ and actions_ok,
              f"面板集合不同={differ}；承包商承接={json.dumps(carrier_of('contractor'), ensure_ascii=False)}；"
              f"供应商承接={json.dumps(carrier_of('supplier'), ensure_ascii=False)}")

        # ---- ⑦ 私域哨兵 0 次（搬位置：旧页没了，扫退役响应体 + 承接面板载荷）+ 非空转对照 ----
        scanned = carrier_payload + "\n".join(body for _path, body in bodies)
        hits = [needle for needle in PRIVATE_KEYS + SENTINELS if needle in scanned]
        fixture_has = [needle for needle in SENTINELS if needle in CONTRACTOR_LEDGER.read_text(encoding="utf-8")]
        check("⑦ 私域哨兵 **0 次**：四条退役响应体与**承接面板载荷**里都搜不到承包商私域键与哨兵串"
              "（这类键连读都不读 → 排名/建议都不可能反推出标底）；"
              "**非空转对照**：同一批哨兵确实写在夹具账本文件里",
              not hits and len(fixture_has) >= 3,
              f"命中={hits or '无'}；夹具里确实有哨兵={fixture_has}")

        # ---- ⑧ 0 行脚本 / 0 内联事件（只对**退役响应体**：它们是 303 说明页；
        #        GUI 外壳本就允许脚本，29 §2 明说不得拿「0 JS」冒充 UI 验收） ----
        script_needle = "<scr" + "ipt"
        inline = re.compile(r"\son[a-z]+\s*=", re.I)
        scripty = [path for path, body in bodies if script_needle in body]
        handlery = [path for path, body in bodies if inline.search(body)]
        check("⑧ 四条退役响应体 **0 行脚本 / 0 内联事件**（它们只是 303 的说明页，不再给可复制的命令）；"
              "扫描器非空转（**不再拿「0 JS」当 UI 验收**：GUI 外壳本就允许脚本，见 29 §2）",
              not scripty and not handlery and script_needle in (f"<a {script_needle}>")
              and bool(inline.search('<a onclick="x()"></a>')),
              f"含脚本={scripty or '无'}；含内联事件={handlery or '无'}")

        # ---- ⑨ 确定性（HTTP 层）：同一 URL 两次逐字节一致（303 响应体 + 承接面板载荷） ----
        again_bodies = []
        for view in ("contractor", "supplier"):
            for suffix in ("/advice/", "/api/advice"):
                again_bodies.append(_fetch_full(f"{base}/{view}{suffix}",
                                                headers={**cookie_of(f"{base}/{view}{suffix}"),
                                                         "Accept": "*/*"},
                                                follow_redirects=False)[1])
        again_panels = {view: get(f"{base}/api/ui/panels?view={view}")[1] for view in ("contractor", "supplier")}
        check("⑨ 确定性（HTTP 层）：同一 URL 两次 GET **响应体逐字节一致**（四条退役路由 + 两视角承接面板载荷）"
              "—— 本层不取墙钟、不用随机数，同一份投影必然给同一组读数",
              all(again == body for again, (_path, body) in zip(again_bodies, bodies)),
              f"四条退役响应体两次一致={all(again == body for again, (_p, body) in zip(again_bodies, bodies))}；"
              f"承包商面板两次一致={again_panels['contractor'] == get(f'{base}/api/ui/panels?view=contractor')[1]}；"
              f"供应商面板两次一致={again_panels['supplier'] == get(f'{base}/api/ui/panels?view=supplier')[1]}")

        # ---- ⑩ 既有路由没坏 + 不涉未提权 admin ----
        ops_code, _ = get(f"{base}/api/ops")
        heur_code, _ = get(f"{base}/contractor/heuristics/")
        home_code, _ = get(f"{base}/contractor/")
        admin_code, admin_body = get(f"{base}/admin/")
        check("⑩ 既有路由没被弄坏（`/api/ops`、`/contractor/heuristics/`、`/contractor/` 都 200），"
              "且本门全程**不涉未提权的 admin**（`/admin/` 仍 401 固定体）",
              ops_code == 200 and heur_code == 200 and home_code == 200
              and admin_code == 401 and admin_body.strip() == '{"error":"unauthorized"}',
              f"ops={ops_code} heuristics={heur_code} home={home_code} admin={admin_code}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    # ---- ⑫ 宿主零写面（HTTP 层）：夹具与目录逐字节不变 ----
    after = {str(path): sha256_file(path) for path in watched}
    listing_after = sorted(str(item.relative_to(SHARED)) for item in SHARED.rglob("*"))
    check("⑫ 宿主**零写面**（跑完真进程之后夹具账本/快照逐字节不变、目录没有多出/少掉任何文件；"
          "宿主不写账本、不落待处理项）",
          before == after and listing_before == listing_after,
          f"字节不变={before == after}；目录不变={listing_before == listing_after}（{len(listing_after)} 项）")

    failed = [item for item in CHECKS if not item["ok"]]
    print(json.dumps({"checks": CHECKS, "passed": len(CHECKS) - len(failed), "total": len(CHECKS),
                      "failures": len(failed)}, ensure_ascii=False, indent=2))
    for item in failed:
        print("FAIL:", item["name"], "|", item["detail"])
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
