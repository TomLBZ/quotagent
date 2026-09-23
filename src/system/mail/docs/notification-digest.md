# 邮件通知摘要（**人不在浏览器时**，有事会到收件箱）

<!-- 预算：16 KB（`docs/design/12-documentation-standard.md` §1 的 `src/*/*/docs/*.md` 行）。
     口径真源：`docs/design/29-webui-gui-app.md` §3（注册面）与 §9（偏好/已读在服务端）。
     实现：`code/ui.mjs`（界面入口）+ `tools/mail-digest.py`（**唯一**落盘者与发信者）。
     实测读数与截图：`tmp/p19-shots/`（`verify-digest.json` / `sink.jsonl` / `p19-pwa-04-digest-prefs-form.png`）。 -->

## 0. 一句话

> 通知中心只在页面里：**人一关浏览器，「有 3 件等待办」就没人告诉他了**。邮件域早就有真 SMTP 发信通道
> （`services/mail_transport`），但此前**没有任何东西会主动发一封**。现在：按**个人偏好**（开关默认**关**）
> 把「待办 / 未读摘要」发到你的邮箱；**同一件事不重复发**、窗口内不发第二封；摘要**不写账本**；
> 私域字段、凭据、对方正文**一个字节都不进报文**（扫三遍，命中就少发一条或整封不发）。

## 1. 开关与落点（**个人偏好，按身份，默认关**）

| 项 | 值 |
|---|---|
| 偏好文件 | `<ui_shared>/mail/notify-prefs.json`（目录 **0700** / 文件 **0600**、原子写、有界：身份 ≤ 64） |
| 状态文件 | `<ui_shared>/mail/notify-state.json`（0600）：上一次成功时刻、已发条目键（去重）、尝试计数 |
| 日志 | `<ui_shared>/mail/notify-journal.jsonl`（0600、append-only、单行有界） |
| 键 | `on`（开关）/ `to`（收件地址）/ `min_level`（`info`\|`warn`\|`bad`，默认 `warn`）/ `throttle_min`（节流分钟，默认 15，0=关） |
| 默认 | **没有你这个身份的记录 = 关**（不猜、不代用户开） |
| 归属 | 按 `human:<名字>` 存：**身份之间互不可见**；换浏览器/换设备读回同一份 ⇒ 仍在（不是 localStorage） |

**不是账本事实**：偏好/节流/已发键都是**可改的运营状态**，不是业务承诺 —— 写进账本会改事件类型目录、
证据包哈希与审计取证语义（与名册/协作/附件同源的理由）。

**凭据与地址的最小暴露**：地址只在发信那一刻使用；回执与日志里只留 **域名**与 **sha256 前 12 位指纹**
（实测回执：`to_domain=example.invalid`、`to_digest=510ef33b0c28`）。

## 2. 摘要里有什么、没有什么（这是本功能的红线）

条目由**外壳的机制面**给：`host.digest({min_level, limit})`（`app-shell.mjs`）—— 按**会话身份**聚合后的通知
（round-robin + 「同一件事只出一条」），再经白名单投影：

| 带出去 | 说明 |
|---|---|
| `id` / `level` / `title` / `next_action` / `plugin_id` / `at` / `count` / `link`（深链）/ `ref` / `tags` | 只有这些；每个字段都一行化 + 夹取（标题 160 / 下一步 200 / id 120 / 链接 400） |

| **不带出去** | 为什么 |
|---|---|
| 通知的 `body` | 它常常是**同侧同事的评论原文**或对方的备注（`collab` 通知源的 body 就是评论摘要）⇒ 对方正文**不进摘要**（界面里照旧能看，邮箱里不行） |
| 私域字段 / 凭据 | 不含 `reserve_price` / `cost_model` / `signature` / `private:`，也不含 SMTP 账号口令的值 |

**两道扫描（命中就少发，不"洗一半"）**：

1. **逐条**（外壳 + 工具各一次）：条目里出现私域哨兵或泄露样态词（`password` / `secret` / `api_key` / `bearer`）
   ⇒ 那一条**不进摘要**，并在 `withheld` 如实计数（写明命中了哪一类）。
2. **整份报文**（工具，发信之前）：拼好的字节里仍命中 ⇒ **整封不发**（`digest-leak-refused`）——
   宁可少一封，不泄露一个字节。

**真跑负控**（`tmp/p19-shots/verify-digest.py` D3/D8）：同事在评论里写下
`reserve_price=98765.4321` / `cost_model={L-001:74.4876}` / `signature=SIG-SENTINEL-t2917` /
`private:margin_pct=0.123456789` / `P19-LEAK-SENTINEL` 并 `@` 我 —— 这些字节**确实在通知中心的 body 里**
（D3 从 `/api/ui/notifications` 回读证明它活着），而**收到的报文里 0 命中**（D8，8 个哨兵 + 同事正文短语逐条断言）。

## 3. 去重与节流（**同一件事不重复发**）

- **去重键** = `<条目 id>@<级别>`：已发过的条目不再进下一封；**级别升级**（info→warn→bad）会再提醒一次。
  已发键有界（每个身份 ≤ 500，超出丢最旧）。
- **节流** = `throttle_min` 窗口内**不发第二封**，拒绝码 `digest-throttled` + `retry_after_s`；
  `0` = 关掉节流。
- 判定顺序：**开关 → 没有条目（不发空信）→ 去重（`digest-no-new`）→ 节流**。每一次未发送都进
  `refusals` 计数与日志（下一次打开面板能看到「未发送：digest-no-new×1」）。
- 「忽略节流与去重」的那次发送（`force`）**列全部可见条目**（你要的是"完整重发一份"，不是一封空信）。

## 4. 界面入口（不看文档就能用）

工作台首屏面板 **`mail.notify`「邮件摘要：有事等你时发一封到你邮箱」**（`system/mail` 注册，`order 41`）：

- 一行读数：**开关**（`开 → example.invalid` / `关（默认关）`）、发什么（级别 + 节流）、**上一次**
  （`digest-sent` / `digest-no-new` / `digest-disabled` … + 时刻 + 成功次数 + 未发送计数）、落点（0600 文件）。
- 行内两个按钮：**「改摘要偏好（开关 / 收件地址）」**（按这一行的值**预填**，不必手抄地址）与
  **「发一份摘要（待办 / 未读）」**（要确认一次；它真的会发一封信）。
- 状态栏一行 `status.mail-digest`：`邮件摘要：开 → example.invalid · 上次 …`；未登录时说
  「按身份存（未登录 ⇒ 不知道读谁的那一条）」——**不冒充**。
- 命令面板（`⌘K`）里也能找到这两个动作（`mail.notify.prefs` / `mail.notify.send`）。

## 5. 写路径（**GUI 不是第二条写路径**，摘要**不写账本**）

```
界面按钮 → 动作 mail.notify.prefs / mail.notify.send（插件自己的服务端一半，`code/ui.mjs`）
        → 会话身份（服务端；入参改不动"我是谁"）
        → host.digest()            只读投影：聚合后的通知（白名单字段 + 扫描）
        → host.stage('mail-notify' | 'mail-digest')   落 **0600 待办件**（宿主唯一的写面）
        → tools/mail-digest.py     唯一落盘者：判开关/去重/节流 + 扫描 + 落 0600 偏好/状态/日志
        → services/mail_transport.send(raw=…, ledger=None)   ← **借方既有 SMTP 通道**（唯一发信出口）
        → 回执：{ok, code, sent, new_items, duplicates, withheld, message_id, ledger: null, ledger_added: 0}
```

- **不写账本**：`ledger=None` ⇒ 回执里 `ledger: null` / `ledger_added: 0`；真跑前后两侧账本 **sha256 不变**（D9）。
- 待办件用**完即消费**（`--keep-request` 可留）；审计留在 0600 日志里（一行一条，只有计数/原因码/指纹）。
- 回执与响应体**同源**（`ok = 退出码 0 ∧ stdout.ok`），机制侧的对账判读是 `writer_consistency: consistent`。

## 6. 无浏览器路径（cron / 排障）

摘要条目来自运行中的服务（只有它知道"谁在等我"），因此**两种触发**：

```bash
# ① GUI/接口触发（主路径；界面按钮就是它）—— 需要会话 cookie
#    POST <prefix>/api/action/mail.notify.send  {"view":"contractor","input":{"min_level":"warn","limit":20}}
# ② 直接跑工具：条目由调用方给（0600 文件或 stdin），**不需要浏览器**
python3 src/system/mail/tools/mail-digest.py --op digest --shared-dir tmp/ui-shared \
  --identity human:wanglei --side contractor --items-json /path/items.json --now 2026-09-23T09:00:00Z
# ③ 只读读数（谁开着、发给哪个域名、上次什么时候、被拒过几次）
python3 src/system/mail/tools/mail-digest.py --op status --shared-dir tmp/ui-shared
# ④ 排障：算完不发、不落任何文件
... --op digest --items-json /path/items.json --dry-run
```

## 7. 边界与已知限制（如实登记）

1. **SMTP 没配对 ⇒ 不发**：走的是既有通道，所以 `mail-smtp-unconfigured` / `smtp-unreachable` 等拒绝码
   原样透出（面板「上一次」列能看到），**不假装发过**。
2. **节流是"每身份一条"**：不做队列、不做重试、不做定时器（外壳无定时器；要定时就自己 cron `--op digest`）。
3. **只发最急的前 N 条**（默认 20，上限 40）：其余在正文里报「另有 M 条没列」，并给界面深链。
4. **未读**按**服务端存的已读集合**算；没有记录（从未登录读过）⇒ 正文写「服务端不知道你读过什么」——
   **不猜**。
5. **通知正文一律不进摘要**（这是刻意的红线，不是遗漏）：想让某句话出现在邮件里，请把**标题/下一步**写清。
6. **沙盘**：`host.sharedDir` 在沙盘里是沙盘目录 ⇒ 沙盘里点摘要会写沙盘的偏好/状态（演示数据），
   真实账本依旧零新增。
7. 摘要**不是合同事实**：它不落账本、不进证据包，也不改变任何业务状态（唯一副作用是"发了一封信"）。

## 8. 复跑（真起服务、真回环 SMTP 收信、真会话）

```bash
python3 tmp/p19-shots/smtp_sink.py --port 8625 --out tmp/p19-shots/sink.jsonl &   # 回环收信夹具
QUOTAGENT_MAIL_CONFIG=$PWD/tmp/p19-shots/fixture-config.yaml \
QUOTAGENT_MAIL_STATE=$PWD/tmp/p19-shots/transport-state.json \
  ./run up --port 8471 --data-dir $PWD/tmp/p19-run
python3 tmp/p19-shots/verify-digest.py      # 16/16（开关/摘要/去重节流/不泄密/不写账本/跨侧）
```

同一张表（`tmp/p19-shots/verify-digest.json`）里的 16 条：默认关不发 · 开关落 0600 · 真发一封 ·
收件人与主题正确 · 哨兵/凭据/对方正文 0 命中 · 两侧账本 sha256 不变 · 重复不发 ·
关掉后不发 · 身份不可由入参改 · 跨侧不互发 · 未登录如实拒 · 自述与落盘齐备。
