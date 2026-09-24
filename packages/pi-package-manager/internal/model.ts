export const AUTO_UPDATE_RECORD_ENTRY_TYPE = "package-manager-auto-update-record"
export const REPORT_ENTRY_TYPE = "package-manager-report"
export const PACKAGE_MANAGER_TITLE = "Pi Package Manager"
export const PACKAGE_MANAGER_WIDGET_KEY = "pi-package-manager"
export const RELOAD_COUNTDOWN_SECONDS = 5
export const OUTPUT_PREVIEW_LINE_COUNT = 8
export const UPDATE_COMMAND = ["update", "--extensions"] as const
export const INSTALL_COMMAND = ["install"] as const
export const UNINSTALL_COMMAND = ["uninstall"] as const
export const CATALOG_SEARCH_LIMIT = 50
export const CATALOG_OVERALL_TIMEOUT_MS = 10_000
export const CATALOG_REQUEST_TIMEOUT_MS = 3_000
export const CATALOG_MAX_RESPONSE_BYTES = 1_048_576
export const CATALOG_METADATA_CONCURRENCY = 4
export const CATALOG_MAX_RETRIES = 1
export const CATALOG_CACHE_TTL_MS = 5 * 60_000
export const CATALOG_SEARCH_CACHE_SIZE = 16
export const CATALOG_METADATA_CACHE_SIZE = 128

export type AutoUpdateOutcome = "succeeded" | "failed" | "skipped"
export type InstallOutcome = "succeeded" | "failed"
export type UninstallOutcome = "succeeded" | "partial" | "failed"
export type ReportTone = "info" | "success" | "warning" | "error"
export type CatalogPackageType = "extension" | "prompt" | "skill" | "theme"
export type CatalogSort = "downloads" | "recent" | "name"

export interface CatalogSearchRequest {
    query: string
    type: CatalogPackageType | "all"
    sort: CatalogSort
}

export interface CatalogPackageLinks {
    npm?: string
    repository?: string
}

export interface CatalogPackage {
    name: string
    version: string
    description: string
    publisher?: string
    publishedAt?: string
    downloadCount?: number
    downloadPeriod: "weekly"
    types: CatalogPackageType[]
    links: CatalogPackageLinks
    installSource: string
}

export interface CatalogSearchResult {
    packages: CatalogPackage[]
    metadataIncomplete: boolean
    unresolvedMetadataCount: number
    stale: boolean
}

export interface CatalogSearchClient {
    search(
        request: CatalogSearchRequest,
        signal: AbortSignal,
    ): Promise<CatalogSearchResult>
    dispose(): void
}

export type WidgetState =
    | { mode: "status-checking" }
    | { mode: "checking" }
    | { mode: "installing"; packages: number }
    | { mode: "countdown"; secondsRemaining: number }
    | { mode: "package-installing"; source: string }
    | {
          mode: "package-uninstalling"
          current: number
          total: number
          source: string
      }

export interface AutoUpdateRecord {
    startedAtUtc: string
    endedAtUtc: string
    outcome: AutoUpdateOutcome
    packagesUpdated: number
    reason?: string
}

export interface PackageManagerReport {
    title: string
    headline?: string
    tone: ReportTone
    lines: string[]
    lineTone?: "default" | "dim"
    output?: string
    outputLabel?: string
    outputDescription?: string
    outputTone?: "default" | "dim"
    hideOutputWhenCollapsed?: boolean
}

export interface PackageStatusSnapshot {
    availableUpdates: string[]
    lastAutoUpdate?: AutoUpdateRecord
}

export interface ConfiguredPackageOption {
    source: string
    scope: "user" | "project"
    filtered: boolean
}
