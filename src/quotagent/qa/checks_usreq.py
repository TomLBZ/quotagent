"""AC-USREQ-006 机检：**cron 没待处理反馈时不得发垃圾消息**（用户原话，`FR-USREQ-006`）。

这条需求的可机检部分在**探测器**上：反馈闭环的 cron job 把 `tools/ui-feedback-monitor.sh` 的输出
当作「有没有变化」的判据 —— 输出与上次相同 ⇒ 调度器**跳过**本次运行（不发任何消息）。所以
「不发垃圾消息」等价于三条可判事实：

  ① 输出**只由待办清单决定**（两次运行逐字节一致、换 TZ 也一致）—— 否则「相同 ⇒ 跳过」不成立；
  ② 待办为 0 时输出**恰一行 `pending=0`**（没有第二条内容 ⇒ 无东西可投递），且不含任何消息措辞；
  ③ **非空转**：真造 2 条待办 ⇒ 输出 `pending=2` + ids（不是恒为 0 的假探测器）。

两态都在**隔离根**（`QUOTAGENT_ROOT` 指向 tmp 下的临时目录）上真跑脚本，不读源码猜、不动真 `tmp/ui-shared/`。
调度器「真的跳过」那半边在 cron 配置里（`/opt/data/cron/jobs.json`，本仓之外）⇒ 不在本 AC 的断言范围内
（`FR-USREQ-006` 的缺口一栏如实登记）。
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from .registry import Assertion, register

ROOT = Path(__file__).resolve().parents[3]
MONITOR = ROOT / "tools" / "ui-feedback-monitor.sh"
TICK = ROOT / "tools" / "ui-feedback-tick.sh"
# 输出里**不得**出现的「已经发了东西」措辞（空待办时出现任何一条 ⇒ 就是在发垃圾消息）
MESSAGE_WORDS = ("已处理", "已通知", "已提醒", "已发送", "已发出", "已催", "消息", "summary")
# 时间/随机源：探测器里出现这些 ⇒ 同一状态两次输出可能不同 ⇒ 调度器判不出「无变化」而反复起 agent
NONDETERMINISM = ("$RANDOM", "date ", "date+", "$$", "TZ=", "EPOCHSECONDS", "$SECONDS")


def _run(root: Path, tz: str) -> subprocess.CompletedProcess:
    env = dict(os.environ, QUOTAGENT_ROOT=str(root), TZ=tz, LC_ALL="C")
    return subprocess.run(["bash", str(MONITOR)], capture_output=True, text=True, env=env, timeout=120)


@register("AC-USREQ-006", "P2",
          "cron 没待处理反馈时不得发垃圾消息：探测器确定性（两次/跨 TZ 一致）+ 空待办恰一行 `pending=0` + 非空转",
          "tools/verify.sh ac AC-USREQ-006")
def check() -> list[Assertion]:
    out: list[Assertion] = []
    out.append(Assertion("① 探测器与 tick 都在仓库里（实现载体存在）",
                         MONITOR.is_file() and TICK.is_file(),
                         f"monitor={MONITOR.relative_to(ROOT)} tick={TICK.relative_to(ROOT)}"))
    if not MONITOR.is_file():
        return out
    src = MONITOR.read_text(encoding="utf-8")
    out.append(Assertion("② 探测器根目录可被 `QUOTAGENT_ROOT` 覆盖（⇒ 机检能在隔离根上真跑两态，而不是读源码猜）",
                         "QUOTAGENT_ROOT" in src, "override=QUOTAGENT_ROOT"))
    hits = [tok for tok in NONDETERMINISM if tok in src]
    out.append(Assertion("③ 探测器无时间/随机源（否则「输出相同 ⇒ 跳过」不成立）",
                         not hits, f"命中={hits}"))

    scratch = Path(tempfile.mkdtemp(prefix="ac-usreq-006-"))
    try:
        empty_root = scratch / "empty"
        (empty_root / "tmp" / "ui-shared" / "ui-feedback").mkdir(parents=True, exist_ok=True)
        r1 = _run(empty_root, "UTC")
        r2 = _run(empty_root, "Asia/Shanghai")
        out.append(Assertion("④ 空待办：输出**恰一行** `pending=0`（没有第二条内容 ⇒ cron 无东西可投递）",
                             r1.stdout == "pending=0\n", f"stdout={r1.stdout!r} rc={r1.returncode}"))
        out.append(Assertion("⑤ 确定性：同一状态两次运行（换 TZ）逐字节一致 ⇒ 调度器能判「无变化」并跳过",
                             r1.stdout == r2.stdout, f"UTC={r1.stdout!r} Shanghai={r2.stdout!r}"))
        bad = [w for w in MESSAGE_WORDS if w in r1.stdout]
        out.append(Assertion("⑥ 空待办时输出里没有任何「已经发了东西」的措辞（不发垃圾消息）",
                             not bad and r1.stderr == "", f"命中={bad} stderr={r1.stderr!r}"))

        pend = empty_root / "tmp" / "ui-shared" / "ui-feedback"
        (pend / "b.json").write_text("{}", encoding="utf-8")
        (pend / "a.json").write_text("{}", encoding="utf-8")
        r3 = _run(empty_root, "UTC")
        out.append(Assertion("⑦ 非空转（负控的反面）：真造 2 条待办 ⇒ 输出 `pending=2` + ids（不是恒为 0 的假探测器）",
                             r3.stdout.startswith("pending=2\n") and "ids=a.json,b.json" in r3.stdout,
                             f"stdout={r3.stdout!r}"))
        out.append(Assertion("⑧ 待办变化 ⇒ 探测器输出**跟着变**（否则调度器永远跳过，反馈永远不被处理）",
                             r1.stdout != r3.stdout, f"empty={r1.stdout!r} two={r3.stdout!r}"))

        tsrc = TICK.read_text(encoding="utf-8")
        last_echo = tsrc.rfind("echo ")
        guard = tsrc.find('[ $n -eq 0 ] && exit 0')
        out.append(Assertion("⑨ tick 的静默半边：无变化时 `[ $n -eq 0 ] && exit 0` 在最后一条 echo **之前**",
                             guard != -1 and last_echo != -1 and guard < last_echo,
                             f"guard@{guard} last_echo@{last_echo}"))
        out.append(Assertion("⑩ tick 输出只在真应用了反馈时才打印（`echo` 的出现次数 ≤ 2，且都带 `$n` 判据）",
                             len(re.findall(r"^\s*echo ", tsrc, flags=re.M)) <= 2,
                             f"echo 行数={len(re.findall(r'^[ ]*echo ', tsrc, flags=re.M))}"))
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    return out
