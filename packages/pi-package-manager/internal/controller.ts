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
    createStatusErrorReport,
    createStatusReport,
    getExecDisplayOutput,
    getExecFailureDetail,
    setPackageManagerWidget,
} from "./reports.ts"
import { defaultPackageManagerDeps, type PackageManagerDeps } from "./runtime.ts"

export function createPackageManagerController(
    pi: Pick<ExtensionAPI, "appendEntry" | "sendUserMessage" | "exec">,
    deps: PackageManagerDeps = defaultPackageManagerDeps,
) {
    return {
        onSessionStart,
        handleStatus,
        handleUpdate,
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
                reason: getExecFailureDetail(result),
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
