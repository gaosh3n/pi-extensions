# pi-peer-addon

`pi-peer-addon` is an add-on built on top of Pi extension [`pi-peer`](https://github.com/shift-labs-ai/pi-peer).

## Important prerequisites

- `pi-peer-addon` requires the [extension `pi-peer`](https://github.com/shift-labs-ai/pi-peer) to already be installed in Pi.
- `pi-peer-addon` currently supports **local peers only**; remote peers are **not supported yet**.

## What you get

- `/peer-addon list-peers` to browse local peers in Pi
- `/peer-addon clean-up-peers` to clean up eligible local peers from Pi
- a two-page TUI: `Current dir` and `Other dirs`
- checkbox-style multi-select cleanup for peer records and inboxes
- conservative cleanup safety checks

## Install both extensions

Install `pi-peer` first, then install this package:

```bash
pi install npm:@shift-labs/pi-peer
pi install npm:@gaosh3n/pi-peer-addon
```

Then restart Pi or run `/reload`.

## How to use it

### List local peers

Run:

```text
/peer-addon list-peers
```

Pi shows a two-page picker for local peer records. Use Tab or ←→ to switch between `Current dir` and `Other dirs`.

### Clean up local peers

Run:

```text
/peer-addon clean-up-peers
```

Pi shows a two-page checkbox-style picker for local peer records. Use Tab or ←→ to switch between `Current dir` and `Other dirs`, use <space> to toggle selection, then press Enter to clean only peers that are still eligible for removal.

## Notes

- This package reads peer record files under `~/.pi/agent/peers/`.
- Cleanup re-checks disk state before deletion.
- If `pi-peer` is missing, this package should be treated as not fully configured.

## Acknowledgements

Thanks to [`pi-peer`](https://github.com/shift-labs-ai/pi-peer). This extension is built as an add-on for it.
