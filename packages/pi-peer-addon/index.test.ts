import assert from "node:assert/strict"
import test from "node:test"

import init, {
    LIST_PEERS_SUBCOMMAND,
    PEER_ADDON_COMMAND,
    buildPeerPages,
    parsePeersListing,
} from "./index.ts"

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

interface CapturedNotification {
    message: string
    level: string
}

interface Harness {
    commandHandler: (args: string, ctx: any) => Promise<void>
    getArgumentCompletions:
        | ((prefix: string) => Array<{ value: string; label: string }> | null)
        | undefined
    notifications: CapturedNotification[]
    sentUserMessages: Array<{ content: string; options: unknown }>
    customCalls: Array<{ overlay: boolean | undefined }>
    requestRenderCount: number
    component: any
    resolvePeers(): void
    ctx: any
}

function createHarness(options?: {
    commands?: Array<{
        name: string
        source: "extension" | "prompt" | "skill"
        sourceInfo: { path: string }
        description?: string
    }>
    peersListing?: string
    peersNotifications?: CapturedNotification[]
    resolveBeforePeerNotifications?: boolean
    hasUI?: boolean
    mode?: string
    cwd?: string
    sessionId?: string | undefined
}): Harness {
    const notifications: CapturedNotification[] = []
    const sentUserMessages: Array<{ content: string; options: unknown }> = []
    const customCalls: Array<{ overlay: boolean | undefined }> = []

    let commandHandler: Harness["commandHandler"] | undefined
    let getArgumentCompletions: Harness["getArgumentCompletions"]
    let component: any
    let requestRenderCount = 0
    let releasePeers: (() => void) | undefined

    const ctx = {
        cwd: options?.cwd ?? "/Users/gaoshen/Developers/pi-extensions",
        hasUI: options?.hasUI ?? true,
        mode: options?.mode ?? "tui",
        isIdle: () => true,
        sessionManager: {
            getSessionId: () => options?.sessionId ?? "4ef5-session",
        },
        ui: {
            notify(message: string, level: string) {
                notifications.push({ message, level })
            },
            custom(factory: any, uiOptions?: { overlay?: boolean }) {
                customCalls.push({ overlay: uiOptions?.overlay })
                return new Promise<void>((resolve) => {
                    component = factory(
                        {
                            requestRender() {
                                requestRenderCount += 1
                            },
                        },
                        {
                            bold(text: string) {
                                return text
                            },
                            fg(_color: string, text: string) {
                                return text
                            },
                        },
                        {},
                        () => resolve(),
                    )
                })
            },
        },
    }

    init({
        registerCommand(
            name: string,
            commandOptions: {
                handler: Harness["commandHandler"]
                getArgumentCompletions?: Harness["getArgumentCompletions"]
            },
        ) {
            if (name !== PEER_ADDON_COMMAND) return
            commandHandler = commandOptions.handler
            getArgumentCompletions = commandOptions.getArgumentCompletions
        },
        getCommands() {
            return (
                options?.commands ?? [
                    {
                        name: "peers",
                        description: "List peers",
                        source: "extension",
                        sourceInfo: { path: "/packages/pi-peer/index.ts" },
                    },
                ]
            )
        },
        sendUserMessage(content: string, sendOptions?: unknown) {
            sentUserMessages.push({ content, options: sendOptions })
            if (!/^\/peers(?::\d+)?$/u.test(content)) return

            releasePeers = () => {
                const replay = options?.peersNotifications ?? [
                    {
                        message:
                            options?.peersListing ??
                            [
                                "2 other pi sessions:",
                                "  teammate#1a2b  /Users/gaoshen/Developers/pi-extensions  [idle]",
                                "  demo#9c8d      /Users/gaoshen/Developers/demo           [working]",
                                "",
                                'Address a session by the name in the first column: message_peer({ to: "…" }).',
                            ].join("\n"),
                        level: "info",
                    },
                ]

                const replayNotifications = () => {
                    for (const notification of replay) {
                        ctx.ui.notify(notification.message, notification.level)
                    }
                }

                if (options?.resolveBeforePeerNotifications) {
                    setTimeout(replayNotifications, 0)
                    return
                }

                replayNotifications()
            }
        },
    } as any)

    if (!commandHandler) {
        throw new Error("peer-addon command was not registered")
    }

    return {
        commandHandler,
        getArgumentCompletions,
        notifications,
        sentUserMessages,
        customCalls,
        get requestRenderCount() {
            return requestRenderCount
        },
        get component() {
            return component
        },
        resolvePeers() {
            releasePeers?.()
        },
        ctx,
    }
}

test("parsePeersListing extracts rows from pi-peer output", () => {
    const rows = parsePeersListing(
        [
            "2 other pi sessions:",
            "  teammate#1a2b  /Users/gaoshen/Developers/pi-extensions  [idle]",
            "  demo#9c8d      /Users/gaoshen/Developers/demo           [working]",
            "",
            'Address a session by the name in the first column: message_peer({ to: "…" }).',
        ].join("\n"),
    )

    assert.deepEqual(rows, [
        {
            sourceName: "teammate#1a2b",
            cwd: "/Users/gaoshen/Developers/pi-extensions",
            status: "idle",
        },
        {
            sourceName: "demo#9c8d",
            cwd: "/Users/gaoshen/Developers/demo",
            status: "working",
        },
    ])
})

test("buildPeerPages adds the current session and splits current vs other directories", () => {
    const listing = [
        "2 other pi sessions:",
        "  teammate#1a2b  /Users/gaoshen/Developers/pi-extensions  [idle]",
        "  demo#9c8d      /Users/gaoshen/Developers/demo           [working]",
    ].join("\n")

    const pages = buildPeerPages({
        listing,
        currentCwd: "/Users/gaoshen/Developers/pi-extensions",
        currentSessionId: "4ef5-session",
        currentStatus: "idle",
    })

    assert.deepEqual(pages, {
        current: [
            {
                label: "pi-extensions#4ef5",
                status: "idle",
                cwd: "/Users/gaoshen/Developers/pi-extensions",
                sourceName: "[me]",
                isMe: true,
            },
            {
                label: "pi-extensions#1a2b",
                status: "idle",
                cwd: "/Users/gaoshen/Developers/pi-extensions",
                sourceName: "teammate#1a2b",
                isMe: false,
            },
        ],
        other: [
            {
                label: "demo#9c8d",
                status: "working",
                cwd: "/Users/gaoshen/Developers/demo",
                sourceName: "demo#9c8d",
                isMe: false,
            },
        ],
    })
})

test("/peer-addon list-peers still captures and reformats late /peers notifications", async () => {
    const harness = createHarness({ resolveBeforePeerNotifications: true })

    const commandPromise = harness.commandHandler(LIST_PEERS_SUBCOMMAND, harness.ctx)
    assert.equal(harness.customCalls.length, 1)
    assert.ok(harness.component)
    assert.match(harness.component.render(80).join("\n"), /List Pi peers/u)
    assert.match(harness.component.render(80).join("\n"), /Loading \/peers/u)
    assert.doesNotMatch(
        harness.component.render(80).join("\n"),
        /Runs pi-peer \/peers, then reformats the result\./u,
    )

    harness.resolvePeers()
    await settle()
    await settle()

    assert.deepEqual(harness.notifications, [])

    const rendered = harness.component.render(100).join("\n")
    assert.match(rendered, /› Current dir \(2\) ‹/u)
    assert.match(rendered, /Other dirs \(1\)/u)
    assert.match(rendered, /pi-extensions#4ef5 \[me\]\s+\[idle\]/u)
    assert.match(rendered, /pi-extensions#1a2b/u)
    assert.match(rendered, /Selected: pi-extensions#4ef5 \[me\]/u)
    assert.match(rendered, /Status: \[idle\]/u)
    assert.match(rendered, /Directory: \/Users\/gaoshen\/Developers\/pi-extensions/u)

    harness.component.handleInput("\x1b")
    await commandPromise
})

test("/peer-addon list-peers shows loading first, then renders the parsed pages", async () => {
    const harness = createHarness()

    const commandPromise = harness.commandHandler(LIST_PEERS_SUBCOMMAND, harness.ctx)

    assert.equal(harness.customCalls.length, 1)
    assert.ok(harness.component)
    assert.match(harness.component.render(80).join("\n"), /List Pi peers/u)
    assert.match(harness.component.render(80).join("\n"), /Loading \/peers/u)
    assert.doesNotMatch(
        harness.component.render(80).join("\n"),
        /Runs pi-peer \/peers, then reformats the result\./u,
    )

    harness.resolvePeers()
    await settle()

    const rendered = harness.component.render(100).join("\n")
    assert.match(rendered, /› Current dir \(2\) ‹/u)
    assert.match(rendered, /Other dirs \(1\)/u)
    assert.match(rendered, /pi-extensions#4ef5 \[me\]\s+\[idle\]/u)
    assert.match(rendered, /pi-extensions#1a2b/u)
    assert.match(rendered, /Selected: pi-extensions#4ef5 \[me\]/u)
    assert.doesNotMatch(rendered, /Page: /u)
    assert.doesNotMatch(rendered, /Source: \/peers/u)

    harness.component.handleInput("\t")
    const otherPage = harness.component.render(100).join("\n")
    assert.match(otherPage, /› Other dirs \(1\) ‹/u)
    assert.match(otherPage, /demo#9c8d/u)
    assert.match(otherPage, /Selected: demo#9c8d/u)
    assert.match(otherPage, /Status: \[working\]/u)
    assert.match(otherPage, /Directory: \/Users\/gaoshen\/Developers\/demo/u)

    harness.component.handleInput("\x1b")
    await commandPromise

    assert.deepEqual(harness.sentUserMessages, [
        { content: "/peers", options: { expandPromptTemplates: true } },
    ])
    assert.ok(harness.requestRenderCount >= 2)
})

test("/peer-addon list-peers fails clearly when pi-peer is not installed", async () => {
    const harness = createHarness({ commands: [] })

    await harness.commandHandler(LIST_PEERS_SUBCOMMAND, harness.ctx)

    assert.deepEqual(harness.notifications, [
        {
            message:
                "pi-peer-addon requires the pi-peer /peers command. Install and load @shift-labs/pi-peer, then retry.",
            level: "warning",
        },
    ])
    assert.equal(harness.customCalls.length, 0)
})

test("/peer-addon list-peers requires pi-peer provenance even for a unique /peers command", async () => {
    const harness = createHarness({
        commands: [
            {
                name: "peers",
                description: "Foreign peers",
                source: "extension",
                sourceInfo: { path: "/packages/not-pi-peer/index.ts" },
            },
        ],
    })

    await harness.commandHandler(LIST_PEERS_SUBCOMMAND, harness.ctx)

    assert.deepEqual(harness.notifications, [
        {
            message:
                "pi-peer-addon requires the pi-peer /peers command. Install and load @shift-labs/pi-peer, then retry.",
            level: "warning",
        },
    ])
    assert.equal(harness.customCalls.length, 0)
})

test("/peer-addon list-peers chooses the pi-peer command when multiple /peers variants exist", async () => {
    const harness = createHarness({
        commands: [
            {
                name: "peers:1",
                description: "Foreign peers",
                source: "extension",
                sourceInfo: { path: "/packages/not-pi-peer/index.ts" },
            },
            {
                name: "peers:2",
                description: "pi-peer peers",
                source: "extension",
                sourceInfo: { path: "/packages/pi-peer/index.ts" },
            },
        ],
    })

    const commandPromise = harness.commandHandler(LIST_PEERS_SUBCOMMAND, harness.ctx)
    harness.resolvePeers()
    await settle()

    assert.deepEqual(harness.sentUserMessages, [
        { content: "/peers:2", options: { expandPromptTemplates: true } },
    ])

    harness.component.handleInput("\x1b")
    await commandPromise
})

test("/peer-addon list-peers forwards nested warnings while still rendering the captured listing", async () => {
    const harness = createHarness({
        peersNotifications: [
            { message: "remote messaging is off", level: "warning" },
            {
                message: [
                    "1 other pi session:",
                    "  teammate#1a2b  /Users/gaoshen/Developers/pi-extensions  [idle]",
                ].join("\n"),
                level: "info",
            },
        ],
    })

    const commandPromise = harness.commandHandler(LIST_PEERS_SUBCOMMAND, harness.ctx)
    harness.resolvePeers()
    await settle()

    assert.deepEqual(harness.notifications, [
        { message: "remote messaging is off", level: "warning" },
    ])
    assert.match(harness.component.render(100).join("\n"), /pi-extensions#1a2b/u)

    harness.component.handleInput("\x1b")
    await commandPromise
})

test("/peer-addon list-peers restores notify after a failed capture path", async () => {
    const harness = createHarness({
        peersNotifications: [
            { message: "first", level: "info" },
            { message: "second", level: "info" },
        ],
    })

    const commandPromise = harness.commandHandler(LIST_PEERS_SUBCOMMAND, harness.ctx)
    harness.resolvePeers()
    await settle()

    harness.ctx.ui.notify("after failure", "warning")
    assert.deepEqual(harness.notifications, [
        { message: "after failure", level: "warning" },
    ])

    harness.component.handleInput("\x1b")
    await commandPromise
})

test("/peer-addon list-peers fails closed when /peers emits more than one info notification", async () => {
    const harness = createHarness({
        peersNotifications: [
            { message: "first", level: "info" },
            { message: "second", level: "info" },
        ],
    })

    const commandPromise = harness.commandHandler(LIST_PEERS_SUBCOMMAND, harness.ctx)
    harness.resolvePeers()
    await settle()

    const rendered = harness.component.render(100).join("\n")
    assert.match(rendered, /Could not load peer list/u)
    assert.match(
        rendered,
        /Expected exactly one info notification from \/peers, received 2\./u,
    )

    harness.component.handleInput("\x1b")
    await commandPromise
})

test("/peer-addon advertises list-peers completion and warns on unknown subcommands", async () => {
    const harness = createHarness()

    assert.deepEqual(harness.getArgumentCompletions?.("li"), [
        { value: LIST_PEERS_SUBCOMMAND, label: LIST_PEERS_SUBCOMMAND },
    ])

    await harness.commandHandler("whoami", harness.ctx)
    assert.deepEqual(harness.notifications, [
        {
            message: "Usage: /peer-addon list-peers",
            level: "warning",
        },
    ])
})
