import {
    SettingsManager,
    getAgentDir,
    type ExecResult,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent"

export type ThemeLuminanceMode = "light" | "dark"

export interface RgbColor {
    r: number
    g: number
    b: number
}

export interface SavedThemeSettingOptions {
    cwd: string
    agentDir?: string
    projectTrusted: boolean
}

export interface ThemeLuminanceDeps {
    getTermProgram(): string | undefined
    showGhosttyConfig(
        pi: Pick<ExtensionAPI, "exec">,
        ctx: ExtensionContext,
    ): Promise<ExecResult>
}

export const defaultThemeLuminanceDeps: ThemeLuminanceDeps = {
    getTermProgram: () => process.env.TERM_PROGRAM,
    showGhosttyConfig(pi, ctx) {
        return pi.exec("ghostty", ["+show-config"], {
            cwd: ctx.cwd,
            signal: ctx.signal,
            timeout: 2000,
        })
    },
}

export default function initThemeLuminance(
    pi: ExtensionAPI,
    deps: ThemeLuminanceDeps = defaultThemeLuminanceDeps,
): void {
    pi.on("session_start", async (event, ctx) => {
        if (event.reason !== "startup" && event.reason !== "reload") {
            return
        }

        await syncThemeLuminance(pi, ctx, deps)
    })
}

export async function syncThemeLuminance(
    pi: Pick<ExtensionAPI, "exec">,
    ctx: ExtensionContext,
    deps: ThemeLuminanceDeps = defaultThemeLuminanceDeps,
): Promise<void> {
    if (deps.getTermProgram() !== "ghostty") {
        return
    }

    let configResult: ExecResult
    try {
        configResult = await deps.showGhosttyConfig(pi, ctx)
    } catch {
        return
    }

    if (configResult.code !== 0 || configResult.killed) {
        return
    }

    const background = parseGhosttyBackground(configResult.stdout)
    if (!background) {
        return
    }

    const color = parseHexColor(background)
    if (!color) {
        return
    }

    const savedThemeSetting = getSavedThemeSetting({
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
    })
    if (!savedThemeSetting) {
        return
    }

    const targetTheme = resolveThemeNameForMode(
        savedThemeSetting,
        classifyLuminance(color),
    )
    if (!targetTheme) {
        return
    }

    const candidateThemes = getCandidateThemes(savedThemeSetting)
    if (!candidateThemes) {
        return
    }

    const currentThemeName = ctx.ui.theme.name
    if (!currentThemeName || !candidateThemes.has(currentThemeName)) {
        return
    }

    if (currentThemeName === targetTheme || !ctx.ui.getTheme(targetTheme)) {
        return
    }

    ctx.ui.setTheme(targetTheme)
}

export function parseGhosttyBackground(stdout: string): string | undefined {
    const match = stdout.match(/^background = (.+)$/m)
    const background = match?.[1]?.trim()

    return background || undefined
}

export function parseHexColor(value: string): RgbColor | undefined {
    if (!value.startsWith("#")) {
        return undefined
    }

    const hex = value.slice(1)
    if (![3, 4, 6, 8].includes(hex.length) || /[^0-9a-f]/i.test(hex)) {
        return undefined
    }

    const normalized =
        hex.length <= 4
            ? [...hex]
                  .slice(0, 3)
                  .map((part) => part + part)
                  .join("")
            : hex.slice(0, 6)

    return {
        r: Number.parseInt(normalized.slice(0, 2), 16),
        g: Number.parseInt(normalized.slice(2, 4), 16),
        b: Number.parseInt(normalized.slice(4, 6), 16),
    }
}

export function classifyLuminance({ r, g, b }: RgbColor): ThemeLuminanceMode {
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    return luminance < 0.5 ? "dark" : "light"
}

export function getSavedThemeSetting({
    cwd,
    agentDir = getAgentDir(),
    projectTrusted,
}: SavedThemeSettingOptions): string | undefined {
    try {
        const themeSetting = SettingsManager.create(cwd, agentDir, {
            projectTrusted,
        }).getThemeSetting()

        return themeSetting?.trim() || undefined
    } catch {
        return undefined
    }
}

export function getCandidateThemes(
    savedThemeSetting: string,
): ReadonlySet<string> | undefined {
    const pair = parseThemePair(savedThemeSetting)
    if (pair) {
        return new Set(pair)
    }

    if (savedThemeSetting === "light" || savedThemeSetting === "dark") {
        return new Set(["light", "dark"])
    }

    return undefined
}

export function resolveThemeNameForMode(
    savedThemeSetting: string,
    mode: ThemeLuminanceMode,
): string | undefined {
    const pair = parseThemePair(savedThemeSetting)
    if (pair) {
        return mode === "light" ? pair[0] : pair[1]
    }

    if (savedThemeSetting === "light" || savedThemeSetting === "dark") {
        return mode
    }

    return undefined
}

function parseThemePair(themeSetting: string): [string, string] | undefined {
    const parts = themeSetting.split("/").map((part) => part.trim())
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return undefined
    }

    return [parts[0], parts[1]]
}
