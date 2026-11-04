/**
 * Extended modifications: Copyright (c) 2026 Piotr Karwowski. Batch Image Timer — Generation Monitor v1.9.3 (MIT). */
import { app } from "/scripts/app.js";
import {openGallery, openFailures, openSettings, installNotifications} from "./batch_timer_extras.js";
import { api } from "/scripts/api.js";
import { openAnalytics, openRunDetails } from "./batch_timer_analytics.js";
import { openHardwarePanel } from "./batch_timer_hardware.js";
import { setImageState, estimateGraphBatchSize, estimatePromptBatchSize,
         findImagesFromOutputs, formatDuration } from "./timer_shared.js";

const MAX_ENTRIES = 20;
const HISTORY_HEIGHT = 238;
const STATS_HEIGHT = 316;
const GPU_HEIGHT = 135;
const TOOLS_HEIGHT = 82;
const SERVER_DEFAULTS = {history_rows:10,gallery_limit:30,show_chart:true,
    performance_enabled:true,performance_threshold:25,performance_min_samples:5,
    show_failures:true,backups_enabled:true,backup_retention:14,show_gpu_panel:true,
    gpu_enabled:true,gpu_device:'auto'};
let serverSettings = {...SERVER_DEFAULTS};
const visibleRows = () => Math.max(5,Math.min(20,serverSettings.history_rows || 10));
const COLLAPSED_HEIGHT = 39;
const historyHeight = node => node.properties?.batchHistoryCollapsed ? COLLAPSED_HEIGHT : HISTORY_HEIGHT + (visibleRows() - 10)*14;
const statsHeight = node => node.properties?.batchStatsCollapsed ? COLLAPSED_HEIGHT : STATS_HEIGHT;
const gpuHeight = node => !serverSettings.show_gpu_panel ? 0 :
    (node.properties?.batchGpuCollapsed ? COLLAPSED_HEIGHT : GPU_HEIGHT);
const extensionHeight = node => historyHeight(node) + statsHeight(node) + gpuHeight(node) + TOOLS_HEIGHT;

const STORAGE_KEY = "comfy.batch_image_timer.session_history.v1"; // v1.3 compatibility
const TRANSFER_PREFIX = "comfy.batch_timer.workflow_transfer.";
const TRANSFER_PARAM = "batch_timer_open";
const HOOK_MARK = Symbol("batchTimerHistoryHooked");
const PREVIEW_LIMIT = 8;
const workflowCache = new Map();
const pending = new Map();
let statsPeriods = null;
let statsFailures = null;
let statsPerformance = null;
let statsError = null;
let statsMode = "calendar";
let statsDay = (()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;})();
let statsDaySummary = null;
let statsDayEntries = [];
let statsModels = [];
let performanceRows = []; // independent from cleared / hidden Recent Generations
let recentBusy = false;
let statsBusy = false;
let statsLastUpdated = 0;
let gpuState=null;
let databaseStatus='CHECKING';
async function refreshDatabaseStatus(){
    try {
        const res=await api.fetchApi('/batch_timer/stats/health');
        const data=await res.json();
        const fresh=Number.isFinite(data.last_scan_ms) && Date.now()-data.last_scan_ms < 60000;
        databaseStatus=data.ok && data.database==='ready' && data.observer==='active' && fresh && !data.observer_error
            ? 'DATABASE OK' : 'DATABASE WARNING';
    } catch (_) { databaseStatus='DATABASE ERROR'; }
    redraw();
}

async function refreshGpuState(){
    if(!serverSettings.gpu_enabled){gpuState={available:false,disabled:true};redraw();return;}
    try {
        const r=await api.fetchApi('/batch_timer/gpu/live');
        if(!r.ok)return;
        const data=await r.json();
        gpuState=data.gpu||null;
        if(!gpuState?.available && !gpuState?.disabled && serverSettings.gpu_enabled){
            // ComfyUI's own system_stats reports device VRAM for non-NVIDIA users.
            try{
                const reply=await api.fetchApi('/system_stats');
                if(reply.ok){
                    const sys=await reply.json();
                    const dev=(sys.devices||[]).find(d=>Number(d.vram_total)>0);
                    if(dev && Number.isFinite(Number(dev.vram_free)))gpuState={available:true,source:'ComfyUI /system_stats',
                        vram_total_bytes:Number(dev.vram_total),
                        vram_used_bytes:Math.max(0,Number(dev.vram_total)-Number(dev.vram_free)),
                        gpu_util_pct:null,temp_c:null};
                }
            }catch(_){}
        }
        redraw();
    } catch(_){ /* GPU monitor must never prevent the timer working. */ }
}
function gpuBrief(){
    if(gpuState?.disabled || !serverSettings.gpu_enabled)return 'GPU monitoring disabled · enable in SETTINGS';
    if(!gpuState?.available)return 'GPU: unavailable  ·  MONITOR for details';
    const g=gpuState;
    const pct=typeof g.gpu_util_pct==='number'?Math.round(g.gpu_util_pct)+'%':'N/A';
    const vram=typeof g.vram_used_bytes==='number'&&typeof g.vram_total_bytes==='number'?
        (g.vram_used_bytes/(1024**3)).toFixed(1)+'/'+(g.vram_total_bytes/(1024**3)).toFixed(1)+' GB':'N/A';
    const temp=typeof g.temp_c==='number'?Math.round(g.temp_c)+'°C':'N/A';
    return `GPU ${pct}  ·  VRAM ${vram}  ·  ${temp}`;
}

async function loadServerSettings(){
    try{
        const res=await api.fetchApi('/batch_timer/stats/settings');
        if(!res.ok)return;
        const data=await res.json();
        if(data.ok && data.settings)applyServerSettings(data.settings);
    }catch(_){}
}
function applyServerSettings(next){
    const nodes=(app.graph?._nodes || []).filter(n=>n.comfyClass==='BatchImageTimer');
    const old=nodes.map(n=>extensionHeight(n));
    serverSettings={...SERVER_DEFAULTS,...next};
    nodes.forEach((n,i)=>{
        const delta=extensionHeight(n)-old[i];
        n.size[1]=Math.max(baseMinimumHeight(n)+extensionHeight(n),n.size[1]+delta);
    });
    if (serverSettings.show_gpu_panel) void refreshGpuState();
    else if (!serverSettings.gpu_enabled) gpuState={available:false,disabled:true};
    redraw();
}

const safeStorage = {
    get() { try { return sessionStorage.getItem(STORAGE_KEY); } catch (_) { return null; } },
    set(value) { try { sessionStorage.setItem(STORAGE_KEY, value); } catch (_) {} },
};
function restoreHistory() {
    try {
        const data = JSON.parse(safeStorage.get() || "[]");
        return Array.isArray(data) ? data.filter(r => r && Number.isFinite(r.when) &&
            Number.isFinite(r.durationMs) && r.durationMs >= 0).slice(0, MAX_ENTRIES) : [];
    } catch (_) { return []; }
}
let history = restoreHistory();
let activePrompt = null;
let hoverKey = null;
let popup = null;
let popupOwner = null;
let lastHoverPosition = null;
let hideTimer = null;

function persistHistory() {
    try {
        // Persist metadata, not oversized thumbnails or full workflow JSON.
        safeStorage.set(JSON.stringify(history.map(({ workflowSnapshot, preview, ...row }) => ({
            ...row,
            preview: preview && !preview.unavailable ? preview : undefined,
            workflowSnapshot: workflowSnapshot && JSON.stringify(workflowSnapshot).length < 180000
                ? workflowSnapshot : undefined,
        }))));
    } catch (_) { /* Still works in memory if storage quota is exceeded. */ }
}
function redraw() { app.graph?.setDirtyCanvas(true, true); }
function promptId(event) { return event?.detail?.prompt_id == null ? null : String(event.detail.prompt_id); }
function rowKey(row) { return `${row.when}:${row.promptId || "legacy"}`; }
function hit(pos, a) { return !!(pos && a && pos[0] >= a.x && pos[0] <= a.x + a.w && pos[1] >= a.y && pos[1] <= a.y + a.h); }
function countForRow(row) { return Number.isFinite(row?.imageCount) && row.imageCount > 0 ? row.imageCount : null; }
function perImageMs(row) { const n = countForRow(row); return n ? row.durationMs / n : null; }
function formatTime(epochMs) { return new Date(epochMs).toLocaleTimeString("en-GB", { hour12: false }); }

function snapshotCurrentWorkflow() {
    try {
        const data = app.graph?.serialize?.();
        if (data && typeof data === "object") return data;
    } catch (_) {}
    return null;
}
function onExecutionStart(event) {
    activePrompt = {
        id: promptId(event), startedAt: performance.now(), timerNode: null,
        estimatedCount: estimateGraphBatchSize(app.graph),
        workflowSnapshot: snapshotCurrentWorkflow(),
    };
}
function onBatchTimerUpdate(event) {
    const d = event?.detail || {};
    const node = app.graph?.getNodeById?.(d.node_id);
    if (!node || node.comfyClass !== "BatchImageTimer") return;
    if (!activePrompt) onExecutionStart(event);
    activePrompt.timerNode = node;
}
function onExecutionSuccess(event) {
    const run = activePrompt;
    if (!run) return;
    const completedId = promptId(event);
    if (run.id && completedId && run.id !== completedId) return;
    const durationMs = Math.max(0, Math.round(performance.now() - run.startedAt));
    // Statistics cover every successful image-producing workflow seen by this
    // ComfyUI frontend, not only runs containing the Batch Image Timer marker.
    // v1.6 records results directly in ComfyUI server history observer.
    // Never depend on the browser being open to count images.
    if (run.timerNode) {
        const row = {
            when: Date.now(),
            durationMs,
            promptId: run.id || completedId || null,
            imageCount: run.estimatedCount, imageCountVerified: false,
            workflowSnapshot: run.workflowSnapshot,
        };
        history.unshift(row);
        history = history.slice(0, MAX_ENTRIES);
        persistHistory();
        redraw();
        if (row.promptId) void loadPreview(row); // Show promptly while server observer catches up.
        setTimeout(() => { void refreshRecent(); void refreshStatistics(); void refreshPerformance(); }, 2700);
    }
    activePrompt = null;
}

// -------------------------------------------------------------------------
// Persistent statistics: record successful image-producing executions and
// summarize them from SQLite, independently from the 10-item hover history.
// -------------------------------------------------------------------------
function getDateStarts() {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    const midnight = new Date(y, m, d);
    const mondayOffset = (midnight.getDay() + 6) % 7; // Monday starts week.
    return {
        today: midnight.getTime(),
        last7: new Date(y, m, d - 6).getTime(),
        last30: new Date(y, m, d - 29).getTime(),
        this_week: new Date(y, m, d - mondayOffset).getTime(),
        last_week: new Date(y, m, d - mondayOffset - 7).getTime(),
        this_month: new Date(y, m, 1).getTime(),
        last_month: new Date(y, m - 1, 1).getTime(),
    };
}
async function refreshStatistics() {
    if (statsBusy) return;
    statsBusy = true;
    try {
        const params = new URLSearchParams(getDateStarts());
        const response = await api.fetchApi(`/batch_timer/stats/summary?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!data.ok || !data.periods) throw new Error(data.error || "Invalid summary");
        statsPeriods = data.periods;
        statsFailures = data.failures || null;
        statsPerformance = data.performance || null;
        statsLastUpdated = Date.now();
        statsError = null;
    } catch (error) {
        const reason = String(error?.message || error);
        if (/HTTP 404/.test(reason)) {
            statsError = "HTTP 404 — install complete patch + restart ComfyUI";
        } else if (/HTTP 500/.test(reason)) {
            statsError = "HTTP 500 — SQLite/server error (check ComfyUI console)";
        } else {
            statsError = `Stats API: ${reason}`;
        }
    } finally {
        statsBusy = false;
        redraw();
    }
}
async function refreshPerformance(){
    try {
        const response=await api.fetchApi('/batch_timer/stats/performance_runs?limit=12');
        if(!response.ok)return;
        const data=await response.json();
        if(data.ok && Array.isArray(data.entries)){
            performanceRows=data.entries;
            redraw();
        }
    } catch (_) { /* Keep last displayed graph on temporary API failure. */ }
}

let chartTooltip=null;
function hideChartTooltip(){ if(chartTooltip)chartTooltip.style.display='none'; }
function showChartTooltip(record,event){
    if(!chartTooltip){
        chartTooltip=document.createElement('div');
        Object.assign(chartTooltip.style,{position:'fixed',zIndex:'100390',pointerEvents:'none',
            background:'#101e29',color:'#e3eef6',border:'1px solid #47718a',borderRadius:'6px',
            padding:'8px 10px',maxWidth:'320px',whiteSpace:'pre-line',font:'11px/1.5 monospace',
            boxShadow:'0 9px 22px rgba(0,0,0,.55)'});
        document.body.appendChild(chartTooltip);
    }
    const dt=new Date(record.finished_ms);
    chartTooltip.textContent=[
        dt.toLocaleString('en-GB'),
        'RENDER '+formatDuration(record.duration_ms),
        (record.model || 'Unknown model').slice(0,65),
        'Size '+(record.resolution||'—')+' · Steps '+(record.steps??'—'),
        'Images '+record.image_count+' · Queue '+(record.queue_wait_ms == null ? 'unavailable':formatDuration(record.queue_wait_ms)),
        'CLICK FOR DETAILS'
    ].join('\n');
    chartTooltip.style.display='block';
    chartTooltip.style.left=Math.min(window.innerWidth-330,Math.max(4,event.clientX+12))+'px';
    chartTooltip.style.top=Math.min(window.innerHeight-150,Math.max(4,event.clientY+12))+'px';
}
function analyticsOptions(){
    return {imageURL,rowFromServer,loadWorkflowHere,openWorkflowNewTab,getDateStarts,
        onUpdated:()=>{void refreshStatistics();void refreshRecent();void refreshPerformance();}};
}

function formatStatisticsTime(value) {
    const s = Math.max(0, Math.round((Number(value) || 0) / 1000));
    const hours = Math.floor(s / 3600), minutes = Math.floor(s / 60) % 60, seconds = s % 60;
    if (hours) return `${hours}h ${String(minutes).padStart(2,"0")}m ${String(seconds).padStart(2,"0")}s`;
    if (minutes) return `${minutes}m ${String(seconds).padStart(2,"0")}s`;
    return `${seconds}s`;
}
// Server-side observer automatically records completed images and duration.
function rowFromServer(item) {
    return {
        when: item.finished_ms, durationMs: item.duration_ms,
        promptId: item.prompt_id, imageCount: item.image_count,
        imageCountVerified: !!item.verified,
        model: item.model, resolution: item.resolution,
        steps: item.steps, cfg: item.cfg, durationSource: item.duration_source,
        preview: {
            images: (item.images || []).slice(0, PREVIEW_LIMIT),
            imageCount: item.image_count, prompts: item.prompts || [],
        },
    };
}
async function refreshRecent() {
    if (recentBusy) return;
    recentBusy = true;
    try {
        const res = await api.fetchApi(`/batch_timer/stats/recent?limit=${Math.max(20,visibleRows())}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const items = (data.entries || []).map(rowFromServer);
        // Recent history may be cleared; performance data comes from its own endpoint.
        const local = new Map(history.map(r => [r.promptId, r]));
        for (const r of items) {
            const old = local.get(r.promptId);
            if (old?.workflowSnapshot) r.workflowSnapshot = old.workflowSnapshot;
        }
        // Local-only legacy entries are kept until they fall out of the last 10.
        const ids = new Set(items.map(r => r.promptId));
        const legacy = history.filter(r => !ids.has(r.promptId) && !r.fromServer);
        history = [...items, ...legacy].sort((a,b) => b.when-a.when).slice(0,visibleRows());
        persistHistory(); redraw();
    } catch (e) { /* Timings still work if statistics server is temporarily unavailable. */ }
    finally { recentBusy = false; }
}
function togglePanel(node, prop) {
    const before = extensionHeight(node);
    node.properties = node.properties || {};
    node.properties[prop] = !node.properties[prop];
    node.size[1] = Math.max(baseMinimumHeight(node) + extensionHeight(node),
        node.size[1] + extensionHeight(node) - before);
    if (prop === 'batchHistoryCollapsed') hidePopup(node);
    redraw();
}
function dateBounds(dateValue) {
    const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue || '');
    if (!parsed) return null;
    const y = Number(parsed[1]), m = Number(parsed[2])-1, d = Number(parsed[3]);
    const day = new Date(y, m, d);
    if (day.getFullYear() !== y || day.getMonth() !== m || day.getDate() !== d) return null;
    return { start_ms: day.getTime(), end_ms: new Date(y,m,d+1).getTime() };
}
async function fetchDay() {
    const bounds = dateBounds(statsDay);
    if (!bounds) return;
    try {
        const res = await api.fetchApi('/batch_timer/stats/day?'+new URLSearchParams(bounds));
        if (!res.ok) throw new Error('HTTP '+res.status);
        const data = await res.json();
        statsDaySummary = data.summary; statsDayEntries = data.entries || []; redraw();
    } catch (e) { statsError = 'Day: '+String(e.message || e); redraw(); }
}
async function fetchModels() {
    try {
        const res = await api.fetchApi('/batch_timer/stats/models');
        if (!res.ok) throw new Error('HTTP '+res.status);
        statsModels = (await res.json()).models || []; redraw();
    } catch (e) { statsError = 'Models: '+String(e.message || e); redraw(); }
}
function chooseDay() {
    // Use the browser's native date picker, no extra UI libraries.
    const input = document.createElement('input');
    input.type = 'date'; input.value = statsDay;
    Object.assign(input.style, { position: 'fixed', top:'95px', left:'32px',
        zIndex:'99999', background:'#19232d', color:'white' });
    const remove = () => setTimeout(() => input.remove(), 800);
    input.addEventListener('change', () => {
        if (dateBounds(input.value)) { statsDay = input.value; statsMode='day'; void fetchDay(); }
        remove();
    });
    input.addEventListener('blur', remove);
    document.body.appendChild(input);
    try { input.showPicker(); } catch (_) { input.focus(); }
}
async function exportCSV() {
    const params = statsMode === 'day' ? dateBounds(statsDay) :
        statsMode === 'rolling' ? {start_ms: getDateStarts().last30} : null;
    const path = '/batch_timer/stats/export.csv' + (params ? '?'+new URLSearchParams(params) : '');
    const response = await api.fetchApi(path);
    if (!response.ok) throw new Error('CSV HTTP '+response.status);
    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement('a'); a.href = url;
    a.download = 'comfyui-generation-statistics.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function drawStatistics(ctx,node) {
    const h = statsHeight(node), x = 10, y = node.size[1] - TOOLS_HEIGHT - gpuHeight(node) - h;
    const width = Math.max(40,node.size[0]-20), right=x+width;
    const accent = node.properties?.activeColor || '#00BFFF';
    const collapsed = !!node.properties?.batchStatsCollapsed;
    const calendar = [['SESSION','session'],['TODAY','today'],['THIS WEEK','this_week'],
        ['LAST WEEK','last_week'],['THIS MONTH','this_month'],['LAST MONTH','last_month']];
    const rolling = [['SESSION','session'],['TODAY','today'],
        ['LAST 7 DAYS','last7'],['LAST 30 DAYS','last30']];
    ctx.save();
    try {
        ctx.fillStyle='#050608'; ctx.fillRect(x,y,width,h-8);
        ctx.strokeStyle='#26313C'; ctx.strokeRect(x+.5,y+.5,width-1,h-9);
        ctx.textAlign='left'; ctx.font='bold 11px monospace'; ctx.fillStyle=accent;
        ctx.fillText((collapsed ? '▸ ' : '▾ ')+'GENERATION STATISTICS',x+10,y+19);
        node._batchStatsCollapseHit={x:x+5,y:y+4,w:187,h:24};
        node._batchStatsActions=[];
        if (collapsed) return;
        const buttons = [['7D/30D','roll'],['DAY','day'],['MODELS','models'],['CSV','csv']];
        let bx=right-10;
        ctx.textAlign='right'; ctx.font='10px monospace';
        for(let i=buttons.length-1;i>=0;i--) {
            const [label,code]=buttons[i];
            ctx.fillStyle=(statsMode==='rolling'&&code==='roll') || (statsMode===code) ? '#58d9fa':'#8dbad4';
            ctx.fillText(label,bx,y+19);
            const w=ctx.measureText(label).width+10;
            node._batchStatsActions.push({x:bx-w+2,y:y+3,w,h:24,code});
            bx-=w+5;
        }
        ctx.beginPath();ctx.strokeStyle='#26313C';ctx.moveTo(x+10,y+28);ctx.lineTo(right-10,y+28);ctx.stroke();
        ctx.font='bold 10px monospace';ctx.fillStyle='#8b98a6';ctx.textAlign='left';
        ctx.fillText(statsMode==='day' ? `DATE ${statsDay}` : statsMode==='models' ? 'MODEL / RESOLUTION' : 'PERIOD',x+11,y+45);
        ctx.textAlign='center';ctx.fillText('IMAGES',right-143,y+45);
        ctx.textAlign='right';ctx.fillText('RENDER TIME',right-11,y+45);
        const rows = statsMode==='rolling' ? rolling : calendar;
        if(statsError && !statsPeriods) {
            ctx.fillStyle='#e5b381';ctx.textAlign='left';ctx.fillText('Stats unavailable: '+statsError.slice(0,50),x+12,y+73);
        } else if(statsMode==='models') {
            statsModels.slice(0,6).forEach((data,i) => {
                const top=y+51+i*20;
                if(i%2===0){ctx.fillStyle='#0c1219';ctx.fillRect(x+7,top,width-14,20)}
                ctx.textAlign='left';ctx.fillStyle='#c1ccd7';ctx.font='10px monospace';
                const label=String(data.model || 'Unknown').split(/[\/]/).pop().slice(0,22);
                ctx.fillText(label,x+11,top+14);
                ctx.textAlign='center';ctx.fillText(String(data.images||0),right-143,top+14);
                ctx.textAlign='right';ctx.fillText(formatStatisticsTime(data.duration_ms),right-11,top+14);
            });
        } else if(statsMode==='day') {
            const d=statsDaySummary || {};
            const data=[['RUNS',d.runs],['IMAGES',d.images],['RENDER TIME',formatStatisticsTime(d.duration_ms)],
                ['AVG / IMAGE',d.images ? formatStatisticsTime(d.duration_ms/d.images) : '—']];
            data.forEach(([name,value],i)=> {
                const top=y+58+i*26;
                if(i%2===0){ctx.fillStyle='#0c1219';ctx.fillRect(x+7,top-10,width-14,22)}
                ctx.font='11px monospace';ctx.textAlign='left';ctx.fillStyle='#c1ccd7';ctx.fillText(name,x+13,top+5);
                ctx.textAlign='right';ctx.fillStyle=accent;ctx.fillText(String(value??'—'),right-12,top+5);
            });
        } else if(!statsPeriods) {
            ctx.textAlign='left';ctx.fillText('Loading stats from the ComfyUI server...',x+12,y+74);
        } else {
            rows.forEach(([label,period],i)=> {
                const top=y+51+i*20, data=statsPeriods[period] || {};
                if(i%2===0){ctx.fillStyle='#0c1219';ctx.fillRect(x+7,top,width-14,20)}
                ctx.textAlign='left';ctx.fillStyle=i===0?accent:'#c1ccd7';ctx.font='10px monospace';
                ctx.fillText(label,x+11,top+14);
                ctx.textAlign='center';ctx.fillStyle='#dbe6ef';
                ctx.fillText((Number(data.estimated_runs)>0?'~':'')+String(data.images||0),right-143,top+14);
                ctx.textAlign='right';ctx.fillStyle='#b6c3ce';
                ctx.fillText(formatStatisticsTime(data.duration_ms),right-11,top+14);
            });
        }
        // Render-performance chart: total execution times, not per-image estimates.
        const chartX=x+12, chartY=y+194, chartW=width-24, chartH=62;
        ctx.textAlign='left';ctx.fillStyle='#8fa1b1';ctx.font='10px monospace';
        ctx.fillText('RENDER PERFORMANCE · LAST 12 RUNS',chartX,chartY-3);
        const entries=serverSettings.show_chart ? performanceRows.slice(0,12).reverse() : [];
        node._batchPerformanceBarsHit=[];
        if(entries.length){
            const max=Math.max(1,...entries.map(r=>Number(r.duration_ms)||0));
            const gap=4, barW=Math.max(3,(chartW-gap*(entries.length-1))/entries.length);
            entries.forEach((record,i)=>{
                const ms=Number(record.duration_ms)||0;
                const barH=Math.max(2,(Math.max(0,ms)/max)*42);
                const bx=chartX+i*(barW+gap), by=chartY+43-barH;
                ctx.fillStyle=i===entries.length-1 ? accent : '#275977';
                ctx.fillRect(bx,by,barW,barH);
                node._batchPerformanceBarsHit.push({x:bx,y:chartY,w:barW,h:46,record});
            });
            ctx.font='9px monospace';ctx.textAlign='right';ctx.fillStyle='#8495a6';
            ctx.fillText('MAX '+formatStatisticsTime(max),right-10,chartY+55);
        } else {
            ctx.fillStyle='#687d90';ctx.fillText(serverSettings.show_chart?'No runs recorded yet':'Chart hidden in settings',chartX,chartY+35);
        }
        ctx.font='10px monospace'; ctx.textAlign='left';
        const todayFails=(statsFailures || {}).today || {};
        if(serverSettings.show_failures){
            ctx.fillStyle='#e1b18c';
            ctx.fillText(`TODAY: FAILED ${todayFails.failed||0} · INTERRUPTED ${todayFails.interrupted||0} · LOST ${formatStatisticsTime(todayFails.lost_ms||0)}`,x+12,y+269);
        }
        if(serverSettings.performance_enabled && statsPerformance?.status==='ok'){
            const delta=Number(statsPerformance.delta_percent)||0;
            ctx.fillStyle=statsPerformance.slower?'#f2ae83':'#779ca8';
            ctx.fillText(statsPerformance.slower ? `SLOWDOWN +${delta.toFixed(1)}% vs ${statsPerformance.samples} comparable runs` :
                `PERFORMANCE ${delta >=0?'+':''}${delta.toFixed(1)}% · ${statsPerformance.samples} matched runs`,x+12,y+288);
        }else if(serverSettings.performance_enabled && statsPerformance?.status==='insufficient_data'){
            ctx.fillStyle='#657d8f';ctx.fillText(`Performance baseline: ${statsPerformance.samples}/${statsPerformance.min_samples} comparable runs`,x+12,y+288);
        }
        // GPU & VRAM and tool launchers live in their own independently sized modules.
        // No GPU telemetry or popup buttons are drawn inside Generation Statistics.
    } finally {ctx.restore();}
}
// Independent GPU telemetry strip, removable via Settings without affecting Monitor popup.
function drawGpuMonitor(ctx, node) {
    node._batchGpuCollapseHit = null;
    node._batchGpuOpenHit = null;
    if (!serverSettings.show_gpu_panel) return;
    const h = gpuHeight(node), x = 10, y = node.size[1] - TOOLS_HEIGHT - h;
    const width = Math.max(40, node.size[0] - 20), right = x + width;
    const accent = node.properties?.activeColor || '#00BFFF';
    const collapsed = !!node.properties?.batchGpuCollapsed;
    const g = gpuState || {};
    ctx.save();
    try {
        ctx.fillStyle = '#060b10'; ctx.fillRect(x,y,width,h-8);
        ctx.strokeStyle = '#2b4253'; ctx.lineWidth = 1;
        ctx.strokeRect(x+.5,y+.5,width-1,h-9);
        ctx.font = 'bold 11px monospace'; ctx.textAlign = 'left'; ctx.fillStyle = accent;
        ctx.fillText((collapsed?'▸ ':'▾ ')+'GPU & VRAM MONITOR',x+10,y+19);
        node._batchGpuCollapseHit={x:x+5,y:y+3,w:197,h:24};
        ctx.textAlign='right';ctx.font='10px monospace';ctx.fillStyle='#94bbcb';
        ctx.fillText('DETAILS ↗',right-12,y+19);
        node._batchGpuOpenHit={x:right-95,y:y+3,w:89,h:25};
        if(collapsed)return;
        ctx.strokeStyle='#294050';ctx.beginPath();ctx.moveTo(x+10,y+28);ctx.lineTo(right-10,y+28);ctx.stroke();
        const name = g.available ? String(g.name || 'GPU detected') : 'GPU telemetry unavailable';
        const maxName = Math.max(22,Math.floor((width-27)/6.6));
        ctx.textAlign='left';ctx.font='9px monospace';ctx.fillStyle='#7f9cb0';
        ctx.fillText(name.length>maxName?name.slice(0,maxName-1)+'…':name,x+13,y+42);
        const barX=x+125,barW=Math.max(35,width-198),valX=right-12;
        function metric(label,val,ratio,top,color){
            ctx.textAlign='left';ctx.font='10px monospace';ctx.fillStyle='#b2c8d7';
            ctx.fillText(label,x+13,y+top+9);
            ctx.fillStyle='#162731';ctx.fillRect(barX,y+top+2,barW,8);
            if(Number.isFinite(ratio)){
                ctx.fillStyle=color;ctx.fillRect(barX,y+top+2,Math.max(0,Math.min(1,ratio))*barW,8);
            }
            ctx.textAlign='right';ctx.fillStyle='#d4e3ed';ctx.fillText(val,valX,y+top+9);
        }
        const util=Number(g.gpu_util_pct);
        metric('GPU LOAD',Number.isFinite(util)&&g.gpu_util_pct!=null ? `${util.toFixed(0)}%`:'N/A',
            g.gpu_util_pct!=null && Number.isFinite(util)?util/100:null,46,'#31d5ad');
        const used=Number(g.vram_used_bytes),total=Number(g.vram_total_bytes);
        metric('VRAM',g.vram_used_bytes!=null&&g.vram_total_bytes!=null&&total>0 ?
            `${(used/1073741824).toFixed(1)}/${(total/1073741824).toFixed(1)}G` : 'N/A',
            g.vram_used_bytes!=null&&total>0?used/total:null,69,'#41bde8');
        const temp=Number(g.temp_c);
        metric('TEMP',g.temp_c!=null&&Number.isFinite(temp)?`${temp.toFixed(0)}°C`:'N/A',
            null,92,'#e8b45c');
        ctx.font='9px monospace';ctx.textAlign='left';ctx.fillStyle='#688393';
        ctx.fillText('Live device readings · click DETAILS for storage',x+13,y+123);
    } finally { ctx.restore(); }
}

// Always-visible launcher module: available even when Generation Statistics is collapsed.
function drawTools(ctx,node){
    const h=TOOLS_HEIGHT,x=10,y=node.size[1]-h,w=Math.max(40,node.size[0]-20),right=x+w;
    const accent=node.properties?.activeColor || '#00BFFF';
    const controls=[['SETTINGS','settings'],['FAILURES','failures'],
        ['ANALYTICS','analytics'],['MONITOR','monitor']];
    node._batchToolActions=[];
    ctx.save();
    try{
        ctx.fillStyle='#070c13';ctx.fillRect(x,y,w,h-8);
        ctx.strokeStyle='#354454';ctx.strokeRect(x+.5,y+.5,w-1,h-9);
        ctx.font='bold 11px monospace';ctx.fillStyle=accent;ctx.textAlign='left';
        ctx.fillText('TOOLS & PANELS',x+10,y+18);
        ctx.font='9px monospace';ctx.fillStyle='#7896a8';ctx.textAlign='right';
        ctx.fillText('click to open ↗',right-10,y+18);
        const gap=7,innerX=x+10,usable=w-20,btnW=(usable-gap*3)/4,btnY=y+30,btnH=33;
        controls.forEach(([label,code],i)=>{
            const bx=innerX+(btnW+gap)*i;
            ctx.fillStyle='#13212b';ctx.fillRect(bx,btnY,btnW,btnH);
            ctx.strokeStyle='#3e667b';ctx.strokeRect(bx+.5,btnY+.5,btnW-1,btnH-1);
            ctx.fillStyle='#cee6f3';ctx.font='bold 10px monospace';ctx.textAlign='center';
            ctx.fillText(label,bx+btnW/2,btnY+20);
            node._batchToolActions.push({x:bx,y:btnY,w:btnW,h:btnH,code});
        });
        ctx.font='9px monospace';ctx.textAlign='left';
        ctx.fillStyle=databaseStatus==='DATABASE OK'?'#45dbaa':
            databaseStatus==='CHECKING'?'#91a5b6':'#e5a46f';
        ctx.fillText('● '+databaseStatus,x+11,y+72);

    }finally{ctx.restore();}
}

function baseMinimumHeight(node) {
    let widgetBottom = 70;
    for (const w of node.widgets || []) {
        if (!Number.isFinite(w.last_y)) continue;
        let h = 24;
        try { const s = w.computeSize?.(); if (Number.isFinite(s?.[1])) h = s[1]; } catch (_) {}
        widgetBottom = Math.max(widgetBottom, w.last_y + h);
    }
    return Math.max(235, widgetBottom + 145);
}
function drawHistory(ctx, node) {
    const h = historyHeight(node);
    const x = 10, y = node.size[1] - TOOLS_HEIGHT - gpuHeight(node) - statsHeight(node) - h;
    const width = Math.max(40, node.size[0] - 20), right = x + width;
    const rows = history.slice(0, visibleRows());
    const collapsed = !!node.properties?.batchHistoryCollapsed;
    const accent = node.properties?.activeColor || "#00BFFF";
    node._batchHistoryRowsHit = [];
    ctx.save();
    try {
        ctx.fillStyle = "#050608";
        ctx.fillRect(x, y, width, h - 8);
        ctx.strokeStyle = "#262C34"; ctx.lineWidth = 1;
        ctx.strokeRect(x + .5, y + .5, width - 1, h - 9);
        ctx.font = "bold 11px monospace"; ctx.textAlign = "left"; ctx.fillStyle = accent;
        ctx.fillText((collapsed ? '▸ ' : '▾ ') + 'RECENT GENERATIONS', x + 10, y + 19);
        node._batchHistoryCollapseHit = {x:x+5,y:y+4,w:180,h:24};
        if (collapsed) {node._batchHistoryClearHit=null;node._batchHistoryGalleryHit=null;return;}
        ctx.font='10px monospace';ctx.fillStyle='#8dbad4';ctx.textAlign='right';
        ctx.fillText('GALLERY',right-62,y+19);
        node._batchHistoryGalleryHit={x:right-115,y:y+5,w:63,h:20};
        ctx.font = "10px monospace"; ctx.textAlign = "right";
        ctx.fillStyle = rows.length ? "#C6CDD6" : "#57616E";
        ctx.fillText("CLEAR", right - 12, y + 19);
        const clearW = ctx.measureText("CLEAR").width;
        node._batchHistoryClearHit = { x: right - 16 - clearW, y: y + 6, w: clearW + 9, h: 19 };
        ctx.strokeStyle = "#26313C"; ctx.beginPath(); ctx.moveTo(x + 10, y + 28); ctx.lineTo(right - 10, y + 28); ctx.stroke();
        ctx.font = "10px monospace";
        if (!rows.length) {
            ctx.fillStyle = "#88939F"; ctx.textAlign = "center";
            ctx.fillText("No completed generations yet", x + width / 2, y + 65);
        } else {
            rows.forEach((row, i) => {
                const baseline = y + 44 + i * 14;
                const area = { x: x + 7, y: baseline - 10, w: width - 14, h: 14 };
                node._batchHistoryRowsHit.push({ ...area, key: rowKey(row), index: i });
                if (i === node._batchHistoryHoverIndex) {
                    ctx.fillStyle = "#193047"; ctx.fillRect(area.x, area.y, area.w, area.h);
                } else if (i % 2 === 0) {
                    ctx.fillStyle = "#0C1219"; ctx.fillRect(area.x, area.y, area.w, area.h);
                }
                ctx.textAlign = "left"; ctx.fillStyle = i === 0 ? accent : "#9DA8B4";
                ctx.fillText(String(i + 1).padStart(2, "0") + ".", x + 10, baseline);
                ctx.fillStyle = "#CBD4DC"; ctx.fillText(formatTime(row.when), x + 35, baseline);
                ctx.textAlign = "right"; ctx.fillStyle = i === 0 ? accent : "#E1E7ED";
                const count = countForRow(row);
                const time = count ? formatDuration(row.durationMs / count) : formatDuration(row.durationMs);
                ctx.fillText(time + (count ? `   ×${count}` : "   old"), right - 10, baseline);
            });
        }
        ctx.strokeStyle = "#26313C"; ctx.beginPath(); ctx.moveTo(x + 10, y + 188 + 14*(visibleRows()-10)); ctx.lineTo(right - 10, y + 188 + 14*(visibleRows()-10)); ctx.stroke();
        ctx.textAlign = "left"; ctx.font = "10px monospace"; ctx.fillStyle = "#86919C";
        ctx.fillText(`LAST ${rows.length} / ${visibleRows()}  ·  PER IMAGE`, x + 10, y + 202 + 14*(visibleRows()-10));
        const measurements = rows.map(perImageMs).filter(n => n !== null);
        if (measurements.length) {
            const fast = Math.min(...measurements);
            const avg = measurements.reduce((sum, n) => sum + n, 0) / measurements.length;
            const slow = Math.max(...measurements);
            const items = [["FAST", fast, "#73D7AE"], ["AVG", avg, "#C8D3DF"], ["SLOW", slow, "#E5B381"]];
            const cellWidth = (width - 16) / 3;
            const font = width >= 350 ? 10 : 9;
            ctx.font = `${font}px monospace`; ctx.textAlign = "center";
            items.forEach(([label, duration, color], i) => {
                ctx.fillStyle = color;
                ctx.fillText(`${label} ${formatDuration(duration)}`, x + 8 + (i + .5) * cellWidth, y + 221 + 14*(visibleRows()-10));
            });
        }
    } finally { ctx.restore(); }
}

function add(tag, parent, text, css = {}) {
    const el = document.createElement(tag);
    if (text != null) el.textContent = String(text);
    Object.assign(el.style, css);
    parent.appendChild(el);
    return el;
}
function cancelHide() {
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = null;
}
function getPopup() {
    if (popup) return popup;
    popup = document.createElement("div");
    popup.setAttribute("role", "dialog");
    Object.assign(popup.style, {
        position: "fixed", zIndex: "100000", display: "none", pointerEvents: "auto",
        width: "326px", maxHeight: "min(80vh, 620px)", overflowY: "auto",
        boxSizing: "border-box", border: "1px solid #344253", borderRadius: "9px",
        padding: "12px", background: "#111820", boxShadow: "0 12px 35px rgba(0,0,0,.7)",
        color: "#dce5ee", font: "12px/1.45 sans-serif", whiteSpace: "normal",
    });
    popup.addEventListener("mouseenter", cancelHide);
    popup.addEventListener("mouseleave", () => scheduleHide());
    document.body.appendChild(popup);
    return popup;
}
function hidePopup(owner = null) {
    if (owner && popupOwner && owner !== popupOwner) return;
    cancelHide(); hoverKey = null; popupOwner = null;
    if (popup) popup.style.display = "none";
    lastHoverPosition = null;
}
function scheduleHide(owner = null) {
    if (owner && popupOwner && owner !== popupOwner) return;
    cancelHide(); hideTimer = setTimeout(() => hidePopup(owner), 500);
}
function placePopup(event) {
    if (!popup || popup.style.display === "none" || !event) return;
    lastHoverPosition = { clientX: event.clientX, clientY: event.clientY };
    const ww = window.innerWidth || 1280, wh = window.innerHeight || 800;
    const x = Number(event.clientX), y = Number(event.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const w = popup.offsetWidth || 326, h = popup.offsetHeight || 350;
    popup.style.left = Math.max(6, Math.min(x + 24, ww - w - 8)) + "px";
    popup.style.top = Math.max(6, Math.min(y - 24, wh - h - 8)) + "px";
}
function imageURL(image) {
    const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || "", type: image.type || "output" });
    return api.apiURL(`/view?${params}`);
}
function parseGraph(entry) {
    const raw = entry?.prompt;
    if (Array.isArray(raw)) return raw[2] || {};
    if (raw && typeof raw === "object") return raw.prompt || {};
    return {};
}
function directText(node) {
    const keys = ["text", "text_g", "text_l", "prompt", "positive_prompt", "negative_prompt"];
    const values = keys.map(k => node?.inputs?.[k]).filter(v => typeof v === "string" && v.trim()).map(x => x.trim());
    return [...new Set(values)].join(" / ");
}
function linkedText(graph, link, visited = new Set(), depth = 0) {
    if (!Array.isArray(link) || depth > 10) return "";
    const id = String(link[0]);
    if (visited.has(id)) return "";
    visited.add(id);
    const node = graph[id]; if (!node) return "";
    const text = directText(node); if (text) return text;
    for (const value of Object.values(node.inputs || {})) {
        const result = linkedText(graph, value, visited, depth + 1);
        if (result) return result;
    }
    return "";
}
function extractPrompts(entry) {
    const graph = parseGraph(entry), result = [], seen = new Set();
    const addUnique = (label, str) => {
        if (!str || seen.has(str)) return;
        seen.add(str); result.push({ label, text: str.slice(0, 900) + (str.length > 900 ? "…" : "") });
    };
    for (const node of Object.values(graph)) {
        if (!/sampler/i.test(node?.class_type || "")) continue;
        addUnique("POSITIVE PROMPT", linkedText(graph, node.inputs?.positive));
        addUnique("NEGATIVE PROMPT", linkedText(graph, node.inputs?.negative));
        if (result.length >= 2) break;
    }
    if (!result.length) {
        for (const node of Object.values(graph)) {
            if (!/clip.*text|prompt|textencode|conditioning/i.test(node?.class_type || "")) continue;
            addUnique("PROMPT / TEXT", directText(node));
            if (result.length >= 2) break;
        }
    }
    return result;
}
function extractPreview(entry) {
    const allImages = findImagesFromOutputs(entry?.outputs);
    return { images: allImages.slice(0, PREVIEW_LIMIT), imageCount: allImages.length, prompts: extractPrompts(entry) };
}
function workflowFromEntry(entry) {
    const raw = entry?.prompt;
    let workflow;
    if (Array.isArray(raw)) workflow = raw?.[3]?.extra_pnginfo?.workflow;
    else workflow = raw?.extra_data?.extra_pnginfo?.workflow || raw?.extra_pnginfo?.workflow;
    if (!workflow) return null;
    try {
        const parsed = typeof workflow === "string" ? JSON.parse(workflow) : workflow;
        return parsed && typeof parsed === "object" && Array.isArray(parsed.nodes) ? parsed : null;
    } catch (_) { return null; }
}
async function loadPreview(row) {
    if (!row.promptId) return;
    const key = rowKey(row);
    if (pending.has(key)) return pending.get(key);
    // Do not skip if only the preview was cached; exact workflow might be needed.
    if (row.preview && workflowCache.has(key) && row.imageCountVerified) return;
    const task = (async () => {
        // Durable fallback: the server keeps metadata/workflow even after restart
        // when ComfyUI has cleared its own in-memory /history.
        try {
            const response = await api.fetchApi(`/batch_timer/stats/detail/${encodeURIComponent(row.promptId)}`);
            if (response.ok) {
                const data = await response.json(); const saved = data?.record;
                if (saved) {
                    row.preview = {images:saved.images || [], imageCount:saved.image_count || 0,
                        prompts:saved.prompts || []};
                    row.imageCount = saved.image_count; row.imageCountVerified=!!saved.verified;
                    row.model=saved.model; row.resolution=saved.resolution;
                    row.steps=saved.steps; row.cfg=saved.cfg;
                    if (saved.workflow && Array.isArray(saved.workflow.nodes))
                        workflowCache.set(key, saved.workflow);
                    persistHistory(); redraw();
                    if (hoverKey === key) {renderPopup(row); placePopup(lastHoverPosition);}
                    // Some older ComfyUI entries have no stored frontend workflow.
                    // Continue to try the transient /history before giving up.
                    if (saved.workflow && Array.isArray(saved.workflow.nodes)) return;
                }
            }
        } catch (_) {}
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                const response = await api.fetchApi(`/history/${encodeURIComponent(row.promptId)}`);
                if (response.ok) {
                    const data = await response.json();
                    const entry = data?.[row.promptId];
                    if (entry) {
                        const preview = extractPreview(entry);
                        row.preview = preview;
                        const workflow = workflowFromEntry(entry);
                        if (workflow) workflowCache.set(key, workflow);
                        const actual = preview.imageCount;
                        const inferred = estimatePromptBatchSize(parseGraph(entry));
                        const count = actual > 0 ? actual : Math.max(inferred, countForRow(row) || 1);
                        row.imageCount = count;
                        row.imageCountVerified = actual > 0;
                        if (history[0] === row) setImageState(row.promptId, count, actual > 0 ? "actual" : "estimated", true);
                        persistHistory(); redraw();
                        if (hoverKey === key) { renderPopup(row); placePopup(lastHoverPosition); }
                        return;
                    }
                }
            } catch (_) {}
            if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
        }
        if (hoverKey === key) {
            row.preview = { unavailable: true }; renderPopup(row); placePopup(lastHoverPosition);
            delete row.preview;
        }
    })().finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
}
async function workflowForRow(row) {
    if (row.promptId && !workflowCache.has(rowKey(row))) await loadPreview(row);
    return workflowCache.get(rowKey(row)) || row.workflowSnapshot || null;
}
function transferToken() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function alertUnavailable() {
    window.alert("No saved workflow was found. You can rerun the generation with a saved workflow or recover it from PNG metadata, if available.");
}
async function loadWorkflowHere(row) {
    const data = await workflowForRow(row);
    if (!data) return alertUnavailable();
    if (!window.confirm("Load the saved workflow in this tab? The currently open workflow may be replaced.")) return;
    try { await app.loadGraphData(data, true, true); hidePopup(); }
    catch (error) { window.alert(`Unable to load workflow: ${error?.message || error}`); }
}
async function openWorkflowNewTab(row) {
    // Open synchronously during a real click. Opening only after await/fetch
    // can cause Chrome/Edge popup blocking for a valid user action.
    const opened = window.open("about:blank", "_blank");
    if (!opened) {
        window.alert("The browser blocked the new tab. Allow pop-ups for ComfyUI or use LOAD WORKFLOW.");
        return;
    }
    try {
        const data = await workflowForRow(row);
        if (!data) { opened.close(); return alertUnavailable(); }
        const token = transferToken();
        try {
            localStorage.setItem(TRANSFER_PREFIX + token, JSON.stringify({ at: Date.now(), workflow: data }));
        } catch (_) {
            opened.close();
            window.alert("The browser could not store data for the new tab (possibly a storage limit). Use LOAD WORKFLOW or download the JSON file.");
            return;
        }
        const target = new URL(window.location.href);
        target.searchParams.set(TRANSFER_PARAM, token);
        opened.location.href = target.toString();
    } catch (error) {
        opened.close();
        window.alert(`Unable to open the new tab: ${error?.message || error}`);
    }
}

async function downloadWorkflow(row) {
    const workflow = await workflowForRow(row);
    if (!workflow) return alertUnavailable();
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `batch-timer-workflow-${new Date(row.when).toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(anchor);
    anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function actionButton(parent, label, onClick) {
    const b = add("button", parent, label, {
        color: "#dce5ee", background: "#243340", border: "1px solid #395164", borderRadius: "5px",
        padding: "5px 8px", cursor: "pointer", font: "600 10px sans-serif", flex: "1 1 45%",
    });
    b.type = "button";
    b.addEventListener("click", async e => {
        e.preventDefault(); e.stopPropagation(); cancelHide();
        b.disabled = true;
        try { await onClick(); }
        catch (error) { window.alert(`Operation failed: ${error?.message || error}`); }
        finally { b.disabled = false; }
    });
    return b;
}
function renderPopup(row) {
    const el = getPopup();
    el.replaceChildren();
    add("div", el, `GENERATION  ${formatTime(row.when)}`, { color: "#57d8fb", fontWeight: "700", marginBottom: "6px" });
    const n = countForRow(row);
    add("div", el, `TIME / IMAGE  ${n ? formatDuration(row.durationMs / n) : "unknown"}`,
        { color: "#b7c4d1", marginBottom: "3px" });
    add("div", el, `TOTAL  ${formatDuration(row.durationMs)}    IMAGES  ${n || "?"}${n && !row.imageCountVerified ? " (estimated)" : ""}`,
        { color: "#8d9ba7", fontSize: "11px", marginBottom: "8px" });

    if (row.model || row.resolution) add('div', el,
        `${row.model || 'Unknown model'} · ${row.resolution || '?'}${row.steps ? ' · '+row.steps+' steps' : ''}`,
        {color:'#93aabf', fontSize:'10px', marginBottom:'6px', overflowWrap:'anywhere'});
    if (row.preview?.images?.length) {
        const pics = row.preview.images;
        const frame = add("div", el, null, { margin: "4px 0 8px", borderRadius: "6px", background: "#06090d", textAlign: "center", overflow: "hidden" });
        const img = add("img", frame, null, { display: "block", width: "100%", height: "182px", objectFit: "contain" });
        img.alt = "ComfyUI generated output"; img.src = imageURL(pics[0]);
        img.onerror = () => { img.style.display = "none"; add("div", frame, "The image is no longer available.", { padding: "20px", color: "#e5b381" }); };
        if (row.preview.imageCount > 1) add("div", el, `${row.preview.imageCount} images in this run (showing the first image)`, { color: "#8d9ba7", fontSize: "11px", marginBottom: "7px" });
    } else if (row.preview?.unavailable) {
        add("div", el, "ComfyUI history is currently unavailable.", { color: "#e5b381" });
    } else if (!row.preview) {
        add("div", el, row.promptId ? "Loading image and prompt…" : "Older record without a saved prompt ID.", { color: "#a8b1bb", marginBottom: "7px" });
    } else {
        add("div", el, "No saved images found (for example, no Save Image node).", { color: "#aab4c0" });
    }

    const prompts = row.preview?.prompts || [];
    if (prompts.length) {
        prompts.slice(0, 2).forEach(part => {
            add("div", el, part.label, { color: "#57d8fb", fontWeight: "700", fontSize: "11px", marginTop: "5px" });
            const textBox = add("div", el, part.text, {
                fontSize: "11px", color: "#d5dde6", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
                maxHeight: "76px", overflow: "hidden",
            });
            textBox.title = part.text;
        });
    }

    const actions = add("div", el, null, { display: "flex", flexWrap: "wrap", gap: "5px", marginTop: "12px" });
    actionButton(actions, "LOAD WORKFLOW", () => loadWorkflowHere(row));
    actionButton(actions, "OPEN IN NEW TAB", () => openWorkflowNewTab(row));
    actionButton(actions, "SAVE WORKFLOW JSON", () => downloadWorkflow(row));
    if (prompts.length) actionButton(actions, "COPY PROMPT", async () => {
        await navigator.clipboard.writeText(prompts.map(p => `${p.label}\n${p.text}`).join("\n\n"));
    });
    if (row.preview?.images?.length) actionButton(actions, "OPEN IMAGE", () => {
        window.open(imageURL(row.preview.images[0]), "_blank");
    });
    add("div", el, "Hover to preview · Click a button to open the workflow", { color: "#78899a", fontSize: "10px", marginTop: "8px" });
}
function hoverRow(node, row, event) {
    cancelHide();
    const key = rowKey(row);
    if (hoverKey !== key || popupOwner !== node) {
        hoverKey = key; popupOwner = node;
        renderPopup(row); getPopup().style.display = "block";
        if (row.promptId && (!row.preview || !workflowCache.has(key))) void loadPreview(row);
    }
    placePopup(event);
}
function installOnNode(node) {
    if (!node || node.comfyClass !== "BatchImageTimer") return false;
    if (node.onDrawBackground?.[HOOK_MARK]) return true;
    const previousDraw = node.onDrawBackground;
    if (typeof previousDraw !== "function") return false;
    const wrappedDraw = function(ctx, ...args) {
        const actualHeight = this.size[1];
        this.size[1] = Math.max(120, actualHeight - extensionHeight(this));
        try { previousDraw.call(this, ctx, ...args); }
        finally { this.size[1] = actualHeight; }
        drawHistory(ctx, this);
        drawStatistics(ctx, this);
        drawGpuMonitor(ctx, this);
        drawTools(ctx, this);
    };
    wrappedDraw[HOOK_MARK] = true;
    node.onDrawBackground = wrappedDraw;
    const prevDown = node.onMouseDown;
    node.onMouseDown = function(event, pos, ...args) {
        if (hit(pos, this._batchHistoryCollapseHit)) {togglePanel(this,'batchHistoryCollapsed'); return true;}
        if (hit(pos,this._batchHistoryGalleryHit)) {
            void openGallery({limit:serverSettings.gallery_limit,imageURL,rowFromServer,loadWorkflowHere,openWorkflowNewTab});
            return true;
        }
        const toolAction=this._batchToolActions?.find(a=>hit(pos,a));
        if(toolAction){
            if(toolAction.code==='settings')void openSettings(serverSettings,applyServerSettings);
            if(toolAction.code==='failures')void openFailures();
            if(toolAction.code==='analytics')openAnalytics(analyticsOptions());
            if(toolAction.code==='monitor')openHardwarePanel(getDateStarts);
            return true;
        }
        if(hit(pos,this._batchGpuOpenHit)){openHardwarePanel(getDateStarts);return true;}
        if(hit(pos,this._batchGpuCollapseHit)){togglePanel(this,'batchGpuCollapsed');return true;}
        if (hit(pos, this._batchStatsCollapseHit)) {togglePanel(this,'batchStatsCollapsed'); return true;}
        const chart=this._batchPerformanceBarsHit?.find(a=>hit(pos,a));
        if(chart){hideChartTooltip();void openRunDetails(chart.record,analyticsOptions());return true;}
        const action = this._batchStatsActions?.find(a => hit(pos,a));
        if (action) {
            if (action.code==='roll') {statsMode=statsMode==='rolling'?'calendar':'rolling'; redraw();}
            else if (action.code==='day') chooseDay();
            else if (action.code==='models') {statsMode='models'; void fetchModels();}
            else if (action.code==='csv') void exportCSV().catch(e=>window.alert('CSV: '+e.message));
            return true;
        }
        if (hit(pos, this._batchHistoryClearHit)) {
            history = []; // Persistent performance chart is unaffected by CLEAR.
            hidePopup(this); this._batchHistoryHoverIndex = -1;
            persistHistory(); redraw();
            void api.fetchApi('/batch_timer/stats/clear_recent', {method:'POST'}).then(() => refreshRecent());
            return true;
        }
        return prevDown?.call(this, event, pos, ...args);
    };
    const prevMove = node.onMouseMove;
    node.onMouseMove = function(event, pos, ...args) {
        prevMove?.call(this, event, pos, ...args);
        const chart=this._batchPerformanceBarsHit?.find(a=>hit(pos,a));
        if(chart)showChartTooltip(chart.record,event);else hideChartTooltip();
        const area = this._batchHistoryRowsHit?.find(a => hit(pos, a));
        const nextIndex = area ? area.index : -1;
        if (this._batchHistoryHoverIndex !== nextIndex) { this._batchHistoryHoverIndex = nextIndex; redraw(); }
        if (area) {
            if (app.canvas?.canvas && !(app.canvas.canvas.style.cursor || "").includes("resize")) app.canvas.canvas.style.cursor = "pointer";
            const row = history[area.index];
            if (row && rowKey(row) === area.key) hoverRow(this, row, event);
        } else scheduleHide(this);
        if ((hit(pos,this._batchHistoryGalleryHit) || hit(pos, this._batchHistoryClearHit) || hit(pos, this._batchStatsCollapseHit) ||
             hit(pos, this._batchHistoryCollapseHit) || this._batchStatsActions?.some(a=>hit(pos,a)) ||
             this._batchToolActions?.some(a=>hit(pos,a)) ||
             hit(pos,this._batchGpuCollapseHit) || hit(pos,this._batchGpuOpenHit) ||
             this._batchPerformanceBarsHit?.some(a=>hit(pos,a))) && app.canvas?.canvas) app.canvas.canvas.style.cursor = "pointer";
    };
    const prevLeave = node.onMouseLeave;
    node.onMouseLeave = function(...args) {
        this._batchHistoryHoverIndex = -1; hideChartTooltip(); scheduleHide(this); redraw();
        return prevLeave?.apply(this, args);
    };
    const prevResize = node.onResize;
    node.onResize = function(size, ...args) {
        const result = prevResize?.call(this, size, ...args);
        this.size[0] = Math.max(this.size[0], 410);
        this.size[1] = Math.max(this.size[1], baseMinimumHeight(this) + extensionHeight(this));
        return result;
    };
    node.size[0] = Math.max(410, node.size[0]);
    node.size[1] = Math.max(node.size[1], baseMinimumHeight(node) + extensionHeight(node));
    redraw();
    return true;
}
function scheduleInstall(node) {
    if (node?.comfyClass !== "BatchImageTimer") return;
    let attempts = 0;
    function tryInstall() { if (installOnNode(node)) return; if (++attempts < 12) setTimeout(tryInstall, 40); }
    setTimeout(tryInstall, 0);
}

// A new ComfyUI tab can import an exact workflow snapshot transferred by this extension.
// The payload is short-lived, same-origin localStorage; never sent to a remote server.
function maybeImportTransferredWorkflow() {
    const url = new URL(window.location.href);
    const token = url.searchParams.get(TRANSFER_PARAM);
    if (!token) return;
    const storageKey = TRANSFER_PREFIX + token;
    let payload;
    try { payload = JSON.parse(localStorage.getItem(storageKey) || "null"); } catch (_) {}
    try { localStorage.removeItem(storageKey); } catch (_) {}
    url.searchParams.delete(TRANSFER_PARAM);
    window.history.replaceState(null, "", url.toString());
    if (!payload?.workflow || Date.now() - payload.at > 5 * 60 * 1000) {
        window.alert("No workflow was found to open, or the transfer data has expired.");
        return;
    }
    let attempts = 0;
    const tryLoad = async () => {
        if (!app.graph || !app.canvas || typeof app.loadGraphData !== "function") {
            if (++attempts < 50) setTimeout(tryLoad, 250);
            return;
        }
        try {
            // Give ComfyUI time to initialize/load its default workflow.
            await new Promise(resolve => setTimeout(resolve, 650));
            await app.loadGraphData(payload.workflow, true, true);
        } catch (error) { window.alert(`Unable to open workflow: ${error?.message || error}`); }
    };
    setTimeout(tryLoad, 450);
}

app.registerExtension({
    name: "BatchImageTimer.GenerationMonitorV192",
    setup() {
        api.addEventListener("execution_start", onExecutionStart);
        api.addEventListener("batch_timer_update", onBatchTimerUpdate);
        api.addEventListener("execution_success", onExecutionSuccess);
        api.addEventListener("execution_interrupted", () => { activePrompt = null; });
        api.addEventListener("execution_error", () => { activePrompt = null; });
        maybeImportTransferredWorkflow();
        installNotifications();
        void loadServerSettings(); void refreshDatabaseStatus();
        void refreshStatistics(); void refreshRecent(); void refreshPerformance();
        if(serverSettings.show_gpu_panel) void refreshGpuState();
        // Data is written server-side; periodic reads work even after page reload.
        setInterval(() => { if (!document.hidden) void refreshRecent(); }, 6000);
        setInterval(() => { if (!document.hidden) void refreshPerformance(); }, 10000);
        setInterval(() => { if (!document.hidden) void refreshStatistics(); }, 30000);
        setInterval(() => { if (!document.hidden && serverSettings.show_gpu_panel && serverSettings.gpu_enabled) void refreshGpuState(); }, 4500);
        setInterval(() => { if (!document.hidden) void refreshDatabaseStatus(); }, 20000);
    },
    nodeCreated: scheduleInstall,
    loadedGraphNode: scheduleInstall,
});
