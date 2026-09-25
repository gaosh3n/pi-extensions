import assert from "node:assert/strict"
import test from "node:test"

import { promptForCatalogPackage } from "./internal/catalog-picker.ts"
import type { CatalogPackage, CatalogSearchResult } from "./internal/model.ts"

const demoPackage: CatalogPackage = {
    name: "pi-demo",
    version: "1.0.0",
    description: "Demo package",
    publisher: "demo",
    downloadCount: 12,
    downloadPeriod: "weekly",
    types: ["extension"],
    links: {},
    installSource: "npm:pi-demo",
}

function createPickerHarness(
    result: CatalogSearchResult = {
        packages: [demoPackage],
        metadataIncomplete: false,
        unresolvedMetadataCount: 0,
        stale: false,
    },
) {
    let component: any
    let resolveCustom: ((value: CatalogPackage | undefined) => void) | undefined
    let searchCalls = 0
    const tui = { requestRender() {} }
    const theme = {
        fg(color: string, text: string) {
            return color === "accent" ? `[cyan]${text}[/cyan]` : `[dim]${text}[/dim]`
        },
        bold(text: string) {
            return text
        },
    }
    const searchCatalog = async () => {
        searchCalls += 1
        return result
    }
    const promise = promptForCatalogPackage(
        {
            ui: {
                custom(factory: any) {
                    return new Promise((resolve) => {
                        resolveCustom = resolve
                        component = factory(tui, theme, {}, resolve)
                    })
                },
            },
        } as any,
        searchCatalog,
        new AbortController().signal,
    )

    return {
        component: () => component,
        promise,
        resolveCustom,
        get searchCalls() {
            return searchCalls
        },
    }
}

test("catalog picker exposes two collapsible, highlighted filter tabs", async () => {
    const harness = createPickerHarness()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const initialLines = harness.component().render(100)
    const titleIndex = initialLines.findIndex((line: string) =>
        line.includes("Install from Pi Catalog"),
    )
    const tabsIndex = initialLines.findIndex((line: string) => line.includes("Sort By"))
    const inputIndex = initialLines.findIndex((line: string) =>
        line.includes("\x1b_pi:c"),
    )
    assert.notEqual(titleIndex, -1)
    assert.equal(tabsIndex, titleIndex + 1)
    assert.ok(tabsIndex < inputIndex)
    assert.match(
        initialLines[tabsIndex]!,
        /\[dim\]Type: All types\[\/dim\].*\[dim\]Sort By: Most downloads\[\/dim\]/u,
    )
    assert.match(initialLines[tabsIndex]!, /Type: All types/u)
    assert.match(initialLines[tabsIndex]!, /Sort By: Most downloads/u)
    const initial = initialLines.join("\n")
    assert.match(initial, /Install from Pi Catalog/u)
    assert.match(initial, /Type/u)
    assert.match(initial, /Sort By/u)
    assert.doesNotMatch(initial, /^  Extensions$/mu)
    assert.doesNotMatch(initial, /^  Recently published$/mu)

    harness.component().handleInput("\t")
    const typeTab = harness.component().render(100).join("\n")
    assert.match(typeTab, /\[cyan\]Type: All types\[\/cyan\]/u)
    assert.match(typeTab, /\[dim\]Sort By: Most downloads\[\/dim\]/u)
    assert.doesNotMatch(typeTab, /^  Extensions$/mu)

    harness.component().handleInput("\r")
    const typeExpandedLines = harness.component().render(100)
    const expandedTabsIndex = typeExpandedLines.findIndex((line: string) =>
        line.includes("Sort By"),
    )
    assert.match(typeExpandedLines[expandedTabsIndex]!, /\[cyan\]Type\[\/cyan\]/u)
    assert.doesNotMatch(typeExpandedLines[expandedTabsIndex]!, /Type: All types/u)
    assert.match(typeExpandedLines[expandedTabsIndex]!, /Sort By: Most downloads/u)
    const typeExpanded = typeExpandedLines.join("\n")
    assert.match(typeExpanded, /^  Extensions$/mu)
    assert.match(typeExpanded, /→ All types/u)

    harness.component().handleInput("\x1b[B")
    assert.match(harness.component().render(100).join("\n"), /→ Extensions/u)

    harness.component().handleInput("\x1b")
    const typeFolded = harness.component().render(100).join("\n")
    assert.doesNotMatch(typeFolded, /^  Extensions$/mu)
    assert.match(typeFolded, /Type: Extensions/u)

    harness.component().handleInput("\t")
    const sortTab = harness.component().render(100).join("\n")
    assert.match(sortTab, /\[dim\]Type: Extensions\[\/dim\]/u)
    assert.match(sortTab, /\[cyan\]Sort By: Most downloads\[\/cyan\]/u)
    assert.doesNotMatch(sortTab, /^  Recently published$/mu)

    harness.component().handleInput("\r")
    const sortExpandedLines = harness.component().render(100)
    const sortExpanded = sortExpandedLines.join("\n")
    const sortExpandedTabs = sortExpandedLines.find((line: string) =>
        line.includes("Sort By"),
    )!
    assert.match(sortExpandedTabs, /\[cyan\]Sort By\[\/cyan\]/u)
    assert.doesNotMatch(sortExpandedTabs, /Sort By: Most downloads/u)
    assert.match(sortExpandedTabs, /Type: Extensions/u)
    assert.match(sortExpanded, /^  Recently published$/mu)

    harness.component().handleInput("\x1b[B")
    assert.match(harness.component().render(100).join("\n"), /→ Recently published/u)

    harness.component().handleInput("\x1b")
    harness.component().handleInput("\t")
    harness.component().handleInput("\r")

    const selected = await harness.promise
    assert.equal(selected?.name, demoPackage.name)
    assert.equal(selected?.version, demoPackage.version)
    assert.deepEqual(selected?.types, demoPackage.types)
})

test("catalog picker moves between filter tabs with Shift+Tab", async () => {
    const harness = createPickerHarness()
    await new Promise((resolve) => setTimeout(resolve, 0))

    harness.component().handleInput("\t")
    harness.component().handleInput("\t")
    const sortTab = harness.component().render(100).join("\n")
    assert.match(sortTab, /\[cyan\]Sort By: Most downloads\[\/cyan\]/u)

    harness.component().handleInput("\x1b[Z")
    const typeTab = harness.component().render(100).join("\n")
    assert.match(typeTab, /\[cyan\]Type: All types\[\/cyan\]/u)
    assert.doesNotMatch(typeTab, /^  Extensions$/mu)
})

test("catalog picker searches on Enter and cancels on Escape", async () => {
    const harness = createPickerHarness()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const callsBefore = harness.searchCalls

    harness.component().handleInput("d")
    harness.component().handleInput("\r")
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(harness.searchCalls, callsBefore + 1)

    harness.component().handleInput("\x1b")
    assert.equal(await harness.promise, undefined)
})
