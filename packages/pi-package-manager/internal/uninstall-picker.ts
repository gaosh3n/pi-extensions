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

import type { ConfiguredPackageOption } from "./model.ts"

export async function promptForPackagesToUninstall(
    ctx: Pick<ExtensionCommandContext, "ui">,
    packages: ConfiguredPackageOption[],
): Promise<string[] | undefined> {
    return ctx.ui.custom<string[] | undefined>(
        (tui, theme, _keybindings, done) => {
            const picker = new PackageUninstallPicker(tui, theme, packages)
            picker.done = done
            return picker
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
}

class PackageUninstallPicker implements Component {
    private readonly container = new Container()
    private readonly title = new Text("", 1, 0)
    private readonly summary = new Text("", 1, 0)
    private readonly footer = new Text("", 1, 0)
    private readonly checkedSources = new Set<string>()
    private readonly items: SelectItem[]
    private readonly selectList: SelectList
    private readonly tui: TUI
    private readonly theme: Theme

    constructor(tui: TUI, theme: Theme, packages: ConfiguredPackageOption[]) {
        this.tui = tui
        this.theme = theme
        this.items = packages.map((pkg) => ({
            value: pkg.source,
            label: formatPackageOptionLabel(pkg.source, false),
        }))
        this.selectList = new SelectList(this.items, Math.min(this.items.length, 10), {
            selectedPrefix: (text) => this.theme.fg("accent", text),
            selectedText: (text) => this.theme.fg("accent", text),
            description: (text) => this.theme.fg("muted", text),
            scrollInfo: (text) => this.theme.fg("dim", text),
            noMatch: (text) => this.theme.fg("warning", text),
        })

        this.selectList.onSelect = () => {
            this.done?.(Array.from(this.checkedSources))
        }
        this.selectList.onCancel = () => {
            this.done?.(undefined)
        }

        this.container.addChild(
            new DynamicBorder((text: string) => this.theme.fg("accent", text)),
        )
        this.container.addChild(this.title)
        this.container.addChild(this.summary)
        this.container.addChild(this.selectList)
        this.container.addChild(this.footer)
        this.container.addChild(
            new DynamicBorder((text: string) => this.theme.fg("accent", text)),
        )

        this.refreshText()
    }

    done?: (value: string[] | undefined) => void

    handleInput(data: string): void {
        if (matchesKey(data, Key.space)) {
            this.toggleSelectedItem()
            this.tui.requestRender()
            return
        }

        this.selectList.handleInput(data)
        this.tui.requestRender()
    }

    invalidate(): void {
        this.container.invalidate()
        this.refreshText()
    }

    render(width: number): string[] {
        return this.container.render(width)
    }

    private refreshText(): void {
        this.title.setText(
            this.theme.fg("accent", this.theme.bold("Select Pi Packages to Uninstall")),
        )
        this.summary.setText(
            this.theme.fg(
                "dim",
                `${this.checkedSources.size} selected • enter confirm • esc cancel`,
            ),
        )
        this.footer.setText(this.theme.fg("dim", "↑↓ navigate • space toggle checkbox"))
    }

    private toggleSelectedItem(): void {
        const selectedItem = this.selectList.getSelectedItem()

        if (!selectedItem) {
            return
        }

        if (this.checkedSources.has(selectedItem.value)) {
            this.checkedSources.delete(selectedItem.value)
            selectedItem.label = formatPackageOptionLabel(selectedItem.value, false)
        } else {
            this.checkedSources.add(selectedItem.value)
            selectedItem.label = formatPackageOptionLabel(selectedItem.value, true)
        }

        this.selectList.invalidate()
        this.refreshText()
    }
}

function formatPackageOptionLabel(source: string, checked: boolean): string {
    return `${checked ? "[x]" : "[ ]"} ${source}`
}
