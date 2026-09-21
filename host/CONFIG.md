# host/CONFIG.md —— 配置更新与 profile 组成

<!-- budget: 4 KB。真源是 host/lib/schema.mjs（键白名单）与 host/profiles.mjs（组成） -->

## 一次配置更新经历什么

1. CLI 构造下一份配置：`mergePatch(当前配置, patch)`（`null` 表示删除该键）。
2. 调 **cordis 原生** `fiber.update(nextConfig)` →
   `waterfall(fiber, 'internal/update', config, noSave, tail)`。
3. 守卫（`host/lib/frozen.mjs` 的 `validate`）在**插件自己的 fiber** 上注册监听器：
   命中违规 → 返回 verdict 且**不调 `next()`** → 链尾不执行 →
   **配置不变、插件不重启**（摘要不变、激活代不变、磁盘文件字节不变）。
4. 无违规 → `return next()` → 链尾 `fiber.config = config; fiber.restart()` →
   **配置生效 + 重启**（cordis 语义；因此模块状态必须外置，不能攒在进程内存里）。

只对**改动差集**判定：未改动的受限键不会造成假否决；重复提交同一更新 = 接受且摘要不变。

## 可改性三档（唯一真源 `lib/schema.mjs`）

| 档 | 含义 | 现有键 |
|---|---|---|
| `frozen: true` | **永不接受**（无人能改，含人） | `kernel.*`（INV-010 内核命名空间） |
| `humanOnly: true` | 只接受 `source` 以 `human:` 开头 | `approval.*`、`commitments.*`、`pricing.authorized_band.*`、`prices.authorized_band.*`、`guard.abnormal_low_ratio`、`profiles.*` |
| 登记键（默认） | 可由策略 patch 调整 | `compare.weights.*`、`norm.*`、`pricing.markup_pct`、`transport.*` |

**白名单外的键一律拒绝**（`unknown-key`）；`enum` 可声明取值集合。
`source` 目前来自 CLI 参数（声明式，非密码学身份）；B3 的桥由 Python 侧注入身份，
宿主**不能自称 `human`**——桥接 AC 会覆盖这条。

```sh
# 否决示例：内核键（永拒）
tools/cordis.sh run cli.mjs config-update --profile contractor-ops --root DIR \
  --patch '{"kernel":{"max_events":1}}' --source human:zhang
# → accepted=false, vetoed_by=frozen, reasons=["frozen:kernel.max_events（内核命名空间不可自改；INV-010）"],
#   digest 不变, epoch 不变, restarted=false

# 生效示例：策略权重（人签）
tools/cordis.sh run cli.mjs config-update --profile contractor-ops --root DIR \
  --patch '{"compare":{"weights":{"price":0.5}}}' --source human:zhang --reason "价格优先"
# → accepted=true, digest 变化 + 落盘, restarted=true（cordis 语义）
```

## 实测坑（别重复踩）

- **注册必须在插件 fiber 内**：在**根 context** 上 `events.on(...)` 或 `events.bail(...)` 会
  `TypeError: Cannot read properties of null (reading '_hooks')`（根 context 的 `fiber` 是 `null`）。
- **别自造 `internal/update`**：它与 cordis 内置的配置更新链同名同语义，自造会打架；
  正确做法是只写规则、复用上游链路（ADR-0015 的否决项）。
- **`tools/*.sh` 是 POSIX sh**：`${@:2}`、`[[ ]]` 之类 bash 写法会 `Bad substitution`；传参用 `shift` + `"$@"`。
- **生效即重启**：接受更新会重跑 `apply`，任何进程内累积状态（草稿/缓存）都必须外置或走 epoch 绑定。

## 机检入口

- `tools/verify.sh cordis` —— 宿主冒烟（五模式/effect 回收/重载）。
- `tools/verify.sh ac AC-PLUGIN-003` —— 把宿主当**被测进程**：两个 profile 两个真进程、
  否决配置不变且不重启、人专属键拒绝 agent、白名单拒绝陌生键、生效更新落盘。
