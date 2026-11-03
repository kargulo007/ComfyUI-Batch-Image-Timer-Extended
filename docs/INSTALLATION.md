# Installation and migration

## Fresh installation

1. Stop the ComfyUI Python process.
2. Download the repository ZIP from GitHub (or clone it).
3. Put the **repository folder itself** under `ComfyUI/custom_nodes/`.
4. Confirm that `__init__.py`, `batch_image_timer.py`, `timer_statistics.py`, `timer_hardware.py`, `pyproject.toml` and `web/` are in that directory.
5. Restart ComfyUI and reload the browser with `Ctrl+Shift+R`.
6. Search for `Batch Image Timer` under `utils/timer`.

### Example Windows Portable folder

```text
H:\ComfyUI_windows_portable\ComfyUI\custom_nodes\ComfyUI-Batch-Image-Timer-Extended\
```

### Example Linux/server folder

```text
/home/user/ComfyUI/custom_nodes/ComfyUI-Batch-Image-Timer-Extended/
```

On a remote server, all statistics, GPU readings and image scans run **on the server**, not the browser's PC.

## Switching from the original or an older extended build

Both the original and this extension register the same ComfyUI node class. **Do not leave both active** under `custom_nodes/`.

**Recommended data migration:** in the old extended build, use `SETTINGS → DATA → EXPORT ALL DATA` (when available); stop ComfyUI, install the new repository in place of the older node, start ComfyUI, and import your exported archive under `SETTINGS → DATA`. The importer accepts compatible v1.9.2 archives only.

**Alternative:** stop ComfyUI fully and back up/copy the entire existing `data/` directory to the new node folder. Check for SQLite `-wal`/`-shm` sidecars before copying. Prefer a consistent export or SQLite snapshot when possible. Do not rename, merge or manually edit the database while the server is running.

If you are simply updating code inside the **same** folder, preserve `data/` and overlay the source files. Restart the backend; browser refresh alone will not update Python modules.

## Confirm backend initialization

With default port 8188, open:

```text
http://127.0.0.1:8188/batch_timer/stats/health
http://127.0.0.1:8188/batch_timer/stats/diagnostics
```

A working health endpoint should return structured JSON; verify the reported database path and observer status. If it does not, review the ComfyUI console logs for import failures.

## Keeping data safe

- Never overwrite or delete the local `data/` directory as part of an update.
- Automatic snapshots are database-only: they do not include output images, models or environment files.
- Keep database backup archives out of public source control; workflow metadata and prompts may be sensitive.
- For remote hosting, protect the ComfyUI server and management endpoints from untrusted access.
