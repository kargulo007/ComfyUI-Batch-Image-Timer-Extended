/**
 * Extended modifications: Copyright (c) 2026 Piotr Karwowski. Shared helper module for the v1.4 timer and history extensions (MIT). */
const subscribers = new Set();
export const imageState = { promptId: null, count: 1, source: "estimated", completed: false };

export function setImageState(promptId, count, source = "estimated", completed = false) {
    const n = Number(count);
    imageState.promptId = promptId == null ? null : String(promptId);
    imageState.count = Number.isFinite(n) && n >= 1 ? Math.max(1, Math.floor(n)) : 1;
    imageState.source = source;
    imageState.completed = completed;
    for (const subscriber of subscribers) subscriber(imageState);
}
export function subscribeImageState(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
}

const LATENT_PATTERN = /empty.*latent|latent.*empty/i;
function nodeBatchValue(node) {
    const widget = node?.widgets?.find(w => w.name === "batch_size");
    if (widget && Number.isFinite(Number(widget.value))) return Number(widget.value);
    const p = node?.properties?.batch_size;
    return Number.isFinite(Number(p)) ? Number(p) : 1;
}

/** For the live, estimated display: infer batch_size, never alter it. */
export function estimateGraphBatchSize(graph) {
    const nodes = graph?._nodes || [];
    const candidates = nodes.filter(n => LATENT_PATTERN.test(n.comfyClass || n.type || ""))
        .map(nodeBatchValue)
        .filter(n => Number.isFinite(n) && n > 0);
    return candidates.length ? Math.max(1, Math.floor(Math.max(...candidates))) : 1;
}

/** For queued execution data, which is more reliable than a live graph widget. */
export function estimatePromptBatchSize(prompt) {
    if (!prompt || typeof prompt !== "object") return 1;
    const candidates = Object.values(prompt)
        .filter(n => LATENT_PATTERN.test(n?.class_type || ""))
        .map(n => Number(n?.inputs?.batch_size))
        .filter(n => Number.isFinite(n) && n >= 1);
    return candidates.length ? Math.max(1, Math.floor(Math.max(...candidates))) : 1;
}

/** Count distinct saved images. Only use previews when no saved images exist. */
export function findImagesFromOutputs(outputs) {
    const results = new Map();
    for (const out of Object.values(outputs || {})) {
        for (const file of out?.images || []) {
            if (!file || typeof file.filename !== "string" || !file.filename) continue;
            const type = ["output", "temp", "input"].includes(file.type) ? file.type : "output";
            if (type === "input") continue;
            const image = { filename: file.filename, subfolder: file.subfolder || "", type };
            results.set(`${type}\u0000${image.subfolder}\u0000${image.filename}`, image);
        }
    }
    const all = [...results.values()];
    const saved = all.filter(f => f.type === "output");
    return saved.length ? saved : all.filter(f => f.type === "temp");
}

export function formatDuration(ms) {
    const centiseconds = Math.floor(Math.max(0, Number(ms) || 0) / 10);
    return [Math.floor(centiseconds / 6000), Math.floor(centiseconds / 100) % 60,
        centiseconds % 100].map(n => String(n).padStart(2, "0")).join(":");
}
