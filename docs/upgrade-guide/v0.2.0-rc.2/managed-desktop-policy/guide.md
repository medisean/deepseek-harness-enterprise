---
kind: upgrade-guide
description: "Managed Desktop can now require enterprise OIDC sign-in through its machine policy."
---

# Configure the managed Desktop policy

English | [中文](guide.zh.md)

## Change

Desktop previously opened with user-controlled profile patches, model endpoints, plugins, and permission modes. It now refuses to start without a valid machine policy and restricts these settings to the managed composition. The Desktop-bundled `dsh` command no longer manages plugins or launches other profiles. A policy can also require enterprise OIDC sign-in; this disables DeepSeek account sign-in, API-key entry, and the skip path.

## Migration

1. Provision `policy.json` at `/Library/Application Support/DeepSeek Harness Enterprise/policy.json` on macOS or `C:\ProgramData\DeepSeek Harness Enterprise\policy.json` on Windows. Set `version` to `1`, `modelGateway` to an approved HTTPS Messages gateway, `workspaceMode` to `read-only` or `workspace-write`, and `workspaceRoot` to an existing absolute directory containing approved workspaces.
2. On Windows, build the signed machine-wide installer with `pnpm run package:desktop:win:x64:enterprise` and deploy it silently through the enterprise software manager. It requires administrator privileges and disables automatic updates so IT controls rollout. Remove a per-user installation before switching the same Windows account to this build. On macOS, deploy the signed and notarized app to `/Applications` through MDM.
3. On macOS, run `sudo bash deploy/enterprise/secure-policy-macos.sh` after placing the policy. On Windows, run `powershell -ExecutionPolicy Bypass -File .\deploy\enterprise\Secure-Policy.ps1` from an elevated Administrator session. The application checks the policy permissions again at startup. Keep the installation directory user-read-only.
4. Remove nonempty Desktop or Harness-home `cordis.patch.yml` files. By default, remove custom Desktop bundles. To approve additional bundles, add an `approvedBundles` array to the machine policy with each package's exact name and semantic version, then include those exact packages in that order in the enterprise Desktop installation before signing and distributing it. The application checks the profile list, installed package version, and that each approved package resolves inside the Desktop installation. Keep that directory writable only by administrators; the app does not verify each package's publisher signature independently. For API-key gateway authentication, configure credentials through the existing credential store.
5. To require enterprise SSO, add an `oidc` object with HTTPS `issuer`, public `clientId`, absolute-URI `audience`, `gatewayScope`, and unique `scopes` containing both `openid` and `gatewayScope`. Set `gatewayScope` to the gateway's `OIDC_REQUIRED_SCOPE`; the client requests every configured scope and sends the audience as the OAuth resource parameter. Register the application as a public native client with loopback redirects on `127.0.0.1` and PKCE S256. Configure the gateway to accept the resulting bearer access token and enforce its audience and scope. SAML-only identity providers need an OIDC broker.
6. Start Desktop and confirm that it reaches the chat view and requests the approved gateway. For OIDC, verify browser sign-in, token refresh, local sign-out, and rejection of invalid or expired gateway tokens with your IdP and gateway. A missing or invalid machine policy produces an `enterprise policy` startup error. Apply enterprise firewall or proxy rules to the application, its child processes, and the external browser before handling sensitive data.
