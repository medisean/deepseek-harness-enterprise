---
kind: upgrade-guide
description: "受管 Desktop 现在可通过机器策略强制企业 OIDC 登录。"
---

# 配置受管 Desktop 策略

[English](guide.md) | 中文

## 变更

此前 Desktop 可使用用户可修改的 profile 补丁、模型地址、插件和权限模式。现在它缺少有效机器策略时拒绝启动，并将这些设置限制为受管组合。Desktop 随附的 `dsh` 命令也不再管理插件或启动其他 profile。策略还可强制企业 OIDC 登录；启用后会关闭 DeepSeek 账户登录、API key 输入和跳过登录入口。

## 迁移

1. 在 macOS 的 `/Library/Application Support/DeepSeek Harness Enterprise/policy.json` 或 Windows 的 `C:\ProgramData\DeepSeek Harness Enterprise\policy.json` 放置 `policy.json`。将 `version` 设为 `1`，`modelGateway` 设为经批准的 HTTPS Messages 网关，`workspaceMode` 设为 `read-only` 或 `workspace-write`，`workspaceRoot` 设为包含批准工作区的现有绝对目录。
2. Windows 使用 `pnpm run package:desktop:win:x64:enterprise` 构建签名的机器级安装包，再由企业软件分发平台静默安装；安装需要管理员权限，更新版本由 IT 下发。同一 Windows 账户从 per-user 版本切换前需要先卸载。macOS 则通过 MDM 将签名、公证的应用部署到 `/Applications`。
3. 放置策略后，在 macOS 上运行 `sudo bash deploy/enterprise/secure-policy-macos.sh`；在 Windows 的管理员 PowerShell 会话中运行 `powershell -ExecutionPolicy Bypass -File .\deploy\enterprise\Secure-Policy.ps1`。应用启动时还会再次检查策略权限。安装目录也应禁止普通用户写入。
4. 删除 Desktop profile 或 Harness home 下非空的 `cordis.patch.yml`。默认情况下删除自定义 Desktop bundle。要批准额外 bundle，在机器策略的 `approvedBundles` 数组中填写每个包的精确名称和 semver 版本，再按相同顺序将这些包加入企业 Desktop 安装目录，然后签名并分发安装包。应用会检查 profile 清单、安装包版本，并确认批准包解析自 Desktop 安装目录。该目录应仅允许管理员写入；应用不会单独验证每个包的发布者签名。使用 API key 网关认证时，通过现有凭据存储配置凭据。
5. 要求企业 SSO 时，添加 `oidc` 对象，配置 HTTPS `issuer`、公开 `clientId`、模型网关绝对 URI `audience`、`gatewayScope`，以及同时包含 `openid` 和 `gatewayScope` 的唯一 `scopes`。`gatewayScope` 必须与网关的 `OIDC_REQUIRED_SCOPE` 相同；客户端会请求所有配置的 scope，并把 audience 作为 OAuth resource 参数发送。将应用注册为 public native client，启用 `127.0.0.1` loopback 回调和 PKCE S256。配置网关接受 bearer access token 并校验受众和 scope。仅支持 SAML 的 IdP 需要通过 OIDC 身份代理接入。
6. 启动 Desktop，确认进入聊天界面且请求发往批准的网关。启用 OIDC 时，使用企业 IdP 和网关验证浏览器登录、令牌续期、本地注销以及网关拒绝无效或过期令牌。机器策略缺失或无效时会出现 `enterprise policy` 启动错误。处理敏感数据前，使用企业防火墙或代理限制应用、子进程和外部浏览器的出站连接。
