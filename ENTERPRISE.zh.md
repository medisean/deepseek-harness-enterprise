# DeepSeek Harness 企业部署

本仓库基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 MIT 许可源码，是独立维护的社区分支。受管 Desktop 面向由企业分发、配置和保护终端的试点环境；它是单机桌面应用，不是多租户服务端。

## 管理员策略

受管 Desktop 启动前必须读取机器级 `policy.json`。macOS 路径为 `/Library/Application Support/DeepSeek Harness Enterprise/policy.json`；Windows 路径为 `C:\ProgramData\DeepSeek Harness Enterprise\policy.json`。文件内容示例：

```json
{
  "version": 1,
  "modelGateway": "https://gateway.example.com/anthropic",
  "workspaceMode": "read-only",
  "workspaceRoot": "/Users/Shared/EnterpriseWorkspaces",
  "oidc": {
    "issuer": "https://id.example.com/realms/engineering",
    "clientId": "deepseek-harness-desktop",
    "gatewayScope": "model:run",
    "scopes": ["openid", "profile", "offline_access", "model:run"],
    "audience": "https://gateway.example.com/"
  }
}
```

`modelGateway` 必须是企业批准的 HTTPS Messages 兼容网关，不能是 `api.deepseek.com`；`workspaceMode` 只接受 `read-only` 或 `workspace-write`。`workspaceRoot` 必须是已存在的绝对目录，不能是文件系统根目录；Windows 部署时使用 Windows 绝对路径。策略缺失、损坏或字段不符时，Desktop 拒绝启动。macOS 检查策略文件及其父目录均由 root 拥有，且组和其他用户不可写；Windows 检查策略文件和目录的所有者及写入 ACL，写权限只允许 Administrators 或 SYSTEM。

受管 Desktop 默认只接受随安装包交付的 `dsh-base` 和 `dsh-web-app` 组合，并要求 profile、home 和启动补丁为空。需要额外插件时，管理员可在机器策略的 `approvedBundles` 中列出包名、精确版本和目录 SHA-256；这些 bundle 必须预先放入企业构建的 Desktop 安装目录，并按策略顺序加入 Desktop profile。应用会在加载插件前核对包身份、目录摘要和安装位置。管理员应将安装目录设为普通用户不可写，并使用企业签名和软件分发机制交付安装包。摘要覆盖 bundle 目录结构和文件内容，并记录符号链接在受保护安装目录内解析到的位置；拒绝指向该目录外的链接，但不计算链接目标或包目录外依赖的内容摘要。应用仍不单独校验每个插件的发布者签名。源码 CLI 的其他 profile 不属于受管模式。

## 已落实的应用内限制

- 内置 DeepSeek 模型请求在读取实时设置后仍使用管理员网关，不再回退到公网默认地址；其他模型适配器在受管组合中禁用。
- 关闭模型 Web 搜索与抓取、Shell 和 PowerShell 工具、持续终端、PTC、MCP、插件管理与配置编辑入口。受管标准预设不加载工具，其他预设停用。首版保留聊天能力；尚不开放受管文件编辑或命令执行。
- 文件沙箱模式上限和工作区根目录由策略决定。旧会话中记录的 `danger-full-access` 和显式高权限请求都会降到该上限；位于批准根目录外的会话工作区在模型请求时失败。受管模式不提供高权限预设入口。
- 会话日志请求字段、插件清单请求字段、OTel 会话遥测、桌面产品埋点保持关闭。打包 Desktop 不检查或下载上游自动更新。
- 可选的 `approvedBundles` 按包名、精确 semver 版本和目录 SHA-256 批准额外 bundle。管理员可在仓库根目录运行 `pnpm run enterprise:bundle-hash <package-directory> --root <desktop-node-modules-directory>` 生成摘要；`--root` 指向放置该 bundle 的受保护安装 `node_modules` 根目录。应用在加载插件前拒绝摘要、版本、bundle 顺序或安装路径不符的情况。摘要保护 bundle 目录内容及链接目标位置，不代替安装包签名、安装目录 ACL 或依赖供应链验证。
- 配置 `oidc` 后，欢迎页只提供企业 SSO。客户端使用系统默认浏览器执行 OIDC Authorization Code + PKCE，回调只监听本机 loopback；模型凭据只由 Electron 主进程按需经私有 IPC 提供给 Host。令牌使用 Electron `safeStorage` 加密后保存在当前操作系统用户的数据目录，不进入策略、环境变量或 renderer；此模式禁用 DeepSeek 账户登录、API key 和免登录入口。
- 企业 SSO 菜单注销前会锁定 Host 请求并检查活动任务；有活动任务时要求先结束任务。注销会清除本地令牌并尽力调用 IdP 撤销端点。IdP 不在线或不支持撤销时，本地会话仍会清除。
- 无 `oidc` 字段时，现有受管网关 API key 路径保持可用；这不构成 SSO。
- 受管 Desktop 将 `DSH_HOME` 固定到 Electron `userData` 下独立的 `enterprise-harness-home`。macOS 和 Linux 将目录权限设为仅当前用户可访问；Windows 验证 `userData` 与专属 home 的 ACL 只允许当前用户、Administrators 和 SYSTEM。企业 Desktop 的会话、设置、附件和凭据文件不再与普通 CLI 或普通 Desktop 共用 Harness home；同一操作系统账户下的其他用户仍由操作系统权限隔离。

## 企业管理员上线步骤

1. 从本仓库固定的提交构建 Desktop 安装包，使用企业证书签名，并通过企业软件分发平台推送。Windows 设备级部署使用 `pnpm run package:desktop:win:x64:enterprise` 生成 per-machine 包；该命令要求 Windows x64 和签名配置，安装时需要管理员权限。macOS 使用 MDM 将签名、公证的应用复制到 `/Applications`。打包配置、签名和产物验证命令见 [Desktop packaging guide](apps/desktop/README.md)。
2. 为每位员工配置独立的受管终端账户和工作区。受管 Desktop 在 Electron `userData/enterprise-harness-home` 中创建独立数据目录，不读取普通 CLI 的 Harness home。使用 MDM 启用 FileVault 或 BitLocker，并按企业保留期限清理 Electron `userData` 中的令牌、会话和附件；Desktop 不提供应用级文件加密或自动清理。网关不保存会话数据。多人共用一个操作系统账户不属于受支持的安全部署。
3. 在策略文件中设置企业网关、工作区模式和绝对工作区路径。创建策略文件后，macOS 管理员运行 `sudo bash deploy/enterprise/secure-policy-macos.sh`；Windows 管理员运行 `powershell -ExecutionPolicy Bypass -File .\deploy\enterprise\Secure-Policy.ps1`。应用启动时会再次验证策略字段和平台权限。
4. 需要 SSO 时，在 `oidc` 中配置 HTTPS issuer、公开 client ID、网关 audience 绝对 URI、`gatewayScope` 和包含 `openid` 及该 gateway scope 的 scope 列表。`gatewayScope` 必须与网关 `OIDC_REQUIRED_SCOPE` 完全一致。客户端会把 audience 作为 OAuth resource 请求参数发送，并请求配置的 scope。将桌面应用注册为 public native client，允许 `http://127.0.0.1:{port}/{random-path}` loopback 回调，并为 PKCE 启用 S256。客户端使用 Authorization Code 流；SAML-only IdP 应先由企业身份代理提供 OIDC。
5. 可使用本仓库提供的 OIDC 企业模型网关作为起点：按 [网关部署说明](deploy/enterprise/gateway/README.zh.md) 配置 IdP issuer/JWKS/audience、scope、全局模型允许列表、租户模型及 token 上限、并发策略、明确批准的 HTTPS 上游和服务端 API key。网关没有公共模型服务默认上游；只有企业批准其数据处理方式后，才配置 DeepSeek 官方 API。请求和响应内容会转发到所配置的上游。配置共享 Redis 后，网关按已验证的 subject 和租户跨副本原子限制并发；Redis 不可用时请求失败关闭。网关生成不含模型内容或令牌的结构化审计事件。生产部署仍需企业配置 TLS 入口、日志留存与访问控制、告警、网络策略，以及高可用网关和 Redis。若不启用 `oidc`，现有凭据流程仍可使用其他兼容网关。
6. 通过终端防火墙、代理或网络隔离，只允许应用及其子进程访问批准的网关、IdP 和必要内网服务。应用内禁用工具不能限制 Electron 视图、外部浏览器或其他进程的所有出站连接。
7. 用非敏感样本核对登录、续期、注销、拒绝过期/错误受众令牌、请求目的地与请求体。确认 MDM 对用户目录、会话记录、附件和诊断文件执行企业保留期限。不要把个人 DeepSeek API key 写入共享机器策略文件。

## 当前不提供的企业能力

- **集中审计：网关已提供最小事件。** 企业模型网关验证 Bearer token 后记录主体、可选租户、UTC 时间、请求关联 ID、模型、结果状态、耗时、上游用量和授权决策；不会写入 token、提示词、附件或模型回答。stdout 事件需由企业日志平台采集，并配置访问控制、保留期限、防篡改和告警。客户端本地会话日志不能替代集中审计。
- **租户数据隔离：仅限单机账户边界。** 网关按管理员提供的租户策略拒绝未知租户、限制每租户模型、单次 token 上限和共享 Redis 并发配额。网关不保存用户数据，也不提供租户存储或租户级审计查询。受管 Desktop 使用独立 Harness home；企业仍需为不同员工配置不同操作系统账户。
- **本地会话保护：依赖终端管理。** 受管 Desktop 将会话和附件保存在专用 Harness home，但不提供应用级文件加密或自动保留期清理。管理员需启用 FileVault 或 BitLocker，并通过 MDM 设置对 Electron `userData` 的清理规则；OIDC 令牌使用操作系统安全存储加密。
- **集中策略下发：没有。** Desktop 从受保护的机器级 `policy.json` 读取设置并验证文件 ACL；通过 MDM 或现有终端管理平台创建、轮换和回滚策略。仓库不提供远程配置服务或策略签名/分发控制面。
- **插件发布者签名校验：没有。** 机器策略要求每个额外 bundle 提供精确版本和 SHA-256 摘要，Desktop 会核对 bundle 目录中的文件、目录和符号链接解析位置，并拒绝越出受保护安装目录的链接。摘要不覆盖链接目标内容或包目录外的依赖，也不识别发布者身份；企业仍需签名整个安装包并保护其目录。
- **出站规则安装器：没有。** 管理员需通过现有终端管理、防火墙、代理或网络隔离产品配置目的地址规则；不要把应用内工具禁用当作网络出口控制。

## 推进顺序与验收

| 阶段 | 交付内容 | 验收条件 |
|---|---|---|
| 试点部署 | 签名安装包、机器策略、独立用户账户、网关和出站网络规则 | macOS 与 Windows 新装均拒绝缺失或 ACL 不安全的策略；普通用户不能修改策略；抓包只观察到批准的应用网络目的地 |
| 企业 SSO | OIDC 登录、受保护的令牌存储、网关 bearer 验证 | 已实现通用 OIDC 客户端；每家企业仍须验证 IdP 回调登记、网关 bearer 校验、续期/撤销和网络规则。未认证和过期令牌被网关拒绝；令牌不进入渲染进程、日志、命令行或子进程环境 |
| 审计与治理 | 网关最小审计事件、租户访问策略、精确版本的插件批准清单、集中策略下发 | 网关记录主体、请求 ID、模型、结果和用量，按租户限制模型、单次生成 token 和并发请求；事件不含令牌或模型内容。企业仍需配置受控日志留存、告警与防篡改；策略由 MDM 下发；受管桌面拒绝未批准、错版本或安装目录外的插件和无效策略 |

启用 SSO 部署前必须取得企业 IdP 与网关的 OIDC 参数和令牌校验约定，并完成该企业环境的端到端验收；通用客户端实现本身不能替代 IdP 和网关侧配置。
