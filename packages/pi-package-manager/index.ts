import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { type AutocompleteItem } from "@earendil-works/pi-tui"

import {
    createPackageManagerController,
    shouldAutoUpdateOnSessionStart,
} from "./internal/controller.ts"
import {
    createAutoUpdateRecord,
    getLastAutoUpdateRecord,
    isAutoUpdateRecord,
    isAutoUpdateRecordEntry,
} from "./internal/records.ts"
import {
    AUTO_UPDATE_RECORD_ENTRY_TYPE,
    PACKAGE_MANAGER_TITLE,
    REPORT_ENTRY_TYPE,
    type AutoUpdateOutcome,
    type AutoUpdateRecord,
    type PackageManagerReport,
    type PackageStatusSnapshot,
    type ReportTone,
    type WidgetState,
} from "./internal/model.ts"
import {
    createAutomaticUpdateWidgetLines,
    createAutoUpdateResultReport,
    createInstallResultReport,
    createReportEntryRenderer,
    createUninstallResultReport,
    createStatusReport,
    formatStatusLines,
    formatUtcTimestamp,
} from "./internal/reports.ts"
import {
    defaultPackageManagerDeps,
    type PackageManagerDeps,
} from "./internal/runtime.ts"

export default function initPackageManager(
    pi: ExtensionAPI,
    deps: PackageManagerDeps = defaultPackageManagerDeps,
): void {
    const controller = createPackageManagerController(pi, deps)

    pi.registerEntryRenderer<PackageManagerReport>(
        REPORT_ENTRY_TYPE,
        createReportEntryRenderer(),
    )

    pi.on("session_start", controller.onSessionStart)
    pi.on("session_shutdown", controller.onSessionShutdown)

    pi.registerCommand("package-manager", {
        description:
            "Manage Pi packages (usage: /package-manager [status|update|install|uninstall])",
        getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
            const items = ["status", "update", "install", "uninstall"].map((value) => ({
                value,
                label: value,
            }))
            const normalizedPrefix = prefix.trim()
            const filtered = normalizedPrefix
                ? items.filter((item) => item.value.startsWith(normalizedPrefix))
                : items
            return filtered.length > 0 ? filtered : null
        },
        handler: async (args, ctx) => {
            const tokens = args.trim().split(/\s+/).filter(Boolean)
            const subcommand = tokens[0] ?? "status"

            if (subcommand === "status") {
                await controller.handleStatus(ctx)
                return
            }

            if (subcommand === "update") {
                await controller.handleUpdate(ctx, {
                    startupTriggered: tokens.includes("--startup"),
                })
                return
            }

            if (subcommand === "install") {
                await controller.handleInstall(ctx)
                return
            }

            if (subcommand === "uninstall") {
                await controller.handleUninstall(ctx)
                return
            }

            ctx.ui.notify(
                "Usage: /package-manager [status|update|install|uninstall]",
                "warning",
            )
        },
    })
}

export {
    AUTO_UPDATE_RECORD_ENTRY_TYPE,
    PACKAGE_MANAGER_TITLE,
    REPORT_ENTRY_TYPE,
    createAutomaticUpdateWidgetLines,
    createAutoUpdateRecord,
    createAutoUpdateResultReport,
    createInstallResultReport,
    createUninstallResultReport,
    createStatusReport,
    formatStatusLines,
    formatUtcTimestamp,
    getLastAutoUpdateRecord,
    isAutoUpdateRecord,
    isAutoUpdateRecordEntry,
    shouldAutoUpdateOnSessionStart,
}
export type {
    AutoUpdateOutcome,
    AutoUpdateRecord,
    PackageManagerDeps,
    PackageManagerReport,
    PackageStatusSnapshot,
    ReportTone,
    WidgetState,
}
