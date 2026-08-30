export const AUTO_UPDATE_RECORD_ENTRY_TYPE = "package-manager-auto-update-record"
export const REPORT_ENTRY_TYPE = "package-manager-report"
export const PACKAGE_MANAGER_TITLE = "Pi Package Manager"
export const PACKAGE_MANAGER_WIDGET_KEY = "pi-package-manager"
export const RELOAD_COUNTDOWN_SECONDS = 5
export const OUTPUT_PREVIEW_LINE_COUNT = 8
export const UPDATE_COMMAND = ["update", "--extensions"] as const

export type AutoUpdateOutcome = "succeeded" | "failed" | "skipped"
export type ReportTone = "info" | "success" | "warning" | "error"

export type WidgetState =
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
