import test from "node:test"
import assert from "node:assert/strict"

import { DefaultPackageManager } from "@earendil-works/pi-coding-agent"

import init, {
    AUTO_UPDATE_RECORD_ENTRY_TYPE,
    PACKAGE_MANAGER_TITLE,
    REPORT_ENTRY_TYPE,
    createAutomaticUpdateWidgetLines,
    createManualUpdateReport,
    createManualUpdateStartReport,
    createStatusReport,
} from "./index.ts"

interface CapturedEntry {
    type: string
    data: unknown
}

interface CapturedWidgetCall {
    key: string
    content: unknown
}

interface Harness {
    entries: CapturedEntry[]
    sentUserMessages: Array<{ message: string; options: unknown }>
    statuses: Array<{ key: string; text: string | undefined }>
    widgets: CapturedWidgetCall[]
    sessionStartHandler: (
        event: { reason: "startup" | "reload" },
        ctx: any,
    ) => Promise<void>
    commandHandler: (args: string, ctx: any) => Promise<void>
    ctx: any
}

function createHarness(options?: {
    exec?: () => Promise<{ code: number; stdout: string; stderr: string }>
}): Harness {
    const entries: CapturedEntry[] = []
    const sentUserMessages: Array<{ message: string; options: unknown }> = []
    const statuses: Array<{ key: string; text: string | undefined }> = []
    const widgets: CapturedWidgetCall[] = []

    let sessionStartHandler: Harness["sessionStartHandler"] | undefined
    let commandHandler: Harness["commandHandler"] | undefined

    const ctx = {
        cwd: process.cwd(),
        signal: undefined,
        mode: "tui",
        hasUI: true,
        sessionManager: { getEntries: () => [] },
        modelRegistry: {},
        model: undefined,
        scopedModels: [],
        isIdle: () => true,
        isProjectTrusted: () => true,
        abort() {},
        hasPendingMessages: () => false,
        shutdown() {},
        getContextUsage: () => undefined,
        compact() {},
        getSystemPrompt: () => "",
        getSystemPromptOptions: () => ({}),
        waitForIdle: async () => {},
        newSession: async () => ({ cancelled: false }),
        fork: async () => ({ cancelled: false }),
        navigateTree: async () => ({ cancelled: false }),
        switchSession: async () => ({ cancelled: false }),
        reload: async () => {},
        ui: {
            notify() {},
            setStatus(key: string, text: string | undefined) {
                statuses.push({ key, text })
            },
            setWidget(key: string, content: unknown) {
                widgets.push({ key, content })
            },
        },
    }

    init({
        registerEntryRenderer() {},
        on(event: string, handler: Harness["sessionStartHandler"]) {
            if (event === "session_start") {
                sessionStartHandler = handler
            }
        },
        sendUserMessage(message: string, sendOptions: unknown) {
            sentUserMessages.push({ message, options: sendOptions })
        },
        registerCommand(
            name: string,
            commandOptions: { handler: Harness["commandHandler"] },
        ) {
            if (name === "package-manager") {
                commandHandler = commandOptions.handler
            }
        },
        appendEntry(type: string, data?: unknown) {
            entries.push({ type, data })
        },
        async exec() {
            if (options?.exec) {
                return options.exec()
            }

            throw new Error("exec should not run in offline test")
        },
    } as any)

    if (!sessionStartHandler || !commandHandler) {
        throw new Error("package manager did not register expected handlers")
    }

    return {
        entries,
        sentUserMessages,
        statuses,
        widgets,
        sessionStartHandler,
        commandHandler,
        ctx,
    }
}

test("report factories keep the title consistent", () => {
    assert.equal(createManualUpdateStartReport().title, PACKAGE_MANAGER_TITLE)
    assert.equal(
        createManualUpdateReport({ outcome: "skipped", packagesUpdated: 0 }).title,
        PACKAGE_MANAGER_TITLE,
    )
    assert.equal(
        createStatusReport({ availableUpdates: [], lastAutoUpdate: undefined }).title,
        PACKAGE_MANAGER_TITLE,
    )
})

test("automatic update widget lines describe progress and countdown", () => {
    assert.deepEqual(createAutomaticUpdateWidgetLines({ mode: "checking" }), [
        "Automatic startup update in progress.",
        "Checking for package updates...",
    ])
    assert.deepEqual(
        createAutomaticUpdateWidgetLines({ mode: "installing", packages: 2 }),
        ["Automatic startup update in progress.", "Installing 2 package updates..."],
    )
    assert.deepEqual(
        createAutomaticUpdateWidgetLines({ mode: "countdown", secondsRemaining: 1 }),
        [
            "Automatic startup update completed.",
            "Reloading in 1 second to activate updated package resources.",
        ],
    )
})

test("manual update reports progress to transcript without footer status text", async () => {
    const originalOffline = process.env.PI_OFFLINE
    process.env.PI_OFFLINE = "1"

    try {
        const harness = createHarness()
        await harness.commandHandler("update", harness.ctx)

        assert.deepEqual(harness.statuses, [])
        assert.equal(harness.entries.length, 2)
        assert.deepEqual(harness.entries[0], {
            type: REPORT_ENTRY_TYPE,
            data: {
                title: PACKAGE_MANAGER_TITLE,
                tone: "info",
                lines: [
                    "Manual update in progress.",
                    "Checking for package updates...",
                ],
            },
        })
        assert.equal(harness.entries[1]?.type, REPORT_ENTRY_TYPE)
    } finally {
        process.env.PI_OFFLINE = originalOffline
    }
})

test("automatic startup update records skipped outcome and appends a final report", async () => {
    const originalOffline = process.env.PI_OFFLINE
    process.env.PI_OFFLINE = "1"

    try {
        const harness = createHarness()
        await harness.sessionStartHandler({ reason: "startup" }, harness.ctx)

        assert.deepEqual(harness.sentUserMessages, [
            {
                message: "/package-manager update --startup",
                options: { expandPromptTemplates: true },
            },
        ])

        await harness.commandHandler("update --startup", harness.ctx)

        assert.deepEqual(harness.statuses, [])
        assert.equal(harness.entries.length, 2)
        assert.equal(harness.entries[0]?.type, AUTO_UPDATE_RECORD_ENTRY_TYPE)
        assert.deepEqual(harness.entries[1], {
            type: REPORT_ENTRY_TYPE,
            data: {
                title: PACKAGE_MANAGER_TITLE,
                tone: "info",
                lines: [
                    "Automatic startup update skipped.",
                    `Start: ${String(
                        (harness.entries[0] as { data: { startedAtUtc: string } }).data
                            .startedAtUtc,
                    )
                        .replace("T", " ")
                        .replace(/\.\d{3}Z$/, " UTC+00")}`,
                    `End: ${String(
                        (harness.entries[0] as { data: { endedAtUtc: string } }).data
                            .endedAtUtc,
                    )
                        .replace("T", " ")
                        .replace(/\.\d{3}Z$/, " UTC+00")}`,
                    "Result: skipped",
                    "Packages updated: 0",
                    "Detail: PI_OFFLINE is set.",
                ],
                output: undefined,
            },
        })
        assert.equal(harness.widgets.length, 2)
        assert.equal(harness.widgets[0]?.key, "pi-package-manager")
        assert.equal(typeof harness.widgets[0]?.content, "function")
        assert.deepEqual(harness.widgets[1], {
            key: "pi-package-manager",
            content: undefined,
        })
    } finally {
        process.env.PI_OFFLINE = originalOffline
    }
})

test("automatic startup update reports no-update skip as a final report", async () => {
    const originalOffline = process.env.PI_OFFLINE
    const originalCheckForAvailableUpdates =
        DefaultPackageManager.prototype.checkForAvailableUpdates
    delete process.env.PI_OFFLINE

    try {
        DefaultPackageManager.prototype.checkForAvailableUpdates = async () => [] as any

        const harness = createHarness()
        await harness.commandHandler("update --startup", harness.ctx)

        assert.equal(harness.entries.length, 2)
        assert.equal(harness.entries[0]?.type, AUTO_UPDATE_RECORD_ENTRY_TYPE)
        assert.deepEqual(harness.entries[1], {
            type: REPORT_ENTRY_TYPE,
            data: {
                title: PACKAGE_MANAGER_TITLE,
                tone: "info",
                lines: [
                    "Automatic startup update skipped.",
                    `Start: ${String(
                        (harness.entries[0] as { data: { startedAtUtc: string } }).data
                            .startedAtUtc,
                    )
                        .replace("T", " ")
                        .replace(/\.\d{3}Z$/, " UTC+00")}`,
                    `End: ${String(
                        (harness.entries[0] as { data: { endedAtUtc: string } }).data
                            .endedAtUtc,
                    )
                        .replace("T", " ")
                        .replace(/\.\d{3}Z$/, " UTC+00")}`,
                    "Result: skipped",
                    "Packages updated: 0",
                    "Detail: No package updates are available.",
                ],
                output: undefined,
            },
        })
    } finally {
        process.env.PI_OFFLINE = originalOffline
        DefaultPackageManager.prototype.checkForAvailableUpdates =
            originalCheckForAvailableUpdates
    }
})

test("automatic startup update does not touch stale ctx after reload", async () => {
    const originalOffline = process.env.PI_OFFLINE
    const originalCheckForAvailableUpdates =
        DefaultPackageManager.prototype.checkForAvailableUpdates
    const originalSetTimeout = globalThis.setTimeout
    delete process.env.PI_OFFLINE

    try {
        DefaultPackageManager.prototype.checkForAvailableUpdates = async () =>
            [{ displayName: "pi-package-manager" }] as any
        globalThis.setTimeout = ((callback: (...args: never[]) => void) => {
            callback()
            return 0 as never
        }) as unknown as typeof setTimeout

        const harness = createHarness({
            exec: async () => ({ code: 0, stdout: "updated", stderr: "" }),
        })
        let reloaded = false
        harness.ctx.reload = async () => {
            reloaded = true
        }
        harness.ctx.ui.setWidget = (key: string, content: unknown) => {
            if (reloaded) {
                throw new Error("This extension ctx is stale after reload")
            }

            harness.widgets.push({ key, content })
        }
        ;(
            harness.ctx.ui as { notify: (message: string, level: string) => void }
        ).notify = (message: string, level: string) => {
            if (reloaded) {
                throw new Error("This extension ctx is stale after reload")
            }

            void message
            void level
        }
        await assert.doesNotReject(() =>
            harness.commandHandler("update --startup", harness.ctx),
        )
    } finally {
        process.env.PI_OFFLINE = originalOffline
        DefaultPackageManager.prototype.checkForAvailableUpdates =
            originalCheckForAvailableUpdates
        globalThis.setTimeout = originalSetTimeout
    }
})
