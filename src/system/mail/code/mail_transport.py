"""`services.mail_transport` —— 邮件的**真实传输层**：SMTP 发信 / IMAP 收信（纯标准库，零第三方依赖）。

为什么单独一个文件：`services/mail.py` 的 AC-MAIL-001 有一条第 4 号断言**静态扫描** mail.py 的
import：出现 `smtplib`/`imaplib`/`poplib`/`socket`/`subprocess` 即红（D-052 写死"本轮不真收发"）。
凭据就位后要真收发，就得**另起一个模块**承载网络面，而不是把 smtplib 塞进 mail.py —— 这样
"邮件域的原生语义"与"网络传输"各自可被独立验证，也让那条断言继续有意义（它守的是 mail.py 的边界）。

八条纪律（逐条落在代码里；门 `tools/verify.sh mail-transport` 逐条断言）：

1. **做不到就直说，且分清"没配"与"连不上"**：未配置 → `{"available": false, "connected": false,
   "configured": false, "reason": "mail-smtp-unconfigured"|"mail-imap-unconfigured", "next_action": ...}`，
   一个字节都不会发出去；配置齐了但连不上/认证失败/被拒 → `smtp-unreachable` / `smtp-auth-failed` /
   `smtp-recipients-refused` ...（**不同故障不同 reason**，不许糊成一句"失败了"）。
2. **环境变量优先于配置文件**：每个键按 ① `QUOTAGENT_MAIL_<SVC>_<KEY>`、
   ② `QUOTAGENT_CONFIG_MAIL__<SVC>__<KEY>`（与 `host/lib/config-keys.mjs` 的 `envNameFor` 同形）、
   ③ 配置文件的 `project` 受管段里点分键 `mail.<svc>.<key>`（`tools/config-apply.py` 写的那一份）
   的顺序取值；高优先层命中即**不再看低层**（是分层覆盖，不是合并）。
3. **凭据永不外泄**：`status()`/`snapshot()`/账本行/返回值里**没有任何值**（只有布尔、来源名、计数、
   原因码与 `message_id`）；所有异常文本与原因说明一律先过 `sanitize()`（把已知密钥换成 `<redacted>`）
   再对外报——`password` 尤其不许进异常消息。
4. **只按证据报"可用"**：`available=true` 要求 `configured ∧ 最近一次真实尝试成功`；配置齐了但还没试过 →
   `mail-smtp-unprobed` + 可行动 `next_action`（**不**因为"看起来配好了"就说能用）。
5. **真发出去才有 `mail/sent`**：`send()` 只有在 SMTP 服务端对 DATA 回 250（接收）之后才落
   `mail/sent`（`class=fact`；body 无凭据、无正文）；连不上/被拒**不落** `mail/sent`。
6. **有界收信**：`fetch_recent(limit)` 只取**最新 limit 封**（夹到 `MAX_FETCH`），返回体报
   `truncated` / `truncated_reason`；单封的**返回大小**夹到 `max_message_bytes`（夹了报 `clipped`）。
   **如实登记**：标准库 `imaplib` 是一次性取回整封的，所以"有界"指**取回条数与返回体**，不是线上
   传输量——不假装成流式。
7. **确定性**：`status()` 对同一份配置 + 同一份状态文件两次调用**逐字节一致**（本模块不把墙钟写进
   任何状态字段；时间戳只来自状态文件里"上一次尝试"的记录）。
8. **状态快照**：每次真实尝试后**原子写**一份 0600 状态文件（只含布尔/来源/计数/原因码 + 最近
   `MAX_ATTEMPTS` 条尝试的 kind/ok/reason/message_id/at）——宿主 `mail-view` 读的就是它
   （宿主不读配置、不联网、不发信：真正收发只在 Python 侧）。

【未验证 / 边界（如实登记，不假装）】
· 只做明文-`starttls` 与 `ssl` 两种握手（`plain` 仅用于回环测试/内网明文中继）；**不做** OAuth2/XOAUTH2、
  不做 SMTPUTF8、不做 IMAP IDLE、不做 DKIM 签名。
· **没有**凭据文件层（`credentials:` 段 → 0600 文件）：本批只做环境变量与 `project:` 点分键，
  凭据文件层留待下一批（登记在 `docs/design/14-plugin-inventory.md`）。
· IMAP 只取整封 `RFC822`：正文进 `body_sha256`（不进账本、不进状态文件），附件只报**计数**。
· `max_message_bytes` 夹的是**返回体**（`clip_text`），`body_sha256` 仍按收到的整封算——这样"内容摘要"
  与"我们留下来多少"两件事不会被混成一件。
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import smtplib
import ssl
import sys
import time
from email.parser import BytesParser
from email.policy import default as DEFAULT_POLICY
from email.utils import getaddresses
from pathlib import Path
from typing import Any

from ..kernel.canon import HASH_PREFIX, sha256_hex
from ..paths import repo_root, scratch_root

__all__ = [
    "MailTransport", "MailTransportError", "SANITIZED",
    "SERVICES", "KNOWN_KEYS", "REQUIRED_KEYS", "SECRET_KEYS", "DEFAULT_PORTS", "DEFAULT_SECURITY",
    "SECURITY_VALUES", "REASON_NEXT_ACTION", "MAX_ATTEMPTS", "MAX_FETCH", "MAX_MESSAGE_BYTES",
    "DEFAULT_TIMEOUT_SECONDS", "DEFAULT_MAX_MESSAGES", "DEFAULT_CONFIG_PATH",
    "sanitize", "load_managed_sections", "config_values", "env_names_for",
]

# --- 常量：键集、默认值、上限（**单一处**，不散落） --------------------------------------------
SERVICES = ("smtp", "imap")
#: 每服务的已知键（不在表里的键**不看也不记名**——名字泄漏本身就是踩过的坑）
KNOWN_KEYS = {
    "smtp": ("host", "port", "username", "password", "from", "security"),
    "imap": ("host", "port", "username", "password", "mailbox", "security"),
}
#: 必填键（缺一 = **未配置**；不猜、不默认一个"看着像"的服务器）
REQUIRED_KEYS = {"smtp": ("host", "port", "from"), "imap": ("host", "port")}
#: 值不得外泄的键（`sanitize()` 的重点对象；永不进原因文本/账本/状态文件）
SECRET_KEYS = ("password",)
DEFAULT_PORTS = {"smtp": 587, "imap": 993}
DEFAULT_SECURITY = {"smtp": "starttls", "imap": "ssl"}
SECURITY_VALUES = {"smtp": ("starttls", "ssl", "plain"), "imap": ("ssl", "plain")}
DEFAULT_CONFIG_PATH = "/workspace/config.yaml"
DEFAULT_TIMEOUT_SECONDS = 5
DEFAULT_MAX_MESSAGES = 20
#: 一次收信最多取回几封 / 单封返回体最多几字节 / 状态文件里最多留几条尝试
MAX_FETCH = 50
MAX_MESSAGE_BYTES = 65536
MAX_ATTEMPTS = 20
#: 密钥被洗掉后的统一替身（**不是**密钥本身，也不是它的任何派生）
SANITIZED = "<redacted>"

#: 原因码 → 可行动的下一步（闭合词表：门据此断言"每个 reason 都有 next_action"）
REASON_NEXT_ACTION = {
    "mail-smtp-unconfigured":
        "把 SMTP 接入点配置：mail.smtp.host / port / from（凭据 mail.smtp.username / password 可选）。"
        "环境变量 QUOTAGENT_MAIL_SMTP_HOST 等优先于 /workspace/config.yaml 的 project 段；"
        "配好后先真发一封或调 probe('smtp')，本服务只按证据报可用",
    "mail-imap-unconfigured":
        "把 IMAP 接入点配置：mail.imap.host / port（凭据 mail.imap.username / password 可选）。"
        "环境变量 QUOTAGENT_MAIL_IMAP_HOST 等优先于 /workspace/config.yaml 的 project 段",
    "mail-smtp-unprobed":
        "配置已齐但还没有一次真实发送/探测成功：调 send(...) 或 probe('smtp') 拿证据；"
        "在那之前本服务不报 available=true",
    "mail-imap-unprobed":
        "配置已齐但还没有一次真实收信/探测成功：调 fetch_recent(...) 或 probe('imap') 拿证据；"
        "在那之前本服务不报 available=true",
    "mail-smtp-config-changed":
        "接入点在这之后被改过（主机/端口/握手/发件人/账号有无）：**旧的成功不算新配置的证据**，"
        "请用当前配置重跑一次 probe('smtp') 或 send(...)",
    "mail-imap-config-changed":
        "接入点在这之后被改过（主机/端口/握手/邮箱/账号有无）：**旧的成功不算新配置的证据**，"
        "请用当前配置重跑一次 probe('imap') 或 fetch_recent(...)",
    "smtp-unreachable": "确认 mail.smtp.host / port 可达（主机名解析、防火墙、端口、服务是否在跑）后重试",
    "imap-unreachable": "确认 mail.imap.host / port 可达（主机名解析、防火墙、端口、服务是否在跑）后重试",
    "smtp-tls-failed": "TLS 握手失败：检查 mail.smtp.security（starttls / ssl / plain）与证书链",
    "imap-tls-failed": "TLS 握手失败：检查 mail.imap.security（ssl / plain）与证书链",
    "smtp-auth-failed": "认证被拒：检查 mail.smtp.username / password；本层只做 LOGIN / PLAIN，"
                        "不支持 OAuth2/XOAUTH2",
    "imap-auth-failed": "认证被拒：检查 mail.imap.username / password；本层只做 LOGIN / PLAIN",
    "smtp-disconnected": "服务器中途断开：重试或核对服务端连接上限（本服务不做自动重试）",
    "smtp-send-failed": "SMTP 交互失败：看上面的 reason 与 stderr 里的服务端应答，修正后重试",
    "smtp-recipients-refused": "收件人被服务器全部拒绝：核对收件人地址与服务器的转发策略",
    "imap-read-failed": "IMAP 读失败：核对 mail.imap.mailbox 是否存在、账号权限与服务端上限",
    "mail-message-not-sendable":
        "send() 需要**原始报文字节**：给 raw=<bytes|str>，或传一个带原生字节的 Message"
        "（services/mail.py 的 compose 产物、Message.raw_bytes / bytes(msg)）",
    "mail-smtp-security-unknown": "mail.smtp.security 只接受 starttls / ssl / plain",
    "mail-imap-security-unknown": "mail.imap.security 只接受 ssl / plain",
    "mail-config-unreadable":
        "配置文件读不到或不是本子集支持的 YAML：先修 /workspace/config.yaml，或把 "
        "QUOTAGENT_MAIL_CONFIG 指到正确的文件（子集：嵌套映射/标量/简单列表/内联 {}/[]）",
    "mail-config-parser-unavailable":
        "YAML 子集解析器（tools/config-apply.py，唯一真源）加载失败：确认仓库完整（该文件是白名单真源）",
    "mail-state-unreadable":
        "状态文件不是合法 JSON：删掉它或修成合法 JSON（它只记录布尔/来源/计数，删掉不会丢事实）",
}


class MailTransportError(RuntimeError):
    """传输层错误基类（对外只出**洗过的**消息，见 `sanitize`）。"""


# ======================================================================
# 纯函数：清洗、键名、YAML 子集
# ======================================================================
def sanitize(text: Any, secrets: Any = None) -> str:
    """把文本里出现的**已知密钥**替换成 `<redacted>`；空白折叠、长度夹取。

    为什么不是"只处理 password"：任何被当成密钥的字符串（密码、token、带凭据的 URL 片段）都可能在
    异常消息里出现，所以这里接受一个**密钥列表**，逐个替换。替换是**按长度倒序**做的（长的先替，
    避免短密钥是长密钥的子串时留下尾巴）。
    """
    out = "" if text is None else str(text)
    values = [item for item in (secrets or []) if isinstance(item, str) and item]
    for item in sorted(set(values), key=len, reverse=True):
        out = out.replace(item, SANITIZED)
    return " ".join(out.split())[:400]


def env_names_for(service: str, key: str) -> tuple:
    """键 → 环境变量名（**两种写法都认**，与 `host/lib/config-keys.mjs` 的 `envNameFor` 同形）。

    ① `QUOTAGENT_MAIL_SMTP_HOST`（本服务专用写法，好记）
    ② `QUOTAGENT_CONFIG_MAIL__SMTP__HOST`（配置 UI 登记的通用覆盖名，见 config-keys.mjs）
    """
    prefix = str(service).upper()
    suffix = str(key).upper()
    return (f"QUOTAGENT_MAIL_{prefix}_{suffix}", f"QUOTAGENT_CONFIG_MAIL__{prefix}__{suffix}")


_PARSER_CACHE: dict = {}


def _parser_module() -> tuple:
    """加载 `tools/config-apply.py`（YAML 子集与受管段的**唯一真源**）——不写第二份解析器。

    失败不抛：返回 `(None, reason)`，由调用方如实报 `mail-config-parser-unavailable`。
    """
    if "module" in _PARSER_CACHE:
        return _PARSER_CACHE["module"], _PARSER_CACHE["reason"]
    module, reason = None, ""
    try:
        path = Path(repo_root()) / "src" / "system" / "config" / "tools" / "config-apply.py"
        spec = importlib.util.spec_from_file_location("quotagent_tools_config_apply", path)
        candidate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(candidate)
        if not hasattr(candidate, "read_managed_sections"):
            raise MailTransportError("config-apply.py 里没有 read_managed_sections")
        module = candidate
    except Exception as exc:  # noqa: BLE001 —— 加载失败要如实报，不是崩掉调用方
        reason = sanitize(f"{type(exc).__name__}: {exc}")
    _PARSER_CACHE["module"], _PARSER_CACHE["reason"] = module, reason
    return module, reason


def load_managed_sections(path: Any) -> tuple:
    """读配置文件的受管三段（`project` / `plugins` / `credentials`）。返回 `(dict|None, reason)`。

    文件不存在 = 没有文件层（返回 `({}, "")`，**不是**错误）；解析不出来 → `(None, reason码)`。
    """
    module, reason = _parser_module()
    if module is None:
        return None, "mail-config-parser-unavailable"
    target = Path(str(path or ""))
    if not target.exists():
        return {}, ""
    try:
        return module.read_managed_sections(target.read_text(encoding="utf-8")), ""
    except Exception:  # noqa: BLE001 —— 子集不支持/坏 YAML：如实报，不猜
        return None, "mail-config-unreadable"


def config_values(path: Any, env: Any = None) -> dict:
    """配置文件的 `project` 受管段 → `{"mail.smtp.host": "..."}` 形式的**点分键扁平表**（只有键与值）。

    `env` 为空时读 `os.environ`。**返回值含配置值**（含 `mail.*.password` 若写在文件里）：
    调用方不得把它直接打印/落账本；对外只经 `MailTransport.status()`（那里只有来源名）。
    """
    sections, reason = load_managed_sections(path)
    if sections is None:
        return {"__reason__": reason}
    project = sections.get("project") if isinstance(sections.get("project"), dict) else {}
    out: dict = {}
    for key, value in project.items():
        if isinstance(value, (dict, list)):
            continue                      # 嵌套结构不进点分表（子集里 project 段是"点分键 → 标量"）
        out[str(key)] = value
    return out


# ======================================================================
# 传输层
# ======================================================================
class MailTransport:
    """SMTP/IMAP 的真实传输（**唯一**的网络出口；宿主与 mail.py 都不碰网络）。"""

    name = "smtp-imap"
    kind = "mail"

    def __init__(self, *, env: Any = None, config_path: Any = None, state_path: Any = None,
                 timeout_seconds: Any = None, max_messages: Any = None,
                 max_message_bytes: Any = None) -> None:
        # `env=None` → 读 `os.environ`；显式给一个 dict（含 `{}`）就不再读进程环境（测试靠它隔离）
        self._env = None if env is None else {str(k): str(v) for k, v in env.items()}
        self._config_path = None if config_path is None else str(config_path)
        self._state_path = None if state_path is None else str(state_path)
        self._timeout_seconds = _positive_int(timeout_seconds, DEFAULT_TIMEOUT_SECONDS, 1, 120)
        self._max_messages = _positive_int(max_messages, DEFAULT_MAX_MESSAGES, 1, MAX_FETCH)
        self._max_message_bytes = _positive_int(max_message_bytes, MAX_MESSAGE_BYTES, 1, 10 * 1024 * 1024)

    # ---------------------------------------------------------------- 配置
    def _env_get(self, name: str) -> Any:
        source = os.environ if self._env is None else self._env
        value = source.get(name)
        return None if value is None else str(value)

    @property
    def config_path(self) -> str:
        """配置文件落点：显式参数 → `QUOTAGENT_MAIL_CONFIG` → `/workspace/config.yaml`。"""
        if self._config_path is not None:
            return self._config_path
        return self._env_get("QUOTAGENT_MAIL_CONFIG") or DEFAULT_CONFIG_PATH

    @property
    def state_path(self) -> str:
        """状态文件落点（**懒解析**：构造时不碰文件系统）：`QUOTAGENT_MAIL_STATE` → `<tmp>/mail/transport-state.json`。"""
        if self._state_path is not None:
            return self._state_path
        explicit = self._env_get("QUOTAGENT_MAIL_STATE")
        if explicit:
            return explicit
        return str(Path(scratch_root()) / "mail" / "transport-state.json")

    @property
    def timeout_seconds(self) -> int:
        return self._timeout_seconds

    @property
    def max_messages(self) -> int:
        return self._max_messages

    @property
    def max_message_bytes(self) -> int:
        return self._max_message_bytes

    def settings(self, service: str) -> tuple:
        """`(生效值, 每键来源)` —— **只在内部用**（返回的 dict 含密钥，不得打印/落账本/进返回值）。"""
        keys = KNOWN_KEYS[service]
        file_layer = config_values(self.config_path, self._env)
        file_reason = file_layer.pop("__reason__", "") if isinstance(file_layer, dict) else ""
        values: dict = {}
        sources: dict = {}
        for key in keys:
            name = f"mail.{service}.{key}"
            for env_name in env_names_for(service, key):
                raw = self._env_get(env_name)
                if raw is not None and raw != "":
                    values[key] = raw
                    sources[key] = "env"
                    break
            if key in values:
                continue
            if name in file_layer and file_layer[name] not in (None, ""):
                values[key] = file_layer[name]
                sources[key] = "file"
                continue
            values[key] = None
            sources[key] = "missing"
        # 默认层（只对**有默认值**的键；必填键没有默认值）
        for key in keys:
            if values.get(key) is not None:
                continue
            if key == "port":
                values[key] = DEFAULT_PORTS[service]
                sources[key] = "default"
            elif key == "security":
                values[key] = DEFAULT_SECURITY[service]
                sources[key] = "default"
            elif key == "mailbox":
                values[key] = "INBOX"
                sources[key] = "default"
        if file_reason:
            values["__file_reason__"] = file_reason
        return values, sources

    def missing_keys(self, service: str) -> list:
        """必填键里**没有生效值**的那些（`port` 有默认值，所以只有 host/from 会缺）。"""
        values, _sources = self.settings(service)
        missing = []
        for key in REQUIRED_KEYS[service]:
            if values.get(key) in (None, ""):
                missing.append(key)
        return missing

    def declared(self, service: str) -> dict:
        """**无值**的配置面：每键在不在、来源是哪一层（给 `status()` 与运维看）。"""
        values, sources = self.settings(service)
        return {
            "keys": {key: {"source": sources.get(key, "missing"),
                           "present": values.get(key) not in (None, ""),
                           "secret": key in SECRET_KEYS}
                     for key in KNOWN_KEYS[service]},
            "missing": self.missing_keys(service),
            "file_reason": values.get("__file_reason__", ""),
        }

    def config_fingerprint(self, service: str) -> str:
        """当前生效配置的**无值**指纹（改过接入点 → 旧的成功就不再是本配置的证据）。

        材料只含主机/端口/握手/邮箱/发件人 + **账号与口令"有没有"两个布尔**：
        指纹里不可能出现任何密钥（`password` 的值从不参与）。
        """
        values, _sources = self.settings(service)
        material = {
            "service": service,
            "host": str(values.get("host") or ""),
            "port": _port_of(values.get("port"), DEFAULT_PORTS[service]),
            "security": str(values.get("security") or DEFAULT_SECURITY[service]),
            "mailbox": str(values.get("mailbox") or "") if service == "imap" else "",
            "from": str(values.get("from") or "") if service == "smtp" else "",
            "has_username": bool(values.get("username")),
            "has_password": bool(values.get("password")),
        }
        return HASH_PREFIX + sha256_hex(json.dumps(material, sort_keys=True, ensure_ascii=False).encode("utf-8"))

    # ---------------------------------------------------------------- 状态文件（宿主读的那份）
    def _read_state(self) -> tuple:
        path = self.state_path
        try:
            raw = Path(path).read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}, ""
        except OSError:
            return {}, "mail-state-unreadable"
        try:
            payload = json.loads(raw)
        except ValueError:
            return {}, "mail-state-unreadable"
        if not isinstance(payload, dict):
            return {}, "mail-state-unreadable"
        return payload, ""

    def _write_state(self, attempt: dict) -> dict:
        """原子写状态文件（0600）：只留布尔/来源/计数/原因码 + 最近 `MAX_ATTEMPTS` 条尝试。"""
        previous, _reason = self._read_state()
        attempts = previous.get("attempts") if isinstance(previous.get("attempts"), list) else []
        last = previous.get("last") if isinstance(previous.get("last"), dict) else {}
        service = str(attempt.get("service") or "")
        if service in SERVICES:
            last[service] = dict(attempt)
        merged = ([dict(attempt)] + [item for item in attempts if isinstance(item, dict)])[:MAX_ATTEMPTS]
        payload = {
            "schema": 1,
            "service": "mail-transport",
            "updated_at": _utc_now(),
            "last": {key: last[key] for key in SERVICES if key in last},
            "attempts": merged,
            "note": "只含布尔/来源/计数/原因码与 message_id：不含任何凭据值、不含邮件正文",
        }
        path = Path(self.state_path)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.parent / f".{path.name}.tmp.{os.getpid()}"
            with open(tmp, "w", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=1) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
            return {"written": True, "attempts": len(merged), "path_configured": True}
        except OSError as exc:
            return {"written": False, "reason": sanitize(f"{type(exc).__name__}"), "attempts": len(merged)}

    # ---------------------------------------------------------------- 只读状态
    def status(self) -> dict:
        """**只读**的传输状态：顶层是 **SMTP（发信链）** 的摘要，另有 `smtp`/`imap` 两段明细。

        顶层 `available/connected/configured/reason/next_action` 就是契约 §3 那三件的所在（`connected`
        是本层新增的**证据位**：只有真连上过才是 true）。不联网、不写账本、不读墙钟 → 两次调用逐字节一致。
        """
        state, state_reason = self._read_state()
        last = state.get("last") if isinstance(state.get("last"), dict) else {}
        attempts = state.get("attempts") if isinstance(state.get("attempts"), list) else []
        out_services = {}
        for service in SERVICES:
            out_services[service] = self._service_status(service, last.get(service))
        smtp = out_services["smtp"]
        return {
            "service": "mail",
            "transport": self.name,
            "available": smtp["available"],
            "connected": smtp["connected"],
            "configured": smtp["configured"],
            "reason": smtp["reason"],
            "next_action": smtp["next_action"],
            "smtp": out_services["smtp"],
            "imap": out_services["imap"],
            "last_attempt": _attempt_view(attempts[0]) if attempts and isinstance(attempts[0], dict) else None,
            "attempts": [_attempt_view(item) for item in attempts[:MAX_ATTEMPTS] if isinstance(item, dict)],
            "state": {"configured": bool(state), "readable": not state_reason, "reason": state_reason,
                      "attempts_recorded": len(attempts)},
            "limits": {"timeout_seconds": self._timeout_seconds, "max_messages": self._max_messages,
                       "max_message_bytes": self._max_message_bytes, "max_fetch": MAX_FETCH,
                       "max_attempts": MAX_ATTEMPTS},
            "credentials_included": False,
            "note": "只有布尔/来源/计数/原因码与 message_id：没有任何凭据值，也没有邮件正文",
        }

    def snapshot(self) -> dict:
        """给 Python 侧快照写入器用的一层包装（`generated_at` 只在这里出现，不进 `status()`）。"""
        payload = self.status()
        payload["generated_at"] = _utc_now()
        return payload

    def _service_status(self, service: str, last: Any) -> dict:
        declared = self.declared(service)
        missing = declared["missing"]
        base = {"service": service, "configured": not missing, "connected": False, "available": False,
                "reason": "", "next_action": "", "missing": missing, "keys": declared["keys"]}
        if declared["file_reason"]:
            base.update({"reason": declared["file_reason"], "next_action": REASON_NEXT_ACTION[declared["file_reason"]]})
            return base
        if missing:
            code = f"mail-{service}-unconfigured"
            base.update({"reason": code, "next_action": REASON_NEXT_ACTION[code]})
            return base
        if not isinstance(last, dict) or not last:
            code = f"mail-{service}-unprobed"
            base.update({"reason": code, "next_action": REASON_NEXT_ACTION[code]})
            return base
        # 接入点被改过 → **旧的成功不算新配置的证据**（否则换个坏主机还会显示"可用"）
        recorded = str(last.get("config_fingerprint") or "")
        if recorded and recorded != self.config_fingerprint(service):
            code = f"mail-{service}-config-changed"
            base.update({"reason": code, "next_action": REASON_NEXT_ACTION[code]})
            return base
        if last.get("ok") is True:
            base.update({"connected": True, "available": True, "reason": "",
                         "next_action": "", "last_at": str(last.get("at") or "")})
            return base
        code = str(last.get("reason") or f"mail-{service}-unprobed")
        base.update({"reason": code, "next_action": str(last.get("next_action") or
                                                       REASON_NEXT_ACTION.get(code, ""))})
        return base

    # ---------------------------------------------------------------- 发信
    def send(self, message: Any = None, *, raw: Any = None, ledger: Any = None,
             ts: Any = None, correlation_id: Any = None) -> dict:
        """把一封报文**真发出去**（SMTP）；未配置 → 立刻返回 `available:false` + reason + next_action。

        `message`：`services/mail.py` 的 Message 视图（带原生字节）或任何能把报文交出来的视图；
        `raw`：直接给报文字节/文本（与 `message` 二选一，`raw` 优先）。
        只有服务端**接收**（DATA 后的 250）才返回 `sent: true` 并落 `mail/sent`；其余一律 `sent: false`。
        """
        data, data_reason = _message_bytes(message, raw)
        envelope = _envelope_of(data)
        attempt = {"kind": "send", "service": "smtp", "ok": False, "reason": "", "next_action": "",
                   "message_id": envelope.get("message_id"), "at": _utc_now(),
                   "config_fingerprint": self.config_fingerprint("smtp")}
        if data is None:
            return self._refuse("smtp", "mail-message-not-sendable", attempt,
                                extra={"bytes": 0, "to": [], "from": ""})
        values, _sources = self.settings("smtp")
        missing = self.missing_keys("smtp")
        if missing:
            return self._refuse("smtp", "mail-smtp-unconfigured", attempt,
                                extra={"bytes": len(data), "missing": missing,
                                       "to": envelope.get("to", []), "from": values.get("from") or ""})
        security = str(values.get("security") or DEFAULT_SECURITY["smtp"]).lower()
        if security not in SECURITY_VALUES["smtp"]:
            return self._refuse("smtp", "mail-smtp-security-unknown", attempt,
                                extra={"bytes": len(data), "security": security})
        secrets = [values.get("password"), values.get("username")]
        host = str(values.get("host"))
        port = _port_of(values.get("port"), DEFAULT_PORTS["smtp"])
        server = f"{host}:{port}"
        accepted: list = []
        refused: list = []
        partial = False
        try:
            conn = self._smtp_connect(host, port, security, secrets)
        except Exception as exc:  # noqa: BLE001 —— 连不上/握不上手：分类报，不假装
            code = _classify(exc, "smtp", secrets, stage="connect")
            return self._refuse("smtp", code, attempt, extra={"bytes": len(data), "server": server,
                                                              "detail": _detail(exc, secrets)})
        try:
            username = values.get("username")
            if username:
                conn.login(str(username), str(values.get("password") or ""))
            recipients = list(envelope.get("to") or [])
            # `sendmail()` 返回的是**被拒**收件人的映射（不是"成功列表"）：接受与否要自己算，
            # 别把它当成 (accepted, refused) 两元组（那个坑踩过一次：空 dict 解包直接 ValueError）。
            refused_map = conn.sendmail(str(values.get("from")), recipients, data) or {}
            refused = sorted(str(item) for item in refused_map)
            accepted = [item for item in recipients if item not in refused]
            partial = bool(refused) and bool(accepted)
            conn.quit()
        except Exception as exc:  # noqa: BLE001
            code = _classify(exc, "smtp", secrets, stage="send")
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
            return self._refuse("smtp", code, attempt, extra={"bytes": len(data), "server": server,
                                                              "detail": _detail(exc, secrets)})
        if refused and not accepted:
            return self._refuse("smtp", "smtp-recipients-refused", attempt,
                                extra={"bytes": len(data), "server": server, "refused": sorted(refused)})
        ledger_ref = self._record_sent(ledger, envelope=envelope, data=data, server=server,
                                       accepted=sorted(accepted), refused=sorted(refused),
                                       ts=ts, correlation_id=correlation_id)
        attempt.update({"ok": True, "reason": "", "next_action": ""})
        state = self._write_state(attempt)
        return {
            "ok": True, "sent": True, "available": True, "connected": True, "configured": True,
            "service": "smtp", "reason": "", "next_action": "", "server": server, "security": security,
            "message_id": envelope.get("message_id"), "bytes": len(data),
            "to": envelope.get("to", []), "from": values.get("from") or "",
            "accepted": accepted, "refused_recipients": refused, "partial": partial,
            "body_sha256": HASH_PREFIX + sha256_hex(data), "ledger": ledger_ref, "state": state,
            "credentials_included": False,
        }

    def _smtp_connect(self, host: str, port: int, security: str, secrets: list) -> Any:
        """按 `security` 建立 SMTP 会话（`plain` 只用于回环/内网明文中继）。"""
        context = ssl.create_default_context()
        if security == "ssl":
            conn = smtplib.SMTP_SSL(host, port, timeout=self._timeout_seconds, context=context)
        else:
            conn = smtplib.SMTP(host, port, timeout=self._timeout_seconds)
        conn.ehlo()
        if security == "starttls":
            conn.starttls(context=context)
            conn.ehlo()
        return conn

    def _record_sent(self, ledger: Any, *, envelope: dict, data: bytes, server: str,
                     accepted: list, refused: list, ts: Any, correlation_id: Any) -> Any:
        """落 `mail/sent`（`class=fact`；**只有真发出去才走这里**）。

        body 里**没有**凭据、没有正文：只有 `message_id` / 收发件人 / `body_sha256` / 字节数 /
        `server`（host:port）/ 被接收与被拒的收件人。`mail/sent` 故意**不**登记进内核事件表
        （AC-MAIL-001 第 2 号断言守着"`mail/sent` 未声明"），所以这里直接经 Ledger 追加事实行。
        """
        if ledger is None:
            return None
        body = {
            "message_id": envelope.get("message_id") or "",
            "to": list(envelope.get("to") or []),
            "from": str(envelope.get("from") or ""),
            "subject": str(envelope.get("subject") or ""),
            "body_sha256": HASH_PREFIX + sha256_hex(data),
            "bytes": len(data),
            "transport": "smtp",
            "server": server,
            "accepted": list(accepted),
            "refused_recipients": list(refused),
            "ok": True,
            "reason": "",
        }
        try:
            ref = ledger.append("mail/sent", body, event_class="fact", actor="agent:mail-transport",
                                ts=ts, correlation_id=correlation_id or body["message_id"] or None,
                                refs={"message_id": body["message_id"]} if body["message_id"] else None)
        except Exception as exc:  # noqa: BLE001 —— 账本拒绝就是拒绝：如实报，不吞
            return {"event": "mail/sent", "written": False, "reason": sanitize(f"{type(exc).__name__}")}
        return {"event": "mail/sent", "written": True, "seq": int(ref.seq), "duplicate": bool(ref.duplicate)}

    # ---------------------------------------------------------------- 收信
    def fetch_recent(self, limit: Any = None, *, ledger: Any = None, ts: Any = None) -> dict:
        """取**最新** `limit` 封入站报文（IMAP）；未配置 → `available:false` + reason + next_action。

        有界：条数夹到 `[1, MAX_FETCH]`、单封**返回体**夹到 `max_message_bytes`；两者任一被夹都报
        `truncated=True` 与 `truncated_reason`。`body_sha256` 按**收到的整封**算（与"留下多少"分开）。
        """
        wanted = _positive_int(limit, self._max_messages, 1, MAX_FETCH)
        attempt = {"kind": "fetch", "service": "imap", "ok": False, "reason": "", "next_action": "",
                   "message_id": None, "at": _utc_now(),
                   "config_fingerprint": self.config_fingerprint("imap")}
        values, _sources = self.settings("imap")
        missing = self.missing_keys("imap")
        if missing:
            return self._refuse("imap", "mail-imap-unconfigured", attempt,
                                extra={"limit": wanted, "messages": [], "count": 0, "missing": missing})
        security = str(values.get("security") or DEFAULT_SECURITY["imap"]).lower()
        if security not in SECURITY_VALUES["imap"]:
            return self._refuse("imap", "mail-imap-security-unknown", attempt,
                                extra={"limit": wanted, "messages": [], "count": 0, "security": security})
        secrets = [values.get("password"), values.get("username")]
        host = str(values.get("host"))
        port = _port_of(values.get("port"), DEFAULT_PORTS["imap"])
        server = f"{host}:{port}"
        mailbox = str(values.get("mailbox") or "INBOX")
        try:
            import imaplib  # 局部导入：只有真要走 IMAP 时才碰这个模块
        except Exception as exc:  # noqa: BLE001
            return self._refuse("imap", "imap-read-failed", attempt,
                                extra={"limit": wanted, "messages": [], "count": 0,
                                       "detail": _detail(exc, secrets)})
        conn = None
        try:
            if security == "ssl":
                conn = imaplib.IMAP4_SSL(host, port, timeout=self._timeout_seconds)
            else:
                conn = imaplib.IMAP4(host, port, timeout=self._timeout_seconds)
            if values.get("username"):
                conn.login(str(values.get("username")), str(values.get("password") or ""))
            typ, payload = conn.select(mailbox, readonly=True)
            if str(typ).upper() != "OK":
                raise MailTransportError("select 未返回 OK")
            total = _exists_of(conn, payload)
            if total == 0:
                conn.logout()
                attempt.update({"ok": True})
                state = self._write_state(attempt)
                return {"ok": True, "sent": False, "available": True, "connected": True, "configured": True,
                        "service": "imap", "reason": "", "next_action": "", "server": server,
                        "mailbox": mailbox, "count": 0, "fetched": 0, "total": 0, "limit": wanted,
                        "truncated": False, "truncated_reason": "", "messages": [], "state": state,
                        "credentials_included": False}
            start = max(1, total - wanted + 1)
            typ, data = conn.fetch(f"{start}:{total}", "(RFC822)")
            if str(typ).upper() != "OK":
                raise MailTransportError("fetch 未返回 OK")
            messages = [_inbound_view(item, self._max_message_bytes) for item in (data or [])
                        if isinstance(item, tuple) and len(item) >= 2 and item[1]]
            conn.logout()
        except Exception as exc:  # noqa: BLE001
            code = _classify(exc, "imap", secrets, stage="read")
            if conn is not None:
                try:
                    conn.logout()
                except Exception:  # noqa: BLE001
                    pass
            return self._refuse("imap", code, attempt,
                                extra={"limit": wanted, "messages": [], "count": 0, "server": server,
                                       "detail": _detail(exc, secrets)})
        clipped = sum(1 for item in messages if item.get("clipped"))
        truncated = total > len(messages) or clipped > 0
        reason = ("mailbox-has-more" if total > len(messages) else ("message-clipped" if clipped else ""))
        attempt.update({"ok": True})
        state = self._write_state(attempt)
        return {
            "ok": True, "sent": False, "available": True, "connected": True, "configured": True,
            "service": "imap", "reason": "", "next_action": "", "server": server, "mailbox": mailbox,
            "count": len(messages), "fetched": len(messages), "total": total, "limit": wanted,
            "truncated": truncated, "truncated_reason": reason, "clipped_messages": clipped,
            "messages": messages, "state": state, "credentials_included": False,
            "note": "有界的是取回条数与返回体（标准库 imaplib 一次性取回整封）",
        }

    # ---------------------------------------------------------------- 探测
    def probe(self, service: str = "smtp") -> dict:
        """真连一次（不做业务动作）来拿"能不能用"的证据；结果同样进状态文件。

        SMTP：连接 + 握手（+ 认证，如果配了账号）→ 记 ok；IMAP：连接 + 登录 + `select` → 记 ok。
        未配置 → 与 `send()`/`fetch_recent()` 同形的拒绝（**不**因为"探测"就跳过配置门）。
        """
        target = str(service or "smtp").lower()
        if target not in SERVICES:
            return {"ok": False, "available": False, "connected": False, "configured": False,
                    "reason": "mail-service-unknown",
                    "next_action": "probe() 只接受 'smtp' 或 'imap'"}
        values, _sources = self.settings(target)
        missing = self.missing_keys(target)
        attempt = {"kind": "probe", "service": target, "ok": False, "reason": "", "next_action": "",
                   "message_id": None, "at": _utc_now(),
                   "config_fingerprint": self.config_fingerprint(target)}
        if missing:
            return self._refuse(target, f"mail-{target}-unconfigured", attempt, extra={"missing": missing})
        security = str(values.get("security") or DEFAULT_SECURITY[target]).lower()
        if security not in SECURITY_VALUES[target]:
            return self._refuse(target, f"mail-{target}-security-unknown", attempt, extra={"security": security})
        secrets = [values.get("password"), values.get("username")]
        host = str(values.get("host"))
        port = _port_of(values.get("port"), DEFAULT_PORTS[target])
        try:
            if target == "smtp":
                conn = self._smtp_connect(host, port, security, secrets)
                if values.get("username"):
                    conn.login(str(values.get("username")), str(values.get("password") or ""))
                conn.quit()
            else:
                import imaplib  # 局部导入（同 fetch_recent）
                ssl_ = ssl.create_default_context()
                conn = (imaplib.IMAP4_SSL(host, port, timeout=self._timeout_seconds) if security == "ssl"
                        else imaplib.IMAP4(host, port, timeout=self._timeout_seconds))
                if values.get("username"):
                    conn.login(str(values.get("username")), str(values.get("password") or ""))
                conn.select(str(values.get("mailbox") or "INBOX"), readonly=True)
                conn.logout()
        except Exception as exc:  # noqa: BLE001
            code = _classify(exc, target, secrets, stage="connect")
            return self._refuse(target, code, attempt,
                                extra={"server": f"{host}:{port}", "detail": _detail(exc, secrets)})
        attempt.update({"ok": True})
        state = self._write_state(attempt)
        return {"ok": True, "available": True, "connected": True, "configured": True, "service": target,
                "reason": "", "next_action": "", "server": f"{host}:{port}", "state": state,
                "credentials_included": False}

    # ---------------------------------------------------------------- 拒绝路径（统一形状）
    def _refuse(self, service: str, reason_code: str, attempt: dict, *, extra: Any = None) -> dict:
        """**唯一**的失败出口：洗过文本、记状态、返回与成功分支同形的 dict（`sent` 恒为 false）。"""
        next_action = REASON_NEXT_ACTION.get(reason_code, "看 reason 与上一步的服务端应答，修正后重试")
        attempt.update({"ok": False, "reason": reason_code, "next_action": next_action})
        state = self._write_state(attempt)
        out = {
            "ok": False, "sent": False, "available": False, "connected": False,
            "configured": reason_code not in (f"mail-{service}-unconfigured",),
            "service": service, "reason": reason_code, "next_action": next_action,
            "message_id": attempt.get("message_id"), "state": state, "credentials_included": False,
        }
        for key, value in (extra or {}).items():
            out[key] = value
        return out


# ======================================================================
# 模块级辅助（纯函数；不碰网络）
# ======================================================================
def _utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _positive_int(value: Any, fallback: int, lower: int, upper: int) -> int:
    """配置/参数夹取：非整数或越界一律落到允许区间内（确定性，不抛错）。"""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return min(upper, max(lower, number))


def _port_of(value: Any, fallback: int) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError):
        return fallback
    return port if 0 < port < 65536 else fallback


def _detail(exc: Any, secrets: Any) -> str:
    """异常 → **洗过的**一行文本（异常类名 + 洗过的消息）：异常消息里不许出现任何密钥。"""
    return sanitize(f"{type(exc).__name__}: {exc}", secrets)


def _classify(exc: Any, service: str, secrets: Any, *, stage: str = "connect") -> str:
    """异常 → 具体的 reason 码（**不同故障不同码**；"连不上"不许糊成"失败了"）。

    只看异常**类型**（消息里可能含服务端文本，不作为判据）；`stage` 区分"连"与"发/读"。
    """
    if isinstance(exc, ssl.SSLError):
        return f"{service}-tls-failed"
    if isinstance(exc, OSError) and not isinstance(exc, (smtplib.SMTPException, MailTransportError)):
        return f"{service}-unreachable"
    if service == "smtp":
        if isinstance(exc, smtplib.SMTPAuthenticationError):
            return "smtp-auth-failed"
        if isinstance(exc, smtplib.SMTPRecipientsRefused):
            return "smtp-recipients-refused"
        if isinstance(exc, smtplib.SMTPServerDisconnected):
            return "smtp-disconnected"
        if isinstance(exc, smtplib.SMTPException):
            return "smtp-auth-failed" if stage == "auth" else "smtp-send-failed"
        return "smtp-send-failed" if stage == "send" else "smtp-unreachable"
    name = type(exc).__name__
    if name in ("IMAP4_SSL_ERROR", "SSLError"):
        return "imap-tls-failed"
    if "abort" in str(exc).lower() or "login" in str(exc).lower() or "auth" in str(exc).lower():
        return "imap-auth-failed"
    return "imap-read-failed" if stage == "read" else "imap-unreachable"


def _message_bytes(message: Any, raw: Any) -> tuple:
    """(报文字节 | None, reason)。`raw` 优先；`message` 认原生字节访问器与方法。"""
    if raw is not None:
        if isinstance(raw, (bytes, bytearray)):
            return bytes(raw), ""
        if isinstance(raw, str):
            return raw.encode("utf-8", "surrogateescape"), ""
        return None, "mail-message-not-sendable"
    if message is None:
        return None, "mail-message-not-sendable"
    if isinstance(message, (bytes, bytearray)):
        return bytes(message), ""
    if isinstance(message, str):
        return message.encode("utf-8", "surrogateescape"), ""
    for attribute in ("raw_bytes", "raw"):
        value = getattr(message, attribute, None)
        if isinstance(value, (bytes, bytearray)):
            return bytes(value), ""
    for attribute in ("as_bytes", "to_bytes", "render"):
        method = getattr(message, attribute, None)
        if callable(method):
            try:
                value = method()
            except Exception:  # noqa: BLE001 —— 试探性调用：签名不符就换下一个
                continue
            if isinstance(value, (bytes, bytearray)):
                return bytes(value), ""
    if isinstance(message, dict):
        for key in ("raw", "raw_bytes", "eml", "rfc5322", "data", "payload"):
            value = message.get(key)
            if isinstance(value, (bytes, bytearray)):
                return bytes(value), ""
            if isinstance(value, str) and "\n" in value:
                return value.encode("utf-8", "surrogateescape"), ""
    return None, "mail-message-not-sendable"


def _envelope_of(data: Any) -> dict:
    """报文字节 → 信封（to/from/subject/message_id）。解析失败不抛：返回空信封（拒绝路径会接住）。"""
    out = {"to": [], "from": "", "subject": "", "message_id": None}
    if not data:
        return out
    try:
        parsed = BytesParser(policy=DEFAULT_POLICY).parsebytes(data)
    except Exception:  # noqa: BLE001
        return out
    out["to"] = [address for _name, address in getaddresses([str(parsed.get("To") or "")]) if address]
    sender = [address for _name, address in getaddresses([str(parsed.get("From") or "")]) if address]
    out["from"] = sender[0] if sender else ""
    out["subject"] = str(parsed.get("Subject") or "")
    identifier = str(parsed.get("Message-ID") or "").strip()
    out["message_id"] = (identifier or None)
    return out


def _exists_of(conn: Any, payload: Any) -> int:
    """从 SELECT/EXAMINE 的响应里取 `EXISTS`（邮件总数）——取不到就按 0 报（不猜一个数）。

    两个来源都试：① `select()` 的返回数据（实测 `('OK', [b'7'])`，那个 `7` 就是 EXISTS）；
    ② `conn.response('EXISTS')`（**注意**：该接口返回的 `typ` 是 `EXISTS` 而不是 `OK`，
    且不存在时给的是 `[None]` —— 只看"有没有一个纯数字"才不会被这两种形态骗到）。
    """
    candidates: list = []
    if isinstance(payload, (list, tuple)):
        candidates.extend(payload)
    try:
        _typ, data = conn.response("EXISTS")
    except Exception:  # noqa: BLE001
        data = None
    if isinstance(data, (list, tuple)):
        candidates.extend(data)
    for item in candidates:
        if isinstance(item, (bytes, bytearray)):
            item = bytes(item).decode("ascii", "ignore")
        text = str(item or "").strip()
        if text.isdigit():
            return int(text)
    return 0


def _hash_of(data: bytes) -> str:
    return HASH_PREFIX + sha256_hex(data)


def clip_text(data: bytes, max_bytes: int) -> str:
    """UTF-8 文本按**字节**夹取（整码点步进：不劈开多字节字符）。"""
    text = bytes(data).decode("utf-8", "replace")
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text
    return raw[:max_bytes].decode("utf-8", "ignore")


def _inbound_view(item: Any, max_bytes: int) -> dict:
    """一封 IMAP `FETCH (RFC822 {n})` 响应 → 有界视图（摘要按**整封**算，返回体按 `max_bytes` 夹）。"""
    raw = bytes(item[1])
    envelope = _envelope_of(raw)
    view = {
        "from": envelope["from"],
        "to": envelope["to"],
        "subject": envelope["subject"],
        "message_id": envelope["message_id"],
        "bytes": len(raw),
        "body_sha256": _hash_of(raw),
        "clipped": len(raw) > max_bytes,
        "text": clip_text(raw, max_bytes),
    }
    return view


def _attempt_view(attempt: Any) -> dict:
    """状态文件里的一条尝试 → 对外的**无值**视图（键白名单，防止以后有人往记录里塞值）。"""
    if not isinstance(attempt, dict):
        return {}
    out = {}
    for key in ("kind", "service", "ok", "reason", "next_action", "message_id", "at",
                "config_fingerprint"):
        if key in attempt:
            out[key] = attempt.get(key)
    out["ok"] = bool(attempt.get("ok"))
    return out
