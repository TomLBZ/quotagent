#!/usr/bin/env python3
"""工作区服务入口：quotagent WebUI（由 `ws-gateway` 以 `$PY <本脚本>` 拉起）。
**位置（本批迁移）**：实体在 `src/system/webui/tools/webui-serve.py`；旧位置 `tools/webui-serve.py` 只剩**薄转发**
（`runpy` 指到本文件）—— 门名、`tools/verify.sh` 的分支、`./run` 与文档里的既有命令**一行未改**。

为什么是个 Python 包装：工作区清单（`services/services.json`）只把 `script` 交给工作区 Python 运行，
而 WebUI 本身是 **cordis 插件**（Node）。所以这里只做两件事：

1. `--healthz PORT`：按工作区服务契约探测本服务的健康路径（退出 0/1，供 `ws-gateway` 保活）；
2. 否则：exec 掉 `node host/cli.mjs webui`（**不留中间进程**），把 UI 跑起来。

默认值可被环境变量覆盖（`QUOTAGENT_WEBUI_PORT` / `QUOTAGENT_UI_LEDGER_CONTRACTOR` /
`QUOTAGENT_UI_LEDGER_SUPPLIER`），以便同一份脚本在不同机器上只改清单不改编码。
"""
from __future__ import annotations

import stat
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
HEALTH_PATH = "/api/health"


def refresh_mail_snapshot() -> None:
    """刷新**邮件域**状态快照（`<ui-shared>/mail.json`）。与留存计划同一模式：**走查会清 `tmp/`，所以 seed 之后
    要补一次**，探活时也刷一次，界面就不会长期停在 degraded。尽力而为，不影响探活结果。

    写入者是归属插件自己的工具 `src/system/mail/tools/mail-snapshot.py`（旧的三域快照写入器
    `tools/refresh-ui-snapshots.py` 已按 `docs/design/29-webui-gui-app.md` §2 与三域流水运维面**一起退役**）。
    """
    script = ROOT / "src" / "system" / "mail" / "tools" / "mail-snapshot.py"
    if not script.exists():
        return
    try:
        proc = subprocess.run([sys.executable, str(script), "--shared-dir", str(ROOT / "tmp" / "ui-shared")],
                              capture_output=True, timeout=120, check=False)
        if proc.returncode != 0:
            print(f"[webui-serve] 邮件快照刷新失败 rc={proc.returncode} "
                  f"{(proc.stderr or b'').decode('utf-8', 'ignore')[-120:]}", file=sys.stderr, flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[webui-serve] 邮件快照刷新异常（不影响探活）：{exc}", file=sys.stderr, flush=True)


def refresh_admin_snapshot() -> None:
    """刷新系统管理快照（阻塞/进度）——与留存计划、邮件快照同一模式的**钩子**。

    真源：`.agents/state.json`（任务登记/阻塞/进度）+ `docs/work/progress-checklist.md`（任务行状态）
    + `tmp/ui-shared/mail.json`（服务自述不可用：`transport.<通道>.available=false` 的节点）。
    第三个源原来指三域快照 `pipeline.json`；那个写入器已随运维面退役 ⇒ 改指**仍在被写的**邮件域快照
    （判定与形状要求不变：`services/admin_blocks.py` 只看"含非空 views 的快照里 available=false 的节点"）。
    **只读**这些输入、只写一个快照文件；判定在 `services/admin_blocks.py`（Python 管事实）。
    """
    script = ROOT / "tools" / "refresh-admin-snapshot.py"
    if not script.exists():
        return
    try:
        proc = subprocess.run([sys.executable, str(script),
                               "--state", str(ROOT / ".agents" / "state.json"),
                               "--checklist", str(ROOT / "docs" / "work" / "progress-checklist.md"),
                               "--pipeline", str(ROOT / "tmp" / "ui-shared" / "mail.json"),
                               "--out", str(ROOT / "tmp" / "ui-shared" / "admin.json"),
                               "--resolutions", str(ROOT / "tmp" / "ui-shared" / "admin" / "ledger.jsonl")],
                              capture_output=True, timeout=120, check=False)
        if proc.returncode != 0:
            print(f"[webui-serve] admin 快照刷新失败 rc={proc.returncode} "
                  f"{(proc.stderr or b'').decode('utf-8', 'ignore')[-120:]}", file=sys.stderr, flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[webui-serve] admin 快照刷新异常（不影响探活）：{exc}", file=sys.stderr, flush=True)


def admin_token() -> str:
    """管理员 token 的**唯一**供给链（绝不落仓库、绝不打印）：

    ① 环境变量 `QUOTAGENT_ADMIN_TOKEN`（容器/编排注入）；
    ② 0600 文件 `config/quotagent-admin-token`（本机运维自己放，权限必须是 600）；
    没配就是"未启用"——admin 道保持统一拒绝体，并且**面板会把这件事本身当成一条阻塞显示**。
    """
    env = os.environ.get("QUOTAGENT_ADMIN_TOKEN", "").strip()
    if env:
        return env
    path = Path(os.environ.get("QUOTAGENT_ADMIN_TOKEN_FILE", str(ROOT.parent.parent / "config" / "quotagent-admin-token")))
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
        if mode != 0o600:
            print(f"[webui-serve] 忽略 {path}：权限 {oct(mode)} 不是 600", file=sys.stderr, flush=True)
            return ""
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""
    except Exception as exc:  # noqa: BLE001
        print(f"[webui-serve] 读 token 失败（按未启用处理）：{exc}", file=sys.stderr, flush=True)
        return ""


def refresh_retention_plan() -> None:
    """刷新留存计划（**钩子**）：判定在 Python 侧，这里是让它"保持新鲜"的时机。

    为什么要有它：走查/清 `tmp/` 的任务会把计划文件带走，界面会一直停在 `degraded`。
    调用点两处：① `main()` 里 seed 之后（走查刚清过目录）；② `probe()`（网关周期性探活）。
    尽力而为：失败只告警，不影响探活结果（否则一个展示项能把服务判成不健康）。
    """
    script = ROOT / "tools" / "refresh-retention-plan.py"
    if not script.exists():
        return
    try:
        proc = subprocess.run([sys.executable, str(script)], capture_output=True, timeout=60, check=False)
        if proc.returncode != 0:
            print(f"[webui-serve] 留存计划刷新失败 rc={proc.returncode} "
                  f"{(proc.stderr or b'').decode('utf-8', 'ignore')[-120:]}", file=sys.stderr, flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[webui-serve] 留存计划刷新异常（不影响探活）：{exc}", file=sys.stderr, flush=True)


def node_bin() -> str:
    found = shutil.which("node")
    if found:
        return found
    for candidate in sorted(Path("/workspace/runtime/node").glob("*/bin/node")):
        return str(candidate)
    raise SystemExit("quotagent webui: 未找到 node（宿主层需要 Node；纯内核不需要）")


def probe(port: int, path: str = HEALTH_PATH, timeout: float = 3.0) -> int:
    # 刷新钩子：`ws-gateway` 周期性探活 → 顺手重算一次留存计划（判定在 Python 侧）。
    # 为什么需要它：清 `tmp/` 的任务会把计划文件带走，界面会长期停在 degraded。
    refresh_retention_plan()
    refresh_mail_snapshot()
    refresh_admin_snapshot()
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=timeout) as sock:
            sock.sendall(f"GET {path} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n".encode())
            data = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
        head = data.split(b"\r\n", 1)[0]
        return 0 if b" 200 " in head else 1
    except OSError:
        return 1


def main(argv: list[str]) -> int:
    if "--healthz" in argv:
        return probe(int(argv[argv.index("--healthz") + 1]))
    port = os.environ.get("QUOTAGENT_WEBUI_PORT", "8093")
    # 先跑一遍走查（keep-shared）产生**真实**两侧账本，UI 展示的就是 g1 MVP 门产出的数据。
    # 走查失败**不阻塞** UI 启动（账本缺失时 UI 会自报 unhealthy），但原因写进日志。
    if os.environ.get("QUOTAGENT_WEBUI_SEED", "1") == "1":
        ui_shared = str(ROOT / "tmp" / "ui-shared")
        seeded = subprocess.run([sys.executable, str(ROOT / "src" / "system" / "repo-gate" / "tests" / "g1-walkthrough.py"),
                                 "--keep-shared", "--shared-dir", ui_shared],
                                cwd=str(ROOT), capture_output=True, text=True, timeout=300)
        print(f"[webui-serve] 走查 seed rc={seeded.returncode} "
              f"{(seeded.stdout or '').strip().splitlines()[-1][:120] if seeded.stdout.strip() else ''}",
              file=sys.stderr, flush=True)
    # seed 之后立即刷新留存计划与邮件快照：走查会清空 ui-shared/，
    # 不补这一下，界面会一直停在 degraded 直到下一次探活。
    refresh_retention_plan()
    refresh_mail_snapshot()
    refresh_admin_snapshot()
    args = [node_bin(), str(ROOT / "host" / "cli.mjs"), "webui", "--profile", "webui", "--port", str(port),
            "--host", os.environ.get("QUOTAGENT_WEBUI_HOST", "127.0.0.1"),
            "--prefix", os.environ.get("QUOTAGENT_WEBUI_PREFIX", "/quotagent"),
            "--ledger-contractor", os.environ.get(
                "QUOTAGENT_UI_LEDGER_CONTRACTOR", str(ROOT / "tmp" / "ui-shared" / "contractor" / "ledger.jsonl")),
            "--ledger-supplier", os.environ.get(
                "QUOTAGENT_UI_LEDGER_SUPPLIER", str(ROOT / "tmp" / "ui-shared" / "supplier" / "ledger.jsonl")),
            "--retention-plan", os.environ.get(
                "QUOTAGENT_UI_RETENTION_PLAN", str(ROOT / "tmp" / "ui-shared" / "retention-plan.json")),
            "--mail-snapshot", os.environ.get(
                "QUOTAGENT_UI_MAIL", str(ROOT / "tmp" / "ui-shared" / "mail.json")),
            "--admin-snapshot", os.environ.get(
                "QUOTAGENT_UI_ADMIN", str(ROOT / "tmp" / "ui-shared" / "admin.json")),
            "--admin-inbox", os.environ.get(
                "QUOTAGENT_UI_ADMIN_INBOX", str(ROOT / "tmp" / "ui-shared" / "admin-submissions")),
            '--ui-shared', os.environ.get("QUOTAGENT_UI_SHARED", str(ROOT / "tmp" / "ui-shared")),
            # RFQ 投递信封：发送方（承包商侧）写进共享交换目录的交付件 —— 被邀供应商由此看到"发给自己的包"
            # （`delivered_to` 收件人作用域 + 字段白名单在 host/modules/projection.mjs）；缺省指向 g1 走查
            # 产出的那份 `01-package.json`（真供应商进程读的同一份文件）。
            '--rfq-delivery', os.environ.get(
                "QUOTAGENT_UI_RFQ_DELIVERY", str(ROOT / "tmp" / "ui-shared" / "contractor" / "01-package.json")),
            "--market-modules", str(ROOT / "host" / "modules"),
            "--market-inventory", str(ROOT / "docs" / "design" / "14-plugin-inventory.md"),
            "--market-user-space", str(ROOT / "user-space"),
            "--user-space-root", str(ROOT / "user-space")]
    # `--config-file` **全链下传**（P50）：`./run up --config-file X` 把 X 放进本进程环境
    # （`QUOTAGENT_UI_CONFIG`，见 `run` 的 `do_up`），这里把它**显式**交给 `host/cli.mjs`
    # （而不是靠 cli 自己再读一遍环境）：插件拿到的 `host.config.config_file` 与配置面（唯一落盘者的
    # 入口）读的必须是**同一份路径**。空 = 一个字都不加 ⇒ 缺省链（`/workspace/config.yaml`）一字未改。
    config_ui = os.environ.get("QUOTAGENT_UI_CONFIG", "").strip()
    if config_ui:
        args += ["--config-file", config_ui]
    # 管理员 token：**进子进程环境变量，不进 argv**（argv 在 ps 里可见）
    tok = admin_token()
    env = dict(os.environ)
    if tok:
        env["QUOTAGENT_ADMIN_TOKEN"] = tok
    else:
        env.pop("QUOTAGENT_ADMIN_TOKEN", None)
        print("[webui-serve] 未配置管理员 token：admin 道保持未启用（面板会把它当阻塞显示）", file=sys.stderr, flush=True)
    os.execve(args[0], args, env)  # 不留中间进程（工作区服务模型要求脚本自身就是服务）
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
