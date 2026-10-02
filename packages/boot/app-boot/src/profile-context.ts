/** Launcher-owned profile locations and composition inputs. */
import { join } from 'node:path'
import { composeEntries, loadProfileDirectory, PROFILE_PATCH_FILENAME, type Profile } from './profile.ts'
import { loadOptionalPatches } from './index.ts'
import type { EnterprisePolicy } from './enterprise-policy.ts'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** Application-owned package manager executable; environment applies only to package operations. */
export interface ProfilePnpmInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** Current profile facts; scheduling and mutation belong to their callers. */
export interface ProfileContext {
  readonly name: string
  /** Packaged applications supply their bundled runtime instead of a PATH executable. */
  readonly packageManager?: ProfilePnpmInvocation
  readonly dir: string
  readonly patchPath: string
  readonly installAnchor: string
  readonly cwd: string
  readonly home: string
  /** Bundle packages used to start this process, before any persisted edits. */
  readonly startedBundles: readonly string[]
  /** Parsed command-line overlays, applied above profile and home patches. */
  readonly overlays: readonly PatchOptions[]
  /** Launch-time DSH_TELEMETRY_DISABLED value; any non-empty value opts out. */
  readonly telemetryDisabledEnv: string | undefined
  /** Present only for the machine-managed Desktop launch. */
  readonly enterprisePolicy?: EnterprisePolicy
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only in a profile launched by dsh. */
    profileContext: ProfileContext
  }
}

const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/** Read current bundle and user layers with the launch-time overlays.
 * @param binName Diagnostic prefix for malformed or missing configuration.
 * @param context Data supplied by the profile launcher.
 * @param initialProfile Already loaded startup profile; omitted reads the current files.
 * @returns Detached ordered patches; this function does not update the Loader.
 */
export function readProfilePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  const profile = initialProfile ?? loadProfileDirectory(binName, context.dir, context.installAnchor, { userLayer: false })
  const own = initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? []
  const home = loadOptionalPatches(binName, join(context.home, PROFILE_PATCH_FILENAME)) ?? []
  if (context.enterprisePolicy !== undefined) {
    const bundles = profile.layers.map(layer => layer.packageName)
    if (context.name !== 'desktop' || bundles.join(',') !== '@deepseek-ai/dsh-base,@deepseek-ai/dsh-web-app'
      || profile.skippedBundles.length !== 0 || own.length !== 0 || home.length !== 0 || context.overlays.length !== 0) {
      throw new Error('enterprise policy: Desktop requires shipped bundles and empty profile, home and launch patches')
    }
  }
  const patches = structuredClone([
    ...profile.layers.flatMap(layer => layer.patches),
    ...own,
    ...home,
    ...context.overlays,
  ])
  const telemetryPatch = resolveTelemetryPatch(context.telemetryDisabledEnv,
    composeEntries([patches]).some(row => row.id === TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) patches.push(telemetryPatch)
  if (context.enterprisePolicy !== undefined) {
    const rows = composeEntries([patches])
    const disabled = new Set([
      'hmr', 'config-editor', 'plugin-manager', 'tool-plugin-manager', 'ui-plugin-manager',
      'llm-pi-ai', 'llm-deepseek-account', 'deepseek-account', 'web', 'web-search-deepseek',
      'web-fetch-http', 'tool-web', 'tool-bash', 'tool-pwsh', 'tool-workflow', 'workflow-ptc',
      'ptc-runtime', 'mcp-resources', 'skill', 'skill-filesystem', 'tool-skill',
      'terminal-controller', 'ui-sidebar-terminal', 'ui-permission', 'ui-agent-preset',
      'open-in-app', 'ui-open-in-app', 'office-to-pdf',
    ])
    for (const row of rows) {
      if (disabled.has(row.id)) patches.push({ id: row.id, disabled: true })
      if (row.id.startsWith('preset-')) {
        if (row.id === 'preset-standard') patches.push({ id: row.id, config: { id: 'standard', order: 1, plugins: [] } })
        else patches.push({ id: row.id, disabled: true })
      }
    }
    patches.push({ id: 'sandbox-policy', config: {
      mode: context.enterprisePolicy.workspaceMode, workspaceRoot: context.enterprisePolicy.workspaceRoot,
      maximumMode: context.enterprisePolicy.workspaceMode,
      allowedWorkspaceRoot: context.enterprisePolicy.workspaceRoot,
    } })
    patches.push({ id: 'llm-deepseek', config: { baseURL: context.enterprisePolicy.modelGateway } })
    for (const id of ['session-log-deepseek', 'plugin-package-inventory-deepseek', 'session-telemetry-otel',
      'desktop-product-telemetry', 'product-analytics']) {
      if (rows.some(row => row.id === id)) patches.push({ id, disabled: true })
    }
  }
  return patches
}
