import {
    keyText,
    type ExtensionContext,
    type ExecResult,
} from "@earendil-works/pi-coding-agent"
import { Box, Text } from "@earendil-works/pi-tui"

import {
    OUTPUT_PREVIEW_LINE_COUNT,
    PACKAGE_MANAGER_TITLE,
    PACKAGE_MANAGER_WIDGET_KEY,
    type AutoUpdateOutcome,
    type AutoUpdateRecord,
    type InstallOutcome,
    type PackageManagerReport,
    type PackageStatusSnapshot,
    type WidgetState,
} from "./model.ts"

interface ThemeLike {
    fg(token: string, text: string): string
    bg(token: string, text: string): string
    bold(text: string): string
}

export function createReportEntryRenderer() {
    return (
        entry: { data?: PackageManagerReport },
        { expanded }: { expanded: boolean },
        theme: ThemeLike,
    ) => {
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

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text))

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
                    report.lines.map((line) => theme.fg(lineTextTone, line)).join("\n"),
                    0,
                    0,
                ),
            )
        }

        if (report.output?.trim()) {
            if (!expanded && report.hideOutputWhenCollapsed) {
                box.addChild(
                    new Text(
                        formatExpandHint(
                            theme,
                            `to expand to see ${report.outputDescription ?? "output"}.`,
                        ),
                        0,
                        0,
                    ),
                )
            } else {
                const { text, truncated } = formatReportOutput(report.output, expanded)

                box.addChild(
                    new Text(
                        theme.fg(outputTextTone, report.outputLabel ?? "Output:"),
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
                                `to expand to view the full ${report.outputDescription ?? "output"}.`,
                            ),
                            0,
                            0,
                        ),
                    )
                }
            }
        }

        return box
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

export function createStatusErrorReport(
    snapshot: PackageStatusSnapshot,
    errorMessage: string,
): PackageManagerReport {
    return {
        title: PACKAGE_MANAGER_TITLE,
        headline: "Package status check failed.",
        tone: "error",
        lines: formatStatusLines(snapshot),
        lineTone: "dim",
        output: `Failed to check package updates: ${errorMessage}`,
        outputLabel: "Error detail:",
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
        outputLabel: "Update output:",
        outputDescription: "update output",
        outputTone: "dim",
        hideOutputWhenCollapsed: true,
    }
}

export function createInstallResultReport(input: {
    startedAtUtc: string
    endedAtUtc: string
    source: string
    outcome: InstallOutcome
    output?: string
    reason?: string
}): PackageManagerReport {
    return {
        title: PACKAGE_MANAGER_TITLE,
        headline:
            input.outcome === "succeeded"
                ? "Pi package install completed."
                : "Pi package install failed.",
        tone: input.outcome === "succeeded" ? "success" : "error",
        lines: [
            `Start: ${formatUtcTimestamp(input.startedAtUtc)}`,
            `End: ${formatUtcTimestamp(input.endedAtUtc)}`,
            `Result: ${input.outcome}`,
            `Package source: ${input.source}`,
            ...(input.outcome === "succeeded"
                ? ["Run /reload to activate installed package resources."]
                : []),
        ],
        lineTone: "dim",
        output: input.output ?? input.reason,
        outputLabel:
            input.outcome === "succeeded" ? "Install output:" : "Error detail:",
        outputDescription:
            input.outcome === "succeeded" ? "install output" : "error detail",
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

    if (state.mode === "package-installing") {
        return [
            "Pi package install in progress.",
            `Installing package from ${state.source}...`,
        ]
    }

    return [
        formatAutomaticUpdateHeadline("succeeded"),
        `Reloading in ${state.secondsRemaining} second${state.secondsRemaining === 1 ? "" : "s"} to activate updated package resources.`,
    ]
}

export function setPackageManagerWidget(
    ctx: ExtensionContext,
    state: WidgetState,
): void {
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

export function clearPackageManagerWidget(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") {
        return
    }

    ctx.ui.setWidget(PACKAGE_MANAGER_WIDGET_KEY, undefined)
}

export function getExecDisplayOutput(result: ExecResult): string | undefined {
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

export function getExecFailureDetail(result: ExecResult): string {
    const stderr = result.stderr.trim()
    const stdout = result.stdout.trim()
    const detail = stderr || stdout || "Package update command failed."

    return detail.length > 400 ? `${detail.slice(0, 397)}...` : detail
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

function formatExpandHint(theme: ThemeLike, description: string): string {
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
