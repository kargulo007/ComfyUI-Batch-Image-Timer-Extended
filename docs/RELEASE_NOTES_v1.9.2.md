# Release v1.9.2 — Generation Monitor Extended

**Extended edition maintained by Piotr Karwowski, based on Herman Kwan's original MIT-licensed ComfyUI Batch Image Timer.**

## Highlights
- One clear `GENERATION TIME` stopwatch with sampler progress (no duplicate total-images setting).
- Recent render history with image/prompt previews, workflow recall and gallery.
- Persistent SQLite totals across server restarts, interactive analytics and CSV.
- Optional separate GPU & VRAM Monitor, detailed hardware popup and output-storage totals.
- Dedicated TOOLS & PANELS: SETTINGS, FAILURES, ANALYTICS and MONITOR.
- In SETTINGS → MONITOR, `Show GPU & VRAM Monitor` is immediately followed by `Enable GPU Monitoring`.
- GPU device selection, export/import data, System Check and database-status indicator.

## Installation
Use the **source-code ZIP** of this Extended repository or git clone it into `ComfyUI/custom_nodes/`, restart the ComfyUI Python backend and hard-refresh the frontend. Do not run it alongside upstream: both expose the `BatchImageTimer` node type.

## Upgrading
Preserve your existing `data/` folder. Prefer exporting the current server settings and database before replacing an older installation. See `docs/INSTALLATION.md`.

## Caveats
- Image counts are verified from saved files where possible, otherwise explicitly estimated.
- GPU metrics depend on driver/device support and include other processes.
- Browser audio requires a loaded page and possibly an interaction to unlock playback.
- This release has received isolated source and simulation checks, not a full independent hardware/comfyui frontend compatibility certification.

## Credits
Based on `hermankwan/ComfyUI-Batch-Image-Timer` (MIT). Original notice retained in LICENSE. This is an independent extended release, not an official upstream update.
