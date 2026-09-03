import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import {
    CLEAN_UP_PEERS_SUBCOMMAND,
    INTRODUCE_PEERS_SUBCOMMAND,
    LIST_PEERS_SUBCOMMAND,
    PEER_ADDON_COMMAND,
} from "./internal/constants.ts"
import {
    registerGreetingReceiver,
    registerGreetingRenderer,
} from "./internal/greeting-runtime.ts"
import { registerPeerAddonCommand } from "./internal/commands.ts"

export {
    CLEAN_UP_PEERS_SUBCOMMAND,
    INTRODUCE_PEERS_SUBCOMMAND,
    LIST_PEERS_SUBCOMMAND,
    PEER_ADDON_COMMAND,
}

export default function init(pi: ExtensionAPI): void {
    registerGreetingRenderer(pi)
    registerGreetingReceiver(pi)
    registerPeerAddonCommand(pi)
}
