# DeepSeek Harness 企业部署

本仓库基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 MIT 许可源码，是独立维护的社区分支。受管 Desktop 面向由企业分发、配置和保护终端的试点环境；它是单机桌面应用，不是多租户服务端。

## 管理员策略

受管 Desktop 启动前必须读取机器级 `policy.json`。macOS 路径为 `/Library/Application Support/DeepSeek Harness Enterprise/policy.json`；Windows 路径为 `C:\ProgramData\DeepSeek Harness Enterprise\policy.json`。文件内容示例：

```json
{
  "version": 1,
  "modelGateway": "https://gateway.example.com/anthropic",
  "workspaceMode": "read-only",
  "workspaceRoot": "/Users/Shared/EnterpriseWorkspaces"
}
```

`modelGateway` 必须是企业批准的 HTTPS Messages 兼容网关，不能是 `api.deepseek.com`；`workspaceMode` 只接受 `read-only` 或 `workspace-write`。`workspaceRoot` 必须是已存在的绝对目录，不能是文件系统根目录；Windows 部署时使用 Windows 绝对路径。策略缺失、损坏或字段不符时，Desktop 拒绝启动。macOS 检查策略文件及其父目录均由 root 拥有，且组和其他用户不可写；Windows 检查策略文件和目录的所有者及写入 ACL，写权限只允许 Administrators 或 SYSTEM。

受管 Desktop 只接受随安装包交付的 `dsh-base` 和 `dsh-web-app` 组合，并要求 profile、home 和启动补丁为空。桌面端随附的 `dsh` 命令只允许启动受管 Desktop profile。管理员应将安装目录设为普通用户不可写，并使用企业签名和软件分发机制交付安装包；源码 CLI 的其他 profile 不属于受管模式。

## 已落实的应用内限制

- 内置 DeepSeek 模型请求在读取实时设置后仍使用管理员网关，不再回退到公网默认地址；其他模型适配器在受管组合中禁用。
- 关闭模型 Web 搜索与抓取、Shell 和 PowerShell 工具、持续终端、PTC、MCP、插件管理与配置编辑入口。受管标准预设不加载工具，其他预设停用。首版保留聊天能力；尚不开放受管文件编辑或命令执行。
- 文件沙箱模式上限和工作区根目录由策略决定。旧会话中记录的 `danger-full-access` 和显式高权限请求都会降到该上限；位于批准根目录外的会话工作区在模型请求时失败。受管模式不提供高权限预设入口。
- 会话日志请求字段、插件清单请求字段、OTel 会话遥测、桌面产品埋点保持关闭。打包 Desktop 不检查或下载上游自动更新。
- 此版不批准任何第三方插件。管理员选择额外 bundle、用户补丁或安装新插件后，受管启动会拒绝；未来版本可增加版本固定的批准清单。

## 企业管理员上线步骤

1. 从本仓库固定的提交构建 Desktop 安装包，使用企业证书签名，并通过企业软件分发平台推送。macOS 对外分发还需签名和公证；Windows 发布包需使用组织认可的代码签名证书。打包配置、签名和产物验证命令见 [Desktop packaging guide](apps/desktop/README.md)。
2. 为每位员工配置独立的受管终端账户、Harness home 和工作区。受管版本暂不提供服务端租户隔离；多人共用一个操作系统账户不属于受支持的安全部署。
3. 在策略文件中设置企业网关、工作区模式和绝对工作区路径。创建策略文件后，macOS 管理员运行 `sudo bash deploy/enterprise/secure-policy-macos.sh`；Windows 管理员运行 `powershell -ExecutionPolicy Bypass -File .\deploy\enterprise\Secure-Policy.ps1`。应用启动时会再次验证策略字段和平台权限。
4. 配置网关地址解析、TLS 信任链和网关凭据。网关应在服务端执行用户身份、模型授权、请求限额和审计；当前应用只锁定请求目的地，不实现企业身份认证或集中审计。
5. 通过终端防火墙、代理或网络隔离，只允许应用及其子进程访问批准的网关和必要内网服务。应用内禁用工具不能限制 Electron 视图、外部浏览器或其他进程的所有出站连接。
6. 用非敏感样本核对请求目的地与请求体，并按企业保留期限处理会话、凭据和诊断文件。不要把个人 DeepSeek API key 写入共享机器策略文件。

## 当前不提供的企业能力

- **SSO：没有。** 当前欢迎页的 DeepSeek Platform 登录是 DeepSeek 账户登录，不是企业 SSO；受管客户端也没有 OIDC 或 SAML 身份流。不能通过改文案或复用该登录流程满足企业身份认证。
- **SSO 接入需要网关配合。** 推荐的首个实现是 OIDC Authorization Code + PKCE：企业提供 issuer、client ID、scope 和回调登记；网关明确 bearer token 的受众、授权规则、续期与注销行为，并在模型 API 上验证令牌。若企业只有 SAML，可由企业 IdP 或身份代理向客户端提供 OIDC。访问令牌和续期令牌必须使用操作系统安全存储，不能写入普通策略文件或环境变量。
- **集中审计与多用户隔离：没有。** 由网关或企业服务端记录经过授权的身份、请求时间、模型、用量和结果策略；客户端本地会话日志不能作为集中审计系统。
- **第三方插件审批清单：没有。** 受管组合当前拒绝额外 bundle、用户补丁和新插件。需要插件时，需设计按版本和签名校验的管理员批准清单，并明确升级、撤销和离线策略。
- **出站规则安装器：没有。** 管理员需通过现有终端管理、防火墙、代理或网络隔离产品配置目的地址规则；不要把应用内工具禁用当作网络出口控制。

## 推进顺序与验收

| 阶段 | 交付内容 | 验收条件 |
|---|---|---|
| 试点部署 | 签名安装包、机器策略、独立用户账户、网关和出站网络规则 | macOS 与 Windows 新装均拒绝缺失或 ACL 不安全的策略；普通用户不能修改策略；抓包只观察到批准的应用网络目的地 |
| 企业 SSO | OIDC 登录、受保护的令牌存储、网关 bearer 验证 | 未认证和过期令牌被网关拒绝；注销、撤权和续期结果符合企业策略；令牌不进入渲染进程、日志、命令行或子进程环境 |
| 审计与治理 | 服务端审计、版本固定的插件批准清单、集中策略分发 | 审计字段和保留期通过企业审查；未批准插件、降级版本和无效策略均被拒绝 |

SSO 实现前必须取得 IdP 与网关的 OIDC 参数和令牌校验约定；缺少这些信息时只能交付当前 API key 网关模式，不能声称企业 SSO 已就绪。
