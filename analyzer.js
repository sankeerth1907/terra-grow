// TerraGrow frontend — pixel classifier mirrors app.py (logic unchanged).
// This file: core analysis logic + UI bindings for the redesigned interface.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&','<':'<','>':'>','"':'"',"'":'&#39;'}[c]));
let UID = 0;

// ---------- shared UI utils ----------
function toast(msg, kind) {
  const w = $('toastWrap'); if (!w) return alert(msg);
  const t = document.createElement('div');
  t.className = 'toast ' + (kind || '');
  t.innerHTML = (kind === 'err'
    ? '<svg viewBox="0 0 24 24"><path d="M12 7v6m0 3v.5"/><circle cx="12" cy="12" r="9"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M5 12.5 10 17.5 19 7"/></svg>')
    + '<span>' + esc(msg) + '</span>';
  w.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 3800);
}
function announce(msg) { const a = $('announce'); if (a) a.textContent = msg; }

// ---------- theme ----------
$('themeToggle').onclick = () => {
  const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = cur;
  try { localStorage.setItem('tg-theme', cur); } catch (e) {}
};

// ---------- state ----------
const state = { items: [], agg: null, view: 'grid', sort: 'order', filter: 'all', chart: null, raw: {} };

// ---------- core classifier (keep in sync with app.py) ----------
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

// ---------- geo details (shared lib geo.js) ----------
const gsd = () => Math.max(0, parseFloat(($('gsdInput') || {}).value) || 0);
function detailsOf(r) {
  return Geo.detailsFor(r.pct, { origW: r.width, origH: r.height, analyzedPx: r.total, counts: r.counts, gsdM: gsd(), engine: r.engine });
}
const label = k => ({farm:'Farmland',barren:'Barren land',city:'City / Urban',water:'Water'}[k]);

// ---------- stepper ----------
function setStep(name) {
  const order = ['upload','analyze','review'];
  const idx = order.indexOf(name);
  order.forEach((k, i) => {
    const li = $('step' + k[0].toUpperCase() + k.slice(1));
    if (!li) return;
    li.classList.toggle('current', i === idx);
    li.classList.toggle('done', i < idx);
    li.setAttribute('aria-current', i === idx ? 'step' : 'false');
  });
}

// ---------- file intake ----------
function addFiles(files) {
  const skip = [];
  [...files].forEach(f => {
    if (!f.type.startsWith('image/')) { skip.push(f.name); return; }
    state.items.push({ uid: ++UID, name: f.name, file: f, url: URL.createObjectURL(f), result: null, maskUrl: null, status: 'queued', error: null });
  });
  const errBox = $('dropErr');
  if (skip.length) {
    errBox.hidden = false;
    errBox.textContent = (skip.length === 1 ? skip[0] + ' is not an image — skipped. ' : skip.length + ' non-image files were skipped. ')
      + 'Supported: PNG, JPG, TIFF-converted.';
    setTimeout(() => { errBox.hidden = true; }, 5000);
  } else errBox.hidden = true;
  render();
}

function removeItem(uid) {
  const i = state.items.findIndex(it => it.uid === uid);
  if (i > -1) { try { URL.revokeObjectURL(state.items[i].url); } catch (e) {} state.items.splice(i, 1); }
  render();
}

// ---------- analysis ----------
async function analyzeImage(item) {
  const img = new Image(); img.src = item.url; await img.decode();
  const MAX = 512, s = Math.min(1, MAX / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h), p = d.data;
  const counts = { farm:0, barren:0, city:0, water:0 };
  const m = document.createElement('canvas'); m.width = w; m.height = h;
  const mctx = m.getContext('2d'), md = mctx.createImageData(w, h);
  const COLORS = { farm:[46,158,79], barren:[201,160,106], city:[154,160,166], water:[45,156,219] };
  for (let i = 0; i < p.length; i += 4) {
    const k = classify(p[i], p[i+1], p[i+2]); counts[k]++;
    const col = COLORS[k], j = i;
    // blend original 35% + class color 65% for overlay
    md.data[j] = p[j]*0.35 + col[0]*0.65; md.data[j+1] = p[j+1]*0.35 + col[1]*0.65;
    md.data[j+2] = p[j+2]*0.35 + col[2]*0.65; md.data[j+3] = 255;
  }
  mctx.putImageData(md, 0, 0);
  const total = w * h, pct = {};
  for (const k in counts) pct[k] = +(counts[k] / total * 100).toFixed(2);
  item.result = { counts, pct, total, width: img.width, height: img.height };
  item.maskUrl = m.toDataURL('image/png');
  item.verdict = verdict(pct);
  item.status = 'done';
}

function verdict(p){
  const top = Object.entries(p).sort((a,b)=>b[1]-a[1])[0];
  let t = `Dominant: ${label(top[0])} (${top[1]}%). `;
  if(p.farm>40) t+='Good cultivation potential. ';
  if(p.barren>40) t+='Large barren patch — consider reclamation / irrigation survey. ';
  if(p.city>40) t+='Highly urbanized — limited farming scope. ';
  if(p.water>25) t+='Significant water body — check irrigation / drainage. ';
  if(p.farm>=30&&p.water>=5&&p.water<=30) t+='Farm + water combo ideal for agriculture.';
  return t;
}

async function analyzeAll(){
  const targets = state.items.filter(it => !it.result);
  if (!state.items.length) { toast('Nothing to analyze — add images or load the sample tiles first.', 'err'); return; }
  $('analyzeBtn').disabled = true;
  $('analyzeBtn').lastChild.textContent = ' Analyzing…';
  setStep('analyze');
  let usedBackend = false;
  if ($('useBackend').checked) {
    try { await analyzeViaBackend(); usedBackend = true; }
    catch (e) {
      console.warn('backend failed, fallback to local', e);
      toast('Python backend unreachable (' + e.message + ') — analyzing in your browser instead.', 'err');
      $('useBackend').checked = false;
    }
  }
  if (!usedBackend) {
    for (const it of state.items.filter(x => !x.result)) {
      it.status = 'analyzing'; it.error = null; render();
      try { await analyzeImage(it); }
      catch (e) { console.error(e); it.status = 'error'; it.error = 'Could not read this image.'; }
      render();
    }
  }
  $('analyzeBtn').disabled = false;
  $('analyzeBtn').lastChild.textContent = ' Analyze all';
  const done = state.items.filter(it => it.result).length;
  setStep(done ? 'review' : 'upload');
  const failed = state.items.filter(it => it.status === 'error').length;
  announce('Analysis complete. ' + done + ' of ' + state.items.length + ' images processed'
    + (failed ? ', ' + failed + ' failed' : '') + '.');
  if (done) toast('Analysis complete — ' + done + ' image' + (done>1?'s':'') + ' processed.');
}

async function analyzeViaBackend(){
  const url = $('backendUrl').value.trim();
  for (const it of state.items.filter(x => !x.result)) {
    it.status = 'analyzing'; render();
    const fd = new FormData(); fd.append('image', it.file, it.name);
    const r = await fetch(url, { method: 'POST', body: fd });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    it.result = { counts: j.counts, pct: j.percentages, total: j.total_pixels, width: j.width, height: j.height, engine: 'backend:' + j.engine };
    it.maskUrl = 'data:image/png;base64,' + j.mask_png_base64;
    it.verdict = j.verdict;
    it.status = 'done'; render();
  }
  setModePill('ok', 'Python backend');
}

function setModePill(cls, txt) {
  const p = $('backendStatus');
  if (txt) $('backendStatusTxt').textContent = txt.replace('● ', '');
  p.classList.remove('ok', 'warn');
  if (cls) p.classList.add(cls);
}

async function testBackend(){
  try {
    const r = await fetch($('backendUrl').value.trim(), { method: 'POST', body: new FormData() });
    // empty body -> expect 400 with json, means server alive
    if (r.ok || r.status === 400) { setModePill('warn', 'Python backend reachable'); toast('Backend is reachable — tick “Use if running” to send images to it.'); }
    else setModePill('warn', 'Backend error ' + r.status);
  } catch (e) { setModePill('', 'Frontend-only'); toast('Backend unreachable — start it with: python app.py', 'err'); }
}

// ---------- sample tiles ----------
async function loadSamples(){
  const candidates = ['tile_r04_c04.png','tile_r01_c01.png','tile_r05_c06.png','tile_r03_c05.png','tile_r06_c08.png','tile_r02_c10.png'];
  let loaded = 0;
  for (const name of candidates) {
    try {
      const r = await fetch(name); if (!r.ok) continue;
      const b = await r.blob();
      const f = new File([b], name, { type: 'image/png' });
      state.items.push({ uid: ++UID, name, file: f, url: URL.createObjectURL(f), result: null, maskUrl: null, status: 'queued', error: null });
      loaded++;
    } catch (e) {}
  }
  if (!loaded) { toast('Could not fetch sample tiles — try Upload instead (serve the folder with python -m http.server).', 'err'); return; }
  setStep('analyze');
  render();
  analyzeAll();
}

// ---------- rendering ----------
function barLegendCells(pct) {
  return ['farm','barren','city','water'].map(k =>
    `<span><i class="sw ${k}" aria-hidden="true"></i>${label(k)} <b class="num">${pct[k]}%</b></span>`).join('');
}

function stackedBar(pct) {
  const order = ['farm','barren','city','water'];
  return `<div class="sbar" role="img" aria-label="Land coverage: ${order.map(k=>label(k)+' '+pct[k]+'%').join(', ')}">` +
    order.map(k => `<i class="s-${k}" style="width:${pct[k]}%" title="${label(k)}: ${pct[k]}%"></i>`).join('') +
  `</div>`;
}

function gaugeSvg(score) {
  const v = Math.max(0, Math.min(100, score || 0));
  const col = v >= 60 ? 'var(--farm)' : (v >= 35 ? 'var(--water)' : 'var(--c-danger)');
  const R = 26, C = 2 * Math.PI * R;
  return `<div class="gauge" style="--gcol:${col}" role="img" aria-label="Cultivation score ${v} out of 100">
    <svg viewBox="0 0 64 64"><circle class="g-bg" cx="32" cy="32" r="${R}"/>
    <circle class="g-v" cx="32" cy="32" r="${R}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - v / 100)).toFixed(1)}"/>
    <text class="g-txt num" x="32" y="32" text-anchor="middle" dominant-baseline="central">${Math.round(v)}</text></svg></div>`;
}

function statusRow(it) {
  if (it.status === 'analyzing') return `<div class="card-status"><span class="spin" aria-hidden="true"></span>Analyzing…</div>`;
  if (it.status === 'error') return `<div class="card-status err"><b>Couldn't analyze this file.</b> ${esc(it.error || '')} <button class="btn ghost sm" data-retry="${it.uid}">Retry</button></div>`;
  if (it.status === 'queued') return `<div class="card-status">Ready — run “Analyze all”.</div>`;
  return '';
}

function compareWidget(it) {
  const has = it.result && it.maskUrl;
  return `<div class="cmp">
    <div class="cmp-frame" data-uid="${it.uid}" title="Click to zoom">
      <img src="${it.url}" alt="Original satellite image ${esc(it.name)}" loading="lazy" decoding="async"/>
      ${has ? `<img class="cmp-mask" src="${it.maskUrl}" alt="Segmented mask overlay" loading="lazy" decoding="async"/>` : ''}
      ${has ? `<span class="cmp-line" aria-hidden="true"></span><span class="cmp-grip" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 8l-4 4 4 4m6-8 4 4-4 4"/></svg></span>` : ''}
    </div>
    ${has ? `<input type="range" class="cmp-range" aria-label="Reveal mask" min="0" max="100" value="50"/>
    <div class="cmp-meta"><span class="m-lbl">${esc(it.width)}×${esc(it.height)} px</span>
      <button class="btn ghost sm zoom-o" data-uid="${it.uid}">Zoom original</button>
      <button class="btn ghost sm zoom-m" data-uid="${it.uid}">Zoom mask</button>
      <span class="cmp-op">Opacity<input type="range" min="10" max="100" value="100" aria-label="Mask opacity"/></span>
    </div>` : ''}
  </div>`;
}

function detailsBlock(it) {
  const d = detailsOf(it.result);
  const wsCls = { deficit: 'deficit', ideal: 'ideal', excess: 'excess' }[d.waterStatus] || 'na';
  return `<details class="card-details"><summary>Details — area, water, advice</summary><div class="cd-body">
    <div class="cd-swatches">${['farm','barren','city','water'].map(k =>
      `<span><i class="sw ${k}"></i>${label(k)} <b class="num">${it.result.pct[k]}%</b> · ${d.perClass[k].ha} ha</span>`).join('')}</div>
    <div class="cd-line"><span>Total area <span class="tip" data-tip="Width × height × (m/px)²; depends on the ground-resolution setting." tabindex="0" role="note" aria-label="Total area depends on ground resolution"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 10.5v6M12 7.5v1.2"/></svg></span></span><b class="num">${d.totalHa} ha (${d.totalAcres} ac)</b></div>
    <div class="cd-line"><span>Underutilised land <span class="tip" data-tip="Barren land that could potentially be reclaimed for crops." tabindex="0" role="note" aria-label="Underutilised: barren, potentially reclaimable"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 10.5v6M12 7.5v1.2"/></svg></span></span><b class="num">${d.underPct}% · ${d.underHa} ha</b></div>
    <div class="cd-line"><span>Water balance</span><b><span class="badge ${wsCls}">${d.waterStatus}</span></b></div>
    <div class="cd-line"><span>Pseudo-NDVI <span class="tip" data-tip="A rough vegetation index estimated from land-cover shares (−1 to +1). Real NDVI needs near-infrared imagery." tabindex="0" role="note" aria-label="Pseudo-NDVI: rough vegetation index from land-cover shares"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 10.5v6M12 7.5v1.2"/></svg></span></span><b class="num">${d.ndvi}</b></div>
    <div class="cd-advice">${esc(d.advice)}</div>
  </div></details>`;
}

function cardHtml(it) {
  if (it.status === 'queued' || it.status === 'analyzing') {
    return `<article class="card skel" data-uid="${it.uid}" style="animation-delay:${Math.min(400, it.uid * 45)}ms" aria-busy="true">
      <div class="card-head"><h3 title="${esc(it.name)}">${esc(it.name)}</h3></div>
      <div class="sk-b sk-img"></div><div class="sk-b sk-bar" style="margin:var(--s3)"></div>
      <div class="sk-b sk-line" style="margin:8px var(--s3)"></div><div class="sk-b sk-line w60"></div>
      ${statusRow(it)}</article>`;
  }
  if (it.status === 'error') {
    return `<article class="card" data-uid="${it.uid}">
      <div class="card-head"><h3 title="${esc(it.name)}">${esc(it.name)}</h3>
        <button class="card-x" data-x="${it.uid}" aria-label="Remove image"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
      <div class="cmp"><div class="cmp-frame" style="cursor:default"><img src="${it.url}" alt="" loading="lazy"/></div></div>
      ${statusRow(it)}</article>`;
  }
  const d = detailsOf(it.result);
  const top = Object.entries(it.result.pct).sort((a, b) => b[1] - a[1])[0];
  return `<article class="card" data-uid="${it.uid}" style="animation-delay:${Math.min(400, it.uid * 45)}ms">
    <div class="card-head"><h3 title="${esc(it.name)}">${esc(it.name)}</h3>
      ${it.result.engine ? `<span class="engine-chip num">${esc(String(it.result.engine).replace('backend:', ''))}</span>` : ''}
      <button class="card-x" data-x="${it.uid}" aria-label="Remove image"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    ${compareWidget(it)}
    <div class="card-body">
      ${stackedBar(it.result.pct)}
      <div class="sbar-legend">${barLegendCells(it.result.pct)}</div>
      <div class="lead">
        ${gaugeSvg(d.score)}
        <div class="lead-txt">
          <p class="lead-verdict">${esc(it.verdict || ('Dominant: ' + label(top[0])))}</p>
          <p class="lead-sub"><b class="num">Cultivation score ${d.score}/100</b> · Water <span class="badge ${({deficit:'deficit',ideal:'ideal',excess:'excess'}[d.waterStatus]||'na')}">${d.waterStatus}</span></p>
        </div>
      </div>
      ${it.result ? detailsBlock(it) : ''}
    </div>
  </article>`;
}

function matches(it) {
  if (!it.result) return state.filter === 'all';
  const d = detailsOf(it.result);
  switch (state.filter) {
    case 'ideal-l': return d.waterStatus === 'ideal';
    case 'deficit': return d.waterStatus === 'deficit';
    case 'excess': return d.waterStatus === 'excess';
    case 'score60': return d.score >= 60;
    default: return true;
  }
}

function render(){
  // file chips under dropzone
  $('dropFiles').innerHTML = state.items.map(it => `<span class="f-chip"><img src="${it.url}" alt=""/><span class="f-name">${esc(it.name)}</span>
    <button class="f-x" data-x="${it.uid}" aria-label="Remove ${esc(it.name)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></span>`).join('');
  $('dropIdle').style.display = state.items.length ? 'none' : '';

  // sort + filter
  const analyzed = it => !!it.result;
  const items = state.items.slice().filter(matches);
  const key = {
    order: it => 0, score: it => it.result ? -detailsOf(it.result).score : 1,
    farm: it => it.result ? -(it.result.pct.farm) : 1,
    water: it => it.result ? ({ ideal: 0, deficit: 1, excess: 2 }[detailsOf(it.result).waterStatus] ?? 3) : 3,
  }[state.sort];
  items.sort((a, b) => (analyzed(b) && analyzed(a) ? 0 : (analyzed(a) ? -1 : (analyzed(b) ? 1 : 0))) || (key(a) - key(b)));

  const box = $('results');
  if (!state.items.length) {
    box.innerHTML = `<div class="empty"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 15l4-4 4 4 5-6 6 7"/><circle cx="9" cy="8" r="1.4"/></svg>
      <b>No images yet</b><p>Drop a satellite or drone image above, or press “Try with sample tiles”.</p></div>`;
  } else if (!items.length) {
    box.innerHTML = `<div class="empty"><svg viewBox="0 0 24 24"><path d="M4 6h16M6 12h12M8 18h8"/></svg>
      <b>No results match this filter</b><p>Try a different filter, or clear it to see all ${state.items.length} images.</p></div>`;
  } else {
    box.innerHTML = items.map(cardHtml).join('');
  }

  // aggregate
  const agg = { farm:0, barren:0, city:0, water:0 }; let tot = 0, n = 0, totHa = 0, underHa = 0, scoreAvg = 0;
  state.items.forEach(it => { if (it.result) {
    for (const k in agg) agg[k] += it.result.counts[k]; tot += it.result.total; n++;
    const d = detailsOf(it.result); totHa += d.totalHa; underHa += d.underHa; scoreAvg += d.score;
  }});
  totHa = +totHa.toFixed(2); underHa = +underHa.toFixed(2); scoreAvg = n ? Math.round(scoreAvg / n) : 0;
  const pct = { farm:0, barren:0, city:0, water:0 };
  if (tot) for (const k in agg) pct[k] = +(agg[k] / tot * 100).toFixed(2);
  $('pctFarm').textContent = tot ? pct.farm + '%' : '—';
  $('pctBarren').textContent = tot ? pct.barren + '%' : '—';
  $('pctCity').textContent = tot ? pct.city + '%' : '—';
  $('pctWater').textContent = tot ? pct.water + '%' : '—';
  $('imgCount').textContent = n ? `${n} / ${state.items.length} analyzed` : 'No images yet';
  $('pixCount').textContent = tot ? tot.toLocaleString() + ' px analyzed' : '';
  $('haCount').textContent = tot ? totHa + ' ha' : '—';
  $('kpiAcres').textContent = tot ? Math.round(totHa / 0.404686) + ' acres' : 'add resolution';
  $('kpiUnder').textContent = tot ? underHa + ' ha' : '—';
  $('kpiUnderPct').textContent = tot ? (totHa ? +(underHa / totHa * 100).toFixed(1) : 0) + '% of area' : 'share of area';
  $('kpiScore').textContent = n ? scoreAvg : '—';
  const top = Object.entries(pct).sort((a, b) => b[1] - a[1])[0];
  $('donutTop').textContent = tot ? label(top[0]).split(' ')[0] : '—';
  drawDonut(tot ? [pct.farm, pct.barren, pct.city, pct.water] : [0, 0, 0, 0]);
  state.agg = { pct, tot, totHa, underHa, scoreAvg, n };
  updateSteps();
}

function updateSteps() {
  const anyResult = state.items.some(it => it.result);
  const analyzing = state.items.some(it => it.status === 'analyzing');
  setStep(analyzing ? 'analyze' : (anyResult ? 'review' : (state.items.length ? 'analyze' : 'upload')));
}

let chart;
function drawDonut(vals){
  const ctx = $('donut');
  if (chart) chart.destroy();
  chart = new Chart(ctx, { type: 'doughnut',
    data: { labels: ['Farmland','Barren','City','Water'],
    datasets: [{ data: vals, backgroundColor: ['#2e9e4f','#c9a06a','#9aa0a6','#2d9cdb'], borderWidth: 2, borderColor: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#fff' }] },
    options: { plugins: { legend: { display: false }, tooltip: { enabled: true } }, cutout: '62%', animation: { duration: 700 } } });
}

// ---------- exports ----------
function exportCSV(){
  const rows = [['image','farmland_%','barren_%','city_%','water_%','pixels','width','height','gsd_m_px','total_ha','farm_ha','barren_ha','city_ha','water_ha','underutilised_ha','underutilised_%','cultivation_score','water_status']];
  state.items.forEach(it => { if (it.result) { const d = detailsOf(it.result);
    rows.push([it.name, it.result.pct.farm, it.result.pct.barren, it.result.pct.city, it.result.pct.water, it.result.total, it.result.width, it.result.height, gsd(), d.totalHa, d.perClass.farm.ha, d.perClass.barren.ha, d.perClass.city.ha, d.perClass.water.ha, d.underHa, d.underPct, d.score, d.waterStatus]); }});
  if (state.agg && state.agg.tot) rows.push(['AGGREGATE', state.agg.pct.farm, state.agg.pct.barren, state.agg.pct.city, state.agg.pct.water, state.agg.tot, '', '', gsd(), state.agg.totHa, '', '', '', '', state.agg.underHa, '', '', '']);
  if (rows.length === 1) { toast('Analyze at least one image first.', 'err'); return; }
  dl('terragrow-results.csv', rows.map(r => r.join(',')).join('\n'), 'text/csv');
  toast('CSV exported — ' + (rows.length - 1) + ' rows.');
}
function exportReport(){
  const a = state.agg; if (!a || !a.tot) { toast('Analyze at least one image first.', 'err'); return; }
  const txt = `TerraGrow Land-Cover Report\n${new Date().toLocaleString()}\nGround resolution: ${gsd()} m/px\n\nAggregate: Farmland ${a.pct.farm}% | Barren ${a.pct.barren}% | City ${a.pct.city}% | Water ${a.pct.water}%\nArea: ${a.totHa} ha total, ${a.underHa} ha underutilised (reclaimable barren)\nAvg cultivation score: ${a.scoreAvg}/100 · Pixels: ${a.tot}\n\nPer image:\n` + state.items.map(it => { if (!it.result) return '- ' + it.name + ': not analyzed';
    const d = detailsOf(it.result);
    return `- ${it.name} (${it.result.width}x${it.result.height}px, ${d.totalHa} ha): farm ${it.result.pct.farm}% (${d.perClass.farm.ha} ha), barren ${it.result.pct.barren}% (${d.perClass.barren.ha} ha), city ${it.result.pct.city}% (${d.perClass.city.ha} ha), water ${it.result.pct.water}% (${d.perClass.water.ha} ha) | underutilised ${d.underPct}% (~${d.underHa} ha) | score ${d.score}/100 | water ${d.waterStatus} | ${d.advice}`; }).join('\n');
  dl('terragrow-report.txt', txt, 'text/plain');
  toast('Report downloaded.');
}
function dl(name, content, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; a.click(); }

// ---------- lightbox ----------
function openLightbox(src, cap) {
  $('lightboxImg').src = src; $('lightboxCap').textContent = cap || '';
  $('lightbox').hidden = false; $('lightboxClose').focus();
}
function closeLightbox() { $('lightbox').hidden = true; $('lightboxImg').src = ''; }

// ---------- delegated card events ----------
const resultsEl = $('results');
resultsEl.addEventListener('input', e => {
  const card = e.target.closest('.card'); if (!card) return;
  const frame = card.querySelector('.cmp-frame');
  if (e.target.classList.contains('cmp-range')) {
    const v = e.target.value + '%';
    frame.style.setProperty('--clip', v);
  } else if (e.target.closest('.cmp-op')) {
    frame.style.setProperty('--mopacity', e.target.value / 100);
  }
});
resultsEl.addEventListener('click', e => {
  const x = e.target.closest('[data-x]'); if (x) { removeItem(+x.dataset.x); return; }
  const retry = e.target.closest('[data-retry]'); if (retry) {
    const it = state.items.find(i => i.uid === +retry.dataset.retry);
    if (!it) return;
    it.status = 'analyzing'; it.error = null; render();
    analyzeImage(it).then(render).catch(er => { it.status = 'error'; it.error = 'Could not read this image.'; render(); });
    return;
  }
  const z = e.target.closest('.zoom-o, .zoom-m, .cmp-frame');
  if (z) {
    const card = z.closest('.card');
    const it = state.items.find(i => i.uid === +card.dataset.uid); if (!it) return;
    if (z.classList.contains('zoom-m') && it.maskUrl) openLightbox(it.maskUrl, 'Segmented mask — ' + it.name);
    else openLightbox(it.url, 'Original — ' + it.name);
  }
});

// ---------- toolbar bindings ----------
$('analyzeBtn').onclick = analyzeAll;
$('clearBtn').onclick = () => { state.items.forEach(it => { try { URL.revokeObjectURL(it.url); } catch (e) {} }); state.items = []; announce('Cleared all images.'); render(); };
$('csvBtn').onclick = exportCSV;
$('reportBtn').onclick = exportReport;
$('printBtn').onclick = () => { if (!(state.agg && state.agg.tot)) { toast('Analyze at least one image first.', 'err'); return; } window.print(); };
$('checkBackend').onclick = testBackend;
$('loadSamplesBtn').onclick = loadSamples;
const pick = () => $('fileInput').click();
$('uploadHeroBtn').onclick = pick;
$('headerUploadBtn').onclick = pick;

const dz = $('dropzone');
['dragover','dragenter'].forEach(e => dz.addEventListener(e, ev => { ev.preventDefault(); dz.classList.add('over'); }));
['dragleave','drop'].forEach(e => dz.addEventListener(e, ev => { ev.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', ev => addFiles(ev.dataTransfer.files));
dz.addEventListener('click', ev => { if (!ev.target.closest('input,button')) pick(); });
dz.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
$('fileInput').addEventListener('change', () => addFiles($('fileInput').files));
if ($('gsdInput')) {
  $('gsdPreset').onchange = () => {
    const v = $('gsdPreset').value;
    if (v === 'custom') { $('gsdInput').disabled = false; $('gsdInput').focus(); }
    else { $('gsdInput').value = v; $('gsdInput').disabled = true; }
    render();
  };
  $('gsdInput').addEventListener('input', render);
}
$('sortSelect').onchange = e => { state.sort = e.target.value; render(); };
$('filterSelect').onchange = e => { state.filter = e.target.value; render(); };
$('viewGrid').onclick = () => setView('grid');
$('viewList').onclick = () => setView('list');
function setView(v) {
  state.view = v;
  resultsEl.classList.toggle('list', v === 'list');
  $('viewGrid').classList.toggle('on', v === 'grid');
  $('viewList').classList.toggle('on', v === 'list');
  $('viewGrid').setAttribute('aria-pressed', v === 'grid');
  $('viewList').setAttribute('aria-pressed', v === 'list');
}
// aggregate collapse (mobile)
$('aggToggle').onclick = () => {
  const body = $('aggBody');
  const collapsed = body.classList.toggle('collapsed');
  $('aggToggle').setAttribute('aria-expanded', String(!collapsed));
};
function syncAggToggle() { $('aggToggle').hidden = window.innerWidth >= 1000; }
window.addEventListener('resize', syncAggToggle); syncAggToggle();
// escape closes lightbox / open menus
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!$('lightbox').hidden) closeLightbox();
    document.querySelectorAll('details.menu[open]').forEach(d => d.open = false);
  }
});
$('lightboxClose').onclick = closeLightbox;
$('lightbox').addEventListener('click', e => { if (e.target.dataset.close != null) closeLightbox(); });

// ============================================================
// Phase 4: Farm dashboard (Cloudflare Worker API) — endpoints unchanged
// ============================================================
const cf = { farms: [], lastTab: null };
const cfUrl = () => ($('cfWorkerUrl').value || '').trim().replace(/\/+$/, '');
function cfSay(obj) { const o = $('farmOut'); if (o) o.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2); }
function setCloudPill(cls, txt) {
  const p = $('cfStatus'); if (txt) $('cfStatusTxt').textContent = txt.replace('● ', '');
  p.classList.remove('ok', 'warn'); if (cls) p.classList.add(cls);
}
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
  setCloudPill('warn', 'Connecting…');
  try {
    const j = await cfGet('/api/health');
    setCloudPill('ok', `Cloud OK · R2:${j.hasR2 ? 'yes' : 'no'} D1:${j.hasD1 ? 'yes' : 'no'}`);
    cfSay(j); renderFarm('stats', j);
    $('fdStep2').open = true;
  } catch (e) {
    setCloudPill('', 'Cloud not connected');
    cfSay('Worker unreachable: ' + e.message);
    toast('Worker unreachable — run: npm run dev (or check the URL).', 'err');
  }
};

// ---- form validation ----
function validateFarm() {
  const name = $('farmName').value.trim();
  const lat = parseFloat($('farmLat').value), lng = parseFloat($('farmLng').value);
  const nameErr = $('nameErr'), latErr = $('latErr'), lngErr = $('lngErr');
  let ok = true;
  if (name.length > 80) { nameErr.hidden = false; nameErr.textContent = 'Keep the plot name under 80 characters.'; ok = false; }
  else { nameErr.hidden = true; }
  if (!(lat >= -90 && lat <= 90)) { latErr.hidden = false; latErr.textContent = 'Latitude must be between −90 and 90.'; ok = false; }
  else latErr.hidden = true;
  if (!(lng >= -180 && lng <= 180)) { lngErr.hidden = false; lngErr.textContent = 'Longitude must be between −180 and 180.'; ok = false; }
  else lngErr.hidden = true;
  $('farmCreateBtn').disabled = !ok;
  return ok;
}
['farmName','farmLat','farmLng'].forEach(id => $(id).addEventListener('input', validateFarm));

$('farmCreateBtn').onclick = async () => {
  if (!validateFarm()) return;
  const lat = parseFloat($('farmLat').value), lng = parseFloat($('farmLng').value);
  try {
    const j = await cfPost('/farms', { name: $('farmName').value.trim() || 'My Farm', soil_type: $('farmSoil').value, boundary: { type: 'Point', coordinates: [lng, lat] } });
    await cfFarmsLoad(j.farm_id);
    cfSay(j);
    toast(`Plot “${$('farmName').value.trim() || 'My Farm'}” registered.`);
    $('fdStep2').open = true;
  } catch (e) { cfSay('Create failed: ' + e.message); toast('Create failed: ' + e.message, 'err'); }
};
async function cfFarmsLoad(selectId) {
  const j = await cfGet('/farms?limit=100');
  cf.farms = j.results || [];
  $('farmSelect').innerHTML = '<option value="">— select a plot —</option>' + cf.farms.map(f => `<option value="${esc(f.id)}">${esc(f.name)} · ${esc(f.soil_type)}</option>`).join('');
  if (selectId) $('farmSelect').value = selectId;
  return j;
}
$('farmRefreshBtn').onclick = async () => { try { cfSay(await cfFarmsLoad(cfFarmId())); toast('Plot list refreshed.'); } catch (e) { toast('Refresh failed: ' + e.message, 'err'); } };

// ---- tabs ----
const TAB_PATH = {
  imagery: () => `/farms/${cfFarmId()}/imagery`,
  recommend: () => `/farms/${cfFarmId()}/recommend`,
  monitor: () => `/farms/${cfFarmId()}/monitor`,
  alerts: () => `/farms/${cfFarmId()}/alerts`,
  history: () => '/api/results?limit=20',
};
$('farmPanel').innerHTML = '<p class="empty-s">Select a tab above to load plot data.</p>';
document.querySelectorAll('.fd-tabs [role="tab"]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const key = btn.dataset.tab;
    document.querySelectorAll('.fd-tabs [role="tab"]').forEach(b => b.setAttribute('aria-selected', String(b === btn)));
    if (!cfFarmId() && key !== 'history') { toast('Select a plot first (then pick a tab).', 'err'); return; }
    $('farmPanel').innerHTML = '<p class="empty-s">Loading…</p>';
    try {
      const j = await cfGet(TAB_PATH[key]());
      state.raw[key] = j; cfSay(j);
      renderFarm(key, j);
    } catch (e) {
      $('farmPanel').innerHTML = `<p class="empty-s">Couldn't load ${esc(key)}.<br>${esc(e.message)}</p>`;
      toast('Load failed: ' + e.message, 'err');
    }
  });
});
$('rawToggle').addEventListener('change', e => {
  $('farmOut').hidden = !e.target.checked;
  $('farmPanel').hidden = e.target.checked;
});

// ---- farm renderers ----
function kvBlock(k, v) {
  return `<div class="fp-block"><div class="fp-k">${esc(k)}</div><div class="fp-v">${esc(v)}</div></div>`;
}
function fmtVal(v) {
  if (v == null) return '—';
  if (typeof v === 'number') return +v.toFixed(4);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function listOf(j) {
  if (Array.isArray(j)) return j;
  if (Array.isArray(j.results)) return j.results;
  if (Array.isArray(j.rows)) return j.rows;
  if (Array.isArray(j.items)) return j.items;
  if (Array.isArray(j.alerts)) return j.alerts;
  if (Array.isArray(j.recommendations)) return j.recommendations;
  return null;
}
function findNumSeries(obj, out, depth = 0) {
  if (!obj || depth > 2) return;
  if (Array.isArray(obj)) { if (obj.length >= 2 && obj.every(x => typeof x === 'number' && isFinite(x))) out.push(obj); return; }
  if (typeof obj === 'object') for (const k in obj) { if (Array.isArray(obj[k]) && obj[k].length >= 2 && obj[k].every(x => typeof x === 'number' && isFinite(x))) out.push(obj[k]); else findNumSeries(obj[k], out, depth + 1); }
}
function drawSpark(cv, vals) {
  if (!cv || !vals || !vals.length) return;
  const ctx = cv.getContext('2d'), w = cv.width = cv.offsetWidth || 120, h = cv.height = 34;
  const mn = Math.min(...vals), mx = Math.max(...vals), rg = (mx - mn) || 1;
  const col = getComputedStyle(document.documentElement).getPropertyValue('--water').trim() || '#2d9cdb';
  ctx.beginPath();
  vals.forEach((v, i) => { const x = 2 + i / (vals.length - 1) * (w - 4), y = h - 3 - (v - mn) / rg * (h - 6); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
}
function sparkRow(vals) {
  return `<div class="spark-row"><canvas class="spark" data-spark aria-hidden="true"></canvas><span class="num">${vals.length} points · ${fmtVal(Math.min(...vals))} → ${fmtVal(Math.max(...vals))}</span></div>`;
}
function rowsTable(rows, cols) {
  return `<table class="ft"><thead><tr>${cols.map(c => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
  <tbody>${rows.slice(0, 50).map(r => `<tr>${cols.map(c => `<td${c.num ? ' class="num"' : ''}>${esc(c.fn(r))}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="9"><em>Empty.</em></td></tr>'}</tbody></table>`;
}
function pctCols(vars) {
  return vars.map(k => ({ label: k[0].toUpperCase(), num: true, fn: r => (r.percentages ? r.percentages[k] : '?') + '%' }));
}
function renderFarm(key, j) {
  const panel = $('farmPanel');
  const list = listOf(j);
  let html = '';
  if (list && list.length) {
    if (key === 'alerts') {
      html = `<div class="fp-rows">${list.map(a => {
        const sev = String(a.severity || a.level || a.type || 'info').toLowerCase();
        const cls = /urgen|error|alert|high/.test(sev) ? 'alert' : /warn|medium/.test(sev) ? 'watch' : (/ok|resolv/.test(sev) ? 'ok' : 'info');
        const sid = a.id != null ? a.id : '';
        return `<div class="fp-row"><div class="r-title"><span class="sev ${cls}">${esc(sev)}</span>${esc(a.title || a.message || a.kind || 'Alert')}
          ${sid !== '' && !a.resolved ? `<button class="btn ghost sm" data-resolve="${esc(sid)}" style="margin-left:auto">Resolve</button>` : ''}</div>
          <div class="r-sub">${esc(fmtVal(a.message || a.detail || a.reason || ''))} ${a.created_at ? '· ' + esc(a.created_at) : ''}</div></div>`;
      }).join('')}</div>`;
    } else if (key === 'imagery') {
      html = rowsTable(list, [
        { label: 'Captured', fn: r => (r.captured_at || r.created_at || r.date || '—').slice(0, 10) },
        { label: 'Source', fn: r => r.r2_key || r.source || r.provider || '—' },
        { label: 'ID', fn: r => r.id != null ? r.id : '—' },
      ]);
    } else if (key === 'history') {
      html = rowsTable(list, [
        { label: 'Image', fn: r => r.filename || r.name || '—' },
        ...pctCols(['farm','barren','city','water']),
        { label: 'Px', num: true, fn: r => r.pixels ?? r.total_pixels ?? '—' },
        { label: 'When', fn: r => (r.created_at || '—').slice(0, 16).replace('T', ' ') },
      ]);
    } else if (key === 'recommend') {
      html = `<div class="fp-rows">${list.map(r => `<div class="fp-row">
        <div class="r-title">${esc(r.crop || r.name || 'Recommendation')}${r.window ? `<span class="sev info">${esc(r.window)}</span>` : ''}</div>
        <div class="r-sub">${esc(r.notes || r.reason || r.detail || fmtVal(r))}</div></div>`).join('')}</div>`;
    } else {
      html = rowsTable(list.map(r => (r && typeof r === 'object' ? r : { value: r })),
        Object.keys(list[0] || {}).slice(0, 6).map(k => ({ label: k, fn: r => fmtVal(r[k]) })));
    }
  } else {
    const o = j && typeof j === 'object' && !Array.isArray(j) ? j : { result: j };
    const series = []; findNumSeries(o, series);
    if (o.percentages && typeof o.percentages === 'object') {
      html = kvBlock('percentages', Object.entries(o.percentages).map(([k, v]) => k + ' ' + v + '%').join(' · '));
      html += Object.entries(o).filter(([k]) => k !== 'percentages').slice(0, 12)
        .map(([k, v]) => kvBlock(k, fmtVal(v))).join('');
    } else {
      html = Object.entries(o).slice(0, 14).map(([k, v]) => kvBlock(k, fmtVal(v))).join('');
    }
    if (series.length) html += `<div class="fp-block"><div class="fp-k">Trend</div>${series.slice(0, 3).map(sparkRow).join('')}</div>`;
  }
  panel.innerHTML = html || '<p class="empty-s">No data returned for this tab.</p>';
  if (!list && key === 'alerts') panel.innerHTML = '<p class="empty-s">No unresolved alerts for this plot — nothing needs attention.</p>';
  panel.querySelectorAll('canvas[data-spark]').forEach(cv => {
    const i = [...panel.querySelectorAll('canvas[data-spark]')].indexOf(cv);
    const series = []; findNumSeries(state.raw[key] ?? j, series);
    drawSpark(cv, series[i]);
  });
  panel.querySelectorAll('[data-resolve]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { await cfPost(`/alerts/${b.dataset.resolve}/resolve`, {}); toast('Alert resolved.'); b.closest('.fp-row').remove(); }
    catch (e) { b.disabled = false; toast('Resolve failed: ' + e.message, 'err'); }
  });
}

// ---- ingest + stats + save ----
$('cfSaveBtn').onclick = async () => {
  const done = state.items.filter(it => it.result);
  if (!done.length) { toast('Analyze images first, then save them to the cloud.', 'err'); return; }
  try {
    const out = [];
    for (const it of done) {
      out.push(await cfPost('/api/results', { filename: it.name, percentages: it.result.pct, counts: it.result.counts, pixels: it.result.total, verdict: it.verdict, gsd_mpx: gsd(), width: it.result.width, height: it.result.height }));
    }
    cfSay({ saved: out.length, ids: out.map(o => o.id) });
    toast(`Saved ${out.length} analysis record${out.length > 1 ? 's' : ''} to the cloud.`);
  } catch (e) { cfSay('Save failed: ' + e.message); toast('Save failed: ' + e.message, 'err'); }
};
$('cfStatsBtn').onclick = async () => {
  try {
    const s = await cfGet('/api/stats');
    $('cfStatsLine').textContent = `${s.images} images · Farm ${s.percentages.farm}% · Barren ${s.percentages.barren}% · City ${s.percentages.city}% · Water ${s.percentages.water}%`;
    cfSay(s); renderFarm('stats', s);
  } catch (e) { $('cfStatsLine').textContent = 'Stats unavailable — connect the Worker first.'; toast('Stats failed: ' + e.message, 'err'); }
};

// ---- map picker (Leaflet, lazy-loaded) ----
let mapObj = null, markerObj = null, mapLoading = false;
async function initMap() {
  if (mapObj || mapLoading) return;
  mapLoading = true;
  $('mapBox').innerHTML = '<p class="empty-s" style="padding:24px">Loading map…</p>';
  try {
    if (!window.L) {
      await new Promise((res, rej) => {
        const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
        document.head.appendChild(l);
        const s = document.createElement('script'); s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
        s.onload = res; s.onerror = rej; document.head.appendChild(s);
      });
    }
    const lat = parseFloat($('farmLat').value) || 0, lng = parseFloat($('farmLng').value) || 0;
    mapObj = L.map('mapBox').setView([lat, lng], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(mapObj);
    markerObj = L.marker([lat, lng], { draggable: true }).addTo(mapObj);
    markerObj.on('dragend', () => { const p = markerObj.getLatLng(); $('farmLat').value = +p.lat.toFixed(4); $('farmLng').value = +p.lng.toFixed(4); validateFarm(); });
    mapObj.on('click', e => { markerObj.setLatLng(e.latlng); $('farmLat').value = +e.latlng.lat.toFixed(4); $('farmLng').value = +e.latlng.lng.toFixed(4); validateFarm(); });
    syncMarkerFromInputs();
  } catch (e) {
    $('mapBox').innerHTML = '<p class="empty-s" style="padding:24px">Map unavailable offline — type coordinates instead.</p>';
  }
  mapLoading = false;
}
function syncMarkerFromInputs() {
  if (!mapObj) return;
  const lat = parseFloat($('farmLat').value), lng = parseFloat($('farmLng').value);
  if (isFinite(lat) && isFinite(lng)) { markerObj.setLatLng([lat, lng]); mapObj.panTo([lat, lng]); }
}
$('farmLat').addEventListener('change', syncMarkerFromInputs);
$('farmLng').addEventListener('change', syncMarkerFromInputs);
$('mapPick').addEventListener('toggle', e => { if (e.target.open) initMap(); });

// ---------- boot ----------
render();
setStep('upload');
