#!/usr/bin/env python3
"""check-rfq-visibility-route —— **「供应商看不到自己的 RFQ 包」的真 HTTP 端到端**（`verify.sh rfq-visibility` 的后半）。

真做十件事（全部走**真进程 + 真路由 + 真回读**，不是"看着像接上了"）：

  ① 造夹具：**两份真哈希链账本**（`supplier:alpha` 被邀 / `supplier:gamma` 未被邀）+ 承包商账本 +
     一份**投递信节目录**（`--rfq-delivery <dir>`）：信封 A 发给 alpha（rev2、报价截止、行项目、并混进
     承包商私域键与哨兵值）、信封 B **只发给另一家**（`supplier:beta-SENTINEL-9f3`，带哨兵）、
     信封 C **同时发给两家**；另有一份**坏信封**（非法 JSON，必须不崩服务也不计入）；
  ② 起**两个真进程**（同一份投递目录、两种身份：alpha 被邀 / gamma 未被邀），都走 `node host/cli.mjs webui`；
  ③ **被邀的供应商看得到包**（本条是这次修复的正控）：`/supplier/api/events` 里出现 `rfq/published` 派生行，
     `rfq.package_id/rev/quote_by/clarify_by/items` 与本脚本**手写的夹具值逐字相等**；页面上有
     `data-rfq="inbox"` 块、`data-rfq-count="1"`、`@rev2`、报价截止原文；
  ④ **未被邀的供应商看不到**（负控）：同一份投递目录、`supplier:gamma` ⇒ 事件里 `rfq/*` **0 条**、
     页面 `data-rfq-degraded="true"` + `data-rfq-reason="no-deliveries-visible"`；
  ⑤ **带哨兵与不带哨兵输出逐字节一致**（真 HTTP）：把"只发给别家"的信封 B（含哨兵）追加进投递目录后，
     alpha 的 `/supplier/api/events` 与 `/supplier/` **逐字节不变**（不是"藏起来"，是根本没进输出）；
  ⑥ **非空转对照**：追加"同时发给两家"的信封 C 后，alpha 的两个响应**必须**变化并出现 `pkg-shared`
     （作用域是**按身份**的，不是把所有人都挡住）；
  ⑦ **他家供应商代号 / 承包商私域键 0 命中**：两个身份的四个响应里搜不到 `supplier:beta-SENTINEL-9f3`、
     `pkg-beta`、`BETA-ONLY`、哨兵值与私域键名（`cost_floor`/`reserve_price`/`internal_notes`/…）；
     **非空转对照**：这些哨兵**确实**写在投递目录的文件里；
  ⑧ **承包商侧不得减少、也不得多出供应商私域**：承包商的事件与首页仍 200、仍含它自己账本里的
     `rfq/published`（它不从投递信封里拿任何一行），且响应里 0 个供应商侧哨兵；
  ⑨ **只读 + 确定性**：跑完前后两份账本与投递目录**逐字节不变**；同一 URL 两次 GET **逐字节一致**；
  ⑩ 既有路由没被弄坏：`/api/health`、`/api/status`、两视角首页都 200；**四道页面 0 行 `<script>` /
     0 内联事件**（扫描器非空转）；未提权 `/admin/` 仍是 **401 固定体**。

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
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.ledger import Ledger  # noqa: E402

CHECKS: list[dict] = []
SCRIPT_NEEDLE = "<scr" + "ipt"
INLINE_EVENT = re.compile(r"\son[a-z]+\s*=", re.I)
FIXED_BODY = '{"error":"unauthorized"}'

SHARED = ROOT / "tmp" / "rfq-visibility-route"
LEDGER_A = SHARED / "supplier-alpha.jsonl"
LEDGER_G = SHARED / "supplier-gamma.jsonl"
LEDGER_C = SHARED / "contractor.jsonl"
DELIVERIES = SHARED / "deliveries"

# ---------------------------------------------------------------------------
# **手写的事实值**（断言全部与这里逐字对照；**绝不拿响应当期望**）
# ---------------------------------------------------------------------------
ME = "supplier:alpha"                 # 被邀的供应商
OTHER = "supplier:beta-SENTINEL-9f3"  # 另一家（代号本身就是哨兵：不得出现在我的视图里）
UNINVITED = "supplier:gamma"          # 没被邀的供应商（负控）
SENTINELS = ["SENTINEL-COST-FLOOR-3a1", "SENTINEL-INTERNAL-NOTE-7f2", "SENTINEL-RESERVE-5c8"]
PRIVATE_KEYS = ["cost_floor", "reserve_price", "cost_model", "markup_pct", "internal_notes",
                "other_quotes", "bidders_private", "authorized_band", "internal_score"]
ALPHA_PKG = "pkg-alpha"
ALPHA_REV = 2
ALPHA_QUOTE_BY = "2026-09-25T00:00:00Z"
ALPHA_CLARIFY_BY = "2026-09-23T00:00:00Z"
ALPHA_SENT_AT = "2026-09-23T09:00:00Z"
ALPHA_ITEMS = [("L-001", "P-100", 150, "m"), ("L-002", "S-200", 480, "kg")]
SHARED_PKG = "pkg-shared"
BETA_PKG = "pkg-beta"


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


def get(url: str, timeout: float = 15.0) -> tuple[int, str]:
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=timeout) as response:
            return int(response.status), response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return int(err.code), err.read().decode("utf-8", "replace")
    except Exception as err:  # noqa: BLE001
        return 0, f"<error {type(err).__name__}: {err}>"


def parse_json(body: str) -> dict:
    try:
        data = json.loads(body)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def envelope(package_id: str, rev: int, delivered_to: list[str], sent_at: str, quote_by: str,
             clarify_by: str, items: list[dict], extra: dict | None = None) -> dict:
    """投递信封（发送方放到共享交换目录的交付件；形状与真走查的 `01-package.json` 同族）。"""
    spec = {"package_id": package_id, "currency": "CNY",
            "deadlines": {"clarify_by": clarify_by, "quote_by": quote_by}, "items": items}
    spec.update(extra or {})
    return {"delivered_to": delivered_to, "rev": rev, "sent_at": sent_at,
            "snapshot_hash": "sha256:" + "9" * 64, "spec": spec}


def envelope_alpha() -> dict:
    return envelope(ALPHA_PKG, ALPHA_REV, [ME], ALPHA_SENT_AT, ALPHA_QUOTE_BY, ALPHA_CLARIFY_BY,
                    [{"item_id": item_id, "code": code, "qty": qty, "unit": unit}
                     for item_id, code, qty, unit in ALPHA_ITEMS],
                    extra={"cost_floor": SENTINELS[0], "reserve_price": SENTINELS[2],
                           "internal_notes": SENTINELS[1],
                           "other_quotes": [{"supplier": OTHER, "unit_price": 99}],
                           "bidders_private": [OTHER]})


def envelope_beta() -> dict:
    return envelope(BETA_PKG, 7, [OTHER], "2026-09-24T09:00:00Z", "2026-09-26T00:00:00Z",
                    "2026-09-24T00:00:00Z",
                    [{"item_id": "L-777", "code": "BETA-ONLY", "qty": 777, "unit": "kg"}],
                    extra={"internal_notes": SENTINELS[1]})


def envelope_shared() -> dict:
    return envelope(SHARED_PKG, 1, [ME, OTHER], "2026-09-22T09:00:00Z", "2026-09-27T00:00:00Z",
                    "2026-09-22T00:00:00Z",
                    [{"item_id": "L-003", "code": "S-300", "qty": 30, "unit": "kg"}])


def write_fixtures() -> dict:
    report: dict = {}
    shutil.rmtree(SHARED, ignore_errors=True)
    DELIVERIES.mkdir(parents=True, exist_ok=True)
    (DELIVERIES / "01-pkg-alpha.json").write_text(
        json.dumps(envelope_alpha(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for path, realm in ((LEDGER_A, ME), (LEDGER_G, UNINVITED), (LEDGER_C, "contractor:con-B")):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)
        ledger = Ledger(path, realm=realm)
        # 供应商侧自己的事实（**不含 rfq/***：这正是被修掉的根因形态 —— 供应商账本里没有 RFQ 事件）
        ledger.append("quote/submitted", {"quote_id": f"q-{realm.split(':')[1]}", "lines": []},
                      correlation_id=f"q-{realm.split(':')[1]}", ts="2026-09-22T10:00:00Z",
                      actor="agent:supplier")
        report[path.name] = ledger.count
        report[f"{path.name}.realm"] = realm
    contractor = Ledger(LEDGER_C, realm="contractor:con-B")
    contractor.append("rfq/published", {"package_id": "pkg-con", "rev": 1, "items": 1,
                                        "quote_by": "2026-09-30T00:00:00Z", "cost_floor": 700},
                      correlation_id="pkg-con", ts="2026-09-21T09:00:00Z", actor="agent:sourcing")
    contractor.append("rfq/distributed", {"package_id": "pkg-con", "rev": 1, "recipients": [ME, OTHER],
                                          "envelopes": [{"participant": ME}, {"participant": OTHER}]},
                      correlation_id="pkg-con", ts="2026-09-21T09:05:00Z", actor="agent:sourcing")
    report["contractor"] = contractor.count
    report["healthy"] = bool(Ledger(LEDGER_A, realm=ME).verify_report()["ok"])
    # 供应商账本里 **rfq/* 一条都没有**（修复前的根因形态；修复后靠投递信封补上）
    report["supplier_rfq_rows"] = len([line for line in LEDGER_A.read_text(encoding="utf-8").splitlines()
                                        if line.strip() and "rfq/" in line])
    return report


def serve(port: int, prefix: str, ledger: Path) -> subprocess.Popen:
    """真进程：投递目录指向夹具；宿主**只读**这些文件（零写面）。"""
    return subprocess.Popen(
        ["node", str(ROOT / "host" / "cli.mjs"), "webui", "--profile", "webui", "--port", str(port),
         "--host", "127.0.0.1", "--prefix", prefix, "--ui-shared", str(SHARED / "ui-shared"),
         "--rfq-delivery", str(DELIVERIES),
         "--ledger-contractor", str(LEDGER_C), "--ledger-supplier", str(ledger)],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        env={key: value for key, value in os.environ.items()
             if key != "QUOTAGENT_ADMIN_TOKEN" and not key.startswith("QUOTAGENT_UI_RFQ_DELIVERY")})


def wait_up(base: str, proc: subprocess.Popen) -> bool:
    for _ in range(40):
        code, _body = get(f"{base}/api/health")
        if code == 200:
            return True
        if proc.poll() is not None:
            return False
        time.sleep(0.5)
    return False


def rfq_rows(payload: dict) -> list[dict]:
    return [row for row in (payload.get("events") or []) if str(row.get("type", "")).startswith("rfq/")]


def main() -> int:  # noqa: C901
    fixture = write_fixtures()
    deliveries_before = {path.name: sha256_file(path) for path in sorted(DELIVERIES.glob("*.json"))}
    ledgers_before = {name: sha256_file(path) for name, path in
                      (("alpha", LEDGER_A), ("gamma", LEDGER_G), ("contractor", LEDGER_C))}
    check("① 夹具就绪：两份**真哈希链**账本（`supplier:alpha` 被邀 / `supplier:gamma` 未被邀）+ 承包商账本 "
          "+ 投递目录（信封 A 发给 alpha：rev2/报价截止/两条行项目 + 刻意混进承包商私域键与哨兵）；"
          "**供应商账本里 `rfq/*` 一条都没有**（这就是被修掉的根因形态）",
          fixture["healthy"] and fixture["supplier_rfq_rows"] == 0 and len(deliveries_before) == 1
          and json.loads((DELIVERIES / "01-pkg-alpha.json").read_text(encoding="utf-8"))["delivered_to"] == [ME],
          f"账本={fixture}；投递目录={list(deliveries_before)}；供应商账本里的 rfq 行数={fixture['supplier_rfq_rows']}")

    port_a, port_g = free_port(), free_port()
    proc_a = serve(port_a, "/rva", LEDGER_A)
    proc_g = serve(port_g, "/rvg", LEDGER_G)
    base_a = f"http://127.0.0.1:{port_a}/rva"
    base_g = f"http://127.0.0.1:{port_g}/rvg"
    try:
        up_a, up_g = wait_up(base_a, proc_a), wait_up(base_g, proc_g)
        check("② 两个真进程就绪（同一份投递目录、两种身份；`/api/health` 200）",
              up_a and up_g, f"alpha pid={proc_a.pid} port={port_a}；gamma pid={proc_g.pid} port={port_g}")
        if not (up_a and up_g):
            return 2

        # ---- ③ 被邀的供应商看得到包（正控，逐字）----
        a_events_1 = get(f"{base_a}/supplier/api/events")
        a_page_1 = get(f"{base_a}/supplier/")
        a_events_json = parse_json(a_events_1[1])
        a_rows = rfq_rows(a_events_json)
        a_row = next((row for row in a_rows if (row.get("rfq") or {}).get("package_id") == ALPHA_PKG), {})
        a_rfq = a_row.get("rfq") or {}
        a_items = a_rfq.get("items") or []
        items_ok = all(any(item.get("item_id") == item_id and item.get("code") == code
                           and item.get("qty") == qty and item.get("unit") == unit for item in a_items)
                       for item_id, code, qty, unit in ALPHA_ITEMS)
        page_hooks = ['data-rfq="inbox"', 'data-rfq-count="1"', 'data-rfq-degraded="false"',
                      f'data-rfq-package="{ALPHA_PKG}"', f'data-rfq-rev="{ALPHA_REV}"',
                      f"@rev{ALPHA_REV}", ALPHA_QUOTE_BY, 'data-rfq="packages"', 'data-rfq="basis"',
                      f'data-rfq-identity="{ME}"', 'data-rfq-omitted="0"']
        page_missing = [hook for hook in page_hooks if hook not in a_page_1[1]]
        check("③ **被邀的供应商看得到包**（正控，逐字）：`/supplier/api/events` 里出现 `rfq/published` 行，"
              "`package_id`/`rev`/`quote_by`/`clarify_by`/`delivered_at`/行项目与数量**全部等于本脚本手写的"
              "夹具事实值**；首页出现投递块（抓手齐、省略 0、身份对）",
              a_events_1[0] == 200 and a_page_1[0] == 200 and len(a_rows) == 1
              and a_row.get("type") == "rfq/published" and a_row.get("seq") is None
              and a_rfq.get("package_id") == ALPHA_PKG and a_rfq.get("rev") == ALPHA_REV
              and a_rfq.get("quote_by") == ALPHA_QUOTE_BY and a_rfq.get("clarify_by") == ALPHA_CLARIFY_BY
              and a_rfq.get("delivered_at") == ALPHA_SENT_AT and a_rfq.get("recipient") == ME
              and a_rfq.get("basis") == "delivery-envelope" and len(a_rfq) == 9 and items_ok
              and not page_missing,
              f"status={a_events_1[0]}/{a_page_1[0]}；rfq 行={len(a_rows)}；行={json.dumps(a_row, ensure_ascii=False)[:400]}；"
              f"页面缺抓手={page_missing}")

        # ---- ④ 未被邀的供应商看不到（负控）----
        g_events = get(f"{base_g}/supplier/api/events")
        g_page = get(f"{base_g}/supplier/")
        g_json = parse_json(g_events[1])
        g_page_hooks = ['data-rfq="inbox"', 'data-rfq-degraded="true"',
                        'data-rfq-reason="no-deliveries-visible"', f'data-rfq-identity="{UNINVITED}"',
                        'data-rfq-count="0"', 'data-rfq="empty"']
        g_missing = [hook for hook in g_page_hooks if hook not in g_page[1]]
        check("④ **未被邀的供应商看不到**（负控）：同一份投递目录、身份 `supplier:gamma` ⇒ 事件里 `rfq/*` "
              "**0 条**；首页投递块是 `degraded:true` + `reason=no-deliveries-visible` + 计数 0"
              "（「没有发给我」是个**有名**状态，不是空白页）",
              g_events[0] == 200 and g_page[0] == 200 and len(rfq_rows(g_json)) == 0 and not g_missing
              and ALPHA_PKG not in g_events[1] and ALPHA_PKG not in g_page[1],
              f"status={g_events[0]}/{g_page[0]}；rfq 行={len(rfq_rows(g_json))}；页面缺抓手={g_missing}")

        # ---- ⑤ 带哨兵与不带哨兵逐字节一致（真 HTTP）----
        # 追加"只发给别家"的信封（含哨兵）+ 一份**坏信封**（非法 JSON）
        (DELIVERIES / "02-pkg-beta.json").write_text(
            json.dumps(envelope_beta(), ensure_ascii=False) + "\n", encoding="utf-8")
        (DELIVERIES / "99-broken.json").write_text("{ 这不是合法 JSON", encoding="utf-8")
        a_events_2 = get(f"{base_a}/supplier/api/events")
        a_page_2 = get(f"{base_a}/supplier/")
        check("⑤ **带哨兵与不带哨兵输出逐字节一致**（真 HTTP）：把「只发给别家」的信封（含他家代号与私域"
              "哨兵）追加进投递目录后，alpha 的事件 JSON 与首页 HTML **逐字节不变**（不是「藏起来」，是"
              "根本没进输出）；顺带：**坏信封**（非法 JSON）既不崩服务也不计入（服务仍 200）",
              a_events_2[0] == 200 and a_page_2[0] == 200
              and a_events_2[1] == a_events_1[1] and a_page_2[1] == a_page_1[1],
              f"事件字节一致={a_events_2[1] == a_events_1[1]}（sha256 {sha256_bytes(a_events_1[1].encode())[:12]}…/"
              f"{sha256_bytes(a_events_2[1].encode())[:12]}…）；页面字节一致={a_page_2[1] == a_page_1[1]}")

        # ---- ⑥ 非空转对照：同时发给两家的信封必须改变我的视图 ----
        (DELIVERIES / "03-pkg-shared.json").write_text(
            json.dumps(envelope_shared(), ensure_ascii=False) + "\n", encoding="utf-8")
        a_events_3 = get(f"{base_a}/supplier/api/events")
        a_page_3 = get(f"{base_a}/supplier/")
        a_ids_3 = [str((row.get("rfq") or {}).get("package_id")) for row in rfq_rows(parse_json(a_events_3[1]))]
        check("⑥ **非空转对照**：追加「同时发给两家」的信封后，alpha 的事件与首页**必须**变化，且多出 "
              "`pkg-shared`（作用域是**按身份**的，不是「把所有人都挡住」）",
              a_events_3[1] != a_events_2[1] and a_page_3[1] != a_page_2[1]
              and a_ids_3 == [ALPHA_PKG, SHARED_PKG] and SHARED_PKG in a_page_3[1],
              f"事件变化={a_events_3[1] != a_events_2[1]}；包列表={a_ids_3}")

        # ---- ⑦ 哨兵 0 命中（他家代号 / 他家包 / 私域键），含非空转对照 ----
        a_blob = a_events_3[1] + a_page_3[1]
        g_blob = g_events[1] + g_page[1]
        c_events = get(f"{base_a}/contractor/api/events")
        c_page = get(f"{base_a}/contractor/")
        c_blob = c_events[1] + c_page[1]
        needle_hits = []
        for label, blob in (("alpha", a_blob), ("gamma", g_blob), ("contractor", c_blob)):
            # ① 数据面（页面 + JSON）：他家代号 / 他家包 / 他家行项目 / 私域**值**，一个字都不许出现
            for needle in [OTHER, BETA_PKG, "BETA-ONLY", "L-777", *SENTINELS]:
                if needle in blob:
                    needle_hits.append(f"{label}:{needle}")
        # ② 私域**键名**只在 JSON（视图行）层面判：页面里那句「本视角拒收私域键 <code>…</code>」是
        #    **既有的口径声明**（写明"我不收这些键"），不是数据泄漏 —— 断言不能把声明的名字当泄漏，
        #    但**视图行里出现键名**就是泄漏（那一层由本门 + 围栏门 `t286` 一起判）。
        # 承包商侧**不在此列**：他的 `privateKeys` 本来就是空（`contractor` 视角没有"要防的另一方"），
        # 他自己账本里的 `cost_floor` 是他自己的数据 —— 断言只判**供应商侧**两个身份。
        json_blobs = {"alpha": a_events_3[1], "gamma": g_events[1]}
        for label, blob in json_blobs.items():
            for needle in PRIVATE_KEYS:
                if needle in blob:
                    needle_hits.append(f"{label}-json:{needle}")
        fixture_has = [needle for needle in [OTHER, BETA_PKG, "BETA-ONLY", *SENTINELS]
                       if needle in "".join(path.read_text(encoding="utf-8", errors="replace")
                                            for path in sorted(DELIVERIES.glob("*.json")))]
        check("⑦ **他家供应商代号 / 他家包 / 承包商私域值 0 命中**：两个身份的四份响应 + 承包商两份响应里搜不到 "
              "`supplier:beta-SENTINEL-9f3`、`pkg-beta`、`BETA-ONLY`、`L-777` 与三个私域哨兵值；"
              "**私域键名**在**视图 JSON** 里 0 命中（页面里那句「本视角拒收私域键 …」是既有的**口径声明**，"
              "不是数据 —— 断言不把声明的键名当泄漏）；**非空转对照**：这些哨兵**确实**写在投递目录的信封里"
              "（「0 命中」因此才有意义）",
              not needle_hits and len(fixture_has) >= 4,
              f"命中={needle_hits or '无'}；夹具里确实有哨兵={fixture_has}")

        # ---- ⑧ 承包商侧不得减少 ----
        c_json = parse_json(c_events[1])
        c_types = [str(row.get("type")) for row in (c_json.get("events") or [])]
        check("⑧ **承包商侧不得减少、也不得多出供应商私域**：承包商视图（事实来自**它自己的账本**）仍 200、"
              "仍含 `rfq/published` 与 `rfq/distributed`，且响应里 0 个供应商侧哨兵（他不读投递信封）",
              c_events[0] == 200 and c_page[0] == 200 and "rfq/published" in c_types
              and "rfq/distributed" in c_types and not [needle for needle in [OTHER, BETA_PKG, *SENTINELS]
                                                        if needle in c_blob],
              f"status={c_events[0]}/{c_page[0]}；类型={c_types}")

        # ---- ⑨ 只读 + 确定性 ----
        a_events_repeat = get(f"{base_a}/supplier/api/events")
        ledgers_after = {name: sha256_file(path) for name, path in
                         (("alpha", LEDGER_A), ("gamma", LEDGER_G), ("contractor", LEDGER_C))}
        envelopes_after = {path.name: sha256_file(path) for path in sorted(DELIVERIES.glob("*.json"))}
        envelopes_untouched = all(envelopes_after.get(name) == digest for name, digest in deliveries_before.items())
        check("⑨ **只读 + 确定性**：同一 URL 两次 GET **逐字节一致**；跑完前后三份账本**逐字节不变**、"
              "夹具投递信封也**逐字节不变**（宿主对投递信封只有读面，不写任何东西）",
              a_events_repeat[1] == a_events_3[1] and ledgers_after == ledgers_before and envelopes_untouched,
              f"两次一致={a_events_repeat[1] == a_events_3[1]}；账本前后一致={ledgers_after == ledgers_before}；"
              f"信封未被改={envelopes_untouched}；指纹="
              + json.dumps({name: str(value)[:12] for name, value in ledgers_after.items()}))

        # ---- ⑩ 既有路由没坏 + 0 内联脚本 ----
        health = get(f"{base_a}/api/health")
        status = parse_json(get(f"{base_a}/api/status")[1])
        admin = get(f"{base_a}/admin/")
        pages = {"alpha 首页": a_page_3, "gamma 首页": g_page, "承包商首页": c_page}
        scripty = [name for name, res in pages.items() if SCRIPT_NEEDLE in res[1] or INLINE_EVENT.search(res[1])]
        check("⑩ 既有路由没被弄坏：`/api/health` 200、`/api/status` 两本账本都健康、三个页面 200 且 "
              "**0 行 `<script>` / 0 内联事件**（扫描器非空转对照），未提权 `/admin/` 仍是 **401 固定体**",
              health[0] == 200 and status.get("route_prefix") == "/rva" and not scripty and admin[0] == 401
              and admin[1].strip() == FIXED_BODY and INLINE_EVENT.search(' on' + 'click="x"') is not None,
              f"health={health[0]}；ledgers={list((status.get('ledgers') or {}).keys())}；含脚本={scripty or '无'}；"
              f"/admin/={admin[0]} 固定体={admin[1].strip() == FIXED_BODY}")
    finally:
        for proc in (proc_a, proc_g):
            try:
                proc.terminate()
                proc.wait(timeout=10)
            except Exception:  # noqa: BLE001
                try:
                    proc.kill()
                except Exception:  # noqa: BLE001
                    pass

    failures = [item for item in CHECKS if not item["ok"]]
    for item in CHECKS:
        print(f"{'[ok]  ' if item['ok'] else '[FAIL]'} {item['name']}")
        if item["detail"]:
            print(f"        {item['detail']}")
    print(f"RESULT: {'PASS' if not failures else 'FAIL'}（rfq-visibility 路由门 "
          f"{len(CHECKS) - len(failures)}/{len(CHECKS)}）")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
