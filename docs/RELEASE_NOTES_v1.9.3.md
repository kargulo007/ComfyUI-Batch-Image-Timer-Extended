# ComfyUI Batch Image Timer Extended v1.9.3 — English UI Update

This release standardizes the **entire node user interface in English**.

## Changed
- Translated all Polish labels, help text, confirmation messages and errors in the Settings dialog (Monitor / Data / System).
- Translated gallery, failure history, notification settings, export/import, backup and workflow recovery dialogs.
- Standardized date and time display in the UI to English (`en-GB`) while preserving 24-hour time.
- Retained GPU/VRAM monitoring, rendering statistics, timers, database schemas, configuration keys, data persistence, workflows and all existing features.

## Installation
1. Stop the ComfyUI server.
2. Back up the existing `ComfyUI-Batch-Image-Timer/data` folder.
3. For an upgrade, extract the **PATCH** contents directly into `ComfyUI/custom_nodes/ComfyUI-Batch-Image-Timer/`, replacing matching files.
4. For a new installation, extract the **FULL** archive into `ComfyUI/custom_nodes/`, preserving the enclosed `ComfyUI-Batch-Image-Timer` folder.
5. Start the ComfyUI server and refresh the browser with Ctrl+Shift+R.

No migration of the statistics database is required.

## Attribution
Extended modifications (c) 2026 Piotr Karwowski. Based on the original MIT-licensed ComfyUI-Batch-Image-Timer by Herman Kwan. Original copyright notices are retained.
