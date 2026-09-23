#!/usr/bin/env python3
"""mail-digest —— **邮件通知摘要**：把「有事等你」在**人不在浏览器时**送到收件箱。

为什么要有它（缺陷真源）：通知中心只在页面里；人一关浏览器，「有 1 件待办」这件事就没人告诉他了。
已有邮件域（`services/mail_transport` 的 SMTP 真发信）此前**没有被用起来**：界面能看通道状态、能配它，
但没有任何东西会主动发一封信。

它做四件事（多一件都不做）：

1. **按个人偏好开关**（**默认关**）：开关 + 收件地址 + 最低级别 + 节流窗口都按**身份**落在
   `<ui_shared>/mail/notify-prefs.json`（目录 0700 / 文件 **0600**、原子写、有界：身份 ≤ 64）。
   没有这个身份的记录 = **关**（不猜、不代用户开）。
2. **摘要**：条目由外壳机制给（`host.digest()` —— 按**会话身份**聚合后的通知，只带
   「标题 / 下一步 / 来源 / 深链 / 计数」，**不带**任何 `body`），本工具再**扫一遍**才发。
3. **去重 + 节流**：已经发过的条目（键 = `<条目 id>@<级别>`：级别升级会再提醒一次）不再发；
   距上一次成功发送不足 `throttle_min` 分钟 ⇒ **不发**并给 `retry_after_s`（窗口可关/可调）。
4. **如实回执**：落一封 0600 状态文件 + 一行 0600 日志（append-only），回执里只有计数/布尔/原因码/
   收件人指纹（**没有**收件地址原文、没有正文、没有凭据）。

三条硬纪律（逐条落在代码里）：

· **不写账本**：`MailTransport.send(..., ledger=None)` 是唯一发信出口 ⇒ 回执里 `ledger: null`、
  `ledger_added: 0`。摘要不是合同事实（与名册/协作/附件同源的理由：写进账本会改事件类型目录、
  证据包哈希与审计取证语义）。
· **绝不泄露私域 / 凭据 / 对方正文**：
  - **进不来**：本工具只接受外壳投影过的字段（`id/level/title/next_action/plugin_id/at/count/link/ref/tags`），
    多出来的键（例如 `body`）一律**丢掉并计数**（`dropped_keys`）；
  - **发之前再扫一遍**：私域哨兵（`services/mail.PRIVATE_TOKENS`）+ SMTP 账号/口令的值 +
    自带的泄露样态词；命中 ⇒ 那一条**不发**（`withheld` 计数）；
  - **最后一道**：拼好的**整份报文**再扫一遍；仍命中 ⇒ **整封不发**（`digest-leak-refused`）——
    与其发一封"洗过一半"的摘要，不如说清楚没发。
· **按身份隔离、跨侧不互发**：偏好条目按 `human:<名字>` 存；发信时**双查**——
  请求里的身份必须有它自己的偏好条目（没有 ⇒ `digest-disabled`），
  且该条目登记的 `side` 必须与这次请求的 `side` 一致（不一致 ⇒ `cross-side-digest`，零发送）。
  收件地址只可能来自**这个身份自己的**条目。

用法（**GUI 是主路径**：面板上的两个按钮 = 下面两条命令；cron 用它做无浏览器路径）::

    # ① 改开关/地址（外壳落 0600 待办件 → 本工具消费它；唯一落盘者就是本工具）
    python3 src/system/mail/tools/mail-digest.py --op prefs-set --shared-dir tmp/ui-shared --request <0600 待办件>
    # ② 发一封摘要（同上：入参来自外壳投影后的待办件）
    python3 src/system/mail/tools/mail-digest.py --op digest --shared-dir tmp/ui-shared --request <0600 待办件>
    # ③ 只读读数（不改任何东西；面板/脚本/运维都用它）
    python3 src/system/mail/tools/mail-digest.py --op status --shared-dir tmp/ui-shared --identity human:wanglei
    # ④ **无浏览器路径**（cron）：条目由调用方给（0600 文件或 `-` 读 stdin），格式同待办件的 `items`
    python3 src/system/mail/tools/mail-digest.py --op digest --shared-dir tmp/ui-shared \
        --identity human:wanglei --side contractor --items-json /path/items.json --now 2026-09-23T09:00:00Z

`--dry-run`：算完（含扫描、去重、节流判定）**不发送、不落任何文件** —— 负控与排障用它。
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from email.header import Header
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.services.mail import PRIVATE_TOKENS  # noqa: E402  （私域哨兵的单一真源）
from quotagent.services.mail_transport import (  # noqa: E402
    SANITIZED, MailTransport, config_values, sanitize,
)

__all__ = [
    "SCHEMA_PREFS", "SCHEMA_STATE", "OPS", "LEVELS", "LEVEL_LABEL", "LEVEL_RANK", "LIMITS",
    "DEFAULT_THROTTLE_MIN", "MAX_THROTTLE_MIN", "REASONS", "ITEM_KEYS", "BODY_KEYS",
    "IDENTITY_RE", "ADDRESS_RE", "paths_of", "load_prefs", "save_prefs", "entry_of",
    "scan_text", "project_items", "build_wire", "digest_once", "set_prefs", "status_of", "main",
]

# --- 契约（键名、上限、词表都在这一处；散落即漂移） -------------------------------------------
SCHEMA_PREFS = "quotagent/mail-notify-prefs/v1"
SCHEMA_STATE = "quotagent/mail-notify-state/v1"
SCHEMA_JOURNAL = "quotagent/mail-notify-journal/v1"
SCHEMA_REQUEST = "quotagent/pending/v1"          # 外壳 `host.stage()` 落的待办件 schema
OPS = ("prefs-get", "prefs-set", "digest", "status")

LEVELS = ("info", "warn", "bad")
LEVEL_LABEL = {"bad": "急", "warn": "待办", "info": "知会"}
LEVEL_RANK = {"bad": 0, "warn": 1, "info": 2}

#: 上限（有界：超出一律**如实计数**，不静默丢）
LIMITS = {"identities": 64, "items": 50, "title": 160, "next": 200, "id": 120, "link": 400,
          "at": 40, "plugin": 64, "tags": 6, "tag": 24, "to": 200, "sent_keys": 500,
          "journal_bytes": 4000, "subject": 120, "body_items": 40}

DEFAULT_THROTTLE_MIN = 15
MAX_THROTTLE_MIN = 1440

#: 本工具只认这些条目键（**其余一律丢掉并计数**：对方正文/私域字段根本进不了摘要）
ITEM_KEYS = ("id", "level", "title", "next_action", "plugin_id", "at", "count", "link", "ref", "tags")
#: 摘要里**允许出现**的报文级键（其余进 `dropped_keys`）
BODY_KEYS = ("op", "identity", "side", "generated_at", "limit", "level", "items", "counts",
             "mechanism", "note", "requested_at", "schema", "kind", "bytes", "payload_sha256",
             "submitted_at", "from", "prefix")

IDENTITY_RE = re.compile(r"^human:[a-z][a-z0-9._-]{0,31}$")
SIDE_RE = re.compile(r"^[a-z][a-z0-9-]{0,15}$")
#: 收件地址：只做**形状**校验（不校验域名存在性 —— 那件事只有 SMTP 服务器知道）
ADDRESS_RE = re.compile(r"^[^@\s,;<>]{1,64}@[A-Za-z0-9]([A-Za-z0-9.-]{0,188})\.([A-Za-z]{2,24})$")

#: 泄露样态词（**只报名字，不报值**）：私域哨兵之外再兜一层"看起来就是机密"的键名
LEAK_HINTS = ("password", "passwd", "secret", "api_key", "apikey", "private_key", "bearer ",
              "credential", "作者正文", "对方正文")
#: 原因码 → 可行动的下一步（闭合词表：每个拒绝都有下一步）
REASONS = {
    "identity-required": "先用**你自己的**身份登录（界面顶栏「身份」），再回来点这个按钮；"
                         "偏好按身份存，工具不会替你挑一个身份。",
    "identity-malformed": "身份写成 `human:<小写名字>`（≤32 位、只含 [a-z0-9._-]）。",
    "side-malformed": "侧写成小写标识（如 contractor / supplier）。",
    "request-unreadable": "待办件读不出来：看它是不是 0600 普通文件、是不是合法 JSON；"
                          "重下一次动作（外壳会重新落一份）。",
    "request-op-mismatch": "待办件里的 op 与本次命令不一致：digest 的件只给 digest，prefs-set 的件只给 prefs-set。",
    "request-items-missing": "待办件里没有 `items`（摘要条目由外壳投影后随件给出）：重新点一次「发一份摘要」。",
    "recipient-missing": "偏好里没有收件地址：先在「通知与邮件摘要」面板里填一个（开关 + 地址一起提交）。",
    "recipient-invalid": "收件地址形状不对（合法：`name@example.com`）；改掉再提交。",
    "digest-disabled": "这个身份的邮件摘要**默认关**：在「通知与邮件摘要」面板里打开开关并填收件地址。",
    "cross-side-digest": "这次请求的侧与偏好登记的不是同一侧 —— 摘要**不跨侧发**（同一条也只按会话身份的侧聚合）。",
    "digest-nothing-to-send": "这次没有任何条目（没有待办/未读），所以**不发空信**；有事了下一封会有内容。",
    "digest-no-new": "这些条目**上一次都已经发过**了（去重键 = 条目 id + 级别）：没有新的要告诉你，不发第二封。",
    "digest-throttled": "距上一次成功发送还不到节流窗口；等这一段时间，或用「忽略节流再发一次」（按钮/`--force`）。",
    "digest-leak-refused": "扫描发现报文里有私域哨兵/凭据/正文样态 ⇒ **整封不发**（宁可少一封，不泄露一个字节）；"
                           "把这些字段从通知来源里去掉，或只让它们留在界面里。",
    "mail-message-not-sendable": "拼报文失败：看 reason 的具体形态（本工具只发纯文本摘要）。",
    "prefs-write-failed": "偏好文件写不进去：先修 `<ui_shared>/mail/` 的权限（目录 0700 / 文件 0600）。",
    "state-write-failed": "状态/日志文件写不进去：先修 `<ui_shared>/mail/` 的权限。",
    "shared-dir-missing": "共享目录不存在：确认 `--shared-dir` 指对了（GUI 会用配置里的那个）。",
}
#: 传输层的原因码直接透传，但下一句要说清"这是发信那一段失败"（不新造词表）
for _code, _next in {
    "mail-smtp-unconfigured": "SMTP 没配：在「邮件通道」面板里填 host/port/from（凭据走凭据面，永不回显）。",
    "mail-smtp-unprobed": "SMTP 配好了但没试过：先用面板上的「探测/真发一封」拿到证据。",
    "mail-smtp-config-changed": "接入点在上次成功之后被改过 ⇒ 旧的成功不算证据：重跑一次探测。",
    "smtp-unreachable": "确认 SMTP 主机/端口可达（主机名解析、防火墙、端口、服务是否在跑）后重试。",
    "smtp-auth-failed": "认证被拒：检查 SMTP 账号/口令（凭据面，只写不回显）。",
    "smtp-tls-failed": "TLS 握手失败：检查 `mail.smtp.security`（starttls/ssl/plain）与证书链。",
    "smtp-recipients-refused": "收件人被服务器拒了：核对地址与服务器转发策略。",
    "smtp-disconnected": "服务器中途断开：重试或核对服务端连接上限（本层不做自动重试）。",
    "smtp-send-failed": "SMTP 交互失败：看回执里的 server/detail 再修。",
    "mail-smtp-security-unknown": "`mail.smtp.security` 只接受 starttls / ssl / plain。",
    "mail-config-unreadable": "配置文件读不到或不是本子集支持的 YAML：先修配置或 `--mail-config`。",
}.items():
    REASONS[_code] = _next


class DigestError(RuntimeError):
    """带原因码的拒绝（对外只出**洗过的**文本：与传输层同一条纪律）。"""

    def __init__(self, code: str, reason: str = "", *, extra: Any = None) -> None:
        super().__init__(reason or code)
        self.code = code
        self.reason = reason or code
        self.extra = extra or {}

    def refusal(self) -> dict:
        out = {"ok": False, "code": self.code, "reason": self.reason,
               "next_action": REASONS.get(self.code, "看 reason 与上一步的输出，修正后重试")}
        out.update(self.extra)
        return out


# ======================================================================
# 纯函数：路径、时间、扫描、投影
# ======================================================================
def paths_of(shared: Any) -> dict:
    """共享目录 → 三件套的落点（**只有这一处**拼路径）。"""
    base = Path(str(shared))
    mail = base / "mail"
    return {"base": base, "dir": mail, "prefs": mail / "notify-prefs.json",
            "state": mail / "notify-state.json", "journal": mail / "notify-journal.jsonl"}


def _utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _flat(value: Any, limit: int = 4000) -> str:
    return " ".join(str("" if value is None else value).split())[:limit]


def _sha12(value: Any) -> str:
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:12]


def _read_json(path: Path) -> tuple:
    """读 JSON：`(doc|{}, reason)`。缺失 = `({}, "")`（不是错误），坏文件 = `({}, "unreadable")`。"""
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}, ""
    except OSError:
        return {}, "unreadable"
    try:
        doc = json.loads(raw)
    except ValueError:
        return {}, "unreadable"
    return (doc if isinstance(doc, dict) else {}), ""


def _write_json_atomic(path: Path, payload: dict, *, mode: int = 0o600) -> dict:
    """原子写 + 显式 chmod（不受 umask 影响）；目录 0700。"""
    target = Path(path)
    try:
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(target.parent, 0o700)
        except OSError:
            pass
        tmp = target.parent / f".{target.name}.tmp.{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=1) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, target)
        return {"ok": True, "file": str(target), "mode": f"{mode:04o}"}
    except OSError as exc:
        return {"ok": False, "code": "prefs-write-failed", "reason": sanitize(f"{type(exc).__name__}")}


def _append_journal(path: Path, record: dict) -> dict:
    """append-only 的一行日志（0600、显式 chmod、单行、有界）。**不含正文/地址原文/凭据**。"""
    target = Path(path)
    line = json.dumps(record, ensure_ascii=False, sort_keys=True)[:LIMITS["journal_bytes"]]
    try:
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, (line + "\n").encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.chmod(target, 0o600)
        except OSError:
            pass
        return {"ok": True, "file": str(target)}
    except OSError as exc:
        return {"ok": False, "code": "state-write-failed", "reason": sanitize(f"{type(exc).__name__}")}


def scan_text(text: Any, secrets: Any = None) -> list:
    """扫一段文本里**命中**了什么（只回**名字**，永不回值）：私域哨兵 + 凭据值 + 泄露样态词。"""
    body = "" if text is None else str(text)
    lowered = body.lower()
    hits = []
    for token in PRIVATE_TOKENS:
        if token.lower() in lowered:
            hits.append(f"private:{token}")
    for hint in LEAK_HINTS:
        if hint.lower() in lowered:
            hits.append(f"hint:{hint}")
    for value in (secrets or []):
        if isinstance(value, str) and len(value) >= 4 and value in body:
            hits.append("credential-value")
    return sorted(set(hits))


def _copy_text(value: Any, limit: int) -> str:
    """一行化 + 夹取（换行/制表折成空格：标题里塞一整段正文时它进不来）。"""
    return " ".join(str("" if value is None else value).split())[:limit]


def project_items(items: Any, secrets: Any = None, *, limit: int = LIMITS["items"]) -> dict:
    """外壳给的条目 → **摘要条目**（只留白名单键、逐字段夹取、逐条扫描）。

    返回 `{"kept": [...], "withheld": [{id, hits}], "dropped_keys": {key: n}, "truncated": n}`：
    含私域哨兵/凭据/正文样态的那一条**不进摘要**（`withheld` 如实计数），多出来的键**丢掉并计数**。
    """
    out = {"kept": [], "withheld": [], "dropped_keys": {}, "truncated": 0}
    rows = items if isinstance(items, list) else []
    for raw in rows:
        if not isinstance(raw, dict):
            out["truncated"] += 1
            continue
        for key in raw.keys():
            if key not in ITEM_KEYS:
                out["dropped_keys"][str(key)] = out["dropped_keys"].get(str(key), 0) + 1
        level = str(raw.get("level") or "info").lower()
        if level not in LEVELS:
            level = "info"
        item = {"id": _copy_text(raw.get("id"), LIMITS["id"]),
                "level": level,
                "title": _copy_text(raw.get("title"), LIMITS["title"]),
                "next_action": _copy_text(raw.get("next_action"), LIMITS["next"]),
                "plugin_id": _copy_text(raw.get("plugin_id"), LIMITS["plugin"]),
                "at": _copy_text(raw.get("at"), LIMITS["at"]),
                "count": int(raw.get("count") or 1) if str(raw.get("count") or "1").lstrip("-").isdigit() else 1,
                "link": _copy_text(raw.get("link"), LIMITS["link"]),
                "ref": {}, "tags": []}
        ref = raw.get("ref") if isinstance(raw.get("ref"), dict) else {}
        if ref:
            item["ref"] = {"kind": _copy_text(ref.get("kind"), 32), "id": _copy_text(ref.get("id"), LIMITS["id"]),
                           "view": _copy_text(ref.get("view"), 32),
                           "title": _copy_text(ref.get("title"), LIMITS["title"])}
        tags = raw.get("tags") if isinstance(raw.get("tags"), list) else []
        item["tags"] = [_copy_text(tag, LIMITS["tag"]) for tag in tags[:LIMITS["tags"]] if _copy_text(tag, LIMITS["tag"])]
        hits = scan_text(json.dumps(item, ensure_ascii=False), secrets)
        if hits:
            out["withheld"].append({"id": item["id"] or "?", "hits": hits})
            continue
        if not item["title"] and not item["next_action"]:
            out["truncated"] += 1
            continue
        if len(out["kept"]) >= limit:
            out["truncated"] += 1
            continue
        out["kept"].append(item)
    return out


def _level_ok(level: str, min_level: str) -> bool:
    return LEVEL_RANK.get(level, 2) <= LEVEL_RANK.get(min_level, 2)


# ======================================================================
# 偏好 / 状态（按身份；默认关）
# ======================================================================
def load_prefs(shared: Any) -> dict:
    doc, reason = _read_json(paths_of(shared)["prefs"])
    identities = doc.get("identities") if isinstance(doc.get("identities"), dict) else {}
    return {"schema": SCHEMA_PREFS, "identities": identities, "unreadable": bool(reason)}


def save_prefs(shared: Any, prefs: dict) -> dict:
    doc = {"schema": SCHEMA_PREFS, "identities": prefs.get("identities") or {}, "updated_at": _utc_now(),
           "mode": "0600", "dir_mode": "0700",
           "note": "邮件通知摘要的**个人偏好**（开关 / 收件地址 / 最低级别 / 节流窗口），按 `human:<名字>` 存。"
                   "它不是账本事实（偏好不是业务承诺）；没有记录 = **关**（默认关，不猜、不代开）。"
                   "地址只在这里与发信那一刻使用：日志与回执里只留指纹与域名。"}
    names = list(doc["identities"].keys())
    if len(names) > LIMITS["identities"]:
        ordered = sorted(names, key=lambda name: str(doc["identities"][name].get("updated_at") or ""))
        for old in ordered[:len(names) - LIMITS["identities"]]:
            del doc["identities"][old]
        doc["dropped"] = len(names) - LIMITS["identities"]
    return _write_json_atomic(paths_of(shared)["prefs"], doc)


def entry_of(prefs: Any, identity: str) -> Any:
    """这个身份的偏好条目（没有 ⇒ `None` = **关**）。"""
    entries = prefs.get("identities") if isinstance(prefs, dict) else {}
    row = (entries or {}).get(str(identity))
    return row if isinstance(row, dict) else None


def _normalize_recipient(value: Any) -> str:
    text = _flat(value, LIMITS["to"])
    if text == "":
        return ""
    return text.lower() if ADDRESS_RE.match(text) else ""


def set_prefs(shared: Any, record: dict, *, dry_run: bool = False) -> dict:
    """写一个身份的偏好（**整体替换这一条**）：开关 / 地址 / 最低级别 / 节流窗口。

    纪律：只为**记录里那个身份**写（别的身份的条目逐字节不动）；`on=false` 时地址留空也合法；
    `on=true` 必须有合法地址（否则 `recipient-invalid`，**零落盘**）。
    """
    identity = _flat(record.get("identity"), 64)
    if not IDENTITY_RE.match(identity):
        raise DigestError("identity-malformed", f"身份形状不合法：{identity!r}")
    side = _flat(record.get("side"), 16)
    if side == "":
        raise DigestError("side-malformed", "没有给侧（side 由会话决定，必须随件给出）")
    if not SIDE_RE.match(side):
        raise DigestError("side-malformed", f"侧形状不合法：{side!r}")
    on = record.get("on")
    on = on is True or str(on).strip().lower() in ("1", "true", "on", "yes")
    to = _normalize_recipient(record.get("to"))
    if on and to == "":
        raw = _flat(record.get("to"), LIMITS["to"])
        raise DigestError("recipient-invalid" if raw else "recipient-missing",
                          f"打开摘要必须给合法收件地址（收到：{raw!r}）")
    level = _flat(record.get("min_level"), 8).lower() or "warn"
    if level not in LEVELS:
        level = "warn"
    try:
        throttle = int(record.get("throttle_min"))
    except (TypeError, ValueError):
        throttle = DEFAULT_THROTTLE_MIN
    throttle = max(0, min(MAX_THROTTLE_MIN, throttle))
    entry = {"identity": identity, "side": side, "on": bool(on), "to": to,
             "min_level": level, "throttle_min": throttle, "updated_at": _utc_now()}
    if dry_run:
        return {"ok": True, "code": "prefs-dry-run", "identity": identity, "side": side,
                "entry": {**entry, "to": "***" if to else ""}, "written": False,
                "next_action": "去掉 --dry-run 就会落盘（0600，按身份）"}
    prefs = load_prefs(shared)
    prefs["identities"][identity] = entry
    written = save_prefs(shared, prefs)
    if not written.get("ok"):
        raise DigestError("prefs-write-failed", str(written.get("reason") or ""), extra={"file": written.get("file")})
    return {"ok": True, "code": "prefs-saved", "identity": identity, "side": side,
            "on": entry["on"], "to_domain": to.split("@")[-1] if to else "",
            "to_digest": _sha12(to) if to else "", "min_level": level, "throttle_min": throttle,
            "file": written.get("file"), "mode": written.get("mode"),
            "ledger": None, "ledger_added": 0,
            "next_action": "" if entry["on"] else "开关现在是关：打开后才会发摘要"}


# ======================================================================
# 报文（纯文本摘要；头注入防护；正文 base64 —— 行长固定、无编码歧义）
# ======================================================================
def _reject_break(name: str, value: str) -> str:
    text = str(value or "")
    if "\r" in text or "\n" in text or "\x00" in text:
        raise DigestError("mail-message-not-sendable", f"{name} 里有换行/NUL（头注入防护：不清洗、不修正）")
    return text.strip()


def build_wire(record: dict, entry: dict, *, kept: list, counts: dict, now: str, sender: str,
               secrets: Any = None, prefix: str = "") -> bytes:
    """摘要条目 → **RFC 5322 报文字节**（纯文本；头非 ASCII 走 RFC 2047；正文 base64 固定行长）。

    纪律：`from` / `to` / `subject` / `date` 里有换行 ⇒ 拒绝（**不清洗、不修正**）；
    拼好后**整份再扫一遍**（私域哨兵 / 凭据值 / 泄露样态词）⇒ 命中就**整封不发**。
    """
    identity = str(entry.get("identity") or "")
    side = str(entry.get("side") or "")
    to = str(entry.get("to") or "")
    if not to:
        raise DigestError("recipient-missing", "偏好里没有收件地址（先打开开关并填地址）")
    todo = sum(1 for item in kept if item["level"] in ("warn", "bad"))
    bad = sum(1 for item in kept if item["level"] == "bad")
    head = (f"{side} 侧 · {identity} · {now}")
    subject = _reject_break("subject", f"[quotagent] 有事等你：{todo} 件待办"
                            + (f"（其中 {bad} 件急）" if bad else "")
                            + f" · 共 {counts.get('listed', len(kept))} 条")[:LIMITS["subject"]]
    lines = [
        f"quotagent 通知摘要 —— {head}",
        "",
        f"共 {counts.get('produced', 0)} 条通知；其中待办（warn 及以上）{counts.get('todo', 0)} 条，"
        f"急（bad）{counts.get('bad', 0)} 条。",
        (f"未读：{counts.get('unread', 0)} 条（服务端按你的已读集合算）"
         if counts.get("unread_known") else "未读：服务端不知道你读过什么（未登录/无记录时**不猜**）"),
        f"这一封列出最急的 {len(kept)} 条"
        + (f"；另有 {counts.get('rest', 0)} 条没列（打开界面看全部）" if counts.get("rest") else "") + "。",
        "",
    ]
    for index, item in enumerate(kept, start=1):
        tag = LEVEL_LABEL.get(item["level"], item["level"])
        count = f" ×{item['count']}" if int(item.get("count") or 1) > 1 else ""
        lines.append(f"{index}. [{tag}] {item['title']}{count}")
        if item["next_action"]:
            lines.append(f"   下一步：{item['next_action']}")
        if item["link"]:
            lines.append(f"   处理入口：{item['link']}")
        if item["plugin_id"]:
            lines.append(f"   来源：{item['plugin_id']}"
                         + (f" · {item['at']}" if item["at"] else ""))
        lines.append("")
    lines += [
        "——",
        "这封摘要由 quotagent 的邮件摘要发出：内容只有**标题 / 下一步 / 来源 / 深链 / 计数**，"
        "不含任何对方发来的正文、不含私域字段、不含凭据。",
        "开关与收件地址是**你自己的个人偏好**（按身份存 0600 文件），可在界面的「通知与邮件摘要」面板里改或关掉。",
    ]
    body = "\n".join(lines)
    text = f"From: {_reject_break('from', sender)}\r\nTo: {_reject_break('to', to)}\r\n" \
           f"Subject: {Header(subject, 'utf-8').encode()}\r\nDate: {_reject_break('date', now)}\r\n" \
           f"Message-ID: <digest-{_sha12(identity + now + subject)}@quotagent>\r\n" \
           f"Content-Type: text/plain; charset=utf-8\r\n" \
           f"Content-Transfer-Encoding: base64\r\nMIME-Version: 1.0\r\n\r\n" \
           + "\r\n".join(base64.b64encode(body.encode("utf-8")).decode("ascii")[i:i + 76]
                         for i in range(0, len(base64.b64encode(body.encode("utf-8")).decode("ascii")), 76)) + "\r\n"
    wire = text.encode("utf-8")
    hits = scan_text(wire.decode("utf-8", "replace"), secrets)
    if hits:
        raise DigestError("digest-leak-refused",
                          f"整份报文扫出 {len(hits)} 类泄露样态 ⇒ 不发",
                          extra={"hits": hits, "sent": False, "ledger_added": 0})
    return wire


def _secrets_of(transport: MailTransport) -> list:
    """SMTP 账号/口令的**值**（只在内存里用来核对"报文中没有它们"；永不打印、永不落盘）。"""
    values, _sources = transport.settings("smtp")
    return [item for item in (values.get("password"), values.get("username")) if isinstance(item, str) and item]


def _state_of(shared: Any, identity: str) -> dict:
    doc, _reason = _read_json(paths_of(shared)["state"])
    entries = doc.get("identities") if isinstance(doc.get("identities"), dict) else {}
    row = entries.get(identity)
    row = row if isinstance(row, dict) else {}
    keys = row.get("sent_keys") if isinstance(row.get("sent_keys"), list) else []
    return {"last_sent_at": str(row.get("last_sent_at") or ""), "last_ok": row.get("last_ok"),
            "last_code": str(row.get("last_code") or ""), "sends": int(row.get("sends") or 0),
            "sent_keys": [str(key) for key in keys][-LIMITS["sent_keys"]:],
            "refusals": row.get("refusals") if isinstance(row.get("refusals"), dict) else {}}


def _save_state(shared: Any, identity: str, patch: dict, *, dry_run: bool = False) -> dict:
    if dry_run:
        return {"ok": True, "written": False, "reason": "dry-run"}
    path = paths_of(shared)["state"]
    doc, _reason = _read_json(path)
    doc = {"schema": SCHEMA_STATE, "identities": doc.get("identities") if isinstance(doc.get("identities"), dict) else {},
           "updated_at": _utc_now(), "mode": "0600",
           "note": "邮件摘要的**发送状态**：上一次成功时刻、已发条目键（去重）、尝试计数。"
                   "只有计数/布尔/原因码/收件人指纹；不含地址原文、不含正文、不含凭据；**不是账本**。"}
    row = {**_state_of(shared, identity), **patch}
    doc["identities"][identity] = row
    names = list(doc["identities"].keys())
    if len(names) > LIMITS["identities"]:
        for old in sorted(names, key=lambda name: str(doc["identities"][name].get("last_at") or ""))[
                :len(names) - LIMITS["identities"]]:
            del doc["identities"][old]
    return _write_json_atomic(path, doc)


def _minutes_between(later: str, earlier: str) -> float:
    try:
        a = datetime.strptime(later, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        b = datetime.strptime(earlier, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return 1e9
    return (a - b).total_seconds() / 60.0


def _journal(shared: Any, record: dict, *, dry_run: bool = False) -> dict:
    if dry_run:
        return {"ok": True, "written": False}
    payload = {"schema": SCHEMA_JOURNAL, "at": _utc_now()}
    payload.update({key: record[key] for key in
                    ("op", "identity", "side", "ok", "code", "to_digest", "to_domain", "items", "new_items",
                     "duplicates", "withheld", "sent", "message_id", "bytes", "ledger_added", "to_domain")
                    if key in record})
    return _append_journal(paths_of(shared)["journal"], payload)


def digest_once(shared: Any, record: dict, *, now: str = "", force: bool = False, dry_run: bool = False,
                sender: str = "", transport: Any = None, prefix: str = "") -> dict:
    """**发一封摘要**（或如实拒发）。返回值 = 回执（`ok` / `code` / `applied` / `refused` / 计数）。"""
    identity = _flat(record.get("identity"), 64)
    if not IDENTITY_RE.match(identity):
        raise DigestError("identity-required" if identity == "" else "identity-malformed",
                          f"身份形状不合法：{identity!r}")
    side = _flat(record.get("side"), 16)
    if not SIDE_RE.match(side):
        raise DigestError("side-malformed", f"侧形状不合法：{side!r}")
    prefs = load_prefs(shared)
    entry = entry_of(prefs, identity)
    if not entry or entry.get("on") is not True:
        raise DigestError("digest-disabled",
                          f"{identity} 的邮件摘要没有打开（默认关）", extra={"identity": identity})
    if str(entry.get("side") or "") != side:
        raise DigestError("cross-side-digest",
                          f"{identity} 登记的侧是 {entry.get('side')!r}，这次请求的侧是 {side!r}",
                          extra={"pref_side": str(entry.get("side") or ""), "request_side": side})
    transport = transport if transport is not None else MailTransport()
    secrets = _secrets_of(transport)
    min_level = _flat(record.get("level"), 8).lower() or str(entry.get("min_level") or "warn")
    if min_level not in LEVELS:
        min_level = "warn"
    limit = record.get("limit")
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = LIMITS["body_items"]
    limit = max(1, min(LIMITS["items"], limit))
    projected = project_items(record.get("items"), secrets, limit=limit)
    raw_items = record.get("items") if isinstance(record.get("items"), list) else []
    visible = [item for item in projected["kept"] if _level_ok(item["level"], min_level)]
    counts = {
        "produced": int((record.get("counts") or {}).get("produced") or len(raw_items)),
        "todo": int((record.get("counts") or {}).get("todo") or
                    sum(1 for item in raw_items if str(item.get("level")) in ("warn", "bad"))),
        "bad": int((record.get("counts") or {}).get("bad") or
                   sum(1 for item in raw_items if str(item.get("level")) == "bad")),
        "unread": int((record.get("counts") or {}).get("unread") or 0),
        "unread_known": bool((record.get("counts") or {}).get("unread_known")),
        "listed": len(visible),
        "rest": max(0, len(projected["kept"]) - len(visible)),
        "withheld": len(projected["withheld"]),
        "dropped_keys": projected["dropped_keys"],
        "truncated": projected["truncated"],
        "min_level": min_level,
    }
    stamp = record.get("generated_at") or now
    state = _state_of(shared, identity)
    sent_keys = set(state["sent_keys"])
    fresh = [item for item in visible if f"{item['id']}@{item['level']}" not in sent_keys]
    duplicates = len(visible) - len(fresh)
    throttle = int(entry.get("throttle_min") if entry.get("throttle_min") is not None else DEFAULT_THROTTLE_MIN)
    waited = _minutes_between(stamp, state["last_sent_at"]) if state["last_sent_at"] else 1e9
    base = {"ok": True, "identity": identity, "side": side, "counts": counts, "to_digest": _sha12(entry.get("to")),
            "to_domain": str(entry.get("to") or "").split("@")[-1], "withheld": projected["withheld"],
            "throttle_min": throttle, "last_sent_at": state["last_sent_at"], "dry_run": bool(dry_run),
            "ledger": None, "ledger_added": 0}
    # ① 没有条目 ⇒ 不发空信
    if not visible:
        code = "digest-nothing-to-send" if not projected["withheld"] else "digest-leak-refused"
        _note_refusal(shared, identity, code, now=stamp, dry_run=dry_run)
        return {**base, "ok": False, "code": code, "reason": REASONS["digest-nothing-to-send"]
                if code == "digest-nothing-to-send" else "全部条目都被扫描拦下（见 withheld）",
                "next_action": REASONS[code], "sent": False, "items": 0, "new_items": 0, "duplicates": 0,
                "refused": [{"file": record.get("file"), "code": code, "reason": REASONS[code],
                             "next_action": REASONS[code]}]}
    # ② 去重：全都发过 ⇒ 不发第二封
    if not fresh and not force:
        _note_refusal(shared, identity, "digest-no-new", now=stamp, dry_run=dry_run)
        return {**base, "ok": False, "code": "digest-no-new",
                "reason": f"{len(visible)} 条条目都已在 {state['last_sent_at']} 那一封里发过（键 = 条目 id + 级别）",
                "next_action": REASONS["digest-no-new"], "sent": False, "items": len(visible),
                "new_items": 0, "duplicates": duplicates,
                "refused": [{"file": record.get("file"), "code": "digest-no-new",
                             "reason": "没有新的条目", "next_action": REASONS["digest-no-new"]}]}
    # ③ 节流：窗口内不发
    if throttle > 0 and waited < throttle and not force:
        retry_after_s = int((throttle - waited) * 60)
        _note_refusal(shared, identity, "digest-throttled", now=stamp, dry_run=dry_run)
        return {**base, "ok": False, "code": "digest-throttled",
                "reason": f"距上一次成功发送 {waited:.1f} 分钟 < 节流窗口 {throttle} 分钟",
                "retry_after_s": retry_after_s, "next_action": REASONS["digest-throttled"],
                "sent": False, "items": len(visible), "new_items": len(fresh), "duplicates": duplicates,
                "refused": [{"file": record.get("file"), "code": "digest-throttled",
                             "reason": f"节流窗口 {throttle} 分钟内", "next_action": REASONS["digest-throttled"]}]}
    # ④ 拼报文 → 真发信（**唯一**出口：MailTransport.send；ledger=None ⇒ 账本零新增）
    #  `listed`：正常情况下只列**这次新出现的**条目（重复的不再占位）；`--force` 且没有新条目时
    #  列全部可见条目（用户要的是"完整重发一份"，不是一封空信）。
    listed = fresh if fresh else visible
    wire = build_wire(record, entry, kept=listed[:limit], counts=counts, now=stamp, sender=sender,
                      secrets=secrets, prefix=prefix)
    out = transport.send(raw=wire, ledger=None)
    ok = out.get("ok") is True and out.get("sent") is True
    receipt = {
        "ok": bool(ok), "code": "digest-sent" if ok else str(out.get("reason") or "smtp-send-failed"),
        "sent": bool(ok), "items": len(visible), "new_items": len(fresh), "duplicates": duplicates,
        "withheld": len(projected["withheld"]), "bytes": int(out.get("bytes") or len(wire)),
        "message_id": out.get("message_id"), "server": _flat(out.get("server"), 80),
        "accepted": len(out.get("accepted") or []), "refused_recipients": len(out.get("refused_recipients") or []),
        "ledger": None, "ledger_added": 0, "counts": counts, "to_digest": base["to_digest"],
        "to_domain": base["to_domain"], "throttle_min": throttle,
        "last_sent_at": stamp if ok else state["last_sent_at"], "dry_run": bool(dry_run),
        "next_allowed_at": "", "reason": "" if ok else _flat(out.get("reason"), 200),
        "next_action": "" if ok else str(out.get("next_action") or REASONS.get(str(out.get("reason")), "")),
        "detail": _flat(out.get("detail"), 200) if out.get("detail") else "",
        "private_hits": 0, "credential_hits": 0,
    }
    if not ok:
        _note_refusal(shared, identity, receipt["code"], now=stamp, dry_run=dry_run)
        receipt["reason"] = receipt["reason"] or REASONS.get(receipt["code"], "")
        receipt["refused"] = [{"file": record.get("file"), "code": receipt["code"],
                               "reason": receipt["reason"], "next_action": receipt["next_action"]}]
        receipt["applied"] = []
        return receipt
    keys = list(dict.fromkeys([*state["sent_keys"], *[f"{item['id']}@{item['level']}" for item in fresh]]))[
        -LIMITS["sent_keys"]:]
    if not dry_run:
        saved = _save_state(shared, identity, {"last_sent_at": stamp, "last_at": stamp, "last_ok": True,
                                               "last_code": "digest-sent", "sends": state["sends"] + 1,
                                               "sent_keys": keys})
        _journal(shared, {"op": "digest", "identity": identity, "side": side, "ok": True,
                          "code": "digest-sent", "to_digest": base["to_digest"], "to_domain": base["to_domain"],
                          "items": len(visible), "new_items": len(fresh), "duplicates": duplicates,
                          "withheld": len(projected["withheld"]), "sent": True,
                          "message_id": receipt["message_id"], "bytes": receipt["bytes"], "ledger_added": 0})
        receipt["state_file"] = saved.get("file")
        receipt["journal"] = str(paths_of(shared)["journal"])
    if throttle > 0:
        try:
            at = datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            receipt["next_allowed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                                       time.gmtime(at.timestamp() + throttle * 60))
        except ValueError:
            receipt["next_allowed_at"] = ""
    receipt["applied"] = [{"file": record.get("file"), "identity": identity, "items": len(fresh),
                           "code": "digest-sent", "message_id": receipt["message_id"]}]
    receipt["refused"] = []
    receipt["next_action"] = f"下一封最早在 {receipt['next_allowed_at']}（节流 {throttle} 分钟）" \
        if receipt["next_allowed_at"] else ""
    return receipt


def _note_refusal(shared: Any, identity: str, code: str, *, now: str = "", dry_run: bool = False) -> None:
    """记一次**未发送**（原因码计数 + 一行日志）：只增计数，不动 `sent_keys`、不动 `last_sent_at`。"""
    if dry_run:
        return
    state = _state_of(shared, identity)
    refusals = dict(state.get("refusals") or {})
    refusals[code] = int(refusals.get(code) or 0) + 1
    _save_state(shared, identity, {"last_at": now or _utc_now(), "last_ok": False, "last_code": code,
                                   "refusals": refusals})
    _journal(shared, {"op": "digest", "identity": identity, "ok": False, "code": code,
                      "sent": False, "ledger_added": 0})


def status_of(shared: Any, identity: str = "", *, transport: Any = None) -> dict:
    """**只读**读数：开关/地址（只出指纹与域名）/节流/上一次/已发条数/日志落点。不改任何文件。"""
    prefs = load_prefs(shared)
    entries = prefs.get("identities") or {}
    wanted = [identity] if identity else sorted(entries.keys())
    rows = []
    for name in wanted:
        entry = entry_of(prefs, name) or {}
        state = _state_of(shared, name)
        rows.append({"identity": name, "configured": bool(entry), "on": entry.get("on") is True,
                     "side": str(entry.get("side") or ""), "min_level": str(entry.get("min_level") or ""),
                     "throttle_min": entry.get("throttle_min"),
                     "to_domain": (str(entry.get("to") or "").split("@")[-1] if entry.get("to") else ""),
                     "to_digest": _sha12(entry.get("to")) if entry.get("to") else "",
                     "to_present": bool(entry.get("to")), "updated_at": str(entry.get("updated_at") or ""),
                     "last_sent_at": state["last_sent_at"], "last_code": state["last_code"],
                     "sends": state["sends"], "sent_keys": len(state["sent_keys"]),
                     "refusals": state["refusals"]})
    transport = transport if transport is not None else MailTransport()
    status = transport.status()
    paths = paths_of(shared)
    return {"ok": True, "service": "mail-digest", "schema": SCHEMA_PREFS, "shared_dir": str(paths["base"]),
            "files": {"prefs": str(paths["prefs"]), "state": str(paths["state"]), "journal": str(paths["journal"])},
            "modes": {"dir": "0700", "file": "0600"}, "limits": LIMITS,
            "default_on": False, "throttle_default_min": DEFAULT_THROTTLE_MIN,
            "identities": len(entries), "rows": rows, "prefs_unreadable": prefs.get("unreadable", False),
            "smtp": {"configured": status.get("configured"), "available": status.get("available"),
                     "reason": status.get("reason")},
            "ledger": None, "ledger_added": 0,
            "note": "只读读数：偏好按身份（默认关）；回执/日志里没有地址原文与正文，只有指纹与域名"}


def _load_record(path: str) -> dict:
    """读一个待办件（0600 文件）或 `-`（stdin）。**只认 dict**。"""
    if path == "-":
        raw = sys.stdin.read()
    else:
        try:
            raw = Path(path).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise DigestError("request-unreadable", f"{type(exc).__name__}: {path}")
    try:
        doc = json.loads(raw)
    except ValueError:
        raise DigestError("request-unreadable", f"不是合法 JSON：{path}")
    if not isinstance(doc, dict):
        raise DigestError("request-unreadable", f"待办件不是对象：{path}")
    return doc


def main(argv: Any = None) -> int:
    parser = argparse.ArgumentParser(prog="mail-digest",
                                     description="邮件通知摘要：按个人偏好把待办/未读发到邮箱（不写账本）")
    parser.add_argument("--op", default="status", choices=OPS)
    parser.add_argument("--shared-dir", dest="shared_dir", required=True,
                        help="共享目录（与 webui 的 ui_shared 同一个）：偏好/状态/日志落 <shared>/mail/")
    parser.add_argument("--request", default="", help="待办件路径（外壳 `host.stage()` 落的 0600 文件；`-` = stdin）")
    parser.add_argument("--identity", default="", help="身份（`human:<名字>`；status 用它挑一条看）")
    parser.add_argument("--side", default="", help="侧（contractor / supplier；由**会话**决定，随件给出）")
    parser.add_argument("--on", default="", help="prefs-set：true/false（不带 --request 时用）")
    parser.add_argument("--to", default="", help="prefs-set：收件地址")
    parser.add_argument("--min-level", dest="min_level", default="", help="prefs-set：最低级别 info|warn|bad")
    parser.add_argument("--throttle-min", dest="throttle_min", default="", help="prefs-set：节流窗口（分钟，0=关）")
    parser.add_argument("--items-json", dest="items_json", default="",
                        help="digest：条目文件（同待办件的 items 形状；`-` = stdin）—— cron 的无浏览器路径")
    parser.add_argument("--now", default="", help="报文里的时刻（ISO8601 UTC；缺省 = 现在）")
    parser.add_argument("--from", dest="sender", default="", help="发件人（缺省 = SMTP 配置里的 from）")
    parser.add_argument("--force", action="store_true", help="忽略节流与去重（仍然**不**绕过扫描）")
    parser.add_argument("--keep-request", dest="keep_request", action="store_true",
                        help="处理完**保留**待办件（缺省 = 消费掉它：队列不无限增长；审计在 0600 日志里）")
    parser.add_argument("--dry-run", dest="dry_run", action="store_true",
                        help="算完不发送、不落任何文件、不消费待办件")
    parser.add_argument("--mail-config", dest="mail_config", default="", help="配置落点（缺省 = 环境/默认）")
    parser.add_argument("--mail-state", dest="mail_state", default="", help="传输状态文件落点")
    args = parser.parse_args(argv)

    shared = Path(str(args.shared_dir)).expanduser()
    if not shared.exists():
        print(json.dumps({"ok": False, "code": "shared-dir-missing", "reason": str(shared),
                          "next_action": REASONS["shared-dir-missing"]}, ensure_ascii=False))
        return 2
    transport_kwargs = {}
    if args.mail_config:
        transport_kwargs["config_path"] = str(args.mail_config)
    if args.mail_state:
        transport_kwargs["state_path"] = str(args.mail_state)
    transport = MailTransport(**transport_kwargs)

    try:
        record = {}
        if args.request or args.items_json:
            record = _load_record(args.request or args.items_json)
            if args.request:
                # 待办件名进回执：机制层用它核对"本动作那一条是 applied 还是 refused"（`receipt.item`）
                record.setdefault("file", Path(args.request).name)
                op_seen = str(record.get("op") or args.op)
                if op_seen != args.op:
                    raise DigestError("request-op-mismatch",
                                      f"待办件里的 op={op_seen!r}，本次命令是 {args.op!r}")
            # 命令行上的显式取值优先于待办件（便于排障与 cron）
            for key, value in (("identity", args.identity), ("side", args.side), ("level", args.min_level),
                               ("to", args.to), ("on", args.on), ("throttle_min", args.throttle_min)):
                if value != "":
                    record[key] = value
        elif args.op in ("digest", "prefs-set"):
            if args.op == "digest":
                raise DigestError("request-items-missing", "digest 需要 `--request` 或 `--items-json`")
            record = {"op": "prefs-set", "identity": args.identity, "side": args.side, "on": args.on,
                      "to": args.to, "min_level": args.min_level, "throttle_min": args.throttle_min,
                      "file": ""}
        if args.op == "prefs-set":
            record.setdefault("op", "prefs-set")
            out = set_prefs(shared, record, dry_run=args.dry_run)
            out["applied"] = [{"file": record.get("file") or "cli", "identity": record.get("identity")}]
        elif args.op == "prefs-get":
            out = status_of(shared, args.identity, transport=transport)
        elif args.op == "digest":
            if not isinstance(record.get("items"), list):
                raise DigestError("request-items-missing",
                                  "摘要条目没随件给出（外壳把聚合后的条目投影后放进待办件）")
            sender = args.sender or str(transport.settings("smtp")[0].get("from") or "")
            out = digest_once(shared, record, now=str(args.now or record.get("generated_at") or _utc_now()),
                              force=bool(args.force), dry_run=bool(args.dry_run), sender=sender,
                              transport=transport, prefix=str(record.get("prefix") or ""))
            if out.get("ok") is not True:
                _consume(args, record)
                print(json.dumps(out, ensure_ascii=False, sort_keys=True))
                return 1
        else:
            out = status_of(shared, args.identity, transport=transport)
    except DigestError as exc:
        out = exc.refusal()
        _consume(args, {})
        print(json.dumps(out, ensure_ascii=False, sort_keys=True))
        return 1

    _consume(args, record)
    print(json.dumps(out, ensure_ascii=False, sort_keys=True))
    return 0


def _consume(args: Any, record: dict) -> Any:
    """消费掉待办件（缺省；`--keep-request` / `--dry-run` 时保留）：队列不无限增长，审计在 0600 日志里。"""
    if getattr(args, "keep_request", False) or getattr(args, "dry_run", False):
        return None
    path = str(getattr(args, "request", "") or "")
    if path in ("", "-"):
        return None
    try:
        Path(path).unlink()
        return True
    except OSError:
        return None


if __name__ == "__main__":
    raise SystemExit(main())
