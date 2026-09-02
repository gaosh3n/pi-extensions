# pi-peer-addon

`pi-peer-addon` is an add-on built on top of Pi extension [`pi-peer`](https://github.com/shift-labs-ai/pi-peer).

## Important prerequisites

- `pi-peer-addon` requires the [extension `pi-peer`](https://github.com/shift-labs-ai/pi-peer) to already be installed in Pi.
- `pi-peer-addon` currently supports **local peers only**; remote peers are **not supported yet**.

## What you get

- `/peer-addon list-peers` to browse local peers in Pi
- `/peer-addon clean-up-peers` to clean up eligible local peers from Pi
- `/peer-addon introduce-peers` to introduce the current local peer to other local peers
- a two-page TUI for browsing and cleanup: `Current dir` and `Other dirs`
- checkbox-style multi-select cleanup for peer records and inboxes
- a tabbed peer-introduction prompt with `Prepared`, `Sent`, and `Skipped` pages
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

Pi shows a two-page checkbox-style picker for local peer records. Use Tab or ←→ to switch between `Current dir` and `Other dirs`, use <space> to toggle selection, press `f` to toggle safe-mode on/off, then press Enter to clean the selected peers. With safe-mode on, only offline peers with empty inboxes are eligible. With safe-mode off, other live/stalled peers and peers with pending mail can also be selected.

### Introduce local peers

Run:

```text
/peer-addon introduce-peers
```

Pi prepares one first-person greeting message per local peer record, delivers the target-specific receiver messages to the other local peers through a quieter add-on greeting path, also emits the sender's own greeting in the same raw receiver style, and then shows a tabbed peer list for `Prepared`, `Sent`, and `Skipped` introductions.

## Notes

- This package reads peer record files under `~/.pi/agent/peers/`.
- `/peer-addon introduce-peers` uses `pi-peer` records for discovery, but delivers greeting files through the add-on's own watched path inside each peer inbox so receivers see only the raw greeting content, without `pi-peer`'s default behavior.
- Cleanup re-checks disk state before deletion.
- Safe-mode can be toggled with `f`. Even with safe-mode off, the current session's own peer mailbox is still never removable.
- If `pi-peer` is missing, this package should be treated as not fully configured.

## Acknowledgements

Thanks to [`pi-peer`](https://github.com/shift-labs-ai/pi-peer). This extension is built as an add-on for it.
