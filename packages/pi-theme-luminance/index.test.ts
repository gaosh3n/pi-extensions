import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import initThemeLuminance, {
    classifyLuminance,
    getCandidateThemes,
    getSavedThemeSetting,
    parseGhosttyBackground,
    parseHexColor,
    resolveThemeNameForMode,
    syncThemeLuminance,
    type ThemeLuminanceDeps,
} from "./index.ts"

interface SessionStartHarness {
    sessionStart:
        | ((event: { reason: string }, ctx: Record<string, unknown>) => Promise<void>)
        | undefined
    execCalls: Array<{ command: string; args: string[]; options: unknown }>
    setThemeCalls: string[]
    ctx: Record<string, unknown>
}

interface TempSettingsContext {
    agentDir: string
    projectDir: string
}

function createSessionStartHarness(options?: {
    deps?: Partial<ThemeLuminanceDeps>
}): SessionStartHarness {
    const execCalls: SessionStartHarness["execCalls"] = []
    const setThemeCalls: string[] = []

    let sessionStart: SessionStartHarness["sessionStart"]

    const ctx = {
        cwd: process.cwd(),
        signal: undefined,
        isProjectTrusted: () => true,
        ui: {
            theme: { name: "light" },
            getTheme(name: string) {
                return ["light", "dark"].includes(name) ? { name } : undefined
            },
            setTheme(name: string) {
                setThemeCalls.push(name)
                return { success: true }
            },
        },
    }

    initThemeLuminance(
        {
            on(event: string, handler: SessionStartHarness["sessionStart"]) {
                if (event === "session_start") {
                    sessionStart = handler
                }
            },
            exec(command: string, args: string[], execOptions?: unknown) {
                execCalls.push({ command, args, options: execOptions })
                return Promise.resolve({
                    stdout: "background = #ffffff\n",
                    stderr: "",
                    code: 0,
                    killed: false,
                })
            },
        } as any,
        {
            getTermProgram: () => "wezterm",
            showGhosttyConfig(pi, context) {
                return pi.exec("ghostty", ["+show-config"], {
                    cwd: context.cwd,
                    signal: context.signal,
                    timeout: 2000,
                })
            },
            scheduleReloadSync() {
                return () => {}
            },
            ...options?.deps,
        },
    )

    return { sessionStart, execCalls, setThemeCalls, ctx }
}

function createSyncContext(options: {
    cwd: string
    currentThemeName?: string | undefined
    availableThemes?: string[]
    projectTrusted?: boolean
    onSetTheme?: (theme: unknown) => void
}): { ctx: any; setThemeCalls: string[]; setThemeArguments: unknown[] } {
    const setThemeCalls: string[] = []
    const setThemeArguments: unknown[] = []
    const currentTheme = { name: options.currentThemeName }
    const themeObjects = new Map(
        (options.availableThemes ?? ["light", "dark"]).map((name) => [name, { name }]),
    )

    return {
        ctx: {
            cwd: options.cwd,
            signal: undefined,
            isProjectTrusted: () => options.projectTrusted ?? true,
            ui: {
                theme: currentTheme,
                getTheme(name: string) {
                    return themeObjects.get(name)
                },
                setTheme(theme: unknown) {
                    setThemeArguments.push(theme)
                    setThemeCalls.push(
                        typeof theme === "string"
                            ? theme
                            : (theme as { name: string }).name,
                    )
                    currentTheme.name =
                        typeof theme === "string"
                            ? theme
                            : (theme as { name: string }).name
                    options.onSetTheme?.(theme)
                    return { success: true }
                },
            },
        },
        setThemeCalls,
        setThemeArguments,
    }
}

async function withTempSettings(
    options: {
        globalTheme?: string
        projectTheme?: string
    },
    run: (context: TempSettingsContext) => Promise<void>,
): Promise<void> {
    const temp = await mkdtemp(join(tmpdir(), "pi-theme-luminance-"))

    try {
        const agentDir = join(temp, "agent")
        const projectDir = join(temp, "project")
        await mkdir(agentDir, { recursive: true })
        await mkdir(join(projectDir, ".pi"), { recursive: true })

        if (options.globalTheme) {
            await writeFile(
                join(agentDir, "settings.json"),
                JSON.stringify({ theme: options.globalTheme }),
            )
        }

        if (options.projectTheme) {
            await writeFile(
                join(projectDir, ".pi", "settings.json"),
                JSON.stringify({ theme: options.projectTheme }),
            )
        }

        await withAgentDir(agentDir, async () => {
            await run({ agentDir, projectDir })
        })
    } finally {
        await rm(temp, { recursive: true, force: true })
    }
}

async function withAgentDir(agentDir: string, run: () => Promise<void>): Promise<void> {
    const previous = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir

    try {
        await run()
    } finally {
        if (previous === undefined) {
            delete process.env.PI_CODING_AGENT_DIR
        } else {
            process.env.PI_CODING_AGENT_DIR = previous
        }
    }
}

function createGhosttyDeps(stdout: string): ThemeLuminanceDeps {
    return {
        getTermProgram: () => "ghostty",
        showGhosttyConfig: async () => ({
            stdout,
            stderr: "",
            code: 0,
            killed: false,
        }),
        scheduleReloadSync() {
            return () => {}
        },
    }
}

test("registers a session_start handler", () => {
    const harness = createSessionStartHarness()
    assert.ok(harness.sessionStart)
})

test("ignores session starts that are not startup or reload", async () => {
    const harness = createSessionStartHarness()

    await harness.sessionStart?.({ reason: "resume" }, harness.ctx)

    assert.deepEqual(harness.execCalls, [])
    assert.deepEqual(harness.setThemeCalls, [])
})

test("TERM_PROGRAM not ghostty is a no-op", async () => {
    const harness = createSessionStartHarness({
        deps: {
            getTermProgram: () => "wezterm",
        },
    })

    await harness.sessionStart?.({ reason: "startup" }, harness.ctx)

    assert.deepEqual(harness.execCalls, [])
    assert.deepEqual(harness.setThemeCalls, [])
})

test(
    "syncs the saved automatic theme pair to the dark side",
    { concurrency: false },
    async () => {
        await withTempSettings(
            { globalTheme: "light-theme/dark-theme" },
            async ({ projectDir }) => {
                const { ctx, setThemeCalls } = createSyncContext({
                    cwd: projectDir,
                    currentThemeName: "light-theme",
                    availableThemes: ["light-theme", "dark-theme"],
                })

                await syncThemeLuminance(
                    {
                        exec: async () => ({
                            stdout: "",
                            stderr: "",
                            code: 0,
                            killed: false,
                        }),
                    } as any,
                    ctx,
                    createGhosttyDeps("background = #000000\n"),
                )

                assert.deepEqual(setThemeCalls, ["dark-theme"])
            },
        )
    },
)

test(
    "keeps an automatic saved theme pair when switching the runtime theme",
    { concurrency: false },
    async () => {
        await withTempSettings(
            { globalTheme: "dayowl/nightowl" },
            async ({ agentDir, projectDir }) => {
                const { ctx, setThemeCalls, setThemeArguments } = createSyncContext({
                    cwd: projectDir,
                    currentThemeName: "dayowl",
                    availableThemes: ["dayowl", "nightowl"],
                    onSetTheme(theme) {
                        // Pi persists when setTheme receives a name. This
                        // simulates that behavior so the test catches a
                        // regression to name-based switching.
                        if (typeof theme === "string") {
                            writeFileSync(
                                join(agentDir, "settings.json"),
                                JSON.stringify({ theme }),
                            )
                        }
                    },
                })

                await syncThemeLuminance(
                    {
                        exec: async () => ({
                            stdout: "",
                            stderr: "",
                            code: 0,
                            killed: false,
                        }),
                    } as any,
                    ctx,
                    createGhosttyDeps("background = #000000\n"),
                )

                assert.deepEqual(setThemeCalls, ["nightowl"])
                assert.strictEqual(setThemeArguments[0], ctx.ui.getTheme("nightowl"))
                assert.notEqual(typeof setThemeArguments[0], "string")
                assert.equal(
                    getSavedThemeSetting({
                        cwd: projectDir,
                        agentDir,
                        projectTrusted: true,
                    }),
                    "dayowl/nightowl",
                )
            },
        )
    },
)

test(
    "keeps the dark side after Pi reapplies Automatic during reload",
    { concurrency: false },
    async () => {
        await withTempSettings(
            { globalTheme: "dayowl/nightowl" },
            async ({ projectDir }) => {
                const { ctx } = createSyncContext({
                    cwd: projectDir,
                    currentThemeName: "dayowl",
                    availableThemes: ["dayowl", "nightowl"],
                })
                let sessionStart:
                    | ((event: { reason: string }, context: any) => Promise<void>)
                    | undefined
                let scheduledSync: (() => Promise<void>) | undefined

                initThemeLuminance(
                    {
                        on(event: string, handler: any) {
                            if (event === "session_start") {
                                sessionStart = handler
                            }
                        },
                        exec: async () => ({
                            stdout: "",
                            stderr: "",
                            code: 0,
                            killed: false,
                        }),
                    } as any,
                    {
                        getTermProgram: () => "ghostty",
                        showGhosttyConfig: async () => ({
                            stdout: "background = #000000\n",
                            stderr: "",
                            code: 0,
                            killed: false,
                        }),
                        scheduleReloadSync(callback) {
                            scheduledSync = callback
                            return () => {}
                        },
                    },
                )

                // Pi emits session_start before its reload path reapplies
                // the saved Automatic setting.
                await sessionStart?.({ reason: "reload" }, ctx)
                ctx.ui.setTheme("dayowl")
                await scheduledSync?.()

                assert.equal(ctx.ui.theme.name, "nightowl")
            },
        )
    },
)

test("cancels stale deferred reload syncs", async () => {
    const callbacks: Array<() => Promise<void>> = []
    const cancellations: number[] = []
    const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>()
    let getTermProgramCalls = 0

    initThemeLuminance(
        {
            on(event: string, handler: any) {
                handlers.set(event, handler)
            },
            exec: async () => ({
                stdout: "",
                stderr: "",
                code: 0,
                killed: false,
            }),
        } as any,
        {
            getTermProgram: () => {
                getTermProgramCalls++
                return "ghostty"
            },
            showGhosttyConfig: async () => ({
                stdout: "background = #000000\n",
                stderr: "",
                code: 0,
                killed: false,
            }),
            scheduleReloadSync(callback) {
                const index = callbacks.push(callback) - 1
                return () => cancellations.push(index)
            },
        },
    )

    const sessionStart = handlers.get("session_start")
    const sessionShutdown = handlers.get("session_shutdown")
    assert.ok(sessionStart)
    assert.ok(sessionShutdown)

    await sessionStart({ reason: "reload" }, {})
    await sessionStart({ reason: "reload" }, {})
    assert.deepEqual(cancellations, [0])

    await sessionShutdown({ reason: "reload" }, {})
    assert.deepEqual(cancellations, [0, 1])

    await callbacks[0]?.()
    await callbacks[1]?.()
    assert.equal(getTermProgramCalls, 0)
})

test(
    "syncs fixed saved light or dark themes using Pi built-in light and dark",
    { concurrency: false },
    async () => {
        await withTempSettings({ globalTheme: "dark" }, async ({ projectDir }) => {
            const { ctx, setThemeCalls } = createSyncContext({
                cwd: projectDir,
                currentThemeName: "dark",
                availableThemes: ["light", "dark"],
            })

            await syncThemeLuminance(
                {
                    exec: async () => ({
                        stdout: "",
                        stderr: "",
                        code: 0,
                        killed: false,
                    }),
                } as any,
                ctx,
                createGhosttyDeps("background = #ffffff\n"),
            )

            assert.deepEqual(setThemeCalls, ["light"])
        })
    },
)

test("single custom saved theme is a no-op", { concurrency: false }, async () => {
    await withTempSettings(
        { globalTheme: "tokyonight-day" },
        async ({ projectDir }) => {
            const { ctx, setThemeCalls } = createSyncContext({
                cwd: projectDir,
                currentThemeName: "tokyonight-day",
                availableThemes: ["tokyonight-day"],
            })

            await syncThemeLuminance(
                {
                    exec: async () => ({
                        stdout: "",
                        stderr: "",
                        code: 0,
                        killed: false,
                    }),
                } as any,
                ctx,
                createGhosttyDeps("background = #000000\n"),
            )

            assert.deepEqual(setThemeCalls, [])
        },
    )
})

test(
    "current theme outside the saved-setting candidate set is a no-op",
    { concurrency: false },
    async () => {
        await withTempSettings(
            { globalTheme: "light-theme/dark-theme" },
            async ({ projectDir }) => {
                const { ctx, setThemeCalls } = createSyncContext({
                    cwd: projectDir,
                    currentThemeName: "custom-run-override",
                    availableThemes: [
                        "light-theme",
                        "dark-theme",
                        "custom-run-override",
                    ],
                })

                await syncThemeLuminance(
                    {
                        exec: async () => ({
                            stdout: "",
                            stderr: "",
                            code: 0,
                            killed: false,
                        }),
                    } as any,
                    ctx,
                    createGhosttyDeps("background = #000000\n"),
                )

                assert.deepEqual(setThemeCalls, [])
            },
        )
    },
)

test("missing current theme name is a no-op", { concurrency: false }, async () => {
    await withTempSettings({ globalTheme: "light/dark" }, async ({ projectDir }) => {
        const { ctx, setThemeCalls } = createSyncContext({
            cwd: projectDir,
            currentThemeName: undefined,
            availableThemes: ["light", "dark"],
        })

        await syncThemeLuminance(
            {
                exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
            } as any,
            ctx,
            createGhosttyDeps("background = #000000\n"),
        )

        assert.deepEqual(setThemeCalls, [])
    })
})

test("ghostty command failure is a no-op", { concurrency: false }, async () => {
    await withTempSettings({ globalTheme: "light/dark" }, async ({ projectDir }) => {
        const { ctx, setThemeCalls } = createSyncContext({
            cwd: projectDir,
            currentThemeName: "light",
            availableThemes: ["light", "dark"],
        })

        await syncThemeLuminance(
            {
                exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
            } as any,
            ctx,
            {
                getTermProgram: () => "ghostty",
                showGhosttyConfig: async () => ({
                    stdout: "",
                    stderr: "ghostty missing",
                    code: 127,
                    killed: false,
                }),
                scheduleReloadSync() {
                    return () => {}
                },
            },
        )

        assert.deepEqual(setThemeCalls, [])
    })
})

test("missing or malformed background is a no-op", { concurrency: false }, async () => {
    await withTempSettings({ globalTheme: "light/dark" }, async ({ projectDir }) => {
        const { ctx, setThemeCalls } = createSyncContext({
            cwd: projectDir,
            currentThemeName: "light",
            availableThemes: ["light", "dark"],
        })

        await syncThemeLuminance(
            {
                exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
            } as any,
            ctx,
            createGhosttyDeps("background = not-a-color\n"),
        )

        assert.deepEqual(setThemeCalls, [])
    })
})

test("already-active target theme is a no-op", { concurrency: false }, async () => {
    await withTempSettings(
        { globalTheme: "light-theme/dark-theme" },
        async ({ projectDir }) => {
            const { ctx, setThemeCalls } = createSyncContext({
                cwd: projectDir,
                currentThemeName: "dark-theme",
                availableThemes: ["light-theme", "dark-theme"],
            })

            await syncThemeLuminance(
                {
                    exec: async () => ({
                        stdout: "",
                        stderr: "",
                        code: 0,
                        killed: false,
                    }),
                } as any,
                ctx,
                createGhosttyDeps("background = #000000\n"),
            )

            assert.deepEqual(setThemeCalls, [])
        },
    )
})

test("missing target theme is a no-op", { concurrency: false }, async () => {
    await withTempSettings(
        { globalTheme: "light-theme/dark-theme" },
        async ({ projectDir }) => {
            const { ctx, setThemeCalls } = createSyncContext({
                cwd: projectDir,
                currentThemeName: "light-theme",
                availableThemes: ["light-theme"],
            })

            await syncThemeLuminance(
                {
                    exec: async () => ({
                        stdout: "",
                        stderr: "",
                        code: 0,
                        killed: false,
                    }),
                } as any,
                ctx,
                createGhosttyDeps("background = #000000\n"),
            )

            assert.deepEqual(setThemeCalls, [])
        },
    )
})

test(
    "getSavedThemeSetting prefers trusted project settings over global settings",
    { concurrency: false },
    async () => {
        await withTempSettings(
            {
                globalTheme: "dark",
                projectTheme: "light-theme/dark-theme",
            },
            async ({ agentDir, projectDir }) => {
                assert.equal(
                    getSavedThemeSetting({
                        cwd: projectDir,
                        agentDir,
                        projectTrusted: true,
                    }),
                    "light-theme/dark-theme",
                )
            },
        )
    },
)

test(
    "getSavedThemeSetting ignores project settings when the project is not trusted",
    { concurrency: false },
    async () => {
        await withTempSettings(
            {
                globalTheme: "dark",
                projectTheme: "light-theme/dark-theme",
            },
            async ({ agentDir, projectDir }) => {
                assert.equal(
                    getSavedThemeSetting({
                        cwd: projectDir,
                        agentDir,
                        projectTrusted: false,
                    }),
                    "dark",
                )
            },
        )
    },
)

test("parseGhosttyBackground extracts the background value", () => {
    assert.equal(
        parseGhosttyBackground("theme = TokyoNight Day\nbackground = #e1e2e7\n"),
        "#e1e2e7",
    )
})

test("parseHexColor normalizes rgb and rgba-style hex colors", () => {
    assert.deepEqual(parseHexColor("#abc"), { r: 170, g: 187, b: 204 })
    assert.deepEqual(parseHexColor("#11223344"), { r: 17, g: 34, b: 51 })
    assert.equal(parseHexColor("rgb(1,2,3)"), undefined)
})

test("classifyLuminance distinguishes dark and light backgrounds", () => {
    assert.equal(classifyLuminance({ r: 0, g: 0, b: 0 }), "dark")
    assert.equal(classifyLuminance({ r: 255, g: 255, b: 255 }), "light")
})

test("theme candidate and resolution helpers follow the settled rules", () => {
    assert.deepEqual(
        [...(getCandidateThemes("light-theme/dark-theme") ?? [])],
        ["light-theme", "dark-theme"],
    )
    assert.deepEqual([...(getCandidateThemes("dark") ?? [])], ["light", "dark"])
    assert.equal(
        resolveThemeNameForMode("light-theme/dark-theme", "light"),
        "light-theme",
    )
    assert.equal(resolveThemeNameForMode("dark", "light"), "light")
    assert.equal(resolveThemeNameForMode("tokyonight-day", "dark"), undefined)
})
