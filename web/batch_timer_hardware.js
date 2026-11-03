/**
 * Extended modifications: Copyright (c) 2026 Piotr Karwowski. ComfyUI Batch Image Timer v1.9 — GPU and output storage monitor (MIT). */
import { api } from '/scripts/api.js';

const css = {color:'#d9edf8', background:'#0c151e', fontFamily:'ui-monospace,Consolas,monospace'};
function el(tag,parent,content,styles={}){
    const node=document.createElement(tag);
    if(content!==undefined && content!==null)node.textContent=String(content);
    Object.assign(node.style,styles);
    if(parent)parent.appendChild(node);
    return node;
}
async function load(path,options){
    const result=await api.fetchApi(path,options);
    if(!result.ok)throw new Error(`HTTP ${result.status}`);
    const json=await result.json();
    if(!json.ok)throw new Error(json.error||'Server returned an error');
    return json;
}
function fmtBytes(value){
    if(!Number.isFinite(Number(value)) || value==null)return '—';
    const n=Number(value);
    if(n<1024)return `${n} B`;
    const units=['KB','MB','GB','TB','PB'];let x=n,u=0;
    do{x/=1024;u++;}while(x>=1024 && u<units.length);
    return `${x.toFixed(x<10?2:1)} ${units[u-1]}`;
}
function safeNumber(value){return typeof value==='number' && Number.isFinite(value)?value:null;}
function bar(parent,text,value,max,color='#36deb0'){
    const box=el('div',parent,null,{marginBottom:'12px'});
    const line=el('div',box,null,{display:'flex',justifyContent:'space-between',gap:'8px',fontSize:'12px',marginBottom:'5px'});
    el('span',line,text);
    const label=el('b',line,'—');
    const track=el('div',box,null,{height:'8px',borderRadius:'5px',overflow:'hidden',background:'#213341'});
    const fill=el('div',track,null,{width:'0%',height:'100%',background:color,borderRadius:'5px'});
    return (v,m,formatted)=>{
        const valid=safeNumber(v)!==null && safeNumber(m)!==null && m>0;
        fill.style.width=valid?`${Math.max(0,Math.min(100,100*v/m))}%`:'0%';
        label.textContent=formatted||'—';
    };
}
function section(parent,title){
    const area=el('div',parent,null,{marginTop:'18px',paddingTop:'10px',borderTop:'1px solid #2a4356'});
    el('div',area,title,{fontSize:'12px',fontWeight:'bold',color:'#43dcb2',marginBottom:'10px'});
    return area;
}
function button(parent,text,callback){
    const b=el('button',parent,text,{cursor:'pointer',background:'#152d3f',color:'#d9f0fd',
        border:'1px solid #31506a',borderRadius:'5px',padding:'7px 12px',font:'11px monospace'});
    b.addEventListener('click',callback);return b;
}

export function openHardwarePanel(getDateStarts){
    const backdrop=el('div',document.body,null,{position:'fixed',inset:'0',background:'rgba(0,0,0,.74)',
        zIndex:'120000',display:'flex',justifyContent:'center',alignItems:'flex-start',overflowY:'auto',padding:'5vh 12px'});
    const content=el('div',backdrop,null,{...css,width:'min(650px,95vw)',maxWidth:'100%',boxSizing:'border-box',
        border:'1px solid #38586b',borderRadius:'12px',padding:'18px',boxShadow:'0 16px 60px #000b'});
    const headline=el('div',content,null,{display:'flex',justifyContent:'space-between',gap:'16px',alignItems:'center'});
    el('strong',headline,'GPU & OUTPUT STORAGE · v1.9',{color:'#41dfb1',fontSize:'15px'});
    let closed=false;let timer=null;
    const close=()=>{closed=true;if(timer)clearInterval(timer);backdrop.remove();document.removeEventListener('keydown',onKey);};
    function onKey(event){if(event.key==='Escape')close();}
    document.addEventListener('keydown',onKey);
    backdrop.addEventListener('mousedown',e=>{if(e.target===backdrop)close();});
    button(headline,'CLOSE ×',close);
    const gpuArea=section(content,'LIVE GPU MONITOR');
    const device=el('div',gpuArea,'Checking GPU…',{fontSize:'11px',color:'#8aa9b9',marginBottom:'10px'});
    const util=bar(gpuArea,'GPU LOAD',0,100);
    const vram=bar(gpuArea,'VRAM IN USE',0,1,'#4bc9fa');
    const temp=bar(gpuArea,'GPU TEMPERATURE',0,100,'#ebbd56');
    const deviceDetails=el('div',gpuArea,null,{display:'grid',gap:'5px',marginBottom:'10px'});
    const gpuHelp=el('div',gpuArea,
        'Measured GPU usage is system-wide, including other applications. Peak VRAM per run is sampled; it is not an exact memory allocation for ComfyUI.',
        {fontSize:'11px',color:'#87a3b3',lineHeight:'1.5'});
    async function refreshGPU(){
        if(closed)return;
        try{
            const raw=await load('/batch_timer/gpu/live');
            let gpu=raw.gpu;
            if(!gpu?.available && !gpu?.disabled && raw.configuration?.enabled !== false){
                // Fallback gives VRAM availability for non-NVIDIA GPUs, but not utilization/temperature.
                try{
                    const resp=await api.fetchApi('/system_stats');
                    if(resp.ok){
                        const stats=await resp.json();
                        const dev=(stats.devices||[]).find(d=>d.vram_total>0 &&
                            ['cuda','xpu','mps','privateuseone','hip'].some(t=>String(d.type||'').toLowerCase().includes(t))) ||
                            (stats.devices||[]).find(d=>d.vram_total>0);
                        if(dev && Number.isFinite(Number(dev.vram_free))){
                            gpu={available:true,name:dev.name||'GPU',source:'ComfyUI /system_stats',
                                vram_used_bytes:Math.max(0,Number(dev.vram_total)-Number(dev.vram_free)),
                                vram_total_bytes:Number(dev.vram_total),gpu_util_pct:null,temp_c:null};
                        }
                    }
                }catch(_){}
            }
            if(closed)return;
            deviceDetails.replaceChildren();
            if(gpu?.disabled || raw.configuration?.enabled === false){
                device.textContent='GPU monitoring disabled in SETTINGS';
                util(null,100);vram(null,1);temp(null,100);
                gpuHelp.textContent='Enable GPU Monitoring in SETTINGS → MONITOR to resume live telemetry.';
                return;
            }
            if(gpu?.available){
                if(Array.isArray(gpu.devices) && gpu.devices.length > 1){
                    for(const card of gpu.devices){
                        const text=el('div',deviceDetails,
                            `GPU ${card.index} · ${card.name} · LOAD ${card.gpu_util_pct??'N/A'}% · `+
                            `VRAM ${fmtBytes(card.vram_used_bytes)} / ${fmtBytes(card.vram_total_bytes)} · `+
                            `${card.temp_c??'N/A'}°C`,
                            {fontSize:'11px',padding:'8px',background:'#152531',borderRadius:'5px',color:'#bcd7e6'});
                    }
                }
                
                device.textContent=`${gpu.name || 'GPU'} · ${gpu.source || 'server'}`;
                util(gpu.gpu_util_pct,100,safeNumber(gpu.gpu_util_pct)===null?'N/A':`${Math.round(gpu.gpu_util_pct)}%`);
                vram(gpu.vram_used_bytes,gpu.vram_total_bytes,
                    gpu.vram_used_bytes==null?'N/A':`${fmtBytes(gpu.vram_used_bytes)} / ${fmtBytes(gpu.vram_total_bytes)}`);
                temp(gpu.temp_c,100,safeNumber(gpu.temp_c)===null?'N/A':`${Math.round(gpu.temp_c)}°C`);
                gpuHelp.textContent=gpu.selection==='all'?
                    'ALL GPUs: VRAM is summed across devices; GPU LOAD and temperature are displayed per device above.':
                    gpu.source==='ComfyUI /system_stats'?
                    'VRAM is estimated from ComfyUI reported total and free bytes. GPU load and temperature are unavailable without NVIDIA telemetry.' :
                    'NVIDIA readings are for the entire device, not just ComfyUI. GPU and VRAM peaks are sampled periodically, not exact instantaneous peaks.';
            }else{
                device.textContent='GPU telemetry unavailable: '+(gpu?.reason||'No compatible GPU reporting interface');
                util(null,100);vram(null,1);temp(null,100);
            }
        }catch(err){if(!closed)device.textContent='Cannot read GPU monitor: '+err.message;}
    }
    void refreshGPU(); timer=setInterval(refreshGPU,4000);
    const storage=section(content,'OUTPUT STORAGE STATISTICS');
    const description=el('div',storage,'Loading recorded image sizes…',{fontSize:'11px',color:'#97aebe'});
    const table=el('table',storage,null,{width:'100%',borderCollapse:'collapse',fontSize:'11px',marginTop:'8px'});
    const header=el('tr',table);
    for(const t of ['PERIOD','IMAGES','MEASURED','SIZE','AVG FILE']){
        const th=el('th',header,t,{textAlign:t==='PERIOD'?'left':'right',borderBottom:'1px solid #365263',padding:'6px 4px',color:'#849cae'});
    }
    const rows=[['SESSION','session'],['TODAY','today'],['LAST 7 DAYS','last7'],
       ['LAST 30 DAYS','last30'],['ALL RECORDED','all_time']];
    async function refreshStorage(){
        try{
            const q=new URLSearchParams(getDateStarts());
            const data=await load('/batch_timer/storage/summary?'+q.toString());
            if(closed)return;
            while(table.rows.length>1)table.deleteRow(1);
            for(const [title,key] of rows){
                const info=data.periods[key]||{};
                const avg=info.measured_files?info.bytes/info.measured_files:null;
                const values=[title,info.images||0,info.measured_files||0,fmtBytes(info.bytes||0),fmtBytes(avg)];
                const tr=el('tr',table);
                for(let i=0;i<values.length;i++)el('td',tr,values[i],{padding:'7px 4px',textAlign:i?'right':'left',
                    borderBottom:'1px solid #1d3040'});
            }
            description.textContent='Recorded sizes at generation time. Older or estimated runs may have no file sizes. '+
                'Measured image count can be smaller than the image count; deleted files remain in historical measurements.';
            if(data.last_folder_scan)showScan(data.last_folder_scan);
        }catch(err){if(!closed)description.textContent='Storage API unavailable: '+err.message;}
    }
    const scanArea=section(content,'CURRENT OUTPUT FOLDER (ON DEMAND)');
    const scanInfo=el('div',scanArea,
        'To count existing images, including those generated before this plugin, scan the ComfyUI output directory manually. Scanning can take several seconds.',
        {fontSize:'11px',color:'#8fa9b8',lineHeight:'1.5',marginBottom:'10px'});
    function showScan(info){
        scanInfo.textContent=info.ok?
            `${info.files} current image files · ${fmtBytes(info.bytes)} · ${new Date(info.scanned_at_ms).toLocaleString()}`+
            (info.truncated?' · PARTIAL SCAN (safety limit reached)':''):
            'Scan error: '+(info.error||'unknown');
    }
    const controls=el('div',scanArea,null,{display:'flex',gap:'9px',flexWrap:'wrap'});
    const scanButton=button(controls,'SCAN OUTPUT FOLDER',async()=>{
        scanButton.disabled=true;scanInfo.textContent='Scanning image files on the ComfyUI server…';
        try{const d=await load('/batch_timer/storage/scan',{method:'POST'});if(!closed)showScan(d);}
        catch(e){if(!closed)scanInfo.textContent='Scan failed: '+e.message;}
        finally{scanButton.disabled=false;}
    });
    button(controls,'REFRESH SAVED STATISTICS',()=>void refreshStorage());
    el('div',content,'The output scan includes only image files below ComfyUI/output, never models, videos, cache or other drives. '+
        'On a remote ComfyUI server, all values describe the server—not your browser computer.',
        {fontSize:'10px',lineHeight:'1.6',color:'#718b9d',marginTop:'15px'});
    void refreshStorage();
}
