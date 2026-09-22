#!/usr/bin/env python3
"""check-mail-transport —— 邮件"真能收发"的门（`tools/verify.sh mail-transport`）。

它守的是**这一批**的判据：凭据就位时**真的能发出去/收回来**，凭据不在时**诚实报未连接**，
而且**任何情况下凭据值都不出现在账本/响应体/日志里**。七组断言（每条都能被证伪）：

  A **未配置 = 诚实拒绝**（不是"失败了"）：`status()/send()/fetch_recent()/probe()` 给
    `available:false` + `connected:false` + **具体的** `reason`（`mail-smtp-unconfigured` /
    `mail-imap-unconfigured`）+ 可行动 `next_action`；`connected:true` 一次都不许出现；
    **一个字节都没发出去**（假 SMTP 服务端一次连接都没收到）。
  B **回环真收发**（自建标准库假服务）：`send()` 真发一封 → 假服务收到报文（**主题与正文都在**）
    → 账本落 `mail/sent`（`class=fact`，body 无凭据无正文）；`status()` 从"未探测"变成可用。
  C **凭据哨兵零泄漏**：哨兵口令在账本文件、`send()` 返回值、状态快照、日志（stdout/stderr）、
    邮件域快照（`mail.json`）里出现次数 **= 0**；**同时**证明它**真的被用上了**（假服务端的 AUTH 行里
    有它的 base64 —— 非空转对照：不泄漏不是因为"压根没用"）。
  D **"没配"与"连不上"是两件事**：IMAP 未配 → `mail-imap-unconfigured`；配了指向**不可达端口** →
    `imap-unreachable`（不是笼统的 `imap-read-failed`）；认证被服务端拒绝 → `imap-auth-failed` /
    `smtp-auth-failed`；配置齐但没试过 → `mail-*-unprobed`（**不因"看起来配好了"就报可用**）。
  E **有界读取并报截断**：假 IMAP 里 7 封、`limit=3` → 只取**最新 3 封**、`total=7`、`truncated=true`、
    `truncated_reason=mailbox-has-more`；单封返回体夹到 `max_message_bytes` → `clipped=true` 且 `clipped_messages>0`。
  F **配置键能经既有保存路径落盘**（本批要求 ②，路径**不变**）：`mail.smtp.*` / `mail.imap.*` 已登记在
    `host/lib/config-keys.mjs` + `host/lib/schema.mjs`；宿主干跑（`previewPatch`）受理；0600 待处理项 →
    `tools/config-apply.py` 真落盘到**临时** YAML（`project` 段出现点分键）并落 `config/changed`；
    **真 `/workspace/config.yaml` 全程字节不变**。
  G **纪律（静态 + 形状）**：`services/mail.py` 仍不 import 网络模块（AC-MAIL-001 第 4 号断言的口径）；
    `host/modules/mail-view.mjs` 不 import 网络/子进程（宿主零网络面）；状态快照与 `mail.json` 只有
    布尔/来源/计数/原因码；`mail-view` 对坏快照给**有名的**降级原因且仍有界。

**不碰真环境**：全程用临时目录 + 临时账本 + 临时 YAML + 环境变量（`env={}` 或显式 `env`），
不回显、不落盘任何真实凭据；测试用**哨兵值** `MAIL-CRED-SENTINEL-4b7f`（真凭据不存在）。

退出码：0 全通过 / 1 有断言失败 / 2 环境错误（与其它门同形）。
"""
from __future__ import annotations

import base64
import contextlib
import hashlib
import io
import json
import os
import re
import shutil
import socket
import socketserver
import stat
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.ledger import Ledger  # noqa: E402
from quotagent.services.mail_transport import (  # noqa: E402
    MailTransport, REASON_NEXT_ACTION, SANITIZED,
)

#: 测试哨兵（**不是**真凭据；真凭据不存在，也不假设存在）。它同时当 SMTP/IMAP 的账号口令。
SENTINEL = "MAIL-CRED-SENTINEL-4b7f"
SENTINEL_USER = "mail-user-sentinel"
SUBJECT = "mail-transport loopback probe"
BODY = "BODY-SENTINEL-mail-transport: real send over loopback"
FROM = "ops@example.com"
TO = "buyer@example.com"
RAW = (f"From: {FROM}\r\nTo: {TO}\r\nSubject: {SUBJECT}\r\nDate: 2026-09-21T09:30:00Z\r\n"
       f"\r\n{BODY}\r\n").encode("utf-8")

CHECKS: list = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append({"name": name, "ok": bool(ok), "detail": str(detail)[:400]})


def free_port() -> int:
    """占一个端口再放掉（用于构造"不可达端口"与给假服务选端口）。"""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stat_mode(path: str) -> int:
    """文件的权限位（`stat.S_IMODE`：只取 9 个权限位，不含类型位）。"""
    return stat.S_IMODE(os.stat(path).st_mode)


# ===========================================================================
# 假 SMTP 服务（标准库 socket；只说必要的话：220 / 250 / 354 / 250 / 221）
# ===========================================================================
class FakeSMTP(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        self.server.connections += 1
        self.wfile.write(b"220 fake.local ESMTP ready\r\n")
        while True:
            line = self.rfile.readline()
            if not line:
                return
            text = line.decode("utf-8", "replace").rstrip("\r\n")
            self.server.commands.append(text)
            upper = text.upper()
            if upper.startswith("EHLO"):
                self.wfile.write(b"250-fake.local\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10485760\r\n")
            elif upper.startswith("HELO"):
                self.wfile.write(b"250 fake.local\r\n")
            elif upper.startswith("AUTH"):
                if self.server.reject_auth:
                    self.wfile.write(b"535 5.7.8 Authentication credentials invalid\r\n")
                else:
                    self.wfile.write(b"235 2.7.0 Authentication successful\r\n")
            elif upper.startswith("MAIL FROM"):
                self.wfile.write(b"250 2.1.0 OK\r\n")
            elif upper.startswith("RCPT TO"):
                if self.server.refuse_recipients:
                    self.wfile.write(b"550 5.1.1 No such user here\r\n")
                else:
                    self.wfile.write(b"250 2.1.5 OK\r\n")
            elif upper == "DATA":
                self.wfile.write(b"354 End data with <CR><LF>.<CR><LF>\r\n")
                chunks = []
                while True:
                    part = self.rfile.readline()
                    if not part or part in (b".\r\n", b".\n"):
                        break
                    chunks.append(part)
                self.server.received = b"".join(chunks)
                self.wfile.write(b"250 2.0.0 Ok: queued as FAKE1\r\n")
            elif upper == "QUIT":
                self.wfile.write(b"221 2.0.0 Bye\r\n")
                return
            else:
                self.wfile.write(b"250 OK\r\n")


class FakeSMTPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    connections = 0
    received = b""
    commands: list = []
    reject_auth = False
    refuse_recipients = False


# ===========================================================================
# 假 IMAP 服务（标准库 socket；SELECT/EXAMINE + FETCH + LOGOUT 的最小面）
# ===========================================================================
class FakeIMAP(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        self.server.connections += 1
        self.wfile.write(b"* OK [CAPABILITY IMAP4rev1] fake imap ready\r\n")
        while True:
            line = self.rfile.readline()
            if not line:
                return
            text = line.decode("utf-8", "replace").rstrip("\r\n")
            parts = text.split(" ", 2)
            tag = parts[0]
            command = parts[1].upper() if len(parts) > 1 else ""
            # 每条响应都必须带**结尾文本**（`<tag> OK <text>`）：imaplib 的 tagre 要求 type 后有 data
            # （裸 `<tag> OK` 会让 imaplib 报 `unexpected response` —— 踩过一次，写在这里免得后人再踩）。
            if command == "CAPABILITY":
                self.wfile.write(b"* CAPABILITY IMAP4rev1\r\n")
                self.wfile.write(tag.encode() + b" OK CAPABILITY completed\r\n")
            elif command == "LOGIN":
                if self.server.reject_login:
                    self.wfile.write(tag.encode() + b" NO LOGIN failed: authentication rejected\r\n")
                else:
                    self.wfile.write(tag.encode() + b" OK LOGIN completed\r\n")
            elif command in ("SELECT", "EXAMINE"):
                count = len(self.server.messages)
                self.wfile.write(b"* %d EXISTS\r\n" % count)
                self.wfile.write(b"* 0 RECENT\r\n* OK [UIDVALIDITY 1] UIDs valid\r\n")
                self.wfile.write(tag.encode() + b" OK [READ-ONLY] SELECT completed\r\n")
            elif command == "FETCH":
                spec = parts[2].split(" ")[0].strip('"') if len(parts) > 2 else ""
                low, _sep, high = spec.partition(":")
                try:
                    start, end = int(low), int(high or low)
                except ValueError:
                    start, end = 1, len(self.server.messages)
                for index in range(start, min(end, len(self.server.messages)) + 1):
                    payload = self.server.messages[index - 1]
                    self.wfile.write(("* %d FETCH (RFC822 {%d}\r\n" % (index, len(payload))).encode())
                    self.wfile.write(payload)
                    self.wfile.write(b")\r\n")
                self.wfile.write(tag.encode() + b" OK FETCH completed\r\n")
            elif command == "LOGOUT":
                self.wfile.write(b"* BYE logging out\r\n")
                self.wfile.write(tag.encode() + b" OK LOGOUT completed\r\n")
                return
            else:
                self.wfile.write(tag.encode() + b" OK completed\r\n")


class FakeIMAPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    connections = 0
    messages: list = []
    reject_login = False


class Runner:
    """起假服务 / 关掉它（**零残留**：断言失败也要收干净，否则端口泄漏会连带污染后面的用例）。"""

    def __init__(self, server: socketserver.BaseServer) -> None:
        self.server = server
        self.port = int(server.server_address[1])
        self._thread = threading.Thread(target=server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        try:
            self.server.shutdown()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.server.server_close()
        except Exception:  # noqa: BLE001
            pass


def smtp_env(port: int, *, state: str, security: str = "plain", username: str = SENTINEL_USER,
             password: str = SENTINEL) -> dict:
    return {
        "QUOTAGENT_MAIL_SMTP_HOST": "127.0.0.1",
        "QUOTAGENT_MAIL_SMTP_PORT": str(port),
        "QUOTAGENT_MAIL_SMTP_FROM": FROM,
        "QUOTAGENT_MAIL_SMTP_SECURITY": security,
        **({"QUOTAGENT_MAIL_SMTP_USERNAME": username} if username != "" else {}),
        **({"QUOTAGENT_MAIL_SMTP_PASSWORD": password} if password != "" else {}),
        "QUOTAGENT_MAIL_STATE": state,
    }


def imap_env(port: int, *, state: str, limit_messages: str = "", security: str = "plain") -> dict:
    return {
        "QUOTAGENT_MAIL_IMAP_HOST": "127.0.0.1",
        "QUOTAGENT_MAIL_IMAP_PORT": str(port),
        "QUOTAGENT_MAIL_IMAP_SECURITY": security,
        "QUOTAGENT_MAIL_IMAP_USERNAME": SENTINEL_USER,
        "QUOTAGENT_MAIL_IMAP_PASSWORD": SENTINEL,
        "QUOTAGENT_MAIL_STATE": state,
    }


NO_CONFIG = str(Path(tempfile.gettempdir()) / "quotagent-mail-transport-absent" / "config.yaml")

#: 真配置文件在本门全程必须**字节不变**（门只用临时文件：不碰用户配置；与 webui 门同一口径）
REAL_CONFIG = Path("/workspace/config.yaml")
REAL_CONFIG_HASH = sha256_file(REAL_CONFIG) if REAL_CONFIG.exists() else ""
#: 内置的"缺省即真源"快照写入器（Python 侧唯一判定者；宿主只读它的输出）
SNAPSHOT_WRITER = ROOT / "tools" / "refresh-ui-snapshots.py"


# ===========================================================================
# A. 未配置 = 诚实拒绝（不是"失败了"）
# ===========================================================================
WORK = Path(tempfile.mkdtemp(prefix="mail-transport-gate-"))
try:
    state_a = str(WORK / "state-a.json")
    idle_smtp = Runner(FakeSMTPServer(("127.0.0.1", free_port()), FakeSMTP))
    idle_imap = Runner(FakeIMAPServer(("127.0.0.1", free_port()), FakeIMAP))
    plain = MailTransport(env={}, config_path=NO_CONFIG, state_path=state_a)
    status_a = plain.status()
    flat = json.dumps(status_a, ensure_ascii=False, sort_keys=True)
    check("A1 未配置：`status()` 给 available:false + configured:false + 具体 reason + 可行动 next_action，"
          "且 `connected:true` 一次都不出现（反例：没配也说可用/含糊说\"失败\"）",
          status_a["available"] is False and status_a["configured"] is False
          and status_a["connected"] is False and status_a["reason"] == "mail-smtp-unconfigured"
          and len(status_a["next_action"]) >= 8 and status_a["imap"]["reason"] == "mail-imap-unconfigured"
          and '"connected": true' not in flat and '"available": true' not in flat,
          f"available={status_a['available']} connected={status_a['connected']} "
          f"reason={status_a['reason']} imap={status_a['imap']['reason']}")

    sent_a = plain.send(raw=RAW)
    check("A2 未配置：`send()` 不假装发送（ok/sent/available 全 false + reason 指到配置键 + next_action），"
          "且**假服务端一次连接都没收到**（没有\"先试一下\"）",
          sent_a["ok"] is False and sent_a["sent"] is False and sent_a["available"] is False
          and sent_a["connected"] is False and sent_a["reason"] == "mail-smtp-unconfigured"
          and len(sent_a["next_action"]) >= 8 and idle_smtp.server.connections == 0
          and idle_smtp.server.received == b"",
          f"send={json.dumps({k: sent_a[k] for k in ('ok', 'sent', 'available', 'reason')}, ensure_ascii=False)} "
          f"假服务连接数={idle_smtp.server.connections}")

    fetched_a = plain.fetch_recent(3)
    probed_a = plain.probe("imap")
    check("A3 未配置：`fetch_recent()` / `probe()` 同样诚实拒绝（IMAP 说 `mail-imap-unconfigured`，"
          "消息列表为空，假 IMAP 一次连接都没收到）",
          fetched_a["ok"] is False and fetched_a["reason"] == "mail-imap-unconfigured"
          and fetched_a["messages"] == [] and fetched_a["count"] == 0
          and probed_a["reason"] == "mail-imap-unconfigured" and idle_imap.server.connections == 0,
          f"fetch={fetched_a['reason']} probe={probed_a['reason']} 假服务连接数={idle_imap.server.connections}")

    check("A4 每个 reason 都有可行动的 next_action（闭合词表；不许有\"下一步：无\"这种假行动）",
          all(isinstance(text, str) and len(text.strip()) >= 8 for text in REASON_NEXT_ACTION.values())
          and len(REASON_NEXT_ACTION) >= 12,
          f"词表 {len(REASON_NEXT_ACTION)} 条；最短 next_action="
          f"{min(len(text) for text in REASON_NEXT_ACTION.values())} 字符")

    # =======================================================================
    # B. 回环真收发（自建标准库假 SMTP） + C. 哨兵零泄漏
    # =======================================================================
    smtp_server = Runner(FakeSMTPServer(("127.0.0.1", free_port()), FakeSMTP))
    state_b = str(WORK / "state-b.json")
    ledger_path = WORK / "ledger-mail.jsonl"
    ledger = Ledger(ledger_path, realm="test:mail-transport")
    transport_b = MailTransport(env=smtp_env(smtp_server.port, state=state_b), config_path=NO_CONFIG)
    before_b = transport_b.status()
    logs = io.StringIO()
    with contextlib.redirect_stdout(logs), contextlib.redirect_stderr(logs):
        print("（把 status() 与 send() 的返回值原样打印一遍：日志里也不许出现哨兵）",
              json.dumps(before_b, ensure_ascii=False))
        result_b = transport_b.send(raw=RAW, ledger=ledger)
        print(json.dumps(result_b, ensure_ascii=False))
    received = smtp_server.server.received.decode("utf-8", "replace")
    sent_rows = ledger.read(type="mail/sent")
    check("B1 回环真发：`send()` 返回 ok/sent/connected 真值、命中收件人、字节数与报文一致，"
          "**假 SMTP 服务端真的收到报文**（主题与正文都在里面）",
          result_b["ok"] is True and result_b["sent"] is True and result_b["connected"] is True
          and result_b["available"] is True and result_b["accepted"] == [TO]
          and result_b["refused_recipients"] == [] and result_b["bytes"] == len(RAW)
          and result_b["body_sha256"].endswith(hashlib.sha256(RAW).hexdigest())
          and SUBJECT in received and BODY in received and f"To: {TO}" in received,
          f"ok={result_b['ok']} accepted={result_b['accepted']} bytes={result_b['bytes']} "
          f"假服务收到 {len(received)} 字节；含主题={SUBJECT in received} 含正文={BODY in received}")

    check("B2 账本落 `mail/sent`（class=fact、body 只留投递事实与摘要：没有凭据、没有正文），"
          "且**只有真发出去才有这一行**",
          len(sent_rows) == 1 and sent_rows[0]["class"] == "fact"
          and sent_rows[0]["type"] == "mail/sent"
          and (sent_rows[0].get("body") or {}).get("subject") == SUBJECT
          and (sent_rows[0].get("body") or {}).get("bytes") == len(RAW)
          and (sent_rows[0].get("body") or {}).get("accepted") == [TO]
          and (sent_rows[0].get("body") or {}).get("transport") == "smtp"
          and sorted((sent_rows[0].get("body") or {}).keys())
          == ["accepted", "body_sha256", "bytes", "from", "message_id", "ok", "reason",
              "refused_recipients", "server", "subject", "to", "transport"]
          and BODY not in json.dumps(sent_rows, ensure_ascii=False),
          f"行数={len(sent_rows)} body 键={sorted((sent_rows[0].get('body') or {}).keys())}")

    after_b = transport_b.status()
    check("B3 状态从\"未探测\"变成可用**只凭证据**：发之前是 `mail-smtp-unprobed`（不是可用），"
          "发之后 available/connected 为真且 reason 为空；状态快照文件已原子落盘且权限 0600",
          before_b["reason"] == "mail-smtp-unprobed" and before_b["available"] is False
          and after_b["available"] is True and after_b["connected"] is True and after_b["reason"] == ""
          and after_b["last_attempt"]["kind"] == "send" and after_b["last_attempt"]["ok"] is True
          and Path(state_b).exists() and stat_mode(state_b) == 0o600,
          f"发送前={before_b['reason']} 发送后 available={after_b['available']} "
          f"last={after_b.get('last_attempt')}")

    state_text = Path(state_b).read_text(encoding="utf-8")
    ledger_text = ledger_path.read_text(encoding="utf-8")
    result_text = json.dumps(result_b, ensure_ascii=False)
    # 非空转对照：哨兵口令**真的**被送到（假）服务端了（AUTH PLAIN 的 base64 里就有它）
    auth_wire = base64.b64encode(f"\x00{SENTINEL_USER}\x00{SENTINEL}".encode("utf-8")).decode("ascii")
    commands_text = "\n".join(smtp_server.server.commands)
    hits = {
        "账本文件": ledger_text.count(SENTINEL) + ledger_text.count(SENTINEL_USER),
        "send() 返回值": result_text.count(SENTINEL) + result_text.count(SENTINEL_USER),
        "日志（stdout/stderr）": logs.getvalue().count(SENTINEL) + logs.getvalue().count(SENTINEL_USER),
        "状态快照": state_text.count(SENTINEL) + state_text.count(SENTINEL_USER),
        "status() 视图": json.dumps(after_b, ensure_ascii=False).count(SENTINEL)
        + json.dumps(after_b, ensure_ascii=False).count(SENTINEL_USER),
    }
    check("C1 **凭据哨兵零泄漏**：口令与账号在账本 / `send()` 返回值 / 日志 / 状态快照 / `status()` 视图里"
          "出现次数 **= 0**；**非空转对照**：同一次发送里，哨兵确实作为 AUTH PLAIN 的 base64 被送到了假服务端",
          sum(hits.values()) == 0 and auth_wire in commands_text,
          f"出现次数={hits}；AUTH 行含哨兵 base64={auth_wire in commands_text}")

    # 认证被拒时异常消息也必须洗过（异常消息里最容易被顺手带上口令）
    reject_server = Runner(FakeSMTPServer(("127.0.0.1", free_port()), FakeSMTP))
    reject_server.server.reject_auth = True
    state_c2 = str(WORK / "state-c2.json")
    transport_c2 = MailTransport(env=smtp_env(reject_server.port, state=state_c2), config_path=NO_CONFIG)
    logs_c2 = io.StringIO()
    with contextlib.redirect_stdout(logs_c2), contextlib.redirect_stderr(logs_c2):
        result_c2 = transport_c2.send(raw=RAW, ledger=ledger)
        print(json.dumps(result_c2, ensure_ascii=False))
    check("C2 认证失败也算\"连不上\"的一种（`smtp-auth-failed`），而且**异常消息是洗过的**："
          "哨兵在返回体/日志/状态快照里出现次数 0（`sanitize()` 把已知密钥换成 `<redacted>`）",
          result_c2["ok"] is False and result_c2["reason"] == "smtp-auth-failed"
          and result_c2["sent"] is False
          and json.dumps(result_c2, ensure_ascii=False).count(SENTINEL) == 0
          and logs_c2.getvalue().count(SENTINEL) == 0
          and Path(state_c2).read_text(encoding="utf-8").count(SENTINEL) == 0,
          f"reason={result_c2['reason']} detail={str(result_c2.get('detail', ''))[:80]} "
          f"日志命中={logs_c2.getvalue().count(SENTINEL)}")
    reject_server.close()

    # 收件人被服务器全部拒绝 → 也是具体 reason（不是 sent，也不落 mail/sent）
    refuse_server = Runner(FakeSMTPServer(("127.0.0.1", free_port()), FakeSMTP))
    refuse_server.server.refuse_recipients = True
    state_c3 = str(WORK / "state-c3.json")
    rows_before_c3 = len(ledger.read(type="mail/sent"))
    result_c3 = MailTransport(env=smtp_env(refuse_server.port, state=state_c3),
                              config_path=NO_CONFIG).send(raw=RAW, ledger=ledger)
    check("C3 收件人被服务器全部拒绝 → `smtp-recipients-refused`、sent=false、**不落** `mail/sent`"
          "（\"发出去了\"与\"服务器拒收\"必须分开报）",
          result_c3["ok"] is False and result_c3["reason"] == "smtp-recipients-refused"
          and result_c3["sent"] is False
          and len(ledger.read(type="mail/sent")) == rows_before_c3,
          f"reason={result_c3['reason']} mail/sent 行数 {rows_before_c3}→{len(ledger.read(type='mail/sent'))}")
    refuse_server.close()
    smtp_server.close()

    # =======================================================================
    # D. "没配" 与 "连不上" 是两件事（不同故障 → 不同 reason）
    # =======================================================================
    RUNNERS = [idle_smtp, idle_imap]

    dead_port = free_port()                      # 占过又放掉的端口 → 连接立刻被拒（不超时、可复现）
    state_d1 = str(WORK / "state-d1.json")
    unreachable = MailTransport(env=imap_env(dead_port, state=state_d1), config_path=NO_CONFIG)
    result_d1 = unreachable.fetch_recent(3)
    status_d1 = unreachable.status()
    check("D1 IMAP 指向**不可达端口** → 具体 `imap-unreachable`（不是笼统\"失败\"、也不是 `imap-read-failed`）；"
          "`status()` 也如实报该 reason + 可行动 next_action",
          result_d1["ok"] is False and result_d1["reason"] == "imap-unreachable"
          and result_d1["messages"] == [] and result_d1["connected"] is False
          and status_d1["imap"]["available"] is False
          and status_d1["imap"]["reason"] == "imap-unreachable"
          and len(status_d1["imap"]["next_action"]) >= 8,
          f"fetch={result_d1['reason']} status={status_d1['imap']['reason']}")

    smtp_dead = MailTransport(env=smtp_env(dead_port, state=str(WORK / "state-d2.json")),
                              config_path=NO_CONFIG).send(raw=RAW)
    check("D2 SMTP 不可达 → `smtp-unreachable`（与\"没配\"的 `mail-smtp-unconfigured` 分得清），"
          "且 sent=false、账本不新增",
          smtp_dead["ok"] is False and smtp_dead["reason"] == "smtp-unreachable"
          and smtp_dead["sent"] is False and len(ledger.read(type="mail/sent")) == 1,
          f"reason={smtp_dead['reason']} sent={smtp_dead['sent']}")

    auth_imap = Runner(FakeIMAPServer(("127.0.0.1", free_port()), FakeIMAP))
    RUNNERS.append(auth_imap)
    auth_imap.server.reject_login = True
    rejected = MailTransport(env=imap_env(auth_imap.port, state=str(WORK / "state-d3.json")),
                             config_path=NO_CONFIG).fetch_recent(3)
    check("D3 IMAP 认证被服务端拒绝 → `imap-auth-failed`（不是 `imap-read-failed`；"
          "三类故障三码，运维照着 next_action 就能动手）",
          rejected["ok"] is False and rejected["reason"] == "imap-auth-failed"
          and len(rejected["next_action"]) >= 8,
          f"reason={rejected['reason']} next_action={str(rejected['next_action'])[:60]}")

    # =======================================================================
    # E. 有界读取并报截断（回环假 IMAP，7 封）
    # =======================================================================
    INBOUND = [(f"From: sender-{index}@example.com\r\nTo: {TO}\r\nSubject: inbound-{index}\r\n"
                f"Date: 2026-09-21T0{index}:00:00Z\r\n\r\nbody-{index}\r\n").encode("utf-8")
               for index in range(1, 8)]
    imap_server = Runner(FakeIMAPServer(("127.0.0.1", free_port()), FakeIMAP))
    RUNNERS.append(imap_server)
    imap_server.server.messages = INBOUND
    state_e = str(WORK / "state-e.json")
    bounded = MailTransport(env=imap_env(imap_server.port, state=state_e), config_path=NO_CONFIG)
    before_e = bounded.status()
    fetched = bounded.fetch_recent(3)
    subjects = [item["subject"] for item in fetched.get("messages", [])]
    check("E1 配置齐但没试过 → `mail-imap-unprobed`（**不因\"看起来配好了\"就报可用**）；"
          "试过之后（真取回）才 available:true",
          before_e["imap"]["available"] is False and before_e["imap"]["reason"] == "mail-imap-unprobed"
          and fetched["ok"] is True and fetched["available"] is True
          and fetched["connected"] is True
          and bounded.status()["imap"]["available"] is True,
          f"取之前={before_e['imap']['reason']} 取之后 available={fetched['available']}")

    check("E2 有界读取并报截断：7 封的邮箱、`limit=3` → 只取**最新 3 封**、`total=7`、"
          "`truncated=true`、`truncated_reason=mailbox-has-more`，且返回体里带每封的摘要",
          fetched["count"] == 3 and fetched["fetched"] == 3 and fetched["total"] == 7
          and fetched["limit"] == 3 and fetched["truncated"] is True
          and fetched["truncated_reason"] == "mailbox-has-more"
          and subjects == ["inbound-5", "inbound-6", "inbound-7"]
          and all(item["body_sha256"].startswith("sha256:") for item in fetched["messages"]),
          f"count={fetched['count']} total={fetched['total']} truncated={fetched['truncated']} "
          f"({fetched['truncated_reason']}) subjects={subjects}")

    clipped = MailTransport(env=imap_env(imap_server.port, state=str(WORK / "state-e2.json")),
                            config_path=NO_CONFIG, max_message_bytes=40).fetch_recent(2)
    sizes = [len(item["text"].encode("utf-8")) for item in clipped["messages"]]
    digests_ok = all(item["body_sha256"].endswith(hashlib.sha256(INBOUND[index]).hexdigest())
                     for index, item in zip(range(5, 7), clipped["messages"]))
    check("E3 单封**返回体**夹取：`max_message_bytes=40` → `clipped=true`、`clipped_messages>0`、"
          "`truncated=true`，每封 text 的字节数 ≤ 40；而 `body_sha256` 仍按**收到的整封**算"
          "（\"内容摘要\"与\"我们留下多少\"是两件事）",
          clipped["ok"] is True and clipped["clipped_messages"] >= 1 and clipped["truncated"] is True
          and all(size <= 40 for size in sizes) and all(item["clipped"] for item in clipped["messages"])
          and digests_ok,
          f"clipped={clipped['clipped_messages']} truncated_reason={clipped['truncated_reason']} "
          f"text 字节={sizes} 摘要按整封算={digests_ok}")

    # =======================================================================
    # F. 配置键：登记在单一真源里，并能经**既有保存路径**落盘（路径不变）
    # =======================================================================
    keys_text = (ROOT / "host" / "lib" / "config-keys.mjs").read_text(encoding="utf-8")
    schema_text = (ROOT / "host" / "lib" / "schema.mjs").read_text(encoding="utf-8")
    declared = dict(re.findall(r"'([^']+)':\s*\{\s*type:\s*'([a-z]+)',\s*default:", keys_text))
    wanted = ["mail.smtp.host", "mail.smtp.port", "mail.smtp.from", "mail.smtp.username",
              "mail.smtp.password", "mail.imap.host", "mail.imap.port", "mail.imap.username",
              "mail.imap.password", "mail.imap.mailbox"]
    missing_keys = [key for key in wanted if key not in declared]
    missing_schema = [key for key in wanted if f"'{key.rsplit('.', 1)[0]}.*'" not in schema_text]
    check("F1 配置键登记（跨语言单一真源）：`mail.smtp.*` / `mail.imap.*` 都在 "
          "`host/lib/config-keys.mjs`（类型 + 默认层）与 `host/lib/schema.mjs`（可改性/人工专属）里 —— "
          "配置 UI 才有键可选、Python 侧才认这个键",
          not missing_keys and not missing_schema and declared.get("mail.smtp.port") == "integer"
          and declared.get("mail.smtp.host") == "string",
          f"缺登记={missing_keys or '无'} 缺 schema 模式={missing_schema or '无'} "
          f"类型={ {key: declared.get(key) for key in ('mail.smtp.host', 'mail.smtp.port')} }")

    node = shutil.which("node")
    review_script = "\n".join([
        "import { previewPatch } from './lib/config-ui.mjs'",
        "const withRef = previewPatch({ doc: {}, env: {}, runtime: {},",
        "  patch: { layer: 'project', target: 'project', fields: { 'mail.smtp.host': 'smtp.example.com' },",
        "    human_approval_ref: 'ap-0000' } })",
        "const noRef = previewPatch({ doc: {}, env: {}, runtime: {},",
        "  patch: { layer: 'project', target: 'project', fields: { 'mail.smtp.host': 'smtp.example.com' } } })",
        "const editable = previewPatch({ doc: {}, env: {}, runtime: {},",
        "  patch: { layer: 'project', target: 'project', fields: { 'mail.timeout_seconds': 7 },",
        "    human_approval_ref: 'ap-0000' } })",
        "const unknown = previewPatch({ doc: {}, env: {}, runtime: {},",
        "  patch: { layer: 'project', target: 'project', fields: { 'mail.smtp.mystery': 'x' },",
        "    human_approval_ref: 'ap-0000' } })",
        "console.log(JSON.stringify({ withRef: { accepted: withRef.accepted, diff: withRef.diff.length,",
        "  reasons: withRef.reasons.map((item) => item.code) },",
        "  noRef: { accepted: noRef.accepted, reasons: noRef.reasons.map((item) => item.code),",
        "    vetoed_by: noRef.vetoed_by },",
        "  editable: { accepted: editable.accepted, reasons: editable.reasons.map((item) => item.code) },",
        "  unknown: { accepted: unknown.accepted, reasons: unknown.reasons.map((item) => item.code) } }))",
    ])
    preview_proc = subprocess.run([str(node), "--input-type=module", "-e", review_script],
                                  cwd=str(ROOT / "host"), capture_output=True, text=True, timeout=120)
    preview = {}
    try:
        preview = json.loads(preview_proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        preview = {}
    check("F2 宿主配置 UI 的干跑（`previewPatch`）受理这些键：带人工引用 `ap-0000` → accepted + 出 diff；"
          "**不带**人工引用 → 拒（`humanOnly`：端点与凭据只能由人改）；未登记键 → 拒（`unknown-key`）；"
          "运行期旋钮（`mail.timeout_seconds`）不属人工专属 → accepted",
          preview.get("withRef", {}).get("accepted") is True
          and preview.get("withRef", {}).get("diff", 0) >= 1
          and preview.get("noRef", {}).get("accepted") is False
          and "humanOnly" in preview.get("noRef", {}).get("reasons", [])
          and preview.get("editable", {}).get("accepted") is True
          and preview.get("unknown", {}).get("accepted") is False
          and "unknown-key" in preview.get("unknown", {}).get("reasons", []),
          f"rc={preview_proc.returncode} {json.dumps(preview, ensure_ascii=False)[:240]} "
          f"{preview_proc.stderr.strip()[-120:]}")

    NOW = "2026-09-21T12:00:00Z"
    tail_smtp = Runner(FakeSMTPServer(("127.0.0.1", free_port()), FakeSMTP))
    RUNNERS.append(tail_smtp)
    apply_dir = WORK / "config-apply"
    inbox = apply_dir / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    yaml_path = apply_dir / "config.yaml"
    apply_ledger = apply_dir / "config-ledger.jsonl"
    init_proc = subprocess.run([sys.executable, str(ROOT / "tools" / "config-apply.py"), "--init",
                                "--file", str(yaml_path), "--ledger", str(apply_ledger),
                                "--actor", "human:gate", "--now", NOW],
                               cwd=str(ROOT), capture_output=True, text=True, timeout=120)
    # 配置值故意指向**回环假 SMTP**：这样后面能证明"UI 落盘的那份配置"真的能把信发出去
    fields = {"mail.smtp.host": "127.0.0.1", "mail.smtp.port": tail_smtp.port,
              "mail.smtp.from": FROM, "mail.smtp.security": "plain"}
    canonical = json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    item = {"request_id": "gate-mail-0001", "layer": "project", "target": "project", "fields": fields,
            "payload_sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
            "bytes": len(canonical.encode("utf-8")), "schema": 1, "submitted_at": None,
            "submitted_by": "gate"}
    item_path = inbox / f"cfg-{item['payload_sha256'][:16]}.json"
    item_path.write_text(json.dumps(item, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    os.chmod(item_path, 0o600)
    apply_proc = subprocess.run([sys.executable, str(ROOT / "tools" / "config-apply.py"),
                                 "--inbox", str(inbox), "--file", str(yaml_path),
                                 "--ledger", str(apply_ledger), "--approval-ref", "ap-0001",
                                 "--actor", "human:gate", "--now", NOW],
                                cwd=str(ROOT), capture_output=True, text=True, timeout=180)
    yaml_text = yaml_path.read_text(encoding="utf-8") if yaml_path.exists() else ""
    changed_rows = [json.loads(line) for line in apply_ledger.read_text(encoding="utf-8").splitlines()
                    if line.strip() and json.loads(line).get("type") == "config/changed"]
    landed = [row for row in changed_rows
              if str(((row.get("body") or {}).get("key_path")) or "") in fields]
    check("F3 **保存路径不变**：0600 待处理项 → `tools/config-apply.py` 真落盘到（临时）YAML 的 `project` 段"
          "（点分键形式，四个键都落），并逐个落 `config/changed`；"
          "账本行里只有键名与摘要、**没有任何值**",
          init_proc.returncode == 0 and apply_proc.returncode == 0
          and all(f"{key}: " in yaml_text for key in fields)
          and len(landed) == len(fields)
          and all("new_digest" in (row.get("body") or {}) for row in landed)
          and FROM not in apply_ledger.read_text(encoding="utf-8"),
          f"init rc={init_proc.returncode} apply rc={apply_proc.returncode} "
          f"config/changed={len(changed_rows)} 行（其中本项 {len(landed)} 行）；"
          f"YAML 片段={[line for line in yaml_text.splitlines() if 'mail.smtp' in line][:4]}")

    transported = MailTransport(env={}, config_path=str(yaml_path), state_path=str(WORK / "state-f.json"))
    settings_sources = transported.declared("smtp")["keys"]
    transported_status = transported.status()
    check("F4 落盘后的键**真的被传输层读到**（同一条链：UI → 待处理项 → config-apply.py → YAML → mail_transport）："
          "`host`/`port`/`from`/`security` 四个键来源都是 `file`，且因为还没真发过 → `mail-smtp-unprobed`"
          "（配置齐 ≠ 可用）",
          all(settings_sources[key]["source"] == "file"
              for key in ("host", "port", "from", "security"))
          and transported.missing_keys("smtp") == [] and transported_status["configured"] is True
          and transported_status["available"] is False
          and transported_status["reason"] == "mail-smtp-unprobed",
          f"来源={ {key: value['source'] for key, value in settings_sources.items()} } "
          f"status={transported_status['reason']}")

    real_config = Path("/workspace/config.yaml")
    real_now = sha256_file(real_config) if real_config.exists() else ""
    check("F5 **真实** `/workspace/config.yaml` 全程字节不变（门只用临时文件：不碰用户的配置）",
          real_now == REAL_CONFIG_HASH,
          f"门开始时={REAL_CONFIG_HASH[:16]}… 现在={real_now[:16] if real_now else '（不存在）'}…")

    # =======================================================================
    # F6. **配置来自文件层**时也真能发出去；Python 侧快照写入器把结果落成宿主只读的 `mail.json`
    # =======================================================================
    ledger_tail_path = WORK / "ledger-tail.jsonl"
    ledger_tail = Ledger(ledger_tail_path, realm="test:mail-transport")
    tail_state = str(WORK / "state-f6.json")
    tail = MailTransport(env={}, config_path=str(yaml_path), state_path=tail_state)
    tail_result = tail.send(raw=RAW, ledger=ledger_tail)
    check("F6 配置**来自文件层**（就是 UI 落盘的那份 YAML）时也真能发出去：`send()` ok/connected、"
          "假 SMTP 收到报文、账本落一行 `mail/sent`、`status()` 由 `mail-smtp-unprobed` 变成可用",
          tail_result["ok"] is True and tail_result["connected"] is True
          and tail_result["accepted"] == [TO] and tail_result["bytes"] == len(RAW)
          and SUBJECT in tail_smtp.server.received.decode("utf-8", "replace")
          and len(ledger_tail.read(type="mail/sent")) == 1
          and tail.status()["available"] is True and tail.status()["reason"] == "",
          f"ok={tail_result['ok']} accepted={tail_result['accepted']} "
          f"假服务收到 {len(tail_smtp.server.received)} 字节 status={tail.status()['reason'] or '可用'}")

    view_dir = WORK / "contractor"
    view_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ledger_tail_path, view_dir / "ledger.jsonl")
    snap_proc = subprocess.run([sys.executable, str(SNAPSHOT_WRITER), "--views", "contractor",
                                "--shared-dir", str(WORK), "--mail-state", tail_state,
                                "--mail-config", str(yaml_path)],
                               cwd=str(ROOT), capture_output=True, text=True, timeout=180)
    snap_stdout = {}
    try:
        snap_stdout = json.loads(snap_proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        snap_stdout = {}
    mail_json_path = WORK / "mail.json"
    mail_json_text = mail_json_path.read_text(encoding="utf-8") if mail_json_path.exists() else ""
    check("F7 快照写入器（`tools/refresh-ui-snapshots.py`）写出的 `mail.json`：队列计数来自账本（`sent=1`）、"
          "传输段来自 `mail_transport` 的真实状态（`smtp.available=true`）；**哨兵出现次数 0**"
          "（宿主读的就是这份文件，凭据不能随它出门）",
          snap_proc.returncode == 0 and snap_stdout.get("mail_totals", {}).get("sent") == 1
          and snap_stdout.get("mail_transport", {}).get("smtp_available") is True
          and mail_json_path.exists()
          and mail_json_text.count(SENTINEL) == 0 and mail_json_text.count(SENTINEL_USER) == 0,
          f"rc={snap_proc.returncode} stdout={json.dumps(snap_stdout, ensure_ascii=False)[:200]} "
          f"snapshot 命中哨兵={mail_json_text.count(SENTINEL)}")

    # =======================================================================
    # G. 纪律（静态 + 形状）
    # =======================================================================
    import ast  # noqa: PLC0415 —— 只在断言里用一次，放这里读起来更贴近断言

    mail_tree = ast.parse((ROOT / "src" / "system" / "mail" / "code" / "mail.py").read_text(encoding="utf-8"))
    mail_imports: set = set()
    for node_ in ast.walk(mail_tree):
        if isinstance(node_, ast.Import):
            mail_imports |= {alias.name.split(".")[0] for alias in node_.names}
        elif isinstance(node_, ast.ImportFrom) and not node_.level:
            mail_imports.add((node_.module or "").split(".")[0])
    view_source = (ROOT / "host" / "modules" / "mail-view.mjs").read_text(encoding="utf-8")
    # **按 import 说明符判**（不是按正文里出现过这个词：注释里写"不 import net"不该被判成 import）
    view_specifiers = re.findall(r"from\s+'([^']+)'", view_source) + re.findall(r"import\(\s*'([^']+)'", view_source)
    view_banned = [spec for spec in view_specifiers
                   if spec in {"node:net", "node:http", "node:https", "node:tls", "node:dgram",
                               "node:child_process", "node:worker_threads", "net", "http", "https", "tls",
                               "dgram", "child_process", "worker_threads"}]
    check("G1 网络面住在另一个文件里（**边界不被绕过**）：`services/mail.py` 仍不 import "
          "smtplib/imaplib/poplib/socket/subprocess（AC-MAIL-001 第 4 号断言的口径原样成立）；"
          "`host/modules/mail-view.mjs` 的 import 说明符里没有网络/子进程模块（宿主只读文件）",
          not (mail_imports & {"smtplib", "imaplib", "poplib", "socket", "subprocess"}) and not view_banned
          and "readFileSync" in view_source,
          f"mail.py imports={sorted(mail_imports)}；mail-view imports={view_specifiers} "
          f"命中={view_banned or '无'}")

    #: **值字段**的键名（这些名字一出现=有人把值放进来了）；`username`/`password` 作为**声明键名**是允许的
    #: （只报"这个键在哪一层、在不在、是不是凭据"——与 `/admin/api/credentials` 的既有口径一致，**
    #: 不含任何值**；值本身由 C1 的哨兵计数与 F7 的快照计数守着）。
    VALUE_KEYS = {"value", "secret_value", "plaintext", "raw", "text", "body", "credential_value",
                  "passwd", "token"}

    def value_leaves(node: object, found: set, trail: str = "") -> set:
        if isinstance(node, dict):
            for key, value in node.items():
                if str(key).lower() in VALUE_KEYS:
                    found.add(f"{trail}.{key}")
                value_leaves(value, found, f"{trail}.{key}")
        elif isinstance(node, list):
            for index, item in enumerate(node):
                value_leaves(item, found, f"{trail}[{index}]")
        return found

    state_payload = json.loads(Path(state_b).read_text(encoding="utf-8"))
    snapshot_payload = json.loads((WORK / "mail.json").read_text(encoding="utf-8"))
    declaration_leaves = set()
    for service in ("smtp", "imap"):
        for _key, entry in (snapshot_payload["transport"][service].get("keys") or {}).items():
            declaration_leaves |= set(entry.keys()) if isinstance(entry, dict) else {"<非对象>"}
    check("G2 状态快照与邮件域快照里**没有任何值字段**（`value`/`secret_value`/`plaintext`/`raw`/`body`/"
          "`text` 这类键名一个都没有）；配置声明面只允许 `source`/`present`/`secret` 三个键（键名与"
          "是否凭据可以有——值不可以）；且快照如实反映\"真发过一封\"（`smtp.available=true`、`sent=1`）",
          not value_leaves(state_payload, set()) and not value_leaves(snapshot_payload, set())
          and declaration_leaves <= {"source", "present", "secret"}
          and snapshot_payload["transport"]["smtp"]["available"] is True
          and snapshot_payload["totals"]["sent"] == 1,
          f"状态文件值字段={sorted(value_leaves(state_payload, set())) or '无'} "
          f"mail.json 值字段={sorted(value_leaves(snapshot_payload, set())) or '无'} "
          f"声明面键={sorted(declaration_leaves)} totals={snapshot_payload.get('totals')}")

    view_script = "\n".join([
        "import { Context, EventsService } from 'cordis'",
        "import { apply, Config } from './modules/mail-view.mjs'",
        "const run = async (state) => {",
        "  const ctx = new Context()",
        "  await ctx.plugin(EventsService)",
        "  const box = {}",
        "  await ctx.plugin({ name: 'probe', inject: [], Config,",
        "    apply: async (inner, cfg) => {",
        "      const original = inner.provide.bind(inner)",
        "      inner.provide = (service, value) => { if (service === 'mailView') box.handle = value",
        "        return original(service, value) }",
        "      await apply(inner, cfg) } }, Config.parse({ mail_state: state,",
        "        ui_shared: state === '' ? '' : 'tmp/ui-shared' }))",
        "  const view = box.handle.read()",
        "  return view",
        "}",
        "const broken = await run(process.argv[1])",
        "const real = await run(process.argv[2])",
        "const missing = await run('')",
        "console.log(JSON.stringify({",
        "  broken: { degraded: broken.degraded, reason: broken.reason, next_action: broken.next_action },",
        "  missing: { degraded: missing.degraded, reason: missing.reason },",
        "  real: { degraded: real.degraded, sent: real.counts.sent, queued: real.counts.queued,",
        "    smtp_available: real.smtp.available, smtp_reason: real.smtp.reason,",
        "    headline: real.headline, bounded: real.bounded,",
        "    attempts: real.attempts.length, views: real.views.length } }))",
    ])
    broken_path = WORK / "broken.json"
    broken_path.write_text("{ 这不是 JSON", encoding="utf-8")
    view_proc = subprocess.run([str(node), "--input-type=module", "-e", view_script,
                                str(broken_path), str(WORK / "mail.json")],
                               cwd=str(ROOT / "host"), capture_output=True, text=True, timeout=180)
    view_out = {}
    try:
        view_out = json.loads(view_proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        view_out = {}
    check("G3 宿主视图（`mail-view`）对**坏快照**给有名的降级原因、对**未配置**也说 `mail-snapshot-unconfigured`、"
          "对**真快照**给出可读结论（队列已发 1 / SMTP 可用 / headline 非空 / 有界为假）；全程不抛异常",
          view_out.get("broken", {}).get("degraded") is True
          and view_out.get("broken", {}).get("reason") == "mail-snapshot-unparsable"
          and len(str(view_out.get("broken", {}).get("next_action", ""))) >= 8
          and view_out.get("missing", {}).get("reason") == "mail-snapshot-unconfigured"
          and view_out.get("real", {}).get("degraded") is False
          and view_out.get("real", {}).get("sent") == 1
          and view_out.get("real", {}).get("smtp_available") is True
          and len(str(view_out.get("real", {}).get("headline", ""))) > 10,
          f"rc={view_proc.returncode} {json.dumps(view_out, ensure_ascii=False)[:240]} "
          f"stderr={view_proc.stderr.strip()[-300:]}")

    modules_proc = subprocess.run([str(node), str(ROOT / "host" / "check-modules.mjs"),
                                   "--module", "mail-view"],
                                  cwd=str(ROOT / "host"), capture_output=True, text=True, timeout=300)
    try:
        modules_report = json.loads(modules_proc.stdout)
    except ValueError:
        modules_report = {}
    check("G4 `mail-view` 的模块 fixture A1..A6（含 A5 确定性：同输入两次输出字节一致）全绿，"
          "且报告里模块名就是 `mail-view`（不是空集合）",
          modules_proc.returncode == 0 and modules_report.get("passed") == modules_report.get("total")
          and (modules_report.get("total") or 0) >= 8 and "mail-view" in (modules_report.get("modules") or []),
          f"rc={modules_proc.returncode} {modules_report.get('passed')}/{modules_report.get('total')} "
          f"modules={modules_report.get('modules')}")
finally:
    for runner in (locals().get("RUNNERS") or []):
        try:
            runner.close()
        except Exception:  # noqa: BLE001
            pass
    shutil.rmtree(WORK, ignore_errors=True)


# ===========================================================================
# 报告（逐条 [ok]/[FAIL] + 汇总；退出码与其它门同形）
# ===========================================================================
failed = [item for item in CHECKS if not item["ok"]]
for item in CHECKS:
    print(f"{'[ok]  ' if item['ok'] else '[FAIL]'} {item['name']}")
    if item["detail"]:
        print(f"        {item['detail']}")
print(f"RESULT: {'PASS' if not failed else 'FAIL'}（mail-transport 门 {len(CHECKS) - len(failed)}/{len(CHECKS)}）")
print(json.dumps({"gate": "mail-transport", "passed": len(CHECKS) - len(failed), "total": len(CHECKS),
                  "failures": [item["name"] for item in failed]}, ensure_ascii=False))
raise SystemExit(1 if failed else 0)
