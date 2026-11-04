"""Copyright (c) 2026 Piotr Karwowski — Extended modifications.

ComfyUI Batch Image Timer Extended — independent modified distribution.
Extended version: 1.9.3

Based on the original ComfyUI-Batch-Image-Timer by Herman Kwan.
Original copyright (c) 2026 Herman Kwan.
MIT-licensed original software: see LICENSE and NOTICE.md.
The extended version is not an official upstream release.
"""

__version__ = "1.9.3"

from .batch_image_timer import BatchImageTimer
from . import timer_statistics  # Registers persistent statistics API routes
from .timer_hardware import start_gpu_monitor, configure_gpu
_gpu_settings = timer_statistics._settings()
configure_gpu(_gpu_settings.get('gpu_enabled', True), _gpu_settings.get('gpu_device', 'auto'))
start_gpu_monitor()  # Optional NVIDIA sampling in a daemon; ComfyUI rendering remains untouched

NODE_CLASS_MAPPINGS = {"BatchImageTimer": BatchImageTimer}
NODE_DISPLAY_NAME_MAPPINGS = {"BatchImageTimer": "⏱️ Batch Image Timer — Generation Time"}

WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "__version__",
]
