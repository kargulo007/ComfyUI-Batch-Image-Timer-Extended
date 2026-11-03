# Troubleshooting

## The node cannot be found in ComfyUI
Make sure `__init__.py` is at the root of the installed extension directory. Restart **the Python backend**, not only the browser. Search for `Batch Image Timer`. Do not install both upstream and Extended versions at once.

## The timer works but statistics stop increasing
Open `/batch_timer/stats/health` and `/batch_timer/stats/diagnostics` at your ComfyUI server address, then inspect `observer` health, recent polling and error fields. The server observer relies on ComfyUI history and may miss entries already discarded before it observed them. Run `ANALYTICS → RECHECK` if those runs are still present on the server.

## History shows 10 runs, but TODAY displays fewer
The short UI history and server SQLite history have different sources and retention behavior. A custom save node may not expose standard output metadata; in some cases the server can only estimate the count (`~`). Compare current DB status and recent ComfyUI history; do not assume totals should match without inspecting the recorded outputs.

## The frontend looks outdated after an update
Stop and restart the server, then hard-reload with `Ctrl+Shift+R`. Check that files are copied into the correct `web/` folder with no extra nesting. Clear a stale browser cache only if needed.

## GPU is N/A
Confirm SETTINGS → MONITOR → `Enable GPU Monitoring` is on. NVIDIA readings need supported NVML or the `nvidia-smi` driver executable; other GPUs or restricted hosting can offer only partial VRAM information.

## No completion sound
Enable sound, set volume above 0%, press TEST SOUND, and check browser tab mute and OS volume mixer. Browser autoplay policies often require a direct interaction before playing audio.

## Old image thumbnail is missing
The original image may have been moved/deleted or produced by a save node without standard metadata. The extension does not store duplicate image copies.

## Database initialization failed
Check folder write permissions, available disk space and backend logs. The plugin may fall back to a ComfyUI user directory if its own `data/` is not writable. Avoid copying live SQLite files without a consistent backup.

## ComfyUI is hosted remotely
`output` and GPU statistics refer to the **server**, not your laptop; sound/notifications refer to the browser. Protect import/restore administration from untrusted users.

## Reporting an issue
Use the GitHub bug-report template. Include ComfyUI/backend version, frontend version, GPU/driver, steps to reproduce, screenshots and sanitized logs. Do not post real prompts, tokens, workflow metadata or full databases if they contain private information.
