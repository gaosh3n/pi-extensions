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
import {
    defaultPackageManagerDeps,
    isValidCatalogVersion,
    sanitizeCatalogPackage,
    type PackageManagerDeps,
} from "./runtime.ts"
import { promptForCatalogPackage } from "./catalog-picker.ts"
import { promptForPackagesToUninstall } from "./uninstall-picker.ts"
import type { CatalogPackage } from "./model.ts"

export function createPackageManagerController(
    pi: Pick<ExtensionAPI, "appendEntry" | "sendUserMessage" | "exec">,
    deps: PackageManagerDeps = defaultPackageManagerDeps,
) {
    let sessionIsActive = true
    let sessionGeneration = 0
    let catalogClient = deps.createCatalogSearchClient?.()
    let catalogSearch = catalogClient?.search.bind(catalogClient) ?? deps.searchCatalog
    const catalogControllers = new Set<AbortController>()

    return {
        onSessionStart,
        onSessionShutdown,
        handleStatus,
        handleUpdate,
        handleInstall,
        handleInstallViaCatalog,
        handleUninstall,
    }

    async function onSessionStart(
        event: Pick<SessionStartEvent, "reason">,
        _ctx: ExtensionContext,
    ): Promise<void> {
        sessionIsActive = true
        sessionGeneration += 1
        for (const controller of catalogControllers) {
            controller.abort()
        }
        catalogControllers.clear()
        catalogClient?.dispose()
        catalogClient = deps.createCatalogSearchClient?.()
        catalogSearch = catalogClient?.search.bind(catalogClient) ?? deps.searchCatalog

        if (!shouldAutoUpdateOnSessionStart(event)) {
            return
        }

        pi.sendUserMessage("/package-manager update --startup", {
            expandPromptTemplates: true,
        })
    }

    async function onSessionShutdown(): Promise<void> {
        sessionIsActive = false
        sessionGeneration += 1
        for (const controller of catalogControllers) {
            controller.abort()
        }
        catalogControllers.clear()
        catalogClient?.dispose()
        catalogClient = undefined
        catalogSearch = deps.searchCatalog
    }

    async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
        const lastAutoUpdate = getLastAutoUpdateRecord(ctx.sessionManager.getEntries())

        setPackageManagerWidget(ctx, { mode: "status-checking" })

        try {
            const availableUpdates = await deps.checkForAvailableUpdates(ctx)

            if (!isSessionActive()) {
                return
            }

            appendReport({
                type: REPORT_ENTRY_TYPE,
                report: createStatusReport({
                    availableUpdates,
                    lastAutoUpdate,
                }),
            })
        } catch (error) {
            if (!isSessionActive()) {
                return
            }

            appendReport({
                type: REPORT_ENTRY_TYPE,
                report: createStatusErrorReport(
                    {
                        availableUpdates: [],
                        lastAutoUpdate,
                    },
                    getErrorMessage(error),
                ),
            })
        } finally {
            if (isSessionActive()) {
                clearPackageManagerWidget(ctx)
            }
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

            if (!isSessionActive()) {
                return
            }

            if (availableUpdates.length === 0) {
                appendSkippedResult(startedAtUtc, "No package updates are available.")
                return
            }

            setPackageManagerWidget(ctx, {
                mode: "installing",
                packages: availableUpdates.length,
            })

            const result = await deps.runNativeUpdate(pi, ctx)

            if (!isSessionActive()) {
                return
            }

            const output = getExecDisplayOutput(result)

            if (result.code === 0) {
                const record = createAutoUpdateRecord({
                    startedAtUtc,
                    endedAtUtc: deps.nowIso(),
                    outcome: "succeeded",
                    packagesUpdated: availableUpdates.length,
                })
                const report = createAutoUpdateResultReport({
                    record,
                    output,
                    reloadAfterSeconds: RELOAD_COUNTDOWN_SECONDS,
                })

                appendAutoUpdateRecordAndReport(pi, record, report)

                if (!(await runReloadCountdown(ctx))) {
                    return
                }

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
            const report = createAutoUpdateResultReport({ record, output })

            appendAutoUpdateRecordAndReport(pi, record, report)
            notifyStartupFailure(ctx, options.startupTriggered)
        } catch (error) {
            if (!isSessionActive()) {
                return
            }

            const record = createAutoUpdateRecord({
                startedAtUtc,
                endedAtUtc: deps.nowIso(),
                outcome: "failed",
                packagesUpdated: 0,
                reason: getErrorMessage(error),
            })
            const report = createAutoUpdateResultReport({ record })

            appendAutoUpdateRecordAndReport(pi, record, report)
            notifyStartupFailure(ctx, options.startupTriggered)
        } finally {
            if (shouldClearWidget && isSessionActive()) {
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

        if (!isSessionActive() || source === undefined) {
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

            if (!isSessionActive()) {
                return
            }

            const output = getExecDisplayOutput(result)
            const report = createInstallResultReport({
                startedAtUtc,
                endedAtUtc: deps.nowIso(),
                source,
                outcome: result.code === 0 ? "succeeded" : "failed",
                output,
                reason:
                    result.code === 0
                        ? undefined
                        : getExecFailureDetail(
                              result,
                              "Package install command failed.",
                          ),
            })

            appendReport({ type: REPORT_ENTRY_TYPE, report })
        } catch (error) {
            if (!isSessionActive()) {
                return
            }

            appendReport({
                type: REPORT_ENTRY_TYPE,
                report: createInstallResultReport({
                    startedAtUtc,
                    endedAtUtc: deps.nowIso(),
                    source,
                    outcome: "failed",
                    reason: getErrorMessage(error),
                }),
            })
        } finally {
            if (isSessionActive()) {
                clearPackageManagerWidget(ctx)
            }
        }
    }

    async function handleInstallViaCatalog(
        ctx: ExtensionCommandContext,
    ): Promise<void> {
        if (ctx.mode !== "tui") {
            ctx.ui.notify(
                "/package-manager install-via-catalog requires TUI mode.",
                "warning",
            )
            return
        }

        const generation = sessionGeneration
        const catalogController = new AbortController()
        catalogControllers.add(catalogController)

        try {
            const selected = await promptForCatalogPackage(
                ctx,
                catalogSearch,
                catalogController.signal,
            )

            if (!isSessionGenerationCurrent(generation) || !selected) {
                return
            }

            const safeSelected = sanitizeCatalogPackage(selected)
            if (!safeSelected || !isValidCatalogPackage(safeSelected)) {
                ctx.ui.notify("The selected catalog package is invalid.", "error")
                return
            }

            const source = safeSelected.installSource
            const confirmed = await ctx.ui.confirm(
                `Install ${safeSelected.name}@${safeSelected.version}?`,
                [
                    `Types: ${safeSelected.types.join(", ")}`,
                    `Publisher: ${safeSelected.publisher ?? "unknown"}`,
                    `Source: ${source}`,
                    safeSelected.description || "No description.",
                ].join("\n"),
            )

            if (!confirmed || !isSessionGenerationCurrent(generation)) {
                return
            }

            const startedAtUtc = deps.nowIso()
            setPackageManagerWidget(ctx, {
                mode: "package-installing",
                source,
            })

            try {
                const result = await deps.runNativeInstall(pi, ctx, source)

                if (!isSessionGenerationCurrent(generation)) {
                    return
                }

                appendReport({
                    type: REPORT_ENTRY_TYPE,
                    report: createInstallResultReport({
                        startedAtUtc,
                        endedAtUtc: deps.nowIso(),
                        source,
                        outcome: result.code === 0 ? "succeeded" : "failed",
                        output: getExecDisplayOutput(result),
                        reason:
                            result.code === 0
                                ? undefined
                                : getExecFailureDetail(
                                      result,
                                      "Package install command failed.",
                                  ),
                    }),
                })
            } catch (error) {
                if (!isSessionGenerationCurrent(generation)) {
                    return
                }

                appendReport({
                    type: REPORT_ENTRY_TYPE,
                    report: createInstallResultReport({
                        startedAtUtc,
                        endedAtUtc: deps.nowIso(),
                        source,
                        outcome: "failed",
                        reason: getErrorMessage(error),
                    }),
                })
            } finally {
                if (isSessionGenerationCurrent(generation)) {
                    clearPackageManagerWidget(ctx)
                }
            }
        } catch (error) {
            if (isSessionGenerationCurrent(generation)) {
                ctx.ui.notify(
                    `Catalog search failed: ${getErrorMessage(error)}`,
                    "error",
                )
            }
        } finally {
            catalogControllers.delete(catalogController)
        }
    }

    async function handleUninstall(ctx: ExtensionCommandContext): Promise<void> {
        if (ctx.mode !== "tui") {
            ctx.ui.notify("/package-manager uninstall requires TUI mode.", "warning")
            return
        }

        const packages = await deps.listConfiguredPackages(ctx)

        if (!isSessionActive()) {
            return
        }

        if (packages.length === 0) {
            ctx.ui.notify("No Pi packages are available to uninstall.", "info")
            return
        }

        const selectedSources = await promptForPackagesToUninstall(ctx, packages)

        if (!isSessionActive() || selectedSources === undefined) {
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

                if (!isSessionActive()) {
                    return
                }

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

            appendReport({
                type: REPORT_ENTRY_TYPE,
                report: createUninstallResultReport({
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
            })
        } catch (error) {
            if (!isSessionActive()) {
                return
            }

            const failedSource = sources[succeededSources.length]
            const errorMessage = getErrorMessage(error)

            if (failedSource && !failedSources.includes(failedSource)) {
                failedSources.push(failedSource)
            }

            outputSections.push(
                failedSource ? `[${failedSource}]\n${errorMessage}` : errorMessage,
            )
            appendReport({
                type: REPORT_ENTRY_TYPE,
                report: createUninstallResultReport({
                    startedAtUtc,
                    endedAtUtc: deps.nowIso(),
                    sources,
                    outcome: succeededSources.length > 0 ? "partial" : "failed",
                    succeededSources,
                    failedSources,
                    output: outputSections.join("\n\n"),
                    reason: errorMessage,
                }),
            })
        } finally {
            if (isSessionActive()) {
                clearPackageManagerWidget(ctx)
            }
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
        const report = createAutoUpdateResultReport({ record })

        appendAutoUpdateRecordAndReport(pi, record, report)
    }

    function appendReport(entry: {
        type: string
        report: ReturnType<typeof createStatusReport>
    }): void {
        pi.appendEntry(entry.type, entry.report)
    }

    function isSessionActive(): boolean {
        return sessionIsActive
    }

    function isSessionGenerationCurrent(generation: number): boolean {
        return sessionIsActive && generation === sessionGeneration
    }

    async function runReloadCountdown(
        ctx: ExtensionContext,
        seconds = RELOAD_COUNTDOWN_SECONDS,
    ): Promise<boolean> {
        for (let remaining = seconds; remaining >= 1; remaining--) {
            if (!isSessionActive()) {
                return false
            }

            setPackageManagerWidget(ctx, {
                mode: "countdown",
                secondsRemaining: remaining,
            })

            await deps.sleep(1000)

            if (!isSessionActive()) {
                return false
            }
        }

        return true
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

function isValidCatalogPackage(pkg: CatalogPackage): boolean {
    return (
        isValidNpmPackageName(pkg.name) &&
        pkg.installSource === `npm:${pkg.name}` &&
        isValidCatalogVersion(pkg.version) &&
        pkg.types.length > 0
    )
}

function hasUnsafeNpmNameCharacters(value: string): boolean {
    return (
        /\\s/u.test(value) ||
        [...value].some((character) => {
            const code = character.codePointAt(0) ?? 0
            return code <= 31 || code === 127
        })
    )
}

function isValidNpmPackageName(value: string): boolean {
    return (
        value.length <= 214 &&
        !hasUnsafeNpmNameCharacters(value) &&
        !value.includes("..") &&
        (/^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/u.test(value) ||
            /^[a-z0-9][a-z0-9._~-]*$/u.test(value))
    )
}
