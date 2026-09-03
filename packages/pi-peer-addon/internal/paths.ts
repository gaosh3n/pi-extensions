import { createHash, randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

import { GREETING_FILE_SUFFIX, GREETING_READY_MARKER } from "./constants.ts"

export function defaultPeersDir(): string {
    return process.env.PI_PEER_DIR ?? join(homedir(), ".pi", "agent", "peers")
}

export function mailboxId(cwd: string, sessionId: string): string {
    return createHash("sha256")
        .update(`${cwd}\0${sessionId}`)
        .digest("hex")
        .slice(0, 12)
}

export function mailboxRecordPath(peersDir: string, id: string): string {
    return join(peersDir, `${id}.json`)
}

export function inboxPath(peersDir: string, id: string): string {
    return join(peersDir, `${id}.inbox`)
}

export function greetingReadyMarkerPath(peersDir: string, id: string): string {
    return join(inboxPath(peersDir, id), GREETING_READY_MARKER)
}

export function greetingLetterPath(inbox: string, sentAt: number): string {
    return join(
        inbox,
        `${sentAt.toString().padStart(14, "0")}-${randomBytes(4).toString("hex")}${GREETING_FILE_SUFFIX}`,
    )
}
