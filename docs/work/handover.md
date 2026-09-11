# 交接（每轮次更新，≤ 1024 B）

<!-- budget: 1024 bytes, hard -->

## 现在在哪

设计期完成：`docs/analysis/`（4 篇）、`docs/design/`（13 篇 + ADR-0001..0006）、
`docs/work/`（FR + AC + roadmap + checklist）。**无实现代码**（设计期约定）。

## 最后验证

`tools/verify.sh docs`（AC-DESIGN-001/002/003）→ 证据 `docs/work/evidence/EV-001`；
远端已推送并回读 refs → `EV-003`。

## 下一步唯一动作

执行 **T-101**（P0 S0.1：自包含运行时 + CLI 骨架），再按 `roadmap.md` §2 顺序推进。
开工前先做 **T-117** 的 V-002 盲测（供应商是否接受结构化报价）——它决定 P1 是否成立。

## 不变量

内核不可自改 · 承诺必须人工批准 · 模型可见即可重建 · 私域不出 realm ·
归一化不可行即拒绝 · 每条 AC 有可执行证据 · 一轮一批 commit+push 并回读远端。

## 阻塞

无。缺陷见 `progress-checklist.md` 的 D-001/D-002。
