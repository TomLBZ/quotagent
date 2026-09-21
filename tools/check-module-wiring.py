"""check-module-wiring —— 机检"模块声明的依赖在**所有消费者**里都同步了"（`tools/verify.sh wiring`）。

为什么需要它：给 `webui` 新增一个依赖，历史上要**手工**同步四处（D-035 / pitfalls-runtime）：
  ① 模块自身 `inject`；② `host/check-modules.mjs` 的 STUBS 表；③ 门 `host/webui.mjs` 的两处挂载；
  ④ `host/canary-dispatch.mjs` 的 e2e 挂载 + `host/cli.mjs` 的运行期挂载。
靠记忆和清单 = 一定会漏（本项目为此付过三次成本）。**把清单变成门**，才是"模块可独立演进"的前提。

它检查什么（只读、不改任何文件）：
  A. 每个 `host/modules/*.mjs` 声明的 `inject` 里，每个服务名都必须能在 `STUBS` 表里找到
     （否则 `verify.sh modules` 会红，但那时只报"缺 stub"，不如这里直接点出"谁缺"）。
  B. `webui` 的 `inject` 里每个服务，必须能在门（host/webui.mjs）与 e2e（host/canary-dispatch.mjs）里
     找到对应的挂载（`wrap(...)` 的第三个参数 或 `provide('<service>'` 或 `name: '<provider>'`）。
  C. `webui` 的 `inject` 里每个服务，必须能在 CLI 的 webui 动作里找到提供者
     （`ctx.provide('<service>'` 或某个插件的 `name` 与提供者映射）。
  D. 反向：`STUBS` 表里不许有**没人 inject** 的孤儿服务（历史残留应当清掉，避免"以为在用"）。

输出 JSON（checks[]）；全部通过退出码 0。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULES = ROOT / "host" / "modules"

# 服务名 → 提供它的插件名（模块文件名去掉 .mjs，即 cordis 插件 name 的常见形式）
PROVIDERS = {
    "kernel-bridge": "kernel-bridge", "norm": "norm", "compare": "compare", "sourcing": "sourcing",
    "timeline": "timeline", "projection": "projection", "audit": "audit-hook", "governor": "governor",
    "canary": "canary", "canary-dispatch": "bridge-canary", "webui": "webui", "observability": "observability",
    "priceHistory": "price-history", "evidenceSummary": "evidence-summary", "breaker": "circuit-breaker",
    "opsView": "ops-view", "evolveJournal": "evolve-journal",
    "supplierScorecard": "supplier-scorecard", "idempotency": "idempotency-guard",
    "approvalDigest": "approval-digest", "budgetGuard": "budget-guard",
}


def inject_of(src: str) -> list[str]:
    m = re.search(r"export const inject\s*=\s*\[([^\]]*)\]", src, re.S)
    return re.findall(r"'([^']+)'", m.group(1)) if m else []


def stub_keys(src: str) -> list[str]:
    block = src.split("const STUBS = {", 1)[1] if "const STUBS = {" in src else ""
    block = block.split("\n}", 1)[0] if block else ""
    return re.findall(r"^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:", block, re.M)


def main() -> int:
    checks: list[dict] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    modules = {p.stem: p.read_text(encoding="utf-8") for p in sorted(MODULES.glob("*.mjs"))}
    all_injected: set[str] = set()
    for name, src in modules.items():
        all_injected.update(inject_of(src))

    stubs_src = (ROOT / "host" / "check-modules.mjs").read_text(encoding="utf-8")
    stubs = set(stub_keys(stubs_src))
    gate_src = (ROOT / "host" / "webui.mjs").read_text(encoding="utf-8")
    e2e_src = (ROOT / "host" / "canary-dispatch.mjs").read_text(encoding="utf-8")
    cli_src = (ROOT / "host" / "cli.mjs").read_text(encoding="utf-8")

    # A. fixture 必须能给每个被声明的依赖 stub
    missing_stubs = sorted(s for s in all_injected if s not in stubs and s != "events")
    check("A. 每个被任何模块 inject 的服务，STUBS 表里都有 stub（fixture 才跑得起来）",
          not missing_stubs, f"缺 stub：{missing_stubs or '无'}")

    # B. webui 的依赖在门与 e2e 里都有挂载
    webui_inject = inject_of(modules.get("webui", ""))
    def mounted(src: str) -> set[str]:
        found = set(re.findall(r"provide\('([A-Za-z_][A-Za-z0-9_]*)'", src))
        found |= set(re.findall(r"wrap\(\{[^}]*\},\s*[^,]+,\s*'([^']+)'", src))
        found |= set(re.findall(r"name:\s*'([A-Za-z_][A-Za-z0-9_-]*)#", src))
        return found
    gate_mounted, e2e_mounted = mounted(gate_src), mounted(e2e_src)
    def reachable(service: str, mounted_set: set[str], src: str) -> bool:
        provider = PROVIDERS.get(service)
        return service in mounted_set or (provider is not None and provider in src)
    missing_gate = sorted(s for s in webui_inject if not reachable(s, gate_mounted, gate_src))
    missing_e2e = sorted(s for s in webui_inject if not reachable(s, e2e_mounted, e2e_src))
    check("B1. `webui` 的每个依赖在**门**（host/webui.mjs）里都有挂载",
          not missing_gate, f"门里缺：{missing_gate or '无'}（webui.inject={webui_inject}）")
    check("B2. `webui` 的每个依赖在 **e2e**（host/canary-dispatch.mjs）里都有挂载",
          not missing_e2e, f"e2e 里缺：{missing_e2e or '无'}")

    # C. CLI 运行期挂载：每个依赖都有提供者
    cli_missing = []
    for s in webui_inject:
        provider = PROVIDERS.get(s)
        if s in cli_src or (provider and f"name: '{provider}'" in cli_src) or (provider and f"/{provider}.mjs" in cli_src):
            continue
        cli_missing.append(s)
    check("C. `webui` 的每个依赖在 CLI 的 webui 动作里都有提供者（否则线上起不来）",
          not cli_missing, f"CLI 里缺：{cli_missing or '无'}")

    # D. 反向：STUBS 里不许有孤儿
    known = all_injected | {"events"}
    orphans = sorted(s for s in stubs if s not in known)
    check("D. STUBS 表里没有**没人 inject** 的孤儿服务（历史残留应当清掉，避免'以为在用'）",
          not orphans, f"孤儿 stub：{orphans or '无'}")

    failed = [c for c in checks if not c["ok"]]
    print(json.dumps({"checks": checks, "passed": len(checks) - len(failed), "total": len(checks),
                      "failures": len(failed),
                      "services_injected": sorted(all_injected)}, ensure_ascii=False, indent=2))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
