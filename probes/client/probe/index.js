/**
 * client-ui 探针的宿主半边：只提供 Loader 入口，让客户端 bundle 被 /plugins 服务。
 * 真实插件（index.js）由 Lead 提供，这里不实现任何业务。
 */

/** 插件显示名（Loader 入口来自 cordis.patch.yml 的 insert 行）。 */
export const name = 'dsh-mailbox-probe';

/** 无宿主服务依赖。 */
export const inject = [];

/** 宿主半边空实现。 */
export function apply() {}
