# DeepSeek Harness 企业隐私分支

本仓库基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 MIT 许可源码，是独立维护的社区分支。受管 Desktop 面向由企业分发、配置和保护终端的试点环境。

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

`modelGateway` 必须是企业批准的 HTTPS Messages 兼容网关，不能是 `api.deepseek.com`；`workspaceMode` 只接受 `read-only` 或 `workspace-write`。`workspaceRoot` 必须是已存在的绝对目录，不能是文件系统根目录；Windows 部署时使用 Windows 绝对路径。策略缺失、损坏或字段不符时，Desktop 拒绝启动。macOS 还检查策略文件及其父目录均由 root 拥有，且组和其他用户不可写；Windows 部署程序必须为该目录和文件设置仅管理员可写的 ACL。本仓库当前不提供 Windows 策略 ACL 的运行时证明。

受管 Desktop 只接受随安装包交付的 `dsh-base` 和 `dsh-web-app` 组合，并要求 profile、home 和启动补丁为空。桌面端随附的 `dsh` 命令只允许启动受管 Desktop profile。管理员应将安装目录设为普通用户不可写，并使用企业签名和软件分发机制交付安装包；源码 CLI 的其他 profile 不属于受管模式。

## 已落实的应用内限制

- 内置 DeepSeek 模型请求在读取实时设置后仍使用管理员网关，不再回退到公网默认地址；其他模型适配器在受管组合中禁用。
- 关闭模型 Web 搜索与抓取、Shell 和 PowerShell 工具、持续终端、PTC、MCP、插件管理与配置编辑入口。受管标准预设不加载工具，其他预设停用。首版保留聊天能力；尚不开放受管文件编辑或命令执行。
- 文件沙箱模式上限和工作区根目录由策略决定。旧会话中记录的 `danger-full-access` 和显式高权限请求都会降到该上限；位于批准根目录外的会话工作区在模型请求时失败。受管模式不提供高权限预设入口。
- 会话日志请求字段、插件清单请求字段、OTel 会话遥测、桌面产品埋点保持关闭。打包 Desktop 不检查或下载上游自动更新。
- 此版不批准任何第三方插件。管理员选择额外 bundle、用户补丁或安装新插件后，受管启动会拒绝；未来版本可增加版本固定的批准清单。

## 部署侧必须完成

1. 将策略放在上述机器级路径，并保护策略和安装目录的写权限；Windows 还需验证 ACL。为员工分配独立系统账户、Harness home 与工作目录。
2. 将网关地址解析、TLS 证书和凭据接入企业网络。通过终端防火墙、代理或网络隔离，只允许应用及其子进程访问批准的网关和必要内网服务。应用内禁用工具不能限制 Electron 视图、外部浏览器或其他进程的所有出站连接。
3. 用非敏感样本核对请求目的地与请求体，再按企业保留期限处理会话、凭据和诊断文件。

本仓库没有提供多用户服务端隔离、SSO、集中审计、第三方插件审批清单或完整的 Windows ACL 和出站规则安装器。macOS 本地策略与组合测试已运行；Windows 的真实安装、ACL 与网络阻断仍需在 Windows 测试机验收。
