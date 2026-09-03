import {
    DynamicBorder,
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

import type { GreetingDisplayRow, GreetingPages, GreetingResult } from "./greetings.ts"
import {
    buildGreetingPages,
    cleanupBlockReason,
    type CleanupPeerPages,
    type CleanupPeerRow,
    type CleanupPromptResult,
    type PeerDisplayRow,
    type PeerPages,
} from "./peers.ts"

interface PeerLike {
    id: string
    label: string
    cwd: string
    state: string
    sessionId: string
    isMe: boolean
}

interface PromptSelectItem extends SelectItem {
    peer?: PeerDisplayRow
    cleanupPeer?: CleanupPeerRow
    greeting?: GreetingDisplayRow
}

interface PeerLoadState {
    kind: "loading" | "ready" | "error"
    pages?: PeerPages
    message?: string
}

interface CleanupLoadState {
    kind: "loading" | "ready" | "error"
    pages?: CleanupPeerPages
    message?: string
}

interface GreetingLoadState {
    kind: "loading" | "ready" | "error"
    result?: GreetingResult
    message?: string
}

function createPromptSelectList(items: SelectItem[], theme: Theme): SelectList {
    return new SelectList(items, 10, {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("dim", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
    })
}

function createPlaceholderItem(label: string, description: string): PromptSelectItem {
    return {
        value: `${label}\0${description}`,
        label,
        description,
    }
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

function formatPeerListLabel(peer: PeerLike): string {
    return peer.isMe ? `${peer.label} [me]` : peer.label
}

function renderPeerDetails(peer: PeerLike | undefined): string {
    if (!peer) {
        return "No peers on this page."
    }

    return [
        `id: ${peer.id}`,
        `cwd: ${peer.cwd}`,
        `state: ${peer.state}`,
        `sessionId: ${peer.sessionId}`,
    ].join("\n")
}

function dimIfUnselected(text: string, isSelected: boolean, theme: Theme): string {
    return isSelected ? text : theme.fg("dim", text)
}

function createPeerSelectItems(
    peers: PeerDisplayRow[],
    selectedPeerId: string | undefined,
    theme: Theme,
): PromptSelectItem[] {
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
        description: `[${peer.state}]  ${peer.cwd}`,
        peer,
    }))
}

function formatCleanupPeerOptionLabel(row: CleanupPeerRow, checked: boolean): string {
    return `${checked ? "[x]" : "[ ]"} ${formatPeerListLabel(row)}`
}

function createCleanupPeerItems(
    rows: CleanupPeerRow[],
    checkedIds: ReadonlySet<string>,
    selectedPeerId: string | undefined,
    theme: Theme,
): PromptSelectItem[] {
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
            formatCleanupPeerOptionLabel(row, checkedIds.has(row.id)),
            row.id === selectedPeerId,
            theme,
        ),
        description: `[${row.state}]  ${row.cwd}`,
        cleanupPeer: row,
    }))
}

function createGreetingSelectItems(
    rows: GreetingDisplayRow[],
    selectedGreetingId: string | undefined,
    theme: Theme,
    emptyLabel: string,
): PromptSelectItem[] {
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
        description: `[${row.state}]  ${row.cwd}`,
        greeting: row,
    }))
}

export class ListPeersPrompt implements Component {
    private readonly container = new Container()
    private readonly title = new Text("", 1, 0)
    private readonly summary = new Text("", 1, 0)
    private readonly source = new Text("", 1, 1)
    private readonly details = new Text("", 1, 1)
    private readonly footer = new Text("", 1, 0)
    private readonly items: PromptSelectItem[] = []
    private readonly selectList
    private readonly tui: TUI
    private readonly theme: Theme
    private readonly close: () => void
    private readonly loadPeers: () => Promise<PeerPages>
    private state: PeerLoadState = { kind: "loading" }
    private activeTab: "current" | "other" = "current"
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
        this.selectList = createPromptSelectList(this.items, this.theme)

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
                            this.state.message ?? "Unknown error",
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
            this.details.setText(
                this.theme.fg("warning", this.state.message ?? "Unknown error"),
            )
            this.footer.setText(this.theme.fg("dim", "Enter/Esc close"))
            return
        }

        const pages = this.state.pages ?? { current: [], other: [] }
        const currentCount = pages.current.length
        const otherCount = pages.other.length
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
        this.details.setText(this.theme.fg("dim", renderPeerDetails(selectedPeer)))
        this.footer.setText(
            this.theme.fg("dim", "↑↓ navigate • Tab/←→ switch page • Enter/Esc close"),
        )
    }

    private getActivePeers(): PeerDisplayRow[] {
        if (this.state.kind !== "ready") {
            return []
        }

        const pages = this.state.pages ?? { current: [], other: [] }
        return this.activeTab === "current" ? pages.current : pages.other
    }

    private getSelectedPeer(): PeerDisplayRow | undefined {
        const selectedItem =
            this.selectList.getSelectedItem() as PromptSelectItem | null
        return selectedItem?.peer
    }
}

export class CleanupPeersPrompt implements Component {
    private readonly container = new Container()
    private readonly title = new Text("", 1, 0)
    private readonly summary = new Text("", 1, 0)
    private readonly tabs = new Text("", 1, 1)
    private readonly details = new Text("", 1, 1)
    private readonly footer = new Text("", 1, 0)
    private readonly items: PromptSelectItem[] = []
    private readonly checkedIds = new Set<string>()
    private readonly selectList
    private readonly tui: TUI
    private readonly theme: Theme
    private readonly notify: ExtensionCommandContext["ui"]["notify"]
    private readonly close: (result: CleanupPromptResult | undefined) => void
    private readonly loadPeers: () => Promise<CleanupPeerPages>
    private state: CleanupLoadState = { kind: "loading" }
    private activeTab: "current" | "other" = "current"
    private safeMode = true
    private disposed = false

    constructor(options: {
        tui: TUI
        theme: Theme
        notify: ExtensionCommandContext["ui"]["notify"]
        close: (result: CleanupPromptResult | undefined) => void
        loadPeers: () => Promise<CleanupPeerPages>
    }) {
        this.tui = options.tui
        this.theme = options.theme
        this.notify = options.notify
        this.close = options.close
        this.loadPeers = options.loadPeers
        this.selectList = createPromptSelectList(this.items, this.theme)

        this.selectList.onSelect = () => {
            this.dispose()
            this.close(
                this.state.kind === "ready"
                    ? {
                          selectedIds: Array.from(this.checkedIds),
                          safeMode: this.safeMode,
                      }
                    : undefined,
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
            if (matchesKey(data, Key.space)) {
                this.toggleSelectedPeer()
                this.tui.requestRender()
                return
            }

            if (data === "f" || data === "F") {
                this.toggleSafeMode()
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

    private toggleSelectedPeer(): void {
        const selectedItem =
            this.selectList.getSelectedItem() as PromptSelectItem | null
        const row = selectedItem?.cleanupPeer
        if (!selectedItem || !row) {
            return
        }

        const reason = cleanupBlockReason(row, this.safeMode)
        if (reason) {
            this.notify(reason, "warning")
            return
        }

        if (this.checkedIds.has(row.id)) {
            this.checkedIds.delete(row.id)
            selectedItem.label = formatCleanupPeerOptionLabel(row, false)
        } else {
            this.checkedIds.add(row.id)
            selectedItem.label = formatCleanupPeerOptionLabel(row, true)
        }

        this.selectList.invalidate()
        this.refreshText()
    }

    private toggleSafeMode(): void {
        this.safeMode = !this.safeMode

        if (this.safeMode) {
            this.pruneBlockedSelections()
        }
        this.refreshContents(false)
        this.notify(
            this.safeMode
                ? "Safe-mode on. Cleanup only allows offline peers with empty inboxes."
                : "Safe-mode off. Live/stalled peers and peers with pending mail can now be selected.",
            this.safeMode ? "info" : "warning",
        )
    }

    private pruneBlockedSelections(): void {
        if (this.state.kind !== "ready") {
            return
        }

        const pages = this.state.pages ?? { current: [], other: [] }
        for (const row of [...pages.current, ...pages.other]) {
            if (this.checkedIds.has(row.id) && cleanupBlockReason(row, true)) {
                this.checkedIds.delete(row.id)
            }
        }
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
        const rows = this.getActivePeers()
        const selectedPeerId = resetSelection ? rows[0]?.id : this.getSelectedPeer()?.id
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
                            "Could not load peers",
                            this.state.message ?? "Unknown error",
                        ),
                    ]
                  : createCleanupPeerItems(
                        rows,
                        this.checkedIds,
                        selectedPeerId,
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
            this.details.setText(
                this.theme.fg("warning", this.state.message ?? "Unknown error"),
            )
            this.footer.setText(this.theme.fg("dim", "Enter/Esc close"))
            return
        }

        const pages = this.state.pages ?? { current: [], other: [] }
        const currentCount = pages.current.length
        const otherCount = pages.other.length
        const selectedRow = this.getSelectedPeer()
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
            `${this.theme.fg("dim", `${this.checkedIds.size} selected`)} • ${this.safeMode ? this.theme.fg("dim", "safe-mode on: only offline peers with empty inboxes") : this.theme.fg("warning", "safe-mode off: live/stalled peers and pending mail can be selected")}`,
        )
        this.tabs.setText(`${currentTab}  ${otherTab}`)
        this.details.setText(this.theme.fg("dim", renderPeerDetails(selectedRow)))
        this.footer.setText(
            this.theme.fg(
                "dim",
                "↑↓ navigate • Space toggle checkbox • f toggle safe-mode • Tab/←→ switch page • Enter clean up • Esc cancel",
            ),
        )
    }

    private getActivePeers(): CleanupPeerRow[] {
        if (this.state.kind !== "ready") {
            return []
        }

        const pages = this.state.pages ?? { current: [], other: [] }
        return this.activeTab === "current" ? pages.current : pages.other
    }

    private getSelectedPeer(): CleanupPeerRow | undefined {
        const selectedItem =
            this.selectList.getSelectedItem() as PromptSelectItem | null
        return selectedItem?.cleanupPeer
    }
}

export class IntroducePeersPrompt implements Component {
    private readonly container = new Container()
    private readonly title = new Text("", 1, 0)
    private readonly tabs = new Text("", 1, 1)
    private readonly details = new Text("", 1, 1)
    private readonly footer = new Text("", 1, 0)
    private readonly items: PromptSelectItem[] = []
    private readonly selectList
    private readonly tui: TUI
    private readonly theme: Theme
    private readonly close: () => void
    private readonly loadGreeting: () => Promise<GreetingResult>
    private state: GreetingLoadState = { kind: "loading" }
    private activeTab: "prepared" | "sent" | "skipped" = "prepared"
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
        this.selectList = createPromptSelectList(this.items, this.theme)

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
        const order: Array<"prepared" | "sent" | "skipped"> = [
            "prepared",
            "sent",
            "skipped",
        ]
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
                            this.state.message ?? "Unknown error",
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
            this.details.setText(
                this.theme.fg("warning", this.state.message ?? "Unknown error"),
            )
            this.footer.setText(this.theme.fg("dim", "Enter/Esc close"))
            return
        }

        const pages = this.getPages()
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
                selectedRow ? renderPeerDetails(selectedRow) : "No peers on this tab.",
            ),
        )
        this.footer.setText(
            this.theme.fg("dim", "↑↓ navigate • Tab/←→ switch tab • Enter/Esc close"),
        )
    }

    private getPages(): GreetingPages {
        if (this.state.kind !== "ready") {
            return { prepared: [], sent: [], skipped: [] }
        }

        return buildGreetingPages(this.state.result as GreetingResult)
    }

    private getActiveGreetings(): GreetingDisplayRow[] {
        const pages = this.getPages()
        return this.activeTab === "prepared"
            ? pages.prepared
            : this.activeTab === "sent"
              ? pages.sent
              : pages.skipped
    }

    private getSelectedGreeting(): GreetingDisplayRow | undefined {
        const selectedItem =
            this.selectList.getSelectedItem() as PromptSelectItem | null
        return selectedItem?.greeting
    }
}
