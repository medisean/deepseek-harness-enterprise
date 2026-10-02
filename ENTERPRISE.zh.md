# DeepSeek Harness 企业隐私分支：v0.1

本仓库基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 MIT 许可源码，是独立维护的社区分支。它面向企业试点，提供更保守的数据上送默认值；它尚未提供企业身份认证、集中策略强制执行或经过审计的安全隔离。

## 首版包含什么

| 配置项 | 本分支默认值 | 范围 |
| --- | --- | --- |
| `session-log-deepseek.enabled` | `false` | base 组合及独立的 `sdk-minimal` 组合；停止向 DeepSeek 协议请求附加 `dsh_session_log` |
| `plugin-package-inventory-deepseek.enabled` | `false` | 同上；停止附加 `dsh_plugin_packages` |
| `session-telemetry-otel.mode` | `DISABLED` | base 组合；停止 OTel 会话上送 |
| `product-analytics.enabled` | `false` | Desktop 组合；默认不采集新的产品埋点 |

这些是随发行版交付的**默认配置**。用户的 profile 和 home patch 可覆盖它们；`product-analytics` 也可以通过实时设置重新开启。企业需要强制策略时，必须增加独立的只读策略层和防篡改机制。

## 部署试点

1. 在受控设备上从本仓库的固定提交构建，保留上游 MIT 许可和第三方许可声明。官方已签名安装包不包含本分支的改动，不能直接当作本分支发行版。
2. 为每位员工分配独立的操作系统账户、Harness home 和工作目录。按最小权限运行，不把共享密钥放入仓库或安装包。
3. 在「设置 → 模型 → 添加模型提供商 → 自定义模型 API」中配置企业模型网关的 URL、实际 API 协议、模型 ID 和个人凭证。内置 DeepSeek 适配器也可通过受信任的 `DEEPSEEK_BASE_URL` 指向兼容的 Messages 网关。配置完成后检查一次真实请求；仅填写内网 URL 不会限制其他提供商或插件的联网行为。
4. 在设备防火墙或企业代理上限定客户端和其子进程的出站目标，至少覆盖模型、账户登录、更新、插件安装、Web 工具和遥测路径。若要求完全离线，还要提供本地模型服务并关闭不需要的联网功能。
5. 用非敏感样本检查请求目的地和请求体，确认模型内容与附件只进入批准的网关；检查会话文件、凭据文件和诊断日志的访问权限与保留期限。

开发机可先运行 Web 组合核对这些默认值：

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm dsh web --no-open
```

源码构建要求 Node.js `^22.19.0` 或 `>=24.0.0`，以及仓库固定的 pnpm 版本。Desktop 打包、签名、公证和更新源配置见 [上游 Desktop 构建说明](apps/desktop/README.zh.md)。Windows 有未签名安装包命令可供本地验证；面向员工分发仍需企业自己的签名凭证和更新基础设施。

## 首版的安全边界

- 默认模型路由仍可能指向公网 DeepSeek API；自定义提供商也可以指向公网。模型出站限制必须由企业网络策略落实。
- 工具和插件能使用操作系统授予进程的文件、命令与网络能力。Harness 的审批和沙箱不能替代独立容器、虚拟机或终端防护。`sdk-minimal` 的 Shell 当前仍使用 `danger-full-access`。
- 当前没有企业 SSO、统一审计、插件白名单强制执行、设备策略锁定和多用户服务端隔离。此版本适合隔离试点，不应作为已认证的企业生产安全产品宣传。
- 上游仍在开发者预览阶段，升级可能改变配置项或数据流。每次合并上游版本后要重新审核此表和实际网络请求。

下一阶段优先实现管理员策略的强制加载、模型与插件出站白名单、企业身份和凭证接入，再建设独立签名及更新流程。
