# 需求归属（userspace/demo-ns/badge）

| FR | 本插件怎么满足 |
|---|---|
| FR-PLUGIN-003（运行期生命周期） | 不在任何启动装配里；只能经运行期控制通道 load/reload/unload，卸载后其区块从页面消失 |
| FR-USERPLUG-001 | 用户空间插件的层纪律：自包含（`inject=[]`），不耦合进平台 |
| FR-USERPLUG-002 | 零写面：不写文件（`permissions.writes = []`）、不写账本 |
| FR-USERPLUG-006 | 服务只注册在自己命名空间 `demo-ns.badge.*` |

取证位置：`tools/verify.sh plugin-lifecycle` 的 L 段（原始行：装载/卸载前后的页面块对比 + 其余部分 sha256 一致）。
