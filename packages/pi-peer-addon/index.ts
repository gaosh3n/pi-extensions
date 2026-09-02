import { createHash, randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
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

import {
    DynamicBorder,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type Theme,
} from "@earendil-works/pi-coding-agent"
import {
    Container,
    Key,
    SelectList,
    Text,
    type Component,
    type SelectItem,
    type TUI,
    matchesKey,
} from "@earendil-works/pi-tui"

export const PEER_ADDON_COMMAND = "peer-addon"
export const LIST_PEERS_SUBCOMMAND = "list-peers"
export const CLEAN_UP_PEERS_SUBCOMMAND = "clean-up-peers"
export const INTRODUCE_PEERS_SUBCOMMAND = "introduce-peers"

const STALE_AFTER_MS = 45_000
const MAX_LETTER_BYTES = 32 * 1024
const GREETING_MESSAGE_TYPE = "peer-addon:greeting"
const GREETING_FILE_SUFFIX = ".peer-addon-greeting"
const GREETING_READY_MARKER = ".peer-addon-greetings-ready"
const GREETING_WATCH_DEBOUNCE_MS = 25
const GREETING_WATCH_POLL_MS = 3_000

type PeerTabKey = "current" | "other"
type GreetingTabKey = "prepared" | "sent" | "skipped"

type PeerLoadState =
    | { kind: "loading" }
    | { kind: "ready"; pages: PeerPages }
    | { kind: "error"; message: string }

type CleanupLoadState =
    | { kind: "loading" }
    | { kind: "ready"; pages: CleanupMailboxPages }
    | { kind: "error"; message: string }

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

type MailboxPresence = "live" | "stalled" | "offline"

export interface CleanupMailboxRow extends PeerDisplayRow {
    presence: MailboxPresence
    letterCount: number
}

export interface CleanupMailboxPages {
    current: CleanupMailboxRow[]
    other: CleanupMailboxRow[]
}

interface CleanupMailboxResult {
    cleanedIds: string[]
    skipped: Array<{ id: string; reason: string }>
}

interface GreetingTarget {
    id: string
    label: string
    cwd: string
    state: string
    sessionId: string
}

interface PreparedGreeting {
    target: GreetingTarget
    message: string
    delivery: "local" | "sent" | "skipped"
    reason?: string
}

interface GreetingResult {
    sender: GreetingTarget
    prepared: PreparedGreeting[]
    sent: GreetingTarget[]
    skipped: Array<{ target: GreetingTarget; reason: string }>
}

interface GreetingDisplayRow extends PeerDisplayRow {
    delivery: PreparedGreeting["delivery"]
    reason?: string
}

interface GreetingPages {
    prepared: GreetingDisplayRow[]
    sent: GreetingDisplayRow[]
    skipped: GreetingDisplayRow[]
}

interface PeerLetter {
    fromId: string
    fromName: string
    fromCwd: string
    text: string
    sentAt: number
}

interface GreetingMailboxLetter extends PeerLetter {
    kind: "peer-addon-greeting"
}

interface GreetingMessageDetails {
    fromName: string
    fromCwd: string
    sentAt: number
}

interface GreetingInboxWatch {
    close(): void
}

type GreetingLoadState =
    | { kind: "loading" }
    | { kind: "ready"; result: GreetingResult }
    | { kind: "error"; message: string }

interface PeerSelectItem extends SelectItem {
    peer?: PeerDisplayRow
    mailbox?: CleanupMailboxRow
    greeting?: GreetingDisplayRow
}

function normalizeSubcommand(args: string): string {
    return args.trim()
}

function defaultPeersDir(): string {
    return process.env.PI_PEER_DIR ?? join(homedir(), ".pi", "agent", "peers")
}

function mailboxId(cwd: string, sessionId: string): string {
    return createHash("sha256")
        .update(`${cwd}\0${sessionId}`)
        .digest("hex")
        .slice(0, 12)
}

function mailboxRecordPath(peersDir: string, id: string): string {
    return join(peersDir, `${id}.json`)
}

function inboxPath(peersDir: string, id: string): string {
    return join(peersDir, `${id}.inbox`)
}

function greetingReadyMarkerPath(peersDir: string, id: string): string {
    return join(inboxPath(peersDir, id), GREETING_READY_MARKER)
}

function greetingLetterPath(inbox: string, sentAt: number): string {
    return join(
        inbox,
        `${sentAt.toString().padStart(14, "0")}-${randomBytes(4).toString("hex")}${GREETING_FILE_SUFFIX}`,
    )
}

function parsePeerRecordFile(value: unknown): PeerRecordFile | undefined {
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

function peerLabel(record: Pick<PeerRecordFile, "id" | "name">): string {
    return `${record.name}#${record.id.slice(0, 4)}`
}

function peerDisplayRowFromRecord(
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

function greetingTargetFromRecord(record: PeerRecordFile): GreetingTarget {
    return {
        id: record.id,
        label: peerLabel(record),
        cwd: record.cwd,
        state: record.state,
        sessionId: record.sessionId,
    }
}

function sortPeerRows<T extends PeerDisplayRow>(
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

function buildGreetingPages(result: GreetingResult): GreetingPages {
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

async function loadPeerRecordFiles(peersDir: string): Promise<PeerRecordFile[]> {
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

async function loadPeerPages(options: {
    peersDir?: string
    currentCwd: string
    currentSessionId?: string
}): Promise<PeerPages> {
    const peersDir = options.peersDir ?? defaultPeersDir()
    const currentMailboxId = options.currentSessionId
        ? mailboxId(options.currentCwd, options.currentSessionId)
        : undefined
    const rows = (await loadPeerRecordFiles(peersDir)).map((record) =>
        peerDisplayRowFromRecord(record, currentMailboxId),
    )
    return sortPeerRows(rows, options.currentCwd)
}

function formatGreetingMessage(sender: GreetingTarget): string {
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

function parseGreetingMailboxLetter(value: unknown): GreetingMailboxLetter | undefined {
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

function sealPeerLetter(letter: PeerLetter): string {
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

async function advertiseGreetingReceiver(options: {
    peersDir?: string
    currentCwd: string
    currentSessionId?: string
}): Promise<void> {
    if (!options.currentSessionId) return

    const peersDir = options.peersDir ?? defaultPeersDir()
    const id = mailboxId(options.currentCwd, options.currentSessionId)
    await mkdir(inboxPath(peersDir, id), { recursive: true, mode: 0o700 })
    await writeFile(greetingReadyMarkerPath(peersDir, id), "ready\n", {
        encoding: "utf8",
        mode: 0o600,
    })
}

async function greetingReceiverReady(options: {
    peersDir?: string
    toId: string
}): Promise<boolean> {
    try {
        await access(
            greetingReadyMarkerPath(
                options.peersDir ?? defaultPeersDir(),
                options.toId,
            ),
        )
        return true
    } catch {
        return false
    }
}

async function depositGreetingMailboxLetter(options: {
    peersDir?: string
    toId: string
    letter: GreetingMailboxLetter
}): Promise<void> {
    const peersDir = options.peersDir ?? defaultPeersDir()
    const inbox = inboxPath(peersDir, options.toId)
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

function watchGreetingInbox(options: {
    peersDir?: string
    mailboxId: string
    onLetters: (letters: GreetingMailboxLetter[]) => void
}): GreetingInboxWatch {
    const peersDir = options.peersDir ?? defaultPeersDir()
    const inbox = inboxPath(peersDir, options.mailboxId)
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

async function sendPeerGreetings(options: {
    peersDir?: string
    currentCwd: string
    currentSessionId?: string
}): Promise<GreetingResult> {
    const peersDir = options.peersDir ?? defaultPeersDir()
    if (!options.currentSessionId) {
        throw new Error(
            "Current session id is unavailable. Make sure pi-peer is installed and this session is registered.",
        )
    }

    const currentMailboxId = mailboxId(options.currentCwd, options.currentSessionId)
    const records = await loadPeerRecordFiles(peersDir)
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
            if (!(await greetingReceiverReady({ peersDir, toId: target.id }))) {
                throw new Error(
                    "Peer greeting receiver is unavailable for this session.",
                )
            }

            await depositGreetingMailboxLetter({
                peersDir,
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

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
    }
}

function mailboxPresence(record: PeerRecordFile, now = Date.now()): MailboxPresence {
    if (record.pid === undefined) return "offline"
    if (!pidAlive(record.pid)) return "offline"
    return now - record.beatAt > STALE_AFTER_MS ? "stalled" : "live"
}

async function countInboxLetters(path: string): Promise<number> {
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

async function loadCleanupMailboxPages(options: {
    peersDir?: string
    currentCwd: string
    currentSessionId?: string
}): Promise<CleanupMailboxPages> {
    const peersDir = options.peersDir ?? defaultPeersDir()
    const currentMailboxId = options.currentSessionId
        ? mailboxId(options.currentCwd, options.currentSessionId)
        : undefined
    const rows = await Promise.all(
        (await loadPeerRecordFiles(peersDir)).map(async (record) => ({
            ...peerDisplayRowFromRecord(record, currentMailboxId),
            presence: mailboxPresence(record),
            letterCount: await countInboxLetters(inboxPath(peersDir, record.id)),
        })),
    )

    return sortPeerRows(rows, options.currentCwd)
}

function mailboxCleanupBlockReason(row: CleanupMailboxRow): string | undefined {
    if (row.isMe) return "Current session mailbox cannot be cleaned up."
    if (row.presence === "live") return "Mailbox is still live."
    if (row.presence === "stalled") {
        return "Mailbox is stalled; only offline mailboxes can be cleaned up."
    }
    if (row.letterCount > 0) {
        return `Mailbox inbox still has ${row.letterCount} pending letter${row.letterCount === 1 ? "" : "s"}.`
    }
    return undefined
}

async function removeMailboxById(peersDir: string, id: string): Promise<void> {
    await rm(mailboxRecordPath(peersDir, id), { force: true })
    await rm(inboxPath(peersDir, id), { force: true, recursive: true })
}

async function cleanUpMailboxes(options: {
    peersDir?: string
    selectedIds: string[]
    currentCwd: string
    currentSessionId?: string
}): Promise<CleanupMailboxResult> {
    const peersDir = options.peersDir ?? defaultPeersDir()
    const currentMailboxId = options.currentSessionId
        ? mailboxId(options.currentCwd, options.currentSessionId)
        : undefined
    const cleanedIds: string[] = []
    const skipped: Array<{ id: string; reason: string }> = []

    for (const id of options.selectedIds) {
        let raw: string
        try {
            raw = await readFile(mailboxRecordPath(peersDir, id), "utf8")
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

        const row: CleanupMailboxRow = {
            ...peerDisplayRowFromRecord(record, currentMailboxId),
            presence: mailboxPresence(record),
            letterCount: await countInboxLetters(inboxPath(peersDir, record.id)),
        }
        const reason = mailboxCleanupBlockReason(row)
        if (reason) {
            skipped.push({ id, reason })
            continue
        }

        await removeMailboxById(peersDir, id)
        cleanedIds.push(id)
    }

    return { cleanedIds, skipped }
}

function createPlaceholderItem(label: string, description: string): PeerSelectItem {
    return {
        value: `${label}\0${description}`,
        label,
        description,
    }
}

function formatPeerState(state: string): string {
    return `[${state}]`
}

function formatPeerListLabel(peer: PeerDisplayRow): string {
    return peer.isMe ? `${peer.label} [me]` : peer.label
}

function formatMailboxListLabel(row: CleanupMailboxRow): string {
    return row.isMe ? `${row.label} [me]` : row.label
}

function formatTabLabel(
    label: string,
    count: number,
    isActive: boolean,
    theme: Theme,
): string {
    const text = `${label} (${count})`
    if (!isActive) {
        return theme.fg("dim", text)
    }

    return theme.fg("accent", theme.bold(`› ${text} ‹`))
}

function dimIfUnselected(text: string, isSelected: boolean, theme: Theme): string {
    return isSelected ? text : theme.fg("dim", text)
}

function createPeerSelectItems(
    peers: PeerDisplayRow[],
    selectedPeerId: string | undefined,
    theme: Theme,
): PeerSelectItem[] {
    if (peers.length === 0) {
        return [
            createPlaceholderItem(
                "No peer sessions on this page.",
                "Switch pages with Tab or ←→.",
            ),
        ]
    }

    return peers.map((peer, index) => ({
        value: `${peer.id}\0${index}`,
        label: dimIfUnselected(
            formatPeerListLabel(peer),
            peer.id === selectedPeerId,
            theme,
        ),
        description: `${formatPeerState(peer.state)}  ${peer.cwd}`,
        peer,
    }))
}

function createGreetingSelectItems(
    rows: GreetingDisplayRow[],
    selectedGreetingId: string | undefined,
    theme: Theme,
    emptyLabel: string,
): PeerSelectItem[] {
    if (rows.length === 0) {
        return [createPlaceholderItem(emptyLabel, "Switch tabs with Tab or ←→.")]
    }

    return rows.map((row, index) => ({
        value: `${row.id}\0${index}`,
        label: dimIfUnselected(
            formatPeerListLabel(row),
            row.id === selectedGreetingId,
            theme,
        ),
        description: `${formatPeerState(row.state)}  ${row.cwd}`,
        greeting: row,
    }))
}

function formatMailboxOptionLabel(row: CleanupMailboxRow, checked: boolean): string {
    return `${checked ? "[x]" : "[ ]"} ${formatMailboxListLabel(row)}`
}

function createCleanupMailboxItems(
    rows: CleanupMailboxRow[],
    checkedIds: ReadonlySet<string>,
    selectedMailboxId: string | undefined,
    theme: Theme,
): PeerSelectItem[] {
    if (rows.length === 0) {
        return [
            createPlaceholderItem(
                "No peers on this page.",
                "Switch pages with Tab or ←→.",
            ),
        ]
    }

    return rows.map((row) => ({
        value: row.id,
        label: dimIfUnselected(
            formatMailboxOptionLabel(row, checkedIds.has(row.id)),
            row.id === selectedMailboxId,
            theme,
        ),
        description: `${formatPeerState(row.state)}  ${row.cwd}`,
        mailbox: row,
    }))
}

class PeerAddonPrompt implements Component {
    private readonly container = new Container()
    private readonly title = new Text("", 1, 0)
    private readonly summary = new Text("", 1, 0)
    private readonly source = new Text("", 1, 1)
    private readonly details = new Text("", 1, 1)
    private readonly footer = new Text("", 1, 0)
    private readonly items: PeerSelectItem[] = []
    private readonly selectList: SelectList
    private readonly tui: TUI
    private readonly theme: Theme
    private readonly close: () => void
    private readonly loadPeers: () => Promise<PeerPages>
    private state: PeerLoadState = { kind: "loading" }
    private activeTab: PeerTabKey = "current"
    private disposed = false

    constructor(options: {
        tui: TUI
        theme: Theme
        close: () => void
        loadPeers: () => Promise<PeerPages>
    }) {
        this.tui = options.tui
        this.theme = options.theme
        this.close = options.close
        this.loadPeers = options.loadPeers
        this.selectList = new SelectList(this.items, 10, {
            selectedPrefix: (text) => this.theme.fg("accent", text),
            selectedText: (text) => this.theme.fg("accent", text),
            description: (text) => this.theme.fg("dim", text),
            scrollInfo: (text) => this.theme.fg("dim", text),
            noMatch: (text) => this.theme.fg("warning", text),
        })

        this.selectList.onSelect = () => {
            this.dispose()
            this.close()
        }
        this.selectList.onCancel = () => {
            this.dispose()
            this.close()
        }
        this.selectList.onSelectionChange = () => {
            this.refreshContents(false)
            this.tui.requestRender()
        }

        this.container.addChild(
            new DynamicBorder((text: string) => this.theme.fg("accent", text)),
        )
        this.container.addChild(this.title)
        this.container.addChild(this.summary)
        this.container.addChild(this.source)
        this.container.addChild(this.selectList)
        this.container.addChild(this.details)
        this.container.addChild(this.footer)
        this.container.addChild(
            new DynamicBorder((text: string) => this.theme.fg("accent", text)),
        )

        this.refreshContents(true)
    }

    async load(): Promise<void> {
        try {
            const pages = await this.loadPeers()
            if (this.disposed) return
            this.state = { kind: "ready", pages }
        } catch (error) {
            if (this.disposed) return
            this.state = {
                kind: "error",
                message: error instanceof Error ? error.message : String(error),
            }
        }

        this.refreshContents(true)
        this.tui.requestRender()
    }

    dispose(): void {
        this.disposed = true
    }

    invalidate(): void {
        this.container.invalidate()
        this.selectList.invalidate()
        this.refreshText()
    }

    handleInput(data: string): void {
        if (this.state.kind === "ready") {
            if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
                this.switchTab()
                return
            }

            if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
                this.switchTab()
                return
            }
        }

        this.selectList.handleInput(data)
        this.tui.requestRender()
    }

    render(width: number): string[] {
        return this.container.render(width)
    }

    private switchTab(): void {
        this.activeTab = this.activeTab === "current" ? "other" : "current"
        this.refreshContents(true)
        this.tui.requestRender()
    }

    private refreshContents(resetSelection: boolean): void {
        this.refreshItems(resetSelection)
        this.refreshText()
    }

    private refreshItems(resetSelection: boolean): void {
        const peers = this.getActivePeers()
        const selectedPeerId = resetSelection
            ? peers[0]?.id
            : this.getSelectedPeer()?.id
        const nextItems =
            this.state.kind === "loading"
                ? [
                      createPlaceholderItem(
                          "Loading peers…",
                          "Please wait while peer records are loaded.",
                      ),
                  ]
                : this.state.kind === "error"
                  ? [
                        createPlaceholderItem(
                            "Could not load peer list",
                            this.state.message,
                        ),
                    ]
                  : createPeerSelectItems(peers, selectedPeerId, this.theme)

        this.items.splice(0, this.items.length, ...nextItems)
        if (resetSelection) {
            this.selectList.setSelectedIndex(0)
        }
        this.selectList.invalidate()
    }

    private refreshText(): void {
        this.title.setText(this.theme.fg("accent", this.theme.bold("List Pi peers")))

        if (this.state.kind === "loading") {
            this.summary.setText("")
            this.source.setText(this.theme.fg("dim", "Loading peers…"))
            this.details.setText(
                this.theme.fg(
                    "dim",
                    "Please wait while peer records are loaded from disk.",
                ),
            )
            this.footer.setText(this.theme.fg("dim", "Enter/Esc close"))
            return
        }

        if (this.state.kind === "error") {
            this.summary.setText("")
            this.source.setText(this.theme.fg("warning", "Could not load peer list"))
            this.details.setText(this.theme.fg("warning", this.state.message))
            this.footer.setText(this.theme.fg("dim", "Enter/Esc close"))
            return
        }

        const currentCount = this.state.pages.current.length
        const otherCount = this.state.pages.other.length
        const selectedPeer = this.getSelectedPeer()
        const currentTab = formatTabLabel(
            "Current dir",
            currentCount,
            this.activeTab === "current",
            this.theme,
        )
        const otherTab = formatTabLabel(
            "Other dirs",
            otherCount,
            this.activeTab === "other",
            this.theme,
        )

        this.summary.setText("")
        this.source.setText(`${currentTab}  ${otherTab}`)
        this.details.setText(
            this.theme.fg(
                "dim",
                selectedPeer
                    ? [
                          `id: ${selectedPeer.id}`,
                          `cwd: ${selectedPeer.cwd}`,
                          `state: ${selectedPeer.state}`,
                          `sessionId: ${selectedPeer.sessionId}`,
                      ].join("\n")
                    : "No peers on this page.",
            ),
        )
        this.footer.setText(
            this.theme.fg("dim", "↑↓ navigate • Tab/←→ switch page • Enter/Esc close"),
        )
    }

    private getActivePeers(): PeerDisplayRow[] {
        if (this.state.kind !== "ready") {
            return []
        }

        return this.activeTab === "current"
            ? this.state.pages.current
            : this.state.pages.other
    }

    private getSelectedPeer(): PeerDisplayRow | undefined {
        const selectedItem = this.selectList.getSelectedItem() as PeerSelectItem | null
        return selectedItem?.peer
    }
}

class CleanupMailboxesPrompt implements Component {
    private readonly container = new Container()
    private readonly title = new Text("", 1, 0)
    private readonly summary = new Text("", 1, 0)
    private readonly tabs = new Text("", 1, 1)
    private readonly details = new Text("", 1, 1)
    private readonly footer = new Text("", 1, 0)
    private readonly items: PeerSelectItem[] = []
    private readonly checkedIds = new Set<string>()
    private readonly selectList: SelectList
    private readonly tui: TUI
    private readonly theme: Theme
    private readonly notify: ExtensionCommandContext["ui"]["notify"]
    private readonly close: (selectedIds: string[] | undefined) => void
    private readonly loadMailboxes: () => Promise<CleanupMailboxPages>
    private state: CleanupLoadState = { kind: "loading" }
    private activeTab: PeerTabKey = "current"
    private disposed = false

    constructor(options: {
        tui: TUI
        theme: Theme
        notify: ExtensionCommandContext["ui"]["notify"]
        close: (selectedIds: string[] | undefined) => void
        loadMailboxes: () => Promise<CleanupMailboxPages>
    }) {
        this.tui = options.tui
        this.theme = options.theme
        this.notify = options.notify
        this.close = options.close
        this.loadMailboxes = options.loadMailboxes
        this.selectList = new SelectList(this.items, 10, {
            selectedPrefix: (text) => this.theme.fg("accent", text),
            selectedText: (text) => this.theme.fg("accent", text),
            description: (text) => this.theme.fg("dim", text),
            scrollInfo: (text) => this.theme.fg("dim", text),
            noMatch: (text) => this.theme.fg("warning", text),
        })

        this.selectList.onSelect = () => {
            this.dispose()
            this.close(
                this.state.kind === "ready" ? Array.from(this.checkedIds) : undefined,
            )
        }
        this.selectList.onCancel = () => {
            this.dispose()
            this.close(undefined)
        }
        this.selectList.onSelectionChange = () => {
            this.refreshContents(false)
            this.tui.requestRender()
        }

        this.container.addChild(
            new DynamicBorder((text: string) => this.theme.fg("accent", text)),
        )
        this.container.addChild(this.title)
        this.container.addChild(this.summary)
        this.container.addChild(this.tabs)
        this.container.addChild(this.selectList)
        this.container.addChild(this.details)
        this.container.addChild(this.footer)
        this.container.addChild(
            new DynamicBorder((text: string) => this.theme.fg("accent", text)),
        )

        this.refreshContents(true)
    }

    async load(): Promise<void> {
        try {
            const pages = await this.loadMailboxes()
            if (this.disposed) return
            this.state = { kind: "ready", pages }
        } catch (error) {
            if (this.disposed) return
            this.state = {
                kind: "error",
                message: error instanceof Error ? error.message : String(error),
            }
        }

        this.refreshContents(true)
        this.tui.requestRender()
    }

    dispose(): void {
        this.disposed = true
    }

    invalidate(): void {
        this.container.invalidate()
        this.selectList.invalidate()
        this.refreshText()
    }

    handleInput(data: string): void {
        if (this.state.kind === "ready") {
            if (matchesKey(data, Key.space)) {
                this.toggleSelectedMailbox()
                this.tui.requestRender()
                return
            }

            if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
                this.switchTab()
                return
            }

            if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
                this.switchTab()
                return
            }
        }

        this.selectList.handleInput(data)
        this.tui.requestRender()
    }

    render(width: number): string[] {
        return this.container.render(width)
    }

    private toggleSelectedMailbox(): void {
        const selectedItem = this.selectList.getSelectedItem() as PeerSelectItem | null
        const row = selectedItem?.mailbox
        if (!selectedItem || !row) {
            return
        }

        const reason = mailboxCleanupBlockReason(row)
        if (reason) {
            this.notify(reason, "warning")
            return
        }

        if (this.checkedIds.has(row.id)) {
            this.checkedIds.delete(row.id)
            selectedItem.label = formatMailboxOptionLabel(row, false)
        } else {
            this.checkedIds.add(row.id)
            selectedItem.label = formatMailboxOptionLabel(row, true)
        }

        this.selectList.invalidate()
        this.refreshText()
    }

    private switchTab(): void {
        this.activeTab = this.activeTab === "current" ? "other" : "current"
        this.refreshContents(true)
        this.tui.requestRender()
    }

    private refreshContents(resetSelection: boolean): void {
        this.refreshItems(resetSelection)
        this.refreshText()
    }

    private refreshItems(resetSelection: boolean): void {
        const rows = this.getActiveMailboxes()
        const selectedMailboxId = resetSelection
            ? rows[0]?.id
            : this.getSelectedMailbox()?.id
        const nextItems =
            this.state.kind === "loading"
                ? [
                      createPlaceholderItem(
                          "Loading peers…",
                          "Please wait while peer records are loaded.",
                      ),
                  ]
                : this.state.kind === "error"
                  ? [createPlaceholderItem("Could not load peers", this.state.message)]
                  : createCleanupMailboxItems(
                        rows,
                        this.checkedIds,
                        selectedMailboxId,
                        this.theme,
                    )

        this.items.splice(0, this.items.length, ...nextItems)
        if (resetSelection) {
            this.selectList.setSelectedIndex(0)
        }
        this.selectList.invalidate()
    }

    private refreshText(): void {
        this.title.setText(
            this.theme.fg("accent", this.theme.bold("Clean up Pi peers")),
        )

        if (this.state.kind === "loading") {
            this.summary.setText("")
            this.tabs.setText(this.theme.fg("dim", "Loading peers…"))
            this.details.setText(
                this.theme.fg(
                    "dim",
                    "Please wait while peer records are loaded from disk.",
                ),
            )
            this.footer.setText(this.theme.fg("dim", "Enter/Esc close"))
            return
        }

        if (this.state.kind === "error") {
            this.summary.setText("")
            this.tabs.setText(this.theme.fg("warning", "Could not load peers"))
            this.details.setText(this.theme.fg("warning", this.state.message))
            this.footer.setText(this.theme.fg("dim", "Enter/Esc close"))
            return
        }

        const currentCount = this.state.pages.current.length
        const otherCount = this.state.pages.other.length
        const selectedRow = this.getSelectedMailbox()
        const currentTab = formatTabLabel(
            "Current dir",
            currentCount,
            this.activeTab === "current",
            this.theme,
        )
        const otherTab = formatTabLabel(
            "Other dirs",
            otherCount,
            this.activeTab === "other",
            this.theme,
        )

        this.summary.setText(
            this.theme.fg(
                "dim",
                `${this.checkedIds.size} selected • enter clean up • esc cancel`,
            ),
        )
        this.tabs.setText(`${currentTab}  ${otherTab}`)
        this.details.setText(
            this.theme.fg(
                "dim",
                selectedRow
                    ? [
                          `id: ${selectedRow.id}`,
                          `cwd: ${selectedRow.cwd}`,
                          `state: ${selectedRow.state}`,
                          `sessionId: ${selectedRow.sessionId}`,
                      ].join("\n")
                    : "No peers on this page.",
            ),
        )
        this.footer.setText(
            this.theme.fg(
                "dim",
                "↑↓ navigate • Space toggle checkbox • Tab/←→ switch page",
            ),
        )
    }

    private getActiveMailboxes(): CleanupMailboxRow[] {
        if (this.state.kind !== "ready") {
            return []
        }

        return this.activeTab === "current"
            ? this.state.pages.current
            : this.state.pages.other
    }

    private getSelectedMailbox(): CleanupMailboxRow | undefined {
        const selectedItem = this.selectList.getSelectedItem() as PeerSelectItem | null
        return selectedItem?.mailbox
    }
}

class GreetingPrompt implements Component {
    private readonly container = new Container()
    private readonly title = new Text("", 1, 0)
    private readonly tabs = new Text("", 1, 1)
    private readonly details = new Text("", 1, 1)
    private readonly footer = new Text("", 1, 0)
    private readonly items: PeerSelectItem[] = []
    private readonly selectList: SelectList
    private readonly tui: TUI
    private readonly theme: Theme
    private readonly close: () => void
    private readonly loadGreeting: () => Promise<GreetingResult>
    private state: GreetingLoadState = { kind: "loading" }
    private activeTab: GreetingTabKey = "prepared"
    private disposed = false

    constructor(options: {
        tui: TUI
        theme: Theme
        close: () => void
        loadGreeting: () => Promise<GreetingResult>
    }) {
        this.tui = options.tui
        this.theme = options.theme
        this.close = options.close
        this.loadGreeting = options.loadGreeting
        this.selectList = new SelectList(this.items, 10, {
            selectedPrefix: (text) => this.theme.fg("accent", text),
            selectedText: (text) => this.theme.fg("accent", text),
            description: (text) => this.theme.fg("dim", text),
            scrollInfo: (text) => this.theme.fg("dim", text),
            noMatch: (text) => this.theme.fg("warning", text),
        })

        this.selectList.onSelect = () => {
            this.dispose()
            this.close()
        }
        this.selectList.onCancel = () => {
            this.dispose()
            this.close()
        }
        this.selectList.onSelectionChange = () => {
            this.refreshContents(false)
            this.tui.requestRender()
        }

        this.container.addChild(
            new DynamicBorder((text: string) => this.theme.fg("accent", text)),
        )
        this.container.addChild(this.title)
        this.container.addChild(this.tabs)
        this.container.addChild(this.selectList)
        this.container.addChild(this.details)
        this.container.addChild(this.footer)
        this.container.addChild(
            new DynamicBorder((text: string) => this.theme.fg("accent", text)),
        )

        this.refreshContents(true)
    }

    async load(): Promise<void> {
        try {
            const result = await this.loadGreeting()
            if (this.disposed) return
            this.state = { kind: "ready", result }
        } catch (error) {
            if (this.disposed) return
            this.state = {
                kind: "error",
                message: error instanceof Error ? error.message : String(error),
            }
        }

        this.refreshContents(true)
        this.tui.requestRender()
    }

    dispose(): void {
        this.disposed = true
    }

    invalidate(): void {
        this.container.invalidate()
        this.selectList.invalidate()
        this.refreshText()
    }

    handleInput(data: string): void {
        if (this.state.kind === "ready") {
            if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
                this.switchTab(1)
                return
            }

            if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
                this.switchTab(-1)
                return
            }
        }

        this.selectList.handleInput(data)
        this.tui.requestRender()
    }

    render(width: number): string[] {
        return this.container.render(width)
    }

    private switchTab(direction: 1 | -1): void {
        const order: GreetingTabKey[] = ["prepared", "sent", "skipped"]
        const currentIndex = order.indexOf(this.activeTab)
        const nextIndex = (currentIndex + direction + order.length) % order.length
        this.activeTab = order[nextIndex] ?? "prepared"
        this.refreshContents(true)
        this.tui.requestRender()
    }

    private refreshContents(resetSelection: boolean): void {
        this.refreshItems(resetSelection)
        this.refreshText()
    }

    private refreshItems(resetSelection: boolean): void {
        const rows = this.getActiveGreetings()
        const selectedGreetingId = resetSelection
            ? rows[0]?.id
            : this.getSelectedGreeting()?.id
        const nextItems =
            this.state.kind === "loading"
                ? [
                      createPlaceholderItem(
                          "Preparing peer introductions…",
                          "Please wait while peer records are loaded.",
                      ),
                  ]
                : this.state.kind === "error"
                  ? [
                        createPlaceholderItem(
                            "Could not introduce peers",
                            this.state.message,
                        ),
                    ]
                  : createGreetingSelectItems(
                        rows,
                        selectedGreetingId,
                        this.theme,
                        this.activeTab === "prepared"
                            ? "No prepared peer introductions."
                            : this.activeTab === "sent"
                              ? "No sent peer introductions."
                              : "No skipped peer introductions.",
                    )

        this.items.splice(0, this.items.length, ...nextItems)
        if (resetSelection) {
            this.selectList.setSelectedIndex(0)
        }
        this.selectList.invalidate()
    }

    private refreshText(): void {
        this.title.setText(
            this.theme.fg("accent", this.theme.bold("Introduce Pi peers")),
        )

        if (this.state.kind === "loading") {
            this.tabs.setText(this.theme.fg("dim", "Preparing peer introductions…"))
            this.details.setText(
                this.theme.fg(
                    "dim",
                    "Loading local peer records and preparing target-specific introductions.",
                ),
            )
            this.footer.setText(this.theme.fg("dim", "Enter/Esc close"))
            return
        }

        if (this.state.kind === "error") {
            this.tabs.setText(this.theme.fg("warning", "Could not introduce peers"))
            this.details.setText(this.theme.fg("warning", this.state.message))
            this.footer.setText(this.theme.fg("dim", "Enter/Esc close"))
            return
        }

        const pages = buildGreetingPages(this.state.result)
        const selectedRow = this.getSelectedGreeting()
        const preparedTab = formatTabLabel(
            "Prepared",
            pages.prepared.length,
            this.activeTab === "prepared",
            this.theme,
        )
        const sentTab = formatTabLabel(
            "Sent",
            pages.sent.length,
            this.activeTab === "sent",
            this.theme,
        )
        const skippedTab = formatTabLabel(
            "Skipped",
            pages.skipped.length,
            this.activeTab === "skipped",
            this.theme,
        )

        this.tabs.setText(`${preparedTab}  ${sentTab}  ${skippedTab}`)
        this.details.setText(
            this.theme.fg(
                "dim",
                selectedRow
                    ? [
                          `id: ${selectedRow.id}`,
                          `cwd: ${selectedRow.cwd}`,
                          `state: ${selectedRow.state}`,
                          `sessionId: ${selectedRow.sessionId}`,
                      ].join("\n")
                    : "No peers on this tab.",
            ),
        )
        this.footer.setText(
            this.theme.fg("dim", "↑↓ navigate • Tab/←→ switch tab • Enter/Esc close"),
        )
    }

    private getActiveGreetings(): GreetingDisplayRow[] {
        if (this.state.kind !== "ready") {
            return []
        }

        const pages = buildGreetingPages(this.state.result)
        return this.activeTab === "prepared"
            ? pages.prepared
            : this.activeTab === "sent"
              ? pages.sent
              : pages.skipped
    }

    private getSelectedGreeting(): GreetingDisplayRow | undefined {
        const selectedItem = this.selectList.getSelectedItem() as PeerSelectItem | null
        return selectedItem?.greeting
    }
}

function registerGreetingRenderer(pi: ExtensionAPI): void {
    pi.registerMessageRenderer<GreetingMessageDetails>(
        GREETING_MESSAGE_TYPE,
        (message, { outputPad }) => new Text(String(message.content), outputPad, 0),
    )
}

function registerGreetingReceiver(pi: ExtensionAPI): void {
    let greetingWatch: GreetingInboxWatch | undefined

    pi.on("session_start", async (_event, ctx) => {
        const currentSessionId = ctx.sessionManager.getSessionId?.()
        if (!currentSessionId) return

        const currentMailbox = mailboxId(ctx.cwd, currentSessionId)
        await advertiseGreetingReceiver({
            currentCwd: ctx.cwd,
            currentSessionId,
        })

        greetingWatch?.close()
        greetingWatch = watchGreetingInbox({
            mailboxId: currentMailbox,
            onLetters(letters) {
                for (const letter of letters) {
                    pi.sendMessage<GreetingMessageDetails>({
                        customType: GREETING_MESSAGE_TYPE,
                        content: letter.text,
                        display: true,
                        details: {
                            fromName: letter.fromName,
                            fromCwd: letter.fromCwd,
                            sentAt: letter.sentAt,
                        } satisfies GreetingMessageDetails,
                    })
                }
            },
        })
    })

    pi.on("session_shutdown", async () => {
        greetingWatch?.close()
        greetingWatch = undefined
    })
}

function registerPeerAddonCommand(pi: ExtensionAPI): void {
    pi.registerCommand(PEER_ADDON_COMMAND, {
        description: "Friendly TUI helpers built on top of pi-peer",
        getArgumentCompletions(argumentPrefix) {
            const trimmed = argumentPrefix.trimStart()
            const completions = [
                LIST_PEERS_SUBCOMMAND,
                CLEAN_UP_PEERS_SUBCOMMAND,
                INTRODUCE_PEERS_SUBCOMMAND,
            ]
                .filter((value) => value.startsWith(trimmed))
                .map((value) => ({ value, label: value }))
            return completions.length > 0 ? completions : null
        },
        async handler(args, ctx) {
            const subcommand = normalizeSubcommand(args)
            if (
                subcommand !== LIST_PEERS_SUBCOMMAND &&
                subcommand !== CLEAN_UP_PEERS_SUBCOMMAND &&
                subcommand !== INTRODUCE_PEERS_SUBCOMMAND
            ) {
                ctx.ui.notify(
                    `Usage: /${PEER_ADDON_COMMAND} ${LIST_PEERS_SUBCOMMAND}|${CLEAN_UP_PEERS_SUBCOMMAND}|${INTRODUCE_PEERS_SUBCOMMAND}`,
                    "warning",
                )
                return
            }

            if (!ctx.hasUI || ctx.mode !== "tui") {
                ctx.ui.notify(
                    `/peer-addon ${subcommand} requires the interactive TUI.`,
                    "warning",
                )
                return
            }

            const currentSessionId = ctx.sessionManager.getSessionId?.()

            if (subcommand === CLEAN_UP_PEERS_SUBCOMMAND) {
                let prompt: CleanupMailboxesPrompt | undefined
                const selectedIds = await ctx.ui.custom<string[] | undefined>(
                    (tui, theme, _kb, done) => {
                        prompt = new CleanupMailboxesPrompt({
                            tui,
                            theme,
                            notify: ctx.ui.notify,
                            close: done,
                            loadMailboxes: () =>
                                loadCleanupMailboxPages({
                                    currentCwd: ctx.cwd,
                                    currentSessionId,
                                }),
                        })

                        void prompt.load()
                        return prompt
                    },
                    {
                        overlay: true,
                        overlayOptions: {
                            width: "70%",
                            minWidth: 48,
                            maxHeight: "80%",
                        },
                    },
                )
                prompt?.dispose()

                if (!selectedIds) {
                    return
                }
                if (selectedIds.length === 0) {
                    ctx.ui.notify("No peers selected.", "warning")
                    return
                }

                const result = await cleanUpMailboxes({
                    selectedIds,
                    currentCwd: ctx.cwd,
                    currentSessionId,
                })
                const cleanedCount = result.cleanedIds.length
                const skippedCount = result.skipped.length
                if (skippedCount > 0) {
                    ctx.ui.notify(
                        `Cleaned ${cleanedCount} peer${cleanedCount === 1 ? "" : "s"}; skipped ${skippedCount}: ${result.skipped
                            .map((entry) => `${entry.id} (${entry.reason})`)
                            .join("; ")}`,
                        "warning",
                    )
                    return
                }

                ctx.ui.notify(
                    `Cleaned ${cleanedCount} peer${cleanedCount === 1 ? "" : "s"}.`,
                    "info",
                )
                return
            }

            if (subcommand === INTRODUCE_PEERS_SUBCOMMAND) {
                let prompt: GreetingPrompt | undefined

                await ctx.ui.custom<void>(
                    (tui, theme, _kb, done) => {
                        prompt = new GreetingPrompt({
                            tui,
                            theme,
                            close: () => done(),
                            loadGreeting: async () => {
                                const result = await sendPeerGreetings({
                                    currentCwd: ctx.cwd,
                                    currentSessionId,
                                })
                                pi.sendMessage<GreetingMessageDetails>({
                                    customType: GREETING_MESSAGE_TYPE,
                                    content: formatGreetingMessage(result.sender),
                                    display: true,
                                    details: {
                                        fromName: result.sender.label,
                                        fromCwd: result.sender.cwd,
                                        sentAt: Date.now(),
                                    } satisfies GreetingMessageDetails,
                                })
                                return result
                            },
                        })

                        void prompt.load()
                        return prompt
                    },
                    {
                        overlay: true,
                        overlayOptions: {
                            width: "70%",
                            minWidth: 48,
                            maxHeight: "80%",
                        },
                    },
                )

                prompt?.dispose()
                return
            }

            let prompt: PeerAddonPrompt | undefined

            await ctx.ui.custom<void>(
                (tui, theme, _kb, done) => {
                    prompt = new PeerAddonPrompt({
                        tui,
                        theme,
                        close: () => done(),
                        loadPeers: () =>
                            loadPeerPages({
                                currentCwd: ctx.cwd,
                                currentSessionId,
                            }),
                    })

                    void prompt.load()
                    return prompt
                },
                {
                    overlay: true,
                    overlayOptions: {
                        width: "70%",
                        minWidth: 48,
                        maxHeight: "80%",
                    },
                },
            )

            prompt?.dispose()
        },
    })
}

export default function init(pi: ExtensionAPI): void {
    registerGreetingRenderer(pi)
    registerGreetingReceiver(pi)
    registerPeerAddonCommand(pi)
}
