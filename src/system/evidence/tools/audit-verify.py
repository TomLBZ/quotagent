#!/usr/bin/env python3
"""审计包独立验证入口（T-208 / FR-EVIDENCE-002 / AC-AUDIT-004）。

**不接触原账本**：只读一个包文件 + （可选）验证方自己的密钥，然后给出逐项检查结果。
退出码：0 = 全部通过；1 = 有检查项失败；2 = 用法/文件错误。

用法：
    python3 tools/audit-verify.py pack.json
    python3 tools/audit-verify.py pack.json --require-signature --secret-env AUDIT_SECRET --participant con-B
    python3 tools/audit-verify.py pack.json --inclusion 7        # 附带验证某条事件的包含证明
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# 实体搬迁（迁移阶段 5，本批 `EV-178`）：`tools/` → `src/<层>/<插件>/tools/` ⇒ 仓库根由 4 层上溯
# 推出（`tools/` → 插件 → 层 → `src/` → 仓库根）；旧路径 `tools/audit-verify.py` 只剩**薄转发**。
sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "src"))

from quotagent.kernel.evidence import inclusion_proof, verify, verify_inclusion  # noqa: E402
from quotagent.kernel.qep import KeyStore  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="audit-verify", description="审计包独立验证（哈希链 + Merkle + 签名）")
    parser.add_argument("pack", help="审计包 JSON 文件")
    parser.add_argument("--require-signature", action="store_true", help="无签名或无法验证签名即判失败")
    parser.add_argument("--secret-env", default="", help="从该环境变量读取共享密钥以验证 HMAC 签名")
    parser.add_argument("--participant", default="", help="签名者 id（默认取包内 signed_by）")
    parser.add_argument("--inclusion", type=int, default=None, help="额外验证该 seq 的包含证明")
    parser.add_argument("--quiet", action="store_true", help="只输出结论行")
    args = parser.parse_args(argv)

    path = Path(args.pack)
    if not path.exists():
        print(f"[错误] 找不到包文件: {path}", file=sys.stderr)
        return 2
    try:
        pack = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        print(f"[错误] 包不是合法 JSON: {err}", file=sys.stderr)
        return 2

    keystore = None
    secret = os.environ.get(args.secret_env, "") if args.secret_env else ""
    if secret:
        keystore = KeyStore()
        participant = args.participant or str(pack.get("signed_by") or "exporter")
        keystore.add(participant, secret=secret, kind="exporter", realm=str(pack.get("scope") or "audit"))

    report = verify(pack, keystore=keystore, require_signature=args.require_signature)
    if not args.quiet:
        print(f"包: {path.name} | kind={pack.get('kind')} | scope={pack.get('scope')} | "
              f"事件 {len(pack.get('events') or [])} 条")
        for check in report["checks"]:
            mark = "ok  " if check["ok"] else "FAIL"
            print(f"  [{mark}] {check['name']}"
                  + ("" if check["ok"] else f" — {check['detail']}"))
        if args.inclusion is not None:
            try:
                proof = inclusion_proof(pack, args.inclusion)
                ok = verify_inclusion(proof)
            except ValueError as err:
                print(f"  [FAIL] 包含证明 — {err}")
                ok = False
            print(f"  [{'ok  ' if ok else 'FAIL'}] 包含证明 seq={args.inclusion}")
            report["ok"] = report["ok"] and ok
    print(("RESULT: PASS" if report["ok"] else "RESULT: FAIL")
          + (f" — {report['first_failure']}" if not report["ok"] else ""))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
