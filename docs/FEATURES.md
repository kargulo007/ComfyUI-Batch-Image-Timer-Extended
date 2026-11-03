# Feature guide — v1.9.2

## Generation clock

- Shows one complete workflow execution time in `MM:SS:CC`.
- Uses the standard ComfyUI sampler progress events when available.
- Does not independently dictate `Empty Latent Image` batch size or create images.
- Colors can be changed using the LED palette in the node.

## Recent Generations

- Stores a short list of recent successful runs with timestamps and durations.
- FAST, AVG and SLOW are computed for the visible run history. For multi-image runs, per-image comparisons can differ from the total execution time.
- Hover a row to access image/prompt details when metadata and files are available.
- GALLERY opens a larger multi-image view; open image/workflow actions require accessible outputs and retained workflow metadata.
- CLEAR affects the short history display, not long-term period statistics.

## Generation Statistics

- SESSION is scoped to the ComfyUI backend process.
- TODAY / THIS WEEK / LAST WEEK / THIS MONTH / LAST MONTH aggregate stored records.
- 7D and 30D provide rolling-period comparisons.
- Render Performance shows recent stored runs; hover/click for details.
- Calendar, Compare, Insights, model breakdown, CSV and Recheck are available via ANALYTICS.
- `~` after a count marks an inferred image count rather than verified output files.

## GPU & VRAM Monitor

- Separate optional panel; independent from Generation Statistics.
- SETTINGS → MONITOR:
  1. `Show GPU & VRAM Monitor` — show/hide the node panel.
  2. `Enable GPU Monitoring` — start/stop telemetry; independent of visibility.
  3. `GPU Device` — automatic, selected device or all available NVIDIA devices.
- Detailed metrics via TOOLS & PANELS → MONITOR.
- Device-wide readings may include load from other processes.
- Samples are periodic, so very short spikes can be missed.

## Output Storage

- Records file sizes when output metadata includes accessible paths under the ComfyUI output directory.
- Scanner is optional and on demand; no full disk scan on each render.
- Does not alter or duplicate output images.

## Notifications

- Completion/failure sound and desktop notifications are optional.
- Volume and TEST SOUND are available in SETTINGS.
- Browser autoplay rules can prevent sound until you interact with the page.
- Browser preferences are not the same as server-side `settings.json`.

## Database & tools

- SQLite and server settings are saved in `data/` under the plugin folder when writable.
- Daily backup, manual backup, restore with safety snapshot, and export/import are available.
- Import replaces server settings/database after confirmation. Do not expose administrative ComfyUI access publicly.
- SYSTEM CHECK reports server-side diagnostics; DATABASE status is shown in TOOLS & PANELS.
- A failed or interrupted job is tracked separately when the server exposes enough events; missing timestamps are not invented.
