import {
    DefaultPackageManager,
    SettingsManager,
    getAgentDir,
    type ExecResult,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent"

import { UPDATE_COMMAND } from "./model.ts"

export interface PackageManagerDeps {
    nowIso(): string
    sleep(milliseconds: number): Promise<void>
    isOffline(): boolean
    checkForAvailableUpdates(ctx: ExtensionContext): Promise<string[]>
    runNativeUpdate(
        pi: Pick<ExtensionAPI, "exec">,
        ctx: ExtensionCommandContext,
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
        const agentDir = getAgentDir()
        const settingsManager = SettingsManager.create(ctx.cwd, agentDir, {
            projectTrusted: ctx.isProjectTrusted(),
        })
        const packageManager = new DefaultPackageManager({
            cwd: ctx.cwd,
            agentDir,
            settingsManager,
        })
        const updates = await packageManager.checkForAvailableUpdates()

        return updates
            .map((update) => update.displayName)
            .sort((left, right) => left.localeCompare(right))
    },
    runNativeUpdate(pi: Pick<ExtensionAPI, "exec">, ctx: ExtensionCommandContext) {
        return pi.exec("pi", [...UPDATE_COMMAND], {
            cwd: ctx.cwd,
            signal: ctx.signal,
        })
    },
}
