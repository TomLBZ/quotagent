# 21 系统管理控制台（admin 道）契约 —— 规划

**状态：规划（未实现）。** 需求已入 `functional-requirements.md`（FR 条目..010）；
**验收条目全文**在 `docs/work/plans/p3-acceptance-spec.json`（AC 条目..011）；
落表规则：门与证据都真实存在后才进 `acceptance-criteria.md`。

**编号与全文**：本批 41 条需求与 42 条验收条目的 **ID 与全文**在 `docs/work/plans/p3-spec.json`（含每条建议的验证命令与证据文件）。**本文件刻意不写 ID 记号**：文档门要求引用的 ID 必须在定义文件里存在，而 AC 只有在门与证据真实存在时才能合法落表 —— 未落表就写 ID，等于用一条指向空气的验证命令冒充已登记（宁可慢，不造假）。

## 1. 目标与形状

- 第四道 UI：`/quotagent/admin/`，与 contractor / supplier / ops 同前缀并列。
- 任一道 UI 提供**管理员 token 提权**入口；提权后**可切换到任意一道**（含回切）。
- 系统面板可见 **agent 进度与阻塞**（如"Jev 建议层缺 key""邮件缺 SMTP/IMAP 凭据"），并可**在 UI 内解除**。

## 2. 硬边界（复用既有纪律，不新开口子）

- **宿主不写账本（H1）**：提权会话、阻塞状态转移一律由 Python 侧写账本；宿主提交只落
  `tmp/ui-shared/admin-submissions/` 待处理项，由 Python 侧消费。
- **管理员身份不是看到私域键的新路径**：切视角不改变任何字段白名单（`INV-008` 不被绕过）。
- **无暗门**：不得"超时自动批准/自动解除"；过期只减权不增权。
- **失败同形**：缺 token / 错 token / 会话过期 / 管理道未启用 → 同一拒绝体，无 oracle。
- token 储存：环境变量或 0600 文件；先 `sha256` 归一再用恒定时间比较；四处（HTML/JS、快照、账本、日志）不得出现。

## 3. 规划中的机检

| 门（计划） | 覆盖 |
|---|---|
| `verify.sh admin-route`（新建） | AC 条目/002/003/005/007/008/009/010 |
| `verify.sh ac AC 条目`（新建 `qa/checks_admin.py`） | 面板真数据（阻塞≥2 条：`plugin-request`/`credential`） |
| `verify.sh ac AC 条目`（同上） | 状态机只 Python 侧写、非法转移零新增 |

## 4. 被否决的选项（来自设计草案，逐条保留）

- 让宿主直接读凭据并判定"是否可以解除阻塞" → 否决：凭据判定属事实层，宿主只提交、不判定。
- 用长寿命 cookie 存 token 本体 → 否决：token 落浏览器即违反 FR 条目；只存不透明会话 id。
- 提权后放宽投影层字段白名单 → 否决：管理员是**运维身份**，不是数据特权。
- 会话过期把阻塞标 `expired` 自动解除 → 否决：等于绕过人工门。
- 阻塞清单手写常量表 → 否决：必须由判定器从真来源（任务登记表 blocked 行 + 服务自述不可用原因）生成。

## 5. 未决（需用户或后续决策）

1. 凭据正文落点（宿主 inbox 加密？直接交 Python 侧？）
2. 多管理员并发与会话上限；token 轮换流程
3. `ws-gateway` 是否原样透传 `Set-Cookie`（AC 条目 的前提，**未实测**）
4. 提权本身是否也落账本（当前设计：只落解阻塞，提权仅会话级）

## 6. 需求行（FR-ADMIN）

| FR 条目 | 新增第四道 UI 道 `/quotagent/admin/`（系统管理），与 `/quotagent/contractor/`、`/quotagent/supplier/`、`/quotagent/ops/` 同前缀并列；该道在**未提权**时不得输出任何面板内容，只给与失败同形的一体化拒绝 | should | P2 | AC 条目 |
| FR 条目 | 任意一道 UI（contractor / supplier / ops）都提供管理员 token 提权入口；token 只经当次表单请求体提交，**不回显、不写前端存储、不进 HTML/JS、不入账本、不出现在 URL 与日志** | should | P2 | AC 条目 |
| FR 条目 | 提权后可**切换到任意一道** UI（含回切）；切换只改导航与道可见性，**不改变任何字段白名单**——管理员身份不得成为看到私域键的新路径 | should | P2 | AC 条目 |
| FR 条目 | 系统管理面板**可见 agent 进度与阻塞**：阻塞项含 `block_id`/`kind`/`reason`/`required_action`/`refs`，至少覆盖插件需求（Jev 建议层 `advisor`）与邮件收发缺凭据两条真实阻塞；进度数字只做只读归纳并标注口径来源 | should | P2 | AC 条目 |
| FR 条目 | 阻塞可**在 UI 内解除**（提交凭据 / 上传件 / 设置）：提交落为宿主侧「待处理提交」，由 Python 侧消费并落账完成 `resolved`；**提交瞬间宿主侧账本零新增**，宿主永不写账本 | should | P2 | AC 条目 |
| FR 条目 | 阻塞状态机只允许 `blocked → pending → resolved / rejected / expired`，转移只能由 Python 侧写账本产生；宿主对状态**只读**，非法转移一律拒绝且不留部分效果 | must | P2 | AC 条目 |
| FR 条目 | 提权粒度写死两档：**会话级**只决定道可见性与切换，**请求级**决定一切写类提交（缺 token 即拒）；两档都**无超时自动批准/自动解除**，过期只减权不增权 | must | P2 | AC 条目 |
| FR 条目 | 提权失败一律**统一响应**（缺 token / 错 token / 过期会话 / 管理道未启用 四类同形），响应体不含 token 或其任何可逆派生；连续失败达阈值进入有界冷却，冷却期不产生任何成功 | must | P2 | AC 条目 |
| FR 条目 | 反例：无 token 不得提权；非 admin token 一律被拒且不泄露（无 oracle）；被拒后既拿不到面板内容，也不在宿主「待处理提交」目录留下任何文件 | must | P2 | AC 条目 |
| FR 条目 | token 校验只在服务端：来源限于环境变量或 0600 文件，先 sha256 归一再用恒定时间比较（不因长度与首字符位置泄露）；token 不得出现在 HTML/JS 响应、快照文件、账本行与宿主日志四处 | must | P2 | AC 条目、AC 条目 |

## 7. 验收条目（AC-ADMIN，摘要；全文见 JSON）

- 第四道未提权不出内容：`/quotagent/admin/`、`/quotagent/admin/api/blocks`、`/quotagent/admin/api/session` 三路在无 token 且无会话时返回 401，body 逐字节等于固定体 `{"error":"unauthoriz…
- 提权端点契约：`POST /quotagent/admin/api/elevate`（`application/x-www-form-urlencoded`，token 只在请求体，URL 与 cookie 里都没有它）用正确 token → 200 且 `Set-Cookie` 为 `HttpOn…
- 切视角不改字段面：`GET /quotagent/admin/api/switch?to=supplier` → 302 到 `/quotagent/supplier/`；已提权会话下 `/quotagent/supplier/` 与 `/quotagent/supplier/api/events`…
- 面板是真数据：`/quotagent/admin/api/blocks` 至少报出 2 条阻塞，`kind` 分别含 `plugin-request`（`advisor`／Jev 建议层）与 `credential`（邮件收发缺 SMTP/IMAP 凭据），每条含 `block_id/kind/re…
- UI 内解阻塞：带 token 的 `POST /quotagent/admin/api/blocks/<id>/resolve`（凭据字段 + 可选上传件）→ 200 且**宿主侧账本零新增**，宿主只在 `tmp/ui-shared/admin-submissions/` 落一条待处理项（blo…
- 状态机与唯一写者（Python 侧）：`services/admin_blocks.py` 只接受 `blocked→pending→resolved / rejected / expired`；非法转移（`resolved→blocked`、`blocked→resolved` 跳过 `pendi…
- 粒度与无暗门：会话过期后 `/quotagent/admin/*` 回到统一拒绝体、切换失效，但**已 resolved 的阻塞与账本不受影响**；会话有效但写类提交不带 token → 401 且 inbox 零新增；把会话与时钟推过任意时长（含门内快进假时钟）→ 阻塞仍为 `blocked`、账…
- 失败不泄露 + 有界退避：缺 token / 错 token / 过期会话 / 管理道未启用（token 文件缺失）四类响应**逐字节相同**（401 固定体，无区分字段）；日志尾部搜不到正确 token；连续失败达 5 次进入冷却，冷却期内**正确 token 也拒绝**、冷却结束不自动提权、冷却…
- 反例（机检）：①无 token 调提权端点 → 拒绝且无会话 cookie；②以非 admin token 提权（合法长度错误内容、正确 token 的 sha256 前缀、正确 token 去末字符三种）→ 一律拒绝，响应体不含所提交 token、不含正确 token、不含任何「接近正确」的提示（…
- token 存储与校验（服务端）：token 只从 `QUOTAGENT_ADMIN_TOKEN` 或 0600 文件读（文件缺失 = 未启用，仍返回统一拒绝体）；校验先 `sha256(token)` 归一再用 `crypto.timingSafeEqual` 比较定长 32 字节摘要（不因长度或…
- 变异自证（D-057 纪律）：对 admin 道逐处偷改实现——①统一拒绝体改成分类错误 ②投影白名单改成透传 ③状态机转移放宽为任意 ④token 比较改前缀匹配——四处每一处都必须让对应门**真变红**并还原；变异脚本自带「锚点未命中或改了但字节没变 = 假变异即失败」的防伪检测
