import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import init, {
    CLEAN_UP_PEERS_SUBCOMMAND,
    LIST_PEERS_SUBCOMMAND,
    PEER_ADDON_COMMAND,
} from "./index.ts"

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
    ctx: any
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
    const customCalls: Array<{ overlay: boolean | undefined }> = []

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
            return []
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
        customCalls,
        get requestRenderCount() {
            return requestRenderCount
        },
        get component() {
            return component
        },
        ctx,
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
            /0 selected • enter clean up • esc cancel<\/dim>\s*\n\s*\n\s*<accent>› Current dir/u,
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

    await harness.commandHandler("whoami", harness.ctx)
    assert.deepEqual(harness.notifications, [
        {
            message: "Usage: /peer-addon list-peers|clean-up-peers",
            level: "warning",
        },
    ])
})
