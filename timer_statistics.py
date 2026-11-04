"""Copyright (c) 2026 Piotr Karwowski — Extended modifications.
Batch Image Timer v1.6: persistent, server-side statistics and recent history.

SQLite lives in <this custom node>/data by default (Portable and server installs).
An existing v1.5 database in ComfyUI/user/batch_image_timer is migrated once.
If custom_nodes is read-only, fall back to that ComfyUI user directory.

The background observer reads *finalized ComfyUI history*; it doesn't patch
ComfyUI's execution engine or require an open browser. It cannot recover jobs
that ComfyUI never put in its in-memory history (e.g. after a crash).
"""
import csv
import io
import zipfile
import tempfile
import os
import json
import logging
import math
import statistics
import re
import sqlite3
import threading
import time
import uuid
from contextlib import closing
from datetime import datetime
from pathlib import Path

from aiohttp import web
from server import PromptServer
from . import timer_hardware as hardware
import asyncio

LOG = logging.getLogger('BatchImageTimer.Statistics')
VERSION = '1.9.3'
SESSION = uuid.uuid4().hex
PLUGIN_DIR = Path(__file__).resolve().parent
DB_PATH = None
DB_WARNING = None
LOCK = threading.RLock()
OBSERVER_STARTED = False
_OBSERVER_THREAD = None
_OBSERVER_STATUS = {'last_poll_ms': None, 'last_error': None, 'history_items': 0,
                    'successful_with_file_metadata': 0, 'estimated_from_workflow': 0,
                    'skipped_no_evidence': 0, 'failed_or_interrupted': 0,
                    'registered': 0, 'running': False}
DEFAULT_SETTINGS = {'history_rows': 10, 'gallery_limit': 30, 'show_chart': True,
 'performance_enabled': True, 'performance_threshold': 25, 'performance_min_samples': 5,
 'backups_enabled': True, 'backup_retention': 14, 'show_failures': True,
 'show_gpu_panel': True, 'gpu_enabled': True, 'gpu_device': 'auto'}
_SETTINGS = None
_SCHEMA_READY = False


def _legacy_directory():
    try:
        import folder_paths
        return Path(folder_paths.get_user_directory()) / 'batch_image_timer'
    except Exception:
        return PLUGIN_DIR / 'data_fallback'


def _db_path():
    global DB_PATH, DB_WARNING
    if DB_PATH is not None:
        return DB_PATH
    with LOCK:
        if DB_PATH is not None:
            return DB_PATH
        primary = PLUGIN_DIR / 'data'
        legacy = _legacy_directory()
        try:
            primary.mkdir(parents=True, exist_ok=True)
            # A writable directory is not sufficient if its DB is read-only.
            probe = primary / '.write_test'
            probe.write_text('ok', encoding='utf-8')
            probe.unlink()
            target = primary / 'rendering_statistics.sqlite3'
            old = legacy / 'rendering_statistics.sqlite3'
            if not target.exists() and old.is_file():
                # Backup API makes the migration safe even with WAL activity.
                with closing(sqlite3.connect(str(old), timeout=8)) as source:
                    with closing(sqlite3.connect(str(target), timeout=8)) as destination:
                        source.backup(destination)
                LOG.info('Batch Image Timer: migrated old statistics into %s', target)
            DB_PATH = target
        except (OSError, sqlite3.Error) as exc:
            DB_WARNING = f'Plugin directory not writable: {exc}; using ComfyUI user directory'
            LOG.warning(DB_WARNING)
            legacy.mkdir(parents=True, exist_ok=True)
            DB_PATH = legacy / 'rendering_statistics.sqlite3'
        return DB_PATH


def _connect():
    global _SCHEMA_READY
    con = sqlite3.connect(str(_db_path()), timeout=8)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA busy_timeout=8000')
    if _SCHEMA_READY:
        return con
    with LOCK:
        if _SCHEMA_READY:
            return con
        con.execute('''CREATE TABLE IF NOT EXISTS completed_generations (
           prompt_id TEXT PRIMARY KEY,
           finished_ms INTEGER NOT NULL,
           duration_ms INTEGER NOT NULL,
           image_count INTEGER NOT NULL,
           verified INTEGER NOT NULL DEFAULT 1,
           session_id TEXT NOT NULL,
           images_json TEXT,
           prompts_json TEXT,
           workflow_json TEXT,
           model TEXT,
           resolution TEXT,
           hidden_recent INTEGER NOT NULL DEFAULT 0,
           duration_source TEXT DEFAULT 'events',
           steps INTEGER,
           cfg REAL,
           batch_size INTEGER,
           queue_wait_ms INTEGER,
           seed TEXT,
           output_bytes INTEGER,
           output_files_sized INTEGER,
           gpu_peak_vram_bytes INTEGER,
           gpu_avg_util_pct REAL,
           gpu_peak_temp_c REAL
        )''')
        current = {x[1] for x in con.execute('PRAGMA table_info(completed_generations)')}
        additions = {'images_json':'TEXT','prompts_json':'TEXT','workflow_json':'TEXT',
                     'model':'TEXT','resolution':'TEXT','hidden_recent':'INTEGER NOT NULL DEFAULT 0',
                     'duration_source':"TEXT DEFAULT 'unknown'", 'steps':'INTEGER',
                     'cfg':'REAL','batch_size':'INTEGER','queue_wait_ms':'INTEGER','seed':'TEXT',
                     'output_bytes':'INTEGER','output_files_sized':'INTEGER',
                     'gpu_peak_vram_bytes':'INTEGER','gpu_avg_util_pct':'REAL','gpu_peak_temp_c':'REAL'}
        for name, field in additions.items():
            if name not in current:
                con.execute(f'ALTER TABLE completed_generations ADD COLUMN {name} {field}')
        con.execute('CREATE INDEX IF NOT EXISTS idx_finished ON completed_generations(finished_ms)')
        con.execute('CREATE INDEX IF NOT EXISTS idx_session ON completed_generations(session_id)')
        con.execute('''CREATE TABLE IF NOT EXISTS failed_generations (
            prompt_id TEXT PRIMARY KEY,
            finished_ms INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            duration_source TEXT NOT NULL DEFAULT 'unavailable',
            session_id TEXT NOT NULL,
            result TEXT NOT NULL,
            error_text TEXT,
            model TEXT,
            resolution TEXT
        )''')
        con.execute('CREATE INDEX IF NOT EXISTS idx_failure_finished ON failed_generations(finished_ms)')
        con.commit()
        _SCHEMA_READY = True
        return con


def _time_ms(value):
    if isinstance(value, (float, int)):
        return int(value * 1000) if 1e9 <= value < 1e11 else int(value) if value >= 1e11 else None
    if isinstance(value, str):
        try:
            return _time_ms(float(value))
        except ValueError:
            try:
                return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)
            except ValueError:
                return None
    return None


def _execution_times(entry):
    """Read canonical execution_start/success timestamps; don't invent duration."""
    messages = (entry.get('status') or {}).get('messages') or []
    started = finished = None
    for message in messages:
        if not isinstance(message, (list, tuple)) or len(message) != 2:
            continue
        kind, data = message
        stamp = _time_ms(data.get('timestamp')) if isinstance(data, dict) else None
        if kind == 'execution_start' and stamp is not None:
            started = stamp
        elif kind in ('execution_success', 'execution_error', 'execution_interrupted') and stamp is not None:
            finished = stamp
    if finished is None:
        # A missing completion timestamp must not be treated as a measured duration.
        return int(time.time() * 1000), 0, 'unavailable'
    if started is not None and finished >= started:
        return finished, min(7*24*3600*1000, finished - started), 'events'
    return finished, 0, 'unavailable'


def _queue_wait_ms(entry):
    """Only report queue delay when ComfyUI exposes an explicit enqueue timestamp."""
    status = entry.get('status') or {}
    messages = status.get('messages') or []
    start_ms = None
    for message in messages:
        if isinstance(message, (list, tuple)) and len(message) == 2 and message[0] == 'execution_start':
            payload = message[1]
            if isinstance(payload, dict):
                start_ms = _time_ms(payload.get('timestamp'))
            break
    metadata = entry.get('queue') if isinstance(entry.get('queue'), dict) else {}
    raw = (entry.get('queued_at') or entry.get('enqueued_at') or
           metadata.get('queued_at') or metadata.get('enqueued_at'))
    queued_ms = _time_ms(raw)
    if start_ms is not None and queued_ms is not None and 0 <= start_ms-queued_ms <= 7*86400*1000:
        return start_ms-queued_ms
    return None


def _output_images(outputs):
    """Read common UI output forms, including compatible custom Save Image nodes.

    Only structured file metadata counts as verified. Never assume that latent
    batch size means the same number of images was actually saved.
    """
    unique = {}
    if not isinstance(outputs, dict):
        return []
    for output in outputs.values():
        if not isinstance(output, dict):
            continue
        candidates = [output]
        for key in ('ui', 'result'):
            nested = output.get(key)
            if isinstance(nested, dict):
                candidates.append(nested)
        for block in candidates:
            for key in ('images', 'image_files', 'saved_images'):
                images = block.get(key)
                if not isinstance(images, (list, tuple)):
                    continue
                for item in images:
                    if not isinstance(item, dict):
                        continue
                    name = item.get('filename') or item.get('file_name')
                    if not isinstance(name, str) or not name:
                        continue
                    # Prevent a video/audio output being counted as a photo.
                    suffix = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
                    if suffix not in ('png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif', 'avif'):
                        continue
                    kind = str(item.get('type', 'output')).lower()
                    if kind not in ('output', 'temp'):
                        continue
                    normalized = {'filename': name[:512],
                                  'subfolder': str(item.get('subfolder') or '')[:512],
                                  'type': kind}
                    unique[(kind, normalized['subfolder'], normalized['filename'])] = normalized
    saved = [x for x in unique.values() if x['type'] == 'output']
    return saved if saved else list(unique.values())


def _estimated_image_count(entry):
    """Conservative fallback for successful image-output workflows.

    If a custom image-save node does not publish a ComfyUI images[] list, its
    finished batch may still be counted, but marked as ESTIMATED (verified=0).
    Do not count arbitrary timer-only, audio or video workflows as pictures.
    """
    prompt_tuple = entry.get('prompt')
    graph = (prompt_tuple[2] if isinstance(prompt_tuple, (list, tuple)) and
             len(prompt_tuple) > 2 and isinstance(prompt_tuple[2], dict) else {})
    if not graph:
        return 0
    classes = []
    candidates = []
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        typ = str(node.get('class_type') or '').lower()
        classes.append(typ)
        inputs = node.get('inputs') or {}
        if not isinstance(inputs, dict):
            continue
        # Only explicitly image-related latent batch settings are authoritative
        # enough to use as an *estimate*.
        size = inputs.get('batch_size')
        if ('latent' in typ and 'image' in typ and 'video' not in typ and
                type(size) is int and 1 <= size <= 10000):
            candidates.append(size)
    has_image_writer = any(('saveimage' in x or 'previewimage' in x or
                            'imageoutput' in x or 'imagesaver' in x or
                            'save_image' in x) for x in classes)
    has_image_pipeline = any(('sampler' in x or 'vaedecode' in x or
                              'imagegenerator' in x or 'generateimage' in x) for x in classes)
    if not has_image_writer or not (has_image_pipeline or candidates):
        return 0
    # A workflow may contain multiple branches. We cannot infer how many output
    # files are produced by each branch; report a conservative batch estimate.
    return max(candidates) if candidates else 1


def _diagnose_history(entries):
    counts = {'history_items': len(entries) if isinstance(entries, dict) else 0,
              'successful_with_file_metadata': 0, 'estimated_from_workflow': 0,
              'skipped_no_evidence': 0, 'failed_or_interrupted': 0}
    for entry in (entries or {}).values():
        if not isinstance(entry, dict):
            continue
        if _failure_status(entry):
            counts['failed_or_interrupted'] += 1
            continue
        status = entry.get('status') or {}
        if not isinstance(status, dict) or status.get('status_str') != 'success' or not status.get('completed', False):
            continue
        if _output_images(entry.get('outputs')):
            counts['successful_with_file_metadata'] += 1
        elif _estimated_image_count(entry):
            counts['estimated_from_workflow'] += 1
        else:
            counts['skipped_no_evidence'] += 1
    return counts


def _get_prompt_data(entry):
    prompt_tuple = entry.get('prompt')
    graph = prompt_tuple[2] if isinstance(prompt_tuple, (list, tuple)) and len(prompt_tuple) > 2 and isinstance(prompt_tuple[2], dict) else {}
    extra = prompt_tuple[3] if isinstance(prompt_tuple, (list, tuple)) and len(prompt_tuple) > 3 and isinstance(prompt_tuple[3], dict) else {}
    snapshot = (extra.get('extra_pnginfo') or {}).get('workflow') if isinstance(extra.get('extra_pnginfo'), dict) else None
    if not isinstance(snapshot, dict):
        snapshot = None
    texts = []; models = []; resolutions = []; steps = None; cfg = None; batch = None; seed = None
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        typ = str(node.get('class_type') or '')
        inputs = node.get('inputs') or {}
        if not isinstance(inputs, dict):
            continue
        if isinstance(inputs.get('text'), str) and inputs['text'].strip():
            if 'textencode' in typ.lower() or 'prompt' in typ.lower():
                label = 'Prompt' if not texts else 'Text'
                texts.append({'label': label, 'text': inputs['text'][:8000]})
        for key in ('ckpt_name','unet_name','model_name','lora_name'):
            if isinstance(inputs.get(key), str):
                models.append(inputs[key][:220])
        w, h = inputs.get('width'), inputs.get('height')
        if isinstance(w, int) and isinstance(h, int) and w > 0 and h > 0:
            resolutions.append(f'{w}x{h}')
        if steps is None and isinstance(inputs.get('steps'), int):
            steps = inputs['steps']
        if cfg is None and isinstance(inputs.get('cfg'), (int, float)):
            cfg = float(inputs['cfg'])
        if batch is None and isinstance(inputs.get('batch_size'), int):
            batch = inputs['batch_size']
        if seed is None and any(x in typ.lower() for x in ('sampler','noise','seed')):
            candidate = inputs.get('seed', inputs.get('noise_seed'))
            if isinstance(candidate,(str,int)) and not isinstance(candidate,bool):
                seed = str(candidate)[:64]
    workflow_json = None
    if snapshot:
        try:
            serialized = json.dumps(snapshot, ensure_ascii=False, separators=(',', ':'))
            if len(serialized.encode('utf-8')) <= 2_000_000:
                workflow_json = serialized
        except (TypeError, ValueError):
            pass
    return {'prompts': texts[:8], 'workflow_json': workflow_json,
            'model': ', '.join(dict.fromkeys(models))[:400] if models else 'Unknown model',
            'resolution': ', '.join(dict.fromkeys(resolutions))[:100] if resolutions else 'Unknown',
            'steps': steps, 'cfg': cfg, 'batch_size': batch, 'seed':seed}


def _failure_status(entry):
    status = entry.get('status') or {}
    label = str(status.get('status_str') or '').lower()
    kinds = [event[0] for event in status.get('messages', [])
             if isinstance(event, (list, tuple)) and event]
    if 'execution_interrupted' in kinds or 'interrupt' in label or 'cancel' in label:
        return 'interrupted'
    if 'execution_error' in kinds or label in ('error', 'failed', 'failure'):
        return 'failed'
    return None


def _failure_message(entry):
    messages = ((entry.get('status') or {}).get('messages') or [])
    for item in reversed(messages):
        if not isinstance(item, (tuple, list)) or len(item) != 2:
            continue
        kind, data = item
        if kind in ('execution_error', 'execution_interrupted') and isinstance(data, dict):
            return str(data.get('exception_message') or data.get('message') or
                       data.get('exception_type') or kind)[:1500]
    return ''


def _record_history_entries(entries):
    if not isinstance(entries, dict) or not entries:
        return 0
    keys = [str(k) for k in entries.keys() if isinstance(k, str) and len(k) <= 128]
    if not keys:
        return 0
    with LOCK, closing(_connect()) as db:
        placeholders = ','.join('?' for _ in keys)
        existing = {r[0] for r in db.execute(f'SELECT prompt_id FROM completed_generations WHERE prompt_id IN ({placeholders})', keys)}
        existing.update(r[0] for r in db.execute(f'SELECT prompt_id FROM failed_generations WHERE prompt_id IN ({placeholders})', keys))
        done = 0
        for prompt_id in keys:
            if prompt_id in existing:
                continue
            entry = entries.get(prompt_id)
            if not isinstance(entry, dict):
                continue
            status = entry.get('status') or {}
            failure = _failure_status(entry)
            if failure:
                finished_ms, duration_ms, source = _execution_times(entry)
                details = _get_prompt_data(entry)
                db.execute('''INSERT OR IGNORE INTO failed_generations
                    (prompt_id,finished_ms,duration_ms,duration_source,session_id,result,error_text,model,resolution)
                    VALUES (?,?,?,?,?,?,?,?,?)''',
                    (prompt_id,finished_ms,duration_ms,source,SESSION,failure,
                     _failure_message(entry),details['model'],details['resolution']))
                existing.add(prompt_id)
                done += 1
                continue
            if status.get('status_str') != 'success' or not status.get('completed', False):
                continue
            images = _output_images(entry.get('outputs'))
            estimated = _estimated_image_count(entry) if not images else 0
            if not images and not estimated:
                continue
            image_count = len(images) if images else estimated
            verified = int(bool(images))
            finished_ms, duration_ms, source = _execution_times(entry)
            details = _get_prompt_data(entry)
            output_bytes, files_sized = hardware.output_file_sizes(images)
            gpu = hardware.gpu_during(finished_ms-duration_ms,finished_ms) if source=='events' else {}
            db.execute('''INSERT OR IGNORE INTO completed_generations
                (prompt_id, finished_ms, duration_ms, image_count, verified, session_id,
                 images_json, prompts_json, workflow_json, model, resolution, steps, cfg, batch_size, duration_source, queue_wait_ms, seed,
                 output_bytes, output_files_sized, gpu_peak_vram_bytes, gpu_avg_util_pct, gpu_peak_temp_c)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
               (prompt_id, finished_ms, duration_ms, image_count, verified,
                SESSION, json.dumps(images[:64]), json.dumps(details['prompts']),
                details['workflow_json'], details['model'], details['resolution'],
                details['steps'], details['cfg'], details['batch_size'], source, _queue_wait_ms(entry), details['seed'],
                 output_bytes, files_sized, gpu.get('gpu_peak_vram_bytes'), gpu.get('gpu_avg_util_pct'),
                 gpu.get('gpu_peak_temp_c')))
            existing.add(prompt_id)
            done += 1
        if done:
            # Exact workflow is intentionally retained only for the newest 30.
            db.execute('UPDATE completed_generations SET workflow_json=NULL '
               'WHERE workflow_json IS NOT NULL AND prompt_id NOT IN ('
               'SELECT prompt_id FROM completed_generations '
               'ORDER BY finished_ms DESC LIMIT 30)')
        db.commit()
        return done


def _backfill_output_storage(entries):
    """One-time/explicit reconciliation for v1.8 runs whose files still exist."""
    if not isinstance(entries,dict) or not entries:
        return 0
    done=0
    with LOCK, closing(_connect()) as db:
        for prompt_id, entry in list(entries.items())[:1000]:
            if not isinstance(prompt_id,str) or not isinstance(entry,dict): continue
            r=db.execute('SELECT output_bytes FROM completed_generations WHERE prompt_id=?',(prompt_id,)).fetchone()
            if r is None or r['output_bytes'] is not None: continue
            files = _output_images(entry.get('outputs'))
            byte_count, sized=hardware.output_file_sizes(files)
            if sized:
                db.execute('UPDATE completed_generations SET output_bytes=?,output_files_sized=? WHERE prompt_id=?',
                            (byte_count,sized,prompt_id))
                done+=1
        db.commit()
    return done


def _queue_history(limit=500):
    server = PromptServer.instance
    queue = getattr(server, 'prompt_queue', None)
    if queue is None or not callable(getattr(queue, 'get_history', None)):
        raise RuntimeError('ComfyUI prompt queue history is unavailable')
    try:
        result = queue.get_history(max_items=limit)
    except TypeError:
        result = queue.get_history(None, limit)
    return result if isinstance(result, dict) else {}


def _observer():
    retries = 0
    initial_reconciliation = True
    initial_reconciliation_done = False
    next_backup_check = 0
    while True:
        try:
            server = PromptServer.instance
            queue = getattr(server, 'prompt_queue', None)
            if queue is not None and callable(getattr(queue, 'get_history', None)):
                # At startup, recheck more of the current ComfyUI server history;
                # skipped runs from previous versions can now be recovered.
                limit = 500 if initial_reconciliation else 120
                history = _queue_history(limit)
                initial_reconciliation = False
                diagnostics = _diagnose_history(history)
                new = _record_history_entries(history)
                if initial_reconciliation_done is False:
                    _backfill_output_storage(history)
                    initial_reconciliation_done = True
                _OBSERVER_STATUS.update(diagnostics)
                _OBSERVER_STATUS.update(last_poll_ms=int(time.time()*1000),
                                        last_error=None, registered=new, running=True)
                if new:
                    LOG.info('Batch Image Timer: saved %d finalized render(s)', new)
                if new or time.monotonic() >= next_backup_check:
                    _maybe_backup()
                    next_backup_check = time.monotonic() + 600
                retries = 0
        except Exception as exc:
            retries += 1
            _OBSERVER_STATUS.update(last_poll_ms=int(time.time()*1000),
                                    last_error=f'{type(exc).__name__}: {exc}'[:300], running=False)
            if retries in (1, 10, 60) or retries % 300 == 0:
                LOG.exception('Batch Image Timer observer error (will retry)')
        time.sleep(2.0)


def start_observer():
    global OBSERVER_STARTED, _OBSERVER_THREAD
    with LOCK:
        if OBSERVER_STARTED:
            return
        OBSERVER_STARTED = True
    _OBSERVER_THREAD = threading.Thread(name='BatchTimerStatisticsObserver',
                                        target=_observer, daemon=True)
    _OBSERVER_THREAD.start()



def _settings_path():
    return _db_path().parent / 'settings.json'


def _settings():
    global _SETTINGS
    with LOCK:
        if _SETTINGS is None:
            _SETTINGS = dict(DEFAULT_SETTINGS)
            try:
                data = json.loads(_settings_path().read_text(encoding='utf-8'))
                if isinstance(data, dict):
                    _SETTINGS.update(_sanitize_settings(data))
            except (OSError, ValueError):
                pass
        return dict(_SETTINGS)


def _sanitize_settings(values):
    result = {}
    bools = ('show_chart', 'performance_enabled', 'backups_enabled', 'show_failures', 'show_gpu_panel', 'gpu_enabled')
    ranges = {'history_rows': (5, 20), 'gallery_limit': (10, 50),
              'performance_threshold': (10, 100), 'performance_min_samples': (3, 15),
              'backup_retention': (3, 30)}
    for key, value in values.items():
        if key in bools and type(value) is bool:
            result[key] = value
        elif key in ranges and type(value) is int:
            lo, hi = ranges[key]
            result[key] = max(lo, min(hi, value))
    if isinstance(values.get('gpu_device'), str):
        device = values['gpu_device']
        if device in ('auto','all') or (device.isdigit() and 0 <= int(device) <= 15):
            result['gpu_device'] = device
    return result


def _save_settings(values):
    global _SETTINGS
    if not isinstance(values, dict):
        raise ValueError('Expected JSON object')
    with LOCK:
        updated = _settings()
        updated.update(_sanitize_settings(values))
        target = _settings_path()
        tmp = target.with_name('settings.' + uuid.uuid4().hex + '.tmp')
        try:
            tmp.write_text(json.dumps(updated, indent=2), encoding='utf-8')
            tmp.replace(target)
        finally:
            if tmp.exists():
                tmp.unlink()
        _SETTINGS = updated
        hardware.configure_gpu(updated['gpu_enabled'], updated['gpu_device'])
        return dict(updated)


def _backups_dir():
    result = _db_path().parent / 'backups'
    result.mkdir(parents=True, exist_ok=True)
    return result


def _backup_files():
    return sorted(_backups_dir().glob('rendering_statistics_????????_??????.sqlite3'), reverse=True)


def _maybe_backup(force=False):
    if not _settings()['backups_enabled'] and not force:
        return None
    with LOCK:
        existing = _backup_files()
        now = time.time()
        if not force and existing and now - existing[0].stat().st_mtime < 24 * 3600:
            return None
        with closing(_connect()) as db:
            if not db.execute('SELECT 1 FROM completed_generations LIMIT 1').fetchone() and not db.execute('SELECT 1 FROM failed_generations LIMIT 1').fetchone():
                return None
            backups = _backups_dir()
            name = 'rendering_statistics_' + datetime.fromtimestamp(now).strftime('%Y%m%d_%H%M%S') + '.sqlite3'
            dest = backups / name
            # Avoid replacement when two calls happen in one second.
            if dest.exists():
                return None
            tmp = backups / (name + '.tmp')
            try:
                with closing(sqlite3.connect(str(tmp), timeout=15)) as copy:
                    db.backup(copy)
                tmp.replace(dest)
            finally:
                if tmp.exists():
                    tmp.unlink()
        keep = _settings()['backup_retention']
        for extra in _backup_files()[keep:]:
            try:
                extra.unlink()
            except OSError:
                LOG.warning('Could not remove old backup: %s', extra)
        return str(dest)


def _failure_period(db, start=None, end=None, session=False):
    clauses = []; args = []
    if start is not None:
        clauses.append('finished_ms>=?'); args.append(start)
    if end is not None:
        clauses.append('finished_ms<?'); args.append(end)
    if session:
        clauses.append('session_id=?'); args.append(SESSION)
    where = (' WHERE ' + ' AND '.join(clauses)) if clauses else ''
    return dict(db.execute('''SELECT COUNT(*) AS runs,
       COALESCE(SUM(CASE WHEN result='failed' THEN 1 ELSE 0 END),0) AS failed,
       COALESCE(SUM(CASE WHEN result='interrupted' THEN 1 ELSE 0 END),0) AS interrupted,
       COALESCE(SUM(CASE WHEN duration_source='events' THEN duration_ms ELSE 0 END),0) AS lost_ms,
       COALESCE(SUM(CASE WHEN duration_source!='events' THEN 1 ELSE 0 END),0) AS unknown_duration_runs
       FROM failed_generations''' + where, args).fetchone())


def _performance(db):
    settings = _settings()
    latest = db.execute('''SELECT * FROM completed_generations
      WHERE duration_source='events' AND duration_ms>0 AND model IS NOT NULL
      AND model!='Unknown model' AND resolution IS NOT NULL AND resolution!='Unknown'
      ORDER BY finished_ms DESC LIMIT 1''').fetchone()
    if not latest:
        return {'status': 'no_comparable_runs'}
    baseline = db.execute('''SELECT duration_ms FROM completed_generations WHERE prompt_id!=?
      AND model=? AND resolution=? AND steps IS ? AND cfg IS ? AND batch_size IS ?
      AND image_count=? AND duration_source='events' AND duration_ms>0
      AND finished_ms<=? ORDER BY finished_ms DESC LIMIT 20''',
      (latest['prompt_id'], latest['model'], latest['resolution'], latest['steps'], latest['cfg'],
       latest['batch_size'], latest['image_count'], latest['finished_ms'])).fetchall()
    sample = len(baseline)
    needed = settings['performance_min_samples']
    result = {'status': 'insufficient_data' if sample<needed else 'ok',
      'prompt_id': latest['prompt_id'], 'samples': sample, 'min_samples': needed,
      'model': latest['model'], 'resolution': latest['resolution'],
      'steps': latest['steps'], 'image_count': latest['image_count'],
      'duration_ms': latest['duration_ms'], 'threshold': settings['performance_threshold']}
    if sample >= needed:
        median = statistics.median(r['duration_ms'] for r in baseline)
        deviation = 100 * (latest['duration_ms'] / median - 1) if median > 0 else 0
        result.update({'baseline_ms': median, 'delta_percent': round(deviation,1),
           'slower': bool(settings['performance_enabled'] and deviation >= settings['performance_threshold'])})
    return result


def _period(db, start=None, end=None, session=False):
    clauses = []; params = []
    if start is not None:
        clauses.append('finished_ms >= ?'); params.append(start)
    if end is not None:
        clauses.append('finished_ms < ?'); params.append(end)
    if session:
        clauses.append('session_id = ?'); params.append(SESSION)
    condition = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
    row = db.execute('''SELECT COUNT(*) runs, COALESCE(SUM(image_count),0) images,
        COALESCE(SUM(duration_ms),0) duration_ms,
        COALESCE(SUM(CASE WHEN verified=0 THEN image_count ELSE 0 END),0) estimated_images,
        COALESCE(SUM(CASE WHEN verified=0 THEN 1 ELSE 0 END),0) estimated_runs,
        COALESCE(SUM(CASE WHEN duration_source='unavailable' THEN 1 ELSE 0 END),0) unknown_duration_runs
        FROM completed_generations''' + condition, params).fetchone()
    return dict(row)


def _time_param(q, name, optional=False):
    raw = q.get(name)
    if raw is None:
        if optional:
            return None
        raise ValueError(f'Missing {name}')
    number = int(raw)
    if number < 0 or number > 9999999999999:
        raise ValueError(f'Invalid {name}')
    return number


def _summary_ranges(q):
    now = int(time.time() * 1000)
    names = ('today', 'last7', 'last30', 'this_week', 'last_week', 'this_month', 'last_month')
    starts = {n: _time_param(q, n) for n in names}
    ranges = {n: (value, now) for n, value in starts.items()}
    ranges['last_week'] = (starts['last_week'], starts['this_week'])
    ranges['last_month'] = (starts['last_month'], starts['this_month'])
    return ranges


def _item(row, detail=False):
    result = {key: row[key] for key in ('prompt_id','finished_ms','duration_ms','image_count','verified',
              'model','resolution','steps','cfg','batch_size','duration_source','queue_wait_ms','seed',
              'output_bytes','output_files_sized','gpu_peak_vram_bytes','gpu_avg_util_pct','gpu_peak_temp_c')}
    result['images'] = json.loads(row['images_json'] or '[]')
    result['prompts'] = json.loads(row['prompts_json'] or '[]')
    if detail:
        result['workflow'] = json.loads(row['workflow_json']) if row['workflow_json'] else None
    return result


@PromptServer.instance.routes.get('/batch_timer/stats/health')
async def health(request):
    try:
        with closing(_connect()) as db:
            n = db.execute('SELECT COUNT(*) FROM completed_generations').fetchone()[0]
        return web.json_response({'ok': True, 'version': VERSION, 'database': 'ready',
           'records': n, 'database_path': str(_db_path()), 'warning': DB_WARNING,
           'backup_directory': str(_db_path().parent / 'backups'),
           'observer': 'active' if _OBSERVER_STATUS['running'] and _OBSERVER_THREAD and _OBSERVER_THREAD.is_alive() else 'inactive',
           'last_scan_ms': _OBSERVER_STATUS['last_poll_ms'],
           'observer_error': _OBSERVER_STATUS['last_error']})
    except Exception as exc:
        LOG.exception('Statistics health error')
        return web.json_response({'ok': False, 'error': str(exc)}, status=500)


@PromptServer.instance.routes.get('/batch_timer/stats/diagnostics')
async def diagnostics(request):
    """Privacy-friendly counters only; never returns prompts or file names."""
    with closing(_connect()) as db:
        totals = _period(db)
        estimated = db.execute('SELECT COUNT(*) FROM completed_generations WHERE verified=0').fetchone()[0]
    return web.json_response({'ok': True, 'version': VERSION,
           'observer_alive': bool(_OBSERVER_THREAD and _OBSERVER_THREAD.is_alive()),
           'observer': dict(_OBSERVER_STATUS), 'stored_runs': totals['runs'],
           'stored_images': totals['images'], 'estimated_runs': estimated,
           'database_path': str(_db_path())})


@PromptServer.instance.routes.get('/batch_timer/stats/summary')
async def summary(request):
    try:
        ranges = _summary_ranges(request.query)
        with closing(_connect()) as db:
            periods = {'session': _period(db, session=True)}
            periods.update({key: _period(db, *times) for key, times in ranges.items()})
            failures = {'session': _failure_period(db, session=True)}
            failures.update({key: _failure_period(db,*times) for key,times in ranges.items()})
            performance = _performance(db)
        return web.json_response({'ok': True, 'periods': periods, 'failures': failures,
                                  'performance': performance, 'session_id': SESSION,
                                  'stored_at': str(_db_path()), 'warning': DB_WARNING})
    except (ValueError, TypeError) as exc:
        return web.json_response({'ok': False, 'error': str(exc)}, status=400)
    except Exception:
        LOG.exception('Summary error')
        return web.json_response({'ok': False, 'error': 'database_unavailable'}, status=500)


@PromptServer.instance.routes.get('/batch_timer/stats/recent')
async def recent(request):
    try:
        limit = max(1, min(50, int(request.query.get('limit', '20'))))
        with closing(_connect()) as db:
            rows = db.execute('''SELECT * FROM completed_generations WHERE hidden_recent=0
                ORDER BY finished_ms DESC, prompt_id DESC LIMIT ?''', (limit,)).fetchall()
        return web.json_response({'ok': True, 'entries': [_item(row) for row in rows]})
    except Exception:
        LOG.exception('Recent records error')
        return web.json_response({'ok': False, 'error': 'unable_to_load'}, status=500)


@PromptServer.instance.routes.get('/batch_timer/stats/detail/{prompt_id}')
async def detail(request):
    prompt_id = request.match_info['prompt_id']
    with closing(_connect()) as db:
        row = db.execute('SELECT * FROM completed_generations WHERE prompt_id=?', (prompt_id,)).fetchone()
    return web.json_response({'ok': bool(row), 'record': _item(row, True) if row else None}, status=200 if row else 404)


@PromptServer.instance.routes.post('/batch_timer/stats/clear_recent')
async def clear_recent(request):
    # Preserve historical statistics, hide rows from the recent preview only.
    with LOCK, closing(_connect()) as db, db:
        db.execute('UPDATE completed_generations SET hidden_recent=1')
    return web.json_response({'ok': True})


@PromptServer.instance.routes.get('/batch_timer/stats/day')
async def day(request):
    try:
        start = _time_param(request.query, 'start_ms')
        end = _time_param(request.query, 'end_ms')
        if end <= start or end - start > 32 * 86400 * 1000:
            raise ValueError('Invalid range')
        with closing(_connect()) as db:
            totals = _period(db, start, end)
            runs = [_item(r) for r in db.execute('''SELECT * FROM completed_generations
                WHERE finished_ms>=? AND finished_ms<? ORDER BY finished_ms DESC LIMIT 100''',(start,end)).fetchall()]
        return web.json_response({'ok': True, 'summary': totals, 'entries': runs})
    except (ValueError, TypeError) as exc:
        return web.json_response({'ok':False,'error':str(exc)},status=400)


@PromptServer.instance.routes.get('/batch_timer/stats/models')
async def models(request):
    with closing(_connect()) as db:
        rows = db.execute('''SELECT COALESCE(model,'Unknown model') model,
            COALESCE(resolution,'Unknown') resolution, COUNT(*) runs,
            SUM(image_count) images, SUM(duration_ms) duration_ms
            FROM completed_generations
            GROUP BY model, resolution ORDER BY runs DESC LIMIT 20''').fetchall()
    return web.json_response({'ok': True, 'models': [dict(r) for r in rows]})


@PromptServer.instance.routes.get('/batch_timer/stats/export.csv')
async def export_csv(request):
    try:
        start = _time_param(request.query, 'start_ms', optional=True)
        end = _time_param(request.query, 'end_ms', optional=True)
        if start is not None and end is not None and end <= start:
            raise ValueError('Invalid range')
        conditions = []; args = []
        if start is not None:
            conditions.append('finished_ms>=?'); args.append(start)
        if end is not None:
            conditions.append('finished_ms<?'); args.append(end)
        where = ' WHERE ' + ' AND '.join(conditions) if conditions else ''
        out = io.StringIO(); writer = csv.writer(out)
        writer.writerow(['date','prompt_id','image_count','duration_seconds','avg_seconds_per_image',
                         'model','resolution','steps','cfg','batch_size','time_source',
                         'output_bytes','output_files_sized','gpu_peak_vram_bytes','gpu_avg_util_pct','gpu_peak_temp_c'])
        with closing(_connect()) as db:
            for r in db.execute('''SELECT * FROM completed_generations''' + where + ' ORDER BY finished_ms DESC',args):
                duration = r['duration_ms']/1000
                writer.writerow([datetime.fromtimestamp(r['finished_ms']/1000).astimezone().isoformat(),
                    r['prompt_id'], r['image_count'], f'{duration:.3f}',
                    f'{duration/max(1,r["image_count"]):.3f}', r['model'], r['resolution'],
                    r['steps'], r['cfg'], r['batch_size'], r['duration_source'],
                    r['output_bytes'],r['output_files_sized'],r['gpu_peak_vram_bytes'],r['gpu_avg_util_pct'],r['gpu_peak_temp_c']])
        return web.Response(text='\ufeff'+out.getvalue(), content_type='text/csv', charset='utf-8',
                 headers={'Content-Disposition':'attachment; filename="batch-timer-statistics.csv"'})
    except (ValueError,TypeError) as exc:
        return web.json_response({'ok':False,'error':str(exc)},status=400)


@PromptServer.instance.routes.get('/batch_timer/stats/settings')
async def get_settings(request):
    return web.json_response({'ok': True, 'settings': _settings()})


@PromptServer.instance.routes.post('/batch_timer/stats/settings')
async def set_settings(request):
    try:
        payload = await request.json()
        return web.json_response({'ok': True, 'settings': _save_settings(payload)})
    except (ValueError, TypeError) as exc:
        return web.json_response({'ok': False, 'error': str(exc)}, status=400)
    except OSError:
        LOG.exception('Settings write failed')
        return web.json_response({'ok': False, 'error': 'Settings folder is read-only'}, status=500)


@PromptServer.instance.routes.get('/batch_timer/stats/failures')
async def get_failures(request):
    limit = max(1, min(50, int(request.query.get('limit', '20'))))
    with closing(_connect()) as db:
        rows = db.execute('''SELECT * FROM failed_generations ORDER BY finished_ms DESC
            LIMIT ?''', (limit,)).fetchall()
    return web.json_response({'ok': True, 'entries': [dict(row) for row in rows]})


@PromptServer.instance.routes.get('/batch_timer/stats/backups')
async def get_backups(request):
    paths = _backup_files()
    return web.json_response({'ok': True, 'directory': str(_backups_dir()),
         'files': [{'name': p.name, 'size_bytes': p.stat().st_size,
                     'created_ms': int(p.stat().st_mtime*1000)} for p in paths]})


@PromptServer.instance.routes.post('/batch_timer/stats/backup_now')
async def backup_now(request):
    try:
        path = _maybe_backup(force=True)
        return web.json_response({'ok': True, 'created': bool(path), 'path': path,
                                  'message': None if path else 'No records or duplicate backup timestamp'})
    except Exception:
        LOG.exception('Backup failed')
        return web.json_response({'ok': False, 'error': 'Backup creation failed'}, status=500)


@PromptServer.instance.routes.get('/batch_timer/stats/failures.csv')
async def failures_csv(request):
    out = io.StringIO(); writer = csv.writer(out)
    writer.writerow(['date', 'prompt_id', 'result', 'duration_seconds', 'duration_source',
                     'model', 'resolution', 'error_text'])
    with closing(_connect()) as db:
        for row in db.execute('SELECT * FROM failed_generations ORDER BY finished_ms DESC'):
            writer.writerow([datetime.fromtimestamp(row['finished_ms']/1000).astimezone().isoformat(),
                row['prompt_id'],row['result'],f"{row['duration_ms']/1000:.3f}",
                row['duration_source'],row['model'],row['resolution'],row['error_text']])
    return web.Response(text='\ufeff'+out.getvalue(), content_type='text/csv',charset='utf-8',
        headers={'Content-Disposition':'attachment; filename="batch-timer-failures.csv"'})


# Start only once, daemonized; the observer never modifies ComfyUI internals.
start_observer()


# -----------------------------------------------------------------------------
# v1.8: non-destructive reconciliation, independent performance, calendar,
# and transactional recovery of local SQLite backups.
# -----------------------------------------------------------------------------
@PromptServer.instance.routes.post('/batch_timer/stats/recheck')
async def recheck_statistics(request):
    try:
        history = _queue_history(1000)
        before = None
        with closing(_connect()) as db:
            before = _period(db)
        added = 0
        # Chunk the work so older SQLite builds never exceed their binding cap.
        for index in range(0, len(history), 300):
            chunk = dict(list(history.items())[index:index+300])
            added += _record_history_entries(chunk)
        with closing(_connect()) as db:
            after = _period(db)
        return web.json_response({'ok':True,'scanned':len(history),'new_runs':added,
            'images_added':after['images']-before['images'],
            'images_total':after['images'], 'estimated_images_total':after['estimated_images'],
            'message':'Only executions still present in ComfyUI server history can be recovered.'})
    except Exception as exc:
        LOG.exception('Manual reconciliation failed')
        return web.json_response({'ok':False,'error':str(exc)[:200]},status=500)


@PromptServer.instance.routes.get('/batch_timer/stats/performance_runs')
async def performance_runs(request):
    try:
        limit = max(1,min(50,int(request.query.get('limit','12'))))
        with closing(_connect()) as db:
            rows = db.execute('''SELECT * FROM completed_generations
                WHERE duration_ms>0 ORDER BY finished_ms DESC, prompt_id DESC LIMIT ?''',
                (limit,)).fetchall()
        return web.json_response({'ok':True,'entries':[_item(r) for r in rows]})
    except (ValueError,TypeError) as exc:
        return web.json_response({'ok':False,'error':str(exc)},status=400)


@PromptServer.instance.routes.get('/batch_timer/stats/calendar')
async def calendar_statistics(request):
    try:
        start = _time_param(request.query,'start_ms')
        end = _time_param(request.query,'end_ms')
        offset = int(request.query.get('offset_minutes', '0'))
        if end<=start or end-start>32*86400000 or not -840 <= offset <= 840:
            raise ValueError('Invalid calendar range or timezone offset')
        with closing(_connect()) as db:
            rows = db.execute('''SELECT date((finished_ms+?)/1000,'unixepoch') AS day,
                COUNT(*) AS runs, SUM(image_count) AS images, SUM(duration_ms) AS duration_ms,
                SUM(CASE WHEN verified=0 THEN image_count ELSE 0 END) AS estimated_images
                FROM completed_generations WHERE finished_ms>=? AND finished_ms<?
                GROUP BY day ORDER BY day''', (offset*60000,start,end)).fetchall()
        return web.json_response({'ok':True,'days':[dict(r) for r in rows],
            'note':'Day grouping uses the browser timezone offset at the chosen month; DST transitions may differ by one hour.'})
    except (ValueError,TypeError) as exc:
        return web.json_response({'ok':False,'error':str(exc)},status=400)


def _safe_backup_name(name):
    # Only allow files created by our local backup mechanism.
    return bool(isinstance(name,str) and re.fullmatch(
        r'(?:rendering_statistics|pre_restore|pre_import)_\d{8}_\d{6}(?:_[a-f0-9]{6})?\.sqlite3',name))


def _backups_for_restore():
    folder=_backups_dir()
    return sorted([f for f in folder.iterdir() if f.is_file() and _safe_backup_name(f.name)],
                  key=lambda p:p.stat().st_mtime,reverse=True)


@PromptServer.instance.routes.get('/batch_timer/stats/restore_candidates')
async def restore_candidates(request):
    return web.json_response({'ok':True,'files':[{'name':p.name,'bytes':p.stat().st_size,
        'modified_ms':int(p.stat().st_mtime*1000)} for p in _backups_for_restore()]})


@PromptServer.instance.routes.post('/batch_timer/stats/restore')
async def restore_backup(request):
    try:
        payload=await request.json()
        name=payload.get('filename') if isinstance(payload,dict) else None
        if not isinstance(payload,dict) or payload.get('confirm') is not True or not _safe_backup_name(name):
            return web.json_response({'ok':False,'error':'Explicit confirmation and valid backup filename required'},status=400)
        available={p.name:p for p in _backups_for_restore()}
        source_file=available.get(name)
        if source_file is None:
            return web.json_response({'ok':False,'error':'Backup not found in plugin backup folder'},status=404)
        with LOCK:
            with closing(sqlite3.connect(source_file.resolve().as_uri()+'?mode=ro',uri=True,timeout=8)) as archive:
                check=archive.execute('PRAGMA quick_check').fetchone()
                if not check or check[0]!='ok':
                    raise ValueError('Backup integrity check failed')
                tables={r[0] for r in archive.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if not {'completed_generations','failed_generations'}.issubset(tables):
                    raise ValueError('Backup schema is not compatible with v1.8')
                schema={r[1] for r in archive.execute('PRAGMA table_info(completed_generations)')}
                required={'prompt_id','finished_ms','duration_ms','image_count','verified',
                          'session_id','images_json','prompts_json','workflow_json','model',
                          'resolution','hidden_recent','duration_source','steps','cfg','batch_size',
                          'queue_wait_ms','seed'}
                if not required.issubset(schema):
                    # v1.6-v1.7 backups have no queue_wait_ms. Add it after restore.
                    if required-{'queue_wait_ms','seed'} - schema:
                        raise ValueError('Backup missing required columns')
                with closing(_connect()) as live:
                    safeguard=_backups_dir()/('pre_restore_'+datetime.now().strftime('%Y%m%d_%H%M%S')+'_'+uuid.uuid4().hex[:6]+'.sqlite3')
                    with closing(sqlite3.connect(str(safeguard),timeout=15)) as safety:
                        live.backup(safety)
                    try:
                        archive.backup(live)
                        if 'queue_wait_ms' not in schema:
                            live.execute('ALTER TABLE completed_generations ADD COLUMN queue_wait_ms INTEGER')
                        if 'seed' not in schema:
                            live.execute('ALTER TABLE completed_generations ADD COLUMN seed TEXT')
                        for name, typ in [('output_bytes','INTEGER'),('output_files_sized','INTEGER'),
                                          ('gpu_peak_vram_bytes','INTEGER'),('gpu_avg_util_pct','REAL'),
                                          ('gpu_peak_temp_c','REAL')]:
                            if name not in schema:
                                live.execute(f'ALTER TABLE completed_generations ADD COLUMN {name} {typ}')
                        live.commit()
                    except Exception:
                        with closing(sqlite3.connect(str(safeguard),timeout=15)) as safety:
                            safety.backup(live)
                        raise
        return web.json_response({'ok':True,'restored':name,'safety_backup':safeguard.name,
            'warning':'The observer may re-import newer runs still available in ComfyUI history.'})
    except (ValueError,TypeError) as exc:
        return web.json_response({'ok':False,'error':str(exc)[:300]},status=400)
    except Exception as exc:
        LOG.exception('Backup restore failed')
        return web.json_response({'ok':False,'error':f'Restore failed: {type(exc).__name__}'},status=500)


# V1.9 — hardware and output storage. These endpoints never scan arbitrary paths.
@PromptServer.instance.routes.get('/batch_timer/gpu/live')
async def gpu_live(request):
    return web.json_response({'ok':True, 'gpu':hardware.live_gpu(), 'configuration':hardware.gpu_config()})


@PromptServer.instance.routes.get('/batch_timer/gpu/devices')
async def gpu_devices(request):
    devices = await asyncio.to_thread(hardware.list_gpus)
    return web.json_response({'ok':True, 'devices':devices, 'configuration':hardware.gpu_config()})


def _storage_period(db,start=None,end=None,session=False):
    conditions=[];args=[]
    if start is not None:conditions.append('finished_ms>=?');args.append(start)
    if end is not None:conditions.append('finished_ms<?');args.append(end)
    if session:conditions.append('session_id=?');args.append(SESSION)
    where=' WHERE '+' AND '.join(conditions) if conditions else ''
    return dict(db.execute('''SELECT COUNT(*) AS runs,
      COALESCE(SUM(image_count),0) AS images,
      COALESCE(SUM(output_bytes),0) AS bytes,
      COALESCE(SUM(output_files_sized),0) AS measured_files,
      SUM(CASE WHEN output_bytes IS NULL THEN 1 ELSE 0 END) AS unknown_size_runs
      FROM completed_generations'''+where,args).fetchone())


@PromptServer.instance.routes.get('/batch_timer/storage/summary')
async def storage_summary(request):
    try:
        ranges=_summary_ranges(request.query)
        with closing(_connect()) as db:
            periods={'session':_storage_period(db,session=True),'all_time':_storage_period(db)}
            periods.update({key:_storage_period(db,*dates) for key,dates in ranges.items()})
        return web.json_response({'ok':True,'periods':periods,'last_folder_scan':hardware.last_folder_scan(),
          'note':'Stored output bytes are measured at generation time. Missing/deleted files and estimated image counts have unknown sizes.'})
    except (ValueError,TypeError) as exc:
        return web.json_response({'ok':False,'error':str(exc)},status=400)
    except Exception as exc:
        LOG.exception('Storage summary error')
        return web.json_response({'ok':False,'error':type(exc).__name__},status=500)


@PromptServer.instance.routes.post('/batch_timer/storage/scan')
async def storage_scan(request):
    try:
        result=await asyncio.to_thread(hardware.scan_output_folder)
        return web.json_response(result,status=200 if result.get('ok') else 409)
    except Exception as exc:
        LOG.exception('Output folder scan error')
        return web.json_response({'ok':False,'error':type(exc).__name__},status=500)


# v1.9.3 — System status, portable export/import. All actions operate on the
# local ComfyUI server. No generated image bytes are included in archives.
def _system_health():
    result = {'version': VERSION, 'database': {}, 'observer': {}, 'output': {}, 'gpu': {}, 'files': {}}
    try:
        with closing(_connect()) as db:
            row = db.execute('PRAGMA quick_check').fetchone()
            latest = db.execute('SELECT MAX(finished_ms) FROM completed_generations').fetchone()[0]
            result['database'] = {'ok': bool(row and row[0] == 'ok'),
                                  'integrity': row[0] if row else 'unknown',
                                  'last_generation_ms': latest,
                                  'records': db.execute('SELECT COUNT(*) FROM completed_generations').fetchone()[0]}
        probe = _db_path().parent / ('health_probe_' + uuid.uuid4().hex + '.tmp')
        try:
            probe.write_bytes(b'test')
            result['database']['writable'] = True
        finally:
            if probe.exists(): probe.unlink()
    except Exception as exc:
        result['database'] = {'ok': False, 'error': str(exc)[:150]}
    now = int(time.time()*1000)
    last_poll = _OBSERVER_STATUS.get('last_poll_ms')
    alive = bool(_OBSERVER_THREAD and _OBSERVER_THREAD.is_alive())
    result['observer'] = {'ok': bool(alive and _OBSERVER_STATUS.get('running') and
                                   last_poll and now-last_poll < 60000 and not _OBSERVER_STATUS.get('last_error')),
                          'alive': alive, 'last_poll_ms': last_poll,
                          'last_error': _OBSERVER_STATUS.get('last_error')}
    try:
        root = hardware._output_dir()
        result['output'] = {'ok': root.is_dir(), 'writable': os.access(root, os.W_OK)}
    except Exception as exc:
        result['output'] = {'ok': False, 'error': str(exc)[:150]}
    config = hardware.gpu_config()
    live = hardware.live_gpu()
    result['gpu'] = {'enabled': config['enabled'], 'device': config['device'],
                     'available': bool(live.get('available')), 'reason': live.get('reason')}
    required = ['timer_statistics.py','timer_hardware.py','batch_image_timer.py',
                'web/batch_timer_extras.js','web/batch_timer_history.js','web/batch_timer_hardware.js']
    missing = [x for x in required if not (PLUGIN_DIR / x).is_file()]
    result['files'] = {'ok': not missing, 'missing': missing}
    result['ok'] = all([result['database'].get('ok'), result['database'].get('writable'),
                        result['observer']['ok'], result['output']['ok'], result['files']['ok']])
    return result


@PromptServer.instance.routes.get('/batch_timer/stats/system_check')
async def system_check(request):
    try:
        # File system / SQLite work outside aiohttp request event loop.
        return web.json_response(await asyncio.to_thread(_system_health))
    except Exception as exc:
        LOG.exception('System check failed')
        return web.json_response({'ok': False, 'error': str(exc)[:150]}, status=500)


def _export_data_bundle():
    # Snapshot via SQLite backup API — safe even when the observer is writing.
    with LOCK:
        with closing(_connect()) as db:
            with tempfile.TemporaryDirectory(prefix='batch_timer_export_') as tmp:
                snap = Path(tmp)/'rendering_statistics.sqlite3'
                with closing(sqlite3.connect(str(snap), timeout=15)) as target:
                    db.backup(target)
                size = snap.stat().st_size
                if size > 128*1024*1024:
                    raise ValueError('Database larger than 128 MB. Please use manual backup.')
                memory = io.BytesIO()
                with zipfile.ZipFile(memory,'w',compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                    archive.write(snap,arcname='rendering_statistics.sqlite3')
                    archive.writestr('settings.json', json.dumps(_settings(),ensure_ascii=False,indent=2))
                    archive.writestr('manifest.json',json.dumps({'plugin':'ComfyUI-Batch-Image-Timer',
                         'version':VERSION,'exported_at':datetime.now().isoformat(),
                         'note':'Statistics and settings only; generated image files are not included.'}))
                return memory.getvalue()


@PromptServer.instance.routes.get('/batch_timer/stats/export_bundle')
async def export_bundle(request):
    try:
        contents = await asyncio.to_thread(_export_data_bundle)
        name = 'batch_timer_data_'+datetime.now().strftime('%Y%m%d_%H%M%S')+'.zip'
        return web.Response(body=contents,content_type='application/zip',
            headers={'Content-Disposition':f'attachment; filename="{name}"', 'Cache-Control':'no-store'})
    except Exception as exc:
        LOG.exception('Export failed')
        return web.json_response({'ok': False, 'error':str(exc)[:180]},status=500)


def _verify_import_bundle(contents):
    with zipfile.ZipFile(io.BytesIO(contents), 'r') as archive:
        filenames = [x.filename for x in archive.infolist()]
        names = set(filenames)
        if len(filenames) != len(names):
            raise ValueError('Archive contains duplicate member names')
        if names != {'rendering_statistics.sqlite3','settings.json','manifest.json'}:
            raise ValueError('Invalid data archive: unexpected or missing members')
        entries = archive.infolist()
        if any(x.file_size>128*1024*1024 or x.compress_size>128*1024*1024 for x in entries):
            raise ValueError('File in archive exceeds limit')
        if sum(x.file_size for x in entries)>130*1024*1024:
            raise ValueError('Expanded archive exceeds limit')
        manifest = json.loads(archive.read('manifest.json'))
        if not isinstance(manifest,dict) or manifest.get('plugin')!='ComfyUI-Batch-Image-Timer':
            raise ValueError('Not a Batch Image Timer archive')
        settings = json.loads(archive.read('settings.json'))
        if not isinstance(settings,dict): raise ValueError('Invalid settings')
        # ZipFile.read performs CRC validation. Max expanded bytes checked above.
        data = archive.read('rendering_statistics.sqlite3')
    if not data.startswith(b'SQLite format 3\x00'):
        raise ValueError('Invalid SQLite file')
    return data, _sanitize_settings(settings)


def _import_bundle(contents):
    global _SETTINGS
    data, settings = _verify_import_bundle(contents)
    with tempfile.TemporaryDirectory(prefix='batch_timer_import_') as tmp:
        candidate = Path(tmp)/'import.sqlite3'
        candidate.write_bytes(data)
        with closing(sqlite3.connect(candidate.resolve().as_uri()+'?mode=ro', uri=True, timeout=10)) as source:
            check = source.execute('PRAGMA quick_check').fetchone()
            if not check or check[0]!='ok': raise ValueError('Imported database integrity check failed')
            objects = source.execute("SELECT type,name FROM sqlite_master WHERE type IN ('trigger','view')").fetchall()
            if objects: raise ValueError('Database contains unsupported triggers/views')
            required_tables = {'completed_generations','failed_generations'}
            existing = {r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not required_tables.issubset(existing): raise ValueError('Incompatible database schema')
            required_columns = {'prompt_id','finished_ms','duration_ms','image_count','verified','session_id',
                        'images_json','prompts_json','workflow_json','model','resolution','hidden_recent',
                        'duration_source','steps','cfg','batch_size','queue_wait_ms','seed','output_bytes',
                        'output_files_sized','gpu_peak_vram_bytes','gpu_avg_util_pct','gpu_peak_temp_c'}
            existing_columns = {r[1] for r in source.execute('PRAGMA table_info(completed_generations)')}
            if not required_columns.issubset(existing_columns):
                raise ValueError('Archive uses an older unsupported schema; update source plugin before exporting')
            with LOCK:
                with closing(_connect()) as live:
                    safety = _backups_dir()/('pre_import_'+datetime.now().strftime('%Y%m%d_%H%M%S')+'_'+uuid.uuid4().hex[:6]+'.sqlite3')
                    with closing(sqlite3.connect(str(safety),timeout=15)) as safe_db:
                        live.backup(safe_db)
                    previous_settings = _settings()
                    try:
                        source.backup(live)
                        live.commit()
                        updated = dict(previous_settings)
                        updated.update(settings)
                        _save_settings(updated)
                    except Exception:
                        with closing(sqlite3.connect(str(safety),timeout=15)) as safe_db:
                            safe_db.backup(live)
                        _save_settings(previous_settings)
                        raise
    return {'ok':True, 'safety_backup': safety.name, 'settings': _settings(),
            'message':'Import complete. Older runs still in ComfyUI history can be re-imported by observer.'}


@PromptServer.instance.routes.post('/batch_timer/stats/import_bundle')
async def import_bundle(request):
    try:
        if request.headers.get('X-Batch-Timer-Confirm') != 'RESTORE':
            raise ValueError('Explicit import confirmation required')
        if request.content_length is not None and request.content_length>64*1024*1024:
            raise ValueError('Archive exceeds 64 MB upload limit')
        reader = await request.multipart()
        part = await reader.next()
        if part is None or part.name != 'archive':
            raise ValueError('Missing archive upload')
        raw = bytearray()
        while True:
            chunk = await part.read_chunk(size=65536)
            if not chunk: break
            raw.extend(chunk)
            if len(raw)>64*1024*1024:
                raise ValueError('Archive exceeds 64 MB upload limit')
        result = await asyncio.to_thread(_import_bundle, bytes(raw))
        return web.json_response(result)
    except (ValueError, TypeError, zipfile.BadZipFile, json.JSONDecodeError, sqlite3.DatabaseError) as exc:
        return web.json_response({'ok':False,'error':str(exc)[:250]},status=400)
    except Exception as exc:
        LOG.exception('Data import failed')
        return web.json_response({'ok':False,'error':type(exc).__name__},status=500)
