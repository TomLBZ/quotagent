"""运行时与 CLI 骨架 AC（T-101）：自包含（仅标准库、干净副本可跑）与运行器契约。"""

from __future__ import annotations

import ast
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from ..paths import new_scratch, repo_root
from .registry import Assertion, ACCheck, run_check, register

IGNORE_DIRS = {".git", ".venv", "tmp", "__pycache__", "node_modules", ".mypy_cache", ".pytest_cache"}
IGNORE_FILES = {"USER-GOALS.md", ".env", "config.local.yaml"}
IGNORE_SUFFIX = (".pyc", ".pyo", ".log")
RUNTIME_ARTIFACTS = {".venv", "tmp", "__pycache__"}
P0_ACS = ("AC-DESIGN-001", "AC-DESIGN-002", "AC-DESIGN-003",
          "AC-AUDIT-001", "AC-AUDIT-002", "AC-RUNTIME-001", "AC-RUNTIME-002")


def _run(cmd: list, *, cwd: Path, env: dict | None = None, timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run([str(c) for c in cmd], cwd=str(cwd), env=env, capture_output=True,
                          text=True, timeout=timeout)


def _tail(text: str, lines: int = 3) -> str:
    return " / ".join((text or "").strip().splitlines()[-lines:])


def _extra_files(root: Path, baseline: set[str]) -> list[str]:
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        for name in filenames:
            rel = str((Path(dirpath) / name).relative_to(root))
            if rel in baseline:
                continue
            if RUNTIME_ARTIFACTS & set(Path(rel).parts):
                continue
            found.append(rel)
    return sorted(found)


def _rel_files(root: Path) -> set[str]:
    return {str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()}


def _clean_copy(dest: Path) -> int:
    """把工作树复制成干净副本：排除 .git/.venv/tmp 与本机未入库文件。"""
    root = repo_root()
    copied = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS]
        for name in filenames:
            if name in IGNORE_FILES or name.endswith(IGNORE_SUFFIX):
                continue
            src = Path(dirpath) / name
            target = dest / src.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)
            copied += 1
    return copied


def _third_party_imports() -> list[str]:
    stdlib = set(sys.builtin_module_names) | set(getattr(sys, "stdlib_module_names", ()))
    local = {"quotagent"}
    found: list[str] = []
    for path in sorted((repo_root() / "src").rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names, level = [alias.name for alias in node.names], 0
            elif isinstance(node, ast.ImportFrom):
                names, level = [node.module or ""], node.level
            else:
                continue
            if level:  # 包内相对导入
                continue
            for name in names:
                top = name.split(".")[0]
                if not top or top in local or top in stdlib:
                    continue
                found.append(f"{path.relative_to(repo_root())}: {name}")
    return found


@register("AC-RUNTIME-001", "P0", "仓库内自包含运行时：仅标准库，干净副本可用裸解释器运行",
          "tools/verify.sh smoke", evidence_refs=("EV-007",))
def ac_runtime_001() -> list[Assertion]:
    out: list[Assertion] = []
    root = repo_root()
    runtime_sh = root / "tools" / "runtime.sh"

    proc = _run([runtime_sh, "--print"], cwd=root)
    interpreter = (proc.stdout or "").strip().splitlines()[-1] if proc.stdout.strip() else ""
    probe = _run([interpreter, "-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], cwd=root) if interpreter else None
    resolve_ok = (proc.returncode == 0 and bool(interpreter) and probe is not None
                  and probe.returncode == 0 and probe.stdout.strip().split(".")[0] == "3")
    out.append(Assertion("tools/runtime.sh 解析出可执行的 Python 3", resolve_ok,
                         f"exit={proc.returncode} interpreter={interpreter or _tail(proc.stderr)}"))

    third_party = _third_party_imports()
    out.append(Assertion("src/ 只导入标准库（无第三方运行时依赖）", not third_party,
                         "; ".join(third_party[:5])))

    minimal_env = {"PATH": f"{Path(interpreter).parent}:/usr/local/bin:/usr/bin:/bin" if interpreter
                   else "/usr/local/bin:/usr/bin:/bin",
                   "QUOTAGENT_PY": interpreter, "PYTHONPATH": ""}
    proc = _run([interpreter or "python3", root / "tools" / "check-docs.py"], cwd=root, env=minimal_env)
    out.append(Assertion("最小环境（仅 PATH/QUOTAGENT_PY）下文档门可运行", proc.returncode == 0,
                         f"exit={proc.returncode} {_tail(proc.stdout or proc.stderr)}"))

    scratch = new_scratch("runtime-001")
    copy = scratch / "clean"
    copy.mkdir(parents=True)
    copied = _clean_copy(copy)
    baseline = _rel_files(copy)
    out.append(Assertion("干净副本不含 .venv/ tmp/ 等宿主产物",
                         not (copy / ".venv").exists() and not (copy / "tmp").exists(),
                         f"copied={copied} files"))

    proc = _run([copy / "tools" / "verify.sh", "docs"], cwd=copy, env=minimal_env)
    out.append(Assertion("干净副本：tools/verify.sh docs 全绿", proc.returncode == 0 and "RESULT: PASS" in proc.stdout,
                         f"exit={proc.returncode} {_tail(proc.stdout or proc.stderr)}"))

    proc = _run([copy / "tools" / "run.sh", "-m", "quotagent.qa", "list"], cwd=copy, env=minimal_env)
    listed = 0
    try:
        listed = len(json.loads(proc.stdout or "{}").get("acs", []))
    except Exception:
        listed = 0
    out.append(Assertion("干净副本：tools/run.sh 可驱动 CLI（未设置 PYTHONPATH）",
                         proc.returncode == 0 and listed >= len(P0_ACS),
                         f"exit={proc.returncode} acs={listed} {_tail(proc.stderr)}"))

    first = _run([copy / "tools" / "bootstrap.sh"], cwd=copy, env=minimal_env)
    second = _run([copy / "tools" / "bootstrap.sh"], cwd=copy, env=minimal_env)
    manifest = copy / ".venv" / "quotagent-runtime.json"
    bootstrap_ok = (first.returncode == 0 and second.returncode == 0
                    and "runtime ready" in first.stdout and "created" in first.stdout
                    and "reused" in second.stdout and manifest.exists())
    out.append(Assertion("tools/bootstrap.sh 幂等：首次 created、再次 reused，清单落在仓库内",
                         bootstrap_ok,
                         f"first={first.returncode}/{_tail(first.stdout)} second={second.returncode}/{_tail(second.stdout)}"))

    extra = _extra_files(copy, baseline)
    out.append(Assertion("运行产物只落在 .venv/ tmp/ __pycache__/（不污染仓库）", not extra,
                         "; ".join(extra[:5])))
    return out


@register("AC-RUNTIME-002", "P0", "CLI 骨架契约：JSON 报告、退出码、未知入口非零",
          "qa ac AC-RUNTIME-002", evidence_refs=("EV-008",))
def ac_runtime_002() -> list[Assertion]:
    out: list[Assertion] = []
    root = repo_root()
    run = [root / "tools" / "run.sh", "-m", "quotagent.qa"]

    proc = _run(run + ["ac", "AC-DESIGN-002"], cwd=root)
    payload: dict = {}
    try:
        payload = json.loads(proc.stdout or "{}")
    except Exception:
        payload = {}
    keys = {"ac", "status", "assertions", "evidence_refs"}
    out.append(Assertion("qa ac 输出 JSON 且含契约键 ac/status/assertions/evidence_refs",
                         keys <= set(payload) and payload.get("status") == "pass" and proc.returncode == 0,
                         f"exit={proc.returncode} keys={sorted(payload)[:9]}"))
    asserts = payload.get("assertions") or []
    out.append(Assertion("断言逐条带 name/ok/detail",
                         bool(asserts) and all({"name", "ok", "detail"} <= set(a) for a in asserts),
                         f"assertions={len(asserts)}"))

    proc = _run(run + ["ac", "AC-NOT-A-REAL-AC"], cwd=root)
    out.append(Assertion("未注册 AC：退出码 2 且给出可读原因",
                         proc.returncode == 2 and ("未注册" in (proc.stdout + proc.stderr)
                                                   or "未知" in (proc.stdout + proc.stderr)),
                         f"exit={proc.returncode} {_tail(proc.stdout + proc.stderr)}"))

    proc = _run(run + ["list"], cwd=root)
    listed: set[str] = set()
    try:
        listed = {item["ac"] for item in json.loads(proc.stdout or "{}").get("acs", [])}
    except Exception:
        listed = set()
    out.append(Assertion("qa list 覆盖本批全部 AC", set(P0_ACS) <= listed,
                         f"missing={sorted(set(P0_ACS) - listed)}"))

    proc = _run(run + ["--version"], cwd=root)
    out.append(Assertion("qa --version 退出码 0", proc.returncode == 0, f"exit={proc.returncode}"))

    proc = _run(run + ["suite", "s1"], cwd=root)
    out.append(Assertion("未实现的场景集返回 2 且指明 roadmap 任务（T-114）",
                         proc.returncode == 2 and "T-114" in (proc.stdout + proc.stderr),
                         f"exit={proc.returncode} {_tail(proc.stdout + proc.stderr)}"))

    pass_proc = _run([root / "tools" / "verify.sh", "ac", "AC-DESIGN-002"], cwd=root)
    unknown_proc = _run([root / "tools" / "verify.sh", "ac", "AC-NOT-A-REAL-AC"], cwd=root)
    gate_proc = _run([root / "tools" / "verify.sh", "g0"], cwd=root)
    out.append(Assertion("tools/verify.sh ac <ID> 透传退出码（通过 0 / 未知 2）",
                         pass_proc.returncode == 0 and unknown_proc.returncode == 2,
                         f"pass={pass_proc.returncode} unknown={unknown_proc.returncode}"))
    out.append(Assertion("阶段门未到达返回 2（不伪装成失败）", gate_proc.returncode == 2,
                         f"exit={gate_proc.returncode}"))

    def _always_fails() -> list[Assertion]:
        return [Assertion("必失败（负控）", False, "差异：期望 1 得到 2")]

    failing = ACCheck(ac="AC-RUNTIME-002#negative", phase="P0", title="运行器负控",
                      command="inline", fn=_always_fails)
    report = run_check(failing)
    out.append(Assertion("失败 AC 映射退出码 1 且给出首个失败断言的差异",
                         report.exit_code() == 1 and "差异" in report.first_failure(),
                         f"exit={report.exit_code()} first={report.first_failure()}"))
    return out
