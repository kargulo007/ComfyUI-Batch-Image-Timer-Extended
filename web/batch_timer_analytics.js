/**
 * Extended modifications: Copyright (c) 2026 Piotr Karwowski. Batch Image Timer v1.9 — analytics dialogs (MIT). No dependencies beyond ComfyUI API. */
import { api } from '/scripts/api.js';

const size=(v)=>v==null?'—':Number(v)<1024?`${v} B`:`${(Number(v)/1048576).toFixed(1)} MB`;
const txt=(v)=>v == null ? '—' : String(v);
const pad=n=>String(n).padStart(2,'0');
const dateTime=ms=>ms ? new Date(ms).toLocaleString('en-GB') : '—';
function duration(ms){
    if (ms==null || !Number.isFinite(Number(ms))) return '—';
    const s=Math.round(ms/1000),h=Math.floor(s/3600),m=Math.floor((s%3600)/60);
    return h ? `${h}h ${pad(m)}m ${pad(s%60)}s` : `${m}m ${pad(s%60)}s`;
}
function el(tag,parent,text,styles={}){
    const elem=document.createElement(tag);
    if(text!==undefined && text!==null)elem.textContent=String(text);
    Object.assign(elem.style,styles);
    if(parent)parent.appendChild(elem);
    return elem;
}
function btn(parent,label,action){
    const b=el('button',parent,label,{cursor:'pointer',padding:'7px 11px',borderRadius:'5px',
        border:'1px solid #36647f',color:'#d4f3ff',background:'#183347',fontSize:'12px'});
    b.type='button'; b.addEventListener('click',action);return b;
}
function row(parent){return el('div',parent,null,{display:'flex',gap:'9px',flexWrap:'wrap',alignItems:'center',margin:'10px 0'});}
function notice(parent,text){return el('div',parent,text,{fontSize:'12px',color:'#9abacc',margin:'10px 0'});}
function formatCell(parent,v){return el('div',parent,txt(v),{whiteSpace:'pre-wrap',overflowWrap:'anywhere'});}
function modal(title){
    const shade=el('div',document.body,null,{position:'fixed',inset:'0',zIndex:'100400',
        background:'rgba(0,0,0,.78)',display:'flex',alignItems:'center',justifyContent:'center',padding:'18px'});
    const body=el('section',shade,null,{width:'min(100%, 900px)',maxHeight:'90vh',overflow:'auto',
        boxSizing:'border-box',background:'#0e1721',color:'#d7e6ef',font:'13px/1.5 sans-serif',
        border:'1px solid #38566d',borderRadius:'10px',padding:'18px'});
    const top=row(body);
    el('strong',top,title,{flex:'1',fontSize:'17px',color:'#48dfff'});
    const close=()=>{document.removeEventListener('keydown',escape);shade.remove();};
    const escape=(e)=>{if(e.key==='Escape')close();};
    document.addEventListener('keydown',escape);
    shade.addEventListener('mousedown',e=>{if(e.target===shade)close();});
    btn(top,'CLOSE ✕',close);
    return {body,close};
}
async function json(path,options){
    const r=await api.fetchApi(path,options);
    const d=await r.json();
    if(!r.ok || !d.ok)throw Error(d.error||`HTTP ${r.status}`);
    return d;
}
function section(parent,title){el('h3',parent,title,{fontSize:'14px',color:'#52dbf5',margin:'14px 0 7px'});}
function statsTable(parent,items){
    const grid=el('div',parent,null,{display:'grid',gridTemplateColumns:'minmax(110px,1fr) repeat(2,minmax(100px,1.3fr))',gap:'1px',
        border:'1px solid #243747',background:'#243747',fontSize:'12px'});
    for(const trio of items)for(let i=0;i<3;i++)el('div',grid,trio[i],{
        padding:'7px',background:'#101b26',overflowWrap:'anywhere',color:i===0?'#9dc6d8':'#dceaf1'});
    return grid;
}
export async function openRunDetails(record,{imageURL,loadWorkflowHere,openWorkflowNewTab,rowFromServer}){
    const {body}=modal('RENDER PERFORMANCE · RUN DETAILS');
    const info=notice(body,'Loading run details…');
    try{
        const data=await json(`/batch_timer/stats/detail/${encodeURIComponent(record.prompt_id)}`);
        const r=data.record;
        info.textContent=`${dateTime(r.finished_ms)} · ${r.image_count} image(s) · ${r.verified?'Verified file output':'Estimated image count'}`;
        statsTable(body,[['MODEL',r.model||'Unknown',''],['RESOLUTION',r.resolution||'Unknown',''],
            ['DURATION',duration(r.duration_ms),`Queue wait: ${duration(r.queue_wait_ms)}`],
            ['STEPS / CFG',r.steps??'—',r.cfg??'—'],
            ['SEED',r.seed??'—',''],
            ['BATCH SIZE',r.batch_size??'—',r.duration_source||'unknown'],
            ['OUTPUT FILE SIZE',size(r.output_bytes),`${r.output_files_sized??0} files measured`],
            ['PEAK GPU VRAM',r.gpu_peak_vram_bytes==null?'—':size(r.gpu_peak_vram_bytes),
                r.gpu_avg_util_pct==null?'No load sample':`AVG GPU ${r.gpu_avg_util_pct}%`],
            ['PEAK GPU TEMP',r.gpu_peak_temp_c==null?'—':`${r.gpu_peak_temp_c}°C`,'Sampled, whole device']]);
        if(r.images?.length){const img=el('img',body,null,{display:'block',maxWidth:'100%',maxHeight:'230px',objectFit:'contain',margin:'12px auto'});
            img.src=imageURL(r.images[0]);img.alt='ComfyUI image preview';}
        if(r.prompts?.length){
            section(body,'PROMPT');
            el('div',body,r.prompts.map(p=>p.text).join('\n\n').slice(0,2000),
                {maxHeight:'140px',overflow:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere'});
        }
        const controls=row(body), adapted=rowFromServer(r);
        btn(controls,'LOAD WORKFLOW',()=>loadWorkflowHere(adapted));
        btn(controls,'OPEN IN NEW TAB',()=>openWorkflowNewTab(adapted));
        notice(body,'Queue wait is shown only when the ComfyUI history contains a reliable enqueue timestamp.');
    }catch(err){info.textContent='Unable to load run: '+err.message;}
}

export function openAnalytics({imageURL,rowFromServer,loadWorkflowHere,openWorkflowNewTab,getDateStarts,onUpdated,initialView='insights'}={}){
    const {body}=modal('GENERATION ANALYTICS · v1.9');
    const tabs=row(body);
    const main=el('div',body,null,{minHeight:'230px'});
    const modes=[['INSIGHTS','insights'],['CALENDAR','calendar'],['COMPARE','compare'],
        ['RECHECK','recheck'],['BACKUPS','backup']];
    for(const [name,mode] of modes)btn(tabs,name,()=>view(mode));
    const reset=()=>{main.replaceChildren();};
    async function insights(){
        section(main,'This week vs last week');
        const msg=notice(main,'Loading statistics…');
        try{
            const dat=await json('/batch_timer/stats/summary?'+new URLSearchParams(getDateStarts()));
            const a=dat.periods.this_week||{},b=dat.periods.last_week||{};
            const pct=(now,old)=>old>0?`${now>=old?'+':''}${((now/old-1)*100).toFixed(1)}%`:'No prior baseline';
            const imgAvg=x=>x.images ? x.duration_ms/x.images : null;
            statsTable(main,[['MEASURE','THIS WEEK','LAST WEEK'],
                ['IMAGES',a.images||0,b.images||0],
                ['RENDER TIME',duration(a.duration_ms),duration(b.duration_ms)],
                ['AVG / IMAGE',duration(imgAvg(a)),duration(imgAvg(b))],
                ['FAILED RUNS',dat.failures?.this_week?.failed||0,dat.failures?.last_week?.failed||0],
                ['INTERRUPTED',dat.failures?.this_week?.interrupted||0,dat.failures?.last_week?.interrupted||0]]);
            section(main,'Differences');
            notice(main,`Images: ${pct(a.images||0,b.images||0)} · Render time: ${pct(a.duration_ms||0,b.duration_ms||0)}`);
            notice(main,'Calendar weeks start Monday. This week is partial until Sunday; compare cautiously against the full previous week.');
            if(a.estimated_images||b.estimated_images)notice(main,'Some image counts are estimated from workflow settings.');
            msg.remove();
        }catch(err){msg.textContent='Statistics unavailable: '+err.message;}
    }
    async function calendar(){
        const controls=row(main);
        const inp=el('input',controls,null,{background:'#0b1520',color:'#d9f7ff',border:'1px solid #31546c',padding:'7px'});
        inp.type='month';
        const d=new Date(); inp.value=`${d.getFullYear()}-${pad(d.getMonth()+1)}`;
        const status=notice(main,'');
        const grid=el('div',main,null,{display:'grid',gridTemplateColumns:'repeat(7,minmax(0,1fr))',gap:'4px'});
        const details=el('div',main,null,{marginTop:'15px'});
        async function load(){
            grid.replaceChildren(); details.replaceChildren();status.textContent='Loading month…';
            const [y,m]=inp.value.split('-').map(Number);
            if(!y||!m)return;
            const start=new Date(y,m-1,1),end=new Date(y,m,1);
            const firstWeekDay=(start.getDay()+6)%7;
            try{
                const data=await json('/batch_timer/stats/calendar?'+new URLSearchParams({
                    start_ms:start.getTime(),end_ms:end.getTime(),offset_minutes:-start.getTimezoneOffset()}));
                const index=new Map(data.days.map(r=>[r.day,r]));
                for(const v of ['MON','TUE','WED','THU','FRI','SAT','SUN'])el('strong',grid,v,{fontSize:'10px',color:'#72b8d1',textAlign:'center'});
                for(let i=0;i<firstWeekDay;i++)el('span',grid,'');
                for(let day=1;day<=new Date(y,m,0).getDate();day++){
                    const key=`${y}-${pad(m)}-${pad(day)}`;const r=index.get(key);
                    const n=btn(grid,`${day}\n${r?.images||0} img`,()=>dayDetails(y,m,day));
                    n.style.whiteSpace='pre-line';n.style.padding='8px 2px';n.style.minHeight='57px';
                    n.style.background=r?.images?'#16425a':'#121c26';
                    n.title=`${key}: ${r?.images||0} images, ${duration(r?.duration_ms||0)}`;
                }
                status.textContent='Select a day to see recorded runs. Day grouping uses local timezone (DST boundary dates may differ).';
            }catch(err){status.textContent='Unable to load calendar: '+err.message;}
        }
        async function dayDetails(y,m,day){
            details.replaceChildren();const start=new Date(y,m-1,day),end=new Date(y,m-1,day+1);
            const info=notice(details,'Loading day…');
            try{
                const data=await json('/batch_timer/stats/day?'+new URLSearchParams({start_ms:start.getTime(),end_ms:end.getTime()}));
                info.textContent=`${start.toLocaleDateString('en-GB')} · ${data.summary.images} images, ${data.summary.runs} runs, ${duration(data.summary.duration_ms)}`;
                for(const record of data.entries.slice(0,20)){
                    const b=btn(details,`${dateTime(record.finished_ms)} · ${duration(record.duration_ms)} · ${record.image_count} img`,
                        ()=>void openRunDetails(record,{imageURL,loadWorkflowHere,openWorkflowNewTab,rowFromServer}));
                    b.style.display='block';b.style.marginBottom='4px';b.style.width='100%';b.style.textAlign='left';
                }
                if(data.entries.length>20)notice(details,'Only the first 20 runs are shown here. CSV export contains the full day.');
            }catch(err){info.textContent=err.message;}
        }
        inp.addEventListener('change',()=>void load());await load();
    }
    async function compare(){
        section(main,'Compare two completed runs');
        const status=notice(main,'Loading recent runs…');
        try{
            const data=await json('/batch_timer/stats/performance_runs?limit=50');
            const entries=data.entries||[];
            if(entries.length<2){status.textContent='Generate at least two images to compare.';return;}
            const controls=row(main);
            function picker(index){
                const s=el('select',controls,null,{flex:'1',minWidth:'180px',background:'#101d29',color:'#dceef7',padding:'8px'});
                entries.forEach((r,i)=>{const o=el('option',s,`${dateTime(r.finished_ms)} · ${duration(r.duration_ms)} · ${r.image_count} img`);o.value=r.prompt_id;});
                s.selectedIndex=index;return s;
            }
            const left=picker(0),right=picker(1);
            const results=el('div',main,null);
            async function run(){
                results.replaceChildren();const a=entries.find(r=>r.prompt_id===left.value),b=entries.find(r=>r.prompt_id===right.value);
                if(a.prompt_id===b.prompt_id){notice(results,'Select different runs.');return;}
                statsTable(results,[['PARAMETER','RUN A','RUN B'],
                    ['DATE',dateTime(a.finished_ms),dateTime(b.finished_ms)],
                    ['RENDER TIME',duration(a.duration_ms),duration(b.duration_ms)],
                    ['QUEUE WAIT',duration(a.queue_wait_ms),duration(b.queue_wait_ms)],
                    ['IMAGE COUNT',a.image_count,b.image_count],
                    ['MODEL',a.model||'Unknown',b.model||'Unknown'],
                    ['RESOLUTION',a.resolution||'—',b.resolution||'—'],
                    ['STEPS',a.steps??'—',b.steps??'—'],
                    ['SEED',a.seed??'—',b.seed??'—'],
                    ['CFG',a.cfg??'—',b.cfg??'—'],
                    ['BATCH SIZE',a.batch_size??'—',b.batch_size??'—'],
                    ['OUTPUT FILE SIZE',size(a.output_bytes),size(b.output_bytes)],
                    ['PEAK VRAM',size(a.gpu_peak_vram_bytes),size(b.gpu_peak_vram_bytes)],
                    ['AVG GPU LOAD',a.gpu_avg_util_pct==null?'—':a.gpu_avg_util_pct+'%',
                                    b.gpu_avg_util_pct==null?'—':b.gpu_avg_util_pct+'%']]);
                const group=row(results);
                for(const [label,r] of [['A',a],['B',b]]){
                    const section=el('div',group,null,{flex:'1',minWidth:'180px'});
                    const img=r.images?.[0];
                    if(img){const pic=el('img',section,null,{maxWidth:'100%',height:'145px',objectFit:'contain',display:'block'});pic.src=imageURL(img);pic.alt='Run '+label;}
                    btn(section,`DETAILS ${label}`,()=>void openRunDetails(r,{imageURL,loadWorkflowHere,openWorkflowNewTab,rowFromServer}));
                }
                notice(results,'Seed is extracted when available from sampler nodes. Dynamic or linked seeds may not be directly known.');
            }
            btn(controls,'COMPARE',()=>void run());status.textContent='Select two runs and click COMPARE.';
            await run();
        }catch(err){status.textContent='Comparison unavailable: '+err.message;}
    }
    async function recheck(){
        section(main,'Recheck statistics against ComfyUI server history');
        notice(main,'Only completed jobs still available in the ComfyUI server history can be recovered. Existing records are deduplicated by prompt ID.');
        const status=notice(main,'');
        const run=btn(main,'RECHECK STATISTICS',async()=>{
            run.disabled=true;status.textContent='Scanning up to 1000 recent history items…';
            try{
                const d=await json('/batch_timer/stats/recheck',{method:'POST'});
                status.textContent=`Scanned ${d.scanned} jobs · Added ${d.new_runs} runs / ${d.images_added} images · Total ${d.images_total} images (estimated: ${d.estimated_images_total}).`;
                onUpdated?.();
            }catch(err){status.textContent='Recheck failed: '+err.message;}
            finally{run.disabled=false;}
        });
        const diagnostic=btn(main,'SHOW DIAGNOSTICS',async()=>{
            try{const d=await json('/batch_timer/stats/diagnostics');status.textContent=`Observer: ${d.observer_alive?'active':'inactive'}, stored ${d.stored_runs} runs / ${d.stored_images} images; last error: ${d.observer?.last_error||'none'}`;}
            catch(err){status.textContent=err.message;}
        });diagnostic.style.marginLeft='8px';
    }
    async function backup(){
        section(main,'Backup and restore statistics');
        notice(main,'The database is stored in the custom node data folder on the ComfyUI server. Restoring replaces saved statistics; the plugin creates an automatic pre-restore backup first.');
        const status=notice(main,'');
        const list=el('div',main,null);
        const control=row(main);
        btn(control,'MAKE BACKUP NOW',async()=>{
            try{const d=await json('/batch_timer/stats/backup_now',{method:'POST'});status.textContent=d.created?'New backup created.':(d.message||'No backup created');await load();}
            catch(err){status.textContent=err.message;}
        });
        async function load(){
            list.replaceChildren();
            try{
                const d=await json('/batch_timer/stats/restore_candidates');
                if(!d.files?.length){notice(list,'No backups found.');return;}
                for(const file of d.files){
                    const line=row(list);line.style.borderBottom='1px solid #223a4d';
                    el('span',line,`${file.name} · ${Math.round(file.bytes/1024)} KB`,{flex:'1',fontSize:'11px',overflowWrap:'anywhere'});
                    btn(line,'RESTORE',async()=>{
                        if(!window.confirm(`Restore backup ${file.name}? This replaces current statistics. A safety backup will be created automatically.`))return;
                        status.textContent='Restoring database…';
                        try{const d=await json('/batch_timer/stats/restore',{method:'POST',headers:{'Content-Type':'application/json'},
                            body:JSON.stringify({filename:file.name,confirm:true})});
                            status.textContent=`Restored ${d.restored}. Safety backup: ${d.safety_backup}. Refreshing statistics…`;
                            onUpdated?.();await load();
                        }catch(err){status.textContent='Restore failed: '+err.message;}
                    });
                }
            }catch(err){status.textContent='Could not list backups: '+err.message;}
        }
        await load();
    }
    async function view(mode){
        reset();
        const jobs={insights,calendar,compare,recheck,backup};
        await jobs[mode]?.();
    }
    void view(initialView);
}
