import {
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
    type SessionStartEvent,
} from "@earendil-works/pi-coding-agent"

import { RELOAD_COUNTDOWN_SECONDS, REPORT_ENTRY_TYPE } from "./model.ts"
import {
    appendAutoUpdateRecordAndReport,
    createAutoUpdateRecord,
    getLastAutoUpdateRecord,
} from "./records.ts"
import {
    clearPackageManagerWidget,
    createAutoUpdateResultReport,
    createInstallResultReport,
    createStatusErrorReport,
    createStatusReport,
    createUninstallResultReport,
    getExecDisplayOutput,
    getExecFailureDetail,
    setPackageManagerWidget,
} from "./reports.ts"
import { defaultPackageManagerDeps, type PackageManagerDeps } from "./runtime.ts"
import { promptForPackagesToUninstall } from "./uninstall-picker.ts"

export function createPackageManagerController(
    pi: Pick<ExtensionAPI, "appendEntry" | "sendUserMessage" | "exec">,
    deps: PackageManagerDeps = defaultPackageManagerDeps,
) {
    return {
        onSessionStart,
        handleStatus,
        handleUpdate,
        handleInstall,
        handleUninstall,
    }

    async function onSessionStart(
        event: Pick<SessionStartEvent, "reason">,
        _ctx: ExtensionContext,
    ): Promise<void> {
        if (!shouldAutoUpdateOnSessionStart(event)) {
            return
        }

        pi.sendUserMessage("/package-manager update --startup", {
            expandPromptTemplates: true,
        })
    }

    async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
        const lastAutoUpdate = getLastAutoUpdateRecord(ctx.sessionManager.getEntries())

        setPackageManagerWidget(ctx, { mode: "status-checking" })

        try {
            const availableUpdates = await deps.checkForAvailableUpdates(ctx)
            pi.appendEntry(
                REPORT_ENTRY_TYPE,
                createStatusReport({
                    availableUpdates,
                    lastAutoUpdate,
                }),
            )
        } catch (error) {
            pi.appendEntry(
                REPORT_ENTRY_TYPE,
                createStatusErrorReport(
                    {
                        availableUpdates: [],
                        lastAutoUpdate,
                    },
                    getErrorMessage(error),
                ),
            )
        } finally {
            clearPackageManagerWidget(ctx)
        }
    }

    async function handleUpdate(
        ctx: ExtensionCommandContext,
        options: { startupTriggered: boolean },
    ): Promise<void> {
        const startedAtUtc = deps.nowIso()
        let shouldClearWidget = true

        setPackageManagerWidget(ctx, { mode: "checking" })

        try {
            if (deps.isOffline()) {
                appendSkippedResult(startedAtUtc, "PI_OFFLINE is set.")
                return
            }

            const availableUpdates = await deps.checkForAvailableUpdates(ctx)

            if (availableUpdates.length === 0) {
                appendSkippedResult(startedAtUtc, "No package updates are available.")
                return
            }

            setPackageManagerWidget(ctx, {
                mode: "installing",
                packages: availableUpdates.length,
            })

            const result = await deps.runNativeUpdate(pi, ctx)
            const output = getExecDisplayOutput(result)

            if (result.code === 0) {
                const record = createAutoUpdateRecord({
                    startedAtUtc,
                    endedAtUtc: deps.nowIso(),
                    outcome: "succeeded",
                    packagesUpdated: availableUpdates.length,
                })

                appendAutoUpdateRecordAndReport(
                    pi,
                    record,
                    createAutoUpdateResultReport({
                        record,
                        output,
                        reloadAfterSeconds: RELOAD_COUNTDOWN_SECONDS,
                    }),
                )
                await runReloadCountdown(ctx)
                clearPackageManagerWidget(ctx)
                shouldClearWidget = false
                await ctx.reload()
                return
            }

            const record = createAutoUpdateRecord({
                startedAtUtc,
                endedAtUtc: deps.nowIso(),
                outcome: "failed",
                packagesUpdated: 0,
                reason: getExecFailureDetail(result, "Package update command failed."),
            })

            appendAutoUpdateRecordAndReport(
                pi,
                record,
                createAutoUpdateResultReport({ record, output }),
            )
            notifyStartupFailure(ctx, options.startupTriggered)
        } catch (error) {
            const record = createAutoUpdateRecord({
                startedAtUtc,
                endedAtUtc: deps.nowIso(),
                outcome: "failed",
                packagesUpdated: 0,
                reason: getErrorMessage(error),
            })

            appendAutoUpdateRecordAndReport(
                pi,
                record,
                createAutoUpdateResultReport({ record }),
            )
            notifyStartupFailure(ctx, options.startupTriggered)
        } finally {
            if (shouldClearWidget) {
                clearPackageManagerWidget(ctx)
            }
        }
    }

    async function handleInstall(ctx: ExtensionCommandContext): Promise<void> {
        if (!ctx.hasUI) {
            ctx.ui.notify(
                "/package-manager install requires dialog-capable UI.",
                "warning",
            )
            return
        }

        const source = (
            await ctx.ui.input(
                "Install Pi Package",
                "npm:@scope/pkg or git:github.com/user/repo",
            )
        )?.trim()

        if (source === undefined) {
            return
        }

        if (!source) {
            ctx.ui.notify("Package source is required.", "warning")
            return
        }

        const startedAtUtc = deps.nowIso()
        setPackageManagerWidget(ctx, { mode: "package-installing", source })

        try {
            const result = await deps.runNativeInstall(pi, ctx, source)
            const output = getExecDisplayOutput(result)

            if (result.code === 0) {
                pi.appendEntry(
                    REPORT_ENTRY_TYPE,
                    createInstallResultReport({
                        startedAtUtc,
                        endedAtUtc: deps.nowIso(),
                        source,
                        outcome: "succeeded",
                        output,
                    }),
                )
                return
            }

            pi.appendEntry(
                REPORT_ENTRY_TYPE,
                createInstallResultReport({
                    startedAtUtc,
                    endedAtUtc: deps.nowIso(),
                    source,
                    outcome: "failed",
                    output,
                    reason: getExecFailureDetail(
                        result,
                        "Package install command failed.",
                    ),
                }),
            )
        } catch (error) {
            pi.appendEntry(
                REPORT_ENTRY_TYPE,
                createInstallResultReport({
                    startedAtUtc,
                    endedAtUtc: deps.nowIso(),
                    source,
                    outcome: "failed",
                    reason: getErrorMessage(error),
                }),
            )
        } finally {
            clearPackageManagerWidget(ctx)
        }
    }

    async function handleUninstall(ctx: ExtensionCommandContext): Promise<void> {
        if (ctx.mode !== "tui") {
            ctx.ui.notify("/package-manager uninstall requires TUI mode.", "warning")
            return
        }

        const packages = await deps.listConfiguredPackages(ctx)

        if (packages.length === 0) {
            ctx.ui.notify("No Pi packages are available to uninstall.", "info")
            return
        }

        const selectedSources = await promptForPackagesToUninstall(ctx, packages)

        if (selectedSources === undefined) {
            return
        }

        if (selectedSources.length === 0) {
            ctx.ui.notify("Select at least one package to uninstall.", "warning")
            return
        }

        const selectedSourceSet = new Set(selectedSources)
        const sources = packages
            .map((pkg) => pkg.source)
            .filter((source) => selectedSourceSet.has(source))

        if (sources.length === 0) {
            ctx.ui.notify("Select at least one package to uninstall.", "warning")
            return
        }

        const startedAtUtc = deps.nowIso()
        const succeededSources: string[] = []
        const failedSources: string[] = []
        const outputSections: string[] = []

        try {
            for (const [index, source] of sources.entries()) {
                setPackageManagerWidget(ctx, {
                    mode: "package-uninstalling",
                    current: index + 1,
                    total: sources.length,
                    source,
                })

                const result = await deps.runNativeUninstall(pi, ctx, source)
                const output = getExecDisplayOutput(result)

                if (result.code === 0) {
                    if (output) {
                        outputSections.push(`[${source}]\n${output}`)
                    }
                    succeededSources.push(source)
                    continue
                }

                failedSources.push(source)
                outputSections.push(
                    `[${source}]\n${output ?? getExecFailureDetail(result, "Package uninstall command failed.")}`,
                )
            }

            pi.appendEntry(
                REPORT_ENTRY_TYPE,
                createUninstallResultReport({
                    startedAtUtc,
                    endedAtUtc: deps.nowIso(),
                    sources,
                    outcome:
                        failedSources.length === 0
                            ? "succeeded"
                            : succeededSources.length > 0
                              ? "partial"
                              : "failed",
                    succeededSources,
                    failedSources,
                    output:
                        outputSections.length > 0
                            ? outputSections.join("\n\n")
                            : undefined,
                    reason:
                        failedSources.length > 0
                            ? `Failed to uninstall ${failedSources[0]}.`
                            : undefined,
                }),
            )
        } catch (error) {
            const failedSource = sources[succeededSources.length]
            const errorMessage = getErrorMessage(error)

            if (failedSource && !failedSources.includes(failedSource)) {
                failedSources.push(failedSource)
            }

            outputSections.push(
                failedSource ? `[${failedSource}]\n${errorMessage}` : errorMessage,
            )
            pi.appendEntry(
                REPORT_ENTRY_TYPE,
                createUninstallResultReport({
                    startedAtUtc,
                    endedAtUtc: deps.nowIso(),
                    sources,
                    outcome: succeededSources.length > 0 ? "partial" : "failed",
                    succeededSources,
                    failedSources,
                    output: outputSections.join("\n\n"),
                    reason: errorMessage,
                }),
            )
        } finally {
            clearPackageManagerWidget(ctx)
        }
    }

    function appendSkippedResult(startedAtUtc: string, reason: string): void {
        const record = createAutoUpdateRecord({
            startedAtUtc,
            endedAtUtc: deps.nowIso(),
            outcome: "skipped",
            packagesUpdated: 0,
            reason,
        })

        appendAutoUpdateRecordAndReport(
            pi,
            record,
            createAutoUpdateResultReport({ record }),
        )
    }

    async function runReloadCountdown(
        ctx: ExtensionContext,
        seconds = RELOAD_COUNTDOWN_SECONDS,
    ): Promise<void> {
        for (let remaining = seconds; remaining >= 1; remaining--) {
            setPackageManagerWidget(ctx, {
                mode: "countdown",
                secondsRemaining: remaining,
            })

            await deps.sleep(1000)
        }
    }
}

export function shouldAutoUpdateOnSessionStart(
    event: Pick<SessionStartEvent, "reason">,
): boolean {
    return event.reason === "startup"
}

function notifyStartupFailure(
    ctx: ExtensionCommandContext,
    startupTriggered: boolean,
): void {
    if (startupTriggered && ctx.hasUI) {
        ctx.ui.notify(
            "Pi Package Manager automatic startup update failed. See transcript for details.",
            "error",
        )
    }
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message
    }

    return String(error)
}
