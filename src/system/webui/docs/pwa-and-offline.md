# PWA：可安装 + 离线壳（**离线时如实说，不假装有数据**）

<!-- 预算：16 KB（`docs/design/12-documentation-standard.md` §1 的 `src/*/*/docs/*.md` 行）。
     口径真源：`docs/design/29-webui-gui-app.md` §3（机制在外壳）。策略原文在实现里：
     `code/assets/sw.js` 的文件头注释就是缓存策略本体；机读副本在 `/api/ui/surface` 的 `pwa` 段。
     读数与截图：`tmp/p19-shots/`（`verify-pwa.json` / `pwa-evidence.json` / `p19-pwa-0*.png`）。 -->

## 0. 一句话

> 界面要么值得**装成应用**（桌面/手机上一个图标、standalone 启动、没有地址栏），要么就别说它是应用。
> 而"装成本地应用"会立刻带来一个新问题：**离线时界面凭什么显示东西？** 这一批的答案是：
> **只缓存外壳（界面本身），一个字节的数据都不缓存**；离线时界面**明说**「离线：数据可能陈旧」，
> 面板与通知照旧走各自的「读不到 / 保留上次读数并标陈旧」，**绝不把一份旧 JSON 当新数据端上来**。

## 1. 可安装（机制，全部来自本服务）

| 件 | 落点 | 说明 |
|---|---|---|
| 清单 | `<prefix>/manifest.webmanifest` | `name` / `short_name` / **`display: standalone`**（`display_override: [standalone, minimal-ui]`）/ `theme_color` / 192+512 图标 / 3 条 `shortcuts`（工作台 · 承包商 · 供应商） |
| 图标 | `<prefix>/assets/icon-192.png`、`icon-512.png` | 由 `tmp/p19-shots/make-icons.py` 用**标准库**（zlib+struct）生成，同一组主题色；512 那条兼作 `maskable` |
| 离线壳 | `<prefix>/sw.js` | Service Worker。**落在前缀根**：它的作用域才正好是整个应用（`<prefix>/`） |
| 接入 | 外壳 HTML `<head>` | `<link rel="manifest">` + `theme-color` + `icon` + `apple-touch-icon` + `mobile-web-app-capable` |

两条刻意的设计：

- **清单里的 URL 一律相对**（`start_url: "./"`、`scope: "./"`、`icons: "./assets/…"`）⇒ 清单这一份文件
  在**任何路由前缀**（`/quotagent`、`/x/y/`）下都对，不需要按前缀渲染模板，也不会有人忘了改一处。
- **资源零外链**：清单、图标、离线壳、`app.js`/`app.css` 全部来自 `src/system/webui/code/assets/`。
  没有外网 CDN、没有构建步骤、没有框架（机检：外壳 HTML 与两个客户端资源里**无 `http(s)://` 外站字面量**、无内联脚本）。

**装机判据（机器可读，真跑读数见 `pwa-evidence.json`）**：Chrome 侧
`Page.getAppManifest()` ⇒ `display: standalone`、`errors: []`；
`Page.getInstallabilityErrors()` ⇒ **`[]`**（这一条为空是浏览器显示「安装」的判据）；
`navigator.serviceWorker.getRegistration()` ⇒ `scope = <prefix>/`、`state = activated`、
`controller` 已控制本页。

## 2. 离线壳的**缓存策略**（这一节就是口径；实现逐条对上）

| 请求 | 策略 | 为什么 |
|---|---|---|
| **非 GET**（动作/人签/登录/邮件配置…） | **完全不拦截**（直连网络） | 写请求**不排队、不重放**：离线时它们如实失败（界面按四态显示"失败"，不假装已提交） |
| 跨源 | 不处理 | 本应用不引外站；脚本/数据只来自本服务 |
| `/api/**`（面板/通知/对象/协作/名册/附件/状态） | **永不缓存** | 这是**数据**：旧 JSON 冒充新数据比"读不到"更坏 |
| `/identity/**` `/sign/**` `/inbox/**` `/mail/**` `/ops/**` `/admin/**` `/plugins/**` | **永不缓存** | 身份、人签、待办、运维/管理面 —— 装到设备上也不该把它们的响应留在缓存里 |
| 服务端渲染的旧页 `/<view>/**` | **永不缓存** | 它们可能含数据（同一理由） |
| `assets/app.js`、`app.css`、图标、清单 | stale-while-revalidate | 静态机制资源：离线也能把**壳**启动起来 |
| 导航（HTML）到**应用根**或**深链 `/app/**`** | network-first；离线 ⇒ 回退到**那一份不含数据的壳 HTML**，带 `x-q-offline: 1` + 给页面发 `{type:'q-offline'}` 消息 | 壳里只有路由前缀与视图名（没有账本/通知/对象数据）⇒ 离线能打开界面，界面**自己说**数据可能陈旧 |
| 导航到**其它**路径（`/ops/`、`/contractor/` …） | 离线**不回退**，直接失败 | 那些页可能含数据：**宁可打不开，也不留一份在设备上** |

缓存按版本命名（`quotagent-shell-v1`），`activate` 时删掉同族旧版本。真跑读数（浏览器里 `caches.keys()`）：

```
quotagent-shell-v1 → [ /quotagent/ , /quotagent/assets/app.css , /quotagent/assets/app.js ,
                       /quotagent/assets/icon-192.png , /quotagent/assets/icon-512.png ,
                       /quotagent/assets/manifest.webmanifest ]
```

—— 只有**六个外壳条目**，没有一条 `/api/**`、没有一条敏感页（`pwa-evidence.json` 的 `offline_probe` 同时证明：
离线时 `/api/ui/panels`、`/api/ui/notifications`、`/api/ui/object`、`/contractor/` 全部 `Failed to fetch`，
而 `assets/app.js` 仍 200（来自缓存））。

## 3. 离线时界面**怎么如实说**（这一条是验收的核心）

- **顶部横幅**：`离线：数据可能陈旧` + 原因（哪个请求没有回音）+ **上一次成功读到的时刻** + 失败次数
  + 一句实话：`离线壳只缓存外壳（界面本身），不缓存任何数据：面板/通知会如实显示"读不到"或保留上次读数并标陈旧。
  动作与人签需要网络（离线时不排队、不重放）。`
- **状态栏连接灯多出第四种样子**：`连接：离线：数据可能陈旧（上次成功读到 …）`，机器可读
  `data-offline="1"` / `data-offline-at` / `data-offline-last-good` / `data-offline-failures`
  —— 与「正常」「服务端忙」「有请求失败」**四种状态互不冒充**。
- **面板/对象页**：读不到就走 `error` 态（`data-state="error"`，带 code + 下一步），**不留空列表充数**；
  已经读到过的那一页保留并标陈旧（通知徽标同理：失败时**不清零**）。
- **只读自述**（给自动化与排障，不含任何机密）：`window.quotagentShell.offline()` / `.pwa()` / `.standalone()`。
- 状态栏另有两行读数：`离线壳 已装（scope …）`（`data-pwa="installed"`）与
  `以应用方式启动（standalone）` / `浏览器标签页`（`data-standalone`）——装没装上、以什么方式在跑，
  界面自己先说清。

## 4. 边界与已知限制（如实登记）

1. **本机无法完成"真实安装"这一步**：安装要**用户点浏览器安装气泡**（或系统菜单）；开发环境里只有
   `chrome-headless-shell`，没有应用窗口，因此**截不到"已安装应用的窗口"**。本批给出的是可安装性的
   **机读判据**（清单 + `installability_errors: []` + SW 已 activate 并控制本页）+ 界面自理 chrome 的证据
   （顶栏/标签页/重载/深链——standalone 下没有地址栏，导航只能靠外壳自己）。
2. `display-mode: standalone` 无法在 CDP 里仿真（`Emulation.setEmulatedMedia` 的 features 白名单里没有它），
   所以那一行的读数是"以浏览器标签页"；真装到设备上时它会变成「以应用方式启动（standalone）」。
3. **Service Worker 只在 https 或 localhost 可用**：非安全来源下注册会失败 —— 界面**如实报**一行横幅
   （「离线壳没有装上（界面照常可用）」+ 原因 + 「不影响任何动作与写路径」），不会静默。
4. **离线壳不给"离线可写"**：没有后台同步、没有请求队列（这是刻意的：排队重放写请求会让"我以为提交了"
   变成一次静默的重复提交）。
5. **缓存版本号是手写的**（`quotagent-shell-v1`）：换壳内容时改它，旧缓存自动清掉。没有引入构建哈希
   （本服务没有构建步骤）。

## 5. 复跑（真起服务 + 真浏览器）

```bash
python3 tmp/p19-shots/verify-pwa.py --base http://127.0.0.1:8471/quotagent   # 9/9（服务端一侧）
# 浏览器一侧（截图与读数的产生方式）：
#   ① 打开 <prefix>/app/home/ → 状态栏应写「离线壳 已装（scope …）」
#   ② CDP：Page.getAppManifest / Page.getInstallabilityErrors → 见 pwa-evidence.json
#   ③ CDP：Network.emulateNetworkConditions(offline=true) → 再点「重载」/导航一个深链
#      ⇒ 页面仍能打开（来自离线壳）+ 横幅「离线：数据可能陈旧」+ 面板 data-state="error"
#      ⇒ 同时证明 /api/** 与敏感页**没有**被缓存
#   ④ Network.emulateNetworkConditions(offline=false) 恢复
```

截图（`tmp/p19-shots/`）：`p19-pwa-01-installed.png`（工作台：邮件摘要面板 + 状态栏「离线壳 已装」）、
`p19-pwa-02-mobile-app-shell.png`（窄屏：顶栏自理导航 + 待办卡）、
`p19-pwa-03-offline-stale.png`（离线：横幅 + 连接灯 + 「这一页没读到（不是"没有数据"）」）。
