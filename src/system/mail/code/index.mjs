/**
 * 进树插件入口：`src/system/mail/`（本批 `EV-181` 接上 `entry`）。
 *
 * 做什么：把**已在本目录 `code/` 的实体** `mail-view.mjs` 的公开面**重导出**，并把它自述的
 * `inject`/`provides`/`usedServices`/`Config` 原样透给宿主。**不新造功能**：本文件没有一行业务语义、
 * 没有任何写面、也没有第二份实现 —— 邮件域的对外服务键是实体自述的 `mailView`（只读运维视图）；
 * 真收发（SMTP/IMAP）在 Python 侧 `code/mail.py`·`mail_transport.py`，宿主**不**经本入口装载它们
 * （`entryKind` 口径与 `system/approval` 同形：有 ESM 实体时，入口 = 那个 ESM 实体）。
 *
 * 决策与**被否决的选项**见 `docs/work/decisions.md` 的 D-082。
 */
import * as impl from './mail-view.mjs'

export * from './mail-view.mjs'

export const name = 'mail'
export const inject = impl.inject
export const provides = impl.provides
export const usedServices = impl.usedServices
export const Config = impl.Config

/** 装载：把实体的 `apply` 原样转给宿主（本包装不加任何东西）。 */
export function apply(ctx, config) {
  return impl.apply(ctx, config)
}
