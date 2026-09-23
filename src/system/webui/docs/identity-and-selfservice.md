# 身份与会话 + 三个自助面（DEF-001/003/025/026）

<!-- 预算：4 KB。口径真源：`docs/design/29-webui-gui-app.md` §7；用法总览见 `usage.md` §8。 -->

业务动作不再靠「开哪个 URL」区分侧：**登录一次**，之后每个动作的身份从**会话**取（`human:<名字>`），不再手填。

| 面 | 路由 | 谁能用 | 落到哪 / 拒绝口径 |
|---|---|---|---|
| 登录·切换·登出 | `GET /identity/{,me}`、`POST /identity/{login,logout}` | 所有人 | 服务端会话 `<ui_shared>/identity/sessions.json`（**0600** 原子写）+ 不透明 cookie（HttpOnly/SameSite=Strict）；过期与登出**只减权** |
| 待我处理 | `GET /inbox/`（JSON `/inbox/api`）、`GET /<side>/inbox/` | 已登录且属于该侧 | 五类待办（待签报价/待批准/待确认中标/待回澄清/超期未回）；只列 `owed_by = human:<我>` 或 `side:<本侧>`；`?as_of=<ISO>` 给事实时刻（缺省取账本最大 `ts`，**不取墙钟**）；越侧 ⇒ `side-mismatch` |
| 人签 | `GET /sign/`、`POST /sign/{quote,award}` | 署名 == 会话身份 | 不一致 ⇒ `signer-mismatch`（账本零新增）→ 既有唯一写者；草稿只有本人能签（`not-my-draft`） |
| 邮件配置 | `GET/POST /mail/config/` | `side=ops` 且署名一致 | 干跑 → **0600 待处理项** → `config-apply.py` 写受管 YAML；**凭据永不回显** |
| 我的插件 | `GET /plugins/`、`POST /plugins/{load,unload,reload}` | 自己的命名空间 | 走 `userPluginManager`；跨命名空间 ⇒ `not-my-namespace`；装卸后重扫/撤销 UI 贡献（规则 1） |

真跑验证（21 条身份路由、48 条断言、含四条负控；隔离数据目录起服务，不碰 `/workspace/config.yaml`）：

```bash
bash tmp/verify-identity/run-server.sh && python3 tmp/verify-identity.py --base http://127.0.0.1:8231/quotagent
```

负控断言：未登录 / 署名不符 / 替别人签 ⇒ `401`·`403`·`not-my-draft` 且**账本零新增**；越侧读工作台 ⇒
`side-mismatch`；`/admin/config/` 无提权仍 `401`。


## 人门：承诺 / 发 PO 必须**消费**一扇「别人批过」的门（P48）

产品主张：「对外承诺**要有另一个人批**」——修前承诺与发 PO 在**同一次落账**里自己开单、自己批准，于是主管
**没有否决权**（他不批也能签），界面查到的「谁批的」就是署名者本人。口径只有一条：

**判据**（唯一判定在 `src/system/approval/code/approval.py#signoff_verdict`，写者/服务层共用）：
① `scope`+`ref` 对得上被批对象；② 那扇门 `granted`；③ 批的人是人；④ **批的人不是这次署名的人**；
⑤ 开单点名了审批人（ADR-0022）⇒ 必须是那位（旧行没点名 ⇒ 只按 ①–④，如实标「未点名」）。

**拒因**（具名 + 下一步 + **零新增**）：`approval-required` / `approval-not-granted`（卡在谁）/
`approval-denied`（理由从账本读）/ `approval-aborted` / `approver-must-differ`（**自签自批**）/
`approver-not-named` / `approver-not-human`。

**自签自批 = 显式开关（默认关闭）**：`<ui-shared>/commitments/policy.json` 的
`{"allow_self_approval": true}`（普通文件、0600、只认真布尔；**不存在 = 关闭**；形状不合法 ⇒ `policy-malformed`，**不当作关闭**）。开关打开且没有可消费的门时，写者才自行开单+批准，并**如实写**「本次批准来自**你本人署名**（自签自批：显式开关已开）」。

**界面如实**（不装作有）：授标链给「人门：承诺 / 发 PO」两列（可提交 / 你自己批的 / 还在等谁）与
「谁签的 · 谁批的」；PO 对象页给「谁批的 vs 谁签的（人门成立吗）」；「已决定的门」给「被谁消费」一列
+ 计数 `approver_differs`/`not_consumed`。

**禁止**：不得在同一次落账里自己开单自己批准；不得把开关做成界面勾选框；不得在门没被真正用上时假装有；
不得为界面好看放宽判据（判据只在上面的那一处，界面只读它）。
