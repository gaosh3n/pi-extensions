import {
    DefaultPackageManager,
    SettingsManager,
    getAgentDir,
    type ExecResult,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent"

import {
    INSTALL_COMMAND,
    UNINSTALL_COMMAND,
    UPDATE_COMMAND,
    type ConfiguredPackageOption,
} from "./model.ts"

export interface PackageManagerDeps {
    nowIso(): string
    sleep(milliseconds: number): Promise<void>
    isOffline(): boolean
    checkForAvailableUpdates(ctx: ExtensionContext): Promise<string[]>
    listConfiguredPackages(ctx: ExtensionContext): Promise<ConfiguredPackageOption[]>
    runNativeUpdate(
        pi: Pick<ExtensionAPI, "exec">,
        ctx: ExtensionCommandContext,
    ): Promise<ExecResult>
    runNativeInstall(
        pi: Pick<ExtensionAPI, "exec">,
        ctx: ExtensionCommandContext,
        source: string,
    ): Promise<ExecResult>
    runNativeUninstall(
        pi: Pick<ExtensionAPI, "exec">,
        ctx: ExtensionCommandContext,
        source: string,
    ): Promise<ExecResult>
}

export const defaultPackageManagerDeps: PackageManagerDeps = {
    nowIso: () => new Date().toISOString(),
    sleep(milliseconds: number) {
        return new Promise((resolve) => {
            setTimeout(resolve, milliseconds)
        })
    },
    isOffline: () => Boolean(process.env.PI_OFFLINE),
    async checkForAvailableUpdates(ctx: ExtensionContext): Promise<string[]> {
        const packageManager = createDefaultPackageManager(ctx)
        const updates = await packageManager.checkForAvailableUpdates()

        return updates
            .map((update) => update.displayName)
            .sort((left, right) => left.localeCompare(right))
    },
    async listConfiguredPackages(
        ctx: ExtensionContext,
    ): Promise<ConfiguredPackageOption[]> {
        return createDefaultPackageManager(ctx)
            .listConfiguredPackages()
            .map((pkg) => ({
                source: pkg.source,
                scope: pkg.scope,
                filtered: pkg.filtered,
            }))
            .sort((left, right) => left.source.localeCompare(right.source))
    },
    runNativeUpdate(pi: Pick<ExtensionAPI, "exec">, ctx: ExtensionCommandContext) {
        return pi.exec("pi", [...UPDATE_COMMAND], {
            cwd: ctx.cwd,
            signal: ctx.signal,
        })
    },
    runNativeInstall(
        pi: Pick<ExtensionAPI, "exec">,
        ctx: ExtensionCommandContext,
        source: string,
    ) {
        return pi.exec("pi", [...INSTALL_COMMAND, source], {
            cwd: ctx.cwd,
            signal: ctx.signal,
        })
    },
    runNativeUninstall(
        pi: Pick<ExtensionAPI, "exec">,
        ctx: ExtensionCommandContext,
        source: string,
    ) {
        return pi.exec("pi", [...UNINSTALL_COMMAND, source], {
            cwd: ctx.cwd,
            signal: ctx.signal,
        })
    },
}

function createDefaultPackageManager(ctx: ExtensionContext): DefaultPackageManager {
    const agentDir = getAgentDir()
    const settingsManager = SettingsManager.create(ctx.cwd, agentDir, {
        projectTrusted: ctx.isProjectTrusted(),
    })

    return new DefaultPackageManager({
        cwd: ctx.cwd,
        agentDir,
        settingsManager,
    })
}
