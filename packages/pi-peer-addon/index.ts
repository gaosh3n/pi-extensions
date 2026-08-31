import { createHash } from "node:crypto"
import { basename } from "node:path"

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

const MISSING_PI_PEER_MESSAGE =
    "pi-peer-addon requires the pi-peer /peers command. Install and load @shift-labs/pi-peer, then retry."
const PEERS_CAPTURE_TIMEOUT_MS = 2_000

type AvailableCommand = ReturnType<ExtensionAPI["getCommands"]>[number]

type PeerTabKey = "current" | "other"

type PeerLoadState =
    | { kind: "loading" }
    | { kind: "ready"; pages: PeerPages; peersCommandName: string }
    | { kind: "error"; message: string }

export interface ParsedPeerRow {
    sourceName: string
    cwd: string
    status: string
}

export interface PeerDisplayRow {
    label: string
    status: string
    cwd: string
    sourceName: string
    isMe: boolean
}

export interface PeerPages {
    current: PeerDisplayRow[]
    other: PeerDisplayRow[]
}

interface PeerSelectItem extends SelectItem {
    peer?: PeerDisplayRow
}

function normalizeSubcommand(args: string): string {
    return args.trim()
}

function formatDirName(cwd: string): string {
    return basename(cwd) || "pi"
}

function stablePrefix(seed: string): string {
    return createHash("sha256").update(seed).digest("hex").slice(0, 4)
}

function extractSourcePrefix(sourceName: string): string | undefined {
    const match = /#([A-Za-z0-9]{4,})$/.exec(sourceName.trim())
    return match?.[1]?.slice(0, 4)
}

export function createFriendlyPeerName(
    cwd: string,
    sourceName: string,
    fallbackSeed?: string,
): string {
    const dirName = formatDirName(cwd)
    const prefix =
        extractSourcePrefix(sourceName) ??
        stablePrefix(fallbackSeed ?? `${sourceName}\0${cwd}`)
    return `${dirName}#${prefix}`
}

export function parsePeersListing(listing: string): ParsedPeerRow[] {
    const trimmed = listing.trim()
    if (trimmed.length === 0) return []
    if (trimmed.startsWith("No other pi sessions are known.")) return []

    const rows: ParsedPeerRow[] = []

    for (const line of listing.split("\n")) {
        const match = /^\s*(.+?)\s{2,}(.*?)\s{2,}\[([^\]]+)\]\s*$/.exec(line)
        if (!match) continue

        rows.push({
            sourceName: match[1]!.trim(),
            cwd: match[2]!.trim(),
            status: match[3]!.trim(),
        })
    }

    return rows
}

function createSelfPeerName(cwd: string, currentSessionId?: string): string {
    const dirName = formatDirName(cwd)
    const prefix = (currentSessionId?.trim() || stablePrefix(cwd)).slice(0, 4)
    return `${dirName}#${prefix}`
}

export function buildPeerPages(options: {
    listing: string
    currentCwd: string
    currentSessionId?: string
    currentStatus: string
}): PeerPages {
    const peers = parsePeersListing(options.listing).map((row) => ({
        label: createFriendlyPeerName(row.cwd, row.sourceName),
        status: row.status,
        cwd: row.cwd,
        sourceName: row.sourceName,
        isMe: false,
    }))

    const me: PeerDisplayRow = {
        label: createSelfPeerName(options.currentCwd, options.currentSessionId),
        status: options.currentStatus,
        cwd: options.currentCwd,
        sourceName: "[me]",
        isMe: true,
    }

    return {
        current: [me, ...peers.filter((peer) => peer.cwd === options.currentCwd)],
        other: peers.filter((peer) => peer.cwd !== options.currentCwd),
    }
}

function isPeersCommandName(name: string): boolean {
    return /^peers(?::\d+)?$/.test(name)
}

function hasPiPeerProvenance(command: AvailableCommand): boolean {
    if (command.source !== "extension") return false
    const sourcePath = command.sourceInfo.path.replaceAll("\\", "/")
    return (
        sourcePath.includes("@shift-labs/pi-peer") ||
        /(^|\/)pi-peer(\/|$)/.test(sourcePath)
    )
}

export function resolvePeersCommand(
    commands: readonly AvailableCommand[],
): AvailableCommand | undefined {
    const piPeerMatches = commands.filter(
        (command) => isPeersCommandName(command.name) && hasPiPeerProvenance(command),
    )

    return piPeerMatches.find((command) => command.name === "peers") ?? piPeerMatches[0]
}

/**
 * Temporary adapter for T2.
 *
 * Pi exposes slash-command dispatch, but not command-to-command return values.
 * The runtime-level pi.sendUserMessage(...) helper is fire-and-forget, so we
 * cannot await nested /peers completion directly. Instead we temporarily wrap
 * the shared ui.notify surface, trigger /peers, and wait for the single info
 * notification that pi-peer currently emits when its survey completes.
 *
 * This is intentionally narrow and defensive:
 * - prerequisite check happens before invocation
 * - notify is wrapped only around the nested /peers observation window
 * - non-info notifications are forwarded immediately
 * - we fail closed unless exactly one info notification is observed
 */
async function capturePeersListing(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    peersCommandName: string,
): Promise<string> {
    const ui = ctx.ui as typeof ctx.ui & {
        notify: (message: string, level?: "info" | "warning" | "error") => void
    }
    const originalNotify = ui.notify
    const captured: Array<{ message: string; level?: "info" | "warning" | "error" }> =
        []

    return await new Promise<string>((resolve, reject) => {
        let finished = false
        let settleTimer: ReturnType<typeof setTimeout> | undefined
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined

        const finish = (callback: () => void) => {
            if (finished) return
            finished = true
            if (settleTimer) clearTimeout(settleTimer)
            if (timeoutTimer) clearTimeout(timeoutTimer)
            ui.notify = originalNotify
            callback()
        }

        const getInfoMessages = () => captured.filter((entry) => entry.level === "info")

        const failForObservedCount = () => {
            const infoMessages = getInfoMessages()
            finish(() => {
                reject(
                    new Error(
                        `Expected exactly one info notification from /${peersCommandName}, received ${infoMessages.length}.`,
                    ),
                )
            })
        }

        const scheduleSuccessCheck = () => {
            if (settleTimer) return
            settleTimer = setTimeout(() => {
                const infoMessages = getInfoMessages()
                if (infoMessages.length !== 1) {
                    failForObservedCount()
                    return
                }

                finish(() => resolve(infoMessages[0]!.message))
            }, 0)
        }

        ui.notify = (message: string, level?: "info" | "warning" | "error") => {
            captured.push({ message, level })
            if (level !== "info") {
                originalNotify(message, level)
                return
            }

            if (getInfoMessages().length > 1) {
                failForObservedCount()
                return
            }

            scheduleSuccessCheck()
        }

        timeoutTimer = setTimeout(() => {
            failForObservedCount()
        }, PEERS_CAPTURE_TIMEOUT_MS)

        try {
            pi.sendUserMessage(`/${peersCommandName}`, { expandPromptTemplates: true })
        } catch (error) {
            finish(() => {
                reject(error instanceof Error ? error : new Error(String(error)))
            })
        }
    })
}

function createPlaceholderItem(label: string, description: string): PeerSelectItem {
    return {
        value: `${label}\0${description}`,
        label,
        description,
    }
}

function formatPeerStatus(status: string): string {
    return `[${status}]`
}

function formatPeerListLabel(peer: PeerDisplayRow): string {
    return peer.isMe ? `${peer.label} [me]` : peer.label
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

function createPeerSelectItems(peers: PeerDisplayRow[]): PeerSelectItem[] {
    if (peers.length === 0) {
        return [
            createPlaceholderItem(
                "No peer sessions on this page.",
                "Switch pages with Tab or ←→.",
            ),
        ]
    }

    return peers.map((peer, index) => ({
        value: `${peer.sourceName}\0${index}`,
        label: formatPeerListLabel(peer),
        description: `${formatPeerStatus(peer.status)}  ${peer.cwd}`,
        peer,
    }))
}

class PeerAddonPrompt implements Component {
    private readonly container = new Container()
    private readonly title = new Text("", 1, 0)
    private readonly summary = new Text("", 1, 0)
    private readonly source = new Text("", 1, 0)
    private readonly details = new Text("", 1, 0)
    private readonly footer = new Text("", 1, 0)
    private readonly items: PeerSelectItem[] = []
    private readonly selectList: SelectList
    private readonly tui: TUI
    private readonly theme: Theme
    private readonly close: () => void
    private readonly loadPeers: () => Promise<{
        pages: PeerPages
        peersCommandName: string
    }>
    private state: PeerLoadState = { kind: "loading" }
    private activeTab: PeerTabKey = "current"
    private disposed = false

    constructor(options: {
        tui: TUI
        theme: Theme
        close: () => void
        loadPeers: () => Promise<{ pages: PeerPages; peersCommandName: string }>
    }) {
        this.tui = options.tui
        this.theme = options.theme
        this.close = options.close
        this.loadPeers = options.loadPeers
        this.selectList = new SelectList(this.items, 10, {
            selectedPrefix: (text) => this.theme.fg("accent", text),
            selectedText: (text) => this.theme.fg("accent", text),
            description: (text) => this.theme.fg("muted", text),
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
            this.refreshText()
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
            const result = await this.loadPeers()
            if (this.disposed) return
            this.state = { kind: "ready", ...result }
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
        const nextItems =
            this.state.kind === "loading"
                ? [
                      createPlaceholderItem(
                          "Loading /peers…",
                          "Please wait while pi-peer surveys peer sessions.",
                      ),
                  ]
                : this.state.kind === "error"
                  ? [
                        createPlaceholderItem(
                            "Could not load peer list",
                            this.state.message,
                        ),
                    ]
                  : createPeerSelectItems(peers)

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
            this.source.setText(this.theme.fg("dim", "Loading /peers…"))
            this.details.setText(
                this.theme.fg(
                    "dim",
                    "Please wait while pi-peer finishes surveying peer sessions.",
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
                          `Selected: ${formatPeerListLabel(selectedPeer)}`,
                          `Status: ${formatPeerStatus(selectedPeer.status)}`,
                          `Directory: ${selectedPeer.cwd}`,
                      ].join("\n")
                    : "No peer sessions on this page.",
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

function registerPeerAddonCommand(pi: ExtensionAPI): void {
    pi.registerCommand(PEER_ADDON_COMMAND, {
        description: "Friendly TUI helpers built on top of pi-peer",
        getArgumentCompletions(argumentPrefix) {
            const trimmed = argumentPrefix.trimStart()
            if (LIST_PEERS_SUBCOMMAND.startsWith(trimmed)) {
                return [{ value: LIST_PEERS_SUBCOMMAND, label: LIST_PEERS_SUBCOMMAND }]
            }
            return null
        },
        async handler(args, ctx) {
            const subcommand = normalizeSubcommand(args)
            if (subcommand !== LIST_PEERS_SUBCOMMAND) {
                ctx.ui.notify(
                    `Usage: /${PEER_ADDON_COMMAND} ${LIST_PEERS_SUBCOMMAND}`,
                    "warning",
                )
                return
            }

            if (!ctx.hasUI || ctx.mode !== "tui") {
                ctx.ui.notify(
                    "/peer-addon list-peers requires the interactive TUI.",
                    "warning",
                )
                return
            }

            const peersCommand = resolvePeersCommand(pi.getCommands())
            if (!peersCommand) {
                ctx.ui.notify(MISSING_PI_PEER_MESSAGE, "warning")
                return
            }

            const currentSessionId = ctx.sessionManager.getSessionId?.()
            const currentStatus = ctx.isIdle() ? "idle" : "working"

            let prompt: PeerAddonPrompt | undefined

            await ctx.ui.custom<void>(
                (tui, theme, _kb, done) => {
                    prompt = new PeerAddonPrompt({
                        tui,
                        theme,
                        close: () => done(),
                        loadPeers: async () => {
                            const listing = await capturePeersListing(
                                pi,
                                ctx,
                                peersCommand.name,
                            )
                            return {
                                pages: buildPeerPages({
                                    listing,
                                    currentCwd: ctx.cwd,
                                    currentSessionId,
                                    currentStatus,
                                }),
                                peersCommandName: peersCommand.name,
                            }
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
        },
    })
}

export default function init(pi: ExtensionAPI): void {
    registerPeerAddonCommand(pi)
}
