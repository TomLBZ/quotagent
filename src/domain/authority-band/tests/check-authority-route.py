#!/usr/bin/env python3
"""check-authority-route —— **「授权区间」的真 HTTP 端到端**（`tools/verify.sh authority` 的后半）。

真做十二件事（全部走**真进程 + 真路由 + 真回读**，不是"看着像接上了"）：

  ① 造夹具：**临时受管配置文件**（`project:` 段里写 `authority.*` 区间；哨兵写在**别的已登记键**上）、
     两份真哈希链账本、临时 `ui-shared`；并记下**真** `/workspace/config.yaml` 的 sha256（本门只读它）；
  ② 起真 `cli.mjs webui` 进程（随机端口、私有前缀 `/qa`、`--config-file` 指向**临时**夹具 —— 不碰真配置）；
  ③ 两视角 `GET <prefix>/<view>/authority/?amount=..&role=..` 与 `<prefix>/<view>/api/authority?..` 四条都 200，
     页面是真页面（`data-authority-*` 抓手 + 道内子导航入口 + 回首页链接）；`/api/routes` 登记四条且 `auth=none`；
  ④ **三例边界值**（恰等于限额 / 超一分 / 差一分）逐条与**本脚本自己手算的**整数分对照（页面与 JSON 两个面）；
  ⑤ **未配置不得编限额**：把临时夹具**移走**（配置读不到）⇒ 同一 URL 变成 `unconfigured=true` +
     `band-unconfigured` + `required_role`/`next_role` 空 + `bands` 空 + 页面出「未配置」块；逐字节还原后
     同一 URL 又回到「在区间内」（证明降级来自「配置读不到」，不是页面坏了）；
  ⑥ **改配置前后同一金额结论不同**：把临时夹具里的 buyer 限额 500000 → 500001 ⇒ 同一个金额 500001 从
     「越界」翻成「在区间内」；且**真 `/workspace/config.yaml` 前后 sha256 逐字一致**（本门不动它）；
  ⑦ 金额非法**三类**（负数 / 非整数 / 超上限）⇒ 具体 `code` + 非空 `next_action` + **不给结论**；
     **非空转对照**：同批合法金额照旧给结论；
  ⑧ **越界必出升级命令且命令真存在**：`escalate_cmd` 以 `tools/verify.sh <门名>` 开头且该门名**真的**出现在
     `tools/verify.sh help` 的输出里；人工签署命令指向 `src/quotagent/g1side.py`（文件真存在）；
  ⑨ **私域哨兵零泄漏**：夹具配置里**确实**写着哨兵（非 `authority.*` 的键），四份响应里 0 命中 + 私域键名 0 命中；
  ⑩ **只读**：GET 前后两份夹具账本**逐字节不变**；同一 URL 两次 GET **逐字节一致**（确定性）；
  ⑪ 四份响应 **0 行 `<script>` / 0 内联事件**（扫描器非空转）；两侧首页与运维页的子导航含 `data-authority-link`；
  ⑫ 既有路由没被弄坏（两侧首页 200 / `/api/ops` 200 / 未提权 `/admin/` 仍 **401 固定体**）。

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
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.ledger import Ledger  # noqa: E402

CHECKS: list[dict] = []
SCRIPT_NEEDLE = "<scr" + "ipt"
INLINE_EVENT = re.compile(r"\son[a-z]+\s*=", re.I)
REAL_CONFIG = Path("/workspace/config.yaml")
VERIFY_SH = ROOT / "tools" / "verify.sh"
G1SIDE = ROOT / "src" / "quotagent" / "g1side.py"
FIXED_BODY = '{"error":"unauthorized"}'

# 哨兵写在**别的已登记键**上（它们会出现在配置总览里，但**不得**出现在授权区间响应里）
SENTINELS = ["AUTH-SENTINEL-8f31", "PRIVATE-NOTE-SENTINEL-7f", "987654321"]
PRIVATE_KEYS = ["cost_floor", "markup_pct", "reserve_price", "cost_model", "private:"]

SHARED = ROOT / "tmp" / "authority-route"
UI_SHARED = SHARED / "ui-shared"
CONFIG_FIXTURE = SHARED / "config.yaml"
CONFIG_STASH = SHARED / "config.yaml.bak"
CONTRACTOR_LEDGER = SHARED / "contractor" / "ledger.jsonl"
SUPPLIER_LEDGER = SHARED / "supplier" / "ledger.jsonl"

# ---------------------------------------------------------------------------
# **手算表**（先把数字算出来再写进断言：写错本脚本就红；**绝不拿响应当期望**）
#   区间登记（整数分）：buyer = 500000（5000.00 元）、lead = 2000000、director = 10000000
#   三例边界（同一角色 buyer、同一份登记）：
#     ① 恰等于限额 500000 ⇒ 在区间内、越界 0 分、需 buyer 批、下一个能批的人 lead、**无**升级命令
#     ② 超一分     500001 ⇒ 越界 1 分（= 500001 − 500000）、需 lead 批、下一个 lead、**有**升级命令
#     ③ 差一分     499999 ⇒ 在区间内、越界 0 分、需 buyer 批、下一个 lead、**无**升级命令
#   within（覆盖本金额的角色，限额升序；remaining = 限额 − 金额）：
#     500001 ⇒ lead（剩 1499999）、director（剩 9499999）
#   另注：夹具里的金额一律**整数分**；宿主与插件都不做元/分折算（那是人自己声明单位的事）。
# ---------------------------------------------------------------------------
BANDS = {"buyer": 500000, "lead": 2000000, "director": 10000000}
AMOUNT_MAX = 1000000000000
BOUNDARY = [
    {"label": "①恰等于限额", "role": "buyer", "amount": 500000, "inside": True, "required": "buyer",
     "next": "lead", "esc": False},
    {"label": "②超一分", "role": "buyer", "amount": 500001, "inside": False, "required": "lead",
     "next": "lead", "esc": True},
    {"label": "③差一分", "role": "buyer", "amount": 499999, "inside": True, "required": "buyer",
     "next": "lead", "esc": False},
]
HAND_WITHIN = {500001: [("lead", 2000000, 1499999), ("director", 10000000, 9499999)]}
BAD_AMOUNTS = [("-1", "amount-negative"), ("500000.5", "amount-not-an-integer"),
               (str(AMOUNT_MAX + 1), "amount-out-of-range")]


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str | None:
    try:
        return sha256_bytes(path.read_bytes())
    except OSError:
        return None


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
        payload = urllib.parse.urlencode({"name": f"gate-authority-{side}", "side": side}).encode("utf-8")
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


def hand_over(role: str, amount: int) -> int:
    """本脚本自己的"越界多少"：`max(0, 金额 − 该角色限额)`。"""
    return max(0, amount - BANDS[role])


def hand_within(amount: int) -> list[tuple[str, int, int]]:
    """本脚本自己的"谁能批到多少"：覆盖本金额的角色（限额升序），剩 = 限额 − 金额。"""
    rows = [(role, limit) for role, limit in BANDS.items() if limit >= amount]
    rows.sort(key=lambda item: (item[1], item[0]))
    return [(role, limit, limit - amount) for role, limit in rows]


def config_text(buyer_limit: int) -> str:
    return "\n".join([
        "project:",
        "  authority.unit: cents",
        "  authority.currency: CNY",
        f"  authority.bands.buyer: {buyer_limit}",
        "  authority.bands.lead: 2000000",
        "  authority.bands.director: 10000000",
        "  authority.fallback_role: director",
        "  authority.escalation_note: '越界请找业主代表走终端人工门'",
        # 哨兵：写在**别的已登记键**上（会进配置总览，但**不得**进授权区间响应）
        f"  transport.dir: '{SENTINELS[0]}'",
        f"  pricing.markup_pct: {SENTINELS[2]}",
        "",
    ])


def write_fixtures() -> dict:
    report = {}
    shutil.rmtree(SHARED, ignore_errors=True)
    UI_SHARED.mkdir(parents=True, exist_ok=True)
    CONFIG_FIXTURE.write_text(config_text(500000), encoding="utf-8")
    os.chmod(CONFIG_FIXTURE, 0o600)
    for path, realm in ((CONTRACTOR_LEDGER, "contractor:con-B"), (SUPPLIER_LEDGER, "supplier:sup-1")):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)
        ledger = Ledger(path, realm=realm)
        ledger.append("rfq/published", {"package_id": "pkg-015", "rev": 1},
                      correlation_id="pkg-015", ts="2026-09-21T15:00:00Z", actor="agent:fixture")
        report[path.name] = ledger.count
    report["healthy"] = bool(Ledger(CONTRACTOR_LEDGER, realm="contractor:con-B").verify_report()["ok"])
    return report


def serve(port: int, prefix: str) -> subprocess.Popen:
    """真进程：**受管配置文件指向临时夹具**（`--config-file`），绝不读写真 `/workspace/config.yaml`。"""
    return subprocess.Popen(
        ["node", str(ROOT / "host" / "cli.mjs"), "webui", "--profile", "webui", "--port", str(port),
         "--host", "127.0.0.1", "--prefix", prefix, "--ui-shared", str(UI_SHARED),
         "--config-file", str(CONFIG_FIXTURE),
         "--ledger-contractor", str(CONTRACTOR_LEDGER), "--ledger-supplier", str(SUPPLIER_LEDGER)],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        env={key: value for key, value in os.environ.items()
             if not key.startswith("QUOTAGENT_CONFIG_") and key != "QUOTAGENT_ADMIN_TOKEN"})


def wait_up(base: str, proc: subprocess.Popen) -> bool:
    for _ in range(40):
        code, _body = get(f"{base}/api/health")
        if code == 200:
            return True
        if proc.poll() is not None:
            return False
        time.sleep(0.5)
    return False


def help_gates() -> str:
    """真跑 `tools/verify.sh help`：升级命令里的门名必须真的在那份输出里。"""
    try:
        proc = subprocess.run(["sh", str(VERIFY_SH), "help"], capture_output=True, text=True, timeout=60)
        return proc.stdout or ""
    except (OSError, subprocess.SubprocessError):
        return ""


def main() -> int:  # noqa: C901
    global BASE
    real_before = sha256_file(REAL_CONFIG)
    fixture = write_fixtures()
    fixture_has = [needle for needle in SENTINELS if needle in CONFIG_FIXTURE.read_text(encoding="utf-8")]
    check("① 夹具就绪：临时受管配置（`project:` 段里 buyer/lead/director 三档 + 单位/币种/兜底角色/升级说明）"
          "+ 两份**真哈希链**账本 + 哨兵写在**别的已登记键**上（非 `authority.*`）",
          fixture["healthy"] and len(fixture_has) >= 2 and "authority.bands.buyer: 500000" in CONFIG_FIXTURE.read_text(encoding="utf-8")
          and REAL_CONFIG.suffix == ".yaml",
          f"账本链自洽={fixture['healthy']}；夹具哨兵={fixture_has}；真配置={REAL_CONFIG} sha256="
          f"{None if real_before is None else real_before[:12]}…")

    ledger_before = sha256_file(CONTRACTOR_LEDGER)
    supplier_before = sha256_file(SUPPLIER_LEDGER)
    port, prefix = free_port(), "/qa"
    proc = serve(port, prefix)
    base = f"http://127.0.0.1:{port}{prefix}"
    BASE = base
    try:
        up = wait_up(base, proc)
        check("② 真进程就绪（`cli.mjs webui --config-file <临时夹具>` + `/api/health` 200；看区间**不需要**管理员身份）",
              up, f"port={port} prefix={prefix} pid={proc.pid} config_file={CONFIG_FIXTURE}")
        if not up:
            return 2

        # ---- ②b 身份门槛（P3 的判据本身也要机检；下面所有业务路由都**登录后再取**）----
        anon_json_code, anon_json_body, _h = _fetch_full(
            f"{base}/contractor/api/authority", headers={"Accept": "application/json"})
        anon_html_code, _b, anon_html_headers = _fetch_full(
            f"{base}/supplier/authority/", headers={"Accept": "text/html"}, follow_redirects=False)
        cookie_contractor = cookie_of(f"{base}/contractor/authority/")
        cookie_supplier = cookie_of(f"{base}/supplier/authority/")     # noqa: F841（两侧各登录一次）
        same_side = _fetch_full(f"{base}/contractor/authority/", headers=cookie_contractor)
        cross_side = _fetch_full(f"{base}/supplier/authority/", headers=cookie_contractor)
        cross_json = _fetch_full(f"{base}/supplier/api/authority", headers=cookie_contractor)
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
        authority_routes = [item for item in routes if "/authority" in str(item.get("path", ""))]
        pages = {view: get(f"{base}/{view}/authority/?amount=500001&role=buyer") for view in ("contractor", "supplier")}
        jsons = {view: get(f"{base}/{view}/api/authority?amount=500001&role=buyer") for view in ("contractor", "supplier")}
        parsed = {view: parse_json(jsons[view][1]) for view in jsons}
        page_contract = all(text in pages[view][1] for view in pages for text in (
            'data-authority="result"', 'data-authority-status=', 'data-authority-unit="cents"',
            'data-authority-engine="rules"', 'data-authority-can-approve="false"', 'data-authority-bands="1"',
            'data-authority-escalate="1"', 'data-authority-config-where="1"',
            f'data-subnav="{view}"', 'data-authority-link="1"', 'data-authority-back="1"'))
        check("③ 两视角区间页/JSON 四条都 **200**；`/api/routes` 登记四条新路由且 `auth=none`；页面是真页面"
              "（结论抓手 + 口径 + 区间表 + 越界升级块 + 「在哪里配」+ 道内子导航入口 + 回首页链接）",
              len(authority_routes) == 4 and all(item.get("auth") == "none" for item in authority_routes)
              and all(item.get("method") == "GET" for item in authority_routes)
              and all(pages[view][0] == 200 and jsons[view][0] == 200 for view in pages) and page_contract,
              f"路由={[f'{i.get('method')} {i.get('path')} {i.get('auth')}' for i in authority_routes]}；"
              f"status={[pages['contractor'][0], jsons['contractor'][0], pages['supplier'][0], jsons['supplier'][0]]}；"
              f"页面契约={page_contract}")

        # ---- ④ 三例边界值（页面与 JSON 两面，全部与本脚本手算对照）----
        boundary_rows = []
        boundary_ok = True
        for case in BOUNDARY:
            want_over = hand_over(case["role"], case["amount"])
            want_within = hand_within(case["amount"])
            payload = parse_json(get(f"{base}/contractor/api/authority?amount={case['amount']}&role={case['role']}")[1])
            page = get(f"{base}/contractor/authority/?amount={case['amount']}&role={case['role']}")[1]
            got_within = [(item.get("role"), item.get("limit_cents"), item.get("remaining_cents")) for item in
                          (payload.get("within") or [])]
            ok = (payload.get("inside_band") is case["inside"] and payload.get("over_by") == want_over
                  and payload.get("required_role") == case["required"] and payload.get("next_role") == case["next"]
                  and bool(payload.get("escalate_cmd")) is case["esc"]
                  and payload.get("unconfigured") is False and payload.get("can_approve") is False
                  and got_within == want_within
                  and f'data-authority-inside="{str(case["inside"]).lower()}"' in page
                  and f'data-authority-over-by="{want_over}"' in page
                  and f'data-authority-required-role="{case["required"]}"' in page
                  and f'data-authority-next-role="{case["next"]}"' in page
                  and (('data-authority-escalate="1"' in page) is case["esc"]))
            boundary_rows.append(
                f'{case["label"]}（{case["role"]} 限额 {BANDS[case["role"]]} 分、金额 {case["amount"]} 分）手算：'
                f'在区间内={case["inside"]} 越界 {want_over} 分 需 {case["required"]} / 下一个 {case["next"]} / '
                f'升级命令 {"有" if case["esc"] else "无"}；实得：在区间内={payload.get("inside_band")} '
                f'越界 {payload.get("over_by")} 分 需 {payload.get("required_role") or "（空）"} / '
                f'下一个 {payload.get("next_role") or "（空）"} / 命令 {"有" if payload.get("escalate_cmd") else "无"}'
                f'；within={got_within}（手算 {want_within}）；页面抓手一致={f'data-authority-next-role="{case["next"]}"' in page}'
                f' ｜{"一致" if ok else "**不一致**"}')
            boundary_ok = boundary_ok and ok
        check("④ **三例边界值逐条对账**（本门最核心的一条）：恰等于限额（500000/500000）／超一分（500001）／"
              "差一分（499999）三例的 `inside_band`/`over_by`/`required_role`/`next_role`/有无升级命令/"
              "`within`（含 `remaining_cents`）**全部等于本脚本手算值**，且页面抓手与 JSON 同口径",
              boundary_ok, "；".join(boundary_rows))

        # ---- ⑤ 未配置不得编限额（真 HTTP：把夹具移走）----
        before_move = get(f"{base}/supplier/api/authority?amount=500001&role=buyer")
        CONFIG_FIXTURE.rename(CONFIG_STASH)
        missing_json = parse_json(get(f"{base}/supplier/api/authority?amount=500001&role=buyer")[1])
        missing_page = get(f"{base}/supplier/authority/?amount=500001&role=buyer")[1]
        CONFIG_FIXTURE.write_bytes(CONFIG_STASH.read_bytes())
        CONFIG_STASH.unlink()
        restored = get(f"{base}/supplier/api/authority?amount=500001&role=buyer")
        restored_json = parse_json(restored[1])
        check("⑤ **未配置不得编限额**（真 HTTP）：把临时夹具移走（配置读不到）⇒ 同一 URL 变成 "
              "`unconfigured=true` + 有名 `reason=band-unconfigured` + `required_role`/`next_role` 空 + "
              "`bands` 空 + `inside_band=null` + 无升级命令 + 页面出「未配置」块；**逐字节还原**后同一 URL "
              "又回到与移走前**逐字节一致**的结论（证明降级来自「配置读不到」，不是页面坏了）",
              missing_json.get("unconfigured") is True and missing_json.get("reason") == "band-unconfigured"
              and missing_json.get("required_role") == "" and missing_json.get("next_role") == ""
              and missing_json.get("bands") == [] and missing_json.get("inside_band") is None
              and missing_json.get("escalate_cmd") == "" and 'data-authority-unconfigured-note="1"' in missing_page
              and "不编限额" in missing_page
              and restored[1] == before_move[1] and restored_json.get("unconfigured") is False
              and restored_json.get("inside_band") is False and restored_json.get("over_by") == 1,
              f"移走夹具 ⇒ unconfigured={missing_json.get('unconfigured')}/reason={missing_json.get('reason')}/"
              f"bands={missing_json.get('bands')}/required='{missing_json.get('required_role')}'/"
              f"next='{missing_json.get('next_role')}'；还原后与移走前逐字节一致="
              f"{restored[1] == before_move[1]}（在区间内={restored_json.get('inside_band')}/越界 {restored_json.get('over_by')} 分）")

        # ---- ⑥ 改配置前后同一金额结论不同 + 真配置指纹不变 ----
        before_edit = parse_json(get(f"{base}/contractor/api/authority?amount=500001&role=buyer")[1])
        CONFIG_FIXTURE.write_text(config_text(500001), encoding="utf-8")
        os.chmod(CONFIG_FIXTURE, 0o600)
        after_edit = parse_json(get(f"{base}/contractor/api/authority?amount=500001&role=buyer")[1])
        real_after = sha256_file(REAL_CONFIG)
        check("⑥ **改配置前后同一金额结论不同**：临时夹具里 buyer 限额 500000 → 500001 ⇒ 同一个金额 500001 "
              "从「越界」翻成「在区间内」（同一进程、同一 URL ⇒ 配置是真读的）；"
              "**真 `/workspace/config.yaml` 前后 sha256 逐字一致**（本门只读它）",
              before_edit.get("inside_band") is False and before_edit.get("over_by") == 1
              and after_edit.get("inside_band") is True and after_edit.get("over_by") == 0
              and after_edit.get("escalate_cmd") == "" and real_after == real_before,
              f"改前 500001 ⇒ 在区间内={before_edit.get('inside_band')}/越界 {before_edit.get('over_by')}；"
              f"改后同金额 ⇒ 在区间内={after_edit.get('inside_band')}/越界 {after_edit.get('over_by')}；"
              f"真配置 sha256 前={None if real_before is None else real_before[:12]}… "
              f"后={None if real_after is None else real_after[:12]}…（一致={real_after == real_before}）")

        # ---- ⑦ 金额非法三类 + 非空转对照 ----
        bad_rows = []
        bad_ok = True
        for text, code in BAD_AMOUNTS:
            payload = parse_json(get(f"{base}/contractor/api/authority?amount={text}&role=buyer")[1])
            ok = (payload.get("code") == code and payload.get("reason") == code
                  and isinstance(payload.get("next_action"), str) and len(payload.get("next_action") or "") > 10
                  and payload.get("inside_band") is None and payload.get("escalate_cmd") == ""
                  and payload.get("required_role") == "" and payload.get("next_role") == "")
            bad_rows.append(f"amount={text} ⇒ code={payload.get('code')}（期望 {code}）/inside_band={payload.get('inside_band')}"
                            f"/next_action {len(payload.get('next_action') or '')} 字｜{'一致' if ok else '**不一致**'}")
            bad_ok = bad_ok and ok
        good_probe = parse_json(get(f"{base}/contractor/api/authority?amount=500000&role=buyer")[1])
        check("⑦ 金额非法**三类**（负数 / 非整数 / 超上限）各自给**具体 code** + 非空 `next_action` + "
              "**不给结论**（`inside_band=null`、无升级命令、角色字段空）；**非空转对照**：同批合法金额"
              "（500000 分）照旧给结论（在区间内）",
              bad_ok and good_probe.get("inside_band") is True and good_probe.get("code") == "",
              "；".join(bad_rows) + f"；对照 500000 ⇒ inside_band={good_probe.get('inside_band')}/code={good_probe.get('code')!r}")

        # ---- ⑧ 越界必出升级命令 + 命令真存在 ----
        help_out = help_gates()
        # 用**两种夹具下都是越界**的金额（2000001 > buyer 限额、也 > lead 限额）⇒ 与前面"改配置"步骤无关
        over_payload = parse_json(get(f"{base}/contractor/api/authority?amount=2000001&role=buyer")[1])
        escalate = str(over_payload.get("escalate_cmd") or "")
        gate_name = escalate.replace("tools/verify.sh ", "").split()[0] if escalate.startswith("tools/verify.sh ") else ""
        check("⑧ **越界必出升级命令、且命令真存在**：越界 ⇒ `escalate_cmd` 以 `tools/verify.sh <门名>` 开头，"
              "该门名**真的出现在** `tools/verify.sh help` 的输出里（本门真跑那个命令）；人工签署命令指向 "
              "`quotagent.g1side` 且 `src/quotagent/g1side.py` 真存在；`blocked_by=human-gate-required`",
              bool(gate_name) and gate_name in help_out and G1SIDE.exists()
              and "quotagent.g1side" in str(over_payload.get("escalate_human_cmd") or "")
              and over_payload.get("blocked_by") == "human-gate-required"
              and "不能" in str(over_payload.get("approval_note") or "")
              and "批准" in str(over_payload.get("approval_note") or ""),
              f"越界命令={escalate!r}（门名={gate_name} 在 help 里={gate_name in help_out}）；"
              f"人工签署={over_payload.get('escalate_human_cmd')!r}；g1side.py 存在={G1SIDE.exists()}；"
              f"blocked_by={over_payload.get('blocked_by')}")

        # ---- ⑨ 私域哨兵零泄漏 ----
        config_text_now = CONFIG_FIXTURE.read_text(encoding="utf-8")
        fixture_sentinels = [needle for needle in SENTINELS if needle in config_text_now]
        responses = {"page:c": pages["contractor"][1], "page:s": pages["supplier"][1],
                     "json:c": jsons["contractor"][1], "json:s": jsons["supplier"][1],
                     "missing:json": json.dumps(missing_json, ensure_ascii=False)}
        hits = [needle for name, text in responses.items() for needle in SENTINELS if needle in text]
        key_hits = [needle for name, text in responses.items() for needle in PRIVATE_KEYS if needle in text]
        check("⑨ **私域哨兵零泄漏**：夹具配置里**确实**写着哨兵（非 `authority.*` 的已登记键），"
              "四份响应 + 未配置响应里哨兵与私域键名 **0 命中**（不是「藏起来」：宿主只把 `authority.*` "
              "那些行交给插件，其它键连值都不读）",
              len(fixture_sentinels) >= 2 and not hits and not key_hits,
              f"夹具哨兵={fixture_sentinels}；响应命中={hits or '无'}；私域键名命中={key_hits or '无'}")

        # ---- ⑩ 只读 + 确定性 ----
        again = get(f"{base}/contractor/api/authority?amount=500001&role=buyer")
        again_page = get(f"{base}/contractor/authority/?amount=500001&role=buyer")
        check("⑩ 区间路由是**只读**的：GET 前后两份夹具账本**逐字节不变**（账本零新增）；"
              "同一 URL 两次 GET **逐字节一致**（不随刷新漂移：不取墙钟、不读随机）",
              sha256_file(CONTRACTOR_LEDGER) == ledger_before and sha256_file(SUPPLIER_LEDGER) == supplier_before
              and again[1] == get(f"{base}/contractor/api/authority?amount=500001&role=buyer")[1]
              and again_page[1] == get(f"{base}/contractor/authority/?amount=500001&role=buyer")[1],
              f"承包商账本未变={sha256_file(CONTRACTOR_LEDGER) == ledger_before}；"
              f"供应商账本未变={sha256_file(SUPPLIER_LEDGER) == supplier_before}；"
              f"JSON 两次一致={again[1] == get(f'{base}/contractor/api/authority?amount=500001&role=buyer')[1]}；"
              f"页面两次一致={again_page[1] == get(f'{base}/contractor/authority/?amount=500001&role=buyer')[1]}")

        # ---- ⑪ 0 脚本 / 0 内联事件 + 三页子导航入口 ----
        scripty = [name for name, text in responses.items() if SCRIPT_NEEDLE in text or INLINE_EVENT.search(text)]
        self_test = (SCRIPT_NEEDLE in f"<a {SCRIPT_NEEDLE}>") or bool(INLINE_EVENT.search('<a onclick="x()">'))
        ops_page = get(f"{base}/ops/")[1]
        nav_ok = all('data-authority-link="1"' in get(f"{base}/{view}/")[1] for view in ("contractor", "supplier")) \
            and 'data-authority-link="1"' in ops_page
        check("⑪ 五份响应 **0 行 `<script>` / 0 内联事件**（扫描器**非空转**：对照样本必须命中）；"
              "承包商/供应商/运维**三个道**的真实页面子导航里都有 `data-authority-link` 入口"
              "（第四道 admin 的入口由围栏门 t284 在提权后验）",
              not scripty and self_test and nav_ok,
              f"含脚本/内联事件={scripty or '无'}；对照={self_test}；三页入口={nav_ok}")

        # ---- ⑫ 既有路由没被弄坏 ----
        admin_code, admin_body = get(f"{base}/admin/")
        home_c, _ = get(f"{base}/contractor/")
        home_s, _ = get(f"{base}/supplier/")
        ops_code, _ = get(f"{base}/api/ops")
        health_code, _ = get(f"{base}/api/health")
        check("⑫ 既有路由没被弄坏：两侧首页 200 / `/api/ops` 200 / `/api/health` 200 / 未提权 `/admin/` 仍 "
              "**401 固定体**（同形，无 oracle）",
              home_c == 200 and home_s == 200 and ops_code == 200 and health_code == 200
              and admin_code == 401 and admin_body.strip() == FIXED_BODY,
              f"home={home_c}/{home_s} ops={ops_code} health={health_code} admin={admin_code} body={admin_body.strip()!r}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    failed = [item for item in CHECKS if not item["ok"]]
    print(json.dumps({"checks": CHECKS, "passed": len(CHECKS) - len(failed), "total": len(CHECKS),
                      "failures": len(failed), "fixture_dir": str(SHARED),
                      "real_config_sha256_before": real_before,
                      "real_config_sha256_after": sha256_file(REAL_CONFIG),
                      "sentinel_used": SENTINELS[0]}, ensure_ascii=False, indent=2))
    for item in failed:
        print("FAIL:", item["name"], "|", item["detail"])
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
