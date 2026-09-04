import type {
    ExtensionAPI,
    ExtensionCommandContext,
    SessionEntry,
    SessionMessageEntry,
} from "@earendil-works/pi-coding-agent"

export const EDIT_LAST_PROMPT_COMMAND = "edit-last-prompt"

const USAGE_MESSAGE = `Usage: /${EDIT_LAST_PROMPT_COMMAND}`
const NOT_IDLE_MESSAGE =
    "Abort or wait until Pi is idle before running /edit-last-prompt."
const NO_ELIGIBLE_PROMPT_MESSAGE =
    "The current branch does not end in an aborted assistant turn, so there is no last prompt to edit."
const MISSING_USER_MESSAGE =
    "Could not find the user message that started the trailing aborted turn."
const IMAGE_PROMPT_MESSAGE =
    "Cannot edit the last prompt because it contains image content, and Pi can only restore text prompts into the editor."
const ABORT_ERROR_MESSAGES = new Set([
    "Operation aborted",
    "This operation was aborted",
])

type FindTrailingAbortedPromptResult =
    | { kind: "ok"; entry: SessionMessageEntry }
    | { kind: "none" }
    | { kind: "invalid"; message: string }

export default function initEditLastPrompt(pi: ExtensionAPI): void {
    pi.registerCommand(EDIT_LAST_PROMPT_COMMAND, {
        description:
            "Restore the trailing aborted prompt into the current session editor (usage: /edit-last-prompt)",
        handler: async (args, ctx) => {
            await handleEditLastPrompt(args, ctx)
        },
    })
}

export async function handleEditLastPrompt(
    args: string,
    ctx: ExtensionCommandContext,
): Promise<void> {
    if (args.trim()) {
        ctx.ui.notify(USAGE_MESSAGE, "warning")
        return
    }

    if (!ctx.isIdle()) {
        ctx.ui.notify(NOT_IDLE_MESSAGE, "warning")
        return
    }

    const target = findTrailingAbortedPromptEntry(ctx.sessionManager.getBranch())
    if (target.kind === "none") {
        ctx.ui.notify(NO_ELIGIBLE_PROMPT_MESSAGE, "warning")
        return
    }

    if (target.kind === "invalid") {
        ctx.ui.notify(target.message, "warning")
        return
    }

    if (userMessageHasImages(target.entry)) {
        ctx.ui.notify(IMAGE_PROMPT_MESSAGE, "warning")
        return
    }

    const restoredText = userMessageText(target.entry)
    const result = await ctx.navigateTree(target.entry.id)
    if (result.cancelled) {
        ctx.ui.notify("Reopening the last prompt was cancelled.", "info")
        return
    }

    ctx.ui.setEditorText(restoredText)
}

export function findTrailingAbortedPromptEntry(
    branch: SessionEntry[],
): FindTrailingAbortedPromptResult {
    for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index]
        if (entry?.type !== "message") {
            continue
        }

        if (entry.message.role === "user") {
            return { kind: "none" }
        }

        if (entry.message.role !== "assistant") {
            continue
        }

        if (!isEligibleAbortedAssistantMessage(entry)) {
            return { kind: "none" }
        }

        for (let userIndex = index - 1; userIndex >= 0; userIndex -= 1) {
            const candidate = branch[userIndex]
            if (candidate?.type === "message" && candidate.message.role === "user") {
                return { kind: "ok", entry: candidate }
            }
        }

        return { kind: "invalid", message: MISSING_USER_MESSAGE }
    }

    return { kind: "none" }
}

function isEligibleAbortedAssistantMessage(entry: SessionMessageEntry): boolean {
    if (entry.message.role !== "assistant") {
        return false
    }

    if (entry.message.stopReason === "aborted") {
        return true
    }

    return (
        entry.message.stopReason === "error" &&
        ABORT_ERROR_MESSAGES.has(entry.message.errorMessage ?? "")
    )
}

function userMessageText(entry: SessionMessageEntry): string {
    if (entry.message.role !== "user") {
        return ""
    }

    const { content } = entry.message
    if (typeof content === "string") {
        return content
    }

    return Array.isArray(content)
        ? content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("")
        : ""
}

export function userMessageHasImages(entry: SessionMessageEntry): boolean {
    if (entry.message.role !== "user") {
        return false
    }

    const { content } = entry.message
    return Array.isArray(content)
        ? content.some(
              (block) =>
                  typeof block === "object" &&
                  block !== null &&
                  "type" in block &&
                  block.type === "image",
          )
        : false
}
