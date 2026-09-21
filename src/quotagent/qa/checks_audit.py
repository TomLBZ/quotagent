"""账本 AC（T-102）：AC-AUDIT-001（篡改可检出）、AC-AUDIT-002（模型输入可重建）。"""

from __future__ import annotations

import json
import os
import subprocess
import random
import shutil
from pathlib import Path

from ..kernel import evidence
from ..kernel.evidence import export as export_evidence
from ..kernel.evidence import inclusion_proof, verify_inclusion
from ..kernel.evidence import verify as verify_evidence
from ..kernel.ledger import Ledger, LedgerFrozenError
from ..kernel.modelgate import DeterministicModelProvider, ModelGateway
from ..kernel.qep import KeyStore
from ..paths import new_scratch
from .registry import Assertion, register

REPO_ROOT = Path(__file__).resolve().parents[3]

SAMPLE_SIZE = 20
TOTAL_CALLS = 30
SNAPSHOT_AT = 12
DEFAULT_SEED = 20260912


def _seed_ledger(path, realm: str, n: int = 12) -> Ledger:
    ledger = Ledger(path, realm=realm)
    for i in range(1, n + 1):
        ledger.append(
            "rfq/published" if i == 1 else "quote/submitted",
            {"package_id": "pkg-014", "rfq_rev": 1, "line": i, "amount": 1000 + i},
            correlation_id=f"corr-{i:02d}",
            actor="agent:sourcing",
        )
    return ledger


@register("AC-AUDIT-001", "P0", "篡改历史事件后 verify_chain() 为假；审计包独立验证失败",
          "qa ac AC-AUDIT-001", evidence_refs=("EV-005",))
def ac_audit_001() -> list[Assertion]:
    out: list[Assertion] = []
    tmp = new_scratch("audit-001")
    path = tmp / "ledger.jsonl"
    ledger = _seed_ledger(path, "contractor:con-B")

    out.append(Assertion("append-only：事件已追加", ledger.count == 12, f"count={ledger.count}"))
    out.append(Assertion("追加后哈希链完整（FR-LEDGER-001/003）", ledger.verify_chain(),
                         f"head={ledger.head_hash}"))

    dup = ledger.append("quote/submitted", {"package_id": "pkg-014", "rfq_rev": 1, "line": 5, "amount": 1005},
                        correlation_id="corr-05", actor="agent:sourcing")
    out.append(Assertion("同 (correlation_id,type,body_hash) 不产生第二条事实（FR-LEDGER-004）",
                         dup.duplicate is True and ledger.count == 12,
                         f"duplicate={dup.duplicate} count={ledger.count}"))

    reopened = Ledger(path, realm="contractor:con-B")
    out.append(Assertion("重开后账本健康且 head_hash 一致（持久化 + 启动校验）",
                         reopened.healthy and reopened.verify_chain() and reopened.head_hash == ledger.head_hash,
                         f"head={reopened.head_hash}"))

    pack = evidence.export(ledger, scope="pkg-014")
    ok_pack = evidence.verify(pack)
    out.append(Assertion("审计包独立验证通过（未篡改）", ok_pack["ok"],
                         json.dumps(ok_pack["checks"][:2], ensure_ascii=False)))

    tampered_pack = json.loads(json.dumps(pack))
    tampered_pack["events"][3]["body"]["amount"] = 1
    bad_pack = evidence.verify(tampered_pack)
    out.append(Assertion("包内任一事件被篡改 → 独立验证失败", bad_pack["ok"] is False,
                         bad_pack["first_failure"]))

    lines = path.read_text(encoding="utf-8").splitlines()
    record = json.loads(lines[6])
    record["body"]["amount"] = 1
    lines[6] = json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    tampered = Ledger(path, realm="contractor:con-B")
    report = tampered.verify_report()
    out.append(Assertion("篡改历史事件后 verify_chain() 返回假", tampered.verify_chain() is False,
                         f"ok={report['ok']} reason={report['reason']}"))
    out.append(Assertion("校验报告定位到被篡改的 seq（第 7 条）", report["first_bad_seq"] == 7,
                         f"first_bad_seq={report['first_bad_seq']} reason={report['reason']}"))
    out.append(Assertion("启动校验失败即标记不健康（停发前置条件）", tampered.healthy is False,
                         f"frozen={tampered.frozen}"))

    refused = False
    try:
        tampered.append("kernel/test", {"x": 1}, correlation_id="corr-frozen")
    except LedgerFrozenError as exc:
        refused = "拒绝追加" in str(exc)
    out.append(Assertion("冻结后拒绝继续追加（FR-LEDGER-003 停发）", refused))
    shutil.rmtree(tmp, ignore_errors=True)
    return out


@register("AC-AUDIT-002", "P0", "随机抽样 20 次模型调用的重建输入与观测输入全等",
          "qa ac AC-AUDIT-002", evidence_refs=("EV-006",))
def ac_audit_002() -> list[Assertion]:
    out: list[Assertion] = []
    tmp = new_scratch("audit-002")
    ledger = Ledger(tmp / "ledger.jsonl", realm="supplier:sup-A")
    gateway = ModelGateway(ledger, DeterministicModelProvider())

    replies = []
    snapshots: dict[str, dict] = {}
    snapshot_seq = 0
    for i in range(TOTAL_CALLS):
        replies.append(gateway.call(
            step=f"intake-{i:03d}",
            messages=[{"role": "system", "content": "你是供应商读包 agent"},
                      {"role": "user", "content": f"抽取第 {i} 条清单条目的规格引用"}],
            params={"temperature": 0},
            agent_id="agent:intake",
            correlation_id=f"corr-{i:03d}",
        ))
        if i + 1 == SNAPSHOT_AT:
            for view in ("index", "types"):
                snapshots[view] = ledger.incremental(view)
            snapshot_seq = ledger.count

    call_seqs = gateway.model_call_seqs()
    out.append(Assertion("每次模型调用都已落账（模型可见 ⟺ 账本可见）",
                         len(call_seqs) == TOTAL_CALLS, f"kernel/model-call={len(call_seqs)}"))
    out.append(Assertion(f"时点快照已采集（seq={snapshot_seq}）",
                         snapshot_seq > 0 and {"index", "types"} <= set(snapshots),
                         f"snapshot_seq={snapshot_seq} views={sorted(snapshots)}"))

    rnd = random.Random(DEFAULT_SEED)
    sample = rnd.sample(replies, SAMPLE_SIZE)
    diffs = [gateway.rebuild_matches(reply.call_id) for reply in sample]
    bad = [d for d in diffs if not d["equal"]]
    out.append(Assertion(f"抽样 {SAMPLE_SIZE} 次：rebuild(inputs) == observed_inputs 全部相等",
                         len(sample) == SAMPLE_SIZE and not bad,
                         f"不一致 {len(bad)} 条: {json.dumps(bad[:2], ensure_ascii=False)}"))

    negative_gateway = ModelGateway(Ledger(tmp / "ledger-negative.jsonl", realm="supplier:sup-A"),
                                    DeterministicModelProvider(), inject_unlogged=True)
    negative_reply = negative_gateway.call(step="inject-001", messages=[{"role": "user", "content": "正常内容"}],
                                           agent_id="agent:intake", correlation_id="corr-inject")
    negative = negative_gateway.rebuild_matches(negative_reply.call_id)
    out.append(Assertion("负控：未落账却进入模型的输入被检出（比对非空转）",
                         negative["equal"] is False, json.dumps(negative, ensure_ascii=False)))

    for view in ("index", "types"):
        full = ledger.project(view)
        incremental = ledger.incremental(view)
        out.append(Assertion(f"投影 {view}: 全量重建 == 增量维护（FR-LEDGER-002）",
                             full == incremental, f"full={full} incremental={incremental}"))
        point = ledger.project(view, from_seq=1, to_seq=snapshot_seq)
        out.append(Assertion(f"投影 {view}: 时点重建（seq<={snapshot_seq}）== 该时点快照",
                             point == snapshots[view], f"point={point} snapshot={snapshots[view]}"))

    out.append(Assertion("投影全量重建可重复（同输入两次结果一致）",
                         ledger.project("index") == ledger.project("index")))
    shutil.rmtree(tmp, ignore_errors=True)
    return out


@register("AC-AUDIT-004", "P1", "审计包带签名与包含证明；可用独立入口（不接触原账本）验证，篡改/错误密钥/缺签名均失败",
          "qa ac AC-AUDIT-004", evidence_refs=("EV-048",))
def check_audit_004() -> list[Assertion]:
    out: list[Assertion] = []
    root = new_scratch("audit-004")
    ledger = Ledger(root / "con.jsonl", realm="contractor:con-B")
    for index in range(1, 9):
        ledger.append("quote/submitted", {"quote_id": f"q-{index:04d}", "amount": 1000.0 + index},
                      correlation_id=f"corr-{index}")
    store = KeyStore()
    store.add("con-B", secret="audit-secret-1", kind="contractor", realm="contractor:con-B")
    pack = export_evidence(ledger, scope="audit:q-0007", keystore=store, participant="con-B")

    out.append(Assertion("导出包带签名与签名者（HMAC-SHA256 占位，ADR-0008）",
                         bool(pack.get("signature")) and pack.get("signed_by") == "con-B"
                         and pack.get("signature_algo") == "hmac-sha256"
                         and pack["manifest"].get("manifest_hash"),
                         f"algo={pack.get('signature_algo')} signed_by={pack.get('signed_by')}"))
    signed_ok = verify_evidence(pack, keystore=store, require_signature=True)
    out.append(Assertion("正确密钥：签名验证通过（整包含清单与根都在签名覆盖内）",
                         signed_ok["ok"] is True
                         and any(check["name"].startswith("包签名（导出方身份）") and check["ok"]
                                 for check in signed_ok["checks"]),
                         f"first_failure={signed_ok['first_failure']}"))
    wrong = KeyStore()
    wrong.add("con-B", secret="WRONG-SECRET", kind="contractor", realm="contractor:con-B")
    wrong_report = verify_evidence(pack, keystore=wrong, require_signature=True)
    out.append(Assertion("错误密钥：签名验证失败（不得只看「存在签名」就通过）",
                         wrong_report["ok"] is False
                         and "签名" in wrong_report["first_failure"],
                         f"first_failure={wrong_report['first_failure']}"))
    out.append(Assertion("验证方未提供密钥：默认只记录存在性；`require_signature` 下判失败（不静默通过）",
                         verify_evidence(pack)["ok"] is True
                         and verify_evidence(pack, require_signature=True)["ok"] is False,
                         f"no_key_ok={verify_evidence(pack)['ok']} "
                         f"required_ok={verify_evidence(pack, require_signature=True)['ok']}"))

    # 清单被 manifest_hash 绑定：改 head_hash（不是计数）也应失败
    manifest_tamper = json.loads(json.dumps(pack))
    manifest_tamper["manifest"]["head_hash"] = "sha256:" + "b" * 64
    manifest_report = verify_evidence(manifest_tamper, keystore=store, require_signature=True)
    out.append(Assertion("篡改清单字段（head_hash）→ 失败（manifest_hash 绑定，不只是计数检查）",
                         manifest_report["ok"] is False
                         and "清单自身被 manifest_hash 绑定" in manifest_report["first_failure"],
                         f"first_failure={manifest_report['first_failure']}"))

    # 包含证明：只凭叶子 + 证明 + 根
    proofs = {seq: inclusion_proof(pack, seq) for seq in (1, 4, 8)}
    out.append(Assertion("包含证明可验证（对首/中/末三条事件，只凭叶子+证明+根）",
                         all(verify_inclusion(proof) for proof in proofs.values())
                         and all(proof["proof"] for proof in proofs.values()),
                         f"proof_lengths={ {seq: len(proof['proof']) for seq, proof in proofs.items()} }"))
    broken = json.loads(json.dumps(proofs[4]))
    broken["leaf"] = "sha256:" + "c" * 64
    out.append(Assertion("篡改叶子后包含证明失败（证明绑定到具体事件）",
                         verify_inclusion(broken) is False, "broken leaf 被接受"))
    wrong_root = json.loads(json.dumps(proofs[4]))
    wrong_root["merkle_root"] = "sha256:" + "d" * 64
    out.append(Assertion("换一个根则包含证明失败（根与证明成对）",
                         verify_inclusion(wrong_root) is False, "wrong root 被接受"))

    # 独立入口：不接触原账本
    pack_path = root / "audit-pack.json"
    pack_path.write_text(json.dumps(pack, ensure_ascii=False), encoding="utf-8")
    env = dict(os.environ, AUDIT_SECRET="audit-secret-1")
    args = [str(REPO_ROOT / "tools" / "audit-verify.py"), str(pack_path),
            "--require-signature", "--secret-env", "AUDIT_SECRET", "--participant", "con-B",
            "--inclusion", "4"]
    good = subprocess.run(args, capture_output=True, text=True, env=env)
    out.append(Assertion("独立入口：未篡改包 → 退出码 0（只给包文件 + 验证方密钥，不接触原账本）",
                         good.returncode == 0 and "RESULT: PASS" in good.stdout,
                         f"exit={good.returncode} out={good.stdout.strip().splitlines()[-1][:120] if good.stdout else ''}"))
    tampered = json.loads(json.dumps(pack))
    tampered["events"][3]["body"]["amount"] = 1.0
    tampered_path = root / "audit-pack-tampered.json"
    tampered_path.write_text(json.dumps(tampered, ensure_ascii=False), encoding="utf-8")
    bad = subprocess.run([arg if arg != str(pack_path) else str(tampered_path) for arg in args],
                         capture_output=True, text=True, env=env)
    out.append(Assertion("独立入口：篡改包 → 退出码 1 且报告定位到失败检查项",
                         bad.returncode == 1 and "RESULT: FAIL" in bad.stdout
                         and ("哈希链" in bad.stdout or "签名" in bad.stdout),
                         f"exit={bad.returncode} out={bad.stdout.strip().splitlines()[-1][:140] if bad.stdout else ''}"))
    unsigned = json.loads(json.dumps(pack))
    for field in ("signature", "signed_by", "signature_algo"):
        unsigned.pop(field, None)
    unsigned_path = root / "audit-pack-unsigned.json"
    unsigned_path.write_text(json.dumps(unsigned, ensure_ascii=False), encoding="utf-8")
    missing = subprocess.run([str(REPO_ROOT / "tools" / "audit-verify.py"), str(unsigned_path),
                              "--require-signature"], capture_output=True, text=True)
    out.append(Assertion("独立入口：无签名包在 `--require-signature` 下失败并说明原因",
                         missing.returncode == 1 and "签名" in missing.stdout,
                         f"exit={missing.returncode} out={missing.stdout.strip().splitlines()[-1][:140] if missing.stdout else ''}"))
    out.append(Assertion("独立入口对不存在的文件给用法级错误（退出码 2，不冒充验证结论）",
                         subprocess.run([str(REPO_ROOT / "tools" / "audit-verify.py"),
                                         str(root / "nope.json")], capture_output=True, text=True).returncode == 2,
                         "missing-file exit != 2"))
    colon_signature = None
    for who in ("contractor:con-B", "plain"):
        ks = KeyStore()
        ks.add(who, secret="shared-secret", kind="participant", realm=who)
        sig = ks.sign(who, b"payload")
        if not ks.verify(who, b"payload", sig):
            colon_signature = who
    out.append(Assertion("参与者 id 含冒号（本项目命名惯例 `human:`/`supplier:`/`contractor:`）时签名仍可验证",
                         colon_signature is None,
                         f"验签失败的 id={colon_signature}"))
    return out
