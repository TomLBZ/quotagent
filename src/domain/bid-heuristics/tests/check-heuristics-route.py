#!/usr/bin/env python3
"""check-heuristics-route —— 比价 heuristics 的**真 HTTP 端到端**（`tools/verify.sh bid-heuristics` 的后半）。

真做五件事（全部走真进程 + 真路由 + 真回读，不是"看着像接上了"）：
  ① 写两份**夹具账本**（承包商侧 / 供应商侧各自的账本文件，与部署形状一致：每个视角读自己的账本）；
  ② 起一个真 `cli.mjs webui` 进程（随机空闲端口、私有前缀 `/qh`）；
  ③ 双方视角的 `GET <prefix>/<view>/heuristics/` 与 `<prefix>/<view>/api/heuristics` 都 200、
     是**真页面/真契约**（有排名表、有权重表单、有贡献分解），且**0 行 `<script>` / 0 内联事件**；
  ④ **改权重 → 响应体不同**（页面与 JSON 两条路由都比；同一批候选下按代号比分数也不同）；
  ⑤ **私域哨兵 0 次**（供应商侧页面/JSON 里搜不到承包商私域键与哨兵串），并有非空转对照
     （同一批私域数据在**承包商侧自己的夹具**里确实存在；供应商侧带私域的那条候选**根本不进排名**）。

额外断言：`/api/routes` 里两条新路由的 `auth` 都是 `none`（**不涉未提权的 admin**）、
既有路由没被弄坏、跑完之后夹具账本与目录**逐字节不变**（宿主零写面在 HTTP 层的机检形态）。

退出码：0 全通过 / 1 有断言失败 / 2 环境错误。
"""
from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
CHECKS: list[dict] = []
# 哨兵串：承包商私域里刻意放的值，任何对外响应体里出现一次就是泄漏
SENTINELS = ["COST-MODEL-SENTINEL-9a", "RESERVE-PRICE-SENTINEL-4b", "PRIVATE-NOTE-SENTINEL-7f", "987654321"]
PRIVATE_KEYS = ["cost_floor", "markup_pct", "reserve_price", "cost_model", "private:", "bidders_private"]


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def get(url: str, timeout: float = 10.0) -> tuple[int, str]:
    """真回读（返回**原始字节解码后的文本**；状态码来自 HTTP 响应本身）。"""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return int(response.status), response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return int(err.code), err.read().decode("utf-8", "replace")
    except Exception as err:  # noqa: BLE001
        return 0, f"<error {type(err).__name__}: {err}>"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def row_pairs(text: str) -> dict[str, str]:
    """页面上"代号 → 得分"的对应（行序会随权重变，按下标比是错的口径）。"""
    import re
    out: dict[str, str] = {}
    for code, score in re.findall(r'data-row="([^"]*)" data-rank="\d+"><td>\d+</td><td><code>[^<]*</code></td>'
                                  r'<td data-score="([^"]*)"', text):
        out[code] = score
    return out


# ---------------------------------------------------------------------------
# ① 夹具账本（写进 tmp/，**不碰**真账本；两份文件分别给两个视角读）
# ---------------------------------------------------------------------------
SHARED = ROOT / "tmp" / "heuristics-route"
CONTRACTOR_LEDGER = SHARED / "contractor" / "ledger.jsonl"
SUPPLIER_LEDGER = SHARED / "supplier" / "ledger.jsonl"


def quote_row(seq: int, quote_id: str, price: float, item: str = "L-001", **extra) -> dict:
    """一条报价 = 同一个行项目（L-001）的一份报价 —— 一个包、一个行项目、多家报价，
    这样极差归一（按行项目分组）才有可比基数（不同行项目的单价不可比，插件会分组）。"""
    body = {"quote_id": quote_id, "rfq_rev": 1,
            "lines": [{"item_id": item, "qty": 100, "unit_price": price}]}
    body.update(extra)
    return {"seq": seq, "type": "quote/submitted", "correlation_id": quote_id,
            "actor": "agent:supplier", "ts": f"2026-09-21T1{seq % 10}:00:00Z", "realm": "supplier:sup-A", "body": body}


# 承包商侧：三家完整报价 + 一条**带私域键**的报价（承包商自己的数据，页面上允许出现它的代号，
# 但不允许出现任何私域键名与哨兵值）
CONTRACTOR_ROWS = [
    quote_row(1, "q-alpha", 100, lead_time_days=10, payment_terms_offered={"advance_pct": 20, "days": 30},
              warranty_months=12, deviations=[]),
    quote_row(2, "q-beta", 80, lead_time_days=20, payment_terms_offered={"advance_pct": 10, "days": 45},
              warranty_months=24, deviations=[{"deviation_id": "d-1"}, {"deviation_id": "d-2"}]),
    quote_row(3, "q-gamma", 90, lead_time_days=15, payment_terms_offered={"advance_pct": 15, "days": 40},
              warranty_months=18, deviations=[{"deviation_id": "d-3"}]),
    quote_row(4, "q-private", 60, cost_floor=70000, markup_pct=12.5, reserve_price=SENTINELS[3],
              cost_model=SENTINELS[0], lead_time_days=5, warranty_months=6,
              **{"private:note": SENTINELS[2]}),
    # 同视角两态对照：这条只带"私域键名"（没有 `private:` 命名的键）—— 承包商侧**是**候选（自己人的数据），
    # 供应商侧同类的 q-leaky **不是**候选（同一类数据、不同视角不同结论）
    quote_row(5, "q-costfloor", 70, cost_floor=70000, markup_pct=12.5, reserve_price=SENTINELS[3],
              cost_model=SENTINELS[0], lead_time_days=8, warranty_months=9),
]
# 供应商侧：**自己**的两条报价 + 一条**自己账本里**带私域键的行（同一条防线：带私域的行不进候选）
SUPPLIER_ROWS = [
    quote_row(1, "q-alpha", 100, lead_time_days=10, payment_terms_offered={"advance_pct": 20, "days": 30},
              warranty_months=12, deviations=[]),
    quote_row(2, "q-beta", 80, lead_time_days=20, payment_terms_offered={"advance_pct": 10, "days": 45},
              warranty_months=24, deviations=[{"deviation_id": "d-1"}, {"deviation_id": "d-2"}]),
    quote_row(3, "q-leaky", 70, cost_floor=55555, bidders_private="BIDDERS-SENTINEL-3c", lead_time_days=8,
              warranty_months=9),
]


def write_fixtures() -> None:
    for path, rows in ((CONTRACTOR_LEDGER, CONTRACTOR_ROWS), (SUPPLIER_LEDGER, SUPPLIER_ROWS)):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8")


def main() -> int:  # noqa: C901
    write_fixtures()
    before = {str(path): sha256_file(path) for path in (CONTRACTOR_LEDGER, SUPPLIER_LEDGER)}
    listing_before = sorted(str(item.relative_to(SHARED)) for item in SHARED.rglob("*"))
    check("① 夹具账本就绪（承包商 4 行 / 供应商 3 行；两份文件分别给两个视角读，形状与部署一致）",
          len(CONTRACTOR_ROWS) >= 3 and len(SUPPLIER_ROWS) >= 2 and all(Path(p).exists() for p in before),
          f"{CONTRACTOR_LEDGER.name}={len(CONTRACTOR_ROWS)} 行；{SUPPLIER_LEDGER.name}={len(SUPPLIER_ROWS)} 行")

    port = free_port()
    prefix = "/qh"
    proc = subprocess.Popen(
        ["node", str(ROOT / "host" / "cli.mjs"), "webui", "--profile", "webui", "--port", str(port),
         "--host", "127.0.0.1", "--prefix", prefix,
         "--ledger-contractor", str(CONTRACTOR_LEDGER), "--ledger-supplier", str(SUPPLIER_LEDGER)],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        env={key: value for key, value in os.environ.items() if key != "QUOTAGENT_ADMIN_TOKEN"})
    base = f"http://127.0.0.1:{port}{prefix}"
    try:
        up = False
        for _ in range(40):
            code, _body = get(f"{base}/api/health", timeout=3)
            if code == 200:
                up = True
                break
            time.sleep(0.5)
        check("② 真进程就绪（`cli.mjs webui` + `/api/health` 200；**不需要**管理员 token）",
              up, f"port={port} prefix={prefix} pid={proc.pid}")
        if not up:
            return 2

        # ---- ③ 路由登记 + 双方视角 ----
        code, routes_body = get(f"{base}/api/routes")
        routes = []
        try:
            routes = json.loads(routes_body).get("routes", [])
        except json.JSONDecodeError:
            routes = []
        heur_routes = [item for item in routes if "heuristics" in str(item.get("path", ""))]
        check("③ `/api/routes` 登记了页面与 JSON 两条新路由，且 `auth` 都是 `none`（不涉未提权的 admin）",
              code == 200 and len(heur_routes) == 4 and all(item.get("auth") == "none" for item in heur_routes)
              and any(str(item["path"]).endswith("/heuristics/") for item in heur_routes)
              and any(str(item["path"]).endswith("/api/heuristics") for item in heur_routes),
              f"status={code} 命中={json.dumps([i.get('path') for i in heur_routes], ensure_ascii=False)}")

        pages = {view: get(f"{base}/{view}/heuristics/") for view in ("contractor", "supplier")}
        page_ok = all(status == 200 for status, _ in pages.values())
        nav_ok = all(f'data-subnav="{view}"' in pages[view][1] for view in pages)
        form_ok = all('<form method="get" action="/qh/' in pages[view][1] and '<button type="submit">用这组权重排名</button>' in pages[view][1]
                      for view in pages)
        table_ok = all('data-heuristics="rows"' in pages[view][1]
                       and 'data-contribution="warranty"' in pages[view][1]
                       and 'data-heuristics-link="1"' in pages[view][1] for view in pages)
        check("③ 双方视角的 heuristics 页各自 **200 且是真页面**（道内子导航含「比价口径」入口 + "
              "`form method=get` 五个权重输入 + 排名表 + 每项贡献列）",
              page_ok and nav_ok and form_ok and table_ok
              and len(row_pairs(pages["contractor"][1])) >= 3 and len(row_pairs(pages["supplier"][1])) >= 2,
              f"status={ {v: pages[v][0] for v in pages} }；子导航={nav_ok} 权重表单={form_ok} 排名表={table_ok}；"
              f"承包商页候选={list(row_pairs(pages['contractor'][1]))} 供应商页候选={list(row_pairs(pages['supplier'][1]))}")

        jsons = {view: get(f"{base}/{view}/api/heuristics") for view in ("contractor", "supplier")}
        parsed = {}
        for view, (status, body) in jsons.items():
            try:
                parsed[view] = json.loads(body)
            except json.JSONDecodeError:
                parsed[view] = {}
        contract_ok = all(
            isinstance(parsed[view].get("rows"), list) and parsed[view].get("degraded") is False
            and parsed[view].get("reason") is None
            and isinstance(parsed[view].get("weights_applied"), dict)
            and isinstance(parsed[view].get("counts"), dict)
            and isinstance(parsed[view].get("truncated"), bool) and isinstance(parsed[view].get("omitted"), int)
            and abs(float(parsed[view].get("normalized_sum", 0)) - 1) <= 1e-9
            and all(sorted(row.get("contributions", {})) == ["delivery", "deviation", "payment", "price", "warranty"]
                    for row in parsed[view].get("rows", []))
            for view in ("contractor", "supplier"))
        item_ok = all(view in parsed and parsed[view].get("counts", {}).get("items") == 1
                      and parsed[view].get("baseline") == "per-item"
                      and all(row.get("item") == "L-001" for row in parsed[view].get("rows", []))
                      for view in ("contractor", "supplier"))
        check("③ 归一基数**按行项目分组**（`baseline=per-item`、`counts.items=1`、每行带 `item=L-001`）："
              "同一个行项目的候选才互相比较（不同行项目的单价不可比）",
              item_ok and "行项目" in pages["contractor"][1] and "L-001" in pages["contractor"][1],
              f"contractor baseline={parsed['contractor'].get('baseline')} items={parsed['contractor'].get('counts', {}).get('items')} "
              f"rows_item={[row.get('item') for row in parsed['contractor'].get('rows', [])]}；"
              f"supplier baseline={parsed['supplier'].get('baseline')} items={parsed['supplier'].get('counts', {}).get('items')}")

        check("③ `/<view>/api/heuristics` 双方各自 200 且契约齐备（rows/weights_applied/counts/truncated/omitted/"
              "degraded/reason + 每行五个贡献键；归一化和为一）",
              all(status == 200 for status, _ in jsons.values()) and contract_ok,
              f"status={ {v: jsons[v][0] for v in jsons} }；承包商 rows={len(parsed['contractor'].get('rows', []))} "
              f"供应商 rows={len(parsed['supplier'].get('rows', []))} sum={parsed['contractor'].get('normalized_sum')}")

        # ---- ④ 改权重 → 响应体不同（页面 + JSON，两次对比） ----
        price_q = "w_price=1&w_delivery=0&w_payment=0&w_warranty=0&w_deviation=0"
        deliver_q = "w_price=0&w_delivery=1&w_payment=0&w_warranty=0&w_deviation=0"
        price_page = get(f"{base}/contractor/heuristics/?{price_q}")
        deliver_page = get(f"{base}/contractor/heuristics/?{deliver_q}")
        price_json = get(f"{base}/contractor/api/heuristics?{price_q}")
        deliver_json = get(f"{base}/contractor/api/heuristics?{deliver_q}")
        price_scores, deliver_scores = row_pairs(price_page[1]), row_pairs(deliver_page[1])
        score_moved = bool(price_scores) and any(deliver_scores.get(code) != score for code, score in price_scores.items())
        order_moved = list(price_scores) != list(deliver_scores)
        check("④ **改权重 → 响应体真的不同**（页面与 JSON 都比；同一批候选下按代号比分数也不同、名次顺序也变）",
              price_page[0] == 200 and deliver_page[0] == 200 and price_page[1] != deliver_page[1]
              and price_json[1] != deliver_json[1] and score_moved and order_moved,
              f"页面体不同={price_page[1] != deliver_page[1]} JSON 不同={price_json[1] != deliver_json[1]} "
              f"分数变了={score_moved} 名次变了={order_moved}；w_price=1→{json.dumps(price_scores)} "
              f"w_delivery=1→{json.dumps(deliver_scores)}")

        # ---- 夹取回显（越界权重 + 非数字权重） ----
        clamp_page = get(f"{base}/contractor/heuristics/?w_price=9&w_delivery=abc")
        clamp_json = get(f"{base}/contractor/api/heuristics?w_price=9&w_delivery=abc")
        clamp_parsed = {}
        try:
            clamp_parsed = json.loads(clamp_json[1])
        except json.JSONDecodeError:
            clamp_parsed = {}
        notes = clamp_parsed.get("clamp_notes", [])
        check("④ 权重越界/非数字**夹取并回显**（页面写出夹取说明与请求原值；JSON 里 applied 是夹取后的真值、"
              "requested 照抄原值；两个分量都没被静默当成 0）",
              clamp_page[0] == 200 and "夹取" in clamp_page[1] and "9" in clamp_page[1] and "abc" in clamp_page[1]
              # 未提交的分量回落到**默认权重**（不是 0）→ price 夹到 1 后归一 = 1/(1+0.15+0.1+0.05+0.1) = 1/1.4
              and abs(float(clamp_parsed.get("weights_applied", {}).get("price", 0)) - 1 / 1.4) <= 1e-9
              and abs(sum(float(value) for value in clamp_parsed.get("weights_applied", {}).values()) - 1) <= 1e-9
              and clamp_parsed.get("weights_requested", {}).get("price") == 9
              and clamp_parsed.get("weights_requested", {}).get("delivery") is None
              and len(notes) >= 2,
              f"status={clamp_page[0]}；applied={json.dumps(clamp_parsed.get('weights_applied'))} "
              f"requested={json.dumps(clamp_parsed.get('weights_requested'))} notes={json.dumps(notes, ensure_ascii=False)}")

        # ---- ⑤ 私域哨兵 0 次（供应商侧）+ 非空转对照 ----
        supplier_text = pages["supplier"][1] + jsons["supplier"][1] + get(f"{base}/supplier/heuristics/?{price_q}")[1]
        hit_keys = [needle for needle in PRIVATE_KEYS if needle in supplier_text]
        hit_sent = [needle for needle in SENTINELS if needle in supplier_text]
        contractor_text = pages["contractor"][1] + jsons["contractor"][1]
        contractor_hit_keys = [needle for needle in PRIVATE_KEYS if needle in contractor_text]
        contractor_hit_sent = [needle for needle in SENTINELS if needle in contractor_text]
        fixture_has = SENTINELS[0] in CONTRACTOR_LEDGER.read_text(encoding="utf-8")
        leaky_in_supplier_candidates = "q-leaky" in row_pairs(pages["supplier"][1]) or any(
            row.get("code") == "q-leaky" for row in parsed["supplier"].get("rows", []))
        contractor_codes = row_pairs(pages["contractor"][1])
        check("⑤ 私域哨兵 **0 次**：供应商侧页面/JSON（含换权重的那次）里搜不到承包商私域键与哨兵串；"
              "承包商侧自己的比价页也一个都不出（只出代号/分数/贡献，私域键的值连读都不读）；"
              "**非空转对照**：同一批私域数据确实在夹具账本里 —— 承包商侧同类行（q-costfloor）**是**候选、"
              "供应商侧同类行（q-leaky）**不进排名**，而「跳过 N 条」这件事本身在页面上有报数",
              not hit_keys and not hit_sent and not contractor_hit_keys and not contractor_hit_sent
              and fixture_has and not leaky_in_supplier_candidates
              and "q-costfloor" in contractor_codes and "q-private" not in contractor_codes
              and "q-alpha" in contractor_codes and "q-beta" in contractor_codes
              and parsed["contractor"].get("counts", {}).get("skipped_private", 0) >= 1
              and parsed["supplier"].get("counts", {}).get("skipped_private", 0) >= 1
              and "整行跳过" in pages["contractor"][1],
              f"供应商侧命中键={hit_keys} 哨兵={hit_sent}；承包商侧比价页命中键={contractor_hit_keys} 哨兵={contractor_hit_sent}；"
              f"夹具确实含哨兵={fixture_has}；供应商侧含 q-leaky={leaky_in_supplier_candidates}；"
              f"承包商页候选={list(contractor_codes)}；跳过私域行="
              f"{parsed['contractor'].get('counts', {}).get('skipped_private')}/"
              f"{parsed['supplier'].get('counts', {}).get('skipped_private')}")

        # ---- 零 JS（页面 + JSON） ----
        script_needle = "<scr" + "ipt"
        import re
        inline = re.compile(r"\son[a-z]+\s*=", re.I)
        scripty = [name for name, (_, body) in {**pages, **jsons, "clamp_page": clamp_page, "price_page": price_page}.items()
                   if script_needle in body]
        handlery = [name for name, (_, body) in {**pages, **jsons}.items() if inline.search(body)]
        check("⑤ 新页面/JSON **0 行脚本 / 0 内联事件**（零 JS 是机检事实：交互只用 `form method=get` 与链接）",
              not scripty and not handlery and script_needle in (f"<a {script_needle}>"),
              f"含脚本={scripty or '无'}；含内联事件={handlery or '无'}")

        # ---- 既有路由没被弄坏 + 未提权的 admin 不涉 ----
        ops_code, _ = get(f"{base}/api/ops")
        score_code, _ = get(f"{base}/contractor/api/scorecard")
        home_code, _ = get(f"{base}/contractor/")
        admin_code, admin_body = get(f"{base}/admin/")
        check("⑤ 既有路由没被弄坏（`/api/ops`、`/contractor/api/scorecard`、`/contractor/` 都 200），"
              "且本门全程**不涉未提权的 admin**（`/admin/` 仍 401 固定体：不需要管理员身份就能验比价口径）",
              ops_code == 200 and score_code == 200 and home_code == 200
              and admin_code == 401 and admin_body.strip() == '{"error":"unauthorized"}',
              f"ops={ops_code} scorecard={score_code} home={home_code} admin={admin_code}")

        # ---- 宿主零写面（HTTP 层）：夹具账本与目录逐文件不变 ----
        after = {str(path): sha256_file(path) for path in (CONTRACTOR_LEDGER, SUPPLIER_LEDGER)}
        listing_after = sorted(str(item.relative_to(SHARED)) for item in SHARED.rglob("*"))
        check("⑤ 宿主**零写面**（跑完一整轮之后夹具账本逐字节不变、目录没有多出/少掉任何文件；"
              "宿主不写账本、不落待处理项）",
              before == after and listing_before == listing_after,
              f"账本字节不变={before == after}；目录不变={listing_before == listing_after}（{len(listing_after)} 项）")
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
