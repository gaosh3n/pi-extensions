import assert from "node:assert/strict"
import test from "node:test"

import { type ExecResult } from "@earendil-works/pi-coding-agent"

import init, {
    AUTO_UPDATE_RECORD_ENTRY_TYPE,
    PACKAGE_MANAGER_TITLE,
    REPORT_ENTRY_TYPE,
    createAutomaticUpdateWidgetLines,
    createAutoUpdateResultReport,
    createStatusReport,
    type AutoUpdateRecord,
    type PackageManagerDeps,
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
    notifications: Array<{ message: string; level: string }>
    sentUserMessages: Array<{ message: string; options: unknown }>
    statuses: Array<{ key: string; text: string | undefined }>
    widgets: CapturedWidgetCall[]
    reportRenderer:
        | ((
              entry: { data: unknown },
              options: { expanded: boolean },
              theme: any,
          ) => any)
        | undefined
    sessionStartHandler: (
        event: { reason: "startup" | "reload" },
        ctx: any,
    ) => Promise<void>
    commandHandler: (args: string, ctx: any) => Promise<void>
    ctx: any
}

function createHarness(options?: {
    deps?: Partial<PackageManagerDeps>
    nowIsoValues?: string[]
    sessionEntries?: any[]
}): Harness {
    const entries: CapturedEntry[] = []
    const notifications: Array<{ message: string; level: string }> = []
    const sentUserMessages: Array<{ message: string; options: unknown }> = []
    const statuses: Array<{ key: string; text: string | undefined }> = []
    const widgets: CapturedWidgetCall[] = []
    const sessionEntries = [...(options?.sessionEntries ?? [])]

    let reportRenderer: Harness["reportRenderer"]
    let sessionStartHandler: Harness["sessionStartHandler"] | undefined
    let commandHandler: Harness["commandHandler"] | undefined

    const nowIsoValues = options?.nowIsoValues ?? [
        "2025-08-27T13:42:01.000Z",
        "2025-08-27T13:42:02.000Z",
        "2025-08-27T13:42:03.000Z",
        "2025-08-27T13:42:04.000Z",
    ]
    let nowIsoIndex = 0

    const deps: PackageManagerDeps = {
        nowIso: () => nowIsoValues[Math.min(nowIsoIndex++, nowIsoValues.length - 1)]!,
        sleep: async () => {},
        isOffline: () => false,
        checkForAvailableUpdates: async () => [],
        runNativeUpdate: async () =>
            createExecResult({ code: 0, stdout: "", stderr: "" }),
        ...options?.deps,
    }

    const ctx = {
        cwd: process.cwd(),
        signal: undefined,
        mode: "tui",
        hasUI: true,
        sessionManager: { getEntries: () => sessionEntries },
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
            notify(message: string, level: string) {
                notifications.push({ message, level })
            },
            setStatus(key: string, text: string | undefined) {
                statuses.push({ key, text })
            },
            setWidget(key: string, content: unknown) {
                widgets.push({ key, content })
            },
        },
    }

    init(
        {
            registerEntryRenderer(_type: string, renderer: Harness["reportRenderer"]) {
                reportRenderer = renderer
            },
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
                sessionEntries.push({ type: "custom", customType: type, data })
            },
            async exec() {
                throw new Error("exec should not be called when using injected deps")
            },
        } as any,
        deps,
    )

    if (!sessionStartHandler || !commandHandler) {
        throw new Error("package manager did not register expected handlers")
    }

    return {
        entries,
        notifications,
        sentUserMessages,
        statuses,
        widgets,
        reportRenderer,
        sessionStartHandler,
        commandHandler,
        ctx,
    }
}

function createSessionRecordEntry(record: AutoUpdateRecord) {
    return {
        type: "custom",
        customType: AUTO_UPDATE_RECORD_ENTRY_TYPE,
        data: record,
    }
}

function createExecResult(input: {
    code: number
    stdout: string
    stderr: string
}): ExecResult {
    return {
        code: input.code,
        stdout: input.stdout,
        stderr: input.stderr,
        killed: false,
    }
}

test("report factories keep the title consistent", () => {
    assert.equal(
        createAutoUpdateResultReport({
            record: {
                startedAtUtc: "2025-08-27T13:42:01.000Z",
                endedAtUtc: "2025-08-27T13:42:02.000Z",
                outcome: "skipped",
                packagesUpdated: 0,
            },
        }).title,
        PACKAGE_MANAGER_TITLE,
    )
    assert.equal(
        createStatusReport({ availableUpdates: [], lastAutoUpdate: undefined }).title,
        PACKAGE_MANAGER_TITLE,
    )
})

test("automatic update widget lines describe progress and countdown", () => {
    assert.deepEqual(createAutomaticUpdateWidgetLines({ mode: "status-checking" }), [
        "Pi package status in progress.",
        "Checking for package updates...",
    ])
    assert.deepEqual(createAutomaticUpdateWidgetLines({ mode: "checking" }), [
        "Pi package(s) update in progress.",
        "Checking for package updates...",
    ])
    assert.deepEqual(
        createAutomaticUpdateWidgetLines({ mode: "installing", packages: 2 }),
        ["Pi package(s) update in progress.", "Installing 2 package updates..."],
    )
    assert.deepEqual(
        createAutomaticUpdateWidgetLines({ mode: "countdown", secondsRemaining: 1 }),
        [
            "Pi package(s) update completed.",
            "Reloading in 1 second to activate updated package resources.",
        ],
    )
})

test("auto-update result report uses output field for skipped detail", () => {
    const report = createAutoUpdateResultReport({
        record: {
            startedAtUtc: "2025-08-27T13:42:01.000Z",
            endedAtUtc: "2025-08-27T13:42:02.000Z",
            outcome: "skipped",
            packagesUpdated: 0,
            reason: "PI_OFFLINE is set.",
        },
    })

    assert.equal(report.headline, "Pi package(s) update skipped.")
    assert.equal(report.lineTone, "dim")
    assert.equal(report.output, "PI_OFFLINE is set.")
    assert.equal(report.outputTone, "dim")
    assert.equal(report.hideOutputWhenCollapsed, true)
    assert.doesNotMatch(report.lines.join("\n"), /Detail:/)
})

test("status report uses the same card vocabulary with semantic status sections", () => {
    const report = createStatusReport({
        availableUpdates: ["alpha", "beta"],
        lastAutoUpdate: {
            startedAtUtc: "2025-08-27T13:42:01.000Z",
            endedAtUtc: "2025-08-27T13:42:02.000Z",
            outcome: "succeeded",
            packagesUpdated: 2,
        },
    })

    assert.equal(report.headline, "2 package updates are available.")
    assert.equal(report.lineTone, "dim")
    assert.deepEqual(report.lines, [
        "Latest update start: 2025-08-27 13:42:01 UTC+00",
        "Latest update end: 2025-08-27 13:42:02 UTC+00",
        "Latest update result: succeeded",
        "Latest update packages updated: 2",
    ])
    assert.equal(report.outputLabel, "Available updates:")
    assert.equal(report.output, "- alpha\n- beta")
    assert.equal(report.outputTone, "dim")
})

test("collapsed auto-update report keeps headline plain and hides output behind an expand hint", () => {
    const harness = createHarness()

    assert.ok(harness.reportRenderer)

    const component = harness.reportRenderer(
        {
            data: createAutoUpdateResultReport({
                record: {
                    startedAtUtc: "2025-08-27T13:42:01.000Z",
                    endedAtUtc: "2025-08-27T13:42:02.000Z",
                    outcome: "succeeded",
                    packagesUpdated: 2,
                },
                output: "line 1\nline 2",
                reloadAfterSeconds: 5,
            }),
        },
        { expanded: false },
        {
            fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
            bg: (token: string, text: string) => `{${token}}${text}{/${token}}`,
            bold: (text: string) => `*${text}*`,
        },
    )
    const rendered = component.render(120).join("\n")

    assert.match(rendered, /<text>Pi package\(s\) update completed\.<\/text>/)
    assert.match(rendered, /<dim>Start: 2025-08-27 13:42:01 UTC\+00<\/dim>/)
    assert.match(rendered, /<dim>Result: succeeded<\/dim>/)
    assert.match(
        rendered,
        /<dim>(?:ctrl\+o|Ctrl\+O)<\/dim><muted> to expand to see update output\.<\/muted>/,
    )
    assert.doesNotMatch(rendered, /Update output:/)
    assert.doesNotMatch(rendered, /line 1/)
    assert.doesNotMatch(
        rendered,
        /<customMessageText>Pi package\(s\) update completed\.<\/customMessageText>/,
    )
    assert.doesNotMatch(
        rendered,
        /<customMessageText>Start: 2025-08-27 13:42:01 UTC\+00<\/customMessageText>/,
    )
})

test("expanded auto-update report shows full update output", () => {
    const harness = createHarness()

    assert.ok(harness.reportRenderer)

    const component = harness.reportRenderer(
        {
            data: createAutoUpdateResultReport({
                record: {
                    startedAtUtc: "2025-08-27T13:42:01.000Z",
                    endedAtUtc: "2025-08-27T13:42:02.000Z",
                    outcome: "succeeded",
                    packagesUpdated: 2,
                },
                output: "line 1\nline 2",
                reloadAfterSeconds: 5,
            }),
        },
        { expanded: true },
        {
            fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
            bg: (token: string, text: string) => `{${token}}${text}{/${token}}`,
            bold: (text: string) => `*${text}*`,
        },
    )
    const rendered = component.render(120).join("\n")

    assert.match(rendered, /<dim>Update output:<\/dim>/)
    assert.match(rendered, /<dim>line 1/)
    assert.doesNotMatch(rendered, /to expand to see update output/)
})

test("status report renderer uses a semantic section label instead of update output", () => {
    const harness = createHarness()

    assert.ok(harness.reportRenderer)

    const component = harness.reportRenderer(
        {
            data: createStatusReport({
                availableUpdates: ["alpha", "beta"],
                lastAutoUpdate: {
                    startedAtUtc: "2025-08-27T13:42:01.000Z",
                    endedAtUtc: "2025-08-27T13:42:02.000Z",
                    outcome: "succeeded",
                    packagesUpdated: 2,
                },
            }),
        },
        { expanded: true },
        {
            fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
            bg: (token: string, text: string) => `{${token}}${text}{/${token}}`,
            bold: (text: string) => `*${text}*`,
        },
    )
    const rendered = component.render(120).join("\n")

    assert.match(rendered, /<text>2 package updates are available\.<\/text>/)
    assert.match(rendered, /<dim>Latest update result: succeeded<\/dim>/)
    assert.match(rendered, /<dim>Available updates:<\/dim>/)
    assert.match(rendered, /<dim>- alpha/)
    assert.match(rendered, /- beta<\/dim>/)
    assert.doesNotMatch(rendered, /Update output:/)
})

test("slash status shows a widget immediately and clears it after completion", async () => {
    let resolveUpdates: ((value: string[]) => void) | undefined

    const harness = createHarness({
        deps: {
            checkForAvailableUpdates: () =>
                new Promise((resolve) => {
                    resolveUpdates = resolve as typeof resolveUpdates
                }),
        },
    })
    const pending = harness.commandHandler("status", harness.ctx)

    assert.equal(harness.widgets.length, 1)
    assert.equal(harness.widgets[0]?.key, "pi-package-manager")
    assert.equal(typeof harness.widgets[0]?.content, "function")
    assert.equal(harness.entries.length, 0)

    resolveUpdates?.(["alpha"])
    await pending

    assert.equal(harness.entries.length, 1)
    assert.equal(harness.entries[0]?.type, REPORT_ENTRY_TYPE)
    assert.deepEqual(harness.widgets[1], {
        key: "pi-package-manager",
        content: undefined,
    })
})

test("slash update reuses the auto-update report flow", async () => {
    const harness = createHarness({
        deps: {
            isOffline: () => true,
        },
    })
    await harness.commandHandler("update", harness.ctx)

    assert.deepEqual(harness.statuses, [])
    assert.equal(harness.entries.length, 2)
    assert.equal(harness.entries[0]?.type, AUTO_UPDATE_RECORD_ENTRY_TYPE)
    assert.equal(harness.entries[1]?.type, REPORT_ENTRY_TYPE)
    assert.equal(harness.widgets.length, 2)
    assert.equal(harness.widgets[0]?.key, "pi-package-manager")
    assert.equal(typeof harness.widgets[0]?.content, "function")
    assert.deepEqual(harness.widgets[1], {
        key: "pi-package-manager",
        content: undefined,
    })
})

test("manual update writes an auto-update record and reloads on success", async () => {
    const harness = createHarness({
        deps: {
            checkForAvailableUpdates: async () => ["alpha"],
            runNativeUpdate: async () =>
                createExecResult({
                    code: 0,
                    stdout: "updated",
                    stderr: "",
                }),
            sleep: async () => {},
        },
    })
    let reloads = 0
    harness.ctx.reload = async () => {
        reloads += 1
    }

    await harness.commandHandler("update", harness.ctx)

    assert.equal(reloads, 1)
    assert.equal(harness.entries[0]?.type, AUTO_UPDATE_RECORD_ENTRY_TYPE)
    assert.deepEqual((harness.entries[0] as { data: AutoUpdateRecord }).data, {
        startedAtUtc: "2025-08-27T13:42:01.000Z",
        endedAtUtc: "2025-08-27T13:42:02.000Z",
        outcome: "succeeded",
        packagesUpdated: 1,
        reason: undefined,
    })
    assert.equal(harness.entries[1]?.type, REPORT_ENTRY_TYPE)
})

test("status reads the latest record regardless of trigger source", async () => {
    const harness = createHarness({
        deps: {
            checkForAvailableUpdates: async () => ["alpha"],
        },
        sessionEntries: [
            createSessionRecordEntry({
                startedAtUtc: "2025-08-27T13:42:01.000Z",
                endedAtUtc: "2025-08-27T13:42:02.000Z",
                outcome: "succeeded",
                packagesUpdated: 1,
            }),
            createSessionRecordEntry({
                startedAtUtc: "2025-08-27T14:00:01.000Z",
                endedAtUtc: "2025-08-27T14:00:02.000Z",
                outcome: "failed",
                packagesUpdated: 0,
                reason: "boom",
            }),
        ],
    })

    await harness.commandHandler("status", harness.ctx)

    assert.deepEqual(harness.entries[0], {
        type: REPORT_ENTRY_TYPE,
        data: {
            title: PACKAGE_MANAGER_TITLE,
            headline: "1 package update is available.",
            tone: "warning",
            lines: [
                "Latest update start: 2025-08-27 14:00:01 UTC+00",
                "Latest update end: 2025-08-27 14:00:02 UTC+00",
                "Latest update result: failed",
                "Latest update packages updated: 0",
                "Latest update detail: boom",
            ],
            lineTone: "dim",
            output: "- alpha",
            outputLabel: "Available updates:",
            outputTone: "dim",
        },
    })
})

test("startup-triggered failure notifies but manual failure does not", async () => {
    const deps = {
        checkForAvailableUpdates: async () => ["alpha"],
        runNativeUpdate: async () =>
            createExecResult({ code: 1, stdout: "", stderr: "boom" }),
    } satisfies Partial<PackageManagerDeps>

    const startupHarness = createHarness({ deps })
    await startupHarness.commandHandler("update --startup", startupHarness.ctx)

    assert.deepEqual(startupHarness.notifications, [
        {
            message:
                "Pi Package Manager automatic startup update failed. See transcript for details.",
            level: "error",
        },
    ])

    const manualHarness = createHarness({ deps })
    await manualHarness.commandHandler("update", manualHarness.ctx)

    assert.deepEqual(manualHarness.notifications, [])
})

test("automatic startup update records skipped outcome and appends a final report", async () => {
    const harness = createHarness({
        deps: {
            isOffline: () => true,
        },
    })
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
    assert.deepEqual(harness.entries[0], {
        type: AUTO_UPDATE_RECORD_ENTRY_TYPE,
        data: {
            startedAtUtc: "2025-08-27T13:42:01.000Z",
            endedAtUtc: "2025-08-27T13:42:02.000Z",
            outcome: "skipped",
            packagesUpdated: 0,
            reason: "PI_OFFLINE is set.",
        },
    })
    assert.deepEqual(harness.entries[1], {
        type: REPORT_ENTRY_TYPE,
        data: {
            title: PACKAGE_MANAGER_TITLE,
            tone: "info",
            headline: "Pi package(s) update skipped.",
            lines: [
                "Start: 2025-08-27 13:42:01 UTC+00",
                "End: 2025-08-27 13:42:02 UTC+00",
                "Result: skipped",
                "Packages updated: 0",
            ],
            lineTone: "dim",
            output: "PI_OFFLINE is set.",
            outputTone: "dim",
            hideOutputWhenCollapsed: true,
        },
    })
    assert.equal(harness.widgets.length, 2)
    assert.equal(harness.widgets[0]?.key, "pi-package-manager")
    assert.equal(typeof harness.widgets[0]?.content, "function")
    assert.deepEqual(harness.widgets[1], {
        key: "pi-package-manager",
        content: undefined,
    })
})

test("automatic startup update reports no-update skip as a final report", async () => {
    const harness = createHarness({
        deps: {
            checkForAvailableUpdates: async () => [],
        },
    })
    await harness.commandHandler("update --startup", harness.ctx)

    assert.equal(harness.entries.length, 2)
    assert.deepEqual(harness.entries[0], {
        type: AUTO_UPDATE_RECORD_ENTRY_TYPE,
        data: {
            startedAtUtc: "2025-08-27T13:42:01.000Z",
            endedAtUtc: "2025-08-27T13:42:02.000Z",
            outcome: "skipped",
            packagesUpdated: 0,
            reason: "No package updates are available.",
        },
    })
    assert.deepEqual(harness.entries[1], {
        type: REPORT_ENTRY_TYPE,
        data: {
            title: PACKAGE_MANAGER_TITLE,
            tone: "info",
            headline: "Pi package(s) update skipped.",
            lines: [
                "Start: 2025-08-27 13:42:01 UTC+00",
                "End: 2025-08-27 13:42:02 UTC+00",
                "Result: skipped",
                "Packages updated: 0",
            ],
            lineTone: "dim",
            output: "No package updates are available.",
            outputTone: "dim",
            hideOutputWhenCollapsed: true,
        },
    })
})

test("automatic startup update does not touch stale ctx after reload", async () => {
    const harness = createHarness({
        deps: {
            checkForAvailableUpdates: async () => ["pi-package-manager"],
            runNativeUpdate: async () =>
                createExecResult({ code: 0, stdout: "updated", stderr: "" }),
            sleep: async () => {},
        },
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
    harness.ctx.ui.notify = (message: string, level: string) => {
        if (reloaded) {
            throw new Error("This extension ctx is stale after reload")
        }

        void message
        void level
    }

    await assert.doesNotReject(() =>
        harness.commandHandler("update --startup", harness.ctx),
    )
})
