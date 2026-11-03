"""Copyright (c) 2026 Piotr Karwowski — Extended modifications.
Batch Image Timer v1.9: low-impact server-side GPU and output-file measurements.

- NVIDIA telemetry is optional: NVML if installed, otherwise nvidia-smi.
- Never touches torch's CUDA context or executes work on the GPU.
- Missing metrics remain missing (not zero); NVIDIA values describe the whole device.
- On-demand output-folder scanning is capped by count and elapsed time.
"""
from collections import deque
from pathlib import Path
import logging
import os
import shutil
import subprocess
import threading
import time

LOG = logging.getLogger('BatchImageTimer.Hardware')
SAMPLE_INTERVAL_S = 4.0
SAMPLES = deque(maxlen=3600)
_LOCK = threading.RLock()
_RUNNING = False
_THREAD = None
_LAST = {'available': False, 'source': 'unavailable', 'reason': 'Not sampled yet'}
_SCAN_LOCK = threading.Lock()
_SCAN_CACHE = None
_NVML_MODULE = None
_NVML_HANDLE = None
IMAGE_EXTS = {'.png','.jpg','.jpeg','.webp','.tif','.tiff','.bmp','.avif'}


def _output_dir():
    import folder_paths
    return Path(folder_paths.get_output_directory()).resolve()


def output_file_sizes(images):
    """Return bytes and measured-file count; unknown values stay NULL.

    Never trust filename/subfolder from workflow metadata as arbitrary paths.
    This also avoids following symlinks out of ComfyUI's output directory.
    """
    root = _output_dir()
    total = count = 0
    seen = set()
    for info in (images or [])[:2048]:
        if not isinstance(info, dict) or str(info.get('type','output')) != 'output':
            continue
        name = info.get('filename')
        sub = info.get('subfolder') or ''
        if not isinstance(name, str) or not isinstance(sub, str) or not name or len(name)>512 or len(sub)>512:
            continue
        if Path(name).suffix.lower() not in IMAGE_EXTS or Path(name).name != name:
            continue
        if Path(sub).is_absolute() or Path(name).is_absolute():
            continue
        try:
            target = (root/sub/name).resolve()
            if not target.is_relative_to(root) or target in seen or not target.is_file():
                continue
            seen.add(target)
            size = target.stat().st_size
            count += 1
            total += size
        except (OSError, ValueError, RuntimeError):
            continue
    return (total if count else None), count


# GPU sampling is independent of panel visibility. Device selection may be changed
# at runtime without restarting ComfyUI; no torch/CUDA calls are performed here.
_ENABLED = True
_SELECTED = 'auto'   # auto, all, 0..15
_WAKE = threading.Event()


def configure_gpu(enabled=True, device='auto'):
    global _ENABLED, _SELECTED, _LAST
    device = str(device)
    if device not in ('auto', 'all') and not (device.isdigit() and 0 <= int(device) <= 15):
        device = 'auto'
    with _LOCK:
        changed = device != _SELECTED
        _ENABLED = bool(enabled)
        _SELECTED = device
        if changed:
            SAMPLES.clear()  # Never mix measurements from different GPU selections.
        if not _ENABLED:
            _LAST = {'available': False, 'disabled': True, 'source': 'disabled',
                     'reason': 'GPU monitoring disabled in Settings'}
        elif changed or _LAST.get('disabled'):
            _LAST = {'available': False, 'source': 'starting', 'reason': 'Waiting for first sample'}
    _WAKE.set()


def gpu_config():
    with _LOCK:
        return {'enabled': _ENABLED, 'device': _SELECTED}


def _gpu_index():
    visible = os.environ.get('CUDA_VISIBLE_DEVICES', '').split(',')[0].strip()
    return int(visible) if visible.isdigit() else 0


def _target_indices(count, selected):
    if selected == 'all':
        return list(range(count))
    target = _gpu_index() if selected == 'auto' else int(selected)
    if target < 0 or target >= count:
        raise ValueError(f'GPU {target} not found; {count} NVIDIA GPU(s) available')
    return [target]


def _nvml_init():
    global _NVML_MODULE
    if _NVML_MODULE is None:
        import pynvml
        pynvml.nvmlInit()
        _NVML_MODULE = pynvml
    return _NVML_MODULE


def _nvml_details(index):
    nvml = _nvml_init()
    handle = nvml.nvmlDeviceGetHandleByIndex(index)
    mem = nvml.nvmlDeviceGetMemoryInfo(handle)
    util = nvml.nvmlDeviceGetUtilizationRates(handle)
    try:
        temp = nvml.nvmlDeviceGetTemperature(handle, nvml.NVML_TEMPERATURE_GPU)
    except Exception:
        temp = None
    name = nvml.nvmlDeviceGetName(handle)
    if isinstance(name, bytes): name = name.decode('utf-8', errors='replace')
    return {'index': index, 'available': True, 'name': str(name)[:100],
            'source': 'nvml', 'gpu_util_pct': int(util.gpu),
            'temp_c': int(temp) if temp is not None else None,
            'vram_used_bytes': int(mem.used), 'vram_total_bytes': int(mem.total)}


def _sample_nvml(selected):
    count = _nvml_init().nvmlDeviceGetCount()
    devices = [_nvml_details(i) for i in _target_indices(count, selected)]
    return _combine_devices(devices, selected)


def _find_nvidia_smi():
    options = [shutil.which('nvidia-smi')]
    if os.name == 'nt':
        options += [r'C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe']
    return next((p for p in options if p and Path(p).is_file()), None)


def _smi_rows(path):
    cmd = [str(path), '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
           '--format=csv,noheader,nounits']
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3.0,
                          check=False, stdin=subprocess.DEVNULL,
                          creationflags=(0x08000000 if os.name == 'nt' else 0))
    if proc.returncode:
        raise RuntimeError((proc.stderr or proc.stdout or 'nvidia-smi failed').strip()[:140])
    def number(v):
        try: return float(v)
        except (TypeError, ValueError): return None
    devices = []
    for row in proc.stdout.strip().splitlines():
        parts = [x.strip() for x in row.split(',')]
        if len(parts) != 6: continue
        idx = number(parts[0]); used = number(parts[3]); total = number(parts[4])
        if idx is None: continue
        devices.append({'index': int(idx), 'available': True, 'source': 'nvidia-smi',
                        'name': parts[1][:100], 'gpu_util_pct': number(parts[2]),
                        'vram_used_bytes': int(used*1048576) if used is not None else None,
                        'vram_total_bytes': int(total*1048576) if total is not None else None,
                        'temp_c': number(parts[5])})
    if not devices:
        raise ValueError('Unexpected nvidia-smi output')
    return devices


def _combine_devices(devices, selected):
    if selected != 'all':
        result = dict(devices[0]); result['devices'] = devices
        return result
    # ALL presents each card separately. VRAM totals are summed only for display,
    # not described as memory available on a single device.
    used = [d.get('vram_used_bytes') for d in devices]
    total = [d.get('vram_total_bytes') for d in devices]
    return {'available': bool(devices), 'source': devices[0].get('source') if devices else '',
            'name': f'All GPUs ({len(devices)})', 'devices': devices, 'selection': 'all',
            'gpu_util_pct': None, 'temp_c': None,
            'vram_used_bytes': sum(used) if all(isinstance(x, (int,float)) for x in used) else None,
            'vram_total_bytes': sum(total) if all(isinstance(x, (int,float)) for x in total) else None}


def _sample_smi(path, selected):
    rows = _smi_rows(path)
    indices = _target_indices(len(rows), selected)
    lookup = {x['index']: x for x in rows}
    return _combine_devices([lookup[i] for i in indices if i in lookup], selected)


def list_gpus():
    try:
        nvml = _nvml_init()
        result = []
        for i in range(nvml.nvmlDeviceGetCount()):
            handle = nvml.nvmlDeviceGetHandleByIndex(i)
            name = nvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes): name = name.decode('utf-8', errors='replace')
            result.append({'index': i, 'name': str(name)[:100]})
        return result
    except Exception:
        smi = _find_nvidia_smi()
        if smi:
            try: return [{'index': x['index'], 'name': x['name']} for x in _smi_rows(smi)]
            except Exception: pass
        return []


def _poller():
    global _LAST
    smi = _find_nvidia_smi()
    consecutive_errors = 0
    while True:
        started = time.monotonic()
        with _LOCK:
            enabled, selected = _ENABLED, _SELECTED
        if not enabled:
            # No GPU / driver calls while disabled, including NVML and nvidia-smi.
            _WAKE.wait(timeout=30.0)
            _WAKE.clear()
            continue
        try:
            try:
                result = _sample_nvml(selected)
            except Exception:
                if not smi: raise
                result = _sample_smi(smi, selected)
            result['sample_ms'] = int(time.time()*1000)
            with _LOCK:
                # Ignore results from a previous selection or after disabling.
                if _ENABLED and _SELECTED == selected:
                    _LAST = result
                    SAMPLES.append(dict(result))
            consecutive_errors = 0
        except Exception as exc:
            consecutive_errors += 1
            with _LOCK:
                if _ENABLED and _SELECTED == selected:
                    _LAST = {'available': False, 'source': 'unavailable', 'reason': str(exc)[:170],
                             'sample_ms': int(time.time()*1000)}
            if consecutive_errors in (1, 10):
                LOG.info('GPU monitoring unavailable: %s', exc)
        delay = 30.0 if consecutive_errors else SAMPLE_INTERVAL_S
        _WAKE.wait(timeout=max(0.1, delay-(time.monotonic()-started)))
        _WAKE.clear()


def start_gpu_monitor():
    global _RUNNING, _THREAD
    with _LOCK:
        if _RUNNING: return
        _RUNNING = True
        _THREAD = threading.Thread(target=_poller, name='BatchTimerHardwareSampler', daemon=True)
        _THREAD.start()


def live_gpu():
    with _LOCK:
        current = dict(_LAST)
        if not _ENABLED:
            return {'available': False, 'disabled': True, 'source': 'disabled',
                    'reason': 'GPU monitoring disabled in Settings'}
    if current.get('available') and int(time.time()*1000)-current.get('sample_ms', 0)>15000:
        return {'available': False, 'source': 'stale', 'reason': 'GPU sample is stale'}
    return current


def gpu_during(start_ms, end_ms):
    if start_ms is None or end_ms is None or end_ms < start_ms:
        return {'gpu_peak_vram_bytes':None,'gpu_avg_util_pct':None,'gpu_peak_temp_c':None}
    with _LOCK:
        points = [r for r in SAMPLES if start_ms <= r.get('sample_ms',0) <= end_ms and r.get('available')]
    # Aggregate VRAM is summed across cards when All GPUs selected. Other metrics
    # remain null to avoid suggesting an average utilization across distinct GPUs.
    def peak(k):
        vals=[r[k] for r in points if isinstance(r.get(k),(int,float))]
        return max(vals) if vals else None
    utils=[r['gpu_util_pct'] for r in points if isinstance(r.get('gpu_util_pct'),(int,float))]
    return {'gpu_peak_vram_bytes':peak('vram_used_bytes'),
            'gpu_avg_util_pct':round(sum(utils)/len(utils),1) if utils else None,
            'gpu_peak_temp_c':peak('temp_c')}


def scan_output_folder(max_items=200000, max_seconds=12.0):
    """Expensive user-requested scan only; no periodic folder walking."""
    global _SCAN_CACHE
    if not _SCAN_LOCK.acquire(blocking=False):
        return {'ok':False,'error':'Scan already running'}
    try:
        root=_output_dir()
        stack=[root]
        files=0; size_bytes=0; visited=0; truncated=False
        start=time.monotonic()
        while stack:
            if visited >= max_items or time.monotonic()-start >= max_seconds:
                truncated=True;break
            directory=stack.pop()
            try:
                with os.scandir(directory) as items:
                    for item in items:
                        visited+=1
                        if visited >= max_items or time.monotonic()-start >= max_seconds:
                            truncated=True;break
                        try:
                            if item.is_symlink(): continue
                            if item.is_dir(follow_symlinks=False):
                                stack.append(Path(item.path))
                            elif item.is_file(follow_symlinks=False) and Path(item.name).suffix.lower() in IMAGE_EXTS:
                                size_bytes+=item.stat(follow_symlinks=False).st_size
                                files+=1
                        except OSError:
                            continue
            except OSError:
                continue
            if truncated:break
        result={'ok':True,'files':files,'bytes':size_bytes,'truncated':truncated,
                'scanned_entries':visited,'scanned_at_ms':int(time.time()*1000),
                'note':'Counts image files currently present in the server output directory. No other directories are scanned.'}
        _SCAN_CACHE=result
        return result
    finally:
        _SCAN_LOCK.release()


def last_folder_scan():
    return dict(_SCAN_CACHE) if _SCAN_CACHE else None
