import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
    access,
    mkdtemp,
    mkdir,
    readdir,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import init, {
    CLEAN_UP_PEERS_SUBCOMMAND,
    INTRODUCE_PEERS_SUBCOMMAND,
    LIST_PEERS_SUBCOMMAND,
    PEER_ADDON_COMMAND,
} from "./index.ts"

const GREETING_FILE_SUFFIX = ".peer-addon-greeting"
const GREETING_READY_MARKER = ".peer-addon-greetings-ready"

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function settlePrompt(): Promise<void> {
    for (let index = 0; index < 5; index += 1) {
        await settle()
    }
}

async function withTempPeersDir(run: (dir: string) => Promise<void>): Promise<void> {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-peer-addon-test-"))
    const previous = process.env.PI_PEER_DIR
    process.env.PI_PEER_DIR = tempDir

    try {
        await run(tempDir)
    } finally {
        if (previous === undefined) {
            delete process.env.PI_PEER_DIR
        } else {
            process.env.PI_PEER_DIR = previous
        }
        await rm(tempDir, { force: true, recursive: true })
    }
}

function mailboxId(cwd: string, sessionId: string): string {
    return createHash("sha256")
        .update(`${cwd}\0${sessionId}`)
        .digest("hex")
        .slice(0, 12)
}

async function writePeerRecord(
    dir: string,
    record: {
        id: string
        name: string
        cwd: string
        sessionId: string
        state: string
        beatAt: number
        pid?: number
    },
): Promise<void> {
    await writeFile(join(dir, `${record.id}.json`), JSON.stringify(record), "utf8")
}

async function writeInbox(
    dir: string,
    id: string,
    letters: string[] = [],
): Promise<void> {
    const inboxDir = join(dir, `${id}.inbox`)
    await mkdir(inboxDir, { recursive: true })
    await writeFile(join(inboxDir, GREETING_READY_MARKER), "ready\n", "utf8")
    await Promise.all(
        letters.map((text, index) =>
            writeFile(join(inboxDir, `${index + 1}.json`), text, "utf8"),
        ),
    )
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path)
        return true
    } catch {
        return false
    }
}

async function readInboxLetters(
    dir: string,
    id: string,
): Promise<Array<Record<string, unknown>>> {
    const inboxDir = join(dir, `${id}.inbox`)
    const names = (await readdir(inboxDir))
        .filter((name) => name.endsWith(".json"))
        .sort()
    return Promise.all(
        names.map(async (name) =>
            JSON.parse(await readFile(join(inboxDir, name), "utf8")),
        ),
    )
}

async function readGreetingInboxLetters(
    dir: string,
    id: string,
): Promise<Array<Record<string, unknown>>> {
    const inboxDir = join(dir, `${id}.inbox`)
    const names = (await readdir(inboxDir))
        .filter((name) => name.endsWith(GREETING_FILE_SUFFIX))
        .sort()
    return Promise.all(
        names.map(async (name) =>
            JSON.parse(await readFile(join(inboxDir, name), "utf8")),
        ),
    )
}

async function writeGreetingInboxLetter(
    dir: string,
    id: string,
    letter: Record<string, unknown>,
): Promise<void> {
    const inboxDir = join(dir, `${id}.inbox`)
    await mkdir(inboxDir, { recursive: true })
    await writeFile(
        join(inboxDir, `${Date.now()}-test${GREETING_FILE_SUFFIX}`),
        `${JSON.stringify(letter)}\n`,
        "utf8",
    )
}

interface CapturedNotification {
    message: string
    level: string
}

interface CapturedExtensionMessage {
    message: {
        customType: string
        content: unknown
        display: boolean | undefined
        details: unknown
    }
    options: unknown
}

interface Harness {
    commandHandler: (args: string, ctx: any) => Promise<void>
    getArgumentCompletions:
        | ((prefix: string) => Array<{ value: string; label: string }> | null)
        | undefined
    notifications: CapturedNotification[]
    sentUserMessages: Array<{ content: string; options: unknown }>
    sentMessages: CapturedExtensionMessage[]
    greetingRenderer: ((message: any, options: any, theme: any) => any) | undefined
    customCalls: Array<{ overlay: boolean | undefined }>
    requestRenderCount: number
    component: any
    ctx: any
    emit(event: string, payload?: unknown): Promise<void>
}

function createHarness(options?: {
    hasUI?: boolean
    mode?: string
    cwd?: string
    sessionId?: string | undefined
    themeMode?: "plain" | "tagged"
}): Harness {
    const notifications: CapturedNotification[] = []
    const sentUserMessages: Array<{ content: string; options: unknown }> = []
    const sentMessages: CapturedExtensionMessage[] = []
    const customCalls: Array<{ overlay: boolean | undefined }> = []
    const eventHandlers = new Map<
        string,
        Array<(event: unknown, ctx: unknown) => Promise<void> | void>
    >()
    let greetingRenderer: Harness["greetingRenderer"]

    let commandHandler: Harness["commandHandler"] | undefined
    let getArgumentCompletions: Harness["getArgumentCompletions"]
    let component: any
    let requestRenderCount = 0

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
                return new Promise((resolve) => {
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
                            fg(color: string, text: string) {
                                return options?.themeMode === "tagged"
                                    ? `<${color}>${text}</${color}>`
                                    : text
                            },
                        },
                        {},
                        (value?: unknown) => resolve(value),
                    )
                })
            },
        },
    }

    init({
        on(
            event: string,
            handler: (event: unknown, ctx: unknown) => Promise<void> | void,
        ) {
            eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler])
        },
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
        registerMessageRenderer(
            customType: string,
            renderer: Harness["greetingRenderer"],
        ) {
            if (customType === "peer-addon:greeting") {
                greetingRenderer = renderer
            }
        },
        getCommands() {
            return []
        },
        sendMessage(
            message: CapturedExtensionMessage["message"],
            sendOptions?: unknown,
        ) {
            sentMessages.push({ message, options: sendOptions })
        },
        sendUserMessage(content: string, sendOptions?: unknown) {
            sentUserMessages.push({ content, options: sendOptions })
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
        sentMessages,
        get greetingRenderer() {
            return greetingRenderer
        },
        customCalls,
        get requestRenderCount() {
            return requestRenderCount
        },
        get component() {
            return component
        },
        ctx,
        async emit(event: string, payload: unknown = { type: event }) {
            for (const handler of eventHandlers.get(event) ?? []) {
                await handler(payload, ctx)
            }
        },
    }
}

test("/peer-addon list-peers shows peer record rows and details from disk", async () => {
    await withTempPeersDir(async (dir) => {
        const currentCwd = "/Users/gaoshen/Developers/pi-extensions"
        const currentSessionId = "4ef5-session"
        const currentId = mailboxId(currentCwd, currentSessionId)

        await writePeerRecord(dir, {
            id: currentId,
            name: "pi-extensions",
            cwd: currentCwd,
            sessionId: currentSessionId,
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, currentId)
        await writePeerRecord(dir, {
            id: "abcd1234ef56",
            name: "demo",
            cwd: "/Users/gaoshen/Developers/demo",
            sessionId: "demo-session",
            state: "working",
            beatAt: Date.now(),
        })
        await writeInbox(dir, "abcd1234ef56")

        const harness = createHarness({ cwd: currentCwd, sessionId: currentSessionId })
        const commandPromise = harness.commandHandler(
            LIST_PEERS_SUBCOMMAND,
            harness.ctx,
        )

        assert.equal(harness.customCalls.length, 1)
        assert.match(harness.component.render(80).join("\n"), /List Pi peers/u)
        assert.match(harness.component.render(80).join("\n"), /Loading peers/u)

        await settlePrompt()

        const currentPage = harness.component.render(100).join("\n")
        assert.match(currentPage, /› Current dir \(1\) ‹/u)
        assert.match(currentPage, /Other dirs \(1\)/u)
        assert.match(currentPage, /pi-extensions#.+ \[me\]\s+\[idle\]/u)
        assert.match(currentPage, new RegExp(`id: ${currentId}`, "u"))
        assert.match(currentPage, /cwd: \/Users\/gaoshen\/Developers\/pi-extensions/u)
        assert.match(currentPage, /state: idle/u)
        assert.match(currentPage, /sessionId: 4ef5-session/u)

        harness.component.handleInput("\t")
        const otherPage = harness.component.render(100).join("\n")
        assert.match(otherPage, /› Other dirs \(1\) ‹/u)
        assert.match(otherPage, /demo#abcd\s+\[working\]/u)
        assert.match(otherPage, /id: abcd1234ef56/u)
        assert.match(otherPage, /cwd: \/Users\/gaoshen\/Developers\/demo/u)
        assert.match(otherPage, /state: working/u)
        assert.match(otherPage, /sessionId: demo-session/u)

        harness.component.handleInput("\x1b")
        await commandPromise

        assert.deepEqual(harness.notifications, [])
        assert.deepEqual(harness.sentUserMessages, [])
        assert.ok(harness.requestRenderCount >= 2)
    })
})

test("/peer-addon list-peers no longer depends on the nested /peers command", async () => {
    await withTempPeersDir(async (dir) => {
        const harness = createHarness()
        const commandPromise = harness.commandHandler(
            LIST_PEERS_SUBCOMMAND,
            harness.ctx,
        )

        assert.equal(harness.customCalls.length, 1)
        await settlePrompt()

        const rendered = harness.component.render(100).join("\n")
        assert.match(rendered, /No peers on this page\./u)
        assert.deepEqual(harness.notifications, [])
        assert.deepEqual(harness.sentUserMessages, [])

        harness.component.handleInput("\x1b")
        await commandPromise
        await rm(dir, { force: true, recursive: true })
        await mkdir(dir, { recursive: true })
    })
})

test("/peer-addon clean-up-peers shows peer rows and details", async () => {
    await withTempPeersDir(async (dir) => {
        const currentCwd = "/Users/gaoshen/Developers/pi-extensions"
        const currentSessionId = "4ef5-session"
        const currentId = mailboxId(currentCwd, currentSessionId)

        await writePeerRecord(dir, {
            id: currentId,
            name: "pi-extensions",
            cwd: currentCwd,
            sessionId: currentSessionId,
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, currentId)
        await writePeerRecord(dir, {
            id: "abcd1234ef56",
            name: "demo",
            cwd: "/Users/gaoshen/Developers/demo",
            sessionId: "demo-session",
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, "abcd1234ef56")

        const harness = createHarness({ cwd: currentCwd, sessionId: currentSessionId })
        const commandPromise = harness.commandHandler(
            CLEAN_UP_PEERS_SUBCOMMAND,
            harness.ctx,
        )

        assert.match(harness.component.render(80).join("\n"), /Loading peers/u)

        await settlePrompt()

        const currentPage = harness.component.render(100).join("\n")
        assert.match(currentPage, /Clean up Pi peers/u)
        assert.match(currentPage, /› Current dir \(1\) ‹/u)
        assert.match(currentPage, /Other dirs \(1\)/u)
        assert.match(currentPage, /\[ \] pi-extensions#.+ \[me\]\s+\[idle\]/u)
        assert.match(currentPage, new RegExp(`id: ${currentId}`, "u"))
        assert.match(currentPage, /cwd: \/Users\/gaoshen\/Developers\/pi-extensions/u)
        assert.match(currentPage, /state: idle/u)
        assert.match(currentPage, /sessionId: 4ef5-session/u)

        harness.component.handleInput("\t")
        const otherPage = harness.component.render(100).join("\n")
        assert.match(otherPage, /› Other dirs \(1\) ‹/u)
        assert.match(otherPage, /\[ \] demo#abcd\s+\[idle\]/u)
        assert.match(otherPage, /sessionId: demo-session/u)

        harness.component.handleInput("\x1b")
        await commandPromise
    })
})

test("/peer-addon clean-up-peers removes selected offline empty peer", async () => {
    await withTempPeersDir(async (dir) => {
        const currentCwd = "/Users/gaoshen/Developers/pi-extensions"
        const currentSessionId = "4ef5-session"
        const currentId = mailboxId(currentCwd, currentSessionId)
        const otherId = "abcd1234ef56"

        await writePeerRecord(dir, {
            id: currentId,
            name: "pi-extensions",
            cwd: currentCwd,
            sessionId: currentSessionId,
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, currentId)
        await writePeerRecord(dir, {
            id: otherId,
            name: "demo",
            cwd: "/Users/gaoshen/Developers/demo",
            sessionId: "demo-session",
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, otherId)

        const harness = createHarness({ cwd: currentCwd, sessionId: currentSessionId })
        const commandPromise = harness.commandHandler(
            CLEAN_UP_PEERS_SUBCOMMAND,
            harness.ctx,
        )

        await settlePrompt()

        harness.component.handleInput("\t")
        harness.component.handleInput(" ")
        assert.match(harness.component.render(100).join("\n"), /\[x\] demo#abcd/u)
        harness.component.handleInput("\t")
        harness.component.handleInput("\t")
        assert.match(harness.component.render(100).join("\n"), /\[x\] demo#abcd/u)

        harness.component.handleInput("\r")
        await commandPromise

        assert.equal(await pathExists(join(dir, `${otherId}.json`)), false)
        assert.equal(await pathExists(join(dir, `${otherId}.inbox`)), false)
        assert.equal(await pathExists(join(dir, `${currentId}.json`)), true)
        assert.deepEqual(harness.notifications, [
            { message: "Cleaned 1 peer.", level: "info" },
        ])
    })
})

test("/peer-addon clean-up-peers blocks current and pending-mail peers", async () => {
    await withTempPeersDir(async (dir) => {
        const currentCwd = "/Users/gaoshen/Developers/pi-extensions"
        const currentSessionId = "4ef5-session"
        const currentId = mailboxId(currentCwd, currentSessionId)
        const otherId = "abcd1234ef56"

        await writePeerRecord(dir, {
            id: currentId,
            name: "pi-extensions",
            cwd: currentCwd,
            sessionId: currentSessionId,
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, currentId)
        await writePeerRecord(dir, {
            id: otherId,
            name: "demo",
            cwd: "/Users/gaoshen/Developers/demo",
            sessionId: "demo-session",
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, otherId, [JSON.stringify({ text: "queued" })])

        const harness = createHarness({ cwd: currentCwd, sessionId: currentSessionId })
        const commandPromise = harness.commandHandler(
            CLEAN_UP_PEERS_SUBCOMMAND,
            harness.ctx,
        )

        await settlePrompt()

        harness.component.handleInput(" ")
        harness.component.handleInput("\t")
        harness.component.handleInput(" ")
        harness.component.handleInput("\r")
        await commandPromise

        assert.deepEqual(harness.notifications, [
            {
                message: "Current session mailbox cannot be cleaned up.",
                level: "warning",
            },
            {
                message: "Mailbox inbox still has 1 pending letter.",
                level: "warning",
            },
            {
                message: "No peers selected.",
                level: "warning",
            },
        ])
        assert.equal(await pathExists(join(dir, `${currentId}.json`)), true)
        assert.equal(await pathExists(join(dir, `${otherId}.json`)), true)
    })
})

test("/peer-addon clean-up-peers with safe-mode off can remove live peers with pending mail", async () => {
    await withTempPeersDir(async (dir) => {
        const currentCwd = "/Users/gaoshen/Developers/pi-extensions"
        const currentSessionId = "4ef5-session"
        const currentId = mailboxId(currentCwd, currentSessionId)
        const otherId = "abcd1234ef56"

        await writePeerRecord(dir, {
            id: currentId,
            name: "pi-extensions",
            cwd: currentCwd,
            sessionId: currentSessionId,
            state: "idle",
            beatAt: Date.now(),
            pid: process.pid,
        })
        await writeInbox(dir, currentId)
        await writePeerRecord(dir, {
            id: otherId,
            name: "demo",
            cwd: "/Users/gaoshen/Developers/demo",
            sessionId: "demo-session",
            state: "working",
            beatAt: Date.now(),
            pid: process.pid,
        })
        await writeInbox(dir, otherId, [JSON.stringify({ text: "queued" })])

        const harness = createHarness({ cwd: currentCwd, sessionId: currentSessionId })
        const commandPromise = harness.commandHandler(
            CLEAN_UP_PEERS_SUBCOMMAND,
            harness.ctx,
        )

        await settlePrompt()

        harness.component.handleInput("f")
        assert.match(harness.component.render(100).join("\n"), /0 selected/u)
        assert.match(
            harness.component.render(100).join("\n"),
            /safe-mode off: live\/stalled peers and pending mail can be selected/u,
        )
        assert.match(harness.component.render(100).join("\n"), /f toggle safe-mode/u)
        harness.component.handleInput("\t")
        harness.component.handleInput(" ")
        assert.match(harness.component.render(100).join("\n"), /\[x\] demo#abcd/u)
        harness.component.handleInput("\r")
        await commandPromise

        assert.equal(await pathExists(join(dir, `${otherId}.json`)), false)
        assert.equal(await pathExists(join(dir, `${otherId}.inbox`)), false)
        assert.equal(await pathExists(join(dir, `${currentId}.json`)), true)
        assert.deepEqual(harness.notifications, [
            {
                message:
                    "Safe-mode off. Live/stalled peers and peers with pending mail can now be selected.",
                level: "warning",
            },
            { message: "Cleaned 1 peer with safe-mode off.", level: "info" },
        ])
    })
})

test("/peer-addon clean-up-peers still refuses the current session mailbox with safe-mode off", async () => {
    await withTempPeersDir(async (dir) => {
        const currentCwd = "/Users/gaoshen/Developers/pi-extensions"
        const currentSessionId = "4ef5-session"
        const currentId = mailboxId(currentCwd, currentSessionId)

        await writePeerRecord(dir, {
            id: currentId,
            name: "pi-extensions",
            cwd: currentCwd,
            sessionId: currentSessionId,
            state: "idle",
            beatAt: Date.now(),
            pid: process.pid,
        })
        await writeInbox(dir, currentId)

        const harness = createHarness({ cwd: currentCwd, sessionId: currentSessionId })
        const commandPromise = harness.commandHandler(
            CLEAN_UP_PEERS_SUBCOMMAND,
            harness.ctx,
        )

        await settlePrompt()

        harness.component.handleInput("f")
        harness.component.handleInput(" ")
        harness.component.handleInput("\r")
        await commandPromise

        assert.equal(await pathExists(join(dir, `${currentId}.json`)), true)
        assert.deepEqual(harness.notifications, [
            {
                message:
                    "Safe-mode off. Live/stalled peers and peers with pending mail can now be selected.",
                level: "warning",
            },
            {
                message: "Current session mailbox cannot be cleaned up.",
                level: "warning",
            },
            {
                message: "No peers selected.",
                level: "warning",
            },
        ])
    })
})

test("/peer-addon clean-up-peers re-enables safe-mode by pruning blocked selections", async () => {
    await withTempPeersDir(async (dir) => {
        const currentCwd = "/Users/gaoshen/Developers/pi-extensions"
        const currentSessionId = "4ef5-session"
        const currentId = mailboxId(currentCwd, currentSessionId)
        const otherId = "abcd1234ef56"

        await writePeerRecord(dir, {
            id: currentId,
            name: "pi-extensions",
            cwd: currentCwd,
            sessionId: currentSessionId,
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, currentId)
        await writePeerRecord(dir, {
            id: otherId,
            name: "demo",
            cwd: "/Users/gaoshen/Developers/demo",
            sessionId: "demo-session",
            state: "working",
            beatAt: Date.now(),
            pid: process.pid,
        })
        await writeInbox(dir, otherId, [JSON.stringify({ text: "queued" })])

        const harness = createHarness({ cwd: currentCwd, sessionId: currentSessionId })
        const commandPromise = harness.commandHandler(
            CLEAN_UP_PEERS_SUBCOMMAND,
            harness.ctx,
        )

        await settlePrompt()

        harness.component.handleInput("f")
        harness.component.handleInput("\t")
        harness.component.handleInput(" ")
        assert.match(harness.component.render(100).join("\n"), /\[x\] demo#abcd/u)
        harness.component.handleInput("f")
        assert.doesNotMatch(
            harness.component.render(100).join("\n"),
            /\[x\] demo#abcd/u,
        )
        assert.match(
            harness.component.render(100).join("\n"),
            /safe-mode on: only offline peers with empty inboxes/u,
        )
        harness.component.handleInput("\r")
        await commandPromise

        assert.equal(await pathExists(join(dir, `${otherId}.json`)), true)
        assert.deepEqual(harness.notifications, [
            {
                message:
                    "Safe-mode off. Live/stalled peers and peers with pending mail can now be selected.",
                level: "warning",
            },
            {
                message:
                    "Safe-mode on. Cleanup only allows offline peers with empty inboxes.",
                level: "info",
            },
            {
                message: "No peers selected.",
                level: "warning",
            },
        ])
    })
})

test("/peer-addon list-peers adds section padding and dims unfocused rows", async () => {
    await withTempPeersDir(async (dir) => {
        const currentCwd = "/Users/gaoshen/Developers/pi-extensions"
        const currentSessionId = "4ef5-session"
        const currentId = mailboxId(currentCwd, currentSessionId)

        await writePeerRecord(dir, {
            id: currentId,
            name: "pi-extensions",
            cwd: currentCwd,
            sessionId: currentSessionId,
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, currentId)
        await writePeerRecord(dir, {
            id: "bbbb1234ef56",
            name: "beta",
            cwd: currentCwd,
            sessionId: "beta-session",
            state: "working",
            beatAt: Date.now(),
        })
        await writeInbox(dir, "bbbb1234ef56")

        const harness = createHarness({
            cwd: currentCwd,
            sessionId: currentSessionId,
            themeMode: "tagged",
        })
        const commandPromise = harness.commandHandler(
            LIST_PEERS_SUBCOMMAND,
            harness.ctx,
        )

        await settlePrompt()

        const rendered = harness.component.render(100).join("\n")
        assert.match(
            rendered,
            /List Pi peers<\/accent>\s*\n\s*\n\s*<accent>› Current dir/u,
        )
        assert.match(
            rendered,
            /Other dirs \(0\)<\/dim>\s*\n\s*\n\s*<accent>→ pi-extensions/u,
        )
        assert.match(rendered, /\n\s*<dim>beta#bbbb<\/dim><dim>\s+\[working\]/u)
        assert.match(
            rendered,
            /sessionId: 4ef5-session<\/dim>\s*\n\s*\n\s*<dim>↑↓ navigate/u,
        )

        harness.component.handleInput("\x1b")
        await commandPromise
    })
})

test("/peer-addon clean-up-peers adds section padding and dims unfocused rows", async () => {
    await withTempPeersDir(async (dir) => {
        const currentCwd = "/Users/gaoshen/Developers/pi-extensions"
        const currentSessionId = "4ef5-session"
        const currentId = mailboxId(currentCwd, currentSessionId)

        await writePeerRecord(dir, {
            id: currentId,
            name: "pi-extensions",
            cwd: currentCwd,
            sessionId: currentSessionId,
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, currentId)
        await writePeerRecord(dir, {
            id: "bbbb1234ef56",
            name: "beta",
            cwd: currentCwd,
            sessionId: "beta-session",
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, "bbbb1234ef56")

        const harness = createHarness({
            cwd: currentCwd,
            sessionId: currentSessionId,
            themeMode: "tagged",
        })
        const commandPromise = harness.commandHandler(
            CLEAN_UP_PEERS_SUBCOMMAND,
            harness.ctx,
        )

        await settlePrompt()

        const rendered = harness.component.render(100).join("\n")
        assert.match(rendered, /Clean up Pi peers/u)
        assert.match(
            rendered,
            /0 selected<\/dim> • <dim>safe-mode on: only offline peers with empty inboxes<\/dim>\s*\n\s*\n\s*<accent>› Current dir/u,
        )
        assert.match(
            rendered,
            /Other dirs \(0\)<\/dim>\s*\n\s*\n\s*<accent>→ \[ \] pi-extensions/u,
        )
        assert.match(rendered, /\n\s*<dim>\[ \] beta#bbbb<\/dim><dim>\s+\[idle\]/u)
        assert.match(
            rendered,
            /sessionId: 4ef5-session<\/dim>\s*\n\s*\n\s*<dim>↑↓ navigate/u,
        )

        harness.component.handleInput("\x1b")
        await commandPromise
    })
})

test("/peer-addon introduce-peers prepares one first-person message per peer", async () => {
    await withTempPeersDir(async (dir) => {
        const currentCwd = "/Users/gaoshen/Developers/pi-extensions"
        const currentSessionId = "4ef5-session"
        const currentId = mailboxId(currentCwd, currentSessionId)
        const demoId = "abcd1234ef56"
        const desktopId = "efab5678cd90"

        await writePeerRecord(dir, {
            id: currentId,
            name: "pi-extensions",
            cwd: currentCwd,
            sessionId: currentSessionId,
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, currentId)
        await writePeerRecord(dir, {
            id: demoId,
            name: "demo",
            cwd: "/Users/gaoshen/Developers/demo",
            sessionId: "demo-session",
            state: "working",
            beatAt: Date.now(),
        })
        await writeInbox(dir, demoId)
        await writePeerRecord(dir, {
            id: desktopId,
            name: "Desktop",
            cwd: "/Users/gaoshen/Desktop",
            sessionId: "desktop-session",
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, desktopId)

        const harness = createHarness({ cwd: currentCwd, sessionId: currentSessionId })
        const commandPromise = harness.commandHandler(
            INTRODUCE_PEERS_SUBCOMMAND,
            harness.ctx,
        )

        assert.equal(harness.customCalls.length, 1)
        assert.match(harness.component.render(80).join("\n"), /Introduce Pi peers/u)
        assert.match(
            harness.component.render(80).join("\n"),
            /Preparing peer introductions/u,
        )

        await settlePrompt()

        const rendered = harness.component.render(120).join("\n")
        assert.match(rendered, /Prepared \(3\).*Sent \(3\).*Skipped \(0\)/u)
        assert.match(rendered, /pi-extensions#[a-z0-9]{4} \[me\]\s+\[idle\]/u)
        assert.match(rendered, /id: [a-z0-9]{12}/u)
        assert.match(rendered, /cwd: \/Users\/gaoshen\/Developers\/pi-extensions/u)
        assert.match(rendered, /state: idle/u)
        assert.match(rendered, /sessionId: 4ef5-session/u)
        assert.doesNotMatch(rendered, /Delivery:/u)
        assert.doesNotMatch(rendered, /Reason:/u)
        assert.doesNotMatch(rendered, /Message:/u)
        assert.doesNotMatch(
            rendered,
            /Hi, as a Pi peer, my name is pi-extensions#[a-z0-9]{4}/u,
        )

        harness.component.handleInput("\t")
        const sentRendered = harness.component.render(120).join("\n")
        assert.match(sentRendered, /demo#abcd\s+\[working\]/u)
        assert.match(sentRendered, /Desktop#efab\s+\[idle\]/u)
        assert.match(sentRendered, /pi-extensions#[a-z0-9]{4} \[me\]\s+\[idle\]/u)

        assert.deepEqual(await readInboxLetters(dir, demoId), [])
        const demoLetters = await readGreetingInboxLetters(dir, demoId)
        assert.equal(demoLetters.length, 1)
        assert.deepEqual(demoLetters[0], {
            kind: "peer-addon-greeting",
            fromId: currentId,
            fromName: `pi-extensions#${currentId.slice(0, 4)}`,
            fromCwd: currentCwd,
            text: [
                "Hi, as a Pi peer, my name is demo#abcd",
                `- id: ${demoId}`,
                "- cwd: /Users/gaoshen/Developers/demo",
                "- state: working",
                "- sessionId: demo-session",
            ].join("\n"),
            sentAt: demoLetters[0]?.sentAt,
        })
        assert.equal(typeof demoLetters[0]?.sentAt, "number")

        assert.deepEqual(await readInboxLetters(dir, desktopId), [])
        const desktopLetters = await readGreetingInboxLetters(dir, desktopId)
        assert.equal(desktopLetters.length, 1)
        assert.deepEqual(desktopLetters[0], {
            kind: "peer-addon-greeting",
            fromId: currentId,
            fromName: `pi-extensions#${currentId.slice(0, 4)}`,
            fromCwd: currentCwd,
            text: [
                "Hi, as a Pi peer, my name is Desktop#efab",
                `- id: ${desktopId}`,
                "- cwd: /Users/gaoshen/Desktop",
                "- state: idle",
                "- sessionId: desktop-session",
            ].join("\n"),
            sentAt: desktopLetters[0]?.sentAt,
        })
        assert.equal(typeof desktopLetters[0]?.sentAt, "number")
        assert.deepEqual(await readInboxLetters(dir, currentId), [])
        assert.deepEqual(await readGreetingInboxLetters(dir, currentId), [])
        assert.equal(harness.sentMessages.length, 1)
        const localSentAt = (
            harness.sentMessages[0]?.message.details as { sentAt: number } | undefined
        )?.sentAt
        assert.deepEqual(harness.sentMessages[0], {
            message: {
                customType: "peer-addon:greeting",
                content: [
                    `Hi, as a Pi peer, my name is pi-extensions#${currentId.slice(0, 4)}`,
                    `- id: ${currentId}`,
                    `- cwd: ${currentCwd}`,
                    "- state: idle",
                    `- sessionId: ${currentSessionId}`,
                ].join("\n"),
                display: true,
                details: {
                    fromName: `pi-extensions#${currentId.slice(0, 4)}`,
                    fromCwd: currentCwd,
                    sentAt: localSentAt,
                },
            },
            options: undefined,
        })

        harness.component.handleInput("\x1b")
        await commandPromise
    })
})

test("/peer-addon introduce-peers moves accent styling with the focused row", async () => {
    await withTempPeersDir(async (dir) => {
        const currentCwd = "/Users/gaoshen/Developers/pi-extensions"
        const currentSessionId = "4ef5-session"
        const currentId = mailboxId(currentCwd, currentSessionId)

        await writePeerRecord(dir, {
            id: currentId,
            name: "pi-extensions",
            cwd: currentCwd,
            sessionId: currentSessionId,
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, currentId)
        await writePeerRecord(dir, {
            id: "abcd1234ef56",
            name: "demo",
            cwd: "/Users/gaoshen/Developers/demo",
            sessionId: "demo-session",
            state: "working",
            beatAt: Date.now(),
        })
        await writeInbox(dir, "abcd1234ef56")

        const harness = createHarness({
            cwd: currentCwd,
            sessionId: currentSessionId,
            themeMode: "tagged",
        })
        const commandPromise = harness.commandHandler(
            INTRODUCE_PEERS_SUBCOMMAND,
            harness.ctx,
        )
        await settlePrompt()

        const rendered = harness.component.render(120).join("\n")
        assert.match(rendered, /<accent>› Prepared/u)
        assert.match(
            rendered,
            /\n\s*<accent>→ pi-extensions#(?:[a-z0-9]{4}) \[me\][\s\S]*?<\/accent>/u,
        )
        assert.match(rendered, /\n\s*<dim>demo#abcd<\/dim><dim>\s+\[working\]/u)

        harness.component.handleInput("\u001b[B")
        const movedRendered = harness.component.render(120).join("\n")
        assert.match(movedRendered, /\n\s*<dim>pi-extensions#(?:[a-z0-9]{4}) \[me\]/u)
        assert.doesNotMatch(movedRendered, /\n\s*<accent>→ pi-extensions/u)
        assert.match(movedRendered, /\n\s*<accent>→ demo#abcd[\s\S]*?<\/accent>/u)

        harness.component.handleInput("\x1b")
        await commandPromise
    })
})

test("/peer-addon introduce-peers skips only receivers whose targeted greeting exceeds pi-peer's letter limit", async () => {
    await withTempPeersDir(async (dir) => {
        const currentCwd = "/Users/gaoshen/Developers/pi-extensions"
        const currentSessionId = "4ef5-session"
        const currentId = mailboxId(currentCwd, currentSessionId)
        const demoId = "abcd1234ef56"
        const hugeId = "ffffeeee1111"

        await writePeerRecord(dir, {
            id: currentId,
            name: "pi-extensions",
            cwd: currentCwd,
            sessionId: currentSessionId,
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, currentId)
        await writePeerRecord(dir, {
            id: demoId,
            name: "demo",
            cwd: "/Users/gaoshen/Developers/demo",
            sessionId: "demo-session",
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, demoId)
        await writePeerRecord(dir, {
            id: hugeId,
            name: "huge",
            cwd: `/${"x".repeat(40_000)}`,
            sessionId: "huge-session",
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, hugeId)

        const harness = createHarness({ cwd: currentCwd, sessionId: currentSessionId })
        const commandPromise = harness.commandHandler(
            INTRODUCE_PEERS_SUBCOMMAND,
            harness.ctx,
        )
        await settlePrompt()

        const rendered = harness.component.render(120).join("\n")
        assert.doesNotMatch(rendered, /Could not introduce peers/u)
        assert.match(rendered, /Prepared \(3\).*Sent \(2\).*Skipped \(1\)/u)

        harness.component.handleInput("\t")
        harness.component.handleInput("\t")
        const skippedRendered = harness.component.render(120).join("\n")
        assert.match(skippedRendered, /huge#ffff\s+\[idle\]/u)
        assert.match(skippedRendered, /id: ffffeeee1111/u)
        assert.match(skippedRendered, /state: idle/u)
        assert.match(skippedRendered, /sessionId: huge-session/u)
        assert.doesNotMatch(skippedRendered, /Delivery:/u)
        assert.doesNotMatch(skippedRendered, /Reason:/u)
        assert.doesNotMatch(skippedRendered, /Message:/u)

        const demoLetters = await readGreetingInboxLetters(dir, demoId)
        assert.equal(demoLetters.length, 1)
        assert.deepEqual(await readGreetingInboxLetters(dir, hugeId), [])

        harness.component.handleInput("\x1b")
        await commandPromise
    })
})

test("/peer-addon introduce-peers skips peers whose quiet receiver is unavailable", async () => {
    await withTempPeersDir(async (dir) => {
        const currentCwd = "/Users/gaoshen/Developers/pi-extensions"
        const currentSessionId = "4ef5-session"
        const currentId = mailboxId(currentCwd, currentSessionId)
        const otherId = "abcd1234ef56"

        await writePeerRecord(dir, {
            id: currentId,
            name: "pi-extensions",
            cwd: currentCwd,
            sessionId: currentSessionId,
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, currentId)
        await writePeerRecord(dir, {
            id: otherId,
            name: "demo",
            cwd: "/Users/gaoshen/Developers/demo",
            sessionId: "demo-session",
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, otherId)
        await rm(join(dir, `${otherId}.inbox`, GREETING_READY_MARKER), {
            force: true,
        })

        const harness = createHarness({ cwd: currentCwd, sessionId: currentSessionId })
        const commandPromise = harness.commandHandler(
            INTRODUCE_PEERS_SUBCOMMAND,
            harness.ctx,
        )
        await settlePrompt()

        const rendered = harness.component.render(120).join("\n")
        assert.match(rendered, /Prepared \(2\).*Sent \(1\).*Skipped \(1\)/u)
        harness.component.handleInput("\t")
        harness.component.handleInput("\t")
        const skippedRendered = harness.component.render(120).join("\n")
        assert.match(skippedRendered, /id: abcd1234ef56/u)
        assert.match(skippedRendered, /cwd: \/Users\/gaoshen\/Developers\/demo/u)
        assert.match(skippedRendered, /state: idle/u)
        assert.match(skippedRendered, /sessionId: demo-session/u)
        assert.doesNotMatch(skippedRendered, /Delivery:/u)
        assert.doesNotMatch(skippedRendered, /Reason:/u)
        assert.deepEqual(await readGreetingInboxLetters(dir, otherId), [])

        harness.component.handleInput("\x1b")
        await commandPromise
    })
})

test("/peer-addon introduce-peers fails clearly when the current pi-peer record is missing", async () => {
    await withTempPeersDir(async (dir) => {
        const harness = createHarness()
        const otherId = "abcd1234ef56"

        await writePeerRecord(dir, {
            id: otherId,
            name: "demo",
            cwd: "/Users/gaoshen/Developers/demo",
            sessionId: "demo-session",
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, otherId)

        const commandPromise = harness.commandHandler(
            INTRODUCE_PEERS_SUBCOMMAND,
            harness.ctx,
        )
        await settlePrompt()

        const rendered = harness.component.render(100).join("\n")
        assert.match(rendered, /Could not introduce peers/u)
        assert.match(
            rendered,
            /Current Pi peer record was not found\. Make sure pi-peer is installed/u,
        )

        harness.component.handleInput("\x1b")
        await commandPromise
    })
})

test("peer-addon receiver intercepts quiet greeting files before pi-peer would render them", async () => {
    await withTempPeersDir(async (dir) => {
        const currentCwd = "/Users/gaoshen/Developers/pi-extensions"
        const currentSessionId = "4ef5-session"
        const currentId = mailboxId(currentCwd, currentSessionId)

        await writePeerRecord(dir, {
            id: currentId,
            name: "pi-extensions",
            cwd: currentCwd,
            sessionId: currentSessionId,
            state: "idle",
            beatAt: Date.now(),
        })
        await writeInbox(dir, currentId)

        const harness = createHarness({ cwd: currentCwd, sessionId: currentSessionId })
        await harness.emit("session_start", {
            type: "session_start",
            reason: "startup",
        })

        await writeGreetingInboxLetter(dir, currentId, {
            kind: "peer-addon-greeting",
            fromId: "sender-id",
            fromName: "Desktop#9ffb",
            fromCwd: "/Users/gaoshen/Desktop",
            text: [
                "Hi, as a Pi peer, my name is Desktop#9ffb",
                "- id: sender-id",
                "- cwd: /Users/gaoshen/Desktop",
                "- state: idle",
                "- sessionId: desktop-session",
            ].join("\n"),
            sentAt: Date.now(),
        })

        await new Promise((resolve) => setTimeout(resolve, 80))

        const sentAt = (
            harness.sentMessages[0]?.message.details as {
                sentAt?: unknown
            }
        )?.sentAt

        assert.equal(harness.sentMessages.length, 1)
        assert.deepEqual(harness.sentMessages[0], {
            message: {
                customType: "peer-addon:greeting",
                content: [
                    "Hi, as a Pi peer, my name is Desktop#9ffb",
                    "- id: sender-id",
                    "- cwd: /Users/gaoshen/Desktop",
                    "- state: idle",
                    "- sessionId: desktop-session",
                ].join("\n"),
                display: true,
                details: {
                    fromName: "Desktop#9ffb",
                    fromCwd: "/Users/gaoshen/Desktop",
                    sentAt,
                },
            },
            options: undefined,
        })
        assert.equal(typeof sentAt, "number")
        assert.doesNotMatch(
            String(harness.sentMessages[0]?.message.content),
            /This came from another pi session/u,
        )
        assert.doesNotMatch(
            String(harness.sentMessages[0]?.message.content),
            /Reply with message_peer/u,
        )

        const rendered = harness
            .greetingRenderer?.(
                harness.sentMessages[0]?.message,
                { expanded: false, outputPad: 0 },
                {},
            )
            ?.render(120)
            .map((line: string) => line.trimEnd())
            .join("\n")
        assert.equal(
            rendered,
            [
                "Hi, as a Pi peer, my name is Desktop#9ffb",
                "- id: sender-id",
                "- cwd: /Users/gaoshen/Desktop",
                "- state: idle",
                "- sessionId: desktop-session",
            ].join("\n"),
        )
        assert.deepEqual(await readGreetingInboxLetters(dir, currentId), [])

        await harness.emit("session_shutdown", {
            type: "session_shutdown",
            reason: "quit",
        })
    })
})

test("/peer-addon advertises both completions and warns on unknown subcommands", async () => {
    const harness = createHarness()

    assert.deepEqual(harness.getArgumentCompletions?.("li"), [
        { value: LIST_PEERS_SUBCOMMAND, label: LIST_PEERS_SUBCOMMAND },
    ])
    assert.deepEqual(harness.getArgumentCompletions?.("cl"), [
        {
            value: CLEAN_UP_PEERS_SUBCOMMAND,
            label: CLEAN_UP_PEERS_SUBCOMMAND,
        },
    ])
    assert.deepEqual(harness.getArgumentCompletions?.("in"), [
        {
            value: INTRODUCE_PEERS_SUBCOMMAND,
            label: INTRODUCE_PEERS_SUBCOMMAND,
        },
    ])

    await harness.commandHandler("whoami", harness.ctx)
    assert.deepEqual(harness.notifications, [
        {
            message: "Usage: /peer-addon list-peers|clean-up-peers|introduce-peers",
            level: "warning",
        },
    ])
})
