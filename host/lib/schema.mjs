/**
 * 配置键白名单（host 侧，H10 常量/枚举白名单）。
 *
 * `frozen: true`  → 永不接受更新（内核命名空间，INV-010）
 * `humanOnly: true` → 只接受 source 以 `human:` 开头的更新
 * `enum`          → 取值枚举
 * 未登记的键一律拒绝（`unknown-key`）。
 */
export const SCHEMA = {
  'kernel.*': { frozen: true, humanOnly: true, note: '内核命名空间不可自改（INV-010）' },
  'approval.*': { humanOnly: true, note: '人工门配置只能由人改' },
  'norm.*': { humanOnly: false, note: '归一化口径（容差等）' },
  'commitments.*': { humanOnly: true, note: '承诺类配置只能由人改（规则 3）' },
  'prices.authorized_band.*': { humanOnly: true, note: '授权区间是策略决定' },
  'pricing.authorized_band.*': { humanOnly: true, note: '授权区间是策略决定（越界即转人工门）' },
  // 授权区间（`authority-band`：谁能批到多少）：**只能由人改**（策略决定）——
  // 两段键（单位/币种/兜底角色/升级说明）与三段键（角色 → 限额）各一条模式，`*` 只匹配一个段。
  'authority.*': { humanOnly: true, note: '授权区间的单位/币种/兜底角色/升级说明：只能由人改' },
  'authority.bands.*': { humanOnly: true, note: '授权区间（角色 → 限额，整数分）：只能由人改（越界即转人工门）' },
  'pricing.markup_pct': { humanOnly: false, enum: null, note: '策略加价可由策略 patch 调整' },
  'compare.weights.*': { humanOnly: false, note: '排序权重来自策略 patch' },
  'norm.tolerance_bps': { humanOnly: false, note: '声明容差' },
  'guard.abnormal_low_ratio': { humanOnly: true, note: '护栏阈值由人定（P1 起）' },
  'profiles.*': { humanOnly: true, note: '改 profile = 改组成，只能由人' },
  'transport.*': { humanOnly: false, note: '投递绑定（共享目录/relay）' },
  // 邮件接入点：**端点与凭据只能由人改**（与 `approval.*` 同类：它们决定"信发给谁/用谁的账号"）；
  // 两个运行期旋钮（超时、一次取几封）不属人工专属。
  'mail.smtp.*': { humanOnly: true, note: 'SMTP 接入点与账号（含凭据指针）：只能由人改' },
  'mail.imap.*': { humanOnly: true, note: 'IMAP 接入点与账号（含凭据指针）：只能由人改' },
  'mail.timeout_seconds': { humanOnly: false, note: '邮件连接超时（秒，运行期旋钮）' },
  'mail.max_messages': { humanOnly: false, note: '一次收信最多取回几封（有界，运行期旋钮）' },
}
