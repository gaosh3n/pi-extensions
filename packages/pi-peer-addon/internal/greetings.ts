import { watch, type FSWatcher } from "node:fs"
import {
    access,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    writeFile,
} from "node:fs/promises"
import { join } from "node:path"

import {
    GREETING_FILE_SUFFIX,
    GREETING_WATCH_DEBOUNCE_MS,
    GREETING_WATCH_POLL_MS,
    MAX_LETTER_BYTES,
} from "./constants.ts"
import {
    greetingLetterPath,
    greetingReadyMarkerPath,
    inboxPath,
    mailboxId,
} from "./paths.ts"
import type { GreetingTarget, PeerDisplayRow } from "./peers.ts"
import { greetingTargetFromRecord, loadPeerRecordFiles } from "./peers.ts"

export interface PeerLetter {
    fromId: string
    fromName: string
    fromCwd: string
    text: string
    sentAt: number
}

export interface GreetingMailboxLetter extends PeerLetter {
    kind: "peer-addon-greeting"
}

export interface GreetingMessageDetails {
    fromName: string
    fromCwd: string
    sentAt: number
}

export interface PreparedGreeting {
    target: GreetingTarget
    message: string
    delivery: "local" | "sent" | "skipped"
    reason?: string
}

export interface GreetingResult {
    sender: GreetingTarget
    prepared: PreparedGreeting[]
    sent: GreetingTarget[]
    skipped: Array<{ target: GreetingTarget; reason: string }>
}

export interface GreetingDisplayRow extends PeerDisplayRow {
    delivery: PreparedGreeting["delivery"]
    reason?: string
}

export interface GreetingPages {
    prepared: GreetingDisplayRow[]
    sent: GreetingDisplayRow[]
    skipped: GreetingDisplayRow[]
}

export interface GreetingInboxWatch {
    close(): void
}

export function formatGreetingMessage(sender: GreetingTarget): string {
    return [
        `Hi, as a Pi peer, my name is ${sender.label}`,
        `- id: ${sender.id}`,
        `- cwd: ${sender.cwd}`,
        `- state: ${sender.state}`,
        `- sessionId: ${sender.sessionId}`,
    ].join("\n")
}

function createGreetingLetter(
    sender: GreetingTarget,
    text: string,
    sentAt: number,
): PeerLetter {
    return {
        fromId: sender.id,
        fromName: sender.label,
        fromCwd: sender.cwd,
        text,
        sentAt,
    }
}

function createGreetingMailboxLetter(
    sender: GreetingTarget,
    text: string,
    sentAt: number,
): GreetingMailboxLetter {
    return {
        kind: "peer-addon-greeting",
        ...createGreetingLetter(sender, text, sentAt),
    }
}

export function parseGreetingMailboxLetter(
    value: unknown,
): GreetingMailboxLetter | undefined {
    if (!value || typeof value !== "object") return undefined

    const record = value as Record<string, unknown>
    if (
        record.kind !== "peer-addon-greeting" ||
        typeof record.fromId !== "string" ||
        typeof record.fromName !== "string" ||
        typeof record.fromCwd !== "string" ||
        typeof record.text !== "string" ||
        typeof record.sentAt !== "number"
    ) {
        return undefined
    }

    return {
        kind: "peer-addon-greeting",
        fromId: record.fromId,
        fromName: record.fromName,
        fromCwd: record.fromCwd,
        text: record.text,
        sentAt: record.sentAt,
    }
}

export function sealPeerLetter(letter: PeerLetter): string {
    const body = `${JSON.stringify(letter)}\n`
    const envelopeBytes =
        Buffer.byteLength(body, "utf8") - Buffer.byteLength(letter.text, "utf8")
    const limitBytes = MAX_LETTER_BYTES - envelopeBytes
    const textBytes = Buffer.byteLength(letter.text, "utf8")
    if (textBytes > limitBytes) {
        throw new Error(
            `Message is ${textBytes} bytes; the limit is ${limitBytes}. Send a summary, or write the detail to a file and name the path.`,
        )
    }
    return body
}

export async function advertiseGreetingReceiver(options: {
    peersDir: string
    currentMailboxId: string
}): Promise<void> {
    await mkdir(inboxPath(options.peersDir, options.currentMailboxId), {
        recursive: true,
        mode: 0o700,
    })
    await writeFile(
        greetingReadyMarkerPath(options.peersDir, options.currentMailboxId),
        "ready\n",
        {
            encoding: "utf8",
            mode: 0o600,
        },
    )
}

export async function greetingReceiverReady(options: {
    peersDir: string
    toId: string
}): Promise<boolean> {
    try {
        await access(greetingReadyMarkerPath(options.peersDir, options.toId))
        return true
    } catch {
        return false
    }
}

export async function depositGreetingMailboxLetter(options: {
    peersDir: string
    toId: string
    letter: GreetingMailboxLetter
}): Promise<void> {
    const inbox = inboxPath(options.peersDir, options.toId)
    await access(inbox)

    const body = sealPeerLetter(options.letter)
    const target = greetingLetterPath(inbox, options.letter.sentAt)
    const temp = `${target}.tmp`
    await writeFile(temp, body, { encoding: "utf8", mode: 0o600 })
    await rename(temp, target)
}

async function drainGreetingMailboxLetters(
    inbox: string,
): Promise<GreetingMailboxLetter[]> {
    let entryNames: string[]
    try {
        entryNames = await readdir(inbox)
    } catch {
        return []
    }

    const letters: GreetingMailboxLetter[] = []
    for (const entryName of entryNames
        .filter((name) => name.endsWith(GREETING_FILE_SUFFIX))
        .sort()) {
        const path = join(inbox, entryName)
        let raw: string
        try {
            raw = await readFile(path, "utf8")
        } catch {
            continue
        }

        await rm(path, { force: true })

        let parsed: unknown
        try {
            parsed = JSON.parse(raw)
        } catch {
            continue
        }

        const letter = parseGreetingMailboxLetter(parsed)
        if (letter) {
            letters.push(letter)
        }
    }

    return letters
}

export function watchGreetingInbox(options: {
    peersDir: string
    mailboxId: string
    onLetters: (letters: GreetingMailboxLetter[]) => void
}): GreetingInboxWatch {
    const inbox = inboxPath(options.peersDir, options.mailboxId)
    let watcher: FSWatcher | undefined
    let pending: ReturnType<typeof setTimeout> | undefined
    let running = false
    let rerunRequested = false
    let closed = false

    const run = async (): Promise<void> => {
        if (closed) return
        if (running) {
            rerunRequested = true
            return
        }

        running = true
        try {
            for (;;) {
                rerunRequested = false
                const letters = await drainGreetingMailboxLetters(inbox)
                if (letters.length > 0) {
                    options.onLetters(letters)
                }
                if (closed || !rerunRequested) {
                    break
                }
            }
        } finally {
            running = false
        }
    }

    const schedule = (): void => {
        if (closed || pending) return
        pending = setTimeout(() => {
            pending = undefined
            void run()
        }, GREETING_WATCH_DEBOUNCE_MS)
        pending.unref?.()
    }

    void mkdir(inbox, { recursive: true, mode: 0o700 })
        .then(() => {
            if (closed) return
            try {
                watcher = watch(inbox, schedule)
                watcher.on("error", () => {})
            } catch {
                watcher = undefined
            }
            schedule()
        })
        .catch(() => {})

    const timer = setInterval(schedule, GREETING_WATCH_POLL_MS)
    timer.unref?.()

    return {
        close() {
            closed = true
            if (pending) {
                clearTimeout(pending)
            }
            clearInterval(timer)
            watcher?.close()
        },
    }
}

export async function sendPeerGreetings(options: {
    peersDir: string
    currentCwd: string
    currentSessionId?: string
}): Promise<GreetingResult> {
    if (!options.currentSessionId) {
        throw new Error(
            "Current session id is unavailable. Make sure pi-peer is installed and this session is registered.",
        )
    }

    const currentMailboxId = mailboxId(options.currentCwd, options.currentSessionId)
    const records = await loadPeerRecordFiles(options.peersDir)
    const senderRecord = records.find((record) => record.id === currentMailboxId)
    if (!senderRecord) {
        throw new Error(
            "Current Pi peer record was not found. Make sure pi-peer is installed and this session has registered itself.",
        )
    }

    const sender = greetingTargetFromRecord(senderRecord)
    const prepared: PreparedGreeting[] = []
    const sent: GreetingTarget[] = []
    const skipped: Array<{ target: GreetingTarget; reason: string }> = []

    for (const record of records) {
        const target = greetingTargetFromRecord(record)
        const message = formatGreetingMessage(target)

        if (record.id === sender.id) {
            prepared.push({ target, message, delivery: "local" })
            continue
        }

        try {
            if (
                !(await greetingReceiverReady({
                    peersDir: options.peersDir,
                    toId: target.id,
                }))
            ) {
                throw new Error(
                    "Peer greeting receiver is unavailable for this session.",
                )
            }

            await depositGreetingMailboxLetter({
                peersDir: options.peersDir,
                toId: target.id,
                letter: createGreetingMailboxLetter(sender, message, Date.now()),
            })
            prepared.push({ target, message, delivery: "sent" })
            sent.push(target)
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            const reason =
                code === "ENOENT"
                    ? "Inbox directory is missing."
                    : error instanceof Error
                      ? error.message
                      : String(error)
            prepared.push({
                target,
                message,
                delivery: "skipped",
                reason,
            })
            skipped.push({ target, reason })
        }
    }

    return { sender, prepared, sent, skipped }
}
