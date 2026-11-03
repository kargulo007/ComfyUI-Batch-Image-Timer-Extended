/**
 * Extended modifications: Copyright (c) 2026 Piotr Karwowski.
 * ComfyUI-Batch-Image-Timer
 * A specialized 7-segment LED timer for tracking the total execution time of batch image processing workflows.
 * 
 * @version 0.2.3
 * @copyright Copyright (c) 2026 Herman Kwan
 * @license MIT
 */

const COLOR_PALETTE = ["#FFFFFF", "#00BFFF", "#00FF88", "#FFCC00", "#FF007F"];
const INACTIVE_COLOR_MAP = {
    "#FFFFFF": "#1A1A1A", "#00BFFF": "#001A22", "#00FF88": "#001F11",
    "#FFCC00": "#1F1700", "#FF007F": "#1F0010"
};
const SEGMENT_MAP = {
    '0': [1,1,1,1,1,1,0], '1': [0,1,1,0,0,0,0], '2': [1,1,0,1,1,0,1],
    '3': [1,1,1,1,0,0,1], '4': [0,1,1,0,0,1,1], '5': [1,0,1,1,0,1,1],
    '6': [1,0,1,1,1,1,1], '7': [1,1,1,0,0,0,0], '8': [1,1,1,1,1,1,1],
    '9': [1,1,1,1,0,1,1]
};

/**
 * Seven-segment time format: MM:SS:CC (minutes, seconds, centiseconds).
 * The source clock already measures milliseconds; only presentation changes.
 * We deliberately truncate fractional centiseconds so a running timer never
 * displays a future time and its final reading remains stable.
 */
export function formatTimerDisplay(timerMs) {
    const centiseconds = Math.floor(Math.max(0, Number.isFinite(timerMs) ? timerMs : 0) / 10);
    const minutes = Math.floor(centiseconds / 6000);
    const seconds = Math.floor((centiseconds % 6000) / 100);
    const hundredths = centiseconds % 100;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(hundredths).padStart(2, "0")}`;
}

/**
 * Compact first panel: one generation-time clock and optional per-node
 * sampler progress. Only step percentages received from ComfyUI are shown.
 */
export function renderTimerUI(ctx, node, timerMs, activeColor, status = "READY", flashTime = 0, info = {}) {
    const nodeW = node.size[0];
    const nodeH = node.size[1];
    let headerOffset = 30;
    if (node.widgets?.length) {
        let maxY = 0;
        for (const widget of node.widgets) {
            if (widget.last_y === undefined || widget.type === "hidden_seq_index") continue;
            let height = 20;
            try {
                const calculated = widget.computeSize?.();
                if (Number.isFinite(calculated?.[1])) height = calculated[1];
            } catch (_) { /* Ignore nonstandard widget layout. */ }
            maxY = Math.max(maxY, widget.last_y + height);
        }
        headerOffset = maxY > 0 ? maxY + 15 : 65;
    }

    const margin = 10;
    const rectW = Math.max(100, nodeW - margin * 2);
    const rectH = Math.max(160, nodeH - headerOffset - margin);
    const rectBottom = headerOffset + rectH;
    const scale = Math.max(.7, Math.min(2.15, rectH / 125, rectW / 240));
    const timeStr = formatTimerDisplay(timerMs);
    const digitHeight = 26 * scale;
    const digitWidth = 14 * scale;
    const digitGap = 5 * scale;
    const colonWidth = 8 * scale;
    const displayWidth = 6 * digitWidth + 7 * digitGap + 2 * colonWidth;
    const digitStartY = headerOffset + Math.max(45, rectH * .30) - digitHeight * .12;

    ctx.save();
    try {
        ctx.fillStyle = "#000000";
        ctx.fillRect(margin, headerOffset, rectW, rectH);
        ctx.strokeStyle = "#222222";
        ctx.lineWidth = 1;
        ctx.strokeRect(margin + .5, headerOffset + .5, rectW - 1, rectH - 1);

        ctx.fillStyle = "#85909B";
        ctx.textAlign = "center";
        ctx.font = `bold ${Math.max(12, Math.round(12 * scale))}px monospace`;
        ctx.fillText("GENERATION TIME", nodeW / 2, digitStartY - 13 * scale);
        node._hitTabs = [];

        const inactiveColor = INACTIVE_COLOR_MAP[activeColor] || "#1A1A1A";
        node._hitDigit = {
            x: (nodeW - displayWidth) / 2 - 4, y: digitStartY - 4,
            w: displayWidth + 8, h: digitHeight + 8,
        };
        const flashing = Date.now() - flashTime < 150;
        let atX = (nodeW - displayWidth) / 2;
        for (const char of timeStr) {
            if (char === ":") {
                const dot = Math.max(3, colonWidth * .35);
                const cx = atX + colonWidth / 2 - dot / 2;
                ctx.fillStyle = activeColor;
                ctx.globalAlpha = flashing ? .05 : .3;
                for (const factor of [.3, .7]) {
                    const dy = digitStartY + digitHeight * factor - dot / 2;
                    ctx.fillRect(cx - .5, dy - .5, dot + 1, dot + 1);
                    ctx.globalAlpha = flashing ? .2 : 1;
                    ctx.fillRect(cx, dy, dot, dot);
                    ctx.globalAlpha = flashing ? .05 : .3;
                }
                ctx.globalAlpha = 1;
                atX += colonWidth + digitGap;
            } else {
                drawDigit(ctx, atX, digitStartY, digitWidth, digitHeight,
                    char, activeColor, inactiveColor, flashing);
                atX += digitWidth + digitGap;
            }
        }
        ctx.globalAlpha = 1;

        // Keep the original five color selectors beneath the clock.
        const swatchSize = Math.max(6, Math.round(6 * scale));
        const swatchGap = 6 * scale;
        const paletteWidth = COLOR_PALETTE.length * swatchSize +
            (COLOR_PALETTE.length - 1) * swatchGap;
        let sx = (nodeW - paletteWidth) / 2;
        const sy = digitStartY + digitHeight + 10 * scale;
        node._hitSwatches = [];
        COLOR_PALETTE.forEach(color => {
            ctx.fillStyle = color;
            ctx.fillRect(sx, sy, swatchSize, swatchSize);
            if (color === activeColor) {
                ctx.strokeStyle = "rgba(255,255,255,.8)";
                ctx.strokeRect(sx - 1.5, sy - 1.5, swatchSize + 3, swatchSize + 3);
            }
            node._hitSwatches.push({ x: sx - 3, y: sy - 3,
                w: swatchSize + 6, h: swatchSize + 6, color });
            sx += swatchSize + swatchGap;
        });

        // Each progress percentage represents the active sampling node only.
        // Other stages may not expose numeric progress, so an animated moving
        // segment indicates activity without inventing an overall percentage.
        const barX = margin + 16;
        const barW = Math.max(20, rectW - 32);
        const barH = Math.max(6, 5 * scale);
        const naturalBarY = sy + swatchSize + Math.max(12, 11 * scale);
        const barY = Math.min(naturalBarY, rectBottom - barH - 24);
        const running = !!info.running;
        const sample = running ? info.sampling : null;
        const known = sample && Number.isFinite(sample.value) &&
            Number.isFinite(sample.max) && sample.max > 0;

        ctx.fillStyle = "#141d25";
        ctx.fillRect(barX, barY, barW, barH);
        if (known) {
            const fraction = Math.min(1, Math.max(0, sample.value / sample.max));
            ctx.fillStyle = activeColor;
            ctx.fillRect(barX, barY, barW * fraction, barH);
        } else if (running) {
            const segmentW = barW * .23;
            const x = ((performance.now() / 950) % 1) * (barW + segmentW) - segmentW;
            ctx.save();
            ctx.beginPath(); ctx.rect(barX, barY, barW, barH); ctx.clip();
            ctx.fillStyle = activeColor;
            ctx.globalAlpha = .83;
            ctx.fillRect(barX + x, barY, segmentW, barH);
            ctx.restore();
        } else if (status === "COMPLETED") {
            ctx.fillStyle = "#39D5A0";
            ctx.fillRect(barX, barY, barW, barH);
        }

        const labelY = barY + barH + Math.max(12, 9 * scale);
        ctx.font = `${Math.max(10, Math.round(9 * scale))}px monospace`;
        ctx.textAlign = "left";
        ctx.fillStyle = status === "ERROR" ? "#FF5555" :
            status === "INTERRUPTED" ? "#FFCC00" :
            status === "COMPLETED" ? "#39D5A0" : "#9CB0C2";
        let leftLabel = "READY";
        if (known) leftLabel = `${info.stage || 'SAMPLING'} ${Math.floor(sample.value)} / ${Math.floor(sample.max)}`;
        else if (running) leftLabel = info.stage ? `RUNNING · ${info.stage}` : 'GENERATING...';
        else if (status === "COMPLETED") leftLabel = "LAST GENERATION COMPLETED";
        else if (status === "ERROR") leftLabel = "ERROR";
        else if (status === "INTERRUPTED") leftLabel = "INTERRUPTED";
        const maxLabelW = known ? barW-55 : barW;
        while (leftLabel.length > 4 && ctx.measureText(leftLabel).width > maxLabelW)
            leftLabel = leftLabel.slice(0,-2) + '…';
        ctx.fillText(leftLabel, barX, labelY);
        if (known) {
            const pct = Math.round(100 * Math.max(0, Math.min(1, sample.value / sample.max)));
            ctx.textAlign = "right";
            ctx.fillStyle = activeColor;
            ctx.fillText(`${pct}%`, barX + barW, labelY);
        }
    } finally {
        ctx.restore();
    }
}

function drawDigit(ctx, x, y, width, height, char, activeColor, inactiveColor, isFlashing) {
    const segments = SEGMENT_MAP[char] || [0,0,0,0,0,0,0];
    const t = Math.max(2, width * 0.14);
    const gap = width * 0.08;
    const hH = height / 2;
    
    const segs = [
        { x: x + t + gap, y: y, w: width - 2 * t - 2 * gap, h: t },
        { x: x + width - t, y: y + t + gap, w: t, h: hH - t - 2 * gap },
        { x: x + width - t, y: y + hH + gap, w: t, h: hH - t - 2 * gap },
        { x: x + t + gap, y: y + height - t, w: width - 2 * t - 2 * gap, h: t },
        { x: x, y: y + hH + gap, w: t, h: hH - t - 2 * gap },
        { x: x, y: y + t + gap, w: t, h: hH - t - 2 * gap },
        { x: x + t + gap, y: y + hH - t / 2, w: width - 2 * t - 2 * gap, h: t }
    ];

    for (let i = 0; i < 7; i++) {
        if (segments[i]) {
            ctx.fillStyle = activeColor;
            ctx.globalAlpha = isFlashing ? 0.05 : 0.3;
            ctx.fillRect(segs[i].x - 1, segs[i].y - 1, segs[i].w + 2, segs[i].h + 2);
            
            ctx.globalAlpha = isFlashing ? 0.2 : 1.0;
            ctx.fillRect(segs[i].x, segs[i].y, segs[i].w, segs[i].h);
        } else {
            ctx.fillStyle = inactiveColor;
            ctx.globalAlpha = 0.5; 
            ctx.fillRect(segs[i].x - 1, segs[i].y - 1, segs[i].w + 2, segs[i].h + 2);
            
            ctx.globalAlpha = 1.0;
            ctx.fillRect(segs[i].x, segs[i].y, segs[i].w, segs[i].h);
        }
    }
}