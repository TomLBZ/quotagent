# 交接

<!-- budget: 1024 bytes, hard -->

## 现在在哪

P2 中。①–④见 EV-160…167（T-288/313/314/315/316）。⑤ **本批**（EV-168/T-317）：**运行中的服务真能装卸**（`tools/plugin.sh … --live`／`./run plugin …`：真挂进 webui 自身 ctx，区块真上页面、卸载后其余逐字节不变；四道围栅；零写面）+ `user-space`→`src/userspace` 收敛为唯一源（兼容符号链接）+ `./run logs|config init`；门 `plugin-lifecycle` 59/59、`run-once` 34/34（8 处变异全红）、`user-space` 21/21。

## 下一步唯一动作

`docs/work/plans/plugin-migration-plan.md` §2 续做**阶段 2**（services → `code/`，逐个搬 + 跑 AC）；建插件目录时同步 `plugin-lifecycle` 的 A13/A14。

## 不变量与阻塞

内核不可自改 · 账本唯一写者 · 账本行永不销毁 · commit 面不进桥 · 私域不出 realm · V 只能人签 · **门名是接口**。
待人手：T-224 的 Jev key；G0/G1 签署。无技术阻塞。
