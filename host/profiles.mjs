/**
 * P1 profiles（T-201 / S1.1）：**双侧进程分离**的组成数据。
 *
 * 每个 profile = 一个真进程 + 一个 realm + 一本账本 + 一组模块 + 一层配置。
 * 组成即数据（ADR-0001 纪律 3）：改 profile 就是改组成，只能由人（见 lib/schema.mjs）。
 * 桥接到 Python 内核（B3）后，`sidecar` 字段会带上真实入口；在 B3 之前它显式标
 * `deferred-to-B3`——**不假装已经接通**。
 */
import { join } from 'node:path'

export const PROFILES = {
  'contractor-ops': {
    role: 'contractor',
    label: '承包商运营台',
    realm: 'contractor:con-B',
    ledger: 'ledger-contractor.jsonl',
    modules: ['config', 'frozen', 'kernel-bridge', 'sourcing', 'compare', 'guard', 'approval', 'queue', 'canary', 'bridge-canary', 'governor', 'audit-hook', 'circuit-breaker', 'idempotency-guard', 'budget-guard'],
    sidecar: 'deferred-to-B3',
    config: {
      approval: { queue: { enabled: true }, auto_approve: false },
      commitments: { require_human: true },
      compare: { weights: { price: 0.6, delivery: 0.15, payment: 0.1, warranty: 0.05, deviation: 0.1 } },
      pricing: { authorized_band: { min_unit_price: 80.0, max_unit_price: 100.0 } },
      guard: { abnormal_low_ratio: 0.6 },
      transport: { kind: 'file-drop', dir: 'inbox' },
    },
  },
  'webui': {
    role: 'view-host',
    label: '双方视角 WebUI（view-host）',
    realm: 'contractor:con-B',
    ledger: 'ledger-contractor.jsonl',
    modules: ['config', 'projection', 'webui', 'timeline', 'canary', 'audit-hook', 'governor', 'observability', 'price-history', 'evidence-summary', 'ops-view', 'evolve-journal', 'supplier-scorecard', 'approval-digest', 'retention-view', 'pipeline-view', 'admin-guard', 'admin-view', 'plugin-market', 'user-plugin-manager'],
    sidecar: 'read-only',
    config: {
      // 一个进程两个路由：承包商视角读承包商账本、供应商视角读供应商账本（结构性隔离）
      // 真正的账本路径由 tools/webui-serve.py 经 CLI 参数给出（机器相关，不进 profile 数据）
    },
  },
  'supplier-bid': {
    role: 'supplier',
    label: '供应商报价台',
    realm: 'supplier:sup-A',
    ledger: 'ledger-supplier.jsonl',
    modules: ['config', 'frozen', 'kernel-bridge', 'norm', 'cost', 'pricing'],
    sidecar: 'deferred-to-B3',
    config: {
      norm: { tolerance_bps: 5, fallback_defaults: [] },
      pricing: { markup_pct: 12.0 },
      transport: { kind: 'file-drop', dir: 'inbox' },
    },
  },
  'agent-runtime': {
    role: 'agent-runtime',
    label: 'agent 运行期（上下文 / 记忆四层 / harness）',
    realm: 'contractor:con-B',
    ledger: 'ledger-contractor.jsonl',
    modules: ['config', 'frozen', 'agent-context', 'agent-memory', 'agent-harness'],
    sidecar: 'read-only',
    config: {},
  },
  relay: {
    role: 'relay',
    label: '中转（不解析 body）',
    realm: 'relay:r-1',
    ledger: 'ledger-relay.jsonl',
    modules: ['config', 'frozen', 'transport'],
    sidecar: 'deferred-to-B3',
    config: {
      transport: { kind: 'file-drop', dir: 'spool', parse_body: false },
    },
  },
}

export const profileDir = (root, profile) => join(root, profile)

export const profileNames = () => Object.keys(PROFILES)
