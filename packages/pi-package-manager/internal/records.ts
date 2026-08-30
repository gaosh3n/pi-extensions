import {
    type CustomEntry,
    type ExtensionAPI,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent"

import {
    AUTO_UPDATE_RECORD_ENTRY_TYPE,
    REPORT_ENTRY_TYPE,
    type AutoUpdateOutcome,
    type AutoUpdateRecord,
    type PackageManagerReport,
} from "./model.ts"

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

export function appendAutoUpdateRecordAndReport(
    pi: Pick<ExtensionAPI, "appendEntry">,
    record: AutoUpdateRecord,
    report: PackageManagerReport,
): void {
    pi.appendEntry(AUTO_UPDATE_RECORD_ENTRY_TYPE, record)
    pi.appendEntry(REPORT_ENTRY_TYPE, report)
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

export function isAutoUpdateRecordEntry(
    entry: SessionEntry,
): entry is CustomEntry<AutoUpdateRecord> {
    return (
        entry.type === "custom" &&
        entry.customType === AUTO_UPDATE_RECORD_ENTRY_TYPE &&
        isAutoUpdateRecord(entry.data)
    )
}

export function isAutoUpdateRecord(value: unknown): value is AutoUpdateRecord {
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
