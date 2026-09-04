import assert from "node:assert/strict"
import test from "node:test"

import init, {
    EDIT_LAST_PROMPT_COMMAND,
    findTrailingAbortedPromptEntry,
    handleEditLastPrompt,
    userMessageHasImages,
} from "./index.ts"

interface Harness {
    commandDescription: string | undefined
    commandHandler: (args: string, ctx: any) => Promise<void>
    navigateCalls: string[]
    editorTextSets: string[]
    notifications: Array<{ message: string; level: string }>
    ctx: any
}

function createHarness(
    branch: any[],
    options?: { isIdle?: boolean; navigateCancelled?: boolean },
): Harness {
    const notifications: Array<{ message: string; level: string }> = []
    const navigateCalls: string[] = []
    const editorTextSets: string[] = []

    let commandDescription: string | undefined
    let commandHandler: Harness["commandHandler"] | undefined

    const ctx = {
        isIdle: () => options?.isIdle ?? true,
        sessionManager: {
            getBranch: () => branch,
        },
        navigateTree: async (entryId: string) => {
            navigateCalls.push(entryId)
            return { cancelled: options?.navigateCancelled ?? false }
        },
        ui: {
            notify(message: string, level: string) {
                notifications.push({ message, level })
            },
            setEditorText(text: string) {
                editorTextSets.push(text)
            },
        },
    }

    init({
        registerCommand(
            name: string,
            commandOptions: {
                description?: string
                handler: Harness["commandHandler"]
            },
        ) {
            if (name === EDIT_LAST_PROMPT_COMMAND) {
                commandDescription = commandOptions.description
                commandHandler = commandOptions.handler
            }
        },
    } as any)

    if (!commandHandler) {
        throw new Error("edit-last-prompt command was not registered")
    }

    return {
        commandDescription,
        commandHandler,
        navigateCalls,
        editorTextSets,
        notifications,
        ctx,
    }
}

function userEntry(id: string, content: unknown): any {
    return {
        type: "message",
        id,
        parentId: null,
        timestamp: "2025-09-03T00:00:00.000Z",
        message: {
            role: "user",
            content,
            timestamp: Date.now(),
        },
    }
}

function assistantEntry(id: string, stopReason: string): any {
    return {
        type: "message",
        id,
        parentId: null,
        timestamp: "2025-09-03T00:00:01.000Z",
        message: {
            role: "assistant",
            content: [{ type: "text", text: "reply" }],
            provider: "openai",
            model: "gpt-5",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                },
            },
            stopReason,
            timestamp: Date.now(),
        },
    }
}

test("registers /edit-last-prompt", () => {
    const harness = createHarness([])

    assert.equal(
        harness.commandDescription,
        "Restore the trailing aborted prompt into the current session editor (usage: /edit-last-prompt)",
    )
})

test("trailing aborted assistant rewinds current session and restores the preceding user prompt", async () => {
    const branch = [userEntry("u1", "Fix the bug"), assistantEntry("a1", "aborted")]
    const harness = createHarness(branch)

    await harness.commandHandler("", harness.ctx)

    assert.deepEqual(harness.navigateCalls, ["u1"])
    assert.deepEqual(harness.editorTextSets, ["Fix the bug"])
    assert.deepEqual(harness.notifications, [])
})

test("older aborted turn followed by later successful turn is not eligible", async () => {
    const branch = [
        userEntry("u1", "Old prompt"),
        assistantEntry("a1", "aborted"),
        userEntry("u2", "New prompt"),
        assistantEntry("a2", "stop"),
    ]
    const harness = createHarness(branch)

    await harness.commandHandler("", harness.ctx)

    assert.deepEqual(harness.navigateCalls, [])
    assert.deepEqual(harness.editorTextSets, [])
    assert.deepEqual(harness.notifications, [
        {
            message:
                "The current branch does not end in an aborted assistant turn, so there is no last prompt to edit.",
            level: "warning",
        },
    ])
})

test("tool-aborted trailing turn recorded as assistant error still reopens the last prompt", async () => {
    const branch = [
        userEntry(
            "u1",
            "Do search on Pi github repo to find if there is any issue about light/dark theme adaptation",
        ),
        assistantEntry("a1", "toolUse"),
        {
            type: "message",
            id: "t1",
            parentId: null,
            timestamp: "2025-09-03T00:00:02.000Z",
            message: {
                role: "toolResult",
                toolCallId: "call_1",
                toolName: "web_search",
                content: [{ type: "text", text: "This operation was aborted" }],
                details: {},
                isError: true,
                timestamp: Date.now(),
            },
        },
        {
            type: "message",
            id: "a2",
            parentId: null,
            timestamp: "2025-09-03T00:00:03.000Z",
            message: {
                role: "assistant",
                content: [],
                provider: "openai",
                model: "gpt-5",
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: 0,
                    },
                },
                stopReason: "error",
                errorMessage: "This operation was aborted",
                timestamp: Date.now(),
            },
        },
    ]
    const harness = createHarness(branch)

    await harness.commandHandler("", harness.ctx)

    assert.deepEqual(harness.navigateCalls, ["u1"])
    assert.deepEqual(harness.editorTextSets, [
        "Do search on Pi github repo to find if there is any issue about light/dark theme adaptation",
    ])
    assert.deepEqual(harness.notifications, [])
})

test("ordinary trailing assistant errors are still refused", async () => {
    const branch = [
        userEntry("u1", "Check the logs"),
        {
            type: "message",
            id: "a1",
            parentId: null,
            timestamp: "2025-09-03T00:00:03.000Z",
            message: {
                role: "assistant",
                content: [],
                provider: "openai",
                model: "gpt-5",
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: 0,
                    },
                },
                stopReason: "error",
                errorMessage: "Something else failed",
                timestamp: Date.now(),
            },
        },
    ]
    const harness = createHarness(branch)

    await harness.commandHandler("", harness.ctx)

    assert.deepEqual(harness.navigateCalls, [])
    assert.deepEqual(harness.editorTextSets, [])
    assert.deepEqual(harness.notifications, [
        {
            message:
                "The current branch does not end in an aborted assistant turn, so there is no last prompt to edit.",
            level: "warning",
        },
    ])
})

test("image-bearing last prompt is refused", async () => {
    const branch = [
        userEntry("u1", [
            { type: "text", text: "Look at this" },
            { type: "image", image: "file:///tmp/example.png" },
        ]),
        assistantEntry("a1", "aborted"),
    ]
    const harness = createHarness(branch)

    await harness.commandHandler("", harness.ctx)

    assert.deepEqual(harness.navigateCalls, [])
    assert.deepEqual(harness.editorTextSets, [])
    assert.deepEqual(harness.notifications, [
        {
            message:
                "Cannot edit the last prompt because it contains image content, and Pi can only restore text prompts into the editor.",
            level: "warning",
        },
    ])
})

test("text-only block arrays are allowed", async () => {
    const branch = [
        userEntry("u1", [
            { type: "text", text: "First line" },
            { type: "text", text: "Second line" },
        ]),
        assistantEntry("a1", "aborted"),
    ]
    const harness = createHarness(branch)

    await harness.commandHandler("", harness.ctx)

    assert.deepEqual(harness.navigateCalls, ["u1"])
    assert.deepEqual(harness.editorTextSets, ["First lineSecond line"])
})

test("cancelled navigation does not overwrite the editor", async () => {
    const branch = [userEntry("u1", "Fix the bug"), assistantEntry("a1", "aborted")]
    const harness = createHarness(branch, { navigateCancelled: true })

    await harness.commandHandler("", harness.ctx)

    assert.deepEqual(harness.navigateCalls, ["u1"])
    assert.deepEqual(harness.editorTextSets, [])
    assert.deepEqual(harness.notifications, [
        {
            message: "Reopening the last prompt was cancelled.",
            level: "info",
        },
    ])
})

test("missing preceding user message produces a friendly error", async () => {
    const branch = [assistantEntry("a1", "aborted")]
    const harness = createHarness(branch)

    await harness.commandHandler("", harness.ctx)

    assert.deepEqual(harness.navigateCalls, [])
    assert.deepEqual(harness.editorTextSets, [])
    assert.deepEqual(harness.notifications, [
        {
            message:
                "Could not find the user message that started the trailing aborted turn.",
            level: "warning",
        },
    ])
})

test("command refuses while Pi is still streaming", async () => {
    const branch = [userEntry("u1", "Fix the bug"), assistantEntry("a1", "aborted")]
    const harness = createHarness(branch, { isIdle: false })

    await harness.commandHandler("", harness.ctx)

    assert.deepEqual(harness.navigateCalls, [])
    assert.deepEqual(harness.editorTextSets, [])
    assert.deepEqual(harness.notifications, [
        {
            message: "Abort or wait until Pi is idle before running /edit-last-prompt.",
            level: "warning",
        },
    ])
})

test("findTrailingAbortedPromptEntry returns none when a trailing user message appears first", () => {
    const result = findTrailingAbortedPromptEntry([userEntry("u1", "Draft")])

    assert.deepEqual(result, { kind: "none" })
})

test("userMessageHasImages only flags image blocks", () => {
    assert.equal(userMessageHasImages(userEntry("u1", "plain text") as any), false)
    assert.equal(
        userMessageHasImages(
            userEntry("u2", [
                { type: "text", text: "hi" },
                { type: "image", image: "file:///tmp/example.png" },
            ]) as any,
        ),
        true,
    )
})

test("handleEditLastPrompt rejects unexpected args", async () => {
    const harness = createHarness([])

    await handleEditLastPrompt("extra", harness.ctx)

    assert.deepEqual(harness.notifications, [
        { message: "Usage: /edit-last-prompt", level: "warning" },
    ])
})
