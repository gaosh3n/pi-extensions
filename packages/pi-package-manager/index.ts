import {
    DefaultPackageManager,
    getAgentDir,
    SettingsManager,
    type CustomEntry,
    type ExecResult,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
    type SessionEntry,
    type SessionStartEvent,
} from "@earendil-works/pi-coding-agent"
import { type AutocompleteItem, Box, Text } from "@earendil-works/pi-tui"

export const AUTO_UPDATE_RECORD_ENTRY_TYPE = "package-manager-auto-update-record"
export const REPORT_ENTRY_TYPE = "package-manager-report"
export const PACKAGE_MANAGER_TITLE = "Pi Package Manager"

const UPDATE_COMMAND = ["update", "--extensions"] as const
const PACKAGE_MANAGER_WIDGET_KEY = "pi-package-manager"
const RELOAD_COUNTDOWN_SECONDS = 5
const OUTPUT_PREVIEW_LINE_COUNT = 8

export type AutoUpdateOutcome = "succeeded" | "failed" | "skipped"
export type ReportTone = "info" | "success" | "warning" | "error"

type WidgetState =
    | { mode: "checking" }
    | { mode: "installing"; packages: number }
    | { mode: "countdown"; secondsRemaining: number }

export interface AutoUpdateRecord {
    startedAtUtc: string
    endedAtUtc: string
    outcome: AutoUpdateOutcome
    packagesUpdated: number
    reason?: string
}

export interface PackageManagerReport {
    title: string
    tone: ReportTone
    lines: string[]
    output?: string
}

export interface PackageStatusSnapshot {
    availableUpdates: string[]
    lastAutoUpdate?: AutoUpdateRecord
}

export default function (pi: ExtensionAPI) {
    let lastAutoUpdateRecord: AutoUpdateRecord | undefined

    pi.registerEntryRenderer<PackageManagerReport>(
        REPORT_ENTRY_TYPE,
        (entry, { expanded }, theme) => {
            const report = entry.data

            if (!report) {
                return undefined
            }

            const toneColor =
                report.tone === "error"
                    ? "error"
                    : report.tone === "warning"
                      ? "warning"
                      : report.tone === "success"
                        ? "success"
                        : "accent"

            const box = new Box(1, 1, (text: string) =>
                theme.bg("customMessageBg", text),
            )

            box.addChild(
                new Text(
                    `${theme.fg(toneColor, "●")} ${theme.bold(theme.fg("customMessageLabel", report.title))}`,
                    0,
                    0,
                ),
            )

            if (report.lines.length > 0) {
                box.addChild(
                    new Text(
                        report.lines
                            .map((line) => theme.fg("customMessageText", line))
                            .join("\n"),
                        0,
                        0,
                    ),
                )
            }

            if (report.output?.trim()) {
                const { text, truncated } = formatReportOutput(report.output, expanded)

                box.addChild(new Text(theme.fg("dim", "Update output:"), 0, 0))
                box.addChild(new Text(theme.fg("toolOutput", text), 0, 0))

                if (truncated) {
                    box.addChild(
                        new Text(
                            theme.fg(
                                "dim",
                                "Expand this entry to view the full update output.",
                            ),
                            0,
                            0,
                        ),
                    )
                }
            }

            return box
        },
    )

    pi.on("session_start", async (event, ctx) => {
        lastAutoUpdateRecord = getLastAutoUpdateRecord(ctx.sessionManager.getEntries())

        if (!shouldAutoUpdateOnSessionStart(event)) {
            return
        }

        pi.sendUserMessage("/package-manager update --startup", {
            expandPromptTemplates: true,
        })
    })

    pi.registerCommand("package-manager", {
        description:
            "Manage Pi package updates (usage: /package-manager [status|update])",
        getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
            const items = ["status", "update"].map((value) => ({
                value,
                label: value,
            }))
            const normalizedPrefix = prefix.trim()
            const filtered = normalizedPrefix
                ? items.filter((item) => item.value.startsWith(normalizedPrefix))
                : items
            return filtered.length > 0 ? filtered : null
        },
        handler: async (args, ctx) => {
            const tokens = args.trim().split(/\s+/).filter(Boolean)
            const subcommand = tokens[0] ?? "status"

            if (subcommand === "status") {
                await handleStatusCommand(pi, ctx, lastAutoUpdateRecord)
                return
            }

            if (subcommand === "update") {
                const automatic = tokens.includes("--startup")
                const result = await runUpdate(pi, ctx, { automatic })

                if (automatic && result.autoUpdateRecord) {
                    lastAutoUpdateRecord = result.autoUpdateRecord
                }

                return
            }

            ctx.ui.notify("Usage: /package-manager [status|update]", "warning")
        },
    })
}

export function shouldAutoUpdateOnSessionStart(
    event: Pick<SessionStartEvent, "reason">,
): boolean {
    return event.reason === "startup"
}

export function createAutoUpdateRecord(input: {
    startedAtUtc: string
    endedAtUtc: string
    outcome: AutoUpdateOutcome
    packagesUpdated: number
    reason?: string
}): AutoUpdateRecord {
    return {
        startedAtUtc: input.startedAtUtc,
        endedAtUtc: input.endedAtUtc,
        outcome: input.outcome,
        packagesUpdated: input.packagesUpdated,
        reason: input.reason,
    }
}

export function formatUtcTimestamp(isoUtc: string): string {
    return isoUtc.replace("T", " ").replace(/\.\d{3}Z$/, " UTC+00")
}

export function formatStatusLines(snapshot: PackageStatusSnapshot): string[] {
    const lines = [
        "Status",
        "",
        `Available package updates: ${snapshot.availableUpdates.length}`,
        "Packages:",
    ]

    if (snapshot.availableUpdates.length > 0) {
        for (const packageName of snapshot.availableUpdates) {
            lines.push(`- ${packageName}`)
        }
    } else {
        lines.push("- none")
    }

    lines.push("", "Latest auto-update:")

    if (!snapshot.lastAutoUpdate) {
        lines.push("- none recorded")
        return lines
    }

    lines.push(`- start: ${formatUtcTimestamp(snapshot.lastAutoUpdate.startedAtUtc)}`)
    lines.push(`- end: ${formatUtcTimestamp(snapshot.lastAutoUpdate.endedAtUtc)}`)
    lines.push(`- result: ${snapshot.lastAutoUpdate.outcome}`)
    lines.push(`- packages updated: ${snapshot.lastAutoUpdate.packagesUpdated}`)

    if (snapshot.lastAutoUpdate.reason) {
        lines.push(`- detail: ${snapshot.lastAutoUpdate.reason}`)
    }

    return lines
}

export function createStatusReport(
    snapshot: PackageStatusSnapshot,
): PackageManagerReport {
    return {
        title: PACKAGE_MANAGER_TITLE,
        tone: snapshot.availableUpdates.length > 0 ? "warning" : "info",
        lines: formatStatusLines(snapshot),
    }
}

export function createManualUpdateStartReport(): PackageManagerReport {
    return {
        title: PACKAGE_MANAGER_TITLE,
        tone: "info",
        lines: ["Manual update in progress.", "Checking for package updates..."],
    }
}

export function createManualUpdateReport(input: {
    outcome: AutoUpdateOutcome
    packagesUpdated: number
    reason?: string
    output?: string
}): PackageManagerReport {
    const lines = [
        input.outcome === "failed"
            ? "Manual update failed."
            : input.outcome === "succeeded"
              ? "Manual update completed."
              : "Manual update skipped.",
        `Result: ${input.outcome}`,
        `Packages updated: ${input.packagesUpdated}`,
    ]

    if (input.reason) {
        lines.push(`Detail: ${input.reason}`)
    }

    if (input.outcome === "succeeded" && input.packagesUpdated > 0) {
        lines.push("Reloading now to activate updated package resources.")
    }

    return {
        title: PACKAGE_MANAGER_TITLE,
        tone:
            input.outcome === "failed"
                ? "error"
                : input.outcome === "succeeded"
                  ? "success"
                  : "info",
        lines,
        output: input.output,
    }
}

export function createAutoUpdateResultReport(input: {
    record: AutoUpdateRecord
    output?: string
    reloadAfterSeconds?: number
}): PackageManagerReport {
    const lines = [
        input.record.outcome === "failed"
            ? "Pi package(s) update failed."
            : input.record.outcome === "succeeded"
              ? "Pi package(s) update completed."
              : "Pi package(s) update skipped.",
        `Start: ${formatUtcTimestamp(input.record.startedAtUtc)}`,
        `End: ${formatUtcTimestamp(input.record.endedAtUtc)}`,
        `Result: ${input.record.outcome}`,
        `Packages updated: ${input.record.packagesUpdated}`,
    ]

    if (input.record.reason) {
        lines.push(`Detail: ${input.record.reason}`)
    }

    if (input.reloadAfterSeconds) {
        lines.push(
            `Reloading in ${input.reloadAfterSeconds} seconds to activate updated package resources.`,
        )
    }

    return {
        title: PACKAGE_MANAGER_TITLE,
        tone:
            input.record.outcome === "failed"
                ? "error"
                : input.record.outcome === "succeeded"
                  ? "success"
                  : "info",
        lines,
        output: input.output,
    }
}

export function createAutomaticUpdateWidgetLines(state: WidgetState): string[] {
    if (state.mode === "checking") {
        return ["Pi package(s) update in progress.", "Checking for package updates..."]
    }

    if (state.mode === "installing") {
        return [
            "Pi package(s) update in progress.",
            `Installing ${state.packages} package update${state.packages === 1 ? "" : "s"}...`,
        ]
    }

    return [
        "Pi package(s) update completed.",
        `Reloading in ${state.secondsRemaining} second${state.secondsRemaining === 1 ? "" : "s"} to activate updated package resources.`,
    ]
}

export function getLastAutoUpdateRecord(
    entries: readonly SessionEntry[],
): AutoUpdateRecord | undefined {
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]

        if (!isAutoUpdateRecordEntry(entry)) {
            continue
        }

        return entry.data
    }

    return undefined
}

async function handleStatusCommand(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    lastAutoUpdateRecord: AutoUpdateRecord | undefined,
): Promise<void> {
    try {
        const availableUpdates = await checkForAvailableUpdates(ctx)
        pi.appendEntry(
            REPORT_ENTRY_TYPE,
            createStatusReport({
                availableUpdates,
                lastAutoUpdate: lastAutoUpdateRecord,
            }),
        )
    } catch (error) {
        const lines = [
            "Status check failed.",
            `Detail: Failed to check package updates: ${getErrorMessage(error)}`,
        ]

        if (lastAutoUpdateRecord) {
            lines.push(
                "",
                `Latest auto-update result: ${lastAutoUpdateRecord.outcome}`,
                `Latest auto-update detail: ${lastAutoUpdateRecord.reason ?? "none"}`,
            )
        }

        pi.appendEntry(REPORT_ENTRY_TYPE, {
            title: PACKAGE_MANAGER_TITLE,
            tone: "error",
            lines,
        })
    }
}

async function runUpdate(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    options: { automatic: boolean },
): Promise<{ autoUpdateRecord?: AutoUpdateRecord }> {
    const startedAtUtc = new Date().toISOString()
    let shouldClearAutomaticWidget = options.automatic

    if (options.automatic) {
        setPackageManagerWidget(ctx, { mode: "checking" })
    } else {
        pi.appendEntry(REPORT_ENTRY_TYPE, createManualUpdateStartReport())
    }

    try {
        if (process.env.PI_OFFLINE) {
            const record = createAutoUpdateRecord({
                startedAtUtc,
                endedAtUtc: new Date().toISOString(),
                outcome: "skipped",
                packagesUpdated: 0,
                reason: "PI_OFFLINE is set.",
            })

            if (options.automatic) {
                pi.appendEntry(AUTO_UPDATE_RECORD_ENTRY_TYPE, record)
                pi.appendEntry(
                    REPORT_ENTRY_TYPE,
                    createAutoUpdateResultReport({ record }),
                )
                return { autoUpdateRecord: record }
            }

            pi.appendEntry(REPORT_ENTRY_TYPE, createManualUpdateReport(record))
            return {}
        }

        const availableUpdates = await checkForAvailableUpdates(ctx)

        if (availableUpdates.length === 0) {
            const record = createAutoUpdateRecord({
                startedAtUtc,
                endedAtUtc: new Date().toISOString(),
                outcome: "skipped",
                packagesUpdated: 0,
                reason: "No package updates are available.",
            })

            if (options.automatic) {
                pi.appendEntry(AUTO_UPDATE_RECORD_ENTRY_TYPE, record)
                pi.appendEntry(
                    REPORT_ENTRY_TYPE,
                    createAutoUpdateResultReport({ record }),
                )
                return { autoUpdateRecord: record }
            }

            pi.appendEntry(REPORT_ENTRY_TYPE, createManualUpdateReport(record))
            return {}
        }

        if (options.automatic) {
            setPackageManagerWidget(ctx, {
                mode: "installing",
                packages: availableUpdates.length,
            })
        }

        const result = await pi.exec("pi", [...UPDATE_COMMAND], {
            cwd: ctx.cwd,
            signal: ctx.signal,
        })
        const output = getExecDisplayOutput(result)

        if (result.code === 0) {
            const record = createAutoUpdateRecord({
                startedAtUtc,
                endedAtUtc: new Date().toISOString(),
                outcome: "succeeded",
                packagesUpdated: availableUpdates.length,
            })

            if (options.automatic) {
                pi.appendEntry(AUTO_UPDATE_RECORD_ENTRY_TYPE, record)
                pi.appendEntry(
                    REPORT_ENTRY_TYPE,
                    createAutoUpdateResultReport({
                        record,
                        output,
                        reloadAfterSeconds: RELOAD_COUNTDOWN_SECONDS,
                    }),
                )
                await runReloadCountdown(ctx)
                clearPackageManagerWidget(ctx)
                shouldClearAutomaticWidget = false
                await ctx.reload()
                return { autoUpdateRecord: record }
            }

            pi.appendEntry(
                REPORT_ENTRY_TYPE,
                createManualUpdateReport({
                    outcome: "succeeded",
                    packagesUpdated: availableUpdates.length,
                    output,
                }),
            )
            await ctx.reload()
            return {}
        }

        const record = createAutoUpdateRecord({
            startedAtUtc,
            endedAtUtc: new Date().toISOString(),
            outcome: "failed",
            packagesUpdated: 0,
            reason: getExecFailureDetail(result),
        })

        if (options.automatic) {
            pi.appendEntry(AUTO_UPDATE_RECORD_ENTRY_TYPE, record)
            pi.appendEntry(
                REPORT_ENTRY_TYPE,
                createAutoUpdateResultReport({ record, output }),
            )

            if (ctx.hasUI) {
                ctx.ui.notify(
                    "Pi Package Manager automatic startup update failed. See transcript for details.",
                    "error",
                )
            }

            return { autoUpdateRecord: record }
        }

        pi.appendEntry(
            REPORT_ENTRY_TYPE,
            createManualUpdateReport({
                outcome: "failed",
                packagesUpdated: 0,
                reason: record.reason,
                output,
            }),
        )
        return {}
    } catch (error) {
        const record = createAutoUpdateRecord({
            startedAtUtc,
            endedAtUtc: new Date().toISOString(),
            outcome: "failed",
            packagesUpdated: 0,
            reason: getErrorMessage(error),
        })

        if (options.automatic) {
            pi.appendEntry(AUTO_UPDATE_RECORD_ENTRY_TYPE, record)
            pi.appendEntry(REPORT_ENTRY_TYPE, createAutoUpdateResultReport({ record }))

            if (ctx.hasUI) {
                ctx.ui.notify(
                    "Pi Package Manager automatic startup update failed. See transcript for details.",
                    "error",
                )
            }

            return { autoUpdateRecord: record }
        }

        pi.appendEntry(
            REPORT_ENTRY_TYPE,
            createManualUpdateReport({
                outcome: "failed",
                packagesUpdated: 0,
                reason: record.reason,
            }),
        )
        return {}
    } finally {
        if (shouldClearAutomaticWidget) {
            clearPackageManagerWidget(ctx)
        }
    }
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

        await delay(1000)
    }
}

async function checkForAvailableUpdates(ctx: ExtensionContext): Promise<string[]> {
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
}

function setPackageManagerWidget(ctx: ExtensionContext, state: WidgetState): void {
    if (ctx.mode !== "tui") {
        return
    }

    ctx.ui.setWidget(
        PACKAGE_MANAGER_WIDGET_KEY,
        (_tui, theme) => {
            const background =
                state.mode === "countdown"
                    ? (text: string) => theme.bg("toolSuccessBg", text)
                    : (text: string) => theme.bg("toolPendingBg", text)
            const box = new Box(1, 1, background)
            const titleColor = state.mode === "countdown" ? "success" : "accent"
            const bodyLines = createAutomaticUpdateWidgetLines(state)

            box.addChild(
                new Text(
                    `${theme.fg(titleColor, "●")} ${theme.bold(theme.fg("customMessageLabel", PACKAGE_MANAGER_TITLE))}`,
                    0,
                    0,
                ),
            )
            box.addChild(
                new Text(
                    bodyLines
                        .map((line, index) =>
                            theme.fg(
                                index === bodyLines.length - 1 ? "dim" : "text",
                                line,
                            ),
                        )
                        .join("\n"),
                    0,
                    0,
                ),
            )

            return box
        },
        { placement: "aboveEditor" },
    )
}

function clearPackageManagerWidget(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") {
        return
    }

    ctx.ui.setWidget(PACKAGE_MANAGER_WIDGET_KEY, undefined)
}

function formatReportOutput(
    output: string,
    expanded: boolean,
): { text: string; truncated: boolean } {
    const normalizedLines = output.trim().split(/\r?\n/)

    if (expanded || normalizedLines.length <= OUTPUT_PREVIEW_LINE_COUNT) {
        return {
            text: normalizedLines.join("\n"),
            truncated: false,
        }
    }

    return {
        text: normalizedLines.slice(0, OUTPUT_PREVIEW_LINE_COUNT).join("\n"),
        truncated: true,
    }
}

function getExecDisplayOutput(result: ExecResult): string | undefined {
    const stdout = result.stdout.trim()
    const stderr = result.stderr.trim()
    const sections: string[] = []

    if (stdout) {
        sections.push(stdout)
    }

    if (stderr) {
        sections.push(`[stderr]\n${stderr}`)
    }

    return sections.length > 0 ? sections.join("\n\n") : undefined
}

function isAutoUpdateRecordEntry(
    entry: SessionEntry,
): entry is CustomEntry<AutoUpdateRecord> {
    return (
        entry.type === "custom" &&
        entry.customType === AUTO_UPDATE_RECORD_ENTRY_TYPE &&
        isAutoUpdateRecord(entry.data)
    )
}

function isAutoUpdateRecord(value: unknown): value is AutoUpdateRecord {
    if (!value || typeof value !== "object") {
        return false
    }

    const candidate = value as Partial<AutoUpdateRecord>
    return (
        typeof candidate.startedAtUtc === "string" &&
        typeof candidate.endedAtUtc === "string" &&
        (candidate.outcome === "succeeded" ||
            candidate.outcome === "failed" ||
            candidate.outcome === "skipped") &&
        typeof candidate.packagesUpdated === "number" &&
        (candidate.reason === undefined || typeof candidate.reason === "string")
    )
}

function getExecFailureDetail(result: ExecResult): string {
    const stderr = result.stderr.trim()
    const stdout = result.stdout.trim()
    const detail = stderr || stdout || "Package update command failed."

    return detail.length > 400 ? `${detail.slice(0, 397)}...` : detail
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message
    }

    return String(error)
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds)
    })
}
