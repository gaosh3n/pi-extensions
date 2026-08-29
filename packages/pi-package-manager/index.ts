import {
    DefaultPackageManager,
    getAgentDir,
    keyText,
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
    | { mode: "status-checking" }
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
    headline?: string
    tone: ReportTone
    lines: string[]
    lineTone?: "default" | "dim"
    output?: string
    outputLabel?: string
    outputTone?: "default" | "dim"
    hideOutputWhenCollapsed?: boolean
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
            const lineTextTone = report.lineTone === "dim" ? "dim" : "customMessageText"
            const outputTextTone = report.outputTone === "dim" ? "dim" : lineTextTone

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

            if (report.headline) {
                box.addChild(new Text(theme.fg("text", report.headline), 0, 0))
            }

            if (report.lines.length > 0) {
                box.addChild(
                    new Text(
                        report.lines
                            .map((line) => theme.fg(lineTextTone, line))
                            .join("\n"),
                        0,
                        0,
                    ),
                )
            }

            if (report.output?.trim()) {
                if (!expanded && report.hideOutputWhenCollapsed) {
                    box.addChild(
                        new Text(
                            formatExpandHint(theme, "to expand to see update output."),
                            0,
                            0,
                        ),
                    )
                } else {
                    const { text, truncated } = formatReportOutput(
                        report.output,
                        expanded,
                    )

                    box.addChild(
                        new Text(
                            theme.fg(
                                outputTextTone,
                                report.outputLabel ?? "Update output:",
                            ),
                            0,
                            0,
                        ),
                    )
                    box.addChild(new Text(theme.fg(outputTextTone, text), 0, 0))

                    if (truncated) {
                        box.addChild(
                            new Text(
                                formatExpandHint(
                                    theme,
                                    "to expand to view the full update output.",
                                ),
                                0,
                                0,
                            ),
                        )
                    }
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
                const result = await runUpdate(pi, ctx, {
                    startupTriggered: tokens.includes("--startup"),
                })

                lastAutoUpdateRecord = result.autoUpdateRecord
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
    if (!snapshot.lastAutoUpdate) {
        return ["Latest package update: none recorded."]
    }

    const lines = [
        `Latest update start: ${formatUtcTimestamp(snapshot.lastAutoUpdate.startedAtUtc)}`,
        `Latest update end: ${formatUtcTimestamp(snapshot.lastAutoUpdate.endedAtUtc)}`,
        `Latest update result: ${snapshot.lastAutoUpdate.outcome}`,
        `Latest update packages updated: ${snapshot.lastAutoUpdate.packagesUpdated}`,
    ]

    if (snapshot.lastAutoUpdate.reason) {
        lines.push(`Latest update detail: ${snapshot.lastAutoUpdate.reason}`)
    }

    return lines
}

export function createStatusReport(
    snapshot: PackageStatusSnapshot,
): PackageManagerReport {
    return {
        title: PACKAGE_MANAGER_TITLE,
        headline:
            snapshot.availableUpdates.length === 0
                ? "No package updates are available."
                : `${snapshot.availableUpdates.length} package update${snapshot.availableUpdates.length === 1 ? " is" : "s are"} available.`,
        tone: snapshot.availableUpdates.length > 0 ? "warning" : "info",
        lines: formatStatusLines(snapshot),
        lineTone: "dim",
        output:
            snapshot.availableUpdates.length > 0
                ? snapshot.availableUpdates.map((name) => `- ${name}`).join("\n")
                : undefined,
        outputLabel:
            snapshot.availableUpdates.length > 0 ? "Available updates:" : undefined,
        outputTone: "dim",
    }
}

export function createAutoUpdateResultReport(input: {
    record: AutoUpdateRecord
    output?: string
    reloadAfterSeconds?: number
}): PackageManagerReport {
    const lines = [
        `Start: ${formatUtcTimestamp(input.record.startedAtUtc)}`,
        `End: ${formatUtcTimestamp(input.record.endedAtUtc)}`,
        `Result: ${input.record.outcome}`,
        `Packages updated: ${input.record.packagesUpdated}`,
    ]

    if (input.reloadAfterSeconds) {
        lines.push(
            `Reloading in ${input.reloadAfterSeconds} seconds to activate updated package resources.`,
        )
    }

    return {
        title: PACKAGE_MANAGER_TITLE,
        headline: formatAutomaticUpdateHeadline(input.record.outcome),
        tone:
            input.record.outcome === "failed"
                ? "error"
                : input.record.outcome === "succeeded"
                  ? "success"
                  : "info",
        lines,
        lineTone: "dim",
        output: input.output ?? input.record.reason,
        outputTone: "dim",
        hideOutputWhenCollapsed: true,
    }
}

export function createAutomaticUpdateWidgetLines(state: WidgetState): string[] {
    if (state.mode === "status-checking") {
        return ["Pi package status in progress.", "Checking for package updates..."]
    }

    if (state.mode === "checking") {
        return [
            formatAutomaticUpdateHeadline("in-progress"),
            "Checking for package updates...",
        ]
    }

    if (state.mode === "installing") {
        return [
            formatAutomaticUpdateHeadline("in-progress"),
            `Installing ${state.packages} package update${state.packages === 1 ? "" : "s"}...`,
        ]
    }

    return [
        formatAutomaticUpdateHeadline("succeeded"),
        `Reloading in ${state.secondsRemaining} second${state.secondsRemaining === 1 ? "" : "s"} to activate updated package resources.`,
    ]
}

function formatAutomaticUpdateHeadline(
    state: AutoUpdateOutcome | "in-progress",
): string {
    const suffix =
        state === "in-progress"
            ? "in progress"
            : state === "succeeded"
              ? "completed"
              : state

    return `Pi package(s) update ${suffix}.`
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
    setPackageManagerWidget(ctx, { mode: "status-checking" })

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
        pi.appendEntry(REPORT_ENTRY_TYPE, {
            title: PACKAGE_MANAGER_TITLE,
            headline: "Package status check failed.",
            tone: "error",
            lines: formatStatusLines({
                availableUpdates: [],
                lastAutoUpdate: lastAutoUpdateRecord,
            }),
            lineTone: "dim",
            output: `Failed to check package updates: ${getErrorMessage(error)}`,
            outputLabel: "Error detail:",
            outputTone: "dim",
        })
    } finally {
        clearPackageManagerWidget(ctx)
    }
}

async function runUpdate(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    options: { startupTriggered: boolean },
): Promise<{ autoUpdateRecord: AutoUpdateRecord }> {
    const startedAtUtc = new Date().toISOString()
    let shouldClearWidget = true

    setPackageManagerWidget(ctx, { mode: "checking" })

    try {
        if (process.env.PI_OFFLINE) {
            const record = createAutoUpdateRecord({
                startedAtUtc,
                endedAtUtc: new Date().toISOString(),
                outcome: "skipped",
                packagesUpdated: 0,
                reason: "PI_OFFLINE is set.",
            })

            pi.appendEntry(AUTO_UPDATE_RECORD_ENTRY_TYPE, record)
            pi.appendEntry(REPORT_ENTRY_TYPE, createAutoUpdateResultReport({ record }))
            return { autoUpdateRecord: record }
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

            pi.appendEntry(AUTO_UPDATE_RECORD_ENTRY_TYPE, record)
            pi.appendEntry(REPORT_ENTRY_TYPE, createAutoUpdateResultReport({ record }))
            return { autoUpdateRecord: record }
        }

        setPackageManagerWidget(ctx, {
            mode: "installing",
            packages: availableUpdates.length,
        })

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
            shouldClearWidget = false
            await ctx.reload()
            return { autoUpdateRecord: record }
        }

        const record = createAutoUpdateRecord({
            startedAtUtc,
            endedAtUtc: new Date().toISOString(),
            outcome: "failed",
            packagesUpdated: 0,
            reason: getExecFailureDetail(result),
        })

        pi.appendEntry(AUTO_UPDATE_RECORD_ENTRY_TYPE, record)
        pi.appendEntry(
            REPORT_ENTRY_TYPE,
            createAutoUpdateResultReport({ record, output }),
        )

        if (options.startupTriggered && ctx.hasUI) {
            ctx.ui.notify(
                "Pi Package Manager automatic startup update failed. See transcript for details.",
                "error",
            )
        }

        return { autoUpdateRecord: record }
    } catch (error) {
        const record = createAutoUpdateRecord({
            startedAtUtc,
            endedAtUtc: new Date().toISOString(),
            outcome: "failed",
            packagesUpdated: 0,
            reason: getErrorMessage(error),
        })

        pi.appendEntry(AUTO_UPDATE_RECORD_ENTRY_TYPE, record)
        pi.appendEntry(REPORT_ENTRY_TYPE, createAutoUpdateResultReport({ record }))

        if (options.startupTriggered && ctx.hasUI) {
            ctx.ui.notify(
                "Pi Package Manager automatic startup update failed. See transcript for details.",
                "error",
            )
        }

        return { autoUpdateRecord: record }
    } finally {
        if (shouldClearWidget) {
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

function formatExpandHint(
    theme: { fg(token: string, text: string): string },
    description: string,
): string {
    const expandKey = keyText("app.tools.expand") || "Ctrl+O"

    return `${theme.fg("dim", expandKey)}${theme.fg("muted", ` ${description}`)}`
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
