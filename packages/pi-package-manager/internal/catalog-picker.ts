import {
    DynamicBorder,
    type ExtensionCommandContext,
    type Theme,
} from "@earendil-works/pi-coding-agent"
import {
    Container,
    Input,
    Key,
    SelectList,
    Text,
    type Component,
    type TUI,
    matchesKey,
} from "@earendil-works/pi-tui"

import {
    applyCatalogView,
    sanitizeCatalogPackage,
    type PackageManagerDeps,
} from "./runtime.ts"
import type { CatalogPackage, CatalogSearchRequest, CatalogSort } from "./model.ts"

const TYPE_OPTIONS: Array<{ value: CatalogSearchRequest["type"]; label: string }> = [
    { value: "all", label: "All types" },
    { value: "extension", label: "Extensions" },
    { value: "prompt", label: "Prompts" },
    { value: "skill", label: "Skills" },
    { value: "theme", label: "Themes" },
]

const SORT_OPTIONS: Array<{ value: CatalogSort; label: string }> = [
    { value: "downloads", label: "Most downloads" },
    { value: "recent", label: "Recently published" },
    { value: "name", label: "A-Z" },
]

type FocusTarget = "search" | "type" | "sort" | "results"

export async function promptForCatalogPackage(
    ctx: Pick<ExtensionCommandContext, "ui">,
    searchCatalog: PackageManagerDeps["searchCatalog"],
    signal: AbortSignal,
): Promise<CatalogPackage | undefined> {
    if (signal.aborted) {
        return undefined
    }

    return ctx.ui.custom<CatalogPackage | undefined>(
        (
            tui: TUI,
            theme: Theme,
            _keybindings: unknown,
            done: (value: CatalogPackage | undefined) => void,
        ) => new CatalogPicker(tui, theme, searchCatalog, signal, done),
        {
            overlay: true,
            overlayOptions: {
                width: "82%",
                minWidth: 64,
                maxHeight: "88%",
            },
        },
    )
}

class CatalogPicker implements Component {
    private readonly container = new Container()
    private readonly title = new Text("", 1, 0)
    private readonly summary = new Text("", 1, 0)
    private readonly details = new Text("", 1, 0)
    private readonly status = new Text("", 1, 0)
    private readonly footer = new Text("", 1, 0)
    private readonly input: Input
    private readonly tui: TUI
    private readonly theme: Theme
    private readonly searchCatalog: PackageManagerDeps["searchCatalog"]
    private readonly parentSignal: AbortSignal
    private activeRequestController: AbortController | undefined
    private readonly typeList: SelectList
    private readonly sortList: SelectList
    private resultList: SelectList
    private allPackages: CatalogPackage[] = []
    private visiblePackages: CatalogPackage[] = []
    private focus: FocusTarget = "search"
    private loading = true
    private errorMessage: string | undefined
    private stale = false
    private metadataWarning: string | undefined
    private requestGeneration = 0
    private finished = false

    constructor(
        tui: TUI,
        theme: Theme,
        searchCatalog: PackageManagerDeps["searchCatalog"],
        signal: AbortSignal,
        done: (value: CatalogPackage | undefined) => void,
    ) {
        this.tui = tui
        this.theme = theme
        this.searchCatalog = searchCatalog
        this.parentSignal = signal
        this.done = done
        this.input = new Input()
        this.input.onSubmit = () => {
            void this.search()
        }
        this.input.onEscape = () => this.cancel()

        this.typeList = this.createOptionList(TYPE_OPTIONS, () => this.applyView())
        this.sortList = this.createOptionList(SORT_OPTIONS, () => this.applyView())
        this.resultList = this.createResultList([])

        this.parentSignal.addEventListener("abort", () => this.cancel(), {
            once: true,
        })
        this.rebuildContainer()
        this.refreshText()
        if (!this.parentSignal.aborted) {
            void this.search()
        }
    }

    private readonly done: (value: CatalogPackage | undefined) => void

    handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
            this.cancel()
            return
        }

        if (matchesKey(data, Key.tab)) {
            this.moveFocus(1)
            return
        }

        if (matchesKey(data, Key.shift("tab"))) {
            this.moveFocus(-1)
            return
        }

        if (this.focus === "search") {
            this.input.handleInput(data)
        } else if (this.focus === "type") {
            this.typeList.handleInput(data)
        } else if (this.focus === "sort") {
            this.sortList.handleInput(data)
        } else {
            this.resultList.handleInput(data)
        }

        this.refreshText()
        this.tui.requestRender()
    }

    invalidate(): void {
        this.container.invalidate()
        this.input.invalidate()
        this.typeList.invalidate()
        this.sortList.invalidate()
        this.resultList.invalidate()
        this.refreshText()
    }

    render(width: number): string[] {
        this.input.focused = this.focus === "search"
        return this.container.render(width)
    }

    private createOptionList<T extends { value: string; label: string }>(
        options: T[],
        onChange: () => void,
    ): SelectList {
        const list = new SelectList(
            options.map((option) => ({ value: option.value, label: option.label })),
            options.length,
            {
                selectedPrefix: (text) => this.theme.fg("accent", text),
                selectedText: (text) => this.theme.fg("accent", text),
                description: (text) => this.theme.fg("muted", text),
                scrollInfo: (text) => this.theme.fg("dim", text),
                noMatch: (text) => this.theme.fg("warning", text),
            },
        )
        list.onSelectionChange = onChange
        list.onSelect = onChange
        return list
    }

    private createResultList(packages: CatalogPackage[]): SelectList {
        const list = new SelectList(
            packages.map((pkg) => ({
                value: pkg.name,
                label: `${pkg.name}@${pkg.version}`,
                description: formatResultDescription(pkg),
            })),
            Math.min(Math.max(packages.length, 1), 8),
            {
                selectedPrefix: (text) => this.theme.fg("accent", text),
                selectedText: (text) => this.theme.fg("accent", text),
                description: (text) => this.theme.fg("muted", text),
                scrollInfo: (text) => this.theme.fg("dim", text),
                noMatch: (text) => this.theme.fg("warning", text),
            },
        )
        list.onSelect = (item) => {
            const selected = this.visiblePackages.find((pkg) => pkg.name === item.value)
            if (selected) this.finish(selected)
        }
        list.onSelectionChange = () => {
            this.refreshText()
            this.tui.requestRender()
        }
        list.onCancel = () => this.cancel()
        return list
    }

    private rebuildContainer(): void {
        this.container.clear()
        this.container.addChild(
            new DynamicBorder((text: string) => this.theme.fg("accent", text)),
        )
        this.container.addChild(this.title)
        this.container.addChild(this.summary)
        this.container.addChild(this.input)
        this.container.addChild(this.typeList)
        this.container.addChild(this.sortList)
        this.container.addChild(this.status)
        this.container.addChild(this.resultList)
        this.container.addChild(this.details)
        this.container.addChild(this.footer)
        this.container.addChild(
            new DynamicBorder((text: string) => this.theme.fg("accent", text)),
        )
    }

    private moveFocus(delta: number): void {
        const targets: FocusTarget[] = ["search", "type", "sort", "results"]
        const index = targets.indexOf(this.focus)
        this.focus = targets[(index + delta + targets.length) % targets.length]!
        this.refreshText()
        this.tui.requestRender()
    }

    private async search(): Promise<void> {
        if (this.finished) return
        if (this.parentSignal.aborted) {
            this.cancel()
            return
        }

        const generation = ++this.requestGeneration
        this.activeRequestController?.abort()
        const requestController = new AbortController()
        this.activeRequestController = requestController
        const abortRequest = () => requestController.abort()
        this.parentSignal.addEventListener("abort", abortRequest, { once: true })
        this.loading = true
        this.errorMessage = undefined
        this.stale = false
        this.metadataWarning = undefined
        this.refreshText()
        this.tui.requestRender()

        try {
            const result = await this.searchCatalog(
                {
                    query: this.input.getValue().trim(),
                    type: "all",
                    sort: "downloads",
                },
                requestController.signal,
            )
            if (this.finished || generation !== this.requestGeneration) return
            this.allPackages = result.packages
                .map(sanitizeCatalogPackage)
                .filter((pkg): pkg is CatalogPackage => pkg !== undefined)
            this.stale = result.stale
            this.metadataWarning = result.metadataIncomplete
                ? `${result.unresolvedMetadataCount} package record${result.unresolvedMetadataCount === 1 ? "" : "s"} could not be resolved; the list is partial.`
                : undefined
            this.applyView()
        } catch (error) {
            if (
                this.finished ||
                generation !== this.requestGeneration ||
                isAbortError(error)
            ) {
                return
            }
            this.errorMessage = error instanceof Error ? error.message : String(error)
            this.allPackages = []
            this.visiblePackages = []
            this.replaceResultList([])
        } finally {
            this.parentSignal.removeEventListener("abort", abortRequest)
            if (!this.finished && generation === this.requestGeneration) {
                this.loading = false
                this.refreshText()
                this.tui.requestRender()
            }
        }
    }

    private applyView(): void {
        const type = TYPE_OPTIONS[this.typeListIndex()]?.value ?? "all"
        const sort = SORT_OPTIONS[this.sortListIndex()]?.value ?? "downloads"
        this.visiblePackages = applyCatalogView(this.allPackages, type, sort)
        this.replaceResultList(this.visiblePackages)
        this.refreshText()
        this.tui.requestRender()
    }

    private typeListIndex(): number {
        return this.indexOfSelected(this.typeList, TYPE_OPTIONS.length)
    }

    private sortListIndex(): number {
        return this.indexOfSelected(this.sortList, SORT_OPTIONS.length)
    }

    private indexOfSelected(list: SelectList, length: number): number {
        const value = list.getSelectedItem()?.value
        const index =
            list === this.typeList
                ? TYPE_OPTIONS.findIndex((option) => option.value === value)
                : SORT_OPTIONS.findIndex((option) => option.value === value)
        return index >= 0 && index < length ? index : 0
    }

    private replaceResultList(packages: CatalogPackage[]): void {
        this.resultList = this.createResultList(packages)
        this.rebuildContainer()
    }

    private refreshText(): void {
        const type = TYPE_OPTIONS[this.typeListIndex()]?.label ?? "All types"
        const sort = SORT_OPTIONS[this.sortListIndex()]?.label ?? "Most downloads"
        const selected = this.resultList.getSelectedItem()
        const selectedPackage = selected
            ? this.visiblePackages.find((pkg) => pkg.name === selected.value)
            : undefined

        this.title.setText(
            this.theme.fg("accent", this.theme.bold("Install from Pi Catalog")),
        )
        this.summary.setText(
            this.theme.fg(
                "dim",
                `Search: ${this.input.getValue() || "(all packages)"} • Type: ${type} • Sort: ${sort}`,
            ),
        )
        const statusMessage = this.loading
            ? "Loading catalog…"
            : this.errorMessage
              ? `Catalog error: ${this.errorMessage}`
              : [
                    this.stale ? "Showing cached results; refresh failed." : undefined,
                    this.metadataWarning,
                    this.visiblePackages.length === 0
                        ? "No packages found."
                        : `${this.visiblePackages.length} package${this.visiblePackages.length === 1 ? "" : "s"} found.`,
                ]
                    .filter((message): message is string => message !== undefined)
                    .join(" ")

        this.status.setText(
            this.theme.fg(
                this.errorMessage
                    ? "error"
                    : this.stale || this.metadataWarning
                      ? "warning"
                      : "dim",
                statusMessage,
            ),
        )
        this.details.setText(
            selectedPackage
                ? this.theme.fg("dim", formatPackageDetails(selectedPackage))
                : this.theme.fg("dim", "Select a package to see details."),
        )
        this.footer.setText(
            this.theme.fg(
                "dim",
                "tab/shift-tab focus • enter search/select • ↑↓ navigate • esc cancel",
            ),
        )
    }

    private finish(pkg: CatalogPackage): void {
        if (this.finished) return
        this.finished = true
        this.activeRequestController?.abort()
        this.done?.(pkg)
    }

    private cancel(): void {
        if (this.finished) return
        this.finished = true
        this.activeRequestController?.abort()
        this.done?.(undefined)
    }
}

function formatResultDescription(pkg: CatalogPackage): string {
    const types = pkg.types.join(", ")
    const downloads =
        pkg.downloadCount === undefined
            ? "downloads n/a"
            : `${pkg.downloadCount.toLocaleString()} weekly downloads`
    return `${types} • ${downloads} • ${pkg.description || "No description"}`
}

function formatPackageDetails(pkg: CatalogPackage): string {
    return [
        `${pkg.name}@${pkg.version}`,
        `Types: ${pkg.types.join(", ")}`,
        `Publisher: ${pkg.publisher ?? "unknown"}`,
        `Downloads: ${pkg.downloadCount === undefined ? "n/a" : `${pkg.downloadCount.toLocaleString()} weekly`}`,
        `Source: ${pkg.installSource}`,
        pkg.description || "No description",
    ].join("\n")
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError"
}
