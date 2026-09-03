import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent"

import {
    CLEAN_UP_PEERS_SUBCOMMAND,
    INTRODUCE_PEERS_SUBCOMMAND,
    LIST_PEERS_SUBCOMMAND,
    PEER_ADDON_COMMAND,
} from "./constants.ts"
import { sendGreetingMessage } from "./greeting-runtime.ts"
import {
    formatGreetingMessage,
    sendPeerGreetings,
    type GreetingMessageDetails,
} from "./greetings.ts"
import { defaultPeersDir } from "./paths.ts"
import {
    cleanUpPeers,
    loadCleanupPeerPages,
    loadPeerPages,
    type CleanupPromptResult,
} from "./peers.ts"
import { CleanupPeersPrompt, IntroducePeersPrompt, ListPeersPrompt } from "./prompts.ts"

function normalizeSubcommand(args: string): string {
    return args.trim()
}

function ensureInteractiveTui(
    ctx: Pick<ExtensionCommandContext, "hasUI" | "mode" | "ui">,
    subcommand: string,
): boolean {
    if (ctx.hasUI && ctx.mode === "tui") {
        return true
    }

    ctx.ui.notify(`/peer-addon ${subcommand} requires the interactive TUI.`, "warning")
    return false
}

const promptOverlayOptions = {
    overlay: true as const,
    overlayOptions: {
        width: "70%" as const,
        minWidth: 48,
        maxHeight: "80%" as const,
    },
}

async function handleCleanupPeers(
    ctx: ExtensionCommandContext,
    peersDir: string,
): Promise<void> {
    const currentSessionId = ctx.sessionManager.getSessionId?.()
    let prompt: CleanupPeersPrompt | undefined
    const cleanupSelection = await ctx.ui.custom<CleanupPromptResult | undefined>(
        (tui, theme, _kb, done) => {
            prompt = new CleanupPeersPrompt({
                tui,
                theme,
                notify: ctx.ui.notify,
                close: done,
                loadPeers: () =>
                    loadCleanupPeerPages({
                        peersDir,
                        currentCwd: ctx.cwd,
                        currentSessionId,
                    }),
            })

            void prompt.load()
            return prompt
        },
        promptOverlayOptions,
    )
    prompt?.dispose()

    if (!cleanupSelection) {
        return
    }
    if (cleanupSelection.selectedIds.length === 0) {
        ctx.ui.notify("No peers selected.", "warning")
        return
    }

    const result = await cleanUpPeers({
        peersDir,
        selectedIds: cleanupSelection.selectedIds,
        currentCwd: ctx.cwd,
        currentSessionId,
        safeMode: cleanupSelection.safeMode,
    })
    const cleanedCount = result.cleanedIds.length
    const skippedCount = result.skipped.length
    const cleanedSuffix = cleanupSelection.safeMode ? "." : " with safe-mode off."
    if (skippedCount > 0) {
        ctx.ui.notify(
            `Cleaned ${cleanedCount} peer${cleanedCount === 1 ? "" : "s"}${cleanupSelection.safeMode ? "" : " with safe-mode off"}; skipped ${skippedCount}: ${result.skipped
                .map((entry) => `${entry.id} (${entry.reason})`)
                .join("; ")}`,
            "warning",
        )
        return
    }

    ctx.ui.notify(
        `Cleaned ${cleanedCount} peer${cleanedCount === 1 ? "" : "s"}${cleanedSuffix}`,
        "info",
    )
}

async function handleIntroducePeers(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    peersDir: string,
): Promise<void> {
    const currentSessionId = ctx.sessionManager.getSessionId?.()
    let prompt: IntroducePeersPrompt | undefined

    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        prompt = new IntroducePeersPrompt({
            tui,
            theme,
            close: () => done(),
            loadGreeting: async () => {
                const result = await sendPeerGreetings({
                    peersDir,
                    currentCwd: ctx.cwd,
                    currentSessionId,
                })
                sendGreetingMessage(pi, formatGreetingMessage(result.sender), {
                    fromName: result.sender.label,
                    fromCwd: result.sender.cwd,
                    sentAt: Date.now(),
                } satisfies GreetingMessageDetails)
                return result
            },
        })

        void prompt.load()
        return prompt
    }, promptOverlayOptions)

    prompt?.dispose()
}

async function handleListPeers(
    ctx: ExtensionCommandContext,
    peersDir: string,
): Promise<void> {
    const currentSessionId = ctx.sessionManager.getSessionId?.()
    let prompt: ListPeersPrompt | undefined

    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        prompt = new ListPeersPrompt({
            tui,
            theme,
            close: () => done(),
            loadPeers: () =>
                loadPeerPages({
                    peersDir,
                    currentCwd: ctx.cwd,
                    currentSessionId,
                }),
        })

        void prompt.load()
        return prompt
    }, promptOverlayOptions)

    prompt?.dispose()
}

export function registerPeerAddonCommand(pi: ExtensionAPI): void {
    pi.registerCommand(PEER_ADDON_COMMAND, {
        description: "Friendly TUI helpers built on top of pi-peer",
        getArgumentCompletions(argumentPrefix) {
            const trimmed = argumentPrefix.trimStart()
            const completions = [
                LIST_PEERS_SUBCOMMAND,
                CLEAN_UP_PEERS_SUBCOMMAND,
                INTRODUCE_PEERS_SUBCOMMAND,
            ]
                .filter((value) => value.startsWith(trimmed))
                .map((value) => ({ value, label: value }))
            return completions.length > 0 ? completions : null
        },
        async handler(args, ctx) {
            const subcommand = normalizeSubcommand(args)
            if (
                subcommand !== LIST_PEERS_SUBCOMMAND &&
                subcommand !== CLEAN_UP_PEERS_SUBCOMMAND &&
                subcommand !== INTRODUCE_PEERS_SUBCOMMAND
            ) {
                ctx.ui.notify(
                    `Usage: /${PEER_ADDON_COMMAND} ${LIST_PEERS_SUBCOMMAND}|${CLEAN_UP_PEERS_SUBCOMMAND}|${INTRODUCE_PEERS_SUBCOMMAND}`,
                    "warning",
                )
                return
            }

            if (!ensureInteractiveTui(ctx, subcommand)) {
                return
            }

            const peersDir = defaultPeersDir()

            if (subcommand === CLEAN_UP_PEERS_SUBCOMMAND) {
                await handleCleanupPeers(ctx, peersDir)
                return
            }

            if (subcommand === INTRODUCE_PEERS_SUBCOMMAND) {
                await handleIntroducePeers(pi, ctx, peersDir)
                return
            }

            await handleListPeers(ctx, peersDir)
        },
    })
}
