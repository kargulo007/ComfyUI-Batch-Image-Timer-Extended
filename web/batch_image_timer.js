/**
 * Extended modifications: Copyright (c) 2026 Piotr Karwowski.
 * Batch Image Timer v1.7.0 — Generation Time + sampler progress.
 * Based on hermankwan/ComfyUI-Batch-Image-Timer (MIT).
 *
 * One stopwatch for the current/last workflow execution. Never divides the
 * displayed duration by image count. The progress bar is per sampler/node
 * (when ComfyUI emits 'progress'), not a fictional whole-workflow ETA.
 * The existing history and persistent statistics extensions remain intact.
 */
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { TimerEngine } from "./timer_engine.js";
import { renderTimerUI } from "./ui_renderer.js";

const timer = new TimerEngine();
let activeGraph = null;
let activeNodeId = null;
let activePromptId = null;
let isRendering = false;
let receivedTimerUpdate = false;
let status = "READY";
let fallbackFinish = null;
let sampling = null;
let executingNodeId = null;
let executingNodeName = null;

const DISPLAY_REFRESH_MS = 25;
const redraw = () => app.graph?.setDirtyCanvas(true, true);
const eventPromptId = event => event?.detail?.prompt_id == null
    ? null : String(event.detail.prompt_id);

function clearFallback() {
    if (fallbackFinish !== null) clearTimeout(fallbackFinish);
    fallbackFinish = null;
}
function getTimerNode() {
    return (app.graph?._nodes || []).find(n => n.comfyClass === "BatchImageTimer") || null;
}
function samePrompt(event) {
    const incoming = eventPromptId(event);
    // Old ComfyUI versions may not include prompt_id on every progress event.
    return !incoming || !activePromptId || incoming === activePromptId;
}
function beginRun(node, promptId) {
    if (!node) return;
    clearFallback();
    activeGraph = node.graph || app.graph;
    activeNodeId = String(node.id);
    activePromptId = promptId || null;
    isRendering = true;
    receivedTimerUpdate = false;
    status = "RENDERING";
    sampling = null;
    executingNodeId = null;
    executingNodeName = null;
    timer.total.start();
    redraw();
}
function finishRun(kind = "success", promptId = null) {
    if (!isRendering) return;
    if (promptId && activePromptId && promptId !== activePromptId) return;
    clearFallback();
    timer.total.stop();
    isRendering = false;
    sampling = null;
    executingNodeId = null;
    executingNodeName = null;
    if (kind === "success" && receivedTimerUpdate) {
        status = "COMPLETED";
    } else if (kind === "success") {
        // The execution did not pass through this timer node; do not report
        // an unrelated workflow as a completed timed generation.
        timer.total.reset();
        status = "READY";
        activeGraph = null;
        activeNodeId = null;
    } else {
        status = kind === "error" ? "ERROR" : "INTERRUPTED";
    }
    activePromptId = null;
    redraw();
}
function handleExecuting(event) {
    if (!isRendering || !samePrompt(event)) return;
    // Most ComfyUI versions use {node,prompt_id}; some send a bare node id.
    const detail = event?.detail;
    const node = detail && typeof detail === "object" ? detail.node : detail;
    const nextId = node == null ? null : String(node);
    if (nextId !== executingNodeId) {
        executingNodeId = nextId;
        const n = app.graph?.getNodeById?.(nextId);
        executingNodeName = n?.title || n?.comfyClass || n?.type || (nextId ? `Node ${nextId}` : null);
        // A percentage from a previous sampler must never be shown for a new
        // node. A new sampler will provide its own value/max shortly.
        sampling = null;
        redraw();
    }
}
function handleProgress(event) {
    if (!isRendering || !samePrompt(event)) return;
    const detail = event?.detail || {};
    const value = Number(detail.value), max = Number(detail.max);
    if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return;
    const node = detail.node == null ? executingNodeId : String(detail.node);
    // Ignore a stale progress packet belonging to a previous node.
    if (executingNodeId && node && String(node) !== executingNodeId) return;
    sampling = {
        nodeId: node == null ? null : String(node),
        value: Math.max(0, Math.min(max, value)),
        max,
    };
    redraw();
}

setInterval(() => { if (isRendering) redraw(); }, DISPLAY_REFRESH_MS);

app.registerExtension({
    name: "BatchImageTimer.GenerationTimeV160",
    async setup() {
        api.addEventListener("execution_start", event => {
            const node = getTimerNode();
            if (node) beginRun(node, eventPromptId(event));
        });
        api.addEventListener("batch_timer_update", event => {
            const detail = event.detail || {};
            const node = app.graph?.getNodeById?.(detail.node_id) || getTimerNode();
            if (!node || node.comfyClass !== "BatchImageTimer") return;
            if (!isRendering) beginRun(node, eventPromptId(event));
            activeGraph = node.graph || app.graph;
            activeNodeId = String(node.id);
            receivedTimerUpdate = true;
            redraw();
        });
        api.addEventListener("executing", handleExecuting);
        api.addEventListener("progress", handleProgress);
        api.addEventListener("execution_success", event => finishRun("success", eventPromptId(event)));
        api.addEventListener("execution_error", event => finishRun("error", eventPromptId(event)));
        api.addEventListener("execution_interrupted", event => finishRun("interrupt", eventPromptId(event)));
        api.addEventListener("status", event => {
            if (!isRendering || event.detail?.status?.exec_info?.queue_remaining !== 0) return;
            clearFallback();
            fallbackFinish = setTimeout(async () => {
                fallbackFinish = null;
                if (!isRendering) return;
                try {
                    const response = await api.fetchApi("/prompt");
                    const data = await response.json();
                    if (data?.exec_info?.executing === false || data?.exec_info?.executing === null) {
                        finishRun("success");
                    }
                } catch (_) { /* Wait for execution_success. */ }
            }, 1500);
        });
    },
    async nodeCreated(node) {
        if (node.comfyClass !== "BatchImageTimer" || node._renderingTimeInstalled) return;
        node._renderingTimeInstalled = true;
        // Old saved workflows may still contain the retired widget.
        if (node.widgets) node.widgets = node.widgets.filter(w => w.name !== "total_images");
        node.properties = node.properties || {};
        node.properties.activeColor = node.properties.activeColor || "#FFFFFF";
        node._lastDigitClick = 0;
        node._flashTime = 0;
        requestAnimationFrame(() => {
            node.size = [Math.max(node.size?.[0] || 410, 410), Math.max(node.size?.[1] || 0, 255)];
            redraw();
        });
        node.onDrawBackground = function(ctx) {
            const active = activeGraph === this.graph && activeNodeId === String(this.id);
            renderTimerUI(ctx, this,
                active ? timer.total.getMs() : 0,
                this.properties.activeColor,
                active ? status : "READY",
                this._flashTime,
                { running: active && isRendering, sampling: active ? sampling : null,
                  stage: active ? executingNodeName : null }
            );
        };
        node.onMouseDown = function(event, pos) {
            if (this._hitSwatches) {
                for (const swatch of this._hitSwatches) {
                    if (hit(pos, swatch)) {
                        this.properties.activeColor = swatch.color;
                        redraw(); return true;
                    }
                }
            }
            if (!hit(pos, this._hitDigit)) return false;
            if (isRendering) {
                this._flashTime = Date.now();
                redraw();
                setTimeout(() => { this._flashTime = 0; redraw(); }, 150);
                return true;
            }
            const now = Date.now();
            if (now - this._lastDigitClick < 330) {
                this._lastDigitClick = 0;
                timer.total.reset();
                status = "READY";
                activeGraph = null;
                activeNodeId = null;
                sampling = null;
            } else this._lastDigitClick = now;
            redraw(); return true;
        };
        node.onMouseMove = function(event, pos) {
            const canvas = app.canvas?.canvas;
            if (!canvas || (canvas.style.cursor || "").includes("resize")) return;
            const isOnDigit = hit(pos, this._hitDigit);
            const isOnSwatch = this._hitSwatches?.some(sw => hit(pos, sw));
            canvas.style.cursor = isOnDigit ? "pointer" : isOnSwatch ? "default" : "crosshair";
        };
        node.onMouseLeave = function() {
            if (app.canvas?.canvas) app.canvas.canvas.style.cursor = app.canvas?.default_connection_cursor || "crosshair";
        };
    },
    async loadedGraphNode(node) { await this.nodeCreated(node); }
});
function hit(pos, area) {
    return !!(pos && area && pos[0] >= area.x && pos[0] <= area.x + area.w &&
        pos[1] >= area.y && pos[1] <= area.y + area.h);
}
