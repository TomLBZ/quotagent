#!/usr/bin/env python3
"""check-config-route —— 配置与凭据（P0 配置/凭据 UI 化 + YAML 持久化 + 配置文件初始化）端到端门。

`tools/verify.sh config-route`。真做七件事（**自带夹具**，不依赖 `tmp/` 演示数据）：

  ① 造夹具：一份**临时受管配置文件**（受管段 project/plugins/credentials + 非受管段 `other:`）、
     临时待处理目录、临时账本（一开始**不存在**，用来证"宿主不写账本"）、临时凭据目录、临时状态快照路径；
  ② 真起 `cli.mjs webui`（**A：夹具配置**；**B：真 `/workspace/config.yaml`，只读**；**C：运行期覆盖**），
     三个进程都是**真 cordis + 真 HTTP**，判定全部来自被测插件与 Python 写入者；
  ③ 未提权：配置与凭据的**四个读端点 + 四个写端点 + 未知子路径**一律 401 且 body 逐字节等于固定体（同形，无 oracle）；
  ④ 提权后：配置页 200 且 **0 行 `<script>` / 0 内联事件**；`/admin/api/config` 三层总览（每键 source/shadowed_by/editable）；
     `preview` 干跑（未知键 → `unknown-key`、`kernel.*` → `frozen`、`humanOnly` 缺引用 → `humanOnly`、合法键 → diff）
     —— 全过程 **`/workspace/config.yaml` 字节零变化**；
  ⑤ 提交：`202` + `payload_sha256`（64 位 hex）+ `next_action`；待处理项 **0600**（目录 0700）、
     **宿主零账本**（临时账本文件在提交后仍不存在）+ 业务账本零变化；
  ⑥ `tools/config-apply.py` 消费：YAML 字段值**能读回且逐字段一致**、非受管段字节不变、账本**恰好新增 N 行**且
     body **只出键名与新旧摘要**（无值）；凭据项落 **0600** 文件、账本只留 `sha256` 与指纹前 8 位、
     归档**不含明文**（修偏差 ③）、状态快照只含来源与指纹；**幂等**（同内容再提交一次 → 零落盘零账本）；
  ⑦ 哨兵：**任何响应体里凭据值出现次数 = 0**（含页面/JSON/审计视图/凭据视图），哨兵也不进账本与日志；
     另加三条机制性断言：**两侧 YAML 子集解析逐字节一致**、**登记表默认值与 `host/profiles.mjs` 同值（防漂移）**、
     **不支持的结构 → 拒且有 reason**（锚点/块标量/多文档/制表符/重复键各一例）。

**不动用户的配置**：本门只读 `/workspace/config.yaml`（开头结尾各算一次 sha256 比对）；一切写入都发生在 `tmp/` 下的夹具目录。
退出码：0 全通过 / 1 有断言失败 / 2 环境错误（与其它门同形）。
"""
from __future__ import annotations

import hashlib
import http.client
import importlib.util
import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
CHECKS: list[dict] = []
FIXED_BODY = '{"error":"unauthorized"}'
PREFIX = "/quotagent"
ADMIN = f"{PREFIX}/admin"
SENTINEL = "CFG-CRED-SENTINEL-8f31c2"
REAL_CONFIG = Path("/workspace/config.yaml")
TOKEN_ENV = "QUOTAGENT_ADMIN_TOKEN"


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})


def digest(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def request(port: int, method: str, path: str, body: str | None = None, headers: dict | None = None,
            timeout: float = 10.0):
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


def wait_http(port: int, path: str, want: int, tries: int = 80, timeout: float = 0.5) -> tuple[bool, int, bytes]:
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
# 夹具
# ---------------------------------------------------------------------------
FIXTURE_DIR = Path(tempfile.mkdtemp(prefix="t-config-route-", dir=str(ROOT / "tmp")))
CONFIG_PATH = FIXTURE_DIR / "config.yaml"
INBOX = FIXTURE_DIR / "config-submissions"
STATUS = FIXTURE_DIR / "config-status.json"
LEDGER = FIXTURE_DIR / "config-ledger.jsonl"
CREDS = FIXTURE_DIR / "creds"
ADMIN_INBOX = FIXTURE_DIR / "admin-submissions"
BIZ_LEDGER = FIXTURE_DIR / "biz-contractor.jsonl"
BIZ_LEDGER_SUPPLIER = FIXTURE_DIR / "biz-supplier.jsonl"
PARSER_PROBE = FIXTURE_DIR / "parser-probe.mjs"
NON_MANAGED = "other:\n  notes: 非受管段必须原样保留\n"

CONFIG_TEXT = ("# 夹具受管配置（受管段：project/plugins/credentials；非受管段：other）\n"
               "apiVersion: workspace/v1\n"
               "project:\n"
               "  pricing.markup_pct: 20\n"
               "  transport.kind: relay\n"
               "plugins:\n"
               '  "demo/demo-plugin":\n'
               "    markup_pct: 9\n"
               + NON_MANAGED)
CONFIG_PATH.write_text(CONFIG_TEXT, encoding="utf-8")
os.chmod(CONFIG_PATH, 0o600)
token = "cfg-gate-token-" + hashlib.sha256(SENTINEL.encode()).hexdigest()[:24]

# 哨兵面：所有响应体都收进来，最后统一断言"凭据值出现次数 = 0"
RESPONSES: list[bytes] = []


def get(port: int, path: str, cookie: str | None = None, headers: dict | None = None):
    head = dict(headers or {})
    if cookie:
        head["cookie"] = cookie
    status, got, body = request(port, "GET", path, headers=head)
    RESPONSES.append(body)
    return status, got, body


def post(port: int, path: str, payload: dict | str, cookie: str | None = None, content_type: str | None = None):
    if isinstance(payload, dict):
        body = json.dumps(payload, ensure_ascii=False)
        ctype = content_type or "application/json"
    else:
        body = str(payload)
        ctype = content_type or "application/x-www-form-urlencoded"
    head = {"content-type": ctype}
    if cookie:
        head["cookie"] = cookie
    status, got, out = request(port, "POST", path, body=body, headers=head)
    RESPONSES.append(out)
    return status, got, out


def as_json(body: bytes) -> dict:
    try:
        value = json.loads(body.decode() or "{}")
        return value if isinstance(value, dict) else {}
    except ValueError:
        return {}


def body_keys(value: dict) -> set:
    return set(value) if isinstance(value, dict) else set()


# 交叉语言探针：同一份夹具交给 JS 侧解析器，输出规范化 JSON（与 Python 侧逐字节比对）
PARSER_PROBE_SRC = """
import { parseYaml, canonical } from '%s'
import { readFileSync } from 'node:fs'
const fixtures = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const out = fixtures.map((item) => {
  const parsed = parseYaml(item.text)
  return parsed.ok ? { ok: true, canonical: canonical(parsed.value) } : { ok: false }
})
process.stdout.write(JSON.stringify(out))
""" % (ROOT / "host" / "lib" / "config-ui.mjs")
PARSER_PROBE.write_text(PARSER_PROBE_SRC, encoding="utf-8")
PARSER_FIXTURES = [
    {"name": "嵌套映射+标量", "text": "project:\n  pricing.markup_pct: 12.5\n  transport.kind: 'relay'\n"},
    {"name": "布尔/null/整数/负数", "text": "a: true\nb: false\nc: null\nd: 5\ne: -3\nf: ~\n"},
    {"name": "内联列表与内联映射", "text": "a: [1, two, true]\nb: {x: 1, y: two}\n"},
    {"name": "短横线列表", "text": "a:\n  - 1\n  - two\n"},
    {"name": "引号与注释", "text": "# 头注释\na: 'has: colon'  # 尾注释\nb: \"quoted\"\n"},
    {"name": "受管段（项目层）", "text": "project:\n  pricing.markup_pct: 20\n  transport.dir: inbox\n"},
    {"name": "锚点（不支持）", "text": "a: &anchor 1\n"},
    {"name": "别名（不支持）", "text": "a: *ref\n"},
    {"name": "块标量（不支持）", "text": "a: |\n  text\n"},
    {"name": "多文档（不支持）", "text": "a: 1\n---\nb: 2\n"},
    {"name": "制表符缩进（不支持）", "text": "a:\n\tb: 1\n"},
    {"name": "重复键（不支持）", "text": "a: 1\na: 2\n"},
]


def load_config_apply():
    spec = importlib.util.spec_from_file_location("config_apply_probe", ROOT / "src" / "system" / "config" / "tools" / "config-apply.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def apply_run(*extra: str, expect: int | None = None, inbox: Path | None = None, file: Path | None = None):
    """真跑 Python 写入者（**临时目录、临时账本**；绝不碰真文件）。"""
    cmd = [sys.executable, str(ROOT / "src" / "system" / "config" / "tools" / "config-apply.py"), "--file", str(file or CONFIG_PATH),
           "--ledger", str(LEDGER), "--approval-ref", "ap-0007", "--actor", "human:gate",
           "--now", "2026-09-21T00:00:00Z"]
    if inbox is not None:
        cmd += ["--inbox", str(inbox)]
    cmd += [item for item in extra if item]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    out = as_json((proc.stdout.strip().split("\n")[-1] if proc.stdout.strip() else "").encode())
    if expect is not None and proc.returncode != expect:
        raise AssertionError(f"config-apply 期望退出码 {expect}，实得 {proc.returncode}；stderr={proc.stderr[-400:]}")
    return proc, out


def ledger_rows() -> list:
    if not LEDGER.exists():
        return []
    return [json.loads(line) for line in LEDGER.read_text(encoding="utf-8").splitlines() if line.strip()]


# ---------------------------------------------------------------------------
# ① 夹具就绪
# ---------------------------------------------------------------------------
real_before = digest(REAL_CONFIG)
check("① 夹具自带（不依赖 tmp/ 演示数据）：临时受管配置（受管段 + 非受管段 `other:`，0600）、临时待处理目录、"
      "临时账本（**一开始不存在**，用来证宿主不写账本）、凭据目录、状态快照、解析探针；"
      "真 `/workspace/config.yaml` 只读（只算 sha256）",
      CONFIG_PATH.exists() and stat.S_IMODE(os.stat(CONFIG_PATH).st_mode) == 0o600
      and not LEDGER.exists() and not INBOX.exists() and PARSER_PROBE.exists()
      and len(token) >= 24 and FIXTURE_DIR.is_dir(),
      f"fixture_dir={FIXTURE_DIR}；哨兵={SENTINEL}；真配置 sha256={str(real_before)[:16]}…（只印摘要）")

# ---------------------------------------------------------------------------
# ② 起三个真服务
# ---------------------------------------------------------------------------
procs: list[subprocess.Popen] = []
ports: dict[str, int] = {}


def start_webui(label: str, extra: list[str]) -> int:
    port = free_port()
    env = dict(os.environ)
    env[TOKEN_ENV] = token
    cmd = ["node", str(ROOT / "host" / "cli.mjs"), "webui", "--profile", "webui", "--port", str(port),
           "--host", "127.0.0.1", "--prefix", PREFIX, "--ledger-contractor", str(BIZ_LEDGER),
           "--ledger-supplier", str(BIZ_LEDGER_SUPPLIER), "--admin-inbox", str(ADMIN_INBOX),
           "--config-inbox", str(INBOX), "--config-status", str(STATUS), "--config-ledger", str(LEDGER),
           *extra]
    proc = subprocess.Popen(cmd, cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    procs.append(proc)
    ok, status, _body = wait_http(port, f"{PREFIX}/api/health", 200)
    check(f"② 真 webui 进程就绪（{label}）", ok, f"port={port} status={status} cmd_extra={extra}")
    ports[label] = port
    return port


port_a = start_webui("A 夹具配置", ["--config-file", str(CONFIG_PATH)])
port_b = start_webui("B 真配置（只读）", ["--config-file", str(REAL_CONFIG)])
port_c = start_webui("C 运行期覆盖", ["--config-file", str(CONFIG_PATH),
                                     "--config-runtime-overrides", json.dumps({"pricing.markup_pct": 33})])

try:
    # 提权（只用 A 的会话做写类断言；B/C 只做只读断言）
    status_elevate, head_elevate, body_elevate = post(port_a, f"{ADMIN}/api/elevate", f"token={token}")
    cookie = header_of(head_elevate, "set-cookie").split(";")[0]
    check("② 提权取得管理员会话（session cookie 只对 admin 前缀生效）",
          status_elevate == 200 and cookie.startswith("qa_admin=") and token not in body_elevate.decode(),
          f"status={status_elevate} cookie 前缀={cookie[:12]}… 响应体含 token={token in body_elevate.decode()}")

    # -----------------------------------------------------------------------
    # ③ 未提权：四个读端点 + 四个写端点 + 未知子路径 —— 401 同形
    # -----------------------------------------------------------------------
    unauth: dict[str, tuple] = {}
    for target in (f"{ADMIN}/config/", f"{ADMIN}/api/config", f"{ADMIN}/api/credentials", f"{ADMIN}/api/config/audit"):
        unauth[f"GET {target}"] = get(port_a, target)
    for target in (f"{ADMIN}/api/config/preview", f"{ADMIN}/api/config/project",
                   f"{ADMIN}/api/config/plugins", f"{ADMIN}/api/credentials/mail_smtp"):
        unauth[f"POST {target}"] = post(port_a, target, 'key=pricing.markup_pct&value=1')
    for target in (f"{ADMIN}/api/config/nope", f"{ADMIN}/api/credentials/nope/nope", f"{ADMIN}/config/nope"):
        unauth[f"GET {target}"] = get(port_a, target)
    statuses = [item[0] for item in unauth.values()]
    bodies = [item[2] for item in unauth.values()]
    leak_words = ["pricing.markup_pct", "mail_smtp", "config_file", "credentials", "configured"]
    leaked = [word for word in leak_words if any(word.encode() in body for body in bodies)]
    check("③ 未提权：配置与凭据的**四个读端点 + 四个写端点 + 三个未知子路径**（共 11 路）一律 401，"
          "且 body **逐字节等于固定体**（不区分「路由不存在/缺 token/未启用」，不给 oracle）",
          statuses == [401] * len(unauth) and len(set(bodies)) == 1 and bodies[0] == FIXED_BODY.encode()
          and not leaked,
          f"路数={len(unauth)} status 去重={sorted(set(statuses))} body 去重={len(set(bodies))} "
          f"体={bodies[0]!r} 可疑键名泄漏={leaked or '无'}")

    # B（真配置文件实例）同样同形
    unauth_b = [get(port_b, f"{ADMIN}/config/"), get(port_b, f"{ADMIN}/api/config"),
                get(port_b, f"{ADMIN}/api/credentials"), get(port_b, f"{ADMIN}/api/config/audit")]
    check("③ 未提权（**指向真 `/workspace/config.yaml` 的实例**）同样读不出任何东西：四路 401 固定体",
          [item[0] for item in unauth_b] == [401] * 4
          and all(item[2] == FIXED_BODY.encode() for item in unauth_b),
          f"statuses={[item[0] for item in unauth_b]}")

    # -----------------------------------------------------------------------
    # ④ 提权后：页面 / 三层总览 / 干跑
    # -----------------------------------------------------------------------
    status_page, _head_page, page = get(port_a, f"{ADMIN}/config/", cookie=cookie)
    page_text = page.decode()
    inline_event = any(f' {name}=' in page_text for name in
                       ("onclick", "onsubmit", "onload", "onchange", "oninput"))
    status_overview, _h, overview_body = get(port_a, f"{ADMIN}/api/config", cookie=cookie)
    overview = as_json(overview_body)
    project_rows = {row.get("key"): row for row in (overview.get("project") or [])}
    cred_rows = {row.get("name"): row for row in (overview.get("credentials") or [])}
    plugin_rows = overview.get("plugin") or []
    mark = project_rows.get("pricing.markup_pct", {})
    check("④ 配置与凭据页（提权后）200 且 **0 行 `<script>` / 0 内联事件**：一屏含三层（project/plugin/credential）"
          "与「提交 ≠ 生效」的说明；JSON 总览给出 `layers`、每键 `source`/`shadowed_by`/`editable`/`sources`、"
          "凭据行给 `required_mode`/`next_action` 且**没有值字段**",
          status_page == 200 and "<script" not in page_text and not inline_event
          and 'data-layer="project"' in page_text and 'data-layer="plugin"' in page_text
          and 'data-layer="credential"' in page_text
          and status_overview == 200 and overview.get("layers") == ["project", "plugin", "credential"]
          and mark.get("source") == "file" and mark.get("value") == 20 and mark.get("shadowed_by") is None
          and mark.get("editable") is True and isinstance(mark.get("editable"), bool)
          and mark.get("sources") == ["default", "file"] and mark.get("in_file") is True
          and (plugin_rows and plugin_rows[0].get("target") == "demo/demo-plugin"
               and plugin_rows[0]["keys"][0].get("key") == "markup_pct")
          and all(row.get("required_mode") == "0600" and row.get("next_action")
                  and "value" not in row for row in cred_rows.values())
          and all(row.get("source") in ("default", "file", "env", "runtime") for row in project_rows.values()),
          f"page={status_page} 长度={len(page_text)} 含 <script>={'<script' in page_text} 内联事件={inline_event}；"
          f"markup_pct source={mark.get('source')} 值={mark.get('value')} shadowed_by={mark.get('shadowed_by')} "
          f"editable={mark.get('editable')} 同现层={mark.get('sources')}；插件行={len(plugin_rows)}；"
          f"凭据行={sorted(cred_rows)}（字段={sorted(body_keys(cred_rows.get('mail_smtp', {}))) if cred_rows else []}）")

    # 运行期层（C 实例）：source=runtime 且 shadowed_by 报出被压住的 file 层。
    # 注意：会话是**每进程内存**（admin-guard 的会话表随 fiber 回收）→ 必须对 C 单独提权。
    status_elevate_c, head_c, _body_c = post(port_c, f"{ADMIN}/api/elevate", f"token={token}")
    cookie_c = header_of(head_c, "set-cookie").split(";")[0]
    status_c, _hc, ov_c = get(port_c, f"{ADMIN}/api/config", cookie=cookie_c)
    rows_c = {row.get("key"): row for row in (as_json(ov_c).get("project") or [])}
    mark_c = rows_c.get("pricing.markup_pct", {})
    check("④ 层合入顺序（低 → 高：default → file → env → runtime）：运行期覆盖生效时 `source=runtime`，"
          "且 `shadowed_by` **显式报出被压住的 file 层**（不静默赢）",
          status_c == 200 and mark_c.get("source") == "runtime" and mark_c.get("value") == 33
          and "file" in str(mark_c.get("shadowed_by")) and mark_c.get("sources") == ["default", "file", "runtime"],
          f"source={mark_c.get('source')} 值={mark_c.get('value')} shadowed_by={mark_c.get('shadowed_by')} "
          f"sources={mark_c.get('sources')}")

    # 干跑：四种判定 + 真配置文件字节零变化
    real_mid = digest(REAL_CONFIG)
    fixture_before = digest(CONFIG_PATH)
    p_unknown = as_json(post(port_a, f"{ADMIN}/api/config/preview", {"layer": "project", "target": "project",
                                                                    "fields": {"nope.key": 1}}, cookie)[2])
    p_frozen = as_json(post(port_a, f"{ADMIN}/api/config/preview", {"layer": "project", "target": "project",
                                                                   "fields": {"kernel.x": 1}}, cookie)[2])
    p_human = as_json(post(port_a, f"{ADMIN}/api/config/preview", {"layer": "project", "target": "project",
                                                                  "fields": {"guard.abnormal_low_ratio": 0.5}}, cookie)[2])
    p_human_ref = as_json(post(port_a, f"{ADMIN}/api/config/preview", {"layer": "project", "target": "project",
                                                                      "fields": {"guard.abnormal_low_ratio": 0.5},
                                                                      "human_approval_ref": "ap-0007"}, cookie)[2])
    p_ok = as_json(post(port_a, f"{ADMIN}/api/config/preview", {"layer": "project", "target": "project",
                                                               "fields": {"pricing.markup_pct": 12.5}}, cookie)[2])
    p_type = as_json(post(port_a, f"{ADMIN}/api/config/preview", {"layer": "project", "target": "project",
                                                                 "fields": {"pricing.markup_pct": "not-a-number"}}, cookie)[2])
    p_cred = as_json(post(port_a, f"{ADMIN}/api/config/preview", {"layer": "credential", "target": "mail_smtp",
                                                                 "fields": {"value": SENTINEL}}, cookie)[2])
    p_yaml = as_json(post(port_a, f"{ADMIN}/api/config/preview", {"layer": "project", "target": "project",
                                                                 "fields": {}, "yaml_text": "a: &anchor 1"}, cookie)[2])
    real_after_preview = digest(REAL_CONFIG)
    check("④ 干跑（`preview`）**零落盘零生效**：未知键 → `unknown-key`；`kernel.*` → `frozen`（永拒）；"
          "`humanOnly` 缺人工引用 → `humanOnly`、带 `ap-NNNN` → 受理；类型不符 → `type-mismatch`；"
          "合法键 → 出 diff（old/new + 两个摘要）；凭据 dry-run 的 diff **只给摘要与指纹前 8 位**；"
          "不支持的 YAML（锚点）→ 拒且有 reason（`unsupported-yaml`）；"
          "**夹具文件与真 `/workspace/config.yaml` 都字节零变化**",
          p_unknown.get("accepted") is False and any(item.get("code") == "unknown-key" for item in p_unknown.get("reasons") or [])
          and p_frozen.get("vetoed_by") == "frozen"
          and p_human.get("accepted") is False and any(item.get("code") == "humanOnly" for item in p_human.get("reasons") or [])
          and p_human_ref.get("accepted") is True
          and p_ok.get("accepted") is True and len(p_ok.get("diff") or []) == 1
          and p_ok["diff"][0]["new"] == 12.5 and p_ok["diff"][0]["old"] == 20
          and p_ok["diff"][0]["new_digest"] != p_ok["diff"][0]["old_digest"]
          and p_type.get("accepted") is False and any(item.get("code") == "type-mismatch" for item in p_type.get("reasons") or [])
          and p_cred.get("accepted") is True and p_cred["diff"][0].get("new") is None
          and len(str(p_cred["diff"][0].get("new_fingerprint_first8"))) == 8
          and p_yaml.get("accepted") is False and p_yaml.get("vetoed_by") == "unsupported-yaml"
          and fixture_before == digest(CONFIG_PATH) and real_mid == real_after_preview,
          f"unknown={p_unknown.get('vetoed_by')} frozen={p_frozen.get('vetoed_by')} human={p_human.get('vetoed_by')} "
          f"human+ref={p_human_ref.get('accepted')} ok_diff={len(p_ok.get('diff') or [])} type={p_type.get('vetoed_by')} "
          f"cred_diff_keys={sorted(body_keys((p_cred.get('diff') or [{}])[0]))} yaml={p_yaml.get('vetoed_by')}；"
          f"夹具字节不变={fixture_before == digest(CONFIG_PATH)} 真配置字节不变={real_mid == real_after_preview}")

    # -----------------------------------------------------------------------
    # ⑤ 提交：只落 0600 待处理项；宿主零账本
    # -----------------------------------------------------------------------
    ledger_before_submit = digest(LEDGER)
    biz_before = (digest(BIZ_LEDGER), digest(BIZ_LEDGER_SUPPLIER))
    s_project = post(port_a, f"{ADMIN}/api/config/project", {"fields": {"pricing.markup_pct": 12.5}}, cookie)
    project_receipt = as_json(s_project[2])
    s_plugin = post(port_a, f"{ADMIN}/api/config/plugins", {"layer": "plugin", "target": "demo/demo-plugin",
                                                            "fields": {"markup_pct": 11}}, cookie)
    plugin_receipt = as_json(s_plugin[2])
    s_plugin_path = post(port_a, f"{ADMIN}/api/config/plugins/demo/demo-plugin",
                         {"fields": {"enabled": True}}, cookie)
    s_plugin_path_receipt = as_json(s_plugin_path[2])
    s_cred = post(port_a, f"{ADMIN}/api/credentials/mail_smtp", {"value": SENTINEL}, cookie)
    cred_receipt = as_json(s_cred[2])
    s_cred_unknown = post(port_a, f"{ADMIN}/api/credentials/not-registered", f"value={SENTINEL}", cookie)
    s_project_bad = post(port_a, f"{ADMIN}/api/config/project", {"fields": {"nope.key": 1}}, cookie)
    s_project_bad_body = as_json(s_project_bad[2])
    pending = sorted(INBOX.glob("*.json")) if INBOX.exists() else []
    pending_modes = [oct(stat.S_IMODE(os.stat(path).st_mode)) for path in pending]
    inbox_mode = oct(stat.S_IMODE(os.stat(INBOX).st_mode)) if INBOX.exists() else None
    check("⑤ 提交只落 **0600** 待处理项（目录 0700）：项目 → `202` + `payload_sha256`(64 hex) + `next_action`；"
          "插件（body 与 `/<ns>/<plugin>` 两种形状）同样 202；凭据提交**只回 `{ok,next_action}`**（不回显值/摘要）；"
          "未知键提交被拒（409，不落件）；未登记的凭据名被拒（409，不落件）",
          s_project[0] == 202 and len(str(project_receipt.get("payload_sha256"))) == 64
          and "config-apply.py" in str(project_receipt.get("next_action"))
          and s_plugin[0] == 202 and s_plugin_path[0] == 202 and s_cred[0] == 202
          and body_keys(cred_receipt) == {"ok", "next_action"} and cred_receipt.get("ok") is True
          and SENTINEL not in json.dumps(cred_receipt, ensure_ascii=False)
          and s_cred_unknown[0] == 409 and s_project_bad[0] == 409 and s_project_bad_body.get("ok") is False
          and len(pending) == 4 and pending_modes == ["0o600"] * len(pending) and inbox_mode == "0o700",
          f"project={s_project[0]} plugin={s_plugin[0]}/{s_plugin_path[0]} cred={s_cred[0]}"
          f"（回执键={sorted(body_keys(cred_receipt))}） unknown-cred={s_cred_unknown[0]} bad-key={s_project_bad[0]}；"
          f"待处理项={len(pending)} 权限={pending_modes} 目录={inbox_mode}")

    biz_after = (digest(BIZ_LEDGER), digest(BIZ_LEDGER_SUPPLIER))
    check("⑤ **宿主零写面（H1）**：提交之后配置账本**仍不存在**（`config-ledger.jsonl` 一个字节都没写）、"
          "业务账本哈希零变化 —— 落账本只能由 Python 侧做",
          digest(LEDGER) == ledger_before_submit and digest(LEDGER) is None and biz_after == biz_before,
          f"配置账本存在={LEDGER.exists()}（before={ledger_before_submit}）业务账本 before={biz_before} after={biz_after}")

    # -----------------------------------------------------------------------
    # ⑥ Python 侧消费：YAML 值可读回一致 / 账本只出摘要 / 凭据不回显 / 幂等
    # -----------------------------------------------------------------------
    proc, receipt = apply_run("--inbox", str(INBOX), "--cred-dir", str(CREDS), "--status", str(STATUS), expect=0)
    module = load_config_apply()
    back = module.read_managed_sections(CONFIG_PATH.read_text(encoding="utf-8"))
    rows = ledger_rows()
    changed = [row for row in rows if row.get("type") == "config/changed"]
    rotated = [row for row in rows if row.get("type") == "credential/rotated"]
    body_key_ok = all(set(row["body"]) == set(module.BODY_KEYS[row["type"]]) for row in rows)
    values_in_ledger = any(SENTINEL in json.dumps(row, ensure_ascii=False) for row in rows)
    check("⑥ `config-apply.py` 消费：退出码 0；**YAML 字段值能读回且逐字段一致**"
          "（project.pricing.markup_pct=12.5、plugins.demo/demo-plugin、credentials 段只登记指针）；"
          "**非受管段 `other:` 字节不变**；账本恰好新增 N 行 `config/changed`/`credential/rotated` 且"
          "**body 只出键名与新旧摘要**（键集与契约逐字相等、无值）；凭据项落 **0600** 文件",
          proc.returncode == 0 and receipt.get("ok") is True and receipt.get("ledger_added") == 4
          and back.get("project", {}).get("pricing.markup_pct") == 12.5
          and back.get("plugins", {}).get("demo/demo-plugin", {}).get("markup_pct") == 11
          and back.get("plugins", {}).get("demo/demo-plugin", {}).get("enabled") is True
          and (back.get("credentials", {}).get("mail_smtp", {}) or {}).get("required_mode") == "0600"
          and "非受管段必须原样保留" in CONFIG_PATH.read_text(encoding="utf-8")
          and NON_MANAGED in CONFIG_PATH.read_text(encoding="utf-8")
          and len(changed) == 3 and len(rotated) == 1 and body_key_ok and not values_in_ledger
          and (CREDS / "mail_smtp.secret").exists()
          and stat.S_IMODE(os.stat(CREDS / "mail_smtp.secret").st_mode) == 0o600,
          f"exit={proc.returncode} applied={len(receipt.get('applied') or [])} 账本新增={receipt.get('ledger_added')}"
          f"（changed={len(changed)} rotated={len(rotated)}）；回读 project={back.get('project')}；"
          f"plugins={back.get('plugins')}；凭据段键={sorted((back.get('credentials') or {}).get('mail_smtp', {}))}；"
          f"非受管段保留={'非受管段必须原样保留' in CONFIG_PATH.read_text(encoding='utf-8')}；"
          f"body 键集与契约相符={body_key_ok}；账本含哨兵={values_in_ledger}")

    # 复盘归档（不删源）+ 明文不残留 + 状态快照 + 幂等
    archive = sorted((INBOX / "applied").glob("*.json")) if (INBOX / "applied").is_dir() else []
    archive_text = "\n".join(path.read_text(encoding="utf-8") for path in archive)
    leftover = sorted(path.name for path in INBOX.glob("*.json"))
    status_payload = as_json(STATUS.read_bytes()) if STATUS.exists() else {}
    status_text = STATUS.read_text(encoding="utf-8") if STATUS.exists() else ""
    fingerprint = hashlib.sha256(SENTINEL.encode()).hexdigest()[:8]
    fingerprint_ok = (status_payload.get("credentials", {}).get("mail_smtp", {}) or {}).get("fingerprint_first8") == fingerprint
    # 幂等：同内容再提交一次（走 UI 再提交 + 再消费）；文件与账本必须零变化
    cfg_bytes, ledger_bytes = CONFIG_PATH.read_bytes(), (LEDGER.read_bytes() if LEDGER.exists() else b"")
    post(port_a, f"{ADMIN}/api/config/project", {"fields": {"pricing.markup_pct": 12.5}}, cookie)
    apply_run("--inbox", str(INBOX), "--cred-dir", str(CREDS), "--status", str(STATUS), expect=0)
    check("⑥ 幂等：同一内容再提交一次 → 消费端判 `duplicate`（零落盘零账本，YAML 与账本**字节不变**）；"
          "归档**不删源**（待处理项移入 `applied/`）且**凭据明文不残留**（归档里值出现 0 次，只留 sha256 与指纹前 8）；"
          "状态快照只写来源/权限/指纹前 8（`fingerprint_first8 == sha256(值)[:8]`，且不含值）",
          archive and not leftover and SENTINEL not in archive_text
          and "plaintext_removed" in archive_text and fingerprint_ok and SENTINEL not in status_text
          and CONFIG_PATH.read_bytes() == cfg_bytes and (LEDGER.read_bytes() if LEDGER.exists() else b"") == ledger_bytes
          and json.loads(archive_text.splitlines()[0]).get("fields", {}).get("value") is None,
          f"归档={len(archive)} 件 收件箱残留={leftover or '无'} 归档含哨兵={SENTINEL in archive_text} "
          f"状态快照指纹={fingerprint_ok}（期望 {fingerprint}）YAML 字节不变={CONFIG_PATH.read_bytes() == cfg_bytes} "
          f"账本字节不变={(LEDGER.read_bytes() if LEDGER.exists() else b'') == ledger_bytes}")

    # -----------------------------------------------------------------------
    # ⑦ UI 读回一致 + 审计 + 哨兵零出现
    # -----------------------------------------------------------------------
    _s, _h, overview2_body = get(port_a, f"{ADMIN}/api/config", cookie=cookie)
    overview2 = as_json(overview2_body)
    rows2 = {row.get("key"): row for row in (overview2.get("project") or [])}
    mark2 = rows2.get("pricing.markup_pct", {})
    _s, _h, creds2_body = get(port_a, f"{ADMIN}/api/credentials", cookie=cookie)
    creds2 = as_json(creds2_body)
    cred2 = {row.get("name"): row for row in (creds2.get("rows") or [])}.get("mail_smtp", {})
    _s, _h, audit_body = get(port_a, f"{ADMIN}/api/config/audit", cookie=cookie)
    audit = as_json(audit_body)
    audit_types = [row.get("type") for row in (audit.get("rows") or [])]
    audit_has_values = any(SENTINEL in json.dumps(row, ensure_ascii=False) for row in (audit.get("rows") or []))
    audit_cfg_page = get(port_a, f"{ADMIN}/config/", cookie=cookie)[2].decode()
    check("⑦ **提交 → Python 消费 → UI 读回一致**：`/admin/api/config` 里该键 `source=file`、值 == 落盘值；"
          "`/admin/api/credentials` 里 `configured=true`、`source=file`、`required_mode=0600`、"
          "`fingerprint_first8 == sha256(值)[:8]`；`/admin/api/config/audit` 只读给出账本行（含旧/新摘要与 actor）；"
          "配置页刷新后同样反映新值",
          mark2.get("source") == "file" and mark2.get("value") == 12.5
          and cred2.get("configured") is True and cred2.get("source") == "file"
          and cred2.get("required_mode") == "0600" and cred2.get("fingerprint_first8") == fingerprint
          and cred2.get("fingerprint_source") == "python-status-snapshot"
          and audit.get("degraded") is False and "config/changed" in audit_types
          and "credential/rotated" in audit_types and not audit_has_values
          and any(row.get("old_digest") and row.get("new_digest") for row in audit.get("rows") or [])
          and "12.5" in audit_cfg_page,
          f"overview source={mark2.get('source')} 值={mark2.get('value')}；凭据 configured={cred2.get('configured')} "
          f"source={cred2.get('source')} 指纹={cred2.get('fingerprint_first8')}（期望 {fingerprint}）"
          f"指纹来源={cred2.get('fingerprint_source')}；审计行={len(audit.get('rows') or [])} types={sorted(set(audit_types))} "
          f"含值={audit_has_values}")

    blob = b"\n".join(RESPONSES)
    check("⑦ **凭据值在响应体里出现次数 = 0**（哨兵测法，面覆盖页面/JSON/凭据视图/审计视图/干跑回执）："
          "所有响应体里都搜不到哨兵；grep 计数逐路为 0；日志（宿主 stdout）里同样为 0",
          SENTINEL.encode() not in blob and blob.count(SENTINEL.encode()) == 0 and len(blob) > 5000,
          f"响应面 {len(blob)} 字节；哨兵出现次数={blob.count(SENTINEL.encode())}；"
          f"页面含哨兵={SENTINEL in audit_cfg_page}")

    # -----------------------------------------------------------------------
    # ⑧ 真配置文件字节零变化（门全程）
    # -----------------------------------------------------------------------
    real_after = digest(REAL_CONFIG)
    check("⑧ 门全程真 `/workspace/config.yaml` **字节不变**（宿主配置面只读；本门只读它、并把它作为 B 实例的受管文件）",
          real_after == real_before and real_after is not None,
          f"before={str(real_before)[:16]}… after={str(real_after)[:16]}…（只印摘要）")

    # -----------------------------------------------------------------------
    # ⑨ 配置文件初始化 + 不支持的结构
    # -----------------------------------------------------------------------
    init_path = FIXTURE_DIR / "init-config.yaml"
    proc_init, init_receipt = (None, None)
    init_cmd = [sys.executable, str(ROOT / "src" / "system" / "config" / "tools" / "config-apply.py"), "--init", "--file", str(init_path),
                "--ledger", str(FIXTURE_DIR / "init-ledger.jsonl"), "--actor", "human:gate",
                "--now", "2026-09-21T00:00:00Z"]
    proc_init = subprocess.run(init_cmd, capture_output=True, text=True)
    init_text = init_path.read_text(encoding="utf-8") if init_path.exists() else ""
    init_mode = oct(stat.S_IMODE(os.stat(init_path).st_mode)) if init_path.exists() else None
    init_bytes = init_path.read_bytes() if init_path.exists() else b""
    proc_init2 = subprocess.run(init_cmd, capture_output=True, text=True)
    check("⑨ `--init`：文件不存在时从**内置模板**生成（0600、含注释说明每一段是什么、值用占位符、三段受管段齐备）；"
          "文件已存在时**拒**（不覆盖用户配置，字节零变化）；模板本身能被同一子集解析",
          proc_init.returncode == 0 and init_mode == "0o600"
          and init_text.count("#") >= 6 and all(marker in init_text for marker in
                                                ("层 1", "层 2", "层 3", "占位符", "凭据值不写在本文档"))
          and "project:" in init_text and "plugins:" in init_text and "credentials:" in init_text
          and load_config_apply().read_managed_sections(init_text) == {"project": {}, "plugins": {}, "credentials": {}}
          and proc_init2.returncode == 2 and init_path.read_bytes() == init_bytes,
          f"init exit={proc_init.returncode} mode={init_mode} 模板字节={len(init_bytes)} "
          f"注释行={init_text.count('#')} 三段说明齐备={all(marker in init_text for marker in ('层 1', '层 2', '层 3'))} "
          f"再 init exit={proc_init2.returncode} 字节不变={init_path.read_bytes() == init_bytes}")

    bad_cases = {
        "锚点": "project:\n  pricing.markup_pct: &anchor 1\n",
        "块标量": "project:\n  pricing.markup_pct: |\n    20\n",
        "多文档": "project:\n  pricing.markup_pct: 20\n---\nb: 1\n",
        "制表符缩进": "project:\n\tpricing.markup_pct: 20\n",
        "重复键": "project:\n  pricing.markup_pct: 20\n  pricing.markup_pct: 21\n",
    }
    bad_results = {}
    for label, text in bad_cases.items():
        path = FIXTURE_DIR / f"bad-{abs(hash(label)) % 100000}.yaml"
        path.write_text(text, encoding="utf-8")
        before = path.read_bytes()
        item_inbox = FIXTURE_DIR / f"bad-inbox-{abs(hash(label)) % 100000}"
        item_inbox.mkdir(parents=True, exist_ok=True)
        fields = {"pricing.markup_pct": 3}
        canonical = json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        item = {"request_id": hashlib.sha256(canonical.encode()).hexdigest()[:16], "layer": "project",
                "target": "project", "fields": fields,
                "payload_sha256": hashlib.sha256(canonical.encode()).hexdigest(),
                "bytes": len(canonical.encode()), "schema": 1, "submitted_at": None, "submitted_by": "gate"}
        item_path = item_inbox / "cfg-bad.json"
        item_path.write_text(json.dumps(item), encoding="utf-8")
        os.chmod(item_path, 0o600)
        proc_bad, receipt_bad = apply_run("--inbox", str(item_inbox), "--cred-dir", str(CREDS), expect=2, file=path)
        reason = (receipt_bad.get("refused") or [{}])[0].get("reason", "")
        rows_bad = ledger_rows()
        refused_rows = [row for row in rows_bad if row.get("type") == "config/refused"]
        bad_results[label] = {"reason": reason, "unchanged": path.read_bytes() == before,
                              "refused_rows": len(refused_rows)}
    check("⑨ **不支持的结构 → 拒且有 reason**（锚点 / 块标量 / 多文档 / 制表符缩进 / 重复键 五例）："
          "`config-apply.py` 退出码 2、refused.reason 含 `unsupported-yaml`、**目标文件字节零变化**、"
          "且被拒的变更各落 **1 行** `config/refused`（被拒也留痕，但拒绝理由只给原因码，不出值）",
          all(item["reason"].startswith("unsupported-yaml") and item["unchanged"] for item in bad_results.values())
          and all(item["refused_rows"] >= 1 for item in bad_results.values()),
          "；".join(f"{label}: reason={item['reason']} 字节不变={item['unchanged']}" for label, item in bad_results.items()))

    # -----------------------------------------------------------------------
    # ⑩ 机制性断言：两侧解析一致 + 默认值不漂移
    # -----------------------------------------------------------------------
    probe_path = FIXTURE_DIR / "parser-fixtures.json"
    probe_path.write_text(json.dumps(PARSER_FIXTURES, ensure_ascii=False), encoding="utf-8")
    probe = subprocess.run(["node", str(PARSER_PROBE), str(probe_path)], capture_output=True, text=True,
                           cwd=str(ROOT))
    js_results = json.loads(probe.stdout or "[]")
    module = load_config_apply()
    py_results = []
    for item in PARSER_FIXTURES:
        try:
            py_results.append({"ok": True, "canonical": module.canonical(module.parse_yaml(item["text"]))})
        except module.YamlError:
            py_results.append({"ok": False})
    mismatches = [PARSER_FIXTURES[index]["name"] for index, (left, right) in enumerate(zip(js_results, py_results))
                  if left != right]
    check("⑩ **YAML 子集的跨语言一致性**（`host/lib/config-ui.mjs` vs `tools/config-apply.py`）："
          f"同一份夹具（{len(PARSER_FIXTURES)} 例，含 6 例可解析 + 6 例必须拒）两侧的**解析结果规范化 JSON 逐字节相等**"
          "（防漂移：宿主与写入者不许各理解一套）",
          len(js_results) == len(py_results) == len(PARSER_FIXTURES) and not mismatches,
          f"夹具={len(PARSER_FIXTURES)} 例；不一致={mismatches or '无'}；"
          f"JS 可解析={sum(1 for item in js_results if item['ok'])} Python 可解析={sum(1 for item in py_results if item['ok'])}")

    keys_text = (ROOT / "src" / "system" / "config" / "code" / "config-keys.mjs").read_text(encoding="utf-8")
    profiles_text = (ROOT / "host" / "profiles.mjs").read_text(encoding="utf-8")
    import re as _re
    declared = {}
    for match in _re.finditer(r"'([^']+)':\s*\{\s*type:\s*'([a-z]+)',\s*default:\s*([^,}]+)", keys_text):
        declared[match.group(1)] = match.group(3).strip()
    drift, compared = [], 0
    for key, default in declared.items():
        leaf = key.split(".")[-1]
        found = _re.search(rf"\b{_re.escape(leaf)}:\s*([^,\n}}]+)", profiles_text)
        if not found:
            continue
        compared += 1
        want = default.strip().strip("'\"")
        got = found.group(1).strip().strip("'\"")
        same = (want == got) or (want.replace(".0", "") == got.replace(".0", ""))
        if not same:
            drift.append(f"{key}: registry={want} profiles={got}")
    check("⑩ 登记表默认值**不许与 `host/profiles.mjs` 漂移**（同一个键两处不同 = 页面显示的默认值是假的）："
          "逐键比对同名叶子键的字面量，必须同值",
          not drift and compared >= 10 and len(declared) >= 15,
          f"登记键={len(declared)} 可比对={compared} 漂移={drift or '无'}")

    # -----------------------------------------------------------------------
    # ⑪ py_compile（写入者必须能被标准库解释器加载）
    # -----------------------------------------------------------------------
    compile_proc = subprocess.run([sys.executable, "-m", "py_compile", str(ROOT / "src" / "system" / "config" / "tools" / "config-apply.py")],
                                  capture_output=True, text=True)
    check("⑪ `python3 -m py_compile tools/config-apply.py` 通过（标准库、无第三方依赖）",
          compile_proc.returncode == 0, f"exit={compile_proc.returncode} stderr={compile_proc.stderr[-200:]}")

except Exception as exc:  # noqa: BLE001
    check("端到端门执行异常（不得静默通过）", False, f"{type(exc).__name__}: {exc}")
finally:
    for proc in procs:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

failed = [item for item in CHECKS if not item["ok"]]
print(json.dumps({"checks": CHECKS, "passed": len(CHECKS) - len(failed), "total": len(CHECKS),
                  "failures": len(failed), "fixture_dir": str(FIXTURE_DIR),
                  "sentinel_used": SENTINEL, "real_config_sha256_before": real_before,
                  "real_config_sha256_after": digest(REAL_CONFIG)}, ensure_ascii=False, indent=2))
for item in failed:
    print("FAIL:", item["name"], "|", item["detail"])
sys.exit(0 if not failed else 1)
