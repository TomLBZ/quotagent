# 身份与会话 + 三个自助面（DEF-001/003/025/026）

<!-- 预算：4 KB。口径真源：`docs/design/29-webui-gui-app.md` §7；用法总览见 `usage.md` §8。 -->

业务动作不再靠「开哪个 URL」区分侧：**登录一次**，之后每个动作的身份从**会话**取（`human:<名字>`），不再手填。

| 面 | 路由 | 谁能用 | 落到哪 / 拒绝口径 |
|---|---|---|---|
| 登录·切换·登出 | `GET /identity/{,me}`、`POST /identity/{login,logout}` | 所有人 | 服务端会话 `<ui_shared>/identity/sessions.json`（**0600** 原子写）+ 不透明 cookie（HttpOnly/SameSite=Strict）；过期与登出**只减权** |
| 待我处理 | `GET /inbox/`（JSON `/inbox/api`）、`GET /<side>/inbox/` | 已登录且属于该侧 | 五类待办（待签报价/待批准/待确认中标/待回澄清/超期未回）；只列 `owed_by = human:<我>` 或 `side:<本侧>`；`?as_of=<ISO>` 给事实时刻（缺省取账本最大 `ts`，**不取墙钟**）；越侧 ⇒ `side-mismatch` |
| 人签 | `GET /sign/`、`POST /sign/{quote,award}` | 署名 == 会话身份 | 不一致 ⇒ `signer-mismatch`（账本零新增）→ 既有唯一写者；草稿只有本人能签（`not-my-draft`） |
| 邮件配置 | `GET/POST /mail/config/` | `side=ops` 且署名一致 | 干跑 → **0600 待处理项** → `config-apply.py` 写受管 YAML；**凭据永不回显** |
| 我的插件 | `GET /plugins/`、`POST /plugins/{load,unload,reload}` | 自己的命名空间 | 走 `userPluginManager`；跨命名空间 ⇒ `not-my-namespace`；装卸后重扫/撤销其 UI 贡献（规则 1） |

真跑验证（21 条身份路由、48 条断言、含四条负控；隔离数据目录起服务，不碰 `/workspace/config.yaml`）：

```bash
bash tmp/verify-identity/run-server.sh && python3 tmp/verify-identity.py --base http://127.0.0.1:8231/quotagent
```

负控断言：未登录 / 署名不符 / 替别人签 ⇒ `401`·`403`·`not-my-draft` 且**账本零新增**；越侧读工作台 ⇒
`side-mismatch`；`/admin/config/` 无提权仍 `401`。
