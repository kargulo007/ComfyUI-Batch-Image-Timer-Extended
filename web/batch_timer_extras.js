/**
 * Extended modifications: Copyright (c) 2026 Piotr Karwowski. Optional tools for Batch Image Timer v1.7: settings, gallery, failures and notices.
 *  Uses only ComfyUI's existing same-origin API; no external libraries or CDNs.
 */
import { api } from "/scripts/api.js";
import { openAnalytics } from "./batch_timer_analytics.js";

const COLOR = '#54d9ff';
const NOTICE_KEY = 'comfy.batch_timer.v17.notifications';
const prefs = (() => {
    const defaults = {enabled:false, sound:false, soundVolume:70};
    try {
        const value = {...defaults, ...JSON.parse(localStorage.getItem(NOTICE_KEY) || '{}')};
        value.soundVolume = safeVolume(value.soundVolume);
        return value;
    } catch (_) { return {...defaults}; }
})();
function safeVolume(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 70;
}

function elt(tag, parent, text, style={}) {
    const el = document.createElement(tag);
    if (text !== undefined && text !== null) el.textContent = String(text);
    Object.assign(el.style, style);
    if (parent) parent.appendChild(el);
    return el;
}
function button(parent, title, onClick) {
    const b=elt('button',parent,title,{background:'#183246',color:'#e4f4ff',border:'1px solid #45667c',
        borderRadius:'5px',padding:'7px 10px',cursor:'pointer',fontSize:'12px'});
    b.type='button';b.onclick=onClick;return b;
}
function modal(title, width=730) {
    const shade=elt('div',document.body,null,{position:'fixed',inset:'0',zIndex:'100200',
        background:'rgba(0,0,0,.76)',display:'flex',alignItems:'center',justifyContent:'center',padding:'16px'});
    const body=elt('section',shade,null,{width:`min(100%, ${width}px)`,maxHeight:'90vh',overflowY:'auto',
        color:'#d6e5f2',font:'13px/1.45 sans-serif',background:'#0e1822',border:'1px solid #34546a',
        borderRadius:'12px',boxShadow:'0 15px 45px rgba(0,0,0,.65)',padding:'20px',boxSizing:'border-box'});
    const head=elt('div',body,null,{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'15px',gap:'10px'});
    elt('strong',head,title,{color:COLOR,fontSize:'17px'});
    function close(){ document.removeEventListener('keydown',esc);shade.remove(); }
    function esc(e){if(e.key==='Escape')close();}
    document.addEventListener('keydown',esc);
    shade.addEventListener('pointerdown',e=>{if(e.target===shade)close();});
    button(head,'CLOSE ✕',close);
    return {body,close};
}
async function fetchJSON(path,options) {
    const resp=await api.fetchApi(path,options);
    if(!resp.ok) throw new Error(`${path} (HTTP ${resp.status})`);
    const data=await resp.json();
    if(!data.ok) throw new Error(data.error || path);
    return data;
}
const grid={display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))',gap:'12px'};
function format(ms){
    const sec=Math.round((ms||0)/1000),m=Math.floor(sec/60),h=Math.floor(m/60);
    return h ? `${h}h ${m%60}m ${sec%60}s` : `${m}m ${sec%60}s`;
}

export async function openGallery({limit=30, imageURL, rowFromServer, loadWorkflowHere, openWorkflowNewTab}) {
    const {body}=modal('RECENT GENERATIONS · GALLERY',920);
    const info=elt('div',body,'Loading images from ComfyUI history…',{color:'#91aabd',marginBottom:'12px'});
    const gallery=elt('div',body,null,grid);
    try {
        const data=await fetchJSON(`/batch_timer/stats/recent?limit=${Math.max(10,Math.min(50,limit))}`);
        const tiles=[];
        for(const record of data.entries){
            const row=rowFromServer(record);
            for(const image of (record.images || [])){
                tiles.push({row,image});
                if(tiles.length>=limit)break;
            }
            if(tiles.length>=limit)break;
        }
        info.textContent=`${tiles.length} recent images from ${data.entries.length} recorded runs · original files stored on the server.`;
        if(!tiles.length) {elt('div',gallery,'No images available.');return;}
        for(const {row,image} of tiles){
            const card=elt('article',gallery,null,{border:'1px solid #304759',borderRadius:'9px',
                background:'#0b111a',padding:'8px',minWidth:0});
            const pic=elt('img',card,null,{width:'100%',height:'130px',objectFit:'contain',background:'#080b10',borderRadius:'5px'});
            pic.src=imageURL(image);pic.alt='Saved ComfyUI image';pic.loading='lazy';
            pic.onerror=()=>{pic.style.display='none';elt('small',card,'Image unavailable',{color:'#e5a97c'});};
            elt('div',card,new Date(row.when).toLocaleString('en-GB'),{fontSize:'11px',color:'#9ab4c5',marginTop:'7px'});
            elt('div',card,`RUN ${format(row.durationMs)} · ${row.imageCount || '?'} images`,{fontSize:'11px',margin:'6px 0'});
            const details=elt('details',card,null,{margin:'7px 0',fontSize:'11px'});
            elt('summary',details,'PROMPT',{cursor:'pointer',color:COLOR});
            elt('div',details,(row.preview?.prompts||[]).map(p=>p.text).join(' / ').slice(0,600) || 'Prompt unavailable',
                {whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'110px',overflowY:'auto'});
            const controls=elt('div',card,null,{display:'flex',flexWrap:'wrap',gap:'5px'});
            button(controls,'LOAD',()=>loadWorkflowHere(row));
            button(controls,'NEW TAB',()=>openWorkflowNewTab(row));
            button(controls,'IMAGE',()=>window.open(imageURL(image),'_blank','noopener,noreferrer'));
        }
    }catch(e){info.textContent='Unable to load gallery: '+e.message;}
}

export async function openFailures() {
    const {body}=modal('FAILED & INTERRUPTED GENERATIONS',780);
    const info=elt('div',body,'Loading…',{marginBottom:'12px',color:'#9bb3c4'});
    button(body,'EXPORT FAILURES CSV',()=>window.open(api.apiURL('/batch_timer/stats/failures.csv'), '_blank','noopener,noreferrer'));
    const items=elt('div',body,null,{marginTop:'14px',display:'grid',gap:'9px'});
    try{
        const data=await fetchJSON('/batch_timer/stats/failures?limit=50');
        info.textContent=`Last ${data.entries.length} failed or interrupted runs. Lost time is calculated only when reliable timestamps are available.`;
        if(!data.entries.length){elt('div',items,'No failed or interrupted runs recorded.');return;}
        for(const f of data.entries){
            const card=elt('div',items,null,{padding:'10px',background:'#111f2a',border:'1px solid #394857',borderRadius:'6px'});
            elt('strong',card,`${String(f.result).toUpperCase()} · ${new Date(f.finished_ms).toLocaleString('en-GB')}`,
                {color:f.result==='failed'?'#f3a19a':'#f3d09b'});
            elt('div',card,`Duration: ${f.duration_source==='events'?format(f.duration_ms):'unavailable'} · ${f.model || 'Unknown model'}`,
                {color:'#9eb4c4',fontSize:'11px',marginTop:'4px',overflowWrap:'anywhere'});
            if(f.error_text)elt('div',card,f.error_text,{whiteSpace:'pre-wrap',overflowWrap:'anywhere',marginTop:'4px'});
        }
    }catch(e){info.textContent='Unable to load failures: '+e.message;}
}

function field(parent, name, text, value, min, max, help) {
    const line=elt('label',parent,null,{display:'flex',alignItems:'center',gap:'10px',
        padding:'8px 0',borderBottom:'1px solid #213647',justifyContent:'space-between'});
    const title=elt('div',line,null);
    elt('strong',title,text,{display:'block'});
    if(help)elt('small',title,help,{display:'block',color:'#849aac'});
    const el=elt('input',line,null,{width:'75px',textAlign:'right',background:'#071018',color:'#e9f4fa',
        border:'1px solid #375066',borderRadius:'4px',padding:'7px'});
    el.type='number';el.min=min;el.max=max;el.step=1;el.value=value;el.dataset.setting=name;
    return el;
}
function toggle(parent,name,text,value,help){
    const line=elt('label',parent,null,{display:'flex',justifyContent:'space-between',alignItems:'center',
        gap:'10px',padding:'8px 0',borderBottom:'1px solid #213647',cursor:'pointer'});
    const title=elt('div',line,null);elt('strong',title,text,{display:'block'});
    if(help)elt('small',title,help,{display:'block',color:'#849aac'});
    const el=elt('input',line);el.type='checkbox';el.checked=!!value;el.dataset.setting=name;
    return el;
}
export async function openSettings(current, onSave){
    const {body}=modal('BATCH IMAGE TIMER · SETTINGS v1.9.3',740);
    const message=elt('div',body,'Settings are stored on the ComfyUI server alongside the SQLite database.',
        {color:'#94b3c9',fontSize:'12px',marginBottom:'12px'});
    const navigation=elt('div',body,null,{display:'flex',gap:'8px',marginBottom:'13px',flexWrap:'wrap'});
    const tabs={}; const tabButtons={};
    for(const [key,title] of [['monitor','MONITOR'],['data','DATA'],['system','SYSTEM']]){
        tabs[key]=elt('div',body,null,{display:'none'});
        tabButtons[key]=button(navigation,title,()=>selectTab(key));
    }
    // Keep navigation ahead of tab content without changing the modal structure.
    for(const key of ['monitor','data','system'])body.appendChild(tabs[key]);
    function selectTab(key){
        for(const id of Object.keys(tabs)){
            tabs[id].style.display=id===key?'block':'none';
            tabButtons[id].style.background=id===key?'#256282':'#183246';
        }
        if(key==='system')void updateSystemStatus();
    }
    const s={...current};
    const controls={};
    const monitor=tabs.monitor;
    const fields=elt('div',monitor);
    elt('h3',fields,'History & Performance',{fontSize:'14px',color:COLOR});
    controls.history_rows=field(fields,'history_rows','Visible history entries',s.history_rows,5,20);
    controls.gallery_limit=field(fields,'gallery_limit','Gallery size',s.gallery_limit,10,50);
    controls.performance_enabled=toggle(fields,'performance_enabled','Warn about slow rendering',s.performance_enabled);
    controls.performance_threshold=field(fields,'performance_threshold','Slowdown threshold (%)',s.performance_threshold,10,100);
    controls.performance_min_samples=field(fields,'performance_min_samples','Minimum comparable runs',s.performance_min_samples,3,15);
    controls.show_chart=toggle(fields,'show_chart','Show performance chart',s.show_chart);
    controls.show_failures=toggle(fields,'show_failures','Show failure counter',s.show_failures);
    elt('h3',fields,'GPU & VRAM MONITOR',{fontSize:'14px',color:'#40deb0',marginTop:'21px'});
    // User-requested order: Show GPU first, Enable Monitoring immediately underneath.
    controls.show_gpu_panel=toggle(fields,'show_gpu_panel','Show GPU & VRAM Monitor',s.show_gpu_panel,
        'Show or hide the separate GPU panel in this node.');
    controls.gpu_enabled=toggle(fields,'gpu_enabled','Enable GPU Monitoring',s.gpu_enabled !== false,
        'Enable or disable NVIDIA GPU polling, even when the panel stays visible.');
    const deviceLine=elt('label',fields,null,{display:'flex',justifyContent:'space-between',alignItems:'center',
        gap:'10px',padding:'9px 0',borderBottom:'1px solid #213647'});
    elt('strong',deviceLine,'GPU device');
    const device=elt('select',deviceLine,null,{color:'#edf4fd',background:'#0a1b28',border:'1px solid #375066',
        padding:'7px',borderRadius:'4px',maxWidth:'65%'});
    const deviceOptions=[['auto','AUTO (ComfyUI default GPU)'],['all','ALL GPUs']];
    const selectedGpu=String(s.gpu_device??'auto');
    function rebuildDeviceList(rows){
        device.replaceChildren();
        const opts=[...deviceOptions];
        for(const gpu of rows||[]){
            if(!Number.isInteger(gpu.index))continue;
            opts.push([String(gpu.index),`GPU ${gpu.index} — ${gpu.name || 'Unknown'}`]);
        }
        if(!opts.some(([val])=>val===selectedGpu))opts.push([selectedGpu,`GPU ${selectedGpu} (not detected)`]);
        for(const [value,label] of opts){
            const option=elt('option',device,label);option.value=value;
        }
        device.value=selectedGpu;
    }
    rebuildDeviceList([]);
    void fetchJSON('/batch_timer/gpu/devices').then(d=>rebuildDeviceList(d.devices)).catch(()=>{});
    controls.gpu_device=device;
    elt('small',fields,'ALL GPUs displays individual devices in the MONITOR window. Total VRAM values cover the entire selection.',
        {display:'block',color:'#809bac',marginTop:'6px'});

    elt('h3',monitor,'Notifications in this browser',{fontSize:'14px',marginTop:'22px'});
    const notify=toggle(monitor,'notify','Desktop notification',prefs.enabled,
        'Works independently of completion sounds.');
    const sound=toggle(monitor,'sound','Play sound after generation',prefs.sound);
    const volumeLine=elt('div',monitor,null,{display:'flex',flexWrap:'wrap',alignItems:'center',gap:'12px',padding:'11px 0'});
    const volumeLabel=elt('label',volumeLine,'Sound volume',{fontWeight:'bold',minWidth:'130px'});
    const volume=elt('input',volumeLine,null,{flex:'1',minWidth:'140px',accentColor:COLOR});
    volume.type='range';volume.min='0';volume.max='100';volume.step='5';volume.value=String(safeVolume(prefs.soundVolume));
    volume.id='batch-timer-sound-volume';volumeLabel.htmlFor=volume.id;
    const volumeValue=elt('strong',volumeLine,volume.value+'%',{color:COLOR});
    volume.addEventListener('input',()=>volumeValue.textContent=volume.value+'%');
    const testLine=elt('div',monitor,null,{display:'flex',alignItems:'center',gap:'12px',flexWrap:'wrap'});
    const soundTest=button(testLine,'▶ TEST SOUND',()=>{
        soundStatus.textContent='Testing sound…';
        void playTone(Number(volume.value)).then(result=>{
            soundStatus.textContent=result.ok?'Sound played successfully.':result.error;
        });
    });
    const soundStatus=elt('span',testLine,'Use this test to check whether the browser is muted.',
        {fontSize:'11px',color:'#9ab6c8'});

    const data=tabs.data;
    elt('h3',data,'Data Export & Import',{fontSize:'14px',color:COLOR});
    elt('div',data,'The export includes the SQLite database, generation history and server-side settings. It does not include image files or browser-specific sound preferences.',
        {fontSize:'12px',color:'#90aabc',marginBottom:'12px',lineHeight:'1.5'});
    const dataActions=elt('div',data,null,{display:'flex',gap:'9px',flexWrap:'wrap'});
    button(dataActions,'EXPORT ALL DATA',async()=>{
        try{
            message.textContent='Preparing export…';
            const response=await api.fetchApi('/batch_timer/stats/export_bundle');
            if(!response.ok)throw new Error(`HTTP ${response.status}`);
            const blob=await response.blob();
            const url=URL.createObjectURL(blob);
            const link=elt('a',null);link.href=url;
            link.download=`batch_timer_data_${new Date().toISOString().slice(0,10)}.zip`;
            document.body.appendChild(link);link.click();link.remove();
            setTimeout(()=>URL.revokeObjectURL(url),10000);
            message.textContent='Export ready — ZIP file downloaded.';
        }catch(error){message.textContent='Export failed: '+error.message;}
    });
    const importLine=elt('div',data,null,{marginTop:'16px',padding:'12px',background:'#101f2c',borderRadius:'6px'});
    elt('strong',importLine,'Import Data · Restore from ZIP');
    elt('p',importLine,'Import replaces the current database and settings. A safety backup is created automatically beforehand.',
        {fontSize:'11px',color:'#f0c68d'});
    const file=elt('input',importLine,null,{display:'block',width:'100%',marginBottom:'10px',fontSize:'11px'});
    file.type='file';file.accept='.zip,application/zip';
    const restore=button(importLine,'IMPORT DATA',async()=>{
        const uploaded=file.files?.[0];
        if(!uploaded){message.textContent='Please select a ZIP archive first.';return;}
        if(uploaded.size>64*1024*1024){message.textContent='File exceeds the 64 MB limit.';return;}
        if(!window.confirm('IMPORT DATA will replace the current statistics and settings on the ComfyUI server. A safety backup will be kept. Continue?'))return;
        restore.disabled=true;
        try{
            const form=new FormData();form.append('archive',uploaded,uploaded.name);
            const resp=await api.fetchApi('/batch_timer/stats/import_bundle',{
                method:'POST',headers:{'X-Batch-Timer-Confirm':'RESTORE'},body:form});
            const response=await resp.json();
            if(!resp.ok||!response.ok)throw new Error(response.error||`HTTP ${resp.status}`);
            message.textContent='Import completed. Previous database backup: '+response.safety_backup;
            onSave(response.settings);
            window.alert('Import completed. Refresh ComfyUI to load the restored statistics.');
        }catch(error){message.textContent='Import failed: '+error.message;}
        finally{restore.disabled=false;}
    });
    elt('h3',data,'Database Backups',{fontSize:'14px',marginTop:'25px'});
    controls.backups_enabled=toggle(data,'backups_enabled','Automatic daily database backup',s.backups_enabled);
    controls.backup_retention=field(data,'backup_retention','Maximum backups to retain',s.backup_retention,3,30);
    const backups=elt('div',data,'Checking backup location…',{fontSize:'11px',color:'#a9bed0',overflowWrap:'anywhere',margin:'10px 0'});
    const backupControls=elt('div',data,null,{display:'flex',flexWrap:'wrap',gap:'8px'});
    button(backupControls,'MAKE BACKUP NOW',async()=>{
        try{const result=await fetchJSON('/batch_timer/stats/backup_now',{method:'POST'});
            message.textContent=result.created?'Backup: '+result.path:result.message;await loadBackups();
        }catch(e){message.textContent='Backup error: '+e.message;}
    });
    button(backupControls,'RESTORE BACKUP',()=>openAnalytics({initialView:'backup'}));
    async function loadBackups(){
        try{const d=await fetchJSON('/batch_timer/stats/backups');
            backups.textContent=`Folder: ${d.directory} · Backups: ${d.files.length}`;
        }catch(e){backups.textContent='Backup information unavailable: '+e.message;}
    }
    void loadBackups();

    const system=tabs.system;
    elt('h3',system,'Diagnostics & Health',{fontSize:'14px',color:COLOR});
    elt('div',system,'Checks SQLite integrity, database write access, the history observer, the output directory and GPU monitor availability.',
        {fontSize:'12px',color:'#91acbf',marginBottom:'12px'});
    const status=elt('div',system,'Select RUN SYSTEM CHECK.',{background:'#0b1721',padding:'13px',
        whiteSpace:'pre-wrap',font:'12px/1.8 monospace',border:'1px solid #315066',borderRadius:'6px'});
    button(system,'RUN SYSTEM CHECK',()=>void updateSystemStatus());
    async function updateSystemStatus(){
        status.textContent='Checking system…';
        try{
            const r=await api.fetchApi('/batch_timer/stats/system_check');
            const d=await r.json();
            const lines=[
                `DATABASE       ${d.database?.ok?'OK':'ERROR'}  ${d.database?.records??'—'} runs`,
                `DATABASE WRITE ${d.database?.writable?'OK':'ERROR'}`,
                `OBSERVER       ${d.observer?.ok?'ACTIVE':'INACTIVE'}  last poll: ${d.observer?.last_poll_ms?new Date(d.observer.last_poll_ms).toLocaleTimeString('en-GB', {hour12: false}):'—'}`,
                `OUTPUT FOLDER  ${d.output?.ok?'AVAILABLE':'ERROR'}`,
                `GPU MONITOR    ${!d.gpu?.enabled?'DISABLED':d.gpu?.available?'ACTIVE':'UNAVAILABLE'}`,
                `PLUGIN FILES   ${d.files?.ok?'OK':'INCOMPLETE'}`,
                `VERSION        ${d.version||'UNKNOWN'}`,
            ];
            if(d.observer?.last_error)lines.push('OBSERVER ERROR: '+d.observer.last_error);
            if(d.files?.missing?.length)lines.push('MISSING FILES: '+d.files.missing.join(', '));
            status.textContent=lines.join('\n');
            status.style.color=d.ok?'#72e1b1':'#f0bb89';
        }catch(e){status.textContent='System check failed: '+e.message;status.style.color='#f0acac';}
    }
    const health=elt('div',system,'',{marginTop:'12px',color:'#8eabba',fontSize:'11px'});
    void fetchJSON('/batch_timer/stats/health').then(d=>{
        health.textContent=`SQLite: ${d.database_path || 'unknown'} · Observer: ${d.observer}`;
    }).catch(()=>{});

    const actions=elt('div',body,null,{display:'flex',gap:'8px',marginTop:'20px',paddingTop:'13px',borderTop:'1px solid #315066'});
    const save=button(actions,'SAVE SETTINGS',async()=>{
        save.disabled=true;
        if(sound.checked)unlockAudioFromGesture();
        try{
            const values={};
            for(const [key,control] of Object.entries(controls)){
                values[key]=control.type==='checkbox'?control.checked:
                    control.tagName==='SELECT'?control.value:Number(control.value);
            }
            const result=await fetchJSON('/batch_timer/stats/settings',{
                method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});
            prefs.enabled=notify.checked;prefs.sound=sound.checked;prefs.soundVolume=safeVolume(volume.value);
            try{localStorage.setItem(NOTICE_KEY,JSON.stringify(prefs));}catch(_){}
            if(prefs.enabled && 'Notification' in window && Notification.permission==='default'){
                try{await Notification.requestPermission();}catch(_){}
            }
            onSave(result.settings);
            message.textContent='Settings saved successfully.';
        }catch(error){message.textContent='Save error: '+error.message;}
        finally{save.disabled=false;}
    });
    selectTab('monitor');
}

let noticesInstalled=false;
let lastNoticeId=null;
let reusableAudioContext=null;

function getAudioContext() {
    try {
        const Type=window.AudioContext || window.webkitAudioContext;
        if(!Type)return null;
        if(!reusableAudioContext || reusableAudioContext.state==='closed') {
            reusableAudioContext=new Type();
        }
        return reusableAudioContext;
    } catch (_) { return null; }
}

function unlockAudioFromGesture() {
    const ctx=getAudioContext();
    if(ctx?.state==='suspended') {
        try { void ctx.resume().catch(()=>{}); } catch (_) {}
    }
}

async function playTone(volumePercent) {
    const volume=safeVolume(volumePercent);
    if(volume===0)return {ok:false,error:'Volume is set to 0%. Move the slider to the right.'};
    const ctx=getAudioContext();
    if(!ctx)return {ok:false,error:'This browser does not support Web Audio.'};
    try {
        if(ctx.state==='suspended') await ctx.resume();
        if(ctx.state!=='running')return {ok:false,error:'The browser blocked audio playback. Activate this tab and click TEST SOUND again.'};
        // Two short audible notes, with attack and fade to avoid clicks.
        // A conservative maximum peak prevents unexpectedly loud playback.
        const peak=0.20*Math.pow(volume/100,1.25);
        const start=ctx.currentTime+0.015;
        for(const [i,freq] of [784,988].entries()) {
            const osc=ctx.createOscillator();
            const gain=ctx.createGain();
            const t=start+i*0.21;
            osc.type='sine'; osc.frequency.setValueAtTime(freq,t);
            gain.gain.setValueAtTime(0.0001,t);
            gain.gain.linearRampToValueAtTime(peak,t+0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001,t+0.18);
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start(t); osc.stop(t+0.19);
            osc.onended=()=>{try{osc.disconnect();gain.disconnect();}catch(_){}};
        }
        return {ok:true};
    } catch (error) {
        return {ok:false,error:'Unable to play sound: '+(error?.message||error)};
    }
}

function notify(kind,event){
    // Browser sound and desktop notifications are independent options.
    if(!prefs.enabled && !prefs.sound)return;
    const id=event?.detail?.prompt_id || `${kind}:${Math.floor(Date.now()/1000)}`;
    const token=String(id)+kind;
    if(lastNoticeId===token)return;
    lastNoticeId=token;
    const title=kind==='success'?'ComfyUI — generation completed':kind==='error'?
        'ComfyUI — generation failed':'ComfyUI — generation interrupted';
    if(prefs.sound) void playTone(prefs.soundVolume);
    if(prefs.enabled && 'Notification' in window && Notification.permission==='granted') {
        try{new Notification(title,{body:'Batch Image Timer · open ComfyUI to see details',tag:'comfy-batch-timer'});}catch(_){}
    }
}
export function installNotifications(){
    if(noticesInstalled)return;
    noticesInstalled=true;
    // After reloading the tab, user interaction is needed to unlock Web Audio.
    // A normal click or keypress in ComfyUI primes it for later render completions.
    document.addEventListener('pointerdown',()=>{if(prefs.sound)unlockAudioFromGesture();},{passive:true});
    document.addEventListener('keydown',()=>{if(prefs.sound)unlockAudioFromGesture();},{passive:true});
    api.addEventListener('execution_success',e=>notify('success',e));
    api.addEventListener('execution_error',e=>notify('error',e));
    api.addEventListener('execution_interrupted',e=>notify('interrupted',e));
}
