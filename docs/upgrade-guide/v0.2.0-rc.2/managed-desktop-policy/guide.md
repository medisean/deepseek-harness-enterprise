---
kind: upgrade-guide
description: "Managed Desktop requires machine policy, can require OIDC sign-in, and stores its data separately from CLI."
---

# Configure the managed Desktop policy

English | [中文](guide.zh.md)

## Change

Desktop previously accepted user-controlled profile patches, model endpoints, plugins, and permission modes. It now requires a valid machine policy, restricts the Desktop-bundled `dsh` command to the managed profile, and stores managed sessions in a dedicated Harness home under Electron `userData`. OIDC policy disables DeepSeek account login, API-key entry, and sign-in bypass.

## Migration

1. Provision `policy.json` at `/Library/Application Support/DeepSeek Harness Enterprise/policy.json` on macOS or `C:\ProgramData\DeepSeek Harness Enterprise\policy.json` on Windows. Set `version: 1`, an approved HTTPS `modelGateway`, `workspaceMode`, and an existing absolute `workspaceRoot`.
2. On Windows, build and silently deploy the signed per-machine installer with `pnpm run package:desktop:win:x64:enterprise`; installation requires an administrator and disables auto-updates. Remove any per-user install first. On macOS, deploy the signed, notarized app to `/Applications` through MDM.
3. Secure the policy with `sudo bash deploy/enterprise/secure-policy-macos.sh` on macOS or elevated `powershell -ExecutionPolicy Bypass -File .\deploy\enterprise\Secure-Policy.ps1` on Windows. Desktop rechecks permissions at startup; keep the install directory user-read-only.
4. Remove nonempty Desktop or Harness-home `cordis.patch.yml` files. Each additional `approvedBundles` entry needs an exact name, version, and lowercase SHA-256 digest. Generate it with `pnpm run enterprise:bundle-hash <package-directory> --root <desktop-node-modules-directory>`, where the root is the protected installation's `node_modules`; include bundles in policy order before signing. Desktop checks composition, version, digest, and path before mounting. The digest records symlink destinations inside the installation and rejects escaping links, but does not hash link targets or external dependencies. Sign the installer and keep its directory administrator-writable only. For API-key gateway auth, use the existing credential store.
5. For SSO, configure HTTPS `issuer`, public `clientId`, absolute `audience`, `gatewayScope`, and unique `scopes` containing `openid` and that scope. Match `gatewayScope` to `OIDC_REQUIRED_SCOPE`. Register a public native client with `127.0.0.1` loopback redirects and PKCE S256; configure the gateway to enforce the access token's audience and scope. SAML-only IdPs need an OIDC broker.
6. Confirm Desktop opens chat and calls the approved gateway. With your IdP and gateway, test OIDC login, refresh, logout, and rejection of invalid or expired tokens. Invalid policy blocks startup. Apply firewall or proxy rules to Desktop, its child processes, and the external browser before handling sensitive data.
7. Managed Desktop no longer reads or writes the ordinary CLI `DSH_HOME`. Existing sessions and attachments remain in the old home and are not copied. Back up records that must be retained, then apply the organization’s approved migration and retention process to Electron `userData`.
