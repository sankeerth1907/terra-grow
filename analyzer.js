// TerraGrow frontend analyzer — pixel classifier mirrors app.py heuristic
const state = { items: [], chart: null };

const $ = id => document.getElementById(id);
const dropzone = $('dropzone'), fileInput = $('fileInput');

['dragover','dragenter'].forEach(e=>dropzone.addEventListener(e,ev=>{ev.preventDefault();dropzone.classList.add('over')}));
['dragleave','drop'].forEach(e=>dropzone.addEventListener(e,ev=>{ev.preventDefault();dropzone.classList.remove('over')}));
dropzone.addEventListener('drop',ev=>addFiles(ev.dataTransfer.files));
fileInput.addEventListener('change',()=>addFiles(fileInput.files));
$('clearBtn').onclick=()=>{state.items=[];render();};
$('analyzeBtn').onclick=analyzeAll;
$('csvBtn').onclick=exportCSV;
$('reportBtn').onclick=exportReport;
$('checkBackend').onclick=testBackend;
$('loadSamplesBtn').onclick=loadSamples;

function addFiles(files){
  [...files].filter(f=>f.type.startsWith('image/')).forEach(f=>{
    const url=URL.createObjectURL(f);
    state.items.push({name:f.name,file:f,url,result:null,maskUrl:null,showMask:false});
  });
  render();
}

// ---- Core classifier (keep in sync with app.py) ----
function classify(r,g,b){
  const mx=Math.max(r,g,b), mn=Math.min(r,g,b), sat=mx-mn;
  // Water: blue/teal dominant
  if(b>50 && b>=r+12 && b>=g-18 && g>=r-10) return 'water';
  if(b>70 && g>70 && r<70 && b>r+20) return 'water';
  // City white / light gray: bright + low saturation
  if(mx>185 && sat<32) return 'city';
  // City asphalt gray: mid gray low saturation
  if(mx<170 && sat<22 && mx>60) return 'city';
  // Farmland green: green clearly dominant
  if(g>60 && g>=r+12 && g>=b-8) return 'farm';
  if(g>70 && g>r && g>=b && sat>12) return 'farm';
  // Barren tan/brown: red dominant, warm
  if(r>95 && r>=g-5 && r>b+5) return 'barren';
  if(r>110 && g>75 && b<110 && r>=g) return 'barren';
  // Reddish rooftops -> city (saturated red, not soil-like)
  if(r>140 && r>g+35 && sat>45) return 'city';
  // fallback by dominance
  if(g>=r && g>=b) return 'farm';
  if(b>=r && b>=g) return 'water';
  if(sat<28) return 'city';
  return 'barren';
}

async function analyzeImage(item){
  const img=new Image(); img.src=item.url; await img.decode();
  const MAX=512, s=Math.min(1,MAX/Math.max(img.width,img.height));
  const w=Math.max(1,Math.round(img.width*s)), h=Math.max(1,Math.round(img.height*s));
  const c=document.createElement('canvas'); c.width=w; c.height=h;
  const ctx=c.getContext('2d'); ctx.drawImage(img,0,0,w,h);
  const d=ctx.getImageData(0,0,w,h), p=d.data;
  const counts={farm:0,barren:0,city:0,water:0};
  const m=document.createElement('canvas'); m.width=w; m.height=h;
  const mctx=m.getContext('2d'), md=mctx.createImageData(w,h);
  const COLORS={farm:[46,158,79],barren:[201,160,106],city:[154,160,166],water:[45,156,219]};
  for(let i=0;i<p.length;i+=4){
    const k=classify(p[i],p[i+1],p[i+2]); counts[k]++;
    const col=COLORS[k], j=i;
    // blend original 35% + class color 65% for overlay
    md.data[j]=p[j]*0.35+col[0]*0.65; md.data[j+1]=p[j+1]*0.35+col[1]*0.65;
    md.data[j+2]=p[j+2]*0.35+col[2]*0.65; md.data[j+3]=255;
  }
  mctx.putImageData(md,0,0);
  const total=w*h, pct={};
  for(const k in counts) pct[k]=+(counts[k]/total*100).toFixed(2);
  item.result={counts,pct,total,width:img.width,height:img.height};
  item.maskUrl=m.toDataURL('image/png');
  item.verdict=verdict(pct);
}

function verdict(p){
  const top=Object.entries(p).sort((a,b)=>b[1]-a[1])[0];
  let t=`Dominant: ${label(top[0])} (${top[1]}%). `;
  if(p.farm>40) t+='Good cultivation potential. ';
  if(p.barren>40) t+='Large barren patch — consider reclamation / irrigation survey. ';
  if(p.city>40) t+='Highly urbanized — limited farming scope. ';
  if(p.water>25) t+='Significant water body — check irrigation / drainage. ';
  if(p.farm>=30&&p.water>=5&&p.water<=30) t+='Farm + water combo ideal for agriculture.';
  return t;
}
const label=k=>({farm:'Farmland',barren:'Barren land',city:'City / Urban',water:'Water'}[k]);

async function analyzeAll(){
  if(!state.items.length){alert('Upload images first, or click "Load sample tiles".');return;}
  $('analyzeBtn').textContent='⏳ Analyzing...';
  if($('useBackend').checked){
    try{ await analyzeViaBackend(); $('analyzeBtn').textContent='⚙ Analyze all'; render(); return; }
    catch(e){ console.warn('backend failed, fallback to local',e); alert('Backend failed ('+e.message+'). Fell back to in-browser analysis.'); }
  }
  for(const it of state.items){ try{ await analyzeImage(it);}catch(e){console.error(e);} }
  $('analyzeBtn').textContent='⚙ Analyze all';
  render();
}

async function analyzeViaBackend(){
  const url=$('backendUrl').value.trim();
  for(const it of state.items){
    const fd=new FormData(); fd.append('image',it.file,it.name);
    const r=await fetch(url,{method:'POST',body:fd});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const j=await r.json();
    it.result={counts:j.counts,pct:j.percentages,total:j.total_pixels,width:j.width,height:j.height,engine:'backend:'+j.engine};
    it.maskUrl='data:image/png;base64,'+j.mask_png_base64;
    it.verdict=j.verdict;
  }
  $('backendStatus').textContent='● backend connected'; $('backendStatus').classList.add('on');
}

async function testBackend(){
  try{
    const r=await fetch($('backendUrl').value.trim(),{method:'POST',body:new FormData()});
    // empty body -> expect 400 with json, means server alive
    $('backendStatus').textContent=r.ok||r.status===400?'● backend reachable':'● backend error '+r.status;
    $('backendStatus').classList.add('on');
  }catch(e){ $('backendStatus').textContent='● backend unreachable — run: python app.py'; }
}

// ---- rendering ----
function render(){
  const box=$('results'); box.innerHTML='';
  state.items.forEach((it,idx)=>{
    const r=it.result;
    const card=document.createElement('div'); card.className='card';
    card.innerHTML=`
      <div class="imgs">
        <div><img src="${it.url}"/><div style="font-size:11px;padding:4px 8px;color:#666">Original</div></div>
        <div>${it.maskUrl?`<img src="${it.maskUrl}"/>`:''}<div style="font-size:11px;padding:4px 8px;color:#666">${it.maskUrl?'Segmented mask (green=farm, tan=barren, gray=city, blue=water)':'Not analyzed yet'}</div></div>
      </div>
      <div class="body">
        <h4>${it.name}</h4>
        ${r?`
        <div class="bars">
          ${bar('Farmland',r.pct.farm,'#2e9e4f')}${bar('Barren',r.pct.barren,'#c9a06a')}
          ${bar('City',r.pct.city,'#9aa0a6')}${bar('Water',r.pct.water,'#2d9cdb')}
        </div>
        <div class="verdict">${it.verdict||''}<div style="color:#888;margin-top:4px">${r.total.toLocaleString()} px analyzed${r.engine?' · '+r.engine:' · in-browser'}</div></div>
        `:`<p style="font-size:13px;color:#777">Press “Analyze all”.</p>`}
      </div>`;
    box.appendChild(card);
  });
  // aggregate
  const agg={farm:0,barren:0,city:0,water:0}; let tot=0,n=0;
  state.items.forEach(it=>{ if(it.result){for(const k in agg)agg[k]+=it.result.counts[k]; tot+=it.result.total; n++;}});
  let pct={farm:0,barren:0,city:0,water:0};
  if(tot) for(const k in agg) pct[k]=+(agg[k]/tot*100).toFixed(2);
  $('pctFarm').textContent=tot?pct.farm+'%':'—';
  $('pctBarren').textContent=tot?pct.barren+'%':'—';
  $('pctCity').textContent=tot?pct.city+'%':'—';
  $('pctWater').textContent=tot?pct.water+'%':'—';
  $('imgCount').textContent=n+' / '+state.items.length+' analyzed';
  $('pixCount').textContent=tot.toLocaleString()+' px';
  drawDonut(tot?[pct.farm,pct.barren,pct.city,pct.water]:[0,0,0,0]);
  state.agg={pct,tot};
}
const bar=(l,v,c)=>`<div class="bar-row"><span>${l}</span><div class="bar"><i style="width:${v}%;background:${c}"></i></div><b>${v}%</b></div>`;

let chart;
function drawDonut(vals){
  const ctx=$('donut');
  if(chart) chart.destroy();
  chart=new Chart(ctx,{type:'doughnut',
    data:{labels:['Farmland','Barren','City','Water'],
    datasets:[{data:vals,backgroundColor:['#2e9e4f','#c9a06a','#9aa0a6','#2d9cdb'],borderWidth:2}]},
    options:{plugins:{legend:{display:false}},cutout:'62%'}});
}

// Sample tiles: files live next to index.html
async function loadSamples(){
  const candidates=['tile_r04_c04.png','tile_r01_c01.png','tile_r05_c06.png','tile_r03_c05.png','tile_r06_c08.png','tile_r02_c10.png'];
  let loaded=0;
  for(const name of candidates){
    try{
      const r=await fetch(name); if(!r.ok) continue;
      const b=await r.blob();
      const f=new File([b],name,{type:'image/png'});
      state.items.push({name,file:f,url:URL.createObjectURL(f),result:null});
      loaded++;
    }catch(e){}
  }
  if(!loaded) alert('Could not fetch sample tiles. Use Upload instead (or serve via: python -m http.server).');
  render();
}

function exportCSV(){
  const rows=[['image','farmland_%','barren_%','city_%','water_%','pixels']];
  state.items.forEach(it=>{ if(it.result) rows.push([it.name,it.result.pct.farm,it.result.pct.barren,it.result.pct.city,it.result.pct.water,it.result.total]); });
  if(state.agg) rows.push(['AGGREGATE',state.agg.pct.farm,state.agg.pct.barren,state.agg.pct.city,state.agg.pct.water,state.agg.tot]);
  dl('terragrow-results.csv',rows.map(r=>r.join(',')).join('\n'),'text/csv');
}
function exportReport(){
  const a=state.agg; if(!a||!a.tot){alert('Analyze first.');return;}
  const txt=`TerraGrow Land-Cover Report\n${new Date().toLocaleString()}\n\nAggregate: Farmland ${a.pct.farm}% | Barren ${a.pct.barren}% | City ${a.pct.city}% | Water ${a.pct.water}%\nPixels: ${a.tot}\n\nPer image:\n`+state.items.map(it=>it.result?`- ${it.name}: farm ${it.result.pct.farm}%, barren ${it.result.pct.barren}%, city ${it.result.pct.city}%, water ${it.result.pct.water}%`:'- '+it.name+': not analyzed').join('\n');
  dl('terragrow-report.txt',txt,'text/plain');
}
function dl(name,content,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;a.click();}
render();

// ---------- Phase 4: Farm dashboard (Cloudflare Worker API) ----------
const cf = { farms: [] };
const cfUrl = () => ($('cfWorkerUrl').value || '').trim().replace(/\/+$/, '');
function cfSay(obj) { $('farmOut').textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2); }
async function cfGet(path) {
  const r = await fetch(cfUrl() + path);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
async function cfPost(path, body, isForm) {
  const r = await fetch(cfUrl() + path, isForm
    ? { method: 'POST', body }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
const cfFarmId = () => $('farmSelect').value;

$('cfTestBtn').onclick = async () => {
  try {
    const j = await cfGet('/api/health');
    $('cfStatus').textContent = `● cloud OK · R2:${j.hasR2 ? 'yes' : 'no'} D1:${j.hasD1 ? 'yes' : 'no'} · ${j.model || 'heuristic'}`;
    $('cfStatus').classList.add('on');
    cfSay(j);
  } catch (e) { $('cfStatus').textContent = '● unreachable — run: npm run dev'; cfSay('Worker unreachable: ' + e.message); }
};
$('farmCreateBtn').onclick = async () => {
  try {
    const lat = parseFloat($('farmLat').value), lng = parseFloat($('farmLng').value);
    const j = await cfPost('/farms', { name: $('farmName').value || 'My Farm', soil_type: $('farmSoil').value, boundary: { type: 'Point', coordinates: [lng, lat] } });
    await cfFarmsLoad(j.farm_id);
    cfSay(j);
  } catch (e) { cfSay('Create failed: ' + e.message); }
};
async function cfFarmsLoad(selectId) {
  const j = await cfGet('/farms?limit=100');
  cf.farms = j.results || [];
  $('farmSelect').innerHTML = '<option value="">— select farm —</option>' + cf.farms.map(f => `<option value="${f.id}">${f.name} · ${f.soil_type}</option>`).join('');
  if (selectId) $('farmSelect').value = selectId;
  return j;
}
$('farmRefreshBtn').onclick = async () => { try { cfSay(await cfFarmsLoad(cfFarmId())); } catch (e) { cfSay('Refresh failed: ' + e.message); } };
$('farmImageryBtn').onclick = async () => { try { cfSay(await cfGet(`/farms/${cfFarmId()}/imagery`)); } catch (e) { cfSay('Imagery failed: ' + e.message); } };
$('farmRecommendBtn').onclick = async () => { try { cfSay(await cfGet(`/farms/${cfFarmId()}/recommend`)); } catch (e) { cfSay('Recommend failed: ' + e.message); } };
$('farmMonitorBtn').onclick = async () => { try { cfSay(await cfGet(`/farms/${cfFarmId()}/monitor`)); } catch (e) { cfSay('Monitor failed: ' + e.message); } };
$('farmAlertsBtn').onclick = async () => { try { cfSay(await cfGet(`/farms/${cfFarmId()}/alerts`)); } catch (e) { cfSay('Alerts failed: ' + e.message); } };
// Push the currently analyzed images to the cloud (analyses table; auto-links to farm imagery by r2_key when present)
$('cfSaveBtn').onclick = async () => {
  const done = state.items.filter(it => it.result);
  if (!done.length) { cfSay('Analyze images first (Analyze all ↑), then save.'); return; }
  try {
    const out = [];
    for (const it of done) {
      out.push(await cfPost('/api/results', { filename: it.name, percentages: it.result.pct, counts: it.result.counts, pixels: it.result.total, verdict: it.verdict }));
    }
    cfSay({ saved: out.length, ids: out.map(o => o.id) });
  } catch (e) { cfSay('Save failed: ' + e.message); }
};
$('cfHistoryBtn').onclick = async () => { try { cfSay(await cfGet('/api/results?limit=20')); } catch (e) { cfSay('History failed: ' + e.message); } };
$('cfStatsBtn').onclick = async () => {
  try {
    const s = await cfGet('/api/stats');
    $('cfStatsLine').textContent = `${s.images} images · Farm ${s.percentages.farm}% · Barren ${s.percentages.barren}% · City ${s.percentages.city}% · Water ${s.percentages.water}%`;
    cfSay(s);
  } catch (e) { cfSay('Stats failed: ' + e.message); }
};
