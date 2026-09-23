#!/usr/bin/env python3
"""src/system/evidence/tools/evidence-pack-verify.py —— **读一个证据包并逐项验证**（DEF-029 的「验证」那一半）。

与 `audit-verify.py` 的分工：那一个是给人看的文本报告；本工具输出**机器可读的一行 JSON**
（`{ok, checks[], first_failure, pack{...}}`），供界面把"哪一项过了、哪一项没过在第几条"直接渲染成表。

**只读**：不碰账本、不写文件、不联网、不取墙钟。包是不是真的自洽只由 `kernel.evidence.verify` 判。
不知道就不知道：没有密钥时**不把"有签名"当"签名通过"**（`kernel.evidence.verify` 的既有语义）。

用法：
  python3 src/system/evidence/tools/evidence-pack-verify.py <pack.json> [--require-signature]
  python3 src/system/evidence/tools/evidence-pack-verify.py <pack.json> --inclusion 7
退出码：0 = 全部通过；1 = 有检查项失败；2 = 用法/文件错误。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.evidence import inclusion_proof, verify as verify_pack  # noqa: E402


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="evidence-pack-verify", description="证据包逐项验证（哈希链 + Merkle + 签名）")
    parser.add_argument("pack", help="证据包 JSON 文件")
    parser.add_argument("--require-signature", action="store_true", help="无签名或无法验证签名即判失败")
    parser.add_argument("--inclusion", type=int, default=None, help="额外验证某条事件的包含证明")
    args = parser.parse_args(argv)

    path = Path(args.pack)
    if not path.exists():
        return emit({"ok": False, "code": "pack-missing", "reason": f"找不到包文件：{path}",
                     "next_action": "用「导出证据包」先落一份（面板里能看到已导出的包）",
                     "checks": [], "first_failure": ""}, 2)
    try:
        pack = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        return emit({"ok": False, "code": "pack-not-json", "reason": f"包不是合法 JSON：{exc}",
                     "next_action": "重新导出一个包（本工具不改任何文件）", "checks": [], "first_failure": ""}, 2)

    report = verify_pack(pack, require_signature=args.require_signature)
    manifest = pack.get("manifest") or {}
    out = {
        "ok": report["ok"],
        "code": "verified" if report["ok"] else "verify-failed",
        "checks": report["checks"],
        "failed": [check for check in report["checks"] if not check["ok"]],
        "first_failure": report["first_failure"],
        "pack": {"file": str(path), "kind": pack.get("kind"), "scope": pack.get("scope"),
                 "package_id": manifest.get("package_id"), "generated_at": pack.get("generated_at"),
                 "from_seq": manifest.get("from_seq"), "to_seq": manifest.get("to_seq"),
                 "count": manifest.get("count"), "merkle_root": pack.get("merkle_root"),
                 "pack_hash": manifest.get("pack_hash"), "signed_by": pack.get("signed_by"),
                 "signature_algo": pack.get("signature_algo")},
        "next_action": "全部通过：这份包可以交给第三方（他们只需包文件与（可选）密钥）"
            if report["ok"] else f"第一处失败：{report['first_failure']}；逐项看 checks 里 ok=false 的那几条",
        "note": "只读验证：不看导出方状态、不碰账本；未提供密钥时不把「有签名」当「签名通过」",
    }
    if args.inclusion is not None:
        try:
            proof = inclusion_proof(pack, args.inclusion)
            out["inclusion"] = {"seq": args.inclusion, "index": proof["index"],
                                "merkle_root": proof["merkle_root"],
                                "ok": verify_inclusion_ok(proof)}
        except ValueError as exc:
            out["inclusion"] = {"seq": args.inclusion, "ok": False, "reason": str(exc)}
    return emit(out, 0 if report["ok"] else 1)


def verify_inclusion_ok(proof: dict) -> bool:
    from quotagent.kernel.evidence import verify_inclusion  # noqa: E402  只在需要时导入（保持文件顶部最小）
    return verify_inclusion(proof)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
