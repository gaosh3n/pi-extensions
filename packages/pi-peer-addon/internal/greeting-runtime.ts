import { Text } from "@earendil-works/pi-tui"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import { GREETING_MESSAGE_TYPE } from "./constants.ts"
import {
    advertiseGreetingReceiver,
    type GreetingInboxWatch,
    type GreetingMailboxLetter,
    type GreetingMessageDetails,
    watchGreetingInbox,
} from "./greetings.ts"
import { defaultPeersDir, mailboxId } from "./paths.ts"

export function sendGreetingMessage(
    pi: ExtensionAPI,
    content: string,
    details: GreetingMessageDetails,
): void {
    pi.sendMessage<GreetingMessageDetails>({
        customType: GREETING_MESSAGE_TYPE,
        content,
        display: true,
        details,
    })
}

export function registerGreetingRenderer(pi: ExtensionAPI): void {
    pi.registerMessageRenderer<GreetingMessageDetails>(
        GREETING_MESSAGE_TYPE,
        (message, { outputPad }) => new Text(String(message.content), outputPad, 0),
    )
}

function forwardGreetingLetters(
    pi: ExtensionAPI,
    letters: GreetingMailboxLetter[],
): void {
    for (const letter of letters) {
        sendGreetingMessage(pi, letter.text, {
            fromName: letter.fromName,
            fromCwd: letter.fromCwd,
            sentAt: letter.sentAt,
        })
    }
}

export function registerGreetingReceiver(pi: ExtensionAPI): void {
    let greetingWatch: GreetingInboxWatch | undefined

    pi.on("session_start", async (_event, ctx) => {
        const currentSessionId = ctx.sessionManager.getSessionId?.()
        if (!currentSessionId) return

        const peersDir = defaultPeersDir()
        const currentMailboxId = mailboxId(ctx.cwd, currentSessionId)
        await advertiseGreetingReceiver({
            peersDir,
            currentMailboxId,
        })

        greetingWatch?.close()
        greetingWatch = watchGreetingInbox({
            peersDir,
            mailboxId: currentMailboxId,
            onLetters(letters) {
                forwardGreetingLetters(pi, letters)
            },
        })
    })

    pi.on("session_shutdown", async () => {
        greetingWatch?.close()
        greetingWatch = undefined
    })
}
