import {
    DefaultPackageManager,
    SettingsManager,
    getAgentDir,
    type ExecResult,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent"

import {
    CATALOG_CACHE_TTL_MS,
    CATALOG_MAX_RESPONSE_BYTES,
    CATALOG_MAX_RETRIES,
    CATALOG_METADATA_CACHE_SIZE,
    CATALOG_METADATA_CONCURRENCY,
    CATALOG_OVERALL_TIMEOUT_MS,
    CATALOG_REQUEST_TIMEOUT_MS,
    CATALOG_SEARCH_CACHE_SIZE,
    CATALOG_SEARCH_LIMIT,
    INSTALL_COMMAND,
    UNINSTALL_COMMAND,
    UPDATE_COMMAND,
    type CatalogPackage,
    type CatalogPackageLinks,
    type CatalogPackageType,
    type CatalogSearchClient,
    type CatalogSearchRequest,
    type CatalogSearchResult,
    type CatalogSort,
    type ConfiguredPackageOption,
} from "./model.ts"

export interface PackageManagerDeps {
    nowIso(): string
    sleep(milliseconds: number): Promise<void>
    isOffline(): boolean
    checkForAvailableUpdates(ctx: ExtensionContext): Promise<string[]>
    listConfiguredPackages(ctx: ExtensionContext): Promise<ConfiguredPackageOption[]>
    runNativeUpdate(
        pi: Pick<ExtensionAPI, "exec">,
        ctx: ExtensionCommandContext,
    ): Promise<ExecResult>
    runNativeInstall(
        pi: Pick<ExtensionAPI, "exec">,
        ctx: ExtensionCommandContext,
        source: string,
    ): Promise<ExecResult>
    runNativeUninstall(
        pi: Pick<ExtensionAPI, "exec">,
        ctx: ExtensionCommandContext,
        source: string,
    ): Promise<ExecResult>
    searchCatalog(
        request: CatalogSearchRequest,
        signal: AbortSignal,
    ): Promise<CatalogSearchResult>
    createCatalogSearchClient?: () => CatalogSearchClient
}

export const defaultPackageManagerDeps: PackageManagerDeps = {
    nowIso: () => new Date().toISOString(),
    sleep(milliseconds: number) {
        return new Promise((resolve) => {
            setTimeout(resolve, milliseconds)
        })
    },
    isOffline: () => Boolean(process.env.PI_OFFLINE),
    async checkForAvailableUpdates(ctx: ExtensionContext): Promise<string[]> {
        const packageManager = createDefaultPackageManager(ctx)
        const updates = await packageManager.checkForAvailableUpdates()

        return updates
            .map((update) => update.displayName)
            .sort((left, right) => left.localeCompare(right))
    },
    async listConfiguredPackages(
        ctx: ExtensionContext,
    ): Promise<ConfiguredPackageOption[]> {
        return createDefaultPackageManager(ctx)
            .listConfiguredPackages()
            .map((pkg) => ({
                source: pkg.source,
                scope: pkg.scope,
                filtered: pkg.filtered,
            }))
            .sort((left, right) => left.source.localeCompare(right.source))
    },
    runNativeUpdate(pi: Pick<ExtensionAPI, "exec">, ctx: ExtensionCommandContext) {
        return pi.exec("pi", [...UPDATE_COMMAND], {
            cwd: ctx.cwd,
            signal: ctx.signal,
        })
    },
    runNativeInstall(
        pi: Pick<ExtensionAPI, "exec">,
        ctx: ExtensionCommandContext,
        source: string,
    ) {
        return pi.exec("pi", [...INSTALL_COMMAND, source], {
            cwd: ctx.cwd,
            signal: ctx.signal,
        })
    },
    runNativeUninstall(
        pi: Pick<ExtensionAPI, "exec">,
        ctx: ExtensionCommandContext,
        source: string,
    ) {
        return pi.exec("pi", [...UNINSTALL_COMMAND, source], {
            cwd: ctx.cwd,
            signal: ctx.signal,
        })
    },
    searchCatalog: (request, signal) =>
        createCatalogSearchClient().search(request, signal),
    createCatalogSearchClient,
}

function createDefaultPackageManager(ctx: ExtensionContext): DefaultPackageManager {
    const agentDir = getAgentDir()
    const settingsManager = SettingsManager.create(ctx.cwd, agentDir, {
        projectTrusted: ctx.isProjectTrusted(),
    })

    return new DefaultPackageManager({
        cwd: ctx.cwd,
        agentDir,
        settingsManager,
    })
}

const NPM_SEARCH_URL = "https://registry.npmjs.org/-/v1/search"
const NPM_REGISTRY_URL = "https://registry.npmjs.org"
const SEMVER_IDENTIFIER = "(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
const SEMVER_PATTERN = new RegExp(
    `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-(?:${SEMVER_IDENTIFIER}(?:\\.${SEMVER_IDENTIFIER})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
)
const CATALOG_TYPES: readonly CatalogPackageType[] = [
    "extension",
    "prompt",
    "skill",
    "theme",
]

type FetchLike = typeof fetch

interface CachedCatalogResult {
    expiresAt: number
    result: CatalogSearchResult
}

interface CachedMetadata {
    expiresAt: number
    package: CatalogPackage | undefined
}

export function createCatalogSearchClient(
    fetchImpl: FetchLike = fetch,
    now: () => number = Date.now,
): CatalogSearchClient {
    const searchCache = new Map<string, CachedCatalogResult>()
    const metadataCache = new Map<string, CachedMetadata>()
    let disposed = false

    return {
        async search(request, signal) {
            if (disposed) {
                throw new Error("Catalog search client is disposed.")
            }
            throwIfAborted(signal)

            const query = request.query.trim()
            const cacheKey = query.toLocaleLowerCase()
            const cached = searchCache.get(cacheKey)

            if (cached && cached.expiresAt > now()) {
                searchCache.delete(cacheKey)
                searchCache.set(cacheKey, cached)
                return viewCatalogResult(cached.result, request)
            }

            const overall = new AbortController()
            const overallTimer = setTimeout(
                () => overall.abort(),
                CATALOG_OVERALL_TIMEOUT_MS,
            )
            const abortOverall = () => overall.abort(signal.reason)
            signal.addEventListener("abort", abortOverall, { once: true })

            try {
                const result = await fetchCatalogResult(
                    fetchImpl,
                    query,
                    overall.signal,
                    signal,
                    metadataCache,
                    now,
                )
                putLru(
                    searchCache,
                    cacheKey,
                    {
                        expiresAt: now() + CATALOG_CACHE_TTL_MS,
                        result,
                    },
                    CATALOG_SEARCH_CACHE_SIZE,
                )
                return viewCatalogResult(result, request)
            } catch (error) {
                if (signal.aborted) {
                    throw error
                }
                const stale = searchCache.get(cacheKey)
                if (stale) {
                    searchCache.delete(cacheKey)
                    searchCache.set(cacheKey, stale)
                    return {
                        ...viewCatalogResult(stale.result, request),
                        stale: true,
                    }
                }
                throw error
            } finally {
                clearTimeout(overallTimer)
                signal.removeEventListener("abort", abortOverall)
            }
        },
        dispose() {
            disposed = true
            searchCache.clear()
            metadataCache.clear()
        },
    }
}

export function sanitizeCatalogPackage(
    pkg: CatalogPackage,
): CatalogPackage | undefined {
    if (!isRecord(pkg)) {
        return undefined
    }

    const name = typeof pkg.name === "string" ? pkg.name : ""
    const version = boundedText(typeof pkg.version === "string" ? pkg.version : "", 100)
    const rawTypes = Array.isArray(pkg.types) ? pkg.types : []
    const types = CATALOG_TYPES.filter((type) => rawTypes.includes(type))
    const links = isRecord(pkg.links) ? pkg.links : {}
    if (
        !isValidNpmPackageName(name) ||
        !isValidCatalogVersion(version) ||
        types.length === 0 ||
        pkg.installSource !== `npm:${name}`
    ) {
        return undefined
    }

    return {
        name,
        version,
        description: boundedText(
            typeof pkg.description === "string" ? pkg.description : "",
            400,
        ),
        publisher:
            typeof pkg.publisher === "string"
                ? boundedText(pkg.publisher, 100) || undefined
                : undefined,
        publishedAt:
            typeof pkg.publishedAt === "string"
                ? boundedText(pkg.publishedAt, 80) || undefined
                : undefined,
        downloadCount:
            typeof pkg.downloadCount === "number" &&
            Number.isFinite(pkg.downloadCount) &&
            pkg.downloadCount >= 0
                ? pkg.downloadCount
                : undefined,
        downloadPeriod: "weekly",
        types,
        links: {
            npm: safeHttpUrl(stringValue(links.npm)),
            repository: safeHttpUrl(stringValue(links.repository)),
        },
        installSource: `npm:${name}`,
    }
}

export function applyCatalogView(
    packages: CatalogPackage[],
    type: CatalogSearchRequest["type"],
    sort: CatalogSort,
): CatalogPackage[] {
    const filtered =
        type === "all" ? packages : packages.filter((pkg) => pkg.types.includes(type))

    return [...filtered].sort((left, right) => {
        if (sort === "downloads") {
            const downloadDifference =
                (right.downloadCount ?? -1) - (left.downloadCount ?? -1)
            if (downloadDifference !== 0) {
                return downloadDifference
            }
        } else if (sort === "recent") {
            const dateDifference =
                (Date.parse(right.publishedAt ?? "") || 0) -
                (Date.parse(left.publishedAt ?? "") || 0)
            if (dateDifference !== 0) {
                return dateDifference
            }
        }

        return left.name.localeCompare(right.name, undefined, {
            sensitivity: "base",
        })
    })
}

async function fetchCatalogResult(
    fetchImpl: FetchLike,
    query: string,
    operationSignal: AbortSignal,
    callerSignal: AbortSignal,
    metadataCache: Map<string, CachedMetadata>,
    now: () => number,
): Promise<CatalogSearchResult> {
    const url = new URL(NPM_SEARCH_URL)
    url.searchParams.set(
        "text",
        query ? `${query} keywords:pi-package` : "keywords:pi-package",
    )
    url.searchParams.set("size", String(CATALOG_SEARCH_LIMIT))

    const payload = await fetchJson(fetchImpl, url, operationSignal, callerSignal)
    const objects = asArray(isRecord(payload) ? payload.objects : undefined)
    const candidates = objects
        .map((object) => normalizeSearchCandidate(object))
        .filter((candidate): candidate is SearchCandidate => candidate !== undefined)

    const packages: CatalogPackage[] = []
    let unresolvedMetadataCount = 0
    await forEachLimited(
        candidates,
        CATALOG_METADATA_CONCURRENCY,
        async (candidate) => {
            try {
                const pkg = await resolveCatalogPackage(
                    fetchImpl,
                    candidate,
                    operationSignal,
                    callerSignal,
                    metadataCache,
                    now,
                )
                if (pkg) {
                    packages.push(pkg)
                } else {
                    unresolvedMetadataCount += 1
                }
            } catch (error) {
                if (callerSignal.aborted) {
                    throw error
                }
                unresolvedMetadataCount += 1
            }
        },
    )

    if (packages.length === 0 && candidates.length > 0) {
        throw new Error("No usable Pi packages were found in the catalog response.")
    }

    return {
        packages,
        metadataIncomplete: unresolvedMetadataCount > 0,
        unresolvedMetadataCount,
        stale: false,
    }
}

interface SearchCandidate {
    name: string
    version: string
    description: string
    publisher?: string
    publishedAt?: string
    downloadCount?: number
    links: CatalogPackageLinks
}

function normalizeSearchCandidate(value: unknown): SearchCandidate | undefined {
    if (!isRecord(value) || !isRecord(value.package)) {
        return undefined
    }

    const pkg = value.package
    const name = stringValue(pkg.name)
    const version = boundedText(stringValue(pkg.version) ?? "", 100)
    if (
        !name ||
        !version ||
        !isValidNpmPackageName(name) ||
        !isValidCatalogVersion(version)
    ) {
        return undefined
    }

    const downloads = isRecord(value.downloads) ? value.downloads.weekly : undefined
    return {
        name,
        version,
        description: boundedText(stringValue(pkg.description) ?? "", 400),
        publisher: isRecord(pkg.publisher)
            ? boundedText(stringValue(pkg.publisher.username) ?? "", 100) || undefined
            : undefined,
        publishedAt: stringValue(pkg.date),
        downloadCount: numberValue(downloads),
        links: {
            npm: safeHttpUrl(
                isRecord(pkg.links) ? stringValue(pkg.links.npm) : undefined,
            ),
            repository: safeHttpUrl(
                isRecord(pkg.links) ? stringValue(pkg.links.repository) : undefined,
            ),
        },
    }
}

async function resolveCatalogPackage(
    fetchImpl: FetchLike,
    candidate: SearchCandidate,
    operationSignal: AbortSignal,
    callerSignal: AbortSignal,
    metadataCache: Map<string, CachedMetadata>,
    now: () => number,
): Promise<CatalogPackage | undefined> {
    const cacheKey = `${candidate.name}@${candidate.version}`
    const cached = getFresh(metadataCache, cacheKey, now())
    if (cached) {
        return cached.package
    }

    const url = `${NPM_REGISTRY_URL}/${encodeURIComponent(candidate.name)}/${encodeURIComponent(candidate.version)}`
    const payload = await fetchJson(
        fetchImpl,
        new URL(url),
        operationSignal,
        callerSignal,
    )
    const types = getCatalogTypes(payload)
    const pkg =
        types.length > 0
            ? {
                  ...candidate,
                  types,
                  installSource: `npm:${candidate.name}`,
                  downloadPeriod: "weekly" as const,
              }
            : undefined

    putLru(
        metadataCache,
        cacheKey,
        { expiresAt: now() + CATALOG_CACHE_TTL_MS, package: pkg },
        CATALOG_METADATA_CACHE_SIZE,
    )
    return pkg
}

function getCatalogTypes(value: unknown): CatalogPackageType[] {
    if (!isRecord(value) || !isRecord(value.pi)) {
        return []
    }

    const result: CatalogPackageType[] = []
    for (const type of CATALOG_TYPES) {
        const key = `${type}s`
        const declaration = value.pi[key]
        if (
            (Array.isArray(declaration) && declaration.length > 0) ||
            (typeof declaration === "string" && declaration.trim().length > 0) ||
            (isRecord(declaration) && Object.keys(declaration).length > 0)
        ) {
            result.push(type)
        }
    }
    return result
}

async function fetchJson(
    fetchImpl: FetchLike,
    url: URL,
    operationSignal: AbortSignal,
    callerSignal: AbortSignal,
): Promise<unknown> {
    let attempt = 0
    while (true) {
        try {
            return await fetchJsonOnce(fetchImpl, url, operationSignal, callerSignal)
        } catch (error) {
            if (
                attempt >= CATALOG_MAX_RETRIES ||
                isAbortError(error) ||
                !isRetryableNetworkError(error)
            ) {
                throw error
            }
            attempt += 1
        }
    }
}

async function fetchJsonOnce(
    fetchImpl: FetchLike,
    url: URL,
    operationSignal: AbortSignal,
    callerSignal: AbortSignal,
): Promise<unknown> {
    throwIfAborted(callerSignal)
    if (operationSignal.aborted) {
        throw new CatalogRequestTimeoutError()
    }

    const timeout = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
        timedOut = true
        timeout.abort()
    }, CATALOG_REQUEST_TIMEOUT_MS)
    const combined = new AbortController()
    const abort = () => combined.abort()
    const timeoutAbort = () => combined.abort()
    operationSignal.addEventListener("abort", abort, { once: true })
    timeout.signal.addEventListener("abort", timeoutAbort, { once: true })

    try {
        const response = await fetchImpl(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: combined.signal,
        })
        if (!response.ok) {
            throw new Error(`Catalog request failed with HTTP ${response.status}.`)
        }
        return await readJsonBody(response)
    } catch (error) {
        if (callerSignal.aborted) {
            throw createAbortError()
        }
        if (timedOut || operationSignal.aborted) {
            throw new CatalogRequestTimeoutError()
        }
        throw error
    } finally {
        clearTimeout(timer)
        operationSignal.removeEventListener("abort", abort)
        timeout.signal.removeEventListener("abort", timeoutAbort)
    }
}

async function readJsonBody(response: Response): Promise<unknown> {
    const length = response.headers.get("content-length")
    if (length && Number(length) > CATALOG_MAX_RESPONSE_BYTES) {
        throw new Error("Catalog response is too large.")
    }

    if (!response.body) {
        const text = await response.text()
        if (text.length > CATALOG_MAX_RESPONSE_BYTES) {
            throw new Error("Catalog response is too large.")
        }
        return JSON.parse(text)
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
        while (true) {
            const next = await reader.read()
            if (next.done) break
            total += next.value.byteLength
            if (total > CATALOG_MAX_RESPONSE_BYTES) {
                await reader.cancel()
                throw new Error("Catalog response is too large.")
            }
            chunks.push(next.value)
        }
    } finally {
        reader.releaseLock()
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder().decode(bytes))
}

async function forEachLimited<T>(
    values: T[],
    concurrency: number,
    run: (value: T) => Promise<void>,
): Promise<void> {
    let index = 0
    const worker = async (): Promise<void> => {
        while (index < values.length) {
            const value = values[index++]
            if (value !== undefined) await run(value)
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
    )
}

function viewCatalogResult(
    result: CatalogSearchResult,
    request: CatalogSearchRequest,
): CatalogSearchResult {
    return {
        ...result,
        packages: applyCatalogView(result.packages, request.type, request.sort),
    }
}

function getFresh<T extends { expiresAt: number }>(
    cache: Map<string, T>,
    key: string,
    now: number,
): T | undefined {
    const value = cache.get(key)
    if (!value || value.expiresAt <= now) {
        if (value) cache.delete(key)
        return undefined
    }
    cache.delete(key)
    cache.set(key, value)
    return value as T
}

function putLru<T extends { expiresAt: number }>(
    cache: Map<string, T>,
    key: string,
    value: T,
    limit: number,
): void {
    cache.delete(key)
    cache.set(key, value)
    while (cache.size > limit) {
        const first = cache.keys().next().value
        if (first === undefined) break
        cache.delete(first)
    }
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function boundedText(value: string, maxLength: number): string {
    const clean = [...value]
        .filter((character) => {
            const code = character.codePointAt(0) ?? 0
            return code > 31 && code !== 127 && (code < 128 || code > 159)
        })
        .join("")
        .trim()
    return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean
}

function safeHttpUrl(value: string | undefined): string | undefined {
    if (!value) return undefined
    try {
        const url = new URL(value)
        return url.protocol === "https:" || url.protocol === "http:"
            ? url.href
            : undefined
    } catch {
        return undefined
    }
}

function isValidNpmPackageName(value: string): boolean {
    return (
        value.length <= 214 &&
        !hasUnsafeNpmNameCharacters(value) &&
        !value.includes("..") &&
        (/^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/u.test(value) ||
            /^[a-z0-9][a-z0-9._~-]*$/u.test(value))
    )
}

export function isValidCatalogVersion(value: string): boolean {
    return SEMVER_PATTERN.test(value)
}

function hasUnsafeNpmNameCharacters(value: string): boolean {
    return (
        /\\s/u.test(value) ||
        [...value].some((character) => {
            const code = character.codePointAt(0) ?? 0
            return code <= 31 || code === 127
        })
    )
}

class CatalogRequestTimeoutError extends Error {
    constructor() {
        super("Catalog request timed out.")
        this.name = "CatalogRequestTimeoutError"
    }
}

function createAbortError(): DOMException {
    return new DOMException("The catalog request was aborted.", "AbortError")
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw createAbortError()
    }
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError"
}

function isRetryableNetworkError(error: unknown): boolean {
    return (
        error instanceof TypeError ||
        (error instanceof Error && /timeout|fetch|network/i.test(error.message))
    )
}
