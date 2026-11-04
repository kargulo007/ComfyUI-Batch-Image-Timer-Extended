## v1.9.3 — English UI Update

- Standardized the full node interface in English: Settings, Gallery, Failures, History, Workflow actions and notifications.
- Unified date/time display to English `en-GB` format.
- No change to database structure, settings keys or generation logic.

# Changelog

Documented changes in the **Extended** edition based on the original [ComfyUI-Batch-Image-Timer](https://github.com/hermankwan/ComfyUI-Batch-Image-Timer).
Original upstream release history and implementation belong to its respective authors.

## [1.9.2] — Settings, portability and diagnostics
- Reorganized SETTINGS into MONITOR, DATA and SYSTEM sections.
- Placed `Enable GPU Monitoring` immediately below `Show GPU & VRAM Monitor`.
- Added GPU selection (AUTO, specific device and ALL when available).
- Added export/import of database and server-side settings with pre-import backup.
- Added system check and discreet DATABASE health status.

## [1.9.1] — Node layout
- Separated the collapsible GPU & VRAM panel from Generation Statistics.
- Added independent TOOLS & PANELS popup launcher section.

## [1.9.0] — GPU and storage
- Added GPU/VRAM/temperature monitoring, selected per-run hardware summaries.
- Added storage totals for output files and optional output-folder scans.

## [1.8.0] — Analytics and recovery
- Interactive performance chart, Compare, Calendar and Insights.
- Recheck/reconcile statistics and restore backups with safety snapshots.

## [1.7.2] — Sound
- Sound independent of desktop notifications, volume slider and TEST SOUND.

## [1.7.1] — Statistics fix
- Better handling of custom image-save nodes and diagnostics for observer failures.

## [1.7.0] — Generation monitoring
- Performance baseline, gallery, failure/interruption log, backup automation and settings.

## [1.6.0] — Persistent data
- SQLite-backed render history and period statistics across server restarts.

## [1.5.2] — Generation timer
- Single `GENERATION TIME` clock with sampler-progress indicator.

## Earlier extension milestones
- Removed manual `total_images` and ETA / COMPUTE / TOTAL mode switching.
- Added recent-generation image/prompt preview and workflow recall.
- Added daily, weekly and monthly totals and display of FAST / AVG / SLOW.

Detailed historical notes are preserved in [`docs/archive_changelogs/`](docs/archive_changelogs/).
