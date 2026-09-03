import { readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"

import { GREETING_FILE_SUFFIX, STALE_AFTER_MS } from "./constants.ts"
import { inboxPath, mailboxId, mailboxRecordPath } from "./paths.ts"
import type {
    GreetingDisplayRow,
    GreetingPages,
    GreetingResult,
    PreparedGreeting,
} from "./greetings.ts"

export interface PeerRecordFile {
    id: string
    name: string
    cwd: string
    sessionId: string
    state: string
    beatAt: number
    pid?: number
}

export interface PeerDisplayRow {
    id: string
    label: string
    cwd: string
    state: string
    sessionId: string
    isMe: boolean
}

export interface PeerPages {
    current: PeerDisplayRow[]
    other: PeerDisplayRow[]
}

export interface GreetingTarget {
    id: string
    label: string
    cwd: string
    state: string
    sessionId: string
}

export type PeerPresence = "live" | "stalled" | "offline"

export interface CleanupPeerRow extends PeerDisplayRow {
    presence: PeerPresence
    letterCount: number
}

export interface CleanupPeerPages {
    current: CleanupPeerRow[]
    other: CleanupPeerRow[]
}

export interface CleanupPeerResult {
    cleanedIds: string[]
    skipped: Array<{ id: string; reason: string }>
}

export interface CleanupPromptResult {
    selectedIds: string[]
    safeMode: boolean
}

export function parsePeerRecordFile(value: unknown): PeerRecordFile | undefined {
    if (!value || typeof value !== "object") return undefined

    const record = value as Record<string, unknown>
    if (
        typeof record.id !== "string" ||
        typeof record.name !== "string" ||
        typeof record.cwd !== "string" ||
        typeof record.sessionId !== "string" ||
        typeof record.state !== "string" ||
        typeof record.beatAt !== "number"
    ) {
        return undefined
    }

    return {
        id: record.id,
        name: record.name,
        cwd: record.cwd,
        sessionId: record.sessionId,
        state: record.state,
        beatAt: record.beatAt,
        pid: typeof record.pid === "number" ? record.pid : undefined,
    }
}

export function peerLabel(record: Pick<PeerRecordFile, "id" | "name">): string {
    return `${record.name}#${record.id.slice(0, 4)}`
}

export function peerDisplayRowFromRecord(
    record: PeerRecordFile,
    currentMailboxId?: string,
): PeerDisplayRow {
    return {
        id: record.id,
        label: peerLabel(record),
        cwd: record.cwd,
        state: record.state,
        sessionId: record.sessionId,
        isMe: record.id === currentMailboxId,
    }
}

export function greetingTargetFromRecord(record: PeerRecordFile): GreetingTarget {
    return {
        id: record.id,
        label: peerLabel(record),
        cwd: record.cwd,
        state: record.state,
        sessionId: record.sessionId,
    }
}

export async function loadPeerRecordFiles(peersDir: string): Promise<PeerRecordFile[]> {
    let entryNames: string[]
    try {
        entryNames = await readdir(peersDir)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return []
        }
        throw error
    }

    const records: PeerRecordFile[] = []
    for (const entryName of entryNames.sort()) {
        if (!entryName.endsWith(".json")) continue

        const raw = await readFile(join(peersDir, entryName), "utf8")
        const record = parsePeerRecordFile(JSON.parse(raw))
        if (record) {
            records.push(record)
        }
    }

    return records
}

export async function removePeerRecordAndInbox(
    peersDir: string,
    id: string,
): Promise<void> {
    await rm(mailboxRecordPath(peersDir, id), { force: true })
    await rm(inboxPath(peersDir, id), { force: true, recursive: true })
}

export async function countInboxLetters(path: string): Promise<number> {
    try {
        const entries = await readdir(path)
        return entries.filter(
            (name) => name.endsWith(".json") || name.endsWith(GREETING_FILE_SUFFIX),
        ).length
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return 0
        }
        throw error
    }
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
    }
}

export function peerPresence(record: PeerRecordFile, now = Date.now()): PeerPresence {
    if (record.pid === undefined) return "offline"
    if (!pidAlive(record.pid)) return "offline"
    return now - record.beatAt > STALE_AFTER_MS ? "stalled" : "live"
}

export function cleanupBlockReason(
    row: CleanupPeerRow,
    safeMode = true,
): string | undefined {
    if (row.isMe) return "Current session mailbox cannot be cleaned up."
    if (!safeMode) return undefined
    if (row.presence === "live") return "Mailbox is still live."
    if (row.presence === "stalled") {
        return "Mailbox is stalled; only offline mailboxes can be cleaned up."
    }
    if (row.letterCount > 0) {
        return `Mailbox inbox still has ${row.letterCount} pending letter${row.letterCount === 1 ? "" : "s"}.`
    }
    return undefined
}

export function sortPeerRows<T extends PeerDisplayRow>(
    rows: T[],
    currentCwd: string,
): {
    current: T[]
    other: T[]
} {
    const current = rows.filter((row) => row.cwd === currentCwd)
    const other = rows.filter((row) => row.cwd !== currentCwd)
    current.sort(
        (left, right) =>
            Number(right.isMe) - Number(left.isMe) ||
            left.label.localeCompare(right.label),
    )
    other.sort((left, right) => left.label.localeCompare(right.label))
    return { current, other }
}

function greetingDisplayRowFromPrepared(
    prepared: PreparedGreeting,
    currentMailboxId: string,
): GreetingDisplayRow {
    return {
        id: prepared.target.id,
        label: prepared.target.label,
        cwd: prepared.target.cwd,
        state: prepared.target.state,
        sessionId: prepared.target.sessionId,
        isMe: prepared.target.id === currentMailboxId,
        delivery: prepared.delivery,
        reason: prepared.reason,
    }
}

function sortGreetingRows(
    rows: GreetingDisplayRow[],
    currentCwd: string,
): GreetingDisplayRow[] {
    const pages = sortPeerRows(rows, currentCwd)
    return [...pages.current, ...pages.other]
}

export function buildGreetingPages(result: GreetingResult): GreetingPages {
    const currentMailboxId = result.sender.id
    const prepared = sortGreetingRows(
        result.prepared.map((entry) =>
            greetingDisplayRowFromPrepared(entry, currentMailboxId),
        ),
        result.sender.cwd,
    )
    const sent = sortGreetingRows(
        prepared.filter((entry) => entry.delivery !== "skipped"),
        result.sender.cwd,
    )
    const skipped = sortGreetingRows(
        prepared.filter((entry) => entry.delivery === "skipped"),
        result.sender.cwd,
    )
    return {
        prepared,
        sent,
        skipped,
    }
}

export async function loadPeerPages(options: {
    peersDir: string
    currentCwd: string
    currentSessionId?: string
}): Promise<PeerPages> {
    const currentMailboxId = options.currentSessionId
        ? mailboxId(options.currentCwd, options.currentSessionId)
        : undefined
    const rows = (await loadPeerRecordFiles(options.peersDir)).map((record) =>
        peerDisplayRowFromRecord(record, currentMailboxId),
    )
    return sortPeerRows(rows, options.currentCwd)
}

export async function loadCleanupPeerPages(options: {
    peersDir: string
    currentCwd: string
    currentSessionId?: string
}): Promise<CleanupPeerPages> {
    const currentMailboxId = options.currentSessionId
        ? mailboxId(options.currentCwd, options.currentSessionId)
        : undefined
    const rows = await Promise.all(
        (await loadPeerRecordFiles(options.peersDir)).map(async (record) => ({
            ...peerDisplayRowFromRecord(record, currentMailboxId),
            presence: peerPresence(record),
            letterCount: await countInboxLetters(
                inboxPath(options.peersDir, record.id),
            ),
        })),
    )

    return sortPeerRows(rows, options.currentCwd)
}

export async function cleanUpPeers(options: {
    peersDir: string
    selectedIds: string[]
    currentCwd: string
    currentSessionId?: string
    safeMode?: boolean
}): Promise<CleanupPeerResult> {
    const currentMailboxId = options.currentSessionId
        ? mailboxId(options.currentCwd, options.currentSessionId)
        : undefined
    const cleanedIds: string[] = []
    const skipped: Array<{ id: string; reason: string }> = []

    for (const id of options.selectedIds) {
        let raw: string
        try {
            raw = await readFile(mailboxRecordPath(options.peersDir, id), "utf8")
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                skipped.push({ id, reason: "Mailbox record is already gone." })
                continue
            }
            throw error
        }

        const record = parsePeerRecordFile(JSON.parse(raw))
        if (!record) {
            skipped.push({ id, reason: "Mailbox record is invalid." })
            continue
        }

        const row: CleanupPeerRow = {
            ...peerDisplayRowFromRecord(record, currentMailboxId),
            presence: peerPresence(record),
            letterCount: await countInboxLetters(
                inboxPath(options.peersDir, record.id),
            ),
        }
        const reason = cleanupBlockReason(row, options.safeMode ?? true)
        if (reason) {
            skipped.push({ id, reason })
            continue
        }

        await removePeerRecordAndInbox(options.peersDir, id)
        cleanedIds.push(id)
    }

    return { cleanedIds, skipped }
}
