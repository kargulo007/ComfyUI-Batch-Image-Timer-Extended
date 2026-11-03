"""Copyright (c) 2026 Piotr Karwowski — Extended modifications.
Batch Image Timer v1.7.0 — lightweight execution marker (no total_images).

Based on hermankwan/ComfyUI-Batch-Image-Timer (MIT).
No user-entered total_images: the generator/Empty Latent Image owns batch size.
"""
from server import PromptServer


class BatchImageTimer:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}, "hidden": {"unique_id": "UNIQUE_ID"}}

    RETURN_TYPES = ()
    FUNCTION = "process"
    CATEGORY = "utils/timer"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Always execute the marker, including when other nodes were cached.
        return float("nan")

    def process(self, unique_id=None):
        PromptServer.instance.send_sync("batch_timer_update", {
            "node_id": unique_id,
        })
        return ()
