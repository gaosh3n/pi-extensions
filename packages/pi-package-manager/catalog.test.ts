import assert from "node:assert/strict"
import test from "node:test"

import {
    applyCatalogView,
    createCatalogSearchClient,
    isValidCatalogVersion,
} from "./internal/runtime.ts"
import type { CatalogPackage, CatalogSearchRequest } from "./internal/model.ts"

function packageRecord(
    input: Partial<CatalogPackage> & Pick<CatalogPackage, "name">,
): CatalogPackage {
    return {
        name: input.name,
        version: input.version ?? "1.0.0",
        description: input.description ?? input.name,
        publisher: input.publisher,
        publishedAt: input.publishedAt,
        downloadCount: input.downloadCount,
        downloadPeriod: "weekly",
        types: input.types ?? ["extension"],
        links: input.links ?? {},
        installSource: `npm:${input.name}`,
    }
}

function request(
    type: CatalogSearchRequest["type"] = "all",
    sort: CatalogSearchRequest["sort"] = "downloads",
): CatalogSearchRequest {
    return { query: "demo", type, sort }
}

test("catalog view filters by type and sorts deterministically", () => {
    const packages = [
        packageRecord({
            name: "zeta",
            downloadCount: 10,
            publishedAt: "2025-01-01T00:00:00.000Z",
            types: ["skill"],
        }),
        packageRecord({
            name: "alpha",
            downloadCount: 10,
            publishedAt: "2025-02-01T00:00:00.000Z",
            types: ["extension", "skill"],
        }),
        packageRecord({
            name: "beta",
            downloadCount: undefined,
            publishedAt: "2025-03-01T00:00:00.000Z",
            types: ["theme"],
        }),
    ]

    assert.deepEqual(
        applyCatalogView(packages, "skill", "downloads").map((pkg) => pkg.name),
        ["alpha", "zeta"],
    )
    assert.deepEqual(
        applyCatalogView(packages, "all", "recent").map((pkg) => pkg.name),
        ["beta", "alpha", "zeta"],
    )
    assert.deepEqual(
        applyCatalogView(packages, "all", "name").map((pkg) => pkg.name),
        ["alpha", "beta", "zeta"],
    )
})

test("catalog client uses bounded npm JSON endpoints and caches a query", async () => {
    const calls: Array<{ url: string; headers: unknown }> = []
    const fetchImpl = async (input: unknown, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, headers: init?.headers })
        if (url.includes("/-/v1/search")) {
            return new Response(
                JSON.stringify({
                    objects: [
                        {
                            package: {
                                name: "pi-demo",
                                version: "1.2.3",
                                description: "A demo package",
                                date: "2025-02-01T00:00:00.000Z",
                                publisher: { username: "demo" },
                                links: { npm: "https://www.npmjs.com/package/pi-demo" },
                            },
                            downloads: { weekly: 42 },
                        },
                    ],
                }),
                { status: 200, headers: { "content-type": "application/json" } },
            )
        }
        return new Response(
            JSON.stringify({
                name: "pi-demo",
                version: "1.2.3",
                pi: { extensions: ["dist/index.ts"] },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        )
    }

    const client = createCatalogSearchClient(fetchImpl)
    const first = await client.search(request(), new AbortController().signal)
    const second = await client.search(
        request("extension", "name"),
        new AbortController().signal,
    )

    assert.equal(first.packages[0]?.name, "pi-demo")
    assert.equal(first.packages[0]?.downloadCount, 42)
    assert.deepEqual(
        second.packages.map((pkg) => pkg.name),
        ["pi-demo"],
    )
    assert.equal(calls.length, 2)
    assert.match(calls[0]!.url, /text=demo\+keywords%3Api-package/u)
    assert.match(calls[0]!.url, /size=50/u)
    assert.equal(
        (calls[0]!.headers as Record<string, string>).Accept,
        "application/json",
    )
    assert.match(calls[1]!.url, /pi-demo\/1\.2\.3/u)

    client.dispose()
})

test("catalog client keeps expired results for stale fallback after refresh failure", async () => {
    let now = 0
    let searchCalls = 0
    const fetchImpl = async (input: unknown) => {
        const url = String(input)
        if (url.includes("/-/v1/search")) {
            searchCalls += 1
            if (searchCalls > 1) {
                throw new TypeError("network down")
            }
            return new Response(
                JSON.stringify({
                    objects: [
                        {
                            package: { name: "pi-stale", version: "1.0.0" },
                            downloads: { weekly: 1 },
                        },
                    ],
                }),
                { status: 200 },
            )
        }
        return new Response(JSON.stringify({ pi: { themes: ["theme"] } }), {
            status: 200,
        })
    }

    const client = createCatalogSearchClient(fetchImpl, () => now)
    await client.search(request(), new AbortController().signal)
    now = 5 * 60_000 + 1
    const result = await client.search(request(), new AbortController().signal)

    assert.equal(result.stale, true)
    assert.deepEqual(
        result.packages.map((pkg) => pkg.name),
        ["pi-stale"],
    )
    client.dispose()
})

test("catalog client does not start work with an already-aborted signal", async () => {
    let calls = 0
    const client = createCatalogSearchClient(async () => {
        calls += 1
        return new Response("{}", { status: 200 })
    })
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(
        client.search(request(), controller.signal),
        (error: unknown) =>
            error instanceof DOMException && error.name === "AbortError",
    )
    assert.equal(calls, 0)
    client.dispose()
})

test("catalog client sanitizes untrusted display metadata", async () => {
    const fetchImpl = async (input: unknown) => {
        const url = String(input)
        if (url.includes("/-/v1/search")) {
            return new Response(
                JSON.stringify({
                    objects: [
                        {
                            package: {
                                name: "pi-safe",
                                version: "1.0.0",
                                description: "hello\u001b[2J world",
                                publisher: { username: "user\u0007" },
                            },
                            downloads: { weekly: 1 },
                        },
                    ],
                }),
                { status: 200 },
            )
        }
        return new Response(JSON.stringify({ pi: { prompts: ["prompt"] } }), {
            status: 200,
        })
    }

    const client = createCatalogSearchClient(fetchImpl)
    const result = await client.search(request(), new AbortController().signal)
    const pkg = result.packages[0]!

    assert.equal(pkg.version, "1.0.0")
    assert.equal(pkg.description, "hello[2J world")
    assert.equal(pkg.publisher, "user")
    assert.equal(isValidCatalogVersion("1.2.3-beta.1+build.4"), true)
    assert.equal(isValidCatalogVersion("1.2.3-1"), true)
    assert.equal(isValidCatalogVersion("1.2.3-01"), false)
    assert.equal(isValidCatalogVersion("1.0.0[31m"), false)
    assert.doesNotMatch(JSON.stringify(pkg), /\\u001b|\\u0007/u)
    client.dispose()
})

test("catalog client reports incomplete metadata while preserving usable packages", async () => {
    const fetchImpl = async (input: unknown) => {
        const url = String(input)
        if (url.includes("/-/v1/search")) {
            return new Response(
                JSON.stringify({
                    objects: [
                        {
                            package: { name: "pi-good", version: "1.0.0" },
                            downloads: { weekly: 10 },
                        },
                        {
                            package: { name: "pi-bad", version: "1.0.0" },
                            downloads: { weekly: 9 },
                        },
                    ],
                }),
                { status: 200 },
            )
        }
        if (url.includes("pi-bad")) {
            return new Response("not found", { status: 404 })
        }
        return new Response(JSON.stringify({ pi: { skills: ["skills"] } }), {
            status: 200,
        })
    }

    const client = createCatalogSearchClient(fetchImpl)
    const result = await client.search(request(), new AbortController().signal)

    assert.deepEqual(
        result.packages.map((pkg) => pkg.name),
        ["pi-good"],
    )
    assert.equal(result.metadataIncomplete, true)
    assert.equal(result.unresolvedMetadataCount, 1)
    client.dispose()
})
