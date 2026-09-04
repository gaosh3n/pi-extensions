# pi-edit-last-prompt

`pi-edit-last-prompt` re-edits the last aborted prompt in the current Pi session.

## What you get

- `/edit-last-prompt` to re-edit the last aborted prompt on the active branch
- current-session restore via Pi's native `navigateTree(...)` plus editor prefill
- explicit refusal when the last prompt contained images, because Pi restores prompts into the text editor only

## Install only this extension

```bash
pi install npm:@gaosh3n/pi-edit-last-prompt
```

Then restart Pi or run `/reload`.

## How to use it

Run:

```text
/edit-last-prompt
```

If the current branch ends in an aborted assistant turn, Pi rewinds the current session tree to before that user message and restores the prompt text into the editor. Edit the restored text, then submit it normally.

Pi currently persists some manual aborts during tool execution as `stopReason: "error"` with an abort-shaped `errorMessage` instead of `stopReason: "aborted"`. This extension compensates for that specific runtime quirk, but it still refuses ordinary non-abort assistant errors.

If the current branch does not end in an aborted assistant turn, the command refuses instead of jumping back to an older aborted turn.

This does **not** rewrite prior session history in place. Pi sessions are append-only, so the abandoned path remains in the tree; the command just moves the current session back to the right point and pre-fills the editor.

## Limitation

Image-bearing prompts are intentionally unsupported in v1. If the last prompt included image blocks, the command warns and does not try to round-trip that prompt through the text editor.
