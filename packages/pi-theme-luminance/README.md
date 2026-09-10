# pi-theme-luminance

`pi-theme-luminance` syncs Pi light/dark theme with terminal background luminance.

## What you get

- terminal-aware light/dark theme sync for Pi
- startup and `/reload` sync based on the supported terminal's background luminance

## Current terminal support

- Ghostty

## Install only this extension

```bash
pi install npm:@gaosh3n/pi-theme-luminance
```

Then restart Pi or run `/reload`.

## How it works

On `session_start`, the extension:

- applies startup synchronization immediately
- defers reload synchronization by 150ms so Pi 0.84.4's own Automatic-theme detector (which waits up to 100ms) finishes first

Then it:

1. checks whether Pi is running in a supported terminal
2. reads that terminal's effective background color
3. computes background luminance and classifies it as `light` or `dark`
4. reads Pi's **saved** `theme` setting through `SettingsManager`
5. resolves the target theme when that saved setting is deterministic:
    - automatic theme pair picks the matching side
    - fixed `light` or `dark` switches between Pi's built-in `light` and `dark`
    - fixed custom theme names are left with no action
6. loads the target theme with `ctx.ui.getTheme(...)` and applies the returned `Theme` object with `ctx.ui.setTheme(...)`

The extension intentionally passes a `Theme` object instead of a theme name. In the current Pi implementation, the interactive UI persists a theme when `setTheme()` receives a name, which would replace an automatic setting such as `dayowl/nightowl` with the currently selected side. Passing the loaded `Theme` object changes only the current runtime theme and preserves the saved automatic pair. The public API documents both forms in [`ExtensionUIContext`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts).

If the current active theme is outside the candidate set implied by the saved setting, the extension does nothing. That guard avoids stomping obvious run-local overrides.

## Limitation

Pi documents `pi --use-theme ...` as a per-run initial override that does not rewrite the saved setting. Public extension APIs do not expose that original override string, so this extension uses the saved setting as the least-wrong source of intent and no-ops when the current theme looks ambiguous.
