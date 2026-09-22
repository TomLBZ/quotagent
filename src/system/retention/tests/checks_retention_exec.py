"""AC-AUDIT-005：留存与销毁**执行侧**（T-253 / FR-EVIDENCE-004 / NFR-COMP-003）。

范围划分（两半合起来才覆盖 FR-EVIDENCE-004 的完整语义）：

- **AC-AUDIT-003**（`qa/checks_retention.py`）管**计划侧**：只读判定器 `services/retention.py`
  算「该不该销毁」——账本行永不销毁、未知类型不判销毁、确定性、零副作用、销毁须人工门。
  它**不执行**任何动作，也不落任何账本事件。
- **AC-AUDIT-005**（本文件）管**执行侧**：`services/retention_exec.py` 真正删除派生副本、
  写归档包、落 `evidence/retention-*` 留痕、并从账本重建读侧封存。
  「销毁**生效后**目标不可再读」这句 AC-AUDIT-003 无法自证的话，在这里由
  `is_sealed()` / `assert_readable()` 真的验一遍。

本机检覆盖（正控 + 负控 + 静态扫描 + 动态零副作用 + 变异自证）：

  1. **正控（真删）**：临时根里的副本文件在 `plan→execute` 后**真的不存在了**，且 `counts.purged == 1`；
  2. **账本真落痕且不复活内容**：`evidence/retention-copy-purged` 恰好 1 条，body **只有**
     `{target, sha256, bytes}`——哨兵文本不出现在账本文件、报告与事件里，但哈希可复核；
  3. **负控（越界拒绝）**：`../` 逃逸、根外绝对路径、指向根外的软链 → 一律 `refused` +
     `reason=path-outside-root`，且根外的文件仍在；同批次里一条**正常**目标必须真的被删
     （证明「全拒」不算通过）；
  4. **负控（账本行）**：计划里混入一条账本行（带 seq）要求 purge → 不得删、计入 `refused` +
     `reason=ledger-row`（执行侧第二次拦截，不因上游判过就少查一遍）；
  5. **负控（缺人工门）**：不可重建物（`approval_required=True`）没有有效批准 → `refused` +
     `reason=approval-missing`、文件仍在、账本零新增；批准（人签字 + scope 适用 + ref 绑定）之后 → 真删 + 落痕；
  6. **幂等**：同一计划跑第二次 → 全部 `skipped/already-absent`，账本**不再新增**事件；
  7. **封存语义**：销毁过的目标 `is_sealed()` 为真、`assert_readable()` 抛 `TargetSealed`，
     文件被后来重建也不复活；没销毁过的目标 `is_sealed()` 为假、`assert_readable()` 静默通过；
  8. **零副作用（dry_run）**：一个文件也不动、账本零新增、不建归档目录，但报告里能看到「本来会删什么」；
  9. **静态零残留**：执行器里没有 `shutil` / `subprocess` / `glob` / `rmtree` / `os.system` /
     `walk` / `rglob` / `scandir`；删除是**单文件显式** `Path.unlink()`（先过 `is_file()` 守卫）；
 10. **不递归删目录（动态）**：目标是目录 → `refused`（`not-a-regular-file`），目录与子文件都在；
 11. **归档不删源**：归档写 `root/archive/<name>.tar` 并落 `evidence/retention-archived`，源文件保留；重跑计 `already-archived`；
 12. **确定性**：dry-run 两次 `render()` **逐字节一致**；真删重跑的报告除**账本侧事实**
     （`events_written` / `ledger_duplicate`）外逐字节一致，且去重不让账本多出一行；
 13. **边界**：`root` 不传 / `root=None` / 空串 / 仓库根 / 仓库 `src/` / 无账本 → 构造即失败
     （没有「默认当前目录」这种退路）；空计划不崩且计数全 0；缺 `items` 的计划报错而不是静默当空跑。

【会变红的反例说明（刻意写在注释里，不假装通过）】
  变异自证（实跑，见 `tmp/t253-mutate.py`）——每一处单点变异都让本文件变红，原始输出记在交付报告里：
    · 关掉根前缀校验（`if self.root not in resolved.parents:` → `if False:`）→ 越界断言红（根外文件真被删了）；
    · 删掉人工门检查（`if raw.get("approval_required"):` → `if False:`）→ 缺门/批准断言红；
    · 关掉幂等短路（`if not resolved.exists():` → `if False:`）→ 幂等断言红；
    · 关掉账本行拦截（`_is_ledger_row` 恒 False）→ 账本行断言红。
  基线（未变异的同一份副本）必须绿：否则「变红」不说明任何事。脚本同时跑基线与四路变异，基线不绿即报错退出。
"""

from __future__ import annotations

import ast
import hashlib
import shutil
from pathlib import Path

from quotagent.kernel.canon import canonical_json
from quotagent.kernel.ledger import Ledger
from quotagent.paths import new_scratch, repo_root
from quotagent.services import retention_exec as retention_exec_module       # 静态扫描要扫「正在执行的这份代码」
from quotagent.services.approval import ApprovalService
from quotagent.services.retention import RetentionPolicy
from quotagent.services.retention_exec import (ARCHIVE_EVENT, PURGE_EVENT, R_APPROVAL_MISSING, R_LEDGER_ROW,
                                       R_NOT_REGULAR, R_PATH_OUTSIDE, R_SYMLINK, S_ALREADY_ABSENT,
                                       S_ALREADY_ARCHIVED, ApprovalMissing,
                                       RetentionExecutionError, RetentionExecutor, TargetSealed)
from quotagent.qa.registry import Assertion, register

NOW = "2026-09-21T00:00:00Z"
OLD = "2020-01-01T00:00:00Z"                      # 手算 age_days = 2455（同 AC-AUDIT-003）
SENTINEL = "SENTINEL-RETENTION-EXEC-T253-7f3c"    # 可识别的哨兵：销毁后不得在账本/报告里复活
PAYLOAD = f"派生产物正文 {SENTINEL} 供应商底价 123456\n"

# 结果里必须有的键（接口契约，少一个就是调用方拿不到事实）
RESULT_KEYS = {"purged", "archived", "skipped", "refused", "events_written", "counts", "dry_run", "note"}
EMPTY_COUNTS_ZERO = ("considered", "keep", "purge-copy", "archive", "purged", "archived",
                     "would_purge", "would_archive", "skipped", "refused", "events_written", "untraced")


def _ledger(root: Path, name: str) -> Ledger:
    return Ledger(root / f"{name}.jsonl", realm="contractor:con-B")


def _mkfile(root: Path, name: str, text: str) -> Path:
    path = root / name
    path.write_text(text, encoding="utf-8")
    return path


def _sha256(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _purge(name: str, object_key: str, **extra) -> dict:
    """按判定器 `plan()` 逐项清单的形状造一条 purge 项（执行侧只多认一个目标路径键）。"""
    return {"object": object_key, "id": object_key.split(":", 1)[-1], "kind": "derived-copy",
            "type": "evidence/pack-exported", "action": "purge-copy", "path": name, **extra}


def _attempt(fn) -> object:
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 —— 负控就是要看它抛什么
        return exc


def _reasons(rows) -> list:
    return [row.get("reason") for row in rows]


def _strip_ledger_facts(report: dict) -> str:
    """把报告里**账本侧**的事实去掉（去重标志与事件计数），剩下的必须逐字节确定。"""
    trimmed = {key: value for key, value in report.items() if key not in ("events", "events_written", "untraced")}
    trimmed["counts"] = {key: value for key, value in trimmed["counts"].items() if key != "events_written"}
    trimmed["purged"] = [{key: value for key, value in row.items() if key != "ledger_duplicate"}
                         for row in trimmed["purged"]]
    return canonical_json(trimmed)


@register("AC-AUDIT-005", "P2",
          "留存与销毁（执行侧）：销毁真的发生、账本落痕不可复活内容、读侧封存、越界与缺批准一律拒绝、幂等",
          "qa ac AC-AUDIT-005", evidence_refs=("EV-088",))
def check_audit_005() -> list[Assertion]:
    out: list[Assertion] = []
    scratch = new_scratch("audit-005")

    # ============ 1~2. 正控（真删）+ 账本真落痕（不复活内容） ============
    pos_root = scratch / "pos"
    pos_root.mkdir()
    pos_ledger = _ledger(scratch, "pos")
    pos_target = _mkfile(pos_root, "copy-014.bin", PAYLOAD)
    pos_keep = _mkfile(pos_root, "keep-a.bin", "保留物：本次计划不含它\n")
    pos_item = _purge("copy-014.bin", "id:pack-014")
    pos_exec = RetentionExecutor(pos_ledger, root=pos_root)
    pos = pos_exec.execute({"items": [pos_item, {"object": "seq:9", "kind": "ledger-row",
                                                 "action": "keep", "ledger_row": True}]})
    resolved = pos_target.resolve()
    out.append(Assertion("正控（真删）：临时根里的副本在 plan→execute 后**真的不存在了**，`counts.purged=1`、"
                         "`events_written=1`，且 keep 项不计入任何动作、同目录的保留物没被动过",
                         not pos_target.exists() and pos_keep.is_file()
                         and pos["counts"]["purged"] == 1 and pos["counts"]["purge-copy"] == 1
                         and pos["counts"]["considered"] == 2 and pos["counts"]["keep"] == 1
                         and pos["purged"][0]["applied"] is True
                         and pos["purged"][0]["resolved"] == str(resolved)
                         and pos["events_written"] == 1
                         and RESULT_KEYS <= set(pos) and pos["dry_run"] is False,
                         f"exists={pos_target.exists()} counts={pos['counts']} target={pos['purged'][0].get('target')}"))

    purge_rows = pos_ledger.read(type=PURGE_EVENT)
    body = purge_rows[0]["body"] if purge_rows else {}
    ledger_text = (scratch / "pos.jsonl").read_text(encoding="utf-8")
    out.append(Assertion("账本真落痕：`evidence/retention-copy-purged` 恰好 1 条，body **只有** "
                         "`{target, sha256, bytes}`，哈希与字节数与手算一致（可事后复核）",
                         len(purge_rows) == 1 and set(body) == {"target", "sha256", "bytes"}
                         and body["target"] == str(resolved) and body["sha256"] == _sha256(PAYLOAD)
                         and body["bytes"] == len(PAYLOAD.encode("utf-8"))
                         and purge_rows[0]["class"] == "fact"
                         and pos["purged"][0]["sha256"] == body["sha256"],
                         f"rows={len(purge_rows)} body_keys={sorted(body)} sha={body.get('sha256')}"))
    out.append(Assertion("留痕**不复活被销毁内容**：哨兵文本不在账本文件、不在报告、不在事件 body 里；"
                         "报告里只有哈希（`sha256:` 前缀）与字节数",
                         SENTINEL not in ledger_text and SENTINEL not in canonical_json(pos)
                         and SENTINEL not in canonical_json(purge_rows)
                         and not any(key in body for key in ("body", "content", "payload", "text"))
                         and body["sha256"].startswith("sha256:")
                         and len(body["sha256"]) == len("sha256:") + 64,
                         f"ledger_leak={SENTINEL in ledger_text} report_leak={SENTINEL in canonical_json(pos)}"))

    # ============ 6. 幂等 ============
    ledger_before = pos_ledger.count
    again = pos_exec.execute({"items": [pos_item]})
    out.append(Assertion("幂等：同一计划跑第二次 → 全部 `skipped/already-absent`（不是报错、不是重复删），"
                         "账本**不再新增**事件（行数与 purge 事件数都不变）",
                         again["counts"]["skipped"] == 1 and again["counts"]["purged"] == 0
                         and again["counts"]["refused"] == 0 and again["events_written"] == 0
                         and _reasons(again["skipped"]) == [S_ALREADY_ABSENT]
                         and pos_ledger.count == ledger_before
                         and len(pos_ledger.read(type=PURGE_EVENT)) == 1,
                         f"skipped={_reasons(again['skipped'])} counts={again['counts']} "
                         f"ledger={ledger_before}->{pos_ledger.count}"))

    # ============ 7. 读侧封存 ============
    sealed_rel = pos_exec.is_sealed("copy-014.bin")
    sealed_abs = pos_exec.is_sealed(str(resolved))
    raised = _attempt(lambda: pos_exec.assert_readable("copy-014.bin"))
    open_ok = _attempt(lambda: pos_exec.assert_readable("keep-a.bin"))
    _mkfile(pos_root, "copy-014.bin", "有人把文件重建回来了\n")     # 重建不得让封存复活
    reborn = pos_exec.is_sealed("copy-014.bin")
    reborn_read = _attempt(lambda: pos_exec.assert_readable(str(resolved)))
    out.append(Assertion("读侧封存（AC-AUDIT-003 里「销毁后不可再读」那句的执行侧实证）：销毁过的目标 "
                         "`is_sealed()` 为真、`assert_readable()` 抛 `TargetSealed`；**文件被重建也不复活**；"
                         "未销毁的目标 `is_sealed()` 为假、`assert_readable()` 静默通过",
                         sealed_rel and sealed_abs and isinstance(raised, TargetSealed)
                         and open_ok is None and pos_exec.is_sealed("keep-a.bin") is False
                         and reborn and isinstance(reborn_read, TargetSealed),
                         f"sealed={sealed_rel}/{sealed_abs} raised={type(raised).__name__} "
                         f"keep_sealed={pos_exec.is_sealed('keep-a.bin')} reborn={reborn}"))

    # ============ 3~5. 越界 / 账本行 / 缺批准（负控） ============
    neg_root = scratch / "neg"
    neg_root.mkdir()
    neg_ledger = _ledger(scratch, "neg")
    outside = scratch / "outside"
    outside.mkdir()
    outside_file = _mkfile(outside, "outside.bin", "根外的东西：不许被碰到\n")
    neg_keep = _mkfile(neg_root, "neg-keep.bin", "根内的东西：不许被碰到\n")
    neg_victim = _mkfile(neg_root, "neg-victim.bin", "同批次里唯一该被删的\n")
    (neg_root / "link-out.bin").symlink_to(outside_file)
    neg_exec = RetentionExecutor(neg_ledger, root=neg_root)
    escapes = [
        _purge("../outside/outside.bin", "id:esc-dotdot"),
        _purge(str(outside_file), "id:esc-abs"),
        _purge("link-out.bin", "id:esc-link"),
    ]
    neg = neg_exec.execute({"items": escapes + [_purge("neg-victim.bin", "id:victim")]})
    out.append(Assertion("负控（越界拒绝）：`../` 逃逸 / 根外绝对路径 / 指向根外的软链 → 一律 `refused` 且 "
                         "`reason=path-outside-root`；根外文件与根内其他文件仍在；"
                         "**同批次里一条正常目标必须真的被删**（「一律拒绝」不算通过）",
                         _reasons(neg["refused"]) == [R_PATH_OUTSIDE] * 3
                         and neg["counts"]["refused"] == 3 and neg["counts"]["purged"] == 1
                         and not neg_victim.exists()
                         and outside_file.is_file() and neg_keep.is_file()
                         and (neg_root / "link-out.bin").is_symlink()
                         and len(neg_ledger.read(type=PURGE_EVENT)) == 1,
                         f"reasons={_reasons(neg['refused'])} purged={neg['counts']['purged']} "
                         f"victim_gone={not neg_victim.exists()} outside_ok={outside_file.is_file()} "
                         f"link_ok={(neg_root / 'link-out.bin').is_symlink()}"))
    link_in = neg_root / "link-in.bin"
    link_in.symlink_to(neg_keep)
    link_report = neg_exec.execute({"items": [_purge("link-in.bin", "id:link-in")]})
    out.append(Assertion("负控（符号链接）：指向**根内**的软链也拒绝（`reason=symlink-refused`）——"
                         "删链接与删它指向的目标不是一回事，链接与它指向的目标都必须还在",
                         _reasons(link_report["refused"]) == [R_SYMLINK]
                         and link_report["counts"]["purged"] == 0 and link_report["events_written"] == 0
                         and link_in.is_symlink() and neg_keep.is_file()
                         and len(neg_ledger.read(type=PURGE_EVENT)) == 1,
                         f"reason={_reasons(link_report['refused'])} link_ok={link_in.is_symlink()} "
                         f"target_ok={neg_keep.is_file()} ledger={neg_ledger.count}"))

    row_root = scratch / "row"
    row_root.mkdir()
    row_ledger = _ledger(scratch, "row")
    row_file = _mkfile(row_root, "ledger-row-file.bin", "账本行对应的东西：永不销毁\n")
    row_exec = RetentionExecutor(row_ledger, root=row_root)
    ledger_row_item = {"object": "seq:1", "seq": 1, "kind": "ledger-row", "ledger_row": True,
                       "action": "purge-copy", "path": "ledger-row-file.bin"}
    row_report = row_exec.execute({"items": [ledger_row_item, _purge("row-file-2.bin", "id:row-2")]})
    (row_root / "row-file-2.bin").write_text("普通副本\n", encoding="utf-8")
    out.append(Assertion("负控（账本行）：计划里混入一条账本行（带 seq）要求 purge → **不得删**、计入 `refused` + "
                         "`reason=ledger-row`（执行侧第二次拦截：不因上游判过就少查一遍），账本零新增",
                         _reasons(row_report["refused"]) == [R_LEDGER_ROW]
                         and row_report["counts"]["refused"] == 1 and row_file.is_file()
                         and row_ledger.count == 0 and row_report["counts"]["purged"] == 0,
                         f"reasons={_reasons(row_report['refused'])} file_ok={row_file.is_file()} "
                         f"ledger={row_ledger.count}"))

    # 判定器（计划侧）→ 执行器（执行侧）端到端：账本行被判 keep、副本被判 purge-copy 后真的被删
    plan_root = scratch / "plan"
    plan_root.mkdir()
    plan_ledger = _ledger(scratch, "plan")
    plan_file = _mkfile(plan_root, "pack-014", PAYLOAD)
    policy = RetentionPolicy({"quote/submitted": {"retain_days": 365, "after": "archive"},
                              "evidence/pack-exported": {"retain_days": 30, "after": "purge-copy",
                                                         "requires_approval": True}}, max_items=10)
    plan = policy.plan([{"seq": 1, "type": "quote/submitted", "ts": OLD},
                        {"id": "pack-014", "type": "evidence/pack-exported", "ts": OLD}], NOW)
    approvals = ApprovalService(ledger=plan_ledger)
    request = approvals.request("evidence.purge-copy", {"target": "pack-014"}, ref="id:pack-014",
                                reason="不可重建物销毁")
    approvals.decide(request["approval_id"], by="human:alice", decision="granted")
    plan_exec = RetentionExecutor(plan_ledger, root=plan_root,
                                  approved_refs={"id:pack-014": request["approval_id"]})
    plan_report = plan_exec.execute(plan)
    out.append(Assertion("计划侧→执行侧端到端：`retention.plan()` 的判断直接喂给执行器——"
                         "账本行那条计 `keep` 且不动，副本那条在拿到人工门后真的被删并落痕",
                         plan["counts"]["refused"] == 1 and plan_report["counts"]["keep"] == 1
                         and plan_report["counts"]["purged"] == 1 and not plan_file.exists()
                         and len(plan_ledger.read(type=PURGE_EVENT)) == 1
                         and plan_report["purged"][0]["object"] == "id:pack-014"
                         and plan_report["purged"][0]["approval_id"] == request["approval_id"],
                         f"plan_refused={plan['counts']['refused']} exec={plan_report['counts']} "
                         f"resolved={plan_report['purged'][0].get('resolved')}"))

    # 账本行「要求 purge」的注入版：不得因为上游没拦而放过
    injected = [dict(item) for item in plan["items"]]
    injected.append({**plan["items"][0], "action": "purge-copy", "path": "pack-014"})
    injected_report = plan_exec.execute({"items": injected})
    out.append(Assertion("负控（账本行·注入版）：把判定器判 keep 的账本行**改写成 purge-copy** 再交给执行器 → "
                         "仍然 `refused` + `reason=ledger-row`，账本不多一行",
                         _reasons(injected_report["refused"]) == [R_LEDGER_ROW]
                         and injected_report["counts"]["keep"] == 1
                         and len(plan_ledger.read(type=PURGE_EVENT)) == 1,
                         f"reasons={_reasons(injected_report['refused'])} keep={injected_report['counts']['keep']}"))

    # ============ 5. 缺人工门 → 拒绝；有批准 → 真删 ============
    gate_root = scratch / "gate"
    gate_root.mkdir()
    gate_ledger = _ledger(scratch, "gate")
    gate_file = _mkfile(gate_root, "irreplaceable.bin", "不可重建物：没门不许动\n")
    gate_item = _purge("irreplaceable.bin", "id:pack-019", approval_required=True)
    no_gate = RetentionExecutor(gate_ledger, root=gate_root).execute({"items": [gate_item]})
    missing_raised = _attempt(lambda: RetentionExecutor(gate_ledger, root=gate_root, approved_refs={
        "id:pack-019": "ap-0001"}).require_approval(gate_item))
    out.append(Assertion("负控（缺人工门）：`approval_required=True` 的不可重建物在没有有效批准时 → "
                         "`refused` + `reason=approval-missing`、**文件仍在**、账本零新增；"
                         "`require_approval()` 直接调用同样抛 `ApprovalMissing`",
                         _reasons(no_gate["refused"]) == [R_APPROVAL_MISSING]
                         and no_gate["counts"]["purged"] == 0 and no_gate["events_written"] == 0
                         and gate_file.is_file() and gate_ledger.count == 0
                         and isinstance(missing_raised, ApprovalMissing)
                         and isinstance(_attempt(lambda: RetentionExecutor(gate_ledger, root=gate_root)
                                                 .require_approval(gate_item)), ApprovalMissing),
                         f"reasons={_reasons(no_gate['refused'])} file_ok={gate_file.is_file()} "
                         f"ledger={gate_ledger.count} raised={type(missing_raised).__name__}"))

    gate_service = ApprovalService(ledger=gate_ledger)
    gate_request = gate_service.request("retention.destroy", {"target": "id:pack-019"},
                                        ref="id:pack-019", reason="不可重建物销毁", approvers=["human:alice"])
    still_pending = RetentionExecutor(gate_ledger, root=gate_root,
                                      approved_refs={"id:pack-019": gate_request["approval_id"]}
                                      ).execute({"items": [gate_item]})
    gate_service.decide(gate_request["approval_id"], by="human:alice", decision="granted")
    granted_exec = RetentionExecutor(gate_ledger, root=gate_root, approvals=gate_service,
                                     approved_refs={"id:pack-019": gate_request["approval_id"]})
    granted = granted_exec.execute({"items": [gate_item]})
    out.append(Assertion("人工门（正控）：引用**不是**批准——「已请求但未批准（pending）」仍 `refused`；"
                         "人签字（`decided_by=human:`、scope 适用、ref 绑定）之后 → **真删 + 落痕**，"
                         "且销毁行带出可回溯的 `approval_id`",
                         _reasons(still_pending["refused"]) == [R_APPROVAL_MISSING]
                         and still_pending["counts"]["purged"] == 0 and not gate_file.exists() is True
                         and granted["counts"]["purged"] == 1 and granted["events_written"] == 1
                         and not gate_file.exists()
                         and granted["purged"][0]["approval_id"] == gate_request["approval_id"]
                         and len(gate_ledger.read(type=PURGE_EVENT)) == 1,
                         f"pending→{_reasons(still_pending['refused'])} granted={granted['counts']} "
                         f"file_gone={not gate_file.exists()}"))

    probe_root = scratch / "probe"
    probe_root.mkdir()
    probe_ledger = _ledger(scratch, "probe")
    probe_file = _mkfile(probe_root, "probe.bin", "批准负控：谁也别动\n")
    probe_service = ApprovalService(ledger=probe_ledger)
    pending = probe_service.request("retention.destroy", {"t": 1}, ref="id:probe")
    denied = probe_service.request("retention.destroy", {"t": 1}, ref="id:probe")
    probe_service.decide(denied["approval_id"], by="human:alice", decision="denied")
    scope_wrong = probe_service.request("billing.refund", {"t": 1}, ref="id:probe")
    probe_service.decide(scope_wrong["approval_id"], by="human:alice", decision="granted")
    ref_wrong = probe_service.request("retention.destroy", {"t": 1}, ref="id:elsewhere")
    probe_service.decide(ref_wrong["approval_id"], by="human:alice", decision="granted")
    probe_item = _purge("probe.bin", "id:probe", approval_required=True)
    probes = {"缺引用": None, "引用格式非法": "granted", "核不出的引用": "ap-9999",
              "未批准(pending)": pending["approval_id"], "已拒绝(denied)": denied["approval_id"],
              "scope 不适用": scope_wrong["approval_id"], "绑定别的对象": ref_wrong["approval_id"]}
    verdicts = {}
    for label, ref in probes.items():
        executor = RetentionExecutor(probe_ledger, root=probe_root, approvals=probe_service,
                                     approved_refs={} if ref is None else {"id:probe": ref})
        report = executor.execute({"items": [probe_item]})
        verdicts[label] = (_reasons(report["refused"]), report["counts"]["purged"])
    out.append(Assertion(f"负控（批准七种伪造/无效形态 {len(probes)}/{len(probes)}）：缺引用、格式非法、核不出、"
                         "未批准、已拒绝、scope 不适用、绑定别的对象 → 一律 `refused` + "
                         "`reason=approval-missing`、文件仍在、账本零 purge 事件（引用不是批准，agent 不得代签）",
                         all(reason == [R_APPROVAL_MISSING] and purged == 0
                             for reason, purged in verdicts.values())
                         and probe_file.is_file() and not probe_ledger.read(type=PURGE_EVENT),
                         f"verdicts={ {key: value[0] for key, value in verdicts.items()} } "
                         f"file_ok={probe_file.is_file()}"))

    # ============ 8. 零副作用（dry_run） ============
    dry_root = scratch / "dry"
    dry_root.mkdir()
    dry_ledger = _ledger(scratch, "dry")
    _mkfile(dry_root, "dry-1.bin", "dry-1\n")
    _mkfile(dry_root, "dry-2.bin", "dry-2\n")
    dry_items = [_purge("dry-1.bin", "id:dry-1"), _purge("dry-2.bin", "id:dry-2")]
    before = sorted(str(path.relative_to(dry_root)) for path in dry_root.rglob("*"))
    dry_exec = RetentionExecutor(dry_ledger, root=dry_root, dry_run=True)
    dry = dry_exec.execute({"items": dry_items})
    after = sorted(str(path.relative_to(dry_root)) for path in dry_root.rglob("*"))
    dry_ledger_rows = dry_ledger.count                      # dry_run 之后、真跑之前的账本行数
    dry_targets = {row["target"] for row in dry["purged"]}
    real = RetentionExecutor(dry_ledger, root=dry_root).execute({"items": dry_items})
    out.append(Assertion("零副作用（dry_run）：**一个文件也不动**（目录清单前后一致、无 archive/ 目录）、"
                         "账本零新增，但报告里能看到「本来会删什么」（`applied=False`、带哈希与字节数）、"
                         "`would_purge=2` 且 `counts.purged=0`；随后真跑删掉的正是这批目标",
                         before == after and dry["counts"]["purged"] == 0 and dry["counts"]["would_purge"] == 2
                         and dry_ledger_rows == 0 and dry["events_written"] == 0 and dry["dry_run"] is True
                         and all(row["applied"] is False and row["sha256"].startswith("sha256:")
                                 and isinstance(row["bytes"], int) and "dry-run" in row["reason"]
                                 for row in dry["purged"])
                         and dry_targets == {row["target"] for row in real["purged"]}
                         and real["counts"]["purged"] == 2
                         and sorted(str(path.relative_to(dry_root)) for path in dry_root.rglob("*")) == [],
                         f"tree={before}->{after} counts={dry['counts']} "
                         f"would={sorted(dry_targets)} real={real['counts']['purged']}"))

    # ============ 9~10. 静态零残留 + 不递归删目录 ============
    # 扫的是**当前进程里真正被 import 的那份源码**（而不是仓库里的固定路径）：变异副本（tmp/t253-mutate.py）
    # 会被扫到，静态变异因而同样能变红。
    scanned = Path(retention_exec_module.__file__).resolve()
    source = scanned.read_text(encoding="utf-8")
    needles = ("shutil", "subprocess", "glob.", "import glob", "rmtree", "os.system", "popen",
               "os.remove", "os.rmdir", "scandir", "os.walk", ".walk(", "rglob(", "fnmatch")
    hits = [needle for needle in needles if needle in source]
    tree = ast.parse(source)
    imports: set = set()
    calls: set = set()
    unlink_receivers: list = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and not node.level:
            imports.add((node.module or "").split(".")[0])
        elif isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name):
                calls.add(func.id)
            elif isinstance(func, ast.Attribute):
                calls.add(func.attr)
                if func.attr in ("unlink", "rmtree", "rmdir", "remove", "walk", "rglob", "scandir"):
                    unlink_receivers.append((func.attr, isinstance(func.value, ast.Name)))
    forbidden_imports = imports & {"shutil", "subprocess", "glob", "tempfile", "fnmatch"}
    forbidden_calls = calls & {"system", "popen", "rmtree", "rmdir", "remove", "walk", "rglob",
                              "scandir", "Popen"}
    delete_calls = [name for name, _ in unlink_receivers if name in ("unlink", "remove", "rmdir", "rmtree")]
    out.append(Assertion("静态零残留：`services/retention_exec.py` 里没有 `shutil`/`subprocess`/`glob`/"
                         "`tempfile` 导入，没有 `os.system`/`popen`/`rmtree`/`os.remove`/`rmdir`/`walk`/"
                         "`rglob`/`scandir` 调用；删除是**单文件显式** `Path.unlink()`（接收者是简单名字，"
                         "不是 glob/遍历结果），且先过 `is_file()` 守卫——「删东西」只能是这一个动作",
                         not hits and not forbidden_imports and not forbidden_calls
                         and bool(delete_calls) and set(delete_calls) == {"unlink"}
                         and all(isinstance(receiver, bool) and receiver for _, receiver in unlink_receivers)
                         and source.count("unlink(") <= 3
                         and source.index("resolved.is_file()") < source.index("resolved.unlink()"),
                         f"needles={hits} imports={sorted(forbidden_imports)} calls={sorted(forbidden_calls)} "
                         f"delete_calls={delete_calls} unlink_sites={len(unlink_receivers)} "
                         f"scanned={scanned.relative_to(repo_root()) if repo_root() in scanned.parents else scanned} "
                         f"({len(source)} B)"))

    dir_root = scratch / "dir"
    dir_root.mkdir()
    dir_ledger = _ledger(scratch, "dir")
    (dir_root / "subdir").mkdir()
    child_a = _mkfile(dir_root / "subdir", "child-a.txt", "子文件 A\n")
    child_b = _mkfile(dir_root / "subdir", "child-b.txt", "子文件 B\n")
    dir_report = RetentionExecutor(dir_ledger, root=dir_root).execute({"items": [
        _purge("subdir", "id:dir"), _purge("subdir/child-a.txt", "id:child")]})
    out.append(Assertion("不递归删目录（动态，与静态扫描互为证据）：目标是目录 → `refused` + "
                         "`not-a-regular-file`，目录与子文件一个不少；目录**内**的单文件仍可被显式删除",
                         _reasons(dir_report["refused"]) == [R_NOT_REGULAR]
                         and (dir_root / "subdir").is_dir() and child_b.is_file() and not child_a.exists()
                         and dir_report["counts"]["refused"] == 1 and dir_report["counts"]["purged"] == 1,
                         f"reasons={_reasons(dir_report['refused'])} dir_ok={(dir_root / 'subdir').is_dir()} "
                         f"children={sorted(p.name for p in (dir_root / 'subdir').iterdir())}"))

    # ============ 11. 归档：写包 + 落痕 + 不删源 + 重跑不重写 ============
    arc_root = scratch / "arc"
    arc_root.mkdir()
    arc_ledger = _ledger(scratch, "arc")
    arc_file = _mkfile(arc_root, "pack-016.bin", "归档物：封进包但源要留着\n")
    arc_item = _purge("pack-016.bin", "id:pack-016", action="archive")
    arc_exec = RetentionExecutor(arc_ledger, root=arc_root)
    arc = arc_exec.execute({"items": [arc_item]})
    archive_path = arc_root / "archive" / "pack-016.bin.tar"
    arc_again = arc_exec.execute({"items": [arc_item]})
    out.append(Assertion("归档：`archive` 项写 `root/archive/<name>.tar` 并落 `evidence/retention-archived`，"
                         "**不删源**（删除只由 purge-copy 触发）；重跑计 `skipped/already-archived` 且不再落新事件",
                         arc["counts"]["archived"] == 1 and archive_path.is_file() and arc_file.is_file()
                         and [row["type"] for row in arc_ledger.read()] == [ARCHIVE_EVENT]
                         and _reasons(arc_again["skipped"]) == [S_ALREADY_ARCHIVED]
                         and arc_again["events_written"] == 0
                         and len(arc_ledger.read(type=ARCHIVE_EVENT)) == 1
                         and arc["archived"][0]["archive"] == str(archive_path),
                         f"archived={arc['counts']['archived']} archive={archive_path.is_file()} "
                         f"source_kept={arc_file.is_file()} again={_reasons(arc_again['skipped'])}"))

    # ============ 12. 确定性 ============
    det_root = scratch / "det"
    det_root.mkdir()
    det_ledger = _ledger(scratch, "det")
    _mkfile(det_root, "same.bin", PAYLOAD)
    det_item = _purge("same.bin", "id:same")
    dry_a = RetentionExecutor(det_ledger, root=det_root, dry_run=True).render(
        RetentionExecutor(det_ledger, root=det_root, dry_run=True).execute({"items": [det_item]}))
    dry_b = RetentionExecutor(det_ledger, root=det_root, dry_run=True).render(
        RetentionExecutor(det_ledger, root=det_root, dry_run=True).execute({"items": [det_item]}))
    first = RetentionExecutor(det_ledger, root=det_root).execute({"items": [det_item]})
    _mkfile(det_root, "same.bin", PAYLOAD)                       # 用同样内容重建，再跑同一计划
    second = RetentionExecutor(det_ledger, root=det_root).execute({"items": [det_item]})
    changed = {key for key in set(first) | set(second)
               if canonical_json(first.get(key)) != canonical_json(second.get(key))}
    counts_changed = {key for key in first["counts"] if first["counts"][key] != second["counts"][key]}
    rows_changed = {key for key in first["purged"][0] if first["purged"][0][key] != second["purged"][0][key]}
    out.append(Assertion("确定性（dry-run）：同一输入两次 `render()` **逐字节一致**；报告里没有时间戳、"
                         "没有自增序号（不含 ISO 日期、不含 clock/counter 字段）",
                         dry_a == dry_b and len(dry_a.encode("utf-8")) > 200
                         and "T00:00" not in dry_a and "timestamp" not in dry_a
                         and "counter" not in dry_a,
                         f"bytes={len(dry_a.encode('utf-8'))} equal={dry_a == dry_b}"))
    out.append(Assertion("确定性（真删重跑）：同一计划在同一根上跑两次，报告除**账本侧事实**"
                         "（`events_written` 与 `ledger_duplicate`）外逐字节一致；账本按 "
                         "`(correlation_id, type, body_hash)` 去重，不因重跑多出一行",
                         _strip_ledger_facts(first) == _strip_ledger_facts(second)
                         and changed == {"purged", "counts", "events", "events_written"}
                         and counts_changed == {"events_written"} and rows_changed == {"ledger_duplicate"}
                         and first["purged"][0]["ledger_duplicate"] is False
                         and second["purged"][0]["ledger_duplicate"] is True
                         and second["events_written"] == 0
                         and len(det_ledger.read(type=PURGE_EVENT)) == 1,
                         f"changed={sorted(changed)} counts={sorted(counts_changed)} rows={sorted(rows_changed)} "
                         f"rows_total={len(det_ledger.read(type=PURGE_EVENT))}"))

    # ============ 13. 边界 ============
    bound_root = scratch / "bound"
    bound_root.mkdir()
    bound_ledger = _ledger(scratch, "bound")
    no_root = _attempt(lambda: RetentionExecutor(bound_ledger))  # type: ignore[call-arg] —— 负控：故意不传 root
    none_root = _attempt(lambda: RetentionExecutor(bound_ledger, root=None))
    blank_root = _attempt(lambda: RetentionExecutor(bound_ledger, root=""))
    repo_as_root = _attempt(lambda: RetentionExecutor(bound_ledger, root=repo_root()))
    src_as_root = _attempt(lambda: RetentionExecutor(bound_ledger, root=repo_root() / "src"))
    no_ledger = _attempt(lambda: RetentionExecutor(None, root=bound_root))
    out.append(Assertion("边界（构造）：不传 root / `root=None` / 空串 / 仓库根 / 仓库 `src/` / 无账本 → "
                         "**构造即失败**（没有「默认当前目录」这种退路，也不许把 src 当可删区）",
                         isinstance(no_root, TypeError)
                         and all(isinstance(value, RetentionExecutionError)
                                 for value in (none_root, blank_root, repo_as_root, src_as_root, no_ledger))
                         and not isinstance(repo_as_root, (type(None), bool))
                         and "root" in str(repo_as_root),
                         f"no_root={type(no_root).__name__} none={type(none_root).__name__} "
                         f"repo={type(repo_as_root).__name__} src={type(src_as_root).__name__} "
                         f"ledger={type(no_ledger).__name__}"))

    empty_exec = RetentionExecutor(bound_ledger, root=bound_root)
    empty = empty_exec.execute({"items": []})
    no_items = _attempt(lambda: empty_exec.execute({}))
    out.append(Assertion("边界（计划）：空计划不崩、计数全 0（`counts` 键集固定，含 `would_purge`/`untraced`）；"
                         "缺 `items` 的计划**报错**而不是静默当空跑；空计划下账本零新增、目录不变",
                         set(empty["counts"]) >= set(EMPTY_COUNTS_ZERO) | {"skipped_reasons", "refused_reasons"}
                         and all(empty["counts"][key] == 0 for key in EMPTY_COUNTS_ZERO)
                         and empty["counts"]["skipped_reasons"] == {} and empty["counts"]["refused_reasons"] == {}
                         and empty["events_written"] == 0 and empty["purged"] == [] and empty["refused"] == []
                         and isinstance(no_items, RetentionExecutionError)
                         and bound_ledger.count == 0,
                         f"counts={empty['counts']} no_items={type(no_items).__name__}: {str(no_items)[:60]}"))

    # ============ 14. 服务自洽：拒绝理由可读 + 报告自带声明 ============
    tally = neg["counts"]["refused_reasons"]
    out.append(Assertion("服务自洽：逐条拒绝的明细与计数**对得上**（`refused_reasons` 是拒绝清单的准确聚合），"
                         "报告自带 `note`/`ledger_rows_destroyed=0` 的边界声明，且没有任何「递归/批量」动作字段",
                         tally == {R_PATH_OUTSIDE: 3} and neg["counts"]["refused"] == 3
                         and neg["counts"]["refused"] == len(neg["refused"])
                         and isinstance(neg["note"], str) and neg["note"].strip() != ""
                         and neg["ledger_rows_destroyed"] == 0
                         and all("recursive" not in key and "glob" not in key for key in neg["counts"]),
                         f"tally={tally} refused={len(neg['refused'])}/{neg['counts']['refused']} "
                         f"ledger_rows_destroyed={neg['ledger_rows_destroyed']}"))

    shutil.rmtree(scratch, ignore_errors=True)
    return out
