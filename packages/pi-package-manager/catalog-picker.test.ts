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
        fg(_color: string, text: string) {
            return text
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

test("catalog picker renders controls and tab traversal selects a result", async () => {
    const harness = createPickerHarness()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const initial = harness.component().render(100).join("\n")
    assert.match(initial, /Install from Pi Catalog/u)
    assert.match(initial, /All types/u)
    assert.match(initial, /Most downloads/u)
    assert.match(initial, /pi-demo@1\.0\.0/u)

    harness.component().handleInput("\t")
    harness.component().handleInput("\t")
    harness.component().handleInput("\t")
    harness.component().handleInput("\r")

    const selected = await harness.promise
    assert.equal(selected?.name, demoPackage.name)
    assert.equal(selected?.version, demoPackage.version)
    assert.deepEqual(selected?.types, demoPackage.types)
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
