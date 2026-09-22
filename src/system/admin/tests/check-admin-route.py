#!/usr/bin/env python3
"""check-admin-route —— admin 道端到端（`tools/verify.sh admin-route`）。

真做四件事（**自带夹具**，不依赖 `tmp/` 里的任何演示数据）：
  ① 造夹具：一份 admin 阻塞/进度快照（含 2 条真阻塞 plugin-request/credential + 一条「脏」块与私域键，
     用来验「不出正文与私域」）、一个临时 admin token 环境变量、两条业务账本、一份路由层夹具源码；
  ② 真起一个 `cli.mjs webui` 进程（随机端口、私有前缀 `/quotagent`）——真 webui 三道（contractor/supplier/ops）
     的响应经代理**逐字节**参与比对，用来证明「提权不改字段面」与「三道未被弄坏」；
  ③ 真起一个 node 进程挂载被测插件（`admin-guard` + `admin-view`，真 cordis、真 HTTP）；
  ④ 真发 HTTP 请求断言：无凭证 401 且体**逐字节**等于固定体（含未知子路径同形）、正确 token 提权 200 +
     `Set-Cookie` 四件、带会话读面板 200 且含 blocks/counts/progress、切道 302、非 admin token 一律 401
     且无 cookie、响应里搜不到 token 与快照哨兵（正文/私域）、连 5 次失败后**正确 token 也拒**。

**范围声明（不许含糊）**：`/quotagent/admin/*` 的**路由**属父方对 `host/modules/webui.mjs` 的接线；
本脚本不能改该文件，因此用一份**同形路由层夹具**（运行时写在 `tmp/` 下，随夹具目录清理）把
「真 webui + 真插件 + 真 HTTP」接起来：所有判定（拒绝体、会话、切道白名单、快照投影）都来自被测插件，
夹具只做「路由 + 状态码 + Set-Cookie 落位」的胶水，非 admin 路径**代理**到真 webui 进程。
"""
from __future__ import annotations

import http.client
import hashlib
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
CHECKS: list[dict] = []
FIXED_BODY = '{"error":"unauthorized"}'
SENTINEL = "SENTINEL-ADMIN-E2E-4c17"
PREFIX = "/quotagent"
ADMIN = f"{PREFIX}/admin"

# 路由层夹具：**同形**于 docs/design/21-admin-console-contract.md §3 的 admin 路（将来由 webui.mjs 承接）。
# 判定全部来自被测插件；这里只有路由/状态码/cookie 胶水；非 admin 路径代理到真 webui 进程。
ROUTE_LAYER = r'''
import { createServer, request as httpRequest } from 'node:http'
import { pathToFileURL } from 'node:url'

const REPO = process.env.T271_REPO
const PREFIX = process.env.T271_PREFIX ?? '/quotagent'
const ADMIN = `${PREFIX}/admin`
const { Context, EventsService } = await import(
  pathToFileURL(`${REPO}/host/node_modules/cordis/lib/index.js`).href)

const guardMod = await import(pathToFileURL(`${REPO}/host/modules/admin-guard.mjs`).href)
const viewMod = await import(pathToFileURL(`${REPO}/host/modules/admin-view.mjs`).href)

const ctx = new Context()
await ctx.plugin(EventsService)
const box = {}
const wrap = (mod, service) => async (inner, config) => {
  const original = inner.provide.bind(inner)
  inner.provide = (name, value) => {
    if (name === service) box[service] = value
    return original(name, value)
  }
  await mod.apply(inner, config)
}
await ctx.plugin({ name: 'admin-guard', inject: [], Config: guardMod.Config,
  apply: wrap(guardMod, 'adminGuard') },
guardMod.Config.parse({ route_prefix: PREFIX, token_env: process.env.T271_TOKEN_ENV }))
await ctx.plugin({ name: 'admin-view', inject: [], Config: viewMod.Config,
  apply: wrap(viewMod, 'adminView') },
viewMod.Config.parse({ admin_snapshot: process.env.T271_ADMIN_SNAPSHOT }))
const guard = box.adminGuard
const view = box.adminView

const send = (res, status, type, body, headers = {}) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers })
  res.end(body)
}
// 统一拒绝：**照抄插件给的固定三元组**（不自己拼第二份字面量 → 也就不存在第二份形状）
const deny = (res) => {
  const fixed = guard.unauthorized()
  res.writeHead(fixed.status, fixed.headers)
  res.end(fixed.body)
}
const readBody = (req) => new Promise((resolve) => {
  let text = ''
  req.on('data', (chunk) => { text += chunk; if (text.length > 16384) req.destroy() })
  req.on('end', () => resolve(text))
})
const panel = (session) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>系统管理</title></head>`
  + `<body><h1>系统管理（admin 道）</h1><nav>`
  + ['contractor', 'supplier', 'ops', 'admin'].map((v) => `<a href="${PREFIX}/${v}/">${v}</a>`).join(' ')
  + `</nav><p>会话到期：${session.expires_at}；阻塞与进度见 <code>${ADMIN}/api/blocks</code></p>`
  + `<p>token 只经当次请求体提交，不回显、不落前端存储、不入账本。</p></body></html>`

const proxy = (req, res) => {
  const upstream = httpRequest({ host: '127.0.0.1', port: Number(process.env.T271_WEBUI_PORT),
    method: req.method, path: req.url, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers)
    up.pipe(res)
  })
  upstream.on('error', () => {
    if (!res.headersSent) send(res, 502, 'application/json; charset=utf-8', '{"error":"upstream"}\n')
  })
  req.pipe(upstream)
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    if (url.pathname !== ADMIN && !url.pathname.startsWith(`${ADMIN}/`)) return proxy(req, res)
    const path = url.pathname.slice(ADMIN.length) || '/'

    if (path === '/' || path === '') {
      const session = guard.authorized(req)
      if (!session.ok) return deny(res)
      return send(res, 200, 'text/html; charset=utf-8', panel(session))
    }
    if (path === '/api/session') {
      const session = guard.authorized(req)
      if (!session.ok) return deny(res)
      return send(res, 200, 'application/json; charset=utf-8',
        JSON.stringify({ elevated: true, expires_at: session.expires_at, views: session.views }) + '\n')
    }
    if (path === '/api/elevate' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req))
      const out = guard.elevate(form.get('token') ?? undefined)
      if (!out.ok) return deny(res)
      return send(res, 200, 'application/json; charset=utf-8',
        JSON.stringify({ elevated: true, expires_at: out.expires_at }) + '\n', { 'set-cookie': out.cookie })
    }
    if (path === '/api/logout' && req.method === 'POST') {
      const out = guard.logout(req)
      if (!out.ok) return deny(res)
      return send(res, 204, 'text/plain; charset=utf-8', '')
    }
    if (path === '/api/blocks') {
      const session = guard.authorized(req)
      if (!session.ok) return deny(res)
      const snapshot = view.snapshot()
      return send(res, 200, 'application/json; charset=utf-8',
        JSON.stringify({ ...snapshot, headline: view.headline(), generated_at_source: 'python-side' }) + '\n')
    }
    if (path === '/api/switch') {
      const session = guard.authorized(req)
      if (!session.ok) return deny(res)
      const target = guard.switchAllowed(url.searchParams.get('to'))
      if (!target.ok) return deny(res)
      return send(res, 302, 'text/plain; charset=utf-8', '', { location: target.to })
    }
    return deny(res)   // 未知子路径：与未提权**同形**（没有「有这个子路由」这种可探测差异）
  } catch (err) {
    if (!res.headersSent) send(res, 500, 'application/json; charset=utf-8', '{"error":"fixture-error"}\n')
    return undefined
  }
})
server.listen(Number(process.env.T271_PORT ?? 0), '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ ok: true, port: server.address().port, admin: ADMIN }) + '\n')
})
'''


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def request(port: int, method: str, path: str, body: str | None = None,
            headers: dict | None = None, timeout: float = 10.0):
    """真发一个 HTTP 请求；返回 (status, headers_list, body_bytes)。"""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    conn.request(method, path, body=body, headers=headers or {})
    response = conn.getresponse()
    payload = response.read()
    head = response.getheaders()
    conn.close()
    return response.status, head, payload


def header_of(headers: list, name: str) -> str:
    for key, value in headers:
        if key.lower() == name.lower():
            return value
    return ""


def wait_http(port: int, path: str, want: int, tries: int = 60, timeout: float = 0.5) -> tuple[bool, int, bytes]:
    last = (0, b"")
    for _ in range(tries):
        try:
            status, _head, body = request(port, "GET", path, timeout=timeout)
            last = (status, body)
            if status == want:
                return True, status, body
        except OSError:
            pass
        time.sleep(0.5)
    return False, last[0], last[1]


# ---------------------------------------------------------------------------
# ① 夹具
# ---------------------------------------------------------------------------
fixture_dir = Path(tempfile.mkdtemp(prefix="t272-admin-route-", dir=str(ROOT / "tmp")))
token = secrets.token_urlsafe(32)
token_env = "QUOTAGENT_ADMIN_TOKEN"
snapshot_path = fixture_dir / "admin-blocks.json"
ledger_contractor = fixture_dir / "contractor.jsonl"
ledger_supplier = fixture_dir / "supplier.jsonl"
route_layer = fixture_dir / "route-layer.mjs"

counts_declared = {"blocked": 2, "pending": 1, "resolved": 3, "rejected": 0, "expired": 0}
snapshot = {
    "generated_at": "2026-09-21T12:00:00Z",
    "counts": {**counts_declared, "private:note": f"{SENTINEL}-counts"},
    "counts_source": "registry+facts",
    "blocks": [
        {"block_id": "blk-advisor-1", "kind": "plugin-request", "state": "blocked",
         "reason": "Jev 建议层插件未落地（登记表为 todo）", "required_action": "人工决定排期",
         "refs": ["progress-checklist"], "private:cost_floor": f"{SENTINEL}-floor"},
        {"block_id": "blk-mail-1", "kind": "credential", "state": "blocked",
         "reason": "缺 SMTP/IMAP 凭据，宿主侧只能报不可用", "required_action": "在面板内提交凭据",
         "refs": ["FR-INTEG-003", "mail-transport-unavailable"], "body": f"{SENTINEL}-body"},
        {"block_id": "blk-pending-1", "kind": "credential", "state": "pending",
         "reason": f"body={SENTINEL}-reason", "required_action": "consume",
         "refs": [f"cost_floor={SENTINEL}-ref"]},
    ],
    "progress": {"done": 41, "todo": 7, "blocked": 2, "source": "registry",
                 "private:nested": {"secret": f"{SENTINEL}-nested"}},
}
snapshot_path.write_text(json.dumps(snapshot, ensure_ascii=True), encoding="utf-8")
for path, realm in ((ledger_contractor, "contractor"), (ledger_supplier, "supplier")):
    rows = [
        {"seq": 1, "type": "quote/submitted", "correlation_id": f"c-{realm}", "actor": "python:kernel",
         "ts": "2026-09-21T11:00:00Z", "body": {"lines": [{"item_id": "L-001", "unit_price": 12.5}]}},
        {"seq": 2, "type": "approval/granted", "correlation_id": f"c-{realm}", "actor": "human:zhang",
         "ts": "2026-09-21T11:05:00Z", "body": {"approval_id": "ap-0001"}},
    ]
    path.write_text("".join(json.dumps(row, ensure_ascii=True) + "\n" for row in rows), encoding="utf-8")
route_layer.write_text(ROUTE_LAYER, encoding="utf-8")

check("① 夹具自带（不依赖 tmp/ 演示数据）：快照含 2 条真阻塞（plugin-request/credential）+ 脏块与私域键、"
      "两条业务账本、路由层夹具源码、临时 token 环境变量",
      snapshot_path.exists() and ledger_contractor.exists() and ledger_supplier.exists()
      and route_layer.exists() and len(token) >= 32,
      f"fixture_dir={fixture_dir}；sentinel={SENTINEL}；token 长度={len(token)}（只给长度，不给值）")

webui_port = free_port()
admin_port = free_port()
webui_proc = None
admin_proc = None

try:
    # ---------------------------------------------------------------------
    # ② 真 webui 进程（三道 UI 的真身；admin 请求将由它承接 —— 本脚本用同形夹具顶替路由）
    # ---------------------------------------------------------------------
    webui_proc = subprocess.Popen(
        ["node", str(ROOT / "host" / "cli.mjs"), "webui", "--profile", "webui",
         "--port", str(webui_port), "--host", "127.0.0.1", "--prefix", PREFIX,
         "--ledger-contractor", str(ledger_contractor), "--ledger-supplier", str(ledger_supplier)],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, env=dict(os.environ))
    up, status, _body = wait_http(webui_port, f"{PREFIX}/api/health", 200)
    check("② 真 webui 进程就绪（cli.mjs webui，随机端口 + 私有前缀）",
          up, f"port={webui_port} status={status}")

    admin_env = dict(os.environ)
    admin_env.update({
        "T271_REPO": str(ROOT),
        "T271_PREFIX": PREFIX,
        "T271_ADMIN_SNAPSHOT": str(snapshot_path),
        "T271_PORT": str(admin_port),
        "T271_WEBUI_PORT": str(webui_port),
        token_env: token,
    })
    admin_proc = subprocess.Popen(["node", str(route_layer)], cwd=str(ROOT / "host"),
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=admin_env)
    ready, status, body = wait_http(admin_port, f"{ADMIN}/", 401)
    check("② admin 路由层进程就绪（真 cordis 挂载 admin-guard + admin-view；非 admin 路径代理到真 webui）",
          ready, f"port={admin_port} status={status} body={body[:48]!r}")

    responses: list[bytes] = []          # 所有响应体（哨兵四搜的面）

    def get(path: str, cookie: str | None = None, **kw):
        headers = dict(kw.pop("headers", {}) or {})
        if cookie:
            headers["cookie"] = cookie
        status, head, body = request(admin_port, "GET", path, headers=headers, **kw)
        responses.append(body)
        return status, head, body

    def post(path: str, body: str, content_type: str = "application/x-www-form-urlencoded", cookie=None):
        headers = {"content-type": content_type}
        if cookie:
            headers["cookie"] = cookie
        status, head, out = request(admin_port, "POST", path, body=body, headers=headers)
        responses.append(out)
        return status, head, out

    # ---------------------------------------------------------------------
    # ③ 统一拒绝体：无凭证四路 + 未知子路径，body 逐字节相同
    # ---------------------------------------------------------------------
    unauth = {
        "面板页 /admin/": get(f"{ADMIN}/"),
        "阻塞清单 /api/blocks": get(f"{ADMIN}/api/blocks"),
        "会话 /api/session": get(f"{ADMIN}/api/session"),
        "切道 /api/switch": get(f"{ADMIN}/api/switch?to=supplier"),
        "未知子路径": get(f"{ADMIN}/api/does-not-exist"),
    }
    codes = [item[0] for item in unauth.values()]
    bodies = [item[2] for item in unauth.values()]
    leak_words = ["block_id", "blk-", "counts", "progress", "plugin-request"]
    leak_found = [word for word in leak_words if any(word.encode() in body for body in bodies)]
    check("③ 第四道未提权不出内容：/admin/ · /api/blocks · /api/session · /api/switch 与**未知子路径**五路"
          "一律 401 且 body 逐字节等于固定体（无区分字段、无面板内容）",
          codes == [401] * 5 and len(set(bodies)) == 1 and bodies[0] == FIXED_BODY.encode()
          and not leak_found and len(bodies[0]) == len(FIXED_BODY),
          f"statuses={codes}；body 去重后 {len(set(bodies))} 种={bodies[0]!r}（逐字节等于固定体="
          f"{bodies[0] == FIXED_BODY.encode()}）；可疑泄漏词={leak_found or '无'}")

    # ---------------------------------------------------------------------
    # ④ 提权端点契约（正确 token）
    # ---------------------------------------------------------------------
    status, head, body = post(f"{ADMIN}/api/elevate", f"token={token}")
    set_cookie = header_of(head, "set-cookie")
    cookie_parts = [part.strip() for part in set_cookie.split(";")]
    cookie_value = cookie_parts[0].split("=", 1)[1] if "=" in cookie_parts[0] else ""
    status_page, _head_page, page = get(f"{ADMIN}/", cookie=f"qa_admin={cookie_value}")
    check("④ 提权端点契约：正确 token（表单体）→ 200 + `Set-Cookie` 四件（HttpOnly/SameSite=Strict/"
          "Path=/quotagent/admin）且会话 id 不是 token 的派生；响应体与提权后的 HTML 页面里都搜不到 token",
          status == 200 and "HttpOnly" in set_cookie and "SameSite=Strict" in set_cookie
          and "Path=/quotagent/admin" in set_cookie and cookie_value != "" and token not in set_cookie
          and token not in body.decode() and token not in page.decode()
          and status_page == 200 and cookie_value not in body.decode(),
          f"status={status}；Set-Cookie={set_cookie[:96]}；会话 id 长度={len(cookie_value)}"
          f"（192 bit，非 token 派生={token not in cookie_value}）；页面 status={status_page}；"
          f"响应体={body[:80]!r}")

    # ---------------------------------------------------------------------
    # ⑤ 带会话读面板：真数据 + 白名单 + 计数照抄
    # ---------------------------------------------------------------------
    status, _head, body = get(f"{ADMIN}/api/blocks", cookie=f"qa_admin={cookie_value}")
    data = json.loads(body.decode() or "{}")
    blocks = data.get("blocks") or []
    counts = data.get("counts") or {}
    progress = data.get("progress") or {}
    kinds = {item.get("kind") for item in blocks}
    block_keys = set()
    for item in blocks:
        block_keys |= set(item)
    allowed_block_keys = {"block_id", "kind", "state", "reason", "required_action", "refs"}
    check("⑤ 带会话读阻塞面板：200 且含 blocks/counts/progress；≥2 条真阻塞且 kind 含 plugin-request 与 "
          "credential；每条含 block_id/kind/reason/required_action/refs；counts 键是状态白名单 + 口径来源"
          "（照抄快照声明值，不用列表长度冒充计数）",
          status == 200 and isinstance(blocks, list) and len(blocks) >= 2
          and {"plugin-request", "credential"} <= kinds and not data.get("degraded")
          and block_keys <= allowed_block_keys and isinstance(counts, dict) and isinstance(progress, dict)
          and counts.get("blocked") == counts_declared["blocked"]
          and counts.get("resolved") == counts_declared["resolved"]
          and counts.get("source") == "registry+facts"
          and set(counts) == {"blocked", "pending", "resolved", "rejected", "expired", "source"}
          and progress.get("source") == "registry"
          and all(item.get("block_id") and item.get("kind") and item.get("reason")
                  and item.get("required_action") is not None and isinstance(item.get("refs"), list)
                  for item in blocks),
          f"status={status} blocks={len(blocks)} kinds={sorted(kinds)} 块键={sorted(block_keys)}；"
          f"counts={json.dumps(counts, ensure_ascii=False)}；progress={json.dumps(progress, ensure_ascii=False)}")

    # ---------------------------------------------------------------------
    # ⑥ 切道：带会话 302 到目标道；不带会话回统一拒绝体
    # ---------------------------------------------------------------------
    status_switch, head_switch, body_switch = get(f"{ADMIN}/api/switch?to=supplier",
                                                  cookie=f"qa_admin={cookie_value}")
    status_switch_anon, _h2, body_switch_anon = get(f"{ADMIN}/api/switch?to=supplier")
    status_switch_bad, _h3, _b3 = get(f"{ADMIN}/api/switch?to=../../etc/passwd",
                                      cookie=f"qa_admin={cookie_value}")
    check("⑥ 切视角只做 302：带会话 `?to=supplier` → 302 到 /quotagent/supplier/；不带会话 → 401 固定体；"
          "非法 to → 401 固定体（白名单，不用 URL 拼路由）",
          status_switch == 302 and header_of(head_switch, "location") == f"{PREFIX}/supplier/"
          and status_switch_anon == 401 and body_switch_anon == FIXED_BODY.encode()
          and status_switch_bad == 401,
          f"带会话 status={status_switch} Location={header_of(head_switch, 'location')!r}；"
          f"无会话 status={status_switch_anon} body={body_switch_anon!r}；非法 to status={status_switch_bad}")

    # ---------------------------------------------------------------------
    # ⑦ 反例：非 admin token 三变体 + 无 token → 401 固定体、无 Set-Cookie
    # ---------------------------------------------------------------------
    sha_prefix = hashlib.sha256(token.encode()).hexdigest()
    variants = {
        "合法长度错内容": "x" * len(token),
        "正确 token 的 sha256": sha_prefix,
        "正确 token 去末字符": token[:-1],
    }
    variant_results = {}
    for label, value in variants.items():
        status_v, head_v, body_v = post(f"{ADMIN}/api/elevate", f"token={value}")
        variant_results[label] = (status_v, header_of(head_v, "set-cookie"), body_v)
    status_none, head_none, body_none = post(f"{ADMIN}/api/elevate", "")
    oracle_leak = [label for label, value in variants.items()
                   if value in variant_results[label][2].decode()]
    check("⑦ 反例（机检）：三种「接近正确」的非 admin token 与**无 token**一律 401 且 body 逐字节等于固定体、"
          "**没有任何 Set-Cookie**；响应里搜不到所提交的值、原 token 与其摘要",
          all(item[0] == 401 and item[1] == "" and item[2] == FIXED_BODY.encode()
              for item in variant_results.values())
          and status_none == 401 and header_of(head_none, "set-cookie") == ""
          and body_none == FIXED_BODY.encode()
          and not oracle_leak and token.encode() not in b"".join(i[2] for i in variant_results.values())
          and sha_prefix.encode() not in b"".join(i[2] for i in variant_results.values()),
          f"变体 status/cookie 对={ {label: (item[0], item[1]) for label, item in variant_results.items()} }；"
          f"无 token status={status_none} Set-Cookie={header_of(head_none, 'set-cookie')!r}；"
          f"提交值回显={oracle_leak or '无'}")

    # ---------------------------------------------------------------------
    # ⑧ 切道不改字段面（AC-ADMIN-003）：带会话与不带会话逐字节相同
    # ---------------------------------------------------------------------
    pairs = []
    for path in (f"{PREFIX}/supplier/", f"{PREFIX}/supplier/api/events"):
        status_a, _ha, body_a = get(path)
        status_b, _hb, body_b = get(path, cookie=f"qa_admin={cookie_value}")
        pairs.append((path, status_a, status_b, body_a == body_b, body_a))
    # 私域键只在**数据面**（JSON）上判：`/supplier/` 的 HTML 会**点名它拒收哪些私域键**（既有 webui 行为，
    # 不是泄漏 —— 名字在这里是"我拒收"的说明，不是数据），所以数据面用 JSON 键形 + private: 两种针。
    api_body = next(body for path, *_rest, body in
                    [(item[0], item[1], item[2], item[3], item[4]) for item in pairs]
                    if path.endswith("/api/events"))
    private_hits = [needle for needle in ('"cost_floor"', "private:", '"bidders_private"')
                    if needle.encode() in api_body]
    check("⑧ 切视角不改字段面（AC-ADMIN-003）：已提权会话下 /quotagent/supplier/ 与 "
          "/quotagent/supplier/api/events 的响应体与**未提权**的同名请求**逐字节相同**；"
          "数据面（JSON）两条路径都不出私域键（管理员身份不是看到私域的新路径）",
          all(item[3] for item in pairs) and all(item[1] == 200 and item[2] == 200 for item in pairs)
          and not private_hits,
          "；".join(f"{path} 200/200 逐字节相同={same}" for path, s1, s2, same, _b in pairs)
          + f"；数据面私域键命中={private_hits or '无'}")

    # ---------------------------------------------------------------------
    # ⑨ 哨兵四搜：所有响应体里都搜不到 token 与快照哨兵（正文/私域）
    # ---------------------------------------------------------------------
    blob = b"\n".join(responses)
    check("⑨ 哨兵四搜：至今所有响应体（页面/JSON）里搜不到 admin token、也搜不到快照里的正文/私域哨兵"
          "（脏块的 body 值 / 私域键名与键值；`\"cost_floor\"` 按 JSON 键形搜——`/supplier/` 页面会以"
          "「我拒收这些键」的方式点名它们，那是既有行为不是数据泄漏）",
          token.encode() not in blob and SENTINEL.encode() not in blob
          and b"private:" not in blob and b'"cost_floor"' not in blob and len(blob) > 500,
          f"搜面 {len(blob)} 字节；含 token={token.encode() in blob}；含哨兵={SENTINEL.encode() in blob}；"
          f"含 private:={b'private:' in blob}；含 JSON 键 cost_floor={b'\"cost_floor\"' in blob}")

    # ---------------------------------------------------------------------
    # ⑩ 有界退避：连 5 次失败 → 冷却；冷却内**正确 token 也拒**、带会话读面板也拒、不产生任何成功
    # ---------------------------------------------------------------------
    for _ in range(5):
        post(f"{ADMIN}/api/elevate", "token=definitely-wrong")
    status_cool, head_cool, body_cool = post(f"{ADMIN}/api/elevate", f"token={token}")
    status_cool_page, _hcp, body_cool_page = get(f"{ADMIN}/api/blocks", cookie=f"qa_admin={cookie_value}")
    check("⑩ 失败不泄露 + 有界退避：连续失败达阈值进入冷却后，**正确 token 也拒**（仍 401 固定体、无 Set-Cookie）、"
          "已提权会话也拿不到面板内容（冷却不产生任何成功）",
          status_cool == 401 and body_cool == FIXED_BODY.encode() and header_of(head_cool, "set-cookie") == ""
          and status_cool_page == 401 and body_cool_page == FIXED_BODY.encode(),
          f"冷却中正确 token → status={status_cool} cookie={header_of(head_cool, 'set-cookie')!r} "
          f"body={body_cool!r}；冷却中带会话读面板 → status={status_cool_page}")

    # ---------------------------------------------------------------------
    # ⑪ 回归：真 webui 三道未被弄坏（经代理的同前缀路径）
    # ---------------------------------------------------------------------
    health = get(f"{PREFIX}/api/health")
    ops = get(f"{PREFIX}/api/ops")
    contractor = get(f"{PREFIX}/contractor/")
    check("⑪ 回归：同前缀下既有三道未被弄坏（经代理的真 webui）/api/health 200、/api/ops 200、/contractor/ 200",
          health[0] == 200 and ops[0] == 200 and contractor[0] == 200,
          f"health={health[0]} ops={ops[0]} contractor={contractor[0]}（真 webui 端口 {webui_port}）")
except Exception as exc:  # noqa: BLE001
    check("端到端门执行异常（不得静默通过）", False, f"{type(exc).__name__}: {exc}")
finally:
    for proc in (admin_proc, webui_proc):
        if proc is None:
            continue
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

failed = [item for item in CHECKS if not item["ok"]]

# ---- T-265b：解阻塞提交面（宿主侧）——只落待处理项、账本零新增、不回显材料 ----
import hashlib as _hl
import os as _os
import stat as _stat

_BLOCK_ID = None
try:
    _blocks = json.loads(curl(f"http://127.0.0.1:{port}{prefix}/admin/api/blocks", cookie=cookie)[1])
    _BLOCK_ID = next((b["block_id"] for b in (_blocks.get("blocks") or [])), None)
except Exception:
    _BLOCK_ID = None

if _BLOCK_ID:
    _before = {}
    for _p in (ledger_contractor, ledger_supplier):
        try:
            _before[_p] = _hl.sha256(Path(_p).read_bytes()).hexdigest()
        except OSError:
            _before[_p] = None
    _sentinel = "SMTP-IMAP-CRED-SENTINEL-e2e"
    _code, _body = curl(f"http://127.0.0.1:{port}{prefix}/admin/api/blocks/{_BLOCK_ID}/resolve",
                        cookie=cookie, method="POST", data=f"kind=credential&material={_sentinel}")
    check("T-265b 提交面：带会话提交材料 → 202，响应体不回显材料（哨兵出现 0 次）",
          _code == 202 and _sentinel not in _body, f"status={_code} sentinel_in_body={_sentinel in _body}")
    _inbox = Path(__file__).resolve().parents[4] / "tmp" / "e2e-admin-inbox"
    check("T-265b 提交面：**账本零新增**（宿主不写账本；业务账本逐一比对哈希）",
          all((_before[_p] is None and not Path(_p).exists())
              or _hl.sha256(Path(_p).read_bytes()).hexdigest() == _before[_p]
              for _p in _before),
          f"before={list(_before.values())}")
    _c2, _ = curl(f"http://127.0.0.1:{port}{prefix}/admin/api/blocks/{_BLOCK_ID}/resolve", method="POST",
                  data="kind=credential&material=x")
    check("T-265b 提交面：无会话提交一律 401（写类提交不缺 token）", _c2 == 401, f"status={_c2}")
else:
    check("T-265b 提交面：夹具里至少有一条阻塞（否则本组断言空转）", False, "无 block 可用")

print(json.dumps({"checks": CHECKS, "passed": len(CHECKS) - len(failed), "total": len(CHECKS),
                  "failures": len(failed)}, ensure_ascii=False, indent=2))
for item in failed:
    print("FAIL:", item["name"], "|", item["detail"])
sys.exit(0 if not failed else 1)
