// ═══════════════════════════════════════════════════════
// DATA
// ═══════════════════════════════════════════════════════
// USERS — populira se iz API pri admin učitavanju
let USERS = [];

// BUYER_ADDR — dinamički iz API (CU korisnik ili buyer podaci iz ponude)
// getBuyerAddr(buyerObj) vraća adresu iz API objekta
function getBuyerAddr(b) {
  if (!b) return null;
  const name = b.buyer_name || b.name || 'Kupac';
  const addr = b.buyer_addr || b.addr || '';
  const city = b.buyer_city || b.city || '';
  const tel  = b.buyer_tel  || b.tel  || '';
  if (!addr && !city && !tel) return null;
  return { name, addr, city, tel };
}

let LISTINGS = [];

// ─── Cache ────────────────────────────────────────────────
// listings cache: {data, ts} — važi 30s
const _cache = {};
async function cachedListings(force=false) {
  const now = Date.now();
  if (!force && _cache.listings && (now - _cache.listings.ts) < 30000) {
    return _cache.listings.data;
  }
  const data = await api('GET', '/listings');
  _cache.listings = { data, ts: now };
  return data;
}
function invalidateListingsCache() { delete _cache.listings; }

let CU = null;
let selRole = 'seller';
let selPM   = 'card';
let uploads = [];
let allMyPonude = {}; // allMyPonude[buyerId] = [{lid, pid, cijena, dani, expiresAt}]

// Helper: ponude trenutnog buyera
function getMyPonude() { return (CU && allMyPonude[CU.id]) || []; }
function addMyPonuda(p) {
  if (!CU) return;
  if (!allMyPonude[CU.id]) allMyPonude[CU.id] = [];
  allMyPonude[CU.id].push(p);
}
let chatHistory = {};
let chatLid = null;
let _confirmCb = null;
let _ponudaLid = null;
const FREE_DAILY_LIMIT = 10; // max ponuda dnevno za free korisnike
// dailyBids[userId] = {date:'2024-01-15', count:3}
const dailyBids = {};

function getTodayStr() {
  const d = new Date();
  return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate();
}

function getBidsToday(uid) {
  const entry = dailyBids[uid];
  if (!entry || entry.date !== getTodayStr()) return 0;
  return entry.count;
}

function incrementBidsToday(uid) {
  const today = getTodayStr();
  if (!dailyBids[uid] || dailyBids[uid].date !== today) {
    dailyBids[uid] = {date: today, count: 0};
  }
  dailyBids[uid].count++;
}

function canBid() {
  if (!CU || CU.role !== 'buyer') return false;
  if (CU.premium) return true; // premium — neograničeno
  return getBidsToday(CU.id) < FREE_DAILY_LIMIT;
}

function bidsRemaining() {
  if (!CU) return 0;
  if (CU.premium) return Infinity;
  return Math.max(0, FREE_DAILY_LIMIT - getBidsToday(CU.id));
}
let poslatoSet = new Set(); // id-evi završenih oglasa koji su označeni kao poslato
let defaultDana = 3; // default za novog korisnika prije učitavanja profila
let readAt = {}; // readAt[uid+':'+lid] = broj poruka kad je zadnji put čitano
let unreadLids = new Set(); // lid-ovi sa nepročitanim porukama

// ═══════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════
const getU     = id => USERS.find(u => String(u.id) === String(id));
const getOwner = l  => ({ id: l.user_id||l.uid||'x', name: l.owner_name||'Nepoznat', city: l.owner_city||'—', tel: l.owner_tel||'—' });
const initials = n  => (n||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
const avColors = ['#c0392b','#16a085','#8e44ad','#2980b9','#e67e22','#27ae60','#d35400'];
const avCol    = id => { const s = String(id||'x'); return avColors[s.charCodeAt(s.length-1) % avColors.length]; };
const now8     = () => { const d=new Date(); return d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0'); };
const fmtDate  = ts => { if(!ts) return ''; const d=new Date(ts); return d.getDate().toString().padStart(2,'0')+'. '+(d.getMonth()+1).toString().padStart(2,'0')+'. '+d.getFullYear()+'.'; };

// ═══════════════════════════════════════════════════════
// PAGE NAVIGATION
// ═══════════════════════════════════════════════════════
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
  const el = document.getElementById(id);
  if (!el) { console.error('Page not found:', id); return; }
  el.style.display = 'block';
  pushNav({page: id});
}

function showLoginPage()    { showPage('page-login'); }
function showRegisterPage() { showPage('page-register'); setTimeout(() => initAC('reg-city', 'reg-country'), 50); }

function goHome() {
  if (!CU) { showPage('page-hero'); return; }
  if (CU.role === 'admin')        { showPage('page-admin');  aTab('users'); }
  else if (CU.role === 'seller')  { showPage('page-seller'); sTab('oglasi'); }
  else                            { showPage('page-buyer'); }
}

// ═══════════════════════════════════════════════════════
// OVERLAYS
// ═══════════════════════════════════════════════════════
function closeOv(id) {
  const el=document.getElementById(id);
  if(el) el.classList.remove('on');
  // Restore chat input ako je bio sakriven
  if (id === 'ov-chat') {
    const inp = document.getElementById('chat-inp-area');
    if (inp) inp.style.display = '';
    const badge = document.getElementById('chat-admin-badge');
    if (badge) badge.style.display = 'none';
  }
}

// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════
// ─── API Helper ───────────────────────────────────────────
async function api(method, path, body) {
  const token = localStorage.getItem('token');
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new Error('Server greška (' + res.status + ')');
  }
  const data = await res.json();
  if (res.status === 401) {
    // Sesija istekla ili novi login na drugom uređaju
    const msg = data.error || 'Sesija istekla';
    localStorage.removeItem('token');
    CU = null;
    showPage('page-hero');
    toast('⚠️ ' + msg, 'err');
    throw new Error(msg);
  }
  if (!res.ok) throw new Error(data.error || 'Greška');
  return data;
}

async function doLogin() {
  const email = document.getElementById('in-email').value.trim().toLowerCase();
  const pass  = document.getElementById('in-pass').value;
  if (!email || !pass) { toast('Unesite email i lozinku', 'err'); return; }
  try {
    const btn = document.querySelector('#page-login .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Prijava...'; }
    const { user, token } = await api('POST', '/auth/login', { email, password: pass });
    localStorage.setItem('token', token);
    loginUser(user);
  } catch (err) {
    toast('❌ ' + err.message, 'err');
  } finally {
    const btn = document.querySelector('#page-login .btn-primary');
    if (btn) { btn.disabled = false; btn.textContent = 'Prijavi se'; }
  }
}

async function doRegister() {
  const name  = document.getElementById('reg-name').value.trim();
  const city  = document.getElementById('reg-city').value.trim();
  const addr  = document.getElementById('reg-addr').value.trim();
  const tel   = document.getElementById('reg-tel').value.trim();
  const email = document.getElementById('reg-email').value.trim().toLowerCase();
  const pass  = document.getElementById('reg-pass').value;
  const pass2 = document.getElementById('reg-pass2').value;
  if (!document.getElementById('reg-terms')?.checked) {
    toast('Morate prihvatiti Uslove korišćenja', 'err');
    return;
  }
  if (pass.length < 6) { toast('Lozinka min. 6 znakova', 'err'); return; }
  if (pass !== pass2) { toast('Lozinke se ne podudaraju', 'err'); return; }
  try {
    const btn = document.getElementById('reg-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Registracija...'; }
    const { user, token } = await api('POST', '/auth/register', { email, password: pass, name, city, addr, tel, role: selRole });
    localStorage.setItem('token', token);
    loginUser(user);
    if (user.status === 'pending') toast('✅ Registracija uspješna! Čekate odobrenje admina.', 'ok');
  } catch (err) {
    toast('❌ ' + err.message, 'err');
  } finally {
    const btn = document.getElementById('reg-btn');
    if (btn) { btn.disabled = false; btn.textContent = 'Registruj se'; }
  }
}

function loginUser(u) {
  // Normalizuj snake_case polja iz API-ja u camelCase
  if (u.premium_until && !u.premiumUntil) u.premiumUntil = new Date(u.premium_until).getTime();
  if (u.default_dana && !u.defaultDana) u.defaultDana = u.default_dana;
  if (u.email_notify === undefined) u.emailNotify = true;
  else u.emailNotify = u.email_notify !== false;
  CU = u;
  expireOld();
  // Provjeri broadcast notifikacije
  if (u.role !== 'admin') checkBroadcasts();
  // Header
  document.getElementById('hdr-guest').style.display = 'none';
  const hu = document.getElementById('hdr-user');
  hu.style.display = 'flex';
  const col = u.role==='buyer'?'#c0392b':u.role==='admin'?'#8e44ad':'#e67e22';
  document.getElementById('uc-av').style.background = col;
  document.getElementById('uc-av').textContent = initials(u.name);
  document.getElementById('uc-name').textContent = u.name;
  // Navigate
  const fab = document.getElementById('fab');
  const savedTab = (() => { try { return JSON.parse(localStorage.getItem('activeTab')); } catch(e) { return null; } })();
  if (u.role === 'seller') {
    fab.classList.add('show'); showPage('page-seller');
    const t = savedTab && savedTab.page === 'page-seller' ? savedTab.stab : 'oglasi';
    sTab(t);
    setTimeout(()=>{ updatePorukeBadges(); updateOglasiBadge(); startBadgePoll(); }, 100);
  } else if (u.role === 'admin') {
    fab.classList.remove('show'); showPage('page-admin');
    const t = savedTab && savedTab.page === 'page-admin' ? savedTab.atab : 'users';
    aTab(t);
  } else {
    fab.classList.remove('show'); showPage('page-buyer'); renderBuyerPage();
    setTimeout(()=>{ updatePorukeBadges(); startBadgePoll(); }, 100);
    // bTab se poziva unutar renderBuyerPage → bTab('oglasi'), override ako ima saved
    if (savedTab && savedTab.page === 'page-buyer') setTimeout(()=>bTab(savedTab.btab), 200);
  }
}

function doLogout() {
  CU = null; uploads = [];
  localStorage.removeItem('token');
  localStorage.removeItem('activeTab');
  document.getElementById('hdr-guest').style.display = '';
  document.getElementById('hdr-user').style.display  = 'none';
  document.getElementById('fab').classList.remove('show');
  showPage('page-hero');
}

// Auto-login ako postoji token
async function tryAutoLogin() {
  const token = localStorage.getItem('token');
  if (!token) return;
  try {
    const user = await api('GET', '/auth/me');
    loginUser(user);
  } catch {
    localStorage.removeItem('token');
  }
}

// ═══════════════════════════════════════════════════════
// REGISTER HELPERS
// ═══════════════════════════════════════════════════════
let selEntity = 'fizicko';
function pickRole(r) {
  selRole = r;
  document.getElementById('role-seller').classList.toggle('sel', r==='seller');
  document.getElementById('role-buyer').classList.toggle('sel', r==='buyer');
  document.getElementById('reg-btn').textContent = 'Registruj se';
  document.getElementById('reg-entity-wrap').style.display = r==='buyer' ? '' : 'none';
  pickEntity(selEntity); // refresh label
}
function pickEntity(e) {
  selEntity = e;
  document.getElementById('ent-fizicko').classList.toggle('sel', e==='fizicko');
  document.getElementById('ent-firma').classList.toggle('sel', e==='firma');
  const lbl = document.getElementById('reg-name-label');
  const inp = document.getElementById('reg-name');
  if (e === 'firma') {
    lbl.textContent = 'Naziv firme *';
    inp.placeholder = 'npr. AutoKat d.o.o.';
  } else {
    lbl.textContent = 'Ime i prezime *';
    inp.placeholder = 'npr. Mirko Perić';
  }
}
function pickPM(m) {
  selPM = m;
  ['card','bank','crypto'].forEach(x => {
    document.getElementById('pm-'+x).classList.toggle('sel', x===m);
    document.getElementById('pm-'+x+'-form').style.display = x===m ? '' : 'none';
  });
}
function fmtCard(el) { let v=el.value.replace(/\D/g,'').slice(0,16); el.value=v.replace(/(.{4})/g,'$1 ').trim(); }

// ═══════════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════════
function sTab(n) {
  localStorage.setItem('activeTab', JSON.stringify({page:'page-seller', stab:n}));
  pushNav({page:'page-seller', stab:n});
  // Sync bottom nav
  ['oglasi','poruke','zavrseni'].forEach(x => {
    const b = document.getElementById('sbn-'+x); if (b) b.classList.toggle('on', x===n);
  });
  ['oglasi','poruke','zavrseni'].forEach(x => {
    const t=document.getElementById('st-'+x); if(t) t.classList.toggle('on',x===n);
    const p=document.getElementById('sp-'+x); if(p) p.classList.toggle('on',x===n);
  });
  if (n==='oglasi')   { renderMyListings(); markOglasiSeen(); }
  if (n==='poruke')   { markAllPorukeRead('seller'); renderPoruke().then(updatePorukeBadges); }
  if (n==='zavrseni') renderZavrseni();
}

function bTab(n) {
  localStorage.setItem('activeTab', JSON.stringify({page:'page-buyer', btab:n}));
  pushNav({page:'page-buyer', btab:n});
  // Sync bottom nav
  ['oglasi','moje','zavrseni','poruke'].forEach(x => {
    const b = document.getElementById('bbn-'+x); if (b) b.classList.toggle('on', x===n);
  });
  ['oglasi','moje','zavrseni','poruke'].forEach(x => {
    const t=document.getElementById('bt-'+x); if(t) t.classList.toggle('on',x===n);
    const p=document.getElementById('bp-'+x); if(p) p.classList.toggle('on',x===n);
  });
  if (n==='oglasi') renderBuyerListings();
  if (n==='moje')   renderMyPonude();
  if (n==='zavrseni') renderBuyerZavrseni();
  if (n==='poruke') { markAllPorukeRead('buyer'); renderBuyerPoruke().then(updatePorukeBadges); }
}

function aTab(n) {
  localStorage.setItem('activeTab', JSON.stringify({page:'page-admin', atab:n}));
  pushNav({page:'page-admin', atab:n});
  // Sync bottom nav
  ['users','oglasi','analitika'].forEach(x => {
    const b = document.getElementById('abn-'+x); if (b) b.classList.toggle('on', x===n);
  });
  ['users','oglasi','analitika'].forEach(x => {
    const t=document.getElementById('at-'+x); if(t) t.classList.toggle('on',x===n);
    const p=document.getElementById('ap-'+x); if(p) p.classList.toggle('on',x===n);
  });
  if (n==='users')  renderAdminUsers();
  if (n==='oglasi') renderAdminOglasi();
  if (n==='analitika') renderAnalitika();
}

// ═══════════════════════════════════════════════════════
// UPLOAD
// ═══════════════════════════════════════════════════════
function handleDrop(e) { e.preventDefault(); document.getElementById('uz').classList.remove('drag'); handleFiles(e.dataTransfer.files); }
// Resize slike na max 1200px i kompresuj na 0.82 quality prije uploada
async function resizeImage(file, maxPx=900, quality=0.72) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let {width: w, height: h} = img;
      const scale = Math.min(1, maxPx / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), {type:'image/jpeg'})), 'image/jpeg', quality);
    };
    img.src = url;
  });
}

async function handleFiles(files) {
  const pg = document.getElementById('prev-grid');
  const arr = Array.from(files).filter(f => f.type.startsWith('image/'));
  if (!arr.length) return;
  // Progress prikaz
  const progId = 'upload-prog';
  let progEl = document.getElementById(progId);
  if (!progEl) {
    progEl = document.createElement('div');
    progEl.id = progId;
    progEl.style.cssText = 'font-size:12px;color:var(--muted);padding:4px 0;margin-bottom:4px';
    pg.parentNode.insertBefore(progEl, pg);
  }
  for (let i = 0; i < arr.length; i++) {
    progEl.textContent = `Obrađujem ${i+1}/${arr.length}...`;
    const resized = await resizeImage(arr[i]);
    uploads.push(resized);
  }
  progEl.remove();
  pg.innerHTML = uploads.map((f,i)=>
    `<div class="prev-item"><img src="${URL.createObjectURL(f)}" onclick="openLightbox(this.src)" style="cursor:zoom-in"><button class="prev-rm" onclick="event.stopPropagation();rmFile(${i})">✕</button></div>`
  ).join('');
}
function rmFile(i) {
  uploads.splice(i,1);
  document.getElementById('prev-grid').innerHTML = uploads.map((f,j)=>
    `<div class="prev-item"><img src="${URL.createObjectURL(f)}" onclick="openLightbox(this.src)" style="cursor:zoom-in"><button class="prev-rm" onclick="event.stopPropagation();rmFile(${j})">✕</button></div>`
  ).join('');
}

// ═══════════════════════════════════════════════════════
// SUBMIT LISTING
// ═══════════════════════════════════════════════════════
async function submitListing() {
  const isLot = _listingType === 'lot';
  const btn = document.getElementById('btn-submit-oglas');
  if (!isLot) {
    const marka = document.getElementById('f-marka').value.trim();
    if (!marka) { toast('Unesite marku vozila', 'err'); return; }
  } else {
    const items = getLotItems();
    if (!items.length) { toast('Dodajte barem jedan katalizator u lot', 'err'); return; }
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Objavljujem...'; }
  const _reEnableBtn = () => { if (btn) { btn.disabled = false; btn.textContent = '📤 Objavi oglas'; } };
  try {
    let imageUrls = [];
    if (uploads.length > 0) {
      const fd = new FormData();
      uploads.forEach(f => fd.append('images', f));
      const token = localStorage.getItem('token');
      const upRes = await fetch('/api/upload', { method:'POST', headers:{ Authorization:'Bearer '+token }, body: fd });
      if (!upRes.ok) {
        const errText = await upRes.text();
        throw new Error('Upload greška: ' + (errText.includes('{') ? JSON.parse(errText).error : 'Pokušajte ponovo'));
      }
      const upData = await upRes.json();
      if (upData.urls) imageUrls = upData.urls;
    }
    const payload = isLot ? {
      listing_type: 'lot',
      lot_items: getLotItems(),
      nap: document.getElementById('f-nap').value.trim(),
      images: imageUrls
    } : {
      listing_type: 'single',
      broj:   document.getElementById('f-broj').value.trim(),
      marka:  document.getElementById('f-marka').value.trim(),
      model:  document.getElementById('f-model').value.trim(),
      god:    document.getElementById('f-god').value.trim(),
      stanje: document.getElementById('f-stanje').value,
      nap:    document.getElementById('f-nap').value.trim(),
      images: imageUrls
    };
    await api('POST', '/listings', payload);
    uploads = [];
    document.getElementById('prev-grid').innerHTML = '';
    ['f-broj','f-marka','f-model','f-god','f-nap'].forEach(id => { const e = document.getElementById(id); if(e) e.value=''; });
    _reEnableBtn();
    closeOv('ov-novi');
    toast(isLot ? `✅ Lot objavljen!` : '✅ Oglas objavljen!', 'ok');
    invalidateListingsCache();
    sTab('oglasi');
  } catch(err) {
    toast('❌ ' + err.message, 'err');
    _reEnableBtn();
  }
}

// ═══════════════════════════════════════════════════════
// EXPIRE
// ═══════════════════════════════════════════════════════
function expireOld() {
  const WEEK = 7*86400000;
  LISTINGS.forEach(l => {
    if (l.status==='active' && !l.ponude.length && (Date.now()-l.createdAt) > WEEK) l.status='expired';
  });
  // Provjeri istek verified
  USERS.forEach(u => {
    if (u.premium && u.premiumUntil && Date.now() > u.premiumUntil) {
      u.premium = false;
      u.premiumUntil = null;
    }
  });
  // Ažuriraj i current usera ako mu je isteklo
  if (CU && CU.premium && CU.premiumUntil && Date.now() > CU.premiumUntil) {
    CU.premium = false;
    CU.premiumUntil = null;
  }
}

// ═══════════════════════════════════════════════════════
// SELLER: MY LISTINGS
// ═══════════════════════════════════════════════════════
async function renderMyListings() {
  updateOglasiBadge();
  try {
    const data = await cachedListings();
    LISTINGS = data.map(l => ({
      ...parseListing(l),
      _ponuda_count: parseInt(l.ponuda_count)||0
    }));
  } catch(e) { toast('Greška pri učitavanju oglasa', 'err'); }
  expireOld();
  const mine    = LISTINGS.filter(l => l.uid===CU.id && l.status==='active');
  const expired = LISTINGS.filter(l => l.uid===CU.id && l.status==='expired');
  const el = document.getElementById('s-oglasi');

  if (!mine.length && !expired.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">📋</div><h3>Nemate aktivnih oglasa</h3><p>Dodajte prvi oglas.</p><button class="btn btn-primary" onclick="openNoviOglas()">+ Dodaj oglas</button></div>`;
    return;
  }

  const activeHtml = mine.length ? mine.map(l => {
    const pend = l.ponude.filter(p => p.status==='pending').length;
    const totalPonuda = pend || parseInt(l.pending_count||l._ponuda_count||0);
    const hasPending = totalPonuda > 0;
    const badge = hasPending
      ? `<span class="badge b-ok" style="cursor:pointer" onclick="event.stopPropagation();togglePP(${l.id})">📨 ${totalPonuda} ${totalPonuda===1?'ponuda':'ponude'} ▾</span>`
      : `<span class="badge b-wait">⏳ Čeka ponude</span>`;
    const imgs = l.images && l.images.length ? l.images : (l.thumb ? [l.thumb] : []);
    const thumbSrc = imgs[0] || null;
    const gallS = imgs.length ? 'openLightbox(this.src,[' + imgs.map(u=>`\'${u}\'`).join(',') + '])' : '';
    const thumb = thumbSrc ? `<img src="${thumbSrc}" loading="lazy" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in" onclick="event.stopPropagation();${gallS}">` : '🔧';
    const rem = 7 - Math.floor((Date.now()-l.createdAt)/86400000);
    const soldDate = l.sold_at ? fmtDate(new Date(l.sold_at).getTime()) : '';
    return `<div class="s-oglas-card" onclick="togglePP(${l.id})">
      <div class="s-oglas-body">
        <div class="s-oglas-thumb">${thumb}</div>
        <div style="flex:1">
          <div class="s-oglas-title">${
            l.listing_type === 'lot'
              ? `<span style="background:var(--orange);color:#fff;font-size:10px;font-weight:700;padding:1px 5px;border-radius:3px;margin-right:4px">LOT</span>📦 ${Array.isArray(l.lot_items)?l.lot_items.length:0} katalizatora`
              : `${l.marka} ${l.model}${l.god?' ('+l.god+')':''}`
          }</div>
          <div class="s-oglas-meta">${l.broj?'Nr. '+l.broj+' · ':''}${l.stanje}</div>
          <div class="s-oglas-meta" style="color:var(--muted)">
            📅 ${fmtDate(l.createdAt)}
            ${soldDate ? ' &nbsp;·&nbsp; ✅ Prodano: '+soldDate : ''}
            ${!soldDate ? ' &nbsp;·&nbsp; ' + (rem > 0
              ? (rem <= 3
                  ? '<span style="color:var(--yellow)">⚠️ Ističe za '+rem+' '+(rem===1?'dan':'dana')+'</span>'
                  : 'Ističe za '+rem+' '+(rem===1?'dan':'dana'))
              : '<span style="color:var(--red)">Istekao</span>') : ''}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${badge}</div>
        </div>
      </div>
      <div class="ponude-panel" id="pp-${l.id}"></div>
    </div>`;
  }).join('') : `<div class="empty"><div class="empty-icon">📋</div><h3>Nemate aktivnih oglasa</h3><p>Dodajte prvi oglas.</p><button class="btn btn-primary" onclick="openNoviOglas()">+ Dodaj oglas</button></div>`;

  const expiredHtml = expired.length ? `
    <div style="margin-top:20px">
      <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">⏰ Istekli oglasi (${expired.length})</div>
      ${expired.map(l => {
        const imgs = l.images && l.images.length ? l.images : (l.thumb ? [l.thumb] : []);
        const thumbSrc = imgs[0] || null;
        const thumb = thumbSrc ? `<img src="${thumbSrc}" loading="lazy" style="width:100%;height:100%;object-fit:cover;opacity:.5">` : '🔧';
        return `<div class="s-oglas-card" style="opacity:.65">
          <div class="s-oglas-body">
            <div class="s-oglas-thumb">${thumb}</div>
            <div style="flex:1">
              <div class="s-oglas-title" style="color:var(--muted)">${l.marka} ${l.model}${l.god?' ('+l.god+')':''}</div>
              <div class="s-oglas-meta">${l.broj?'Nr. '+l.broj+' · ':''}${l.stanje}</div>
              <div class="s-oglas-meta">📅 ${fmtDate(l.createdAt)} &nbsp;·&nbsp; <span style="color:var(--red)">Isteklo bez ponuda</span></div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
                <button class="btn btn-primary btn-xs" onclick="event.stopPropagation();reactivateListing(${l.id})">🔄 Reaktiviraj</button>
                <button class="btn btn-or btn-xs" onclick="event.stopPropagation();deleteListing(${l.id})">🗑 Obriši</button>
              </div>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>` : '';

  el.innerHTML = activeHtml + expiredHtml;
}

async function reactivateListing(lid) {
  try {
    await api('PUT', '/listings/'+lid+'/status', { status: 'active' });
    invalidateListingsCache();
    toast('✅ Oglas reaktiviran — važi još 7 dana', 'ok');
    renderMyListings();
  } catch(err) { toast('❌ ' + err.message, 'err'); }
}

async function togglePP(lid) {
  // Ne reaguj ako je profil modal otvoren
  if (document.getElementById('ov-user-profile')) return;
  const panel = document.getElementById('pp-'+lid);
  if (!panel) return;
  if (panel.style.display==='block') { panel.style.display='none'; return; }
  try {
    panel.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:13px">Učitavam...</div>';
    panel.style.display = 'block';
    const l = await api('GET', '/listings/'+lid);
    // Mapiraj ponude u format koji buildPonudeList očekuje
    l.ponude = (l.ponude||[]).map(p => ({
      id: p.id, buyerId: p.buyer_id, cijena: parseFloat(p.cijena),
      msg: '', time: new Date(p.created_at).toLocaleTimeString('bs',{hour:'2-digit',minute:'2-digit'}),
      status: p.status, dani: p.dani,
      buyerName: p.buyer_name, buyerCity: p.buyer_city, buyerTel: p.buyer_tel, buyerAddr: p.buyer_addr,
      buyerTx: parseInt(p.buyer_transactions) || 0,
      premium: false
    }));
    // Ažuriraj lokalni LISTINGS
    const idx = LISTINGS.findIndex(x => x.id===lid);
    if (idx>=0) LISTINGS[idx].ponude = l.ponude;
    else LISTINGS.push({...l, uid: l.user_id});
    panel.innerHTML = buildPonudeList(LISTINGS.find(x=>x.id===lid)||l);
  } catch(e) {
    panel.innerHTML = '<div style="padding:12px;color:var(--red);font-size:13px">Greška pri učitavanju</div>';
  }
}

function buildPonudeList(l) {
  const sorted = [...l.ponude].sort((a,b) => b.cijena-a.cijena);
  if (!sorted.length) return '<div style="font-size:13px;color:var(--muted);padding:8px">Nema ponuda</div>';
  return sorted.map((p,i) => {
    const buyerName = p.buyerName || (getU(p.buyerId)||{name:'Otkupljivač'}).name;
    const buyerCity = p.buyerCity || (getU(p.buyerId)||{city:'—'}).city;
    const buyerTel  = p.buyerTel  || (getU(p.buyerId)||{tel:'—'}).tel;
    const col = avCol(String(p.buyerId));
    const isAcc = p.status==='accepted', isDec = p.status==='declined' || p.status==='rejected';
    const verB = p.premium ? '<span class="badge b-ok" style="font-size:10px">⭐ Premium</span>' : '';
    const stB  = isAcc?'<span class="badge b-ok" style="font-size:10px">✅ Prihvaćena</span>':isDec?'<span class="badge b-err" style="font-size:10px">❌ Odbijena</span>':i===0?'<span class="badge b-orange" style="font-size:10px">🥇 Najbolja</span>':'';
    const acts = !isAcc&&!isDec ? `<button class="btn btn-og btn-xs" onclick="event.stopPropagation();acceptPonuda(${p.id},${l.id})">✅ Prihvati</button><button class="btn btn-or btn-xs" onclick="event.stopPropagation();declinePonuda(${p.id},${l.id})">❌ Odbij</button>` : '';
    const telB = isAcc ? `<div style="font-size:11px;color:var(--muted2);margin-top:2px">📞 ${buyerTel||'—'}</div>` : '';
    const msgB = p.msg ? `<div style="font-size:12px;color:var(--muted2);font-style:italic;margin-top:4px;word-break:break-word;white-space:normal">"${p.msg}"</div>` : '';
    const bg   = isAcc?'var(--gL)':isDec?'rgba(0,0,0,.15)':'rgba(255,255,255,.03)';
    const bc   = isAcc?'rgba(29,185,84,.2)':isDec?'var(--border)':'var(--border2)';
    return `<div class="ponuda-row" style="background:${bg};border-color:${bc};opacity:${isDec?.5:1}">
      <div class="ponuda-av" style="background:${col};cursor:pointer" onclick="openUserProfile(${p.buyerId},'${buyerName.replace(/'/g,"\\'")}')"> ${initials(buyerName)}</div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:14px;display:flex;align-items:center;gap:5px;flex-wrap:wrap">
            <span style="cursor:pointer;text-decoration:underline" onclick="openUserProfile(${p.buyerId},'${buyerName.replace(/'/g,"\\'")}')"> ${buyerName}</span>${p.buyerTx > 0 ? ` <span style="font-size:11px;color:var(--muted);font-weight:400">(${p.buyerTx})</span>` : ''}
            ${verB} ${stB}
          </div>
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:900;font-size:20px;color:${isAcc?'var(--green)':isDec?'var(--muted)':'var(--orange2)'};flex-shrink:0">${p.cijena} KM</div>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">📍 ${buyerCity} · ${p.time}${p.dani ? ` · ⏱️ ${p.dani}d` : ''}</div>
        ${telB}${msgB}
        ${acts ? `<div style="display:flex;gap:6px;margin-top:8px">${acts}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function acceptPonuda(pid, lid) {
  showConfirm('Prihvatiti ponudu?','Sve ostale ponude za ovaj oglas bit će automatski odbijene.','✅ Da, prihvati', async () => {
    try {
      await api('PUT', '/ponude/'+pid+'/accept');
      const l = LISTINGS.find(x=>x.id===lid);
      if (l) { l.status='finished'; l.ponude.forEach(p => { p.status = p.id==pid?'accepted':'rejected'; }); }
      refreshPP(lid);
      invalidateListingsCache();
      await renderMyListings();
      renderZavrseni();
      sTab('zavrseni');
      toast('✅ Ponuda prihvaćena! Katalizator je prodan.','ok');
    } catch(err) { toast('❌ ' + err.message, 'err'); }
  });
}
async function declinePonuda(pid, lid) {
  try {
    await api('PUT', '/ponude/'+pid+'/reject');
    const l=LISTINGS.find(x=>x.id===lid);
    if (l) { const p=l.ponude.find(x=>x.id==pid); if(p) p.status='rejected'; }
    refreshPP(lid);
    toast('Ponuda odbijena.','');
  } catch(err) { toast('❌ ' + err.message, 'err'); }
}
function refreshPP(lid) {
  const panel=document.getElementById('pp-'+lid);
  if (panel&&panel.style.display==='block') {
    const l=LISTINGS.find(x=>x.id===lid);
    panel.innerHTML=buildPonudeList(l);
  }
}

// ═══════════════════════════════════════════════════════
// SELLER: ZAVRŠENI
// ═══════════════════════════════════════════════════════
async function renderZavrseni() {
  const el = document.getElementById('s-zavrseni');
  el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px">Učitavam...</div>';
  try {
    const data = await cachedListings();
    LISTINGS = data.map(parseListing);
  } catch(e) { el.innerHTML = '<div class="empty"><p>Greška pri učitavanju.</p></div>'; return; }
  const mine = LISTINGS.filter(l => l.uid === CU.id && (l.status === 'finished' || l.status === 'sent' || l.status === 'sold'));
  if (!mine.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">✅</div><h3>Nema završenih oglasa</h3><p>Ovdje će biti oglasi koje ste prodali.</p></div>`;
    return;
  }
  // Fetchaj detalje svakih završenih oglasa da dobijemo buyer adresu
  const detailed = await Promise.all(mine.map(l => api('GET', '/listings/'+l.id).catch(() => l)));
  const merged = mine.map(l => {
    const d = detailed.find(x => x.id === l.id) || l;
    return { ...l, ponude: d.ponude || [] };
  });
  // Sync poslatoSet iz API statusa (status='sent' == označeno kao poslato)
  merged.forEach(l => { if (l.status === 'sent') poslatoSet.add(l.id); });
  // Fetchaj koje transakcije su već ocijenjene
  let ratedSet = new Set();
  let ratingMap = {};
  try {
    const ratingChecks = await Promise.all(
      merged.map(l => api('GET', '/ratings/check/' + l.id).catch(() => ({ rated: false })))
    );
    merged.forEach((l, i) => {
      if (ratingChecks[i].rated) {
        ratedSet.add(l.id);
        ratingMap[l.id] = ratingChecks[i].rating;
      }
    });
  } catch(e) {}

  // Sortiraj: najnoviji na vrhu, poslato na dno
  const sorted = [...merged].sort((a, b) => {
    const aP = poslatoSet.has(a.id) ? 1 : 0;
    const bP = poslatoSet.has(b.id) ? 1 : 0;
    if (aP !== bP) return aP - bP;
    return b.createdAt - a.createdAt; // noviji na vrhu
  });
  // Paginacija — 20 po stranici
  const PAGE_SIZE = 20;
  const zavPage = window._zavPage || 0;
  const paginated = sorted.slice(0, (zavPage + 1) * PAGE_SIZE);
  const hasMore = sorted.length > paginated.length;
  el.innerHTML = paginated.map(l => {
    const acc   = l.ponude.find(p => p.status === 'accepted');
    const buyer = acc ? { name: acc.buyer_name||'Kupac', city: acc.buyer_city||'—', tel: acc.buyer_tel||'—' } : null;
    const addr  = acc ? getBuyerAddr(acc) : null;
    const imgs = l.images && l.images.length ? l.images : (l.thumb ? [l.thumb] : []);
    const thumbSrc = imgs[0] || null;
    const gallJS = imgs.length ? 'openLightbox(this.src,[' + imgs.map(u=>`\'${u}\'`).join(',') + '])' : '';
    const thumb = thumbSrc ? `<img src="${thumbSrc}" loading="lazy" style="cursor:zoom-in;width:100%;height:100%;object-fit:cover" onclick="${gallJS}">` : '🔧';
    const isPoslato = poslatoSet.has(l.id);
    const isOpen = !isPoslato; // poslato su zatvorene, ostale otvorene

    const rateBtn = buyer && acc ? `<button class="btn btn-ghost btn-sm" id="rate-btn-${l.id}" ${ratedSet.has(l.id)?`disabled style="opacity:.5"`:''} onclick="checkAndRate(${acc.buyer_id||acc.id},${l.id},'${l.marka} ${l.model}',this)">${ratedSet.has(l.id) ? '⭐ Ocijenjeno ' + (ratingMap[l.id] ? '★'.repeat(ratingMap[l.id].stars)+'☆'.repeat(5-ratingMap[l.id].stars) : '') : '⭐ Ocijeni kupca'}</button>` : '';

    return `<div class="zav-card${isPoslato?' poslato':''}${isOpen?' open':''}" id="zav-${l.id}">
      <div class="zav-header" onclick="toggleZav(${l.id})">
        <div class="s-oglas-thumb" style="width:52px;height:52px;font-size:20px;flex-shrink:0">${thumb}</div>
        <div style="flex:1;min-width:0">
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:16px">${l.marka} ${l.model}${l.god?' ('+l.god+')':''}</div>
          <div style="font-size:12px;color:var(--muted)">${l.broj?'Nr. '+l.broj+' · ':''}${acc?acc.cijena+' KM':''}</div>
        </div>
        ${isPoslato ? '<span class="badge b-ok" style="flex-shrink:0">✅ Poslato</span>' : '<span class="badge b-wait" style="flex-shrink:0">📦 Za slanje</span>'}
        <span class="zav-chevron">▼</span>
      </div>
      <div class="zav-body">
        ${addr ? `
        <div class="zav-addr-box" style="margin-bottom:0">
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:14px;color:var(--green);margin-bottom:8px">📦 Pošaljite na ovu adresu:</div>
          <div style="font-size:13px;line-height:2">
            <b>${addr.name}</b><br>
            📌 ${addr.addr}<br>
            🏙️ ${addr.city}<br>
            📞 ${addr.tel}
          </div>
        </div>` : '<div style="font-size:13px;color:var(--muted);padding:4px 0">Nema adrese za dostavu.</div>'}
        ${buyer ? `<div class="divider"></div><div style="font-size:12px;color:var(--muted2)">Kupac: <b style="color:var(--text);cursor:pointer;text-decoration:underline" onclick="openUserProfile(${acc.buyer_id||acc.id},'${buyer.name}')">${buyer.name}</b></div>` : ''}
      </div>
      ${rateBtn ? `<div style="padding:8px 14px;border-top:1px solid var(--border);display:flex;justify-content:flex-end">${rateBtn}</div>` : ''}
      <div class="zav-check-wrap">
        <input type="checkbox" id="chk-${l.id}" ${isPoslato?'checked':''} onchange="togglePoslato(${l.id},this.checked)">
        <label class="zav-check-label" for="chk-${l.id}">Označeno kao poslato</label>
      </div>
    </div>`;
  }).join('') + (hasMore ? `<div style="text-align:center;margin:16px 0"><button class="btn btn-ghost" onclick="window._zavPage=(window._zavPage||0)+1;renderZavrseni()">Učitaj još (${sorted.length - paginated.length})</button></div>` : '');
}

function toggleZav(lid) {
  const card = document.getElementById('zav-'+lid);
  if (card) card.classList.toggle('open');
}

async function togglePoslato(lid, checked) {
  try {
    await api('PUT', '/listings/'+lid+'/status', { status: checked ? 'sent' : 'finished' });
    if (checked) poslatoSet.add(lid); else poslatoSet.delete(lid);
    invalidateListingsCache();
    const card = document.getElementById('zav-'+lid);
    if (card) {
      if (checked) {
        card.classList.add('poslato');
        card.classList.remove('open'); // sakrij adresu
        const badge = card.querySelector('.zav-header .badge');
        if (badge) { badge.textContent = '✅ Poslato'; badge.className = 'badge b-ok'; badge.style.flexShrink='0'; }
      } else {
        card.classList.remove('poslato');
        card.classList.add('open'); // prikaži adresu
        const badge = card.querySelector('.zav-header .badge');
        if (badge) { badge.textContent = '📦 Za slanje'; badge.className = 'badge b-wait'; badge.style.flexShrink='0'; }
      }
    }
  } catch(err) {
    const chk = document.getElementById('chk-'+lid);
    if (chk) chk.checked = !checked;
    toast('❌ ' + err.message, 'err');
  }
}


function parseListing(l) {
  return {
    ...l,
    uid: l.user_id,
    thumb: l.images && l.images.length ? l.images[0] : null,
    createdAt: new Date(l.created_at).getTime(),
    ponude: l.my_ponude || [],
    lot_items: Array.isArray(l.lot_items) ? l.lot_items
      : (typeof l.lot_items === 'string' && l.lot_items ? JSON.parse(l.lot_items) : [])
  };
}

function renderBuyerPage() {
  const pend = CU.status==='pending';
  document.getElementById('buyer-pending').style.display  = pend?'':'none';
  document.getElementById('buyer-content').style.display  = pend?'none':'';
  if (!pend) bTab('oglasi');
}

async function renderBuyerListings() {
  const el = document.getElementById('b-oglasi');
  try {
    invalidateListingsCache();
    const data = await cachedListings();
    LISTINGS = data.map(parseListing);
    // Sync my ponude
    allMyPonude[CU.id] = LISTINGS.flatMap(l =>
      (l.my_ponude||[]).map(p => ({ lid: l.id, pid: p.id, cijena: p.cijena, dani: p.dani, status: p.status||'pending', expiresAt: new Date(p.expires_at).getTime(), createdAt: p.created_at ? new Date(p.created_at).getTime() : 0 }))
    );
  } catch(e) { toast('Greška pri učitavanju', 'err'); return; }
  // Sakrij oglas čim je buyer ikad poslao ponudu (bez obzira na status)
  const blockedLids = getMyPonude().map(p => p.lid);
  const activeRaw = LISTINGS.filter(l => l.status==='active' && !blockedLids.includes(l.id));
  const active = sortListings(activeRaw);
  if (!active.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">📋</div><h3>Nema aktivnih oglasa</h3></div>`;
    return;
  }
  // Limit bar
  const bRem = bidsRemaining();
  let limitBar = '';
  if (!CU.premium) {
    if (bRem === 0) {
      limitBar = `<div style="background:var(--rL);border:1px solid rgba(230,57,70,.25);border-radius:8px;padding:12px 14px;margin-bottom:12px">
        <div style="font-size:13px;color:var(--red);font-weight:600;margin-bottom:3px">🚫 Dnevni limit dostignut</div>
        <div style="font-size:12px;color:var(--muted2)">Iskoristili ste svih <b>${FREE_DAILY_LIMIT}</b> ponuda danas. Reset u ponoć.</div>
        <button onclick="openPremiumInfo()" style="background:none;border:none;color:var(--orange);font-weight:700;font-size:12px;cursor:pointer;font-family:Barlow,sans-serif;padding:4px 0 0 0">⭐ Nadogradite na Premium →</button>
      </div>`;
    } else if (bRem <= 3) {
      limitBar = `<div style="background:var(--yL);border:1px solid rgba(244,196,48,.25);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <span style="color:var(--yellow)">⚠️ Ostalo vam je <b>${bRem}</b> ${bRem===1?'ponuda':'ponude'} danas</span>
        <button onclick="openPremiumInfo()" style="background:none;border:none;color:var(--orange);font-weight:700;font-size:12px;cursor:pointer;font-family:Barlow,sans-serif;padding:0">⭐ Premium →</button>
      </div>`;
    } else {
      limitBar = `<div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
        <span style="color:var(--muted2)">📊 Ponude danas: <b style="color:var(--text)">${FREE_DAILY_LIMIT - bRem} / ${FREE_DAILY_LIMIT}</b></span>
        <button onclick="openPremiumInfo()" style="background:none;border:none;color:var(--muted);font-size:11px;cursor:pointer;font-family:Barlow,sans-serif;padding:0">⭐ Premium — neograničeno</button>
      </div>`;
    }
  }
  const postarina = `<div class="postarina-bar">ℹ️ <b>Napomena:</b> Otkupljivač snosi sve troškove poštarine i transporta.</div>`;
  const moze = canBid();
  const PG = 20;
  const pg = window._buyerOglasiPage || 0;
  const paginated = active.slice(0, (pg + 1) * PG);
  const hasMore = active.length > paginated.length;
  el.innerHTML = limitBar + postarina + `<div class="oglas-list">` + paginated.map(l => {
    const seller = getOwner(l);
    const isLot = l.listing_type === 'lot';
    const lotItems = Array.isArray(l.lot_items) ? l.lot_items : (l.lot_items ? JSON.parse(l.lot_items) : []);
    const lotCount = lotItems.length;
    const lotPreview = lotItems.slice(0,3).map(i=>i.broj).filter(Boolean).join(', ') + (lotItems.length > 3 ? '...' : '');
    const imgs = l.images && l.images.length ? l.images : (l.thumb ? [l.thumb] : []);
    const thumbSrc = imgs[0] || null;
    const galleryJS = imgs.length ? 'openLightbox(this.src,[' + imgs.map(u=>`'${u}'`).join(',') + '])' : '';
    const thumb = thumbSrc ? `<div class="oglas-img" style="cursor:zoom-in" onclick="event.stopPropagation();${galleryJS}"><img src="${thumbSrc}" loading="lazy"></div>` : `<div class="oglas-img">${isLot?'📦':'🪙'}</div>`;
    const rem = 7 - Math.floor((Date.now() - l.createdAt) / 86400000);
    const expW = rem <= 3 && rem > 0 ? `<span class="badge b-wait">⚠️ Ističe za ${rem}d</span>` : '';
    const oglasBtnLabel = isLot ? `📤 Ponuda za lot` : `📤 Ponuda`;
    const ponudaBtn = moze
      ? `<button class="btn btn-green btn-sm" onclick="openPonudaOv(${l.id},'${isLot ? 'Lot '+lotCount+' kom' : l.marka+' '+l.model}')">` + oglasBtnLabel + `</button>`
      : `<button class="btn btn-ghost btn-sm" style="opacity:.5;cursor:default" onclick="openPremiumInfo()">🚫 Limit</button>`;
    return `<div class="oglas-card">
      ${thumb}
      <div class="oglas-body">
        ${isLot
          ? `<div class="oglas-title" style="cursor:pointer" onclick="event.stopPropagation();openLotDetail(${l.id})">
               <span style="background:var(--orange);color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;margin-right:5px;vertical-align:middle">LOT</span>
               📦 ${lotCount} katalizatora
               <span style="font-size:11px;color:var(--orange);margin-left:4px">▸ detalji</span>
             </div>`
          : `<div class="oglas-title">${l.marka} ${l.model}${l.god ? ' (' + l.god + ')' : ''}</div>`
        }
        <div class="oglas-badges">
          ${!isLot && l.broj ? `<span class="badge b-blue">Nr. ${l.broj}</span>` : ''}
          ${!isLot ? `<span class="badge" style="background:rgba(255,255,255,.06);color:var(--muted2)">${l.stanje}</span>` : ''}
          ${isLot && lotPreview ? `<span style="font-size:11px;color:var(--muted2);cursor:pointer" onclick="event.stopPropagation();openLotDetail(${l.id})">OEM: ${lotPreview}</span>` : ''}
          ${expW}
          <span style="font-size:11px;color:var(--muted)">📅 ${fmtDate(l.createdAt)}</span>
        </div>
        ${l.nap ? `<div class="oglas-nap">${l.nap}</div>` : ''}
        <div class="oglas-footer">
          <div class="oglas-seller">📍 <b>${seller.city || '—'}</b> &nbsp;·&nbsp; 👤 <b style="cursor:pointer;text-decoration:underline" onclick="event.stopPropagation();openUserProfile(${l.uid||l.user_id},'${seller.name}')">${seller.name}</b>${l.sales_count > 0 ? ` <span style="font-size:11px;color:var(--muted);font-weight:400">(${l.sales_count})</span>` : ''}</div>
          <div class="oglas-actions">
            <button class="btn btn-ghost btn-sm" onclick="openChat(${l.id},'${isLot?'Lot '+lotCount+' kom':l.marka+' '+l.model}')">💬 Poruka</button>
            ${ponudaBtn}
          </div>
        </div>
      </div>
    </div>`;
  }).join('') + '</div>' +
  (hasMore ? `<div style="text-align:center;margin:16px 0"><button class="btn btn-ghost" onclick="window._buyerOglasiPage=(window._buyerOglasiPage||0)+1;renderBuyerListings()">Učitaj još (${active.length - paginated.length})</button></div>` : '');
}

// ═══════════════════════════════════════════════════════
// PONUDA OVERLAY
// ═══════════════════════════════════════════════════════
function openPonudaOvMin(lid, naziv, minCijena) {
  openPonudaOv(lid, naziv);
  // Postavi minimum
  const inp = document.getElementById('pon-iznos');
  if (inp) {
    inp.min = minCijena + 1;
    inp.placeholder = 'Min. ' + (minCijena + 1) + ' KM';
  }
  // Dodaj info o minimumu
  const sub = document.getElementById('pon-sub');
  if (sub) sub.textContent = 'Nova ponuda mora biti veća od ' + minCijena + ' KM';
}

function openPonudaOv(lid, naziv) {
  _ponudaLid = lid;
  document.getElementById('pon-title').textContent = naziv;
  document.getElementById('pon-sub').textContent = 'Unesite iznos vaše ponude';
  document.getElementById('pon-iznos').value = '';
  document.getElementById('pon-iznos').min = '';
  document.getElementById('pon-iznos').placeholder = 'npr. 150';
  const subEl = document.getElementById('pon-sub');
  if (subEl) subEl.textContent = 'Unesite iznos vaše ponude';
  // Postavi default dana iz profila
  const dSel = document.getElementById('pon-dani');
  if (dSel) dSel.value = String(CU && CU.defaultDana ? CU.defaultDana : defaultDana);
  document.getElementById('pon-step1').style.display = '';
  const ovP = document.getElementById('ov-ponuda');
  if (ovP) { ovP.classList.add('on'); }
  closeOv('ov-confirm-ponuda');
  setTimeout(()=>document.getElementById('pon-iznos').focus(),120);
}
function ponudaPreview() {
  const v=document.getElementById('pon-iznos').value;
  document.getElementById('pon-prev-iznos').textContent=v?v+' KM':'—';
}
function ponudaNext() {
  const c=parseFloat(document.getElementById('pon-iznos').value);
  if (!c||c<1) { toast('Unesite iznos ponude','err'); return; }
  const inp = document.getElementById('pon-iznos');
  const minVal = parseFloat(inp.min||0);
  if (minVal > 0 && c <= minVal) { toast('Ponuda mora biti veća od ' + minVal + ' KM', 'err'); return; }
  const l=LISTINGS.find(x=>x.id===_ponudaLid);
  const dani = parseInt(document.getElementById('pon-dani').value)||3;
  document.getElementById('pon-prev-iznos').textContent=c+' KM';
  document.getElementById('pon-prev-naziv').textContent=(l?l.marka+' '+l.model:'')+(l?' · '+getOwner(l).name:'');
  const daniTxt = dani===1?'1 dan':dani+' dana';
  document.getElementById('pon-prev-dani').textContent='⏱ Vrijedi '+daniTxt+' od slanja';
  document.getElementById('pon-step1').style.display='none';
  document.getElementById('ov-ponuda').classList.remove('on');
  document.getElementById('ov-confirm-ponuda').classList.add('on');
}
function ponudaBack() {
  document.getElementById('ov-confirm-ponuda').classList.remove('on');
  document.getElementById('ov-ponuda').classList.add('on');
  document.getElementById('pon-step1').style.display='';
}
async function ponudaConfirm() {
  if (!canBid()) {
    closeOv('ov-ponuda'); closeOv('ov-confirm-ponuda');
    toast('❌ Dnevni limit od '+FREE_DAILY_LIMIT+' ponuda je dostignut.', 'err');
    return;
  }
  const c=parseFloat(document.getElementById('pon-iznos').value);
  const dani=parseInt((document.getElementById('pon-dani')||{value:'3'}).value)||3;
  if (!c||!_ponudaLid) return;
  try {
    await api('POST', '/ponude', { listing_id: _ponudaLid, cijena: c, dani });
    incrementBidsToday(CU.id);
    closeOv('ov-ponuda'); closeOv('ov-confirm-ponuda');
    invalidateListingsCache();
    await renderBuyerListings();
    bTab('moje');
    toast('✅ Ponuda '+c+' KM poslana!','ok');
  } catch(err) {
    toast('❌ ' + err.message, 'err');
  }
}


// ═══════════════════════════════════════════════════════
// BUYER ZAVRŠENI
// ═══════════════════════════════════════════════════════
async function renderBuyerZavrseni() {
  const el = document.getElementById('b-zavrseni');
  el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px">Učitavam...</div>';
  try {
    const data = await api('GET', '/listings'); // forsiraj svjež fetch
    LISTINGS = data.map(parseListing);
  } catch(e) { el.innerHTML = '<div class="empty"><p>Greška.</p></div>'; return; }

  // Oglasi gdje je moja ponuda prihvaćena
  const myFinished = LISTINGS.filter(l => {
    const acc = (l.my_ponude||[]).find(p => p.status === 'accepted');
    return !!acc;
  });

  if (!myFinished.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">🏆</div><h3>Nema završenih kupovina</h3><p>Ovdje će biti oglasi gdje je vaša ponuda prihvaćena.</p></div>`;
    return;
  }

  const sortedFinished = [...myFinished].sort((a,b) => b.createdAt - a.createdAt);

  // Provjeri koje su već ocijenjene
  let buyerRatedSet = new Set();
  let buyerRatingMap = {};
  try {
    const checks = await Promise.all(
      sortedFinished.map(l => api('GET', '/ratings/check/' + l.id).catch(() => ({ rated: false })))
    );
    sortedFinished.forEach((l, i) => {
      if (checks[i].rated) {
        buyerRatedSet.add(l.id);
        buyerRatingMap[l.id] = checks[i].rating;
      }
    });
  } catch(e) {}

  el.innerHTML = sortedFinished.map(l => {
    const acc = (l.my_ponude||[]).find(p => p.status === 'accepted');
    const seller = getOwner(l);
    const myAddr = CU ? getBuyerAddr(CU) : null;
    const imgs = l.images && l.images.length ? l.images : (l.thumb ? [l.thumb] : []);
    const thumbSrc = imgs[0] || null;
    const gallB = imgs.length ? 'openLightbox(this.src,[' + imgs.map(u=>`\'${u}\'`).join(',') + '])' : '';
    const thumb = thumbSrc ? `<img src="${thumbSrc}" style="width:56px;height:56px;object-fit:cover;border-radius:6px;cursor:zoom-in" onclick="${gallB}">` : '🔧';
    return `<div class="card">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div class="s-oglas-thumb" style="width:56px;height:56px;font-size:22px;flex-shrink:0">${thumb}</div>
        <div style="flex:1;min-width:0">
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:17px">${l.marka} ${l.model}${l.god?' ('+l.god+')':''}</div>
          <div style="font-size:12px;color:var(--muted)">${l.broj?'Nr. '+l.broj+' · ':''}📍 ${seller.city}</div>
        </div>
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:900;font-size:22px;color:var(--green);flex-shrink:0">${acc?acc.cijena+' KM':''}</div>
      </div>
      <span class="badge b-ok" style="font-size:13px;padding:4px 12px;margin-bottom:12px;display:inline-block">✅ Ponuda prihvaćena</span>
      <div style="background:var(--gL);border:1px solid rgba(29,185,84,.2);border-radius:8px;padding:14px">
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:14px;color:var(--green);margin-bottom:8px">📦 Katalizator se šalje na vašu adresu</div>
        <div style="font-size:13px;color:var(--muted2);line-height:2">
          ${myAddr ? `<b style="color:var(--text)">${myAddr.name}</b><br>📌 ${myAddr.addr}<br>🏙️ ${myAddr.city}<br>📞 ${myAddr.tel}` : '<span style="color:var(--muted)">Adresa nije unesena u profilu</span>'}
        </div>
      </div>
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);font-size:12px;color:var(--muted2);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <span>Prodavač: <b style="color:var(--text);cursor:pointer;text-decoration:underline" onclick="openUserProfile(${l.uid||l.user_id},'${seller.name}')">${seller.name}</b> · 📞 ${seller.tel}</span>
        <button class="btn btn-ghost btn-sm" id="rate-btn-${l.id}" ${buyerRatedSet.has(l.id)?`disabled style="opacity:.5"`:''} onclick="checkAndRate(${l.uid||l.user_id},${l.id},'${l.marka} ${l.model}',this)">${buyerRatedSet.has(l.id) ? '⭐ Ocijenjeno ' + (buyerRatingMap[l.id] ? '★'.repeat(buyerRatingMap[l.id].stars)+'☆'.repeat(5-buyerRatingMap[l.id].stars) : '') : '⭐ Ocijeni prodavača'}</button>
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════
// MY PONUDE (buyer)
// ═══════════════════════════════════════════════════════
function renderMyPonude() {
  const el=document.getElementById('b-moje');
  const ponudeList = getMyPonude();
  if (!ponudeList.length) {
    el.innerHTML=`<div class="empty"><div class="empty-icon">📤</div><h3>Niste još slali ponude</h3><p>Idite na Aktivni oglasi.</p></div>`;
    return;
  }
  const sortedPonude = [...ponudeList].sort((a,b) => (b.createdAt||b.expiresAt||0) - (a.createdAt||a.expiresAt||0));
  const PG = 20;
  const pg = window._buyerPonudePage || 0;
  const paginated = sortedPonude.slice(0, (pg + 1) * PG);
  const hasMore = sortedPonude.length > paginated.length;
  el.innerHTML = paginated.map(mp=>{
    const l=LISTINGS.find(x=>x.id===mp.lid); if(!l) return '';
    const p=l.ponude.find(x=>x.buyerId===CU.id && x.cijena===mp.cijena) || l.ponude.find(x=>x.id===mp.pid);
    const rawStatus = p ? p.status : mp.status || 'pending';
    const status = rawStatus === 'rejected' ? 'declined' : rawStatus;
    const stColor = status==='accepted' ? 'var(--green)' : status==='declined' ? 'var(--red)' : 'var(--yellow)';
    const stText  = status==='accepted' ? '✅ Prihvaćena' : status==='declined' ? '❌ Odbijena' : '⏳ Na čekanju';
    const imgs = l.images && l.images.length ? l.images : (l.thumb ? [l.thumb] : []);
    const thumbSrc = imgs[0] || null;
    const gallJS = imgs.length ? `openLightbox(this.src,[${imgs.map(u=>`'${u}'`).join(',')}])` : '';
    const thumb = thumbSrc
      ? `<img src="${thumbSrc}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;cursor:zoom-in;flex-shrink:0" onclick="${gallJS}">`
      : `<span style="font-size:20px">🔧</span>`;
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border)">
      ${thumb}
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:700">${l.marka} ${l.model}${l.god?' ('+l.god+')':''}</div>
        <div style="font-size:11px;color:var(--muted)">${l.broj?'Nr. '+l.broj+' · ':''}${mp.cijena} KM · ${mp.createdAt ? fmtDate(mp.createdAt) : ''}</div>
      </div>
      <span style="font-size:12px;color:${stColor};font-weight:700;flex-shrink:0">${stText}</span>
    </div>`;
  }).join('');
  // Wrap u card
  el.innerHTML = `<div style="background:var(--dark);border:1px solid var(--border);border-radius:10px;overflow:hidden">${el.innerHTML}</div>` +
    (hasMore ? `<div style="text-align:center;margin:12px 0"><button class="btn btn-ghost" onclick="window._buyerPonudePage=(window._buyerPonudePage||0)+1;renderMyPonude()">Učitaj još (${sortedPonude.length - paginated.length})</button></div>` : '');
}

// ═══════════════════════════════════════════════════════
// CHAT
// ═══════════════════════════════════════════════════════
async function openChat(lid, title) {
  chatLid = lid;
  const l = LISTINGS.find(x=>x.id===lid);
  const sellerName = l ? (l.owner_name || l.name || 'Prodavač') : 'Prodavač';
  document.getElementById('ch-av').textContent = initials(sellerName);
  document.getElementById('ch-av').style.background = avCol(String(l ? l.uid : 'x1'));
  document.getElementById('ch-name').textContent = sellerName + ' · ' + title;
  const ta = document.getElementById('chat-ta');
  ta.value = ''; ta.style.height = 'auto';
  document.getElementById('ov-chat').classList.add('on');
  updateSendBtn();
  // Učitaj poruke iz API
  await loadChatMsgs(lid);
  markRead(chatLid);
  // Označi kao pročitano na serveru
  api('PUT', '/chat/'+lid+'/read').catch(()=>{});
  updatePorukeBadges();
  setTimeout(()=>ta.focus(), 150);
}

async function loadChatMsgs(lid) {
  try {
    const l = LISTINGS.find(x=>x.id===lid);
    let url = '/chat/'+lid;
    // Ako je seller — treba buyer_id query param; koristimo prvu ponudu
    if (CU.role === 'seller' && l && l.ponude && l.ponude.length) {
      url += '?buyer_id=' + l.ponude[0].buyerId;
    }
    const msgs = await api('GET', url);
    const sellerUid = l ? (l.uid || l.user_id) : null;
    chatHistory[lid] = msgs.map(m => ({
      senderId: m.sender_id,
      senderName: m.sender_name,
      from: String(m.sender_id) === String(sellerUid) ? 'seller' : 'buyer',
      msg: m.text || '',
      imgUrl: m.image_url || null,
      time: new Date(m.created_at).toLocaleTimeString('bs',{hour:'2-digit',minute:'2-digit'})
    }));
    // Spremi buyer_id za seller odgovor (prva poruka koja nije od sellera)
    const buyerMsg = chatHistory[lid].find(m => m.from === 'buyer');
    if (buyerMsg) chatHistory[lid]._buyerId = buyerMsg.senderId;
  } catch(e) {
    // Ne briši postojeću historiju pri grešci
    if (!chatHistory[lid]) chatHistory[lid] = [];
  }
  renderChatMsgs();
}

function renderChatMsgs() {
  const msgs = chatHistory[chatLid] || [];
  const el = document.getElementById('chat-msgs');
  if (!msgs.length) {
    el.innerHTML = '<div class="chat-empty"><div class="chat-empty-icon">💬</div>Pošaljite prvu poruku</div>';
    return;
  }
  el.innerHTML = msgs.map((m, i) => {
    const isMe = m.senderId === CU.id;
    const prev = msgs[i-1];
    const showAv = !isMe && (!prev || prev.senderId === CU.id);
    const theirId   = isMe ? (msgs.find(x=>x.senderId!==CU.id)||{senderId:'x'}).senderId : m.senderId;
    const theirName = isMe ? (msgs.find(x=>x.senderId!==CU.id)||{senderName:'?'}).senderName : m.senderName;
    const avColor = isMe ? avCol(CU.id) : avCol(theirId);
    const avText  = isMe ? initials(CU.name) : initials(theirName||'?');
    const content = m.imgUrl
      ? `<img class="bubble-img" src="${m.imgUrl}" onclick="openLightbox('${m.imgUrl}')">`
      : m.msg.split('\n').join('<br>');
    return `<div class="bubble-wrap ${isMe?'me':''}">
      ${!isMe?`<div class="bubble-av" style="background:${avColor};${showAv?'':'opacity:0;pointer-events:none'}">${avText}</div>`:''}
      <div class="bubble ${isMe?'me':'them'}">${content}<span class="bubble-time">${m.time}</span></div>
    </div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}


function markAllPorukeRead(role) {
  if (!CU) return;
  if (role === 'seller') {
    // Označi sve poruke na seller-ovim oglasima kao pročitane
    LISTINGS.filter(l => l.uid === CU.id).forEach(l => {
      if ((chatHistory[l.id]||[]).length) markRead(l.id);
    });
  } else {
    // Označi sve konverzacije gdje je buyer učestvovao
    LISTINGS.forEach(l => {
      if ((chatHistory[l.id]||[]).some(m => m.senderId === CU.id)) markRead(l.id);
    });
  }
}

function markRead(lid) {
  if (!CU || !lid) return;
  unreadLids.delete(CU.id + ':' + lid);
}

function hasUnread(lid) {
  if (!CU) return false;
  return unreadLids.has(CU.id + ':' + lid);
}

function updatePorukeBadges() {
  if (!CU) return;
  if (CU.role === 'seller') {
    const myIds = LISTINGS.filter(l => l.uid === CU.id).map(l => l.id);
    const cnt = myIds.filter(lid => hasUnread(lid)).length;
    const b = document.getElementById('poruke-badge');
    if (b) { b.style.display = cnt ? 'inline' : 'none'; b.textContent = cnt; }
    const bb = document.getElementById('sbn-poruke-badge');
    if (bb) { bb.style.display = cnt ? 'block' : 'none'; bb.textContent = cnt; }
  } else if (CU.role === 'buyer') {
    const cnt = LISTINGS.filter(l => hasUnread(l.id)).length;
    const b = document.getElementById('b-poruke-badge');
    if (b) { b.style.display = cnt ? 'inline' : 'none'; b.textContent = cnt; }
    const bb = document.getElementById('bbn-poruke-badge');
    if (bb) { bb.style.display = cnt ? 'block' : 'none'; bb.textContent = cnt; }
  }
}

// Polling za unread badges svakih 30s
let _badgePollInterval = null;
function startBadgePoll() {
  if (_badgePollInterval) return;
  // Odmah fetchaj badges
  (async () => {
    try {
      const inbox = await api('GET', '/chat/inbox');
      inbox.forEach(c => {
        const key = CU.id + ':' + c.listing_id;
        if (parseInt(c.unread_count) > 0) unreadLids.add(key);
        else unreadLids.delete(key);
      });
      updatePorukeBadges();
    } catch(e) {}
  })();
  _badgePollInterval = setInterval(async () => {
    if (!CU) return;
    try {
      const inbox = await api('GET', '/chat/inbox');
      let changed = false;
      inbox.forEach(c => {
        const key = CU.id + ':' + c.listing_id;
        const had = unreadLids.has(key);
        if (parseInt(c.unread_count) > 0) { unreadLids.add(key); if (!had) changed = true; }
        else unreadLids.delete(key);
      });
      if (changed || inbox.length) updatePorukeBadges();
    } catch(e) {}
  }, 20000);
}


async function sendChatImg(input) {
  const file = input.files[0];
  input.value = ''; // resetuj odmah da ne pita ponovo
  if (!file || !chatLid) return;
  const listing = LISTINGS.find(x=>x.id===chatLid);
  if (!listing) return;
  let receiver_id;
  if (CU.role === 'buyer') {
    receiver_id = parseInt(listing.uid||listing.user_id);
  } else {
    const hist = chatHistory[chatLid] || [];
    const bId = hist._buyerId || (hist.find(m => m.from === 'buyer') || {}).senderId;
    receiver_id = bId ? parseInt(bId) : null;
  }
  if (!receiver_id) { toast('Nema aktivne konverzacije s kupcem', 'err'); return; }
  // Prikaži progress bar u chatu
  const chatEl = document.getElementById('chat-msgs');
  const progressId = 'up-prog-'+Date.now();
  if (chatEl) {
    const prog = document.createElement('div');
    prog.id = progressId;
    prog.style.cssText = 'text-align:center;padding:8px;font-size:12px;color:var(--muted)';
    prog.innerHTML = '<div style="background:var(--border);border-radius:4px;overflow:hidden;height:4px;margin-bottom:4px"><div id="prog-bar-'+progressId+'" style="height:100%;background:var(--orange);width:0%;transition:width .3s"></div></div>Šaljem sliku...';
    chatEl.appendChild(prog);
    chatEl.scrollTop = chatEl.scrollHeight;
  }
  const updateProg = pct => {
    const bar = document.getElementById('prog-bar-'+progressId);
    if (bar) bar.style.width = pct+'%';
  };
  updateProg(20);
  try {
    const fd = new FormData();
    fd.append('images', file);
    const token = localStorage.getItem('token');
    updateProg(40);
    const upRes = await fetch('/api/upload', { method:'POST', headers:{ Authorization:'Bearer '+token }, body: fd });
    updateProg(80);
    if (!upRes.ok) {
      const errText = await upRes.text();
      throw new Error('Upload greška: ' + (errText.includes('{') ? JSON.parse(errText).error : 'Pokušajte ponovo'));
    }
    const upData = await upRes.json();
    const image_url = upData.urls ? upData.urls[0] : null;
    if (!image_url) throw new Error('Upload slike nije uspio');
    updateProg(90);
    await api('POST', '/chat/'+chatLid, { receiver_id, image_url });
    if (CU.role === 'seller') {
      await loadChatMsgsWithBuyer(chatLid, receiver_id);
    } else {
      await loadChatMsgs(chatLid);
    }
    markRead(chatLid);
    updatePorukeBadges();
  } catch(err) { toast('❌ ' + err.message, 'err'); }
  // Ukloni progress bar
  const progEl = document.getElementById(progressId);
  if (progEl) progEl.remove();
}

let _lbGallery = [];
let _lbIdx = 0;

function openLightbox(src, gallery) {
  _lbGallery = gallery && gallery.length ? gallery : [src];
  _lbIdx = _lbGallery.indexOf(src);
  if (_lbIdx < 0) _lbIdx = 0;
  _lbRender();
  document.getElementById('lightbox').classList.add('on');
  _pushBack(() => closeLightbox());
}

function closeLightbox() {
  const lb = document.getElementById('lightbox');
  if (!lb || !lb.classList.contains('on')) return;
  lb.classList.remove('on');
  _lbGallery = []; _lbIdx = 0; _lbScale = 1;
  const img = document.getElementById('lightbox-img');
  if (img) { img.classList.remove('zoomed'); img.style.transform = 'scale(1)'; }
}

let _lbScale = 1;

function lbZoom(dir) {
  _lbScale = Math.min(4, Math.max(0.5, _lbScale + dir * 0.5));
  const img = document.getElementById('lightbox-img');
  if (img) img.style.transform = `scale(${_lbScale})`;
}

function lbZoomReset() {
  _lbScale = 1;
  const img = document.getElementById('lightbox-img');
  if (img) img.style.transform = 'scale(1)';
}

function lbNav(dir) {
  _lbIdx = (_lbIdx + dir + _lbGallery.length) % _lbGallery.length;
  _lbScale = 1;
  const img = document.getElementById('lightbox-img');
  if (img) { img.style.transform = 'scale(1)'; img.classList.remove('zoomed'); }
  _lbRender();
}

function _lbRender() {
  document.getElementById('lightbox-img').src = _lbGallery[_lbIdx];
  const multi = _lbGallery.length > 1;
  const prev = document.getElementById('lb-prev');
  const next = document.getElementById('lb-next');
  const ctr  = document.getElementById('lb-counter');
  if (prev) prev.style.display = multi ? 'flex' : 'none';
  if (next) next.style.display = multi ? 'flex' : 'none';
  if (ctr)  { ctr.style.display = multi ? 'block' : 'none'; ctr.textContent = (_lbIdx+1) + ' / ' + _lbGallery.length; }
}

// Zatvori klik na pozadinu
document.addEventListener('click', e => {
  if (e.target.id === 'lightbox') closeLightbox();
});
// Strelice na tastaturi
document.addEventListener('keydown', e => {
  const lb = document.getElementById('lightbox');
  if (!lb || !lb.classList.contains('on')) return;
  if (e.key === 'ArrowLeft')  lbNav(-1);
  if (e.key === 'ArrowRight') lbNav(1);
  if (e.key === 'Escape')     closeLightbox();
});

async function sendChat() {
  const ta=document.getElementById('chat-ta');
  const txt=ta.value.trim();
  if (!txt||!chatLid) return;
  const listing = LISTINGS.find(x=>x.id===chatLid);
  if (!listing) return;
  // Odredi receiver_id
  let receiver_id;
  if (CU.role === 'buyer') {
    receiver_id = parseInt(listing.uid||listing.user_id);
  } else {
    // Seller — uzmi buyer_id iz chat historije
    const hist = chatHistory[chatLid] || [];
    const bId = hist._buyerId || (hist.find(m => m.from === 'buyer') || {}).senderId;
    receiver_id = bId ? parseInt(bId) : null;
  }
  if (!receiver_id) { toast('Nema aktivne konverzacije s kupcem', 'err'); return; }
  try {
    await api('POST', '/chat/'+chatLid, { receiver_id, text: txt });
    ta.value=''; ta.style.height='auto';
    updateSendBtn();
    // Seller mora koristiti loadChatMsgsWithBuyer da ne izgubi historiju
    if (CU.role === 'seller') {
      await loadChatMsgsWithBuyer(chatLid, receiver_id);
    } else {
      await loadChatMsgs(chatLid);
    }
    markRead(chatLid);
    updatePorukeBadges();
  } catch(err) { toast('❌ ' + err.message, 'err'); }
  // Ukloni progress bar
  const progEl = document.getElementById(progressId);
  if (progEl) progEl.remove();
}

function updateSendBtn() {
  const btn=document.getElementById('chat-send-btn');
  if (btn) btn.disabled=!document.getElementById('chat-ta').value.trim();
}

// ═══════════════════════════════════════════════════════
// PROFIL
// ═══════════════════════════════════════════════════════
function openProfil() {
  if (!CU) return;
  const u=CU, col=u.role==='buyer'?'#c0392b':u.role==='admin'?'#8e44ad':'#e67e22';
  const entityLabel=u.entity==='firma'?'🏢 Firma':u.entity==='fizicko'?'👤 Fizičko lice':'';
  const roleLabel=(u.role==='buyer'?'Otkupljivač':u.role==='admin'?'Admin':'Prodavač')+(entityLabel?' · '+entityLabel:'');
  const stB=u.status==='approved'?'<span class="badge b-ok">✅ Aktivan</span>':'<span class="badge b-wait">⏳ Na čekanju</span>';
  const untilStr = u.premiumUntil ? ' do '+fmtDate(u.premiumUntil) : '';
  const vB=u.premium?`<span class="badge b-orange">⭐ Premium${untilStr}</span>`:''; const premB='';
  const premiumBlock = (u.role === 'buyer' && !u.premium) ? `
    <div class="divider"></div>
    <div style="background:linear-gradient(135deg,#0a0e18,#060d0a);border:1.5px solid rgba(244,196,48,.25);border-radius:10px;padding:18px;margin-top:4px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:20px">🔓</span>
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:17px;color:var(--yellow)">Postani Premium otkupljivač</div>
      </div>
      <div style="font-size:13px;color:var(--muted2);line-height:1.7;margin-bottom:14px">
        Premium status povećava povjerenje prodavača i daje ti prioritet u listi ponuda i neograničene ponude.<br>
        Godišnja pretplata: <b style="color:var(--text)">50 KM</b>
      </div>
      <div style="font-size:12px;color:var(--muted2);margin-bottom:12px;line-height:1.8">
        <b style="color:var(--text)">Načini uplate:</b><br>
        💳 <b style="color:var(--text)">Virman / Uplata:</b><br>
        &nbsp;&nbsp;Berza Katalizatora d.o.o.<br>
        &nbsp;&nbsp;IBAN: <b style="color:var(--text)">BA39 1234 5678 9012 3456</b><br>
        &nbsp;&nbsp;Svrha: <b style="color:var(--text)">Premium – ${u.email}</b><br><br>
        ₿ <b style="color:var(--text)">Crypto (USDT TRC20):</b><br>
        &nbsp;&nbsp;<span style="word-break:break-all;color:var(--text);font-size:11px">TRx9Kdemo...wallet</span><br>
        &nbsp;&nbsp;Pošalji potvrdu na: <b style="color:var(--text)">admin@berza.ba</b>
      </div>
      <div style="background:var(--yL);border:1px solid rgba(244,196,48,.2);border-radius:6px;padding:9px 12px;font-size:12px;color:var(--yellow)">
        ⚠️ Nakon uplate pošalji potvrdu na admin@berza.ba — aktivacija unutar 24h.
      </div>
    </div>` : (u.role === 'buyer' && u.premium) ? `
    <div class="divider"></div>
    <div style="background:var(--gL);border:1px solid rgba(29,185,84,.2);border-radius:8px;padding:14px 16px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:${u.premiumUntil?'8':'0'}px">
        <span style="font-size:22px">✅</span>
        <div>
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:15px;color:var(--green)">Premium otkupljivač</div>
          <div style="font-size:12px;color:var(--muted2)">Vaš nalog ima Premium status. Prodavači te vide kao pouzdanog kupca.</div>
        </div>
      </div>
      ${u.premiumUntil ? `<div style="font-size:12px;color:var(--muted2);padding-top:8px;border-top:1px solid rgba(29,185,84,.15)">
        📅 Premium važi do: <b style="color:var(--green)">${fmtDate(u.premiumUntil)}</b>
        ${u.premiumUntil - Date.now() < 30*86400000 ? '<span style="color:var(--yellow);margin-left:6px">⚠️ Ističe uskoro — kontaktirajte admina za obnovu</span>' : ''}
      </div>` : ''}
    </div>` : '';

  document.getElementById('profil-content').innerHTML=`
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
      <div style="width:48px;height:48px;border-radius:50%;background:${col};display:flex;align-items:center;justify-content:center;font-family:'Barlow Condensed',sans-serif;font-weight:900;font-size:17px;color:#fff">${initials(u.name)}</div>
      <div><div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:18px">${u.name}</div>
      <div style="font-size:12px;color:var(--muted2);margin-top:2px">${u.email} · ${roleLabel} ${stB} ${vB}</div></div>
    </div>
    <div class="divider"></div>
    <div class="row2">
      <div class="fg"><label>Ime / Naziv</label><input id="p-name" value="${u.name||''}"></div>
      <div class="fg"><label>Grad</label>
        <div class="ac-wrap">
          <input id="p-city" value="${u.city||''}" placeholder="Upiši grad..." autocomplete="off">
          <div class="ac-list" id="ac-p-city"></div>
        </div>
      </div>
    </div>
    <div class="row2"><div class="fg"><label>Adresa</label><input id="p-addr" value="${u.addr||''}"></div><div class="fg"><label>Telefon</label><input id="p-tel" value="${u.tel||''}"></div></div>
    ${u.role==='buyer' ? `
    <div class="divider"></div>
    <div class="fg">
      <label>Default period važenja ponude</label>
      <select id="p-default-dani">
        ${[1,2,3,4,5,6,7].map(d=>`<option value="${d}" ${(u.defaultDana||3)===d?'selected':''}>${d} ${d===1?'dan':'dana'}</option>`).join('')}
      </select>
      <div style="font-size:11px;color:var(--muted);margin-top:4px">Ovo će biti automatski odabran period kad šalješ ponudu</div>
    </div>` : ''}
    <div class="divider"></div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
      <div>
        <div style="font-size:13px;font-weight:600">📧 Email notifikacije</div>
        <div style="font-size:11px;color:var(--muted)">Primaj email pri novim porukama i ponudama</div>
      </div>
      <label style="position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0">
        <input type="checkbox" id="p-email-notify" ${u.emailNotify!==false?'checked':''} onchange="toggleEmailNotify(this.checked)" style="opacity:0;width:0;height:0;position:absolute">
        <span style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:${u.emailNotify!==false?'var(--green)':'var(--border2)'};border-radius:24px;transition:.3s">
          <span style="position:absolute;height:18px;width:18px;left:${u.emailNotify!==false?'23':'3'}px;bottom:3px;background:#fff;border-radius:50%;transition:.3s"></span>
        </span>
      </label>
    </div>
    <button class="btn btn-primary btn-sm" onclick="saveProfile()">💾 Sačuvaj</button>
    ${premiumBlock}
  `;
  document.getElementById('ov-profil').classList.add('on');
  // Dodaj privremeni country select za profil AC
  setTimeout(() => {
    if (!document.getElementById('p-country-hidden')) {
      const sel = document.createElement('select');
      sel.id = 'p-country-hidden';
      sel.style.display = 'none';
      sel.innerHTML = '<option value="ba">ba</option><option value="rs">rs</option>';
      // Postavi vrijednost na osnovu trenutnog grada
      // country detection not needed
      document.body.appendChild(sel);
    }
    initAC('p-city', 'p-country-hidden');
  }, 50);
}
function saveProfile() {
  CU.name=document.getElementById('p-name').value.trim()||CU.name;
  CU.city=document.getElementById('p-city').value.trim();
  CU.addr=document.getElementById('p-addr').value.trim();
  CU.tel =document.getElementById('p-tel').value.trim();
  const dEl=document.getElementById('p-default-dani');
  if (dEl) { CU.defaultDana=parseInt(dEl.value)||3; defaultDana=CU.defaultDana; }
  // CU je ažuriran direktno — getBuyerAddr(CU) će automatski koristiti nove podatke
  document.getElementById('uc-av').textContent=initials(CU.name);
  document.getElementById('uc-name').textContent=CU.name;
  closeOv('ov-profil');
  toast('✅ Profil ažuriran','ok');
}

// ═══════════════════════════════════════════════════════
// CONFIRM
// ═══════════════════════════════════════════════════════
function showConfirm(title,msg,okLabel,cb) {
  document.getElementById('confirm-title').textContent=title;
  document.getElementById('confirm-msg').textContent=msg;
  const btn=document.getElementById('confirm-ok');
  btn.textContent=okLabel;
  btn.onclick=()=>{ closeOv('ov-confirm'); cb(); };
  document.getElementById('ov-confirm').classList.add('on');
}

// ═══════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════
let adminFilterRole = 'all';
let adminFilterCountry = 'all';

function setAdminFilter(f) {
  adminFilterRole = f;
  ['all','seller','buyer'].forEach(x=>{
    const b=document.getElementById('af-'+x);
    if(b) b.className='btn btn-xs '+(x===f?'btn-primary':'btn-ghost');
  });
  renderAdminUsers();
}

function setAdminCountry(c) {
  adminFilterCountry = c;
  ['all','BA','RS'].forEach(x=>{
    const b=document.getElementById('afc-'+x);
    if(b) b.className='btn btn-xs '+(x===c?'btn-primary':'btn-ghost');
  });
  renderAdminUsers();
}

async function renderAdminUsers() {
  const q=(document.getElementById('admin-search')||{value:''}).value.trim().toLowerCase();
  try {
    const data = await api('GET', '/admin/users');
    USERS = data.map(u => ({
      ...u,
      premiumUntil: u.premium_until ? new Date(u.premium_until).getTime() : null,
      defaultDana: u.default_dana || 3
    }));
  } catch(e) { toast('Greška pri učitavanju korisnika', 'err'); return; }
  let list=USERS.filter(u=>u.role!=='admin');
  if (adminFilterRole !== 'all') list = list.filter(u => u.role === adminFilterRole);
  if (adminFilterCountry !== 'all') list = list.filter(u => (u.country||'BA').toUpperCase() === adminFilterCountry);
  if(q) list=list.filter(u=>u.name.toLowerCase().includes(q)||u.email.toLowerCase().includes(q)||(u.city||'').toLowerCase().includes(q));
  const pend=list.filter(u=>u.status==='pending');
  const rest=list.filter(u=>u.status!=='pending');
  const badge=document.getElementById('admin-badge');
  const allPend=USERS.filter(u=>u.role!=='admin'&&u.status==='pending');
  badge.style.display=allPend.length?'inline':'none'; badge.textContent=allPend.length;
  let h='';
  if(pend.length){
    h+=`<div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:11px;color:var(--yellow);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">⏳ Na čekanju (${pend.length})</div>`;
    h+=pend.map(adminCard).join('');
    h+=`<div class="divider"></div>`;
  }
  if(rest.length){
    h+=`<div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Svi (${rest.length})</div>`;
    h+=rest.map(adminCard).join('');
  }
  if(!list.length) h=`<div class="empty"><div class="empty-icon">🔍</div><h3>Nema rezultata</h3></div>`;
  document.getElementById('a-users').innerHTML = `<div class="admin-users-grid">${h}</div>`;
}

function adminCard(u) {
  const col=u.role==='buyer'?'#c0392b':'#e67e22';
  const rB=u.role==='buyer'?'<span class="badge b-orange">Otkupljivač</span>':'<span class="badge b-blue">Prodavač</span>';
  const sB=u.status==='approved'?'<span class="badge b-ok">✅</span>':u.status==='pending'?'<span class="badge b-wait">⏳</span>':'<span class="badge b-err">❌</span>';
  const vUntil=u.premiumUntil?(' do '+fmtDate(u.premiumUntil)):''; const vB=''; const pB=u.premium?`<span class="badge b-orange" style="font-size:10px">⭐ Premium${vUntil}</span>`:'';
  // Sve akcije u jedan dropdown
  const ddItems = [];
  if (u.status==='pending') {
    ddItems.push(`<div class="admin-dd-item success" onclick="admApprove('${u.id}');closeAdminDD()">✅ Odobri nalog</div>`);
    ddItems.push(`<div class="admin-dd-item danger" onclick="admReject('${u.id}');closeAdminDD()">❌ Odbij nalog</div>`);
  } else if (u.status==='approved') {
    ddItems.push(`<div class="admin-dd-item danger" onclick="admReject('${u.id}');closeAdminDD()">🚫 Suspenduj</div>`);
  } else {
    ddItems.push(`<div class="admin-dd-item success" onclick="admApprove('${u.id}');closeAdminDD()">♻️ Reaktiviraj</div>`);
  }
  if (u.role==='buyer') {
    ddItems.push(`<div class="admin-dd-sep"></div>`);
    if (u.premium) ddItems.push(`<div class="admin-dd-item danger" onclick="admSetPremium('${u.id}',false);closeAdminDD()">🔓 Ukloni Premium</div>`);
    else ddItems.push(`<div class="admin-dd-item success" onclick="admSetPremium('${u.id}',true);closeAdminDD()">⭐ Postavi Premium (+1g)</div>`);

  }
  ddItems.push(`<div class="admin-dd-sep"></div>`);
  return `<div class="admin-card" id="ac-${u.id}" onclick="toggleUserDetail('${u.id}')" style="cursor:pointer;padding:8px 10px">
    <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
      <div class="admin-av" style="background:${col};width:32px;height:32px;font-size:12px;flex-shrink:0">${initials(u.name)}</div>
      <div style="min-width:0;flex:1">
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:13px;display:flex;align-items:center;gap:4px;flex-wrap:wrap">${u.name} ${rB} ${sB} ${pB}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${u.email} · ${u.city||'—'} · ${u.tel||'—'}</div>
      </div>
    </div>
    <div style="flex-shrink:0;margin-left:6px">
      <div class="admin-dd" id="add-${u.id}" onclick="event.stopPropagation()">
        <button class="admin-dd-btn" onclick="toggleAdminDD('${u.id}')">Akcije ▾</button>
        <div class="admin-dd-menu">${ddItems.join('')}</div>
      </div>
    </div>
  </div>`;
}


function toggleAdminDD(uid) {
  document.querySelectorAll('.admin-dd.open').forEach(d => { if (d.id !== 'add-'+uid) d.classList.remove('open'); });
  const dd = document.getElementById('add-'+uid);
  if (dd) dd.classList.toggle('open');
}
function closeAdminDD() {
  document.querySelectorAll('.admin-dd.open').forEach(d => d.classList.remove('open'));
}
document.addEventListener('click', e => {
  if (!e.target.closest('.admin-dd')) closeAdminDD();
});

function openPremiumInfo() { document.getElementById('ov-premium').classList.add('on'); }

async function admSetPremium(uid, val) {
  try {
    if (val) await api('PUT', '/admin/users/'+uid+'/premium', { days: 365 });
    else await api('DELETE', '/admin/users/'+uid+'/premium'); // koristi pravi DELETE endpoint
    toast(val ? '⭐ Premium dodijeljen' : 'Premium uklonjen', val ? 'ok' : '');
    renderAdminUsers();
  } catch(err) { toast('❌ ' + err.message, 'err'); }
}

async function admApprove(uid) {
  try {
    await api('PUT', '/admin/users/'+uid+'/approve');
    toast('✅ Korisnik odobren', 'ok');
    renderAdminUsers();
  } catch(err) { toast('❌ ' + err.message, 'err'); }
}
async function admReject(uid) {
  try {
    await api('PUT', '/admin/users/'+uid+'/reject');
    toast('Korisnik suspendovan', '');
    renderAdminUsers();
  } catch(err) { toast('❌ ' + err.message, 'err'); }
}

async function toggleUserDetail(uid) {
  let el = document.getElementById('ad-'+uid);
  if (!el) {
    const card = document.getElementById('ac-'+uid);
    if (!card) return;
    el = document.createElement('div');
    el.id = 'ad-'+uid;
    el.style.cssText = 'background:var(--dark);border:1px solid var(--border);border-radius:0 0 8px 8px;margin-top:-8px;border-top:none;padding:14px 16px;';
    el.style.display = 'none';
    card.insertAdjacentElement('afterend', el);
  }
  if (el.style.display !== 'none') { el.style.display='none'; return; }
  el.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px">Učitavam...</div>';
  el.style.display = '';
  // Fetchaj korisnika ako nije u USERS
  let u = getU(uid);
  if (!u) {
    try {
      const allUsers = await api('GET', '/admin/users');
      USERS = allUsers.map(x => ({ ...x, premiumUntil: x.premium_until ? new Date(x.premium_until).getTime() : null }));
      u = getU(uid);
    } catch(e) {}
  }
  if (!u) { el.innerHTML = '<div style="color:var(--red);padding:8px">Korisnik nije pronađen</div>'; return; }
  // Fetchaj oglase i ponude
  let userListings = [];
  let userPonude = [];
  try {
    const allListings = await api('GET', '/listings');
    if (u.role === 'seller') {
      userListings = allListings.filter(l => String(l.user_id) === String(uid));
    } else {
      const ponudeRes = await api('GET', '/admin/ponude').catch(()=>[]);
      userPonude = ponudeRes.filter(p => String(p.buyer_id) === String(uid));
    }
  } catch(e) {}
  const col=u.role==='buyer'?'#c0392b':'#e67e22';
  // Fetchaj inbox za ovog korisnika direktno iz API-ja
  let userConvoData = [];
  try {
    const inboxRes = await api('GET', '/admin/chat/inbox/'+uid).catch(()=>[]);
    userConvoData = Array.isArray(inboxRes) ? inboxRes : [];
  } catch(e) {}

  let h=`<div style="padding:4px 0">`;
  // Samo datum i premium — ime/email/grad/tel već vidljivi na kartici iznad
  h+=`<div style="font-size:11px;color:var(--muted);margin-bottom:12px">
    Registrovan: ${fmtDate(new Date(u.created_at).getTime())}
    ${u.premium && u.premiumUntil ? ` &nbsp;·&nbsp; <span style="color:var(--yellow)">⭐ Premium do: ${fmtDate(u.premiumUntil)}</span>` : ''}
  </div>
  <div class="divider"></div>`;

  if(u.role==='seller'){
    const sold = userListings.filter(l => l.status==='finished'||l.status==='sent');
    h+=`<div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:13px;margin-bottom:8px">OGLASI (${userListings.length}) · Prodano: ${sold.length}</div>`;
    h+=userListings.length?userListings.map(l=>{
      const stLabel = l.status==='active'?'Aktivan':l.status==='finished'?'Završen':l.status==='sent'?'Poslato':l.status;
      const stColor = l.status==='active'?'var(--green)':l.status==='finished'||l.status==='sent'?'var(--orange)':'var(--muted)';
      const soldDate = l.sold_at ? ' · Prodano: '+fmtDate(new Date(l.sold_at).getTime()) : '';
      return `<div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:6px;padding:9px 12px;margin-bottom:5px;display:flex;justify-content:space-between;align-items:center">
        <div style="min-width:0;flex:1">
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:13px">${l.marka} ${l.model}${l.god?' ('+l.god+')':''}</div>
          <div style="font-size:11px;color:var(--muted)">Dodano: ${fmtDate(new Date(l.created_at).getTime())}${soldDate}</div>
          <span style="font-size:10px;color:${stColor}">${stLabel}</span>
        </div>
        <button class="btn btn-or btn-xs" onclick="admDeleteListing(${l.id})">🗑</button>
      </div>`;
    }).join(''):
    '<div style="font-size:12px;color:var(--muted)">Nema oglasa</div>';
  } else {
    const accepted = userPonude.filter(p=>p.status==='accepted');
    const rejected = userPonude.filter(p=>p.status==='rejected');
    h+=`<div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:13px;margin-bottom:8px">PONUDE (${userPonude.length}) · Prihvaćene: ${accepted.length} · Odbijene: ${rejected.length}</div>`;
    h+=userPonude.length?userPonude.map(p=>{
      const stColor = p.status==='accepted'?'var(--green)':p.status==='rejected'?'var(--red)':'var(--yellow)';
      const stLabel = p.status==='accepted'?'Prihvaćena':p.status==='rejected'?'Odbijena':'Na čekanju';
      const respondDate = p.responded_at ? ' · Odgovor: '+fmtDate(new Date(p.responded_at).getTime()) : '';
      return `<div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:6px;padding:9px 12px;margin-bottom:5px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:13px">${p.marka||'—'} ${p.model||''}</div>
          <div style="font-size:11px;color:var(--muted)">Poslano: ${fmtDate(new Date(p.created_at).getTime())}${respondDate}</div>
          <span style="font-size:10px;color:${stColor}">${stLabel}</span>
        </div>
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:16px;color:var(--green)">${p.cijena} KM</div>
      </div>`;
    }).join(''):
    '<div style="font-size:12px;color:var(--muted)">Nema ponuda</div>';
  }

  // ── Konverzacije iz API-ja ──
  h += `<div class="divider"></div><div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:13px;margin-bottom:8px">KONVERZACIJE (${userConvoData.length})</div>`;
  h += userConvoData.length ? userConvoData.map(c => {
    const title = (c.marka||'') + ' ' + (c.model||'');
    const preview = c.last_text ? c.last_text.slice(0,40) : '—';
    const lastDate = c.last_at ? fmtDate(new Date(c.last_at).getTime()) : '';
    return `<div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:6px;padding:9px 12px;margin-bottom:5px;display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="min-width:0;flex:1">
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:13px">${title.trim()||'Oglas #'+c.listing_id}</div>
        <div style="font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${lastDate} · "${preview}"</div>
      </div>
      <button class="btn btn-ghost btn-xs" onclick="admViewChat(${c.listing_id},${u.id})">Čitaj</button>
    </div>`;
  }).join('') : '<div style="font-size:12px;color:var(--muted)">Nema konverzacija</div>';
  h+='<div class="divider"></div><button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'ad-'+uid+'\').style.display=\'none\'">← Zatvori</button></div>';
  el.style.background='var(--dark)';
  el.style.borderRadius='0 0 8px 8px';
  el.style.marginTop='-8px';
  el.style.border='1px solid var(--border)';
  el.style.borderTop='none';
  el.style.padding='14px 16px';
  el.innerHTML=h;
  el.style.display='';
  el.scrollIntoView({behavior:'smooth',block:'nearest'});
}


// ═══════════════════════════════════════════════════════
// ADMIN VIEW CHAT (read-only)
// ═══════════════════════════════════════════════════════
async function admViewChat(lid, uid) {
  chatLid = lid;
  const l = LISTINGS.find(x => x.id === lid);

  document.getElementById('ch-av').textContent = '👁';
  document.getElementById('ch-av').style.background = '#8e44ad';
  document.getElementById('ch-name').textContent = (l ? l.marka+' '+l.model : 'Oglas #'+lid) + ' · Admin pregled';
  document.getElementById('ov-chat').classList.add('on');

  // Sakrij input za admin pregled
  const inputArea = document.querySelector('#ov-chat .chat-input-wrap');
  if (inputArea) inputArea.style.display = 'none';

  const chatEl = document.getElementById('chat-msgs');
  if (chatEl) chatEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted);font-size:13px">Učitavam...</div>';

  try {
    const msgs = await api('GET', '/admin/chat/'+lid+'/'+uid);
    const seller = getOwner(l||{});
    if (chatEl) chatEl.innerHTML = msgs.length ? msgs.map(m => {
      const isOwner = l && String(m.sender_id) === String(l.user_id || l.uid);
      const time = new Date(m.created_at).toLocaleTimeString('bs',{hour:'2-digit',minute:'2-digit'});
      const dateStr = new Date(m.created_at).toLocaleDateString('bs');
      const txt = m.image_url
        ? `<img class="bubble-img" src="${m.image_url}" onclick="openLightbox('${m.image_url}')" style="cursor:zoom-in">`
        : (m.text||'').split('\n').join('<br>');
      return `<div class="bubble-wrap ${isOwner?'me':''}">
        ${!isOwner?`<div class="bubble-av" style="background:#8e44ad">${initials(m.sender_name||'?')}</div>`:''}
        <div class="bubble ${isOwner?'me':'them'}">
          <div style="font-size:10px;color:rgba(255,255,255,.5);margin-bottom:3px">${m.sender_name||'?'} · ${dateStr}</div>
          ${txt}<span class="bubble-time">${time}</span>
        </div>
      </div>`;
    }).join('') : '<div style="padding:16px;text-align:center;color:var(--muted)">Nema poruka</div>';
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
  } catch(e) {
    if (chatEl) chatEl.innerHTML = '<div style="padding:16px;color:var(--red)">Greška pri učitavanju</div>';
  }
  return; // Admin pregled — ne nastavljaj dalje
}


function admDeleteListing(lid) {
  showConfirm('Obrisati oglas?','Ova akcija ne može se poništiti.','🗑 Da, obriši', async ()=>{
    try {
      await api('DELETE', '/listings/'+lid);
      invalidateListingsCache();
      renderAdminOglasi();
      toast('Oglas obrisan.','');
    } catch(err) { toast('❌ ' + err.message, 'err'); }
  });
}


async function renderAnalitika() {
  const el = document.getElementById('a-analitika');
  el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px">Učitavam...</div>';
  try {
    const [users, listings, ponude] = await Promise.all([
      api('GET', '/admin/users'),
      api('GET', '/listings'),
      api('GET', '/admin/ponude').catch(() => [])
    ]);

    const sellers   = users.filter(u => u.role === 'seller');
    const buyers    = users.filter(u => u.role === 'buyer');
    const approved  = buyers.filter(u => u.status === 'approved');
    const pending   = users.filter(u => u.status === 'pending');
    const premium   = buyers.filter(u => u.premium);
    const premiumExpiringSoon = premium.filter(u => u.premium_until && (new Date(u.premium_until) - Date.now()) < 30*86400000);

    const activeLi   = listings.filter(l => l.status === 'active');
    const finishedLi = listings.filter(l => l.status === 'finished' || l.status === 'sent');
    const ba = listings.filter(l => l.country === 'BA').length;
    const rs = listings.filter(l => l.country === 'RS').length;

    const totalPonude   = ponude.length;
    const acceptedPon   = ponude.filter(p => p.status === 'accepted').length;
    const rejectedPon   = ponude.filter(p => p.status === 'rejected').length;
    const pendingPon    = ponude.filter(p => p.status === 'pending').length;
    const avgCijena     = ponude.length ? Math.round(ponude.reduce((s,p)=>s+parseFloat(p.cijena||0),0)/ponude.length) : 0;
    const maxCijena     = ponude.length ? Math.max(...ponude.map(p=>parseFloat(p.cijena||0))) : 0;

    // Registracije po danima (zadnjih 7 dana)
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const ds = d.toISOString().split('T')[0];
      const count = users.filter(u => u.created_at && u.created_at.startsWith(ds)).length;
      days.push({ label: d.toLocaleDateString('bs', {weekday:'short', day:'numeric'}), count });
    }
    const maxDay = Math.max(...days.map(d => d.count), 1);

    // Ponude po danima (zadnjih 7 dana)
    const ponDays = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const ds = d.toISOString().split('T')[0];
      const count = ponude.filter(p => p.created_at && p.created_at.startsWith(ds)).length;
      ponDays.push({ label: d.toLocaleDateString('bs', {weekday:'short', day:'numeric'}), count });
    }
    const maxPon = Math.max(...ponDays.map(d => d.count), 1);

    const statBox = (label, val, color='var(--text)', sub='') =>
      `<div style="background:var(--dark);border:1px solid var(--border);border-radius:10px;padding:12px 14px;flex:1;min-width:80px;">
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:900;font-size:24px;color:${color};line-height:1">${val}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:3px;line-height:1.3">${label}</div>
        ${sub ? `<div style="font-size:10px;color:var(--muted2);margin-top:2px">${sub}</div>` : ''}
      </div>`;

    const barChart = (data, max, color) => `
      <div style="display:flex;align-items:flex-end;gap:4px;height:60px">
        ${data.map(d => `
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px">
            <div style="font-size:9px;color:var(--muted2)">${d.count||''}</div>
            <div style="width:100%;background:${color};border-radius:2px 2px 0 0;height:${Math.max(3, Math.round(d.count/max*50))}px;opacity:${d.count?1:0.15}"></div>
            <div style="font-size:8px;color:var(--muted);text-align:center;white-space:nowrap">${d.label}</div>
          </div>`).join('')}
      </div>`;

    const section = (title, body) =>
      `<div style="background:var(--dark);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:12px">
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:14px;color:var(--muted2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">${title}</div>
        ${body}
      </div>`;

    const row = (label, val, color='var(--text)') =>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04)">
        <span style="font-size:13px;color:var(--muted2)">${label}</span>
        <b style="font-size:13px;color:${color}">${val}</b>
      </div>`;

    // BiH/RS breakdown
    const baUsers   = users.filter(u => u.country === 'BA' && u.role !== 'admin');
    const rsUsers   = users.filter(u => u.country === 'RS' && u.role !== 'admin');
    const baSellers = baUsers.filter(u => u.role === 'seller');
    const rsSellers = rsUsers.filter(u => u.role === 'seller');
    const baBuyers  = baUsers.filter(u => u.role === 'buyer');
    const rsBuyers  = rsUsers.filter(u => u.role === 'buyer');
    const baActive  = activeLi.filter(l => l.country === 'BA');
    const rsActive  = activeLi.filter(l => l.country === 'RS');

    el.innerHTML = `<div style="max-width:760px;margin:0 auto">
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">
        ${statBox('Prodavači', sellers.length, 'var(--orange)')}
        ${statBox('Otkupljivači', buyers.length, 'var(--red)')}
        ${statBox('Na čekanju', pending.length, 'var(--yellow)')}
        ${statBox('Premium', premium.length, 'var(--yellow)', premiumExpiringSoon.length ? premiumExpiringSoon.length+' ističe uskoro' : '')}
        ${statBox('Aktivni oglasi', activeLi.length, 'var(--green)')}
        ${statBox('Završene prodaje', finishedLi.length, 'var(--green)')}
        ${statBox('BiH oglasi', ba)}
        ${statBox('Srbija oglasi', rs)}
      </div>

      ${section('BiH vs Srbija', `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:8px;padding:12px">
            <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:13px;color:var(--muted2);margin-bottom:8px">Bosna i Hercegovina</div>
            ${row('Prodavači', baSellers.length)}
            ${row('Otkupljivači', baBuyers.length)}
            ${row('Aktivni oglasi', baActive.length, 'var(--green)')}
          </div>
          <div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:8px;padding:12px">
            <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:13px;color:var(--muted2);margin-bottom:8px">Srbija</div>
            ${row('Prodavači', rsSellers.length)}
            ${row('Otkupljivači', rsBuyers.length)}
            ${row('Aktivni oglasi', rsActive.length, 'var(--green)')}
          </div>
        </div>
      `)}

      ${section('Korisnici — zadnjih 7 dana', barChart(days, maxDay, 'var(--orange)'))}

      ${section('Ponude — zadnjih 7 dana', barChart(ponDays, maxPon, 'var(--green)'))}

      ${section('Ponude — statistika', `
        ${row('Ukupno ponuda', totalPonude)}
        ${row('Prihvaćene', acceptedPon, 'var(--green)')}
        ${row('Odbijene', rejectedPon, 'var(--red)')}
        ${row('Na čekanju', pendingPon, 'var(--yellow)')}
      `)}

      ${section('Korisnici — pregled', `
        ${row('Odobreni otkupljivači', approved.length+' / '+buyers.length, 'var(--green)')}
        ${row('Premium otkupljivači', premium.length, 'var(--yellow)')}
        ${premiumExpiringSoon.length ? row('Premium ističe za 30 dana', premiumExpiringSoon.length, 'var(--yellow)') : ''}
        ${row('Prodavači ukupno', sellers.length)}
        ${row('Ukupno korisnika', users.filter(u=>u.role!=='admin').length)}
      `)}</div>`;
  } catch(e) {
    console.error(e);
    el.innerHTML = '<div class="empty"><p>Greška pri učitavanju analitike.</p></div>';
  }
}

async function admToggleOglas(id) {
  const el = document.getElementById('adm-det-'+id);
  if (!el) return;
  const isOpen = el.style.display !== 'none';
  if (isOpen) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  // Fetchuj ponude ako nisu već učitane
  if (!el.dataset.loaded) {
    el.dataset.loaded = '1';
    const ponudeEl = document.getElementById('adm-ponude-'+id);
    if (ponudeEl) {
      ponudeEl.innerHTML = '<span style="color:var(--muted);font-size:11px">Učitavam ponude...</span>';
      try {
        const ponude = await api('GET', '/admin/listings/'+id+'/ponude');
        if (!ponude.length) {
          ponudeEl.innerHTML = '<span style="color:var(--muted);font-size:11px">Nema ponuda.</span>';
        } else {
          const accepted = ponude.find(p => p.status === 'accepted');
          ponudeEl.innerHTML = ponude.map(p => {
            const isAcc = p.status === 'accepted';
            const isRej = p.status === 'rejected';
            const col = isAcc ? 'var(--green)' : isRej ? 'var(--muted)' : 'var(--text)';
            const badge = isAcc ? '✅' : isRej ? '❌' : '⏳';
            return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.05);opacity:${isRej?.6:1}">
              <span style="font-size:12px">${badge}</span>
              <span style="flex:1;font-size:12px;color:var(--text)">${p.buyer_name} <span style="color:var(--muted)">(${p.buyer_city||'—'})</span></span>
              <span style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:14px;color:${col}">${p.cijena} KM</span>
              <span style="font-size:10px;color:var(--muted)">${p.dani}d</span>
            </div>`;
          }).join('');
        }
      } catch(e) {
        ponudeEl.innerHTML = '<span style="color:var(--red);font-size:11px">Greška pri učitavanju ponuda.</span>';
      }
    }
  }
}

async function renderAdminOglasi() {
  const el = document.getElementById('a-oglasi');
  try {
    const data = await cachedListings();
    LISTINGS = data.map(parseListing);
  } catch(e) { toast('Greška', 'err'); return; }

  const PG = 20;
  const pg = window._adminOglasiPage || 0;
  const all = LISTINGS;
  const paginated = all.slice(0, (pg + 1) * PG);
  const hasMore = all.length > paginated.length;

  el.innerHTML = (paginated.length ? paginated.map(l => {
    const isLot = l.listing_type === 'lot';
    const stLabel = l.status==='active'?'Aktivan':l.status==='finished'?'Završen':l.status==='sent'?'Poslato':l.status==='expired'?'Istekao':'—';
    const stColor = l.status==='active'?'ok':l.status==='finished'||l.status==='sent'?'ok':'wait';
    return `<div class="admin-oglas-card" id="ac-l-${l.id}">
      <div style="display:flex;gap:10px;align-items:center;padding:10px 12px;cursor:pointer" onclick="admToggleOglas(${l.id})">
        <div class="s-oglas-thumb" style="width:42px;height:42px;font-size:18px;flex-shrink:0">${l.thumb?`<img src="${l.thumb}">`:(isLot?'📦':'🪙')}</div>
        <div style="flex:1;min-width:0">
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:13px">
            ${isLot?`<span style="background:var(--orange);color:#fff;font-size:9px;font-weight:700;padding:1px 4px;border-radius:3px;margin-right:4px">LOT</span>`:''}${l.marka} ${l.model}${l.god?' ('+l.god+')':''}
          </div>
          <div style="font-size:11px;color:var(--muted)">📍 ${l.owner_city||'—'} · ${l.ponuda_count||0} ponuda · <span class="badge b-${stColor}" style="font-size:10px">${stLabel}</span></div>
        </div>
        <span style="color:var(--muted);font-size:12px;flex-shrink:0">▼</span>
      </div>
      <div id="adm-det-${l.id}" style="display:none;border-top:1px solid var(--border);padding:12px;background:rgba(0,0,0,.2)">
        ${(()=>{ const imgs = l.images && l.images.length ? l.images : (l.thumb?[l.thumb]:[]); return imgs.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${imgs.map(u=>`<img src="${u}" style="width:64px;height:64px;object-fit:cover;border-radius:6px;cursor:zoom-in" onclick="event.stopPropagation();openLightbox('${u}',[${imgs.map(x=>`'${x}'`).join(',')}])">`).join('')}</div>` : ''; })()}
        <div style="font-size:12px;line-height:2">
          ${l.broj?`<b>OEM br.:</b> ${l.broj}<br>`:''}
          ${!isLot?`<b>Stanje:</b> ${l.stanje||'—'}<br>`:''}
          <b>Objavio:</b> ${l.owner_name||'—'} (${l.owner_city||'—'}) · ${l.owner_tel||'—'}<br>
          ${l.accepted_buyer_name ? `<b style="color:var(--green)">Kupac:</b> ${l.accepted_buyer_name} (${l.accepted_buyer_city||'—'})<br>` : ''}
          ${l.sold_at ? `<b>Prodano:</b> ${new Date(l.sold_at).toLocaleDateString('bs')}<br>` : ''}
          ${l.nap?`<b>Napomena:</b> ${l.nap}<br>`:''}
          <b>Datum:</b> ${new Date(l.created_at||Date.now()).toLocaleDateString('bs')}
        </div>
        ${parseInt(l.ponuda_count) > 0 ? `
          <div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.07)">
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Ponude</div>
            <div id="adm-ponude-${l.id}"></div>
          </div>` : ''}
        <div style="margin-top:10px">
          <button class="btn btn-or btn-xs" onclick="event.stopPropagation();admDeleteListing(${l.id})">🗑 Briši oglas</button>
        </div>
      </div>
    </div>`;
  }).join('') : `<div class="empty"><div class="empty-icon">📋</div><h3>Nema oglasa</h3></div>`) +
  (hasMore ? `<div style="text-align:center;margin:16px 0"><button class="btn btn-ghost" onclick="window._adminOglasiPage=(window._adminOglasiPage||0)+1;renderAdminOglasi()">Učitaj još (${all.length - paginated.length})</button></div>` : '');
}


// ═══════════════════════════════════════════════════════
// NOVI OGLAS (FAB)
// ═══════════════════════════════════════════════════════
let _listingType = 'single';
let _lotRowCount = 0;

function setListingType(type) {
  _listingType = type;
  document.getElementById('form-single').style.display = type === 'single' ? '' : 'none';
  document.getElementById('form-lot').style.display = type === 'lot' ? '' : 'none';
  document.getElementById('tog-single').className = 'btn btn-sm ' + (type === 'single' ? 'btn-primary' : 'btn-ghost');
  document.getElementById('tog-lot').className = 'btn btn-sm ' + (type === 'lot' ? 'btn-primary' : 'btn-ghost');
  document.getElementById('tog-single').style.flex = '1';
  document.getElementById('tog-lot').style.flex = '1';
  if (type === 'lot' && _lotRowCount === 0) {
    addLotRow(); addLotRow(); addLotRow(); // Start sa 3 reda
  }
}

function addLotRow() {
  const container = document.getElementById('lot-rows');
  if (!container) return;
  const count = container.querySelectorAll('.lot-row').length;
  if (count >= 50) { toast('Maksimalno 50 komada', 'err'); return; }
  _lotRowCount++;
  const id = _lotRowCount;
  const row = document.createElement('div');
  row.className = 'lot-row';
  row.id = 'lot-row-' + id;
  row.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:6px';
  row.innerHTML = `
    <div style="width:22px;height:22px;border-radius:50%;background:var(--border2);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--muted);flex-shrink:0">${count+1}</div>
    <input placeholder="OEM broj (opcija)" style="flex:1;background:var(--dark);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:7px 10px;font-family:Barlow,sans-serif;font-size:13px" class="lot-broj">
    <select style="background:var(--dark);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:7px 8px;font-family:Barlow,sans-serif;font-size:12px;flex-shrink:0" class="lot-stanje">
      <option value="Originalni — neoštećen" selected>Originalni</option>
      <option value="Malo oštećen">Malo oštećen</option>
      <option value="Zapušen / pokvaren">Zapušen</option>
      <option value="Nepoznato">Nepoznato</option>
    </select>
    <button onclick="removeLotRow('lot-row-${id}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;flex-shrink:0;padding:2px 4px">×</button>`;
  container.appendChild(row);
  updateLotCount();
}

function removeLotRow(rowId) {
  const row = document.getElementById(rowId);
  if (row) row.remove();
  // Renumber
  document.querySelectorAll('.lot-row').forEach((r, i) => {
    const num = r.querySelector('div');
    if (num) num.textContent = i + 1;
  });
  updateLotCount();
}

function updateLotCount() {
  const count = document.querySelectorAll('.lot-row').length;
  const info = document.getElementById('lot-count-info');
  if (info) info.textContent = count > 0 ? `${count} katalizatora u lotu` + (count >= 40 ? ` — max 50` : '') : '';
}

function getLotItems() {
  const items = [];
  document.querySelectorAll('.lot-row').forEach(row => {
    const broj = row.querySelector('.lot-broj')?.value.trim() || '';
    const stanje = row.querySelector('.lot-stanje')?.value || 'Nepoznato';
    items.push({ broj, stanje });
  });
  return items;
}

function openNoviOglas() {
  uploads = [];
  _listingType = 'single';
  _lotRowCount = 0;
  const pg = document.getElementById('prev-grid');
  if (pg) pg.innerHTML = '';
  ['f-broj','f-marka','f-model','f-god','f-nap'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const fs = document.getElementById('f-stanje');
  if (fs) fs.selectedIndex = 0;
  // Reset lot
  const lotRows = document.getElementById('lot-rows');
  if (lotRows) lotRows.innerHTML = '';
  document.getElementById('form-single').style.display = '';
  document.getElementById('form-lot').style.display = 'none';
  document.getElementById('tog-single').className = 'btn btn-primary btn-sm';
  document.getElementById('tog-lot').className = 'btn btn-ghost btn-sm';
  document.getElementById('tog-single').style.flex = '1';
  document.getElementById('tog-lot').style.flex = '1';
  document.getElementById('ov-novi').classList.add('on');
}

// ═══════════════════════════════════════════════════════
// PORUKE (seller inbox)
// ═══════════════════════════════════════════════════════
async function renderPoruke() {
  const el = document.getElementById('s-poruke');
  el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px">Učitavam...</div>';
  // Osiguraj da su LISTINGS učitani
  if (!LISTINGS.length) {
    try {
      const data = await cachedListings();
      LISTINGS = data.map(parseListing);
    } catch(e) {}
  }
  try {
    const inbox = await api('GET', '/chat/inbox');
    await Promise.all(inbox.map(async c => {
      try {
        const msgs = await api('GET', '/chat/'+c.listing_id+'?buyer_id='+c.buyer_id);
        const l = LISTINGS.find(x => x.id === parseInt(c.listing_id));
        const sellerUid = l ? (l.uid || l.user_id) : CU.id;
        if (!chatHistory[c.listing_id]) chatHistory[c.listing_id] = [];
        chatHistory[c.listing_id] = msgs.map(m => ({
          senderId: m.sender_id,
          senderName: m.sender_name,
          from: String(m.sender_id) === String(sellerUid) ? 'seller' : 'buyer',
          msg: m.text || '',
          imgUrl: m.image_url || null,
          time: new Date(m.created_at).toLocaleTimeString('bs',{hour:'2-digit',minute:'2-digit'})
        }));
        chatHistory[c.listing_id]._buyerId = c.buyer_id;
        if (parseInt(c.unread_count) > 0) unreadLids.add(CU.id + ':' + c.listing_id);
        else unreadLids.delete(CU.id + ':' + c.listing_id);
      } catch(e) {}
    }));
  } catch(e) {}
  // Skupi sve konverzacije gdje ima poruka za prodavačeve oglase
  const myListingIds = LISTINGS.filter(l => l.uid === CU.id).map(l => l.id);
  const convos = [];
  myListingIds.forEach(lid => {
    const msgs = chatHistory[lid] || [];
    if (!msgs.length) return;
    const l = LISTINGS.find(x => x.id === lid);
    // Grupiraj po buyerId
    const buyers = {};
    msgs.forEach(m => {
      if (m.from === 'buyer') {
        if (!buyers[m.buyerId || 'buyer']) buyers[m.buyerId || 'buyer'] = [];
        buyers[m.buyerId || 'buyer'].push(m);
      }
    });
    // Jedna konverzacija po oglasu (sve poruke zajedno)
    convos.push({ lid, listing: l, msgs, lastMsg: msgs[msgs.length-1] });
  });

  // Ažuriraj badge — samo nepročitane
  const badge = document.getElementById('poruke-badge');
  const unreadCount = convos.filter(c => hasUnread(c.lid)).length;
  badge.style.display = unreadCount ? 'inline' : 'none';
  badge.textContent = unreadCount;

  if (!convos.length) {
    el.innerHTML = `<div class="empty">
      <div class="empty-icon">💬</div>
      <h3>Nema poruka</h3>
      <p>Kada otkupljivač pošalje poruku o vašem oglasu, pojavit će se ovdje.</p>
    </div>`;
    return;
  }

  el.innerHTML = convos.map(c => {
    const last = c.lastMsg;
    const buyerName = last.senderName || 'Otkupljivač';
    const buyerCol  = avCol(last.senderId || 'x');
    const buyerInit = initials(buyerName);
    const preview = last.msg.length > 50 ? last.msg.slice(0,50)+'...' : last.msg;
    const unread = hasUnread(c.lid);
    return `<div class="inbox-item ${unread?'unread':''}" id="ii-${c.lid}" onclick="openSellerChat(${c.lid})">
      <div class="inbox-av" style="background:${buyerCol}">${buyerInit}</div>
      <div style="flex:1;min-width:0">
        <div class="inbox-name">${buyerName}</div>
        <div class="inbox-preview">${c.listing.marka} ${c.listing.model} · "${preview}"</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
        <div class="inbox-time">${last.time}</div>
        ${unread?'<div class="inbox-unread-dot"></div>':''}
      </div>
    </div>`;
  }).join('');
  // Long press za brisanje
  convos.forEach(c => {
    const el2 = document.getElementById('ii-'+c.lid);
    if (el2) addLongPress(el2, c.lid);
  });
}

async function openSellerChat(lid) {
  chatLid = lid;
  const l = LISTINGS.find(x => x.id === lid);
  document.getElementById('ov-chat').classList.add('on');
  const ta = document.getElementById('chat-ta');
  ta.value = ''; ta.style.height = 'auto';
  updateSendBtn();
  // Fetchaj poruke iz API
  const hist = chatHistory[lid] || [];
  const buyerIdFromHist = hist._buyerId || (hist.find(m => m.from === 'buyer') || {}).senderId;
  // Ako imamo buyer_id iz historije, fetchaj
  if (buyerIdFromHist) {
    await loadChatMsgsWithBuyer(lid, buyerIdFromHist);
  } else {
    // Učitaj inbox da nađemo buyer_id
    try {
      const inbox = await api('GET', '/chat/inbox');
      const conv = inbox.find(c => parseInt(c.listing_id) === lid);
      if (conv) await loadChatMsgsWithBuyer(lid, conv.buyer_id);
    } catch(e) {}
  }
  const msgs2 = chatHistory[lid] || [];
  const bMsg = msgs2.find(m => m.from === 'buyer');
  const buyerName = bMsg ? bMsg.senderName : 'Otkupljivač';
  const buyerId   = (chatHistory[lid]||{})._buyerId || (bMsg||{}).senderId || 'x';
  document.getElementById('ch-av').textContent = initials(buyerName);
  document.getElementById('ch-av').style.background = avCol(String(buyerId));
  document.getElementById('ch-name').textContent = buyerName + ' · ' + (l ? l.marka + ' ' + l.model : '');
  api('PUT', '/chat/'+lid+'/read').catch(()=>{});
  markRead(lid);
  updatePorukeBadges();
  setTimeout(() => ta.focus(), 150);
}

async function loadChatMsgsWithBuyer(lid, buyerId) {
  try {
    const msgs = await api('GET', '/chat/'+lid+'?buyer_id='+buyerId);
    const l = LISTINGS.find(x => x.id === lid);
    const sellerUid = l ? (l.uid || l.user_id) : CU.id;
    chatHistory[lid] = msgs.map(m => ({
      senderId: m.sender_id,
      senderName: m.sender_name,
      from: String(m.sender_id) === String(sellerUid) ? 'seller' : 'buyer',
      msg: m.text || '',
      imgUrl: m.image_url || null,
      time: new Date(m.created_at).toLocaleTimeString('bs',{hour:'2-digit',minute:'2-digit'})
    }));
    chatHistory[lid]._buyerId = buyerId;
  } catch(e) {
    if (!chatHistory[lid]) chatHistory[lid] = [];
  }
  renderChatMsgs();
}

function renderSellerChatMsgs(lid, buyerName, buyerId) {
  // Koristimo isti renderChatMsgs koji je svjestan CU.id
  renderChatMsgs();
}


// ═══════════════════════════════════════════════════════
// PORUKE (buyer inbox) — konverzacije koje je otkupljivač pokrenuo
// ═══════════════════════════════════════════════════════
async function renderBuyerPoruke() {
  const el = document.getElementById('b-poruke');
  el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px">Učitavam...</div>';
  // Osiguraj da su LISTINGS učitani
  if (!LISTINGS.length) {
    try {
      const data = await cachedListings();
      LISTINGS = data.map(parseListing);
    } catch(e) {}
  }
  // Učitaj inbox iz API-ja
  try {
    const inbox = await api('GET', '/chat/inbox');
    // Učitaj poruke za svaki chat i popuni chatHistory
    await Promise.all(inbox.map(async c => {
      try {
        const msgs = await api('GET', '/chat/'+c.listing_id);
        const sellerUid = c.seller_id;
        chatHistory[c.listing_id] = msgs.map(m => ({
          senderId: m.sender_id,
          senderName: m.sender_name,
          from: String(m.sender_id) === String(sellerUid) ? 'seller' : 'buyer',
          msg: m.text || '',
          imgUrl: m.image_url || null,
          time: new Date(m.created_at).toLocaleTimeString('bs',{hour:'2-digit',minute:'2-digit'})
        }));
        // Označi unread
        if (parseInt(c.unread_count) > 0) unreadLids.add(CU.id + ':' + c.listing_id);
        else unreadLids.delete(CU.id + ':' + c.listing_id);
      } catch(e) {}
    }));
  } catch(e) {}

  // Nađi sve oglase gdje je otkupljivač pisao
  const convos = [];
  LISTINGS.forEach(l => {
    const msgs = chatHistory[l.id] || [];
    const myMsgs = msgs.filter(m => m.senderId === CU.id);
    if (!myMsgs.length) return;
    convos.push({ lid: l.id, listing: l, msgs, lastMsg: msgs[msgs.length-1] });
  });

  // Badge — samo nepročitane
  const badge = document.getElementById('b-poruke-badge');
  const bUnreadCount = convos.filter(c => hasUnread(c.id || c.lid)).length;
  if (badge) { badge.style.display = bUnreadCount ? 'inline' : 'none'; badge.textContent = bUnreadCount; }

  if (!convos.length) {
    el.innerHTML = `<div class="empty">
      <div class="empty-icon">💬</div>
      <h3>Nema poruka</h3>
      <p>Pošaljite poruku prodavaču klikom na 💬 Poruka uz oglas.</p>
    </div>`;
    return;
  }

  el.innerHTML = convos.map(c => {
    const last = c.lastMsg;
    const seller = getOwner(c.listing);
    const preview = last.msg.length > 50 ? last.msg.slice(0,50)+'...' : last.msg;
    const isMyLast = last.senderId === CU.id;
    const unread = hasUnread(c.lid);
    return `<div class="inbox-item ${unread?'unread':''}" id="bi-${c.lid}" onclick="openChat(${c.lid},'${c.listing.marka} ${c.listing.model}')">
      <div class="inbox-av" style="background:${avCol(seller.id||'x')}">${initials(seller.name)}</div>
      <div style="flex:1;min-width:0">
        <div class="inbox-name">${seller.name}</div>
        <div class="inbox-preview">${c.listing.marka} ${c.listing.model} · ${isMyLast?'Ti: ':''}${preview}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
        <div class="inbox-time">${last.time}</div>
        ${unread?'<div class="inbox-unread-dot"></div>':''}
      </div>
    </div>`;
  }).join('');
  convos.forEach(c => {
    const el2 = document.getElementById('bi-'+c.lid);
    if (el2) addLongPress(el2, c.lid);
  });
}


// ═══════════════════════════════════════════════════════
// CONTEXT MENU (long press / right click na inbox item)
// ═══════════════════════════════════════════════════════
let _ctxLid = null;
let _longPressT = null;

function showCtxMenu(e, lid) {
  e.preventDefault();
  _ctxLid = lid;
  const menu = document.getElementById('ctx-menu');
  menu.classList.add('on');
  // Pozicioniraj uz klik/touch
  const x = e.clientX || (e.touches && e.touches[0].clientX) || 0;
  const y = e.clientY || (e.touches && e.touches[0].clientY) || 0;
  const mw = 170, mh = 50;
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
  menu.style.top  = Math.min(y, window.innerHeight - mh - 8) + 'px';
}

function hideCtxMenu() {
  document.getElementById('ctx-menu').classList.remove('on');
  _ctxLid = null;
}

async function deleteConvo() {
  if (_ctxLid === null) return;
  const lid = _ctxLid; // sačuvaj prije hideCtxMenu koji resetuje _ctxLid
  hideCtxMenu();
  try {
    await api('DELETE', '/chat/'+lid);
    delete chatHistory[lid];
    Object.keys(readAt).forEach(k => { if (k.endsWith(':'+lid)) delete readAt[k]; });
    unreadLids.delete(CU.id+':'+lid);
    updatePorukeBadges();
    if (CU.role === 'seller') renderPoruke();
    else renderBuyerPoruke();
    toast('Razgovor izbrisan', '');
  } catch(err) {
    toast('❌ ' + err.message, 'err');
  }
}

// Zatvori na klik izvan
document.addEventListener('click', e => {
  if (!e.target.closest('#ctx-menu')) hideCtxMenu();
});

function addLongPress(el, lid) {
  // Touch long press (500ms)
  el.addEventListener('touchstart', e => {
    _longPressT = setTimeout(() => showCtxMenu(e, lid), 500);
  }, {passive: true});
  el.addEventListener('touchend', () => clearTimeout(_longPressT));
  el.addEventListener('touchmove', () => clearTimeout(_longPressT));
  // Right click na desktopu
  el.addEventListener('contextmenu', e => showCtxMenu(e, lid));
}





// ═══════════════════════════════════════════════════════
// TEMA (dark/light)
// ═══════════════════════════════════════════════════════
let currentTheme = localStorage.getItem('theme') || 'dark';

function applyTheme(t) {
  currentTheme = t;
  document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : '');
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = t === 'light' ? '🌙' : '☀️';
  localStorage.setItem('theme', t);
}

function toggleTheme() {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

// Primijeni sačuvanu temu odmah
applyTheme(currentTheme);


// ═══════════════════════════════════════════════════════
// GRADOVI (autocomplete)
// ═══════════════════════════════════════════════════════
const CITIES = {
  ba: ['Sarajevo','Banja Luka','Tuzla','Zenica','Mostar','Bijeljina','Brčko','Bihać','Prijedor','Doboj',
       'Cazin','Trebinje','Lukavac','Visoko','Gradačac','Živinice','Travnik','Bosanska Krupa','Konjic',
       'Sanski Most','Goražde','Široki Brijeg','Bugojno','Bosanski Brod','Zavidovići','Novi Grad',
       'Zvornik','Gračanica','Orašje','Vogošća','Ilidža','Hadžići','Ilijaš','Visoko','Foča',
       'Nevesinje','Gacko','Ljubuški','Čapljina','Stolac','Neum','Prozor-Rama','Glamoč','Livno',
       'Tomislavgrad','Kupres','Donji Vakuf','Gornji Vakuf','Vitez','Kiseljak','Kakanj','Vareš',
       'Olovo','Kladanj','Breza','Srebrenik','Kalesija','Sapna','Tešanj','Žepče','Maglaj','Zavidovići',
       'Modriča','Derventa','Šamac','Odžak','Srbac','Laktaši','Gradiška','Kozarska Dubica','Kostajnica',
       'Mrkonjić Grad','Jajce','Ključ','Bosansko Grahovo','Drvar','Pale','Sokolac','Han Pijesak',
       'Rogatica','Višegrad','Srebrenica','Vlasenica','Milići','Bratunac','Skelani','Ugljevik',
       'Lopare','Osmaci','Teočak','Čelić','Donji Žabar','Pelagićevo','Vukosavlje','Berkovići'],
  rs: ['Beograd','Novi Sad','Niš','Kragujevac','Subotica','Zrenjanin','Pančevo','Čačak','Novi Pazar',
       'Kraljevo','Smederevo','Leskovac','Vranje','Šabac','Valjevo','Kruševac','Požarevac','Zaječar',
       'Kikinda','Sombor','Sremska Mitrovica','Jagodina','Pirot','Dimitrovgrad','Prokuplje','Bor',
       'Negotin','Kladovo','Majdanpek','Knjaževac','Sokobanja','Boljevac','Aleksinac','Ražanj',
       'Paraćin','Ćuprija','Despotovac','Svilajnac','Aranđelovac','Mladenovac','Lazarevac','Obrenovac',
       'Loznica','Krupanj','Mali Zvornik','Vladimirci','Ub','Mionica','Kolubara','Ljig','Gornji Milanovac',
       'Ivanjica','Arilje','Požega','Užice','Bajina Bašta','Kosjerić','Priboj','Prijepolje','Nova Varoš',
       'Tutin','Raška','Vrnjačka Banja','Trstenik','Aleksandrovac','Brus','Blace','Žitorađa','Kuršumlija',
       'Lebane','Vlasotince','Crna Trava','Surdulica','Bosilegrad','Trgovište','Bujanovac','Preševo',
       'Medveđa','Nišavski','Inđija','Ruma','Stara Pazova','Beočin','Bačka Palanka','Bačka Topola']
};

let acActive = null; // ID aktivnog autocomplete inputa
let acFocusIdx = -1;

function initAC(inputId, countrySelectId) {
  const inp = document.getElementById(inputId);
  if (!inp) return;

  inp.addEventListener('input', () => showAC(inputId, countrySelectId));
  inp.addEventListener('keydown', e => {
    const list = document.getElementById('ac-'+inputId);
    if (!list || !list.classList.contains('on')) return;
    const items = list.querySelectorAll('.ac-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); acFocusIdx = Math.min(acFocusIdx+1, items.length-1); highlightAC(items); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); acFocusIdx = Math.max(acFocusIdx-1, 0); highlightAC(items); }
    else if (e.key === 'Enter' && acFocusIdx >= 0) { e.preventDefault(); items[acFocusIdx].click(); }
    else if (e.key === 'Escape') hideAC(inputId);
  });
  inp.addEventListener('blur', () => setTimeout(() => hideAC(inputId), 150));
}

function highlightAC(items) {
  items.forEach((it, i) => it.classList.toggle('focused', i === acFocusIdx));
  if (items[acFocusIdx]) items[acFocusIdx].scrollIntoView({block:'nearest'});
}

function showAC(inputId, countrySelectId) {
  const inp = document.getElementById(inputId);
  const val = inp.value.trim().toLowerCase();
  const list = document.getElementById('ac-'+inputId);
  if (!list) return;

  if (val.length < 1) { list.classList.remove('on'); return; }

  // Odredi koja država je odabrana
  const cEl = document.getElementById(countrySelectId);
  const country = cEl ? cEl.value : 'ba';
  const cities = CITIES[country] || CITIES.ba;

  const matches = cities.filter(c => c.toLowerCase().includes(val)).slice(0, 8);
  if (!matches.length) { list.classList.remove('on'); return; }

  acFocusIdx = -1;
  list.innerHTML = matches.map(city => {
    const idx = city.toLowerCase().indexOf(val);
    const before = city.slice(0, idx);
    const match  = city.slice(idx, idx + val.length);
    const after  = city.slice(idx + val.length);
    return `<div class="ac-item" onclick="selectCity('${inputId}','${city}')">${before}<span class="ac-match">${match}</span>${after}</div>`;
  }).join('');
  list.classList.add('on');
}

function selectCity(inputId, city) {
  const inp = document.getElementById(inputId);
  if (inp) inp.value = city;
  hideAC(inputId);
}

function hideAC(inputId) {
  const list = document.getElementById('ac-'+inputId);
  if (list) list.classList.remove('on');
}

// Kad se promijeni država, sakrij prijedloge
function onCountryChange(countrySelectId, inputId) {
  hideAC(inputId);
  document.getElementById(inputId).value = '';
}


// Tastatura: ponuda sheet koristi env(safe-area) + CSS za pomicanje
// Nema JS listenera koji bi interferirao s dugmadima

// ═══════════════════════════════════════════════════════
// CENTRALNI BACK BUTTON SISTEM
// ═══════════════════════════════════════════════════════
// Stack funkcija za zatvaranje (LIFO). Svaki modal/overlay registrira svoju close funkciju.
const _backStack = [];

function _pushBack(closeFn) {
  _backStack.push(closeFn);
  history.pushState({ backStack: _backStack.length }, '');
}

function _popBack() {
  const fn = _backStack.pop();
  if (fn) fn();
}

window.addEventListener('popstate', e => {
  if (_backStack.length > 0) {
    _popBack();
    history.pushState({ backStack: _backStack.length }, '');
    return;
  }
  // Fallback — zatvori bilo koji otvoreni .ov overlay
  const overlays = [...document.querySelectorAll('.ov.on')];
  if (overlays.length) {
    overlays.forEach(o => o.classList.remove('on'));
    history.pushState({ backStack: 0 }, '');
    return;
  }
  // Nema otvorenih modalova — ostani u app
  if (CU) {
    history.pushState({ backStack: 0 }, '');
  }
});

// Kompatibilni aliasi za navigacijske funkcije
function pushNav(state) {
  history.pushState(state, '');
}

function restoreNav(state) {
  if (!state) return;
  if (state.page) {
    document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
    const pg = document.getElementById(state.page);
    if (pg) pg.style.display = '';
  }
  if (state.stab) sTabSilent(state.stab);
  if (state.btab) bTabSilent(state.btab);
  if (state.atab) aTabSilent(state.atab);
}

// Init state pri učitavanju
history.replaceState({ backStack: 0 }, '');

function restoreNav(state) {
  if (!state) return;
  if (state.page) {
    document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
    const el = document.getElementById(state.page);
    if (el) el.style.display = 'block';
  }
  if (state.stab) sTabSilent(state.stab);
  if (state.btab) bTabSilent(state.btab);
  if (state.atab) aTabSilent(state.atab);
}

// Tihe verzije tab funkcija (bez pushNav da ne duplikuju)
function sTabSilent(n) {
  ['oglasi','poruke','zavrseni'].forEach(x => {
    const t=document.getElementById('st-'+x); if(t) t.classList.toggle('on',x===n);
    const p=document.getElementById('sp-'+x); if(p) p.classList.toggle('on',x===n);
  });
  if (n==='oglasi')   { renderMyListings(); markOglasiSeen(); }
  if (n==='poruke')   { markAllPorukeRead('seller'); renderPoruke().then(updatePorukeBadges); }
  if (n==='zavrseni') renderZavrseni();
}
function bTabSilent(n) {
  ['oglasi','moje','zavrseni','poruke'].forEach(x => {
    const t=document.getElementById('bt-'+x); if(t) t.classList.toggle('on',x===n);
    const p=document.getElementById('bp-'+x); if(p) p.classList.toggle('on',x===n);
  });
  if (n==='oglasi') renderBuyerListings();
  if (n==='moje')   renderMyPonude();
  if (n==='zavrseni') renderBuyerZavrseni();
  if (n==='poruke') { markAllPorukeRead('buyer'); renderBuyerPoruke().then(updatePorukeBadges); }
}
function aTabSilent(n) {
  ['users','oglasi','analitika'].forEach(x => {
    const t=document.getElementById('at-'+x); if(t) t.classList.toggle('on',x===n);
    const p=document.getElementById('ap-'+x); if(p) p.classList.toggle('on',x===n);
  });
  if (n==='users')  renderAdminUsers();
  if (n==='oglasi') renderAdminOglasi();
  if (n==='analitika') renderAnalitika();
}

// ═══════════════════════════════════════════════════════
// SORTIRANJE
// ═══════════════════════════════════════════════════════
let currentSort = 'novo';

function setSort(s) {
  currentSort = s;
  renderBuyerListings();
}

function sortListings(listings) {
  const copy = [...listings];
  if (currentSort === 'novo') {
    return copy.sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
  } else if (currentSort === 'ponude') {
    return copy.sort((a,b) => (parseInt(b.ponuda_count)||0) - (parseInt(a.ponuda_count)||0));
  } else if (currentSort === 'istice') {
    return copy.sort((a,b) => {
      const remA = 7 - Math.floor((Date.now()-(a.createdAt||0))/86400000);
      const remB = 7 - Math.floor((Date.now()-(b.createdAt||0))/86400000);
      return remA - remB;
    });
  }
  return copy;
}

// ═══════════════════════════════════════════════════════
// BADGE: nove ponude na oglasima
// ═══════════════════════════════════════════════════════
let lastSeenPonude = {}; // lid -> broj ponuda kad je zadnji put gledao

function updateOglasiBadge() {
  if (!CU || CU.role !== 'seller') return;
  const mine = LISTINGS.filter(l => l.uid === CU.id);
  let newCount = 0;
  mine.forEach(l => {
    const seen = lastSeenPonude[l.id] || 0;
    const newP = l.ponude.filter(p => p.status === 'pending').length;
    if (newP > seen) newCount += (newP - seen);
  });
  const b = document.getElementById('oglasi-badge');
  if (b) { b.style.display = newCount ? 'inline' : 'none'; b.textContent = newCount; }
}

function markOglasiSeen() {
  if (!CU) return;
  LISTINGS.filter(l => l.uid === CU.id).forEach(l => {
    lastSeenPonude[l.id] = l.ponude.filter(p => p.status === 'pending').length;
  });
  const b = document.getElementById('oglasi-badge');
  if (b) b.style.display = 'none';
}

// ═══════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════
let _toastT=null;
function toast(msg,type='') {
  const el=document.getElementById('toast');
  el.textContent=msg; el.className='toast on'+(type?' '+type:'');
  clearTimeout(_toastT); _toastT=setTimeout(()=>el.classList.remove('on'),3000);
}

function openLotDetail(lid) {
  const l = LISTINGS.find(x => x.id === lid);
  if (!l) return;
  const items = Array.isArray(l.lot_items) ? l.lot_items : (l.lot_items ? JSON.parse(l.lot_items) : []);
  const existing = document.getElementById('ov-lot-detail');
  if (existing) existing.remove();
  const ov = document.createElement('div');
  ov.id = 'ov-lot-detail';
  ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:10001;background:rgba(0,0,0,.82);backdrop-filter:blur(4px);display:flex;align-items:flex-start;justify-content:center;padding-top:64px;overflow-y:auto';
  const rows = items.map((it, i) => {
    const stBadge = it.stanje === 'Originalni — neoštećen'
      ? `<span style="color:#1db954;font-size:11px">✅ Originalni</span>`
      : it.stanje === 'Malo oštećen'
        ? `<span style="color:var(--yellow);font-size:11px">⚠️ Malo oštećen</span>`
        : it.stanje === 'Zapušen / pokvaren'
          ? `<span style="color:var(--red);font-size:11px">❌ Zapušen</span>`
          : `<span style="color:var(--muted);font-size:11px">— Nepoznato</span>`;
    return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.08)">
      <span style="width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;font-size:11px;color:#aaa;flex-shrink:0">${i+1}</span>
      <span style="flex:1;font-size:14px;color:${it.broj?'#fff':'#666'};font-family:'Barlow Condensed',sans-serif;font-weight:${it.broj?700:400};letter-spacing:.3px">${it.broj || '— bez OEM broja'}</span>
      ${stBadge}
    </div>`;
  }).join('');
  ov.innerHTML = `
    <div style="background:#1a1a1a;border:1px solid #333;border-radius:14px;padding:22px 20px;width:calc(100% - 32px);max-width:420px" onclick="event.stopPropagation()">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div>
          <span style="background:var(--orange);color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;margin-right:8px">LOT</span>
          <span style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:18px;color:#fff">📦 ${items.length} katalizatora</span>
        </div>
        <button onclick="document.getElementById('ov-lot-detail').remove()" style="background:none;border:none;color:#888;font-size:22px;cursor:pointer;line-height:1">✕</button>
      </div>
      ${l.nap ? `<div style="font-size:12px;color:var(--muted2);background:rgba(255,255,255,.04);border-radius:6px;padding:8px 10px;margin-bottom:12px">📝 ${l.nap}</div>` : ''}
      <div style="max-height:55vh;overflow-y:auto">${rows}</div>
      <div style="margin-top:14px;display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" style="flex:1" onclick="document.getElementById('ov-lot-detail').remove()">Zatvori</button>
        <button class="btn btn-green btn-sm" style="flex:1" onclick="document.getElementById('ov-lot-detail').remove();openPonudaOv(${lid},'Lot ${items.length} kom')">📤 Pošalji ponudu</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if(e.target===ov) { ov.remove(); } });
  _pushBack(() => ov.remove());
}
// ═══════════════════════════════════════════════════════
async function checkBroadcasts() {
  try {
    const broadcasts = await api('GET', '/broadcasts/unread');
    if (!broadcasts.length) return;
    // Prikaži jedan po jedan s odgodom
    broadcasts.reverse().forEach((b, i) => {
      setTimeout(() => showBroadcast(b), i * 400);
    });
  } catch(e) {}
}

function showBroadcast(b) {
  const existing = document.getElementById('broadcast-banner');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'broadcast-banner';
  el.style.cssText = `
    position:fixed;top:0;left:0;right:0;z-index:9999;
    background:linear-gradient(135deg,#1a0e00,#0a1200);
    border-bottom:2px solid var(--orange);
    padding:12px 16px;
    display:flex;align-items:center;gap:12px;
    animation:slideDown .3s ease;
    box-shadow:0 4px 20px rgba(0,0,0,.4);
  `;
  el.innerHTML = `
    <span style="font-size:18px;flex-shrink:0">📢</span>
    <div style="flex:1;min-width:0">
      <div style="font-size:11px;color:var(--orange);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Obavještenje</div>
      <div style="font-size:13px;color:#f5a623;line-height:1.4;font-weight:500">${b.message}</div>
    </div>
    <button onclick="dismissBroadcast(${b.id})" style="background:none;border:none;color:var(--orange);font-size:20px;cursor:pointer;flex-shrink:0;padding:4px;opacity:.8">✕</button>
  `;
  document.body.prepend(el);
  // Auto-dismiss nakon 10s
  setTimeout(() => dismissBroadcast(b.id), 10000);
}

async function dismissBroadcast(id) {
  const el = document.getElementById('broadcast-banner');
  if (el) { el.style.opacity='0'; el.style.transform='translateY(-100%)'; el.style.transition='all .3s'; setTimeout(()=>el.remove(), 300); }
  try { await api('POST', '/broadcasts/'+id+'/read'); } catch(e) {}
}

// ═══════════════════════════════════════════════════════
// REJTING SISTEM
// ═══════════════════════════════════════════════════════
function starsHtml(avg, total, size='14px') {
  if (!avg) return `<span style="font-size:11px;color:var(--muted)">Bez ocjene</span>`;
  const full = Math.floor(avg);
  const half = (avg - full) >= 0.5;
  let stars = '';
  for(let i=1;i<=5;i++) {
    if(i<=full) stars += `<span style="color:#f4c430;font-size:${size}">★</span>`;
    else if(i===full+1&&half) stars += `<span style="color:#f4c430;font-size:${size};opacity:.6">★</span>`;
    else stars += `<span style="color:rgba(255,255,255,.15);font-size:${size}">★</span>`;
  }
  return `<span style="display:inline-flex;align-items:center;gap:2px">${stars} <span style="font-size:11px;color:var(--muted);margin-left:3px">${avg} (${total})</span></span>`;
}

function openRatingModal(toUserId, listingId, listingName) {
  const existing = document.getElementById('ov-rating');
  if (existing) existing.remove();
  const ov = document.createElement('div');
  ov.id = 'ov-rating';
  ov.className = 'ov ov-center on';
  ov.style.cssText = 'z-index:10000';
  ov.innerHTML = `
    <div style="background:#1a1a1a;border:1px solid #333;border-radius:14px;padding:26px 22px;width:100%;max-width:340px;text-align:center;animation:slideUp .22s ease" onclick="event.stopPropagation()">
      <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:18px;margin-bottom:4px;color:#fff">⭐ Ostavi ocjenu</div>
      <div style="font-size:12px;color:#aaa;margin-bottom:18px">${listingName}</div>
      <div id="rating-stars" style="display:flex;justify-content:center;gap:4px;margin-bottom:12px">
        <span data-s="1" onclick="_pickStar(1)" style="font-size:44px;cursor:pointer;color:#555;transition:color .1s;user-select:none;line-height:1">★</span>
        <span data-s="2" onclick="_pickStar(2)" style="font-size:44px;cursor:pointer;color:#555;transition:color .1s;user-select:none;line-height:1">★</span>
        <span data-s="3" onclick="_pickStar(3)" style="font-size:44px;cursor:pointer;color:#555;transition:color .1s;user-select:none;line-height:1">★</span>
        <span data-s="4" onclick="_pickStar(4)" style="font-size:44px;cursor:pointer;color:#555;transition:color .1s;user-select:none;line-height:1">★</span>
        <span data-s="5" onclick="_pickStar(5)" style="font-size:44px;cursor:pointer;color:#555;transition:color .1s;user-select:none;line-height:1">★</span>
      </div>
      <div id="rating-label" style="font-size:13px;color:#aaa;margin-bottom:16px;min-height:20px"></div>
      <div style="display:flex;gap:10px">
        <button class="btn btn-ghost" style="flex:1" onclick="document.getElementById('ov-rating').remove()">Odustani</button>
        <button class="btn btn-primary" style="flex:1" id="rating-submit-btn" onclick="_submitRating(${toUserId},${listingId})" disabled>Ocijeni</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if(e.target===ov) ov.remove(); });
  _pushBack(() => ov.remove());
}

const _starLabels = ['','😕 Loše','😐 Ispod prosjeka','🙂 Solidno','😊 Dobro','🤩 Odlično'];
let _selectedStars = 0;

function _pickStar(n) {
  _selectedStars = n;
  document.querySelectorAll('#rating-stars span').forEach(s => {
    s.style.color = parseInt(s.dataset.s) <= n ? '#f4c430' : 'rgba(255,255,255,.2)';
  });
  const lbl = document.getElementById('rating-label');
  if (lbl) lbl.textContent = _starLabels[n] || '';
  const btn = document.getElementById('rating-submit-btn');
  if (btn) btn.disabled = false;
}

async function _submitRating(toUserId, listingId) {
  if (!_selectedStars) return;
  const stars = _selectedStars;
  const btn = document.getElementById('rating-submit-btn');
  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Šaljem...'; }
    await api('POST', '/ratings', { to_user_id: toUserId, listing_id: listingId, stars });
    document.getElementById('ov-rating')?.remove();
    _selectedStars = 0;
    toast('✅ Ocjena poslana!', 'ok');
    // Odmah ažuriraj dugme na stranici ispod
    const rateBtn = document.getElementById('rate-btn-' + listingId);
    if (rateBtn) {
      rateBtn.disabled = true;
      rateBtn.textContent = '⭐ Ocijenjeno ' + '★'.repeat(stars) + '☆'.repeat(5 - stars);
      rateBtn.style.opacity = '.5';
    }
  } catch(err) {
    toast('❌ ' + err.message, 'err');
    if (btn) { btn.disabled = false; btn.textContent = 'Ocijeni'; }
  }
}

// ═══════════════════════════════════════════════════════
// PROVJERA OCJENE + KORISNIČKI PROFIL
// ═══════════════════════════════════════════════════════
async function checkAndRate(toUserId, listingId, listingName, btn) {
  try {
    const res = await api('GET', '/ratings/check/' + listingId);
    if (res.rated) {
      if (btn) {
        const stars = res.rating ? res.rating.stars : 0;
        const starsStr = stars ? ' ' + '★'.repeat(stars) + '☆'.repeat(5-stars) : '';
        btn.disabled = true;
        btn.textContent = `⭐ Ocijenjeno${starsStr}`;
        btn.style.opacity = '.5';
      }
      toast('Već ste ocijenili ovu transakciju.', '');
      return;
    }
    openRatingModal(toUserId, listingId, listingName);
  } catch(e) {
    openRatingModal(toUserId, listingId, listingName);
  }
}

async function openUserProfile(userId, userName) {
  const existing = document.getElementById('ov-user-profile');
  if (existing) existing.remove();
  const ov = document.createElement('div');
  ov.id = 'ov-user-profile';
  // Ne koristimo .ov klasu - sve inline da izbjegnemo CSS konflikte
  ov.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'bottom:0',
    'z-index:10001', 'background:rgba(0,0,0,.82)', 'backdrop-filter:blur(4px)',
    'display:flex', 'flex-direction:column', 'align-items:center',
    'justify-content:flex-start', 'padding-top:64px',
    'overflow-y:auto', 'overscroll-behavior:contain'
  ].join(';') + ';';
  ov.innerHTML = `
    <div style="background:#1a1a1a;border:1px solid #333;border-radius:14px;padding:22px 20px;width:calc(100% - 32px);max-width:360px;animation:slideUp .22s ease;position:relative" onclick="event.stopPropagation()">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:18px;color:#fff">👤 ${userName}</div>
        <button id="ov-user-profile-close" style="background:none;border:none;color:#888;font-size:22px;cursor:pointer;line-height:1;padding:4px 8px">✕</button>
      </div>
      <div id="user-profile-body" style="color:#aaa;font-size:13px;text-align:center;padding:16px">Učitavam...</div>
    </div>`;
  document.body.appendChild(ov);
  document.getElementById('ov-user-profile-close').addEventListener('click', e => {
    e.stopPropagation();
    ov.remove();
  });
  ov.addEventListener('click', e => { if(e.target===ov) ov.remove(); });
  _pushBack(() => ov.remove());

  try {
    const data = await api('GET', '/ratings/' + userId);
    const col = avCol(String(userId));
    const body = document.getElementById('user-profile-body');
    if (!body) return;
    const avgStars = data.avg_stars || 0;
    const total = data.total || 0;
    const sales = data.sales_count || 0;

    // Za otkupljivača fetchaj broj prihvaćenih ponuda (transakcija)
    let buyerTransactions = data.buyer_transactions || 0;

    let starsStr = '';
    for(let i=1;i<=5;i++) {
      starsStr += `<span style="font-size:30px;color:${i<=Math.round(avgStars)?'#f4c430':'#444'}">${i<=Math.round(avgStars)?'★':'☆'}</span>`;
    }
    const isBuyer = data.role === 'buyer';
    const txCount = isBuyer ? buyerTransactions : sales;
    const txLabel = isBuyer
      ? (txCount > 0 ? `<div style="background:rgba(41,128,185,.12);border:1px solid rgba(41,128,185,.2);border-radius:8px;padding:8px 16px;font-size:13px;color:#5dade2;margin-top:4px">🛒 ${txCount} kupovina</div>` : '')
      : (txCount > 0 ? `<div style="background:rgba(29,185,84,.12);border:1px solid rgba(29,185,84,.2);border-radius:8px;padding:8px 16px;font-size:13px;color:#1db954;margin-top:4px">✅ ${txCount} uspješnih prodaja</div>` : '');
    body.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;gap:10px">
        <div style="width:56px;height:56px;border-radius:50%;background:${col};display:flex;align-items:center;justify-content:center;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:22px;color:#fff">${initials(userName)}</div>
        <div style="font-size:15px;font-weight:700;color:#fff">${userName}</div>
        ${avgStars > 0 ? `
          <div>${starsStr}</div>
          <div style="font-size:13px;color:#aaa">${avgStars} prosjek · ${total} ${total===1?'ocjena':'ocjena'}</div>
        ` : `<div style="font-size:13px;color:#555;margin:8px 0">Još nema ocjena</div>`}
        ${txLabel}
      </div>`;
  } catch(e) {
    const body = document.getElementById('user-profile-body');
    if (body) body.textContent = 'Nije moguće učitati profil.';
  }
}

// ═══════════════════════════════════════════════════════
// ADMIN — BROADCAST SLANJE
// ═══════════════════════════════════════════════════════
async function openBroadcastModal() {
  const existing = document.getElementById('ov-broadcast');
  if (existing) existing.remove();
  let histHtml = '';
  try {
    const hist = await api('GET', '/admin/broadcasts');
    histHtml = hist.length ? hist.slice(0,5).map(b=>`
      <div style="border-top:1px solid var(--border);padding:8px 0;font-size:12px">
        <div style="color:var(--muted2)">${fmtDate(b.created_at)}</div>
        <div style="color:var(--text);margin-top:2px">${b.message}</div>
      </div>`).join('') : '<div style="font-size:12px;color:var(--muted);padding:8px 0">Nema prethodnih obavještenja.</div>';
  } catch(e) {}
  const ov = document.createElement('div');
  ov.id = 'ov-broadcast';
  ov.className = 'ov ov-center on';
  ov.innerHTML = `
    <div style="background:var(--panel);border:1px solid var(--border2);border-radius:14px;padding:24px 20px;width:100%;max-width:420px;animation:slideUp .22s ease">
      <button onclick="document.getElementById('ov-broadcast').remove()" style="float:right;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer">✕</button>
      <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:18px;margin-bottom:16px">📢 Broadcast poruka</div>
      <div class="fg">
        <label>Poruka svim korisnicima</label>
        <textarea id="bc-msg" rows="3" placeholder="Unesite obavještenje..." style="width:100%;background:var(--dark);border:1px solid var(--border2);border-radius:7px;color:var(--text);padding:10px;font-family:Barlow,sans-serif;font-size:13px;resize:vertical"></textarea>
      </div>
      <button class="btn btn-primary btn-block" onclick="sendBroadcast()">📤 Pošalji svim korisnicima</button>
      ${histHtml ? `<div style="margin-top:16px"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Prethodna obavještenja</div>${histHtml}</div>` : ''}
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if(e.target===ov) ov.remove(); });
}

async function sendBroadcast() {
  const msg = document.getElementById('bc-msg')?.value.trim();
  if (!msg) { toast('Unesite poruku', 'err'); return; }
  try {
    await api('POST', '/admin/broadcast', { message: msg });
    document.getElementById('ov-broadcast')?.remove();
    toast('✅ Broadcast poslan svim korisnicima!', 'ok');
  } catch(err) { toast('❌ ' + err.message, 'err'); }
}

// ═══════════════════════════════════════════════════════
// EMAIL NOTIFY TOGGLE (u profilu)
// ═══════════════════════════════════════════════════════
async function toggleEmailNotify(val) {
  try {
    await api('PUT', '/auth/email-notify', { email_notify: val });
    CU.emailNotify = val;
    // Vizuelno ažuriraj slider
    const span = document.querySelector('#p-email-notify + span');
    const knob = document.querySelector('#p-email-notify + span span');
    if (span) span.style.background = val ? 'var(--green)' : 'var(--border2)';
    if (knob) knob.style.left = val ? '23px' : '3px';
    toast(val ? '✅ Email notifikacije uključene' : 'Email notifikacije isključene', val ? 'ok' : '');
  } catch(err) { toast('❌ ' + err.message, 'err'); }
}

// ═══════════════════════════════════════════════════════
// TERMS & CONDITIONS
// ═══════════════════════════════════════════════════════
function openTerms() {
  const content = document.getElementById('terms-content');
  if (content && !content.innerHTML) {
    content.innerHTML = `
<h3 style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:16px;color:var(--text);margin:16px 0 6px">1. Opšte odredbe</h3>
<p>Berza Katalizatora (u daljem tekstu: "Platforma") je online tržište koje omogućava fizičkim i pravnim licima (u daljem tekstu: "Korisnici") da objavljuju i pregledaju oglase za prodaju katalizatora i DPF filtera. Platforma je u vlasništvu fizičkog lica sa sjedištem u Bijeljini, Bosna i Hercegovina.</p>
<p>Korišćenjem Platforme prihvatate ove Uslove u potpunosti. Ako se ne slažete sa bilo kojim dijelom ovih Uslova, molimo vas da ne koristite Platformu.</p>

<h3 style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:16px;color:var(--text);margin:16px 0 6px">2. Opis usluge</h3>
<p>Platforma pruža isključivo tehnički prostor za objavljivanje oglasa i komunikaciju između prodavača i otkupljivača katalizatora. Berza Katalizatora <strong style="color:var(--text)">nije stranka</strong> u bilo kakvoj transakciji između Korisnika i ne vrši posredovanje u kupoprodaji.</p>

<h3 style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:16px;color:var(--text);margin:16px 0 6px">3. Odricanje od odgovornosti</h3>
<p><strong style="color:var(--text)">Platforma ne snosi nikakvu odgovornost</strong> za:</p>
<ul style="padding-left:18px;margin:8px 0">
  <li style="margin-bottom:6px">Tačnost, potpunost ili istinitost informacija koje Korisnici objavljuju u oglasima</li>
  <li style="margin-bottom:6px">Kvalitet, stanje, autentičnost ili vrijednost robe koja je predmet oglasa</li>
  <li style="margin-bottom:6px">Postupke, propuste ili namjere bilo kojeg Korisnika Platforme</li>
  <li style="margin-bottom:6px">Finansijske gubitke, prevare ili sporove nastale između Korisnika</li>
  <li style="margin-bottom:6px">Neisporuku robe, neplaćanje ili bilo koji drugi oblik neispunjenja obaveza između Korisnika</li>
  <li style="margin-bottom:6px">Štetu nastalu usled korišćenja ili nemogućnosti korišćenja Platforme</li>
</ul>
<p>Sve transakcije se odvijaju isključivo između Korisnika, na njihovu vlastitu odgovornost.</p>

<h3 style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:16px;color:var(--text);margin:16px 0 6px">4. Obaveze Korisnika</h3>
<p>Korisnici su dužni da:</p>
<ul style="padding-left:18px;margin:8px 0">
  <li style="margin-bottom:6px">Objavljuju isključivo tačne i istinite informacije o robi koju nude</li>
  <li style="margin-bottom:6px">Ne objavljuju oglase za robu koja je ukradena, falsifikovana ili čija prodaja nije dozvoljena zakonom</li>
  <li style="margin-bottom:6px">Ne koriste Platformu u svrhe prevare, uznemiravanja ili bilo koje druge protivpravne aktivnosti</li>
  <li style="margin-bottom:6px">Postupaju u dobroj vjeri prema ostalim Korisnicima</li>
  <li style="margin-bottom:6px">Preuzmu punu odgovornost za sve obaveze koje preuzmu putem Platforme</li>
</ul>

<h3 style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:16px;color:var(--text);margin:16px 0 6px">5. Zabranjeni sadržaj</h3>
<p>Strogo je zabranjeno objavljivanje oglasa koji sadrže: robu nezakonito nabavljenu ili ukradenu, lažne ili manipulativne opise, kontakt podatke trećih lica bez njihovog pristanka, uvredljiv ili diskriminatorni sadržaj. Platforma zadržava pravo da bez prethodne najave ukloni svaki oglas koji smatra neprimjerenim ili koji krši ove Uslove.</p>

<h3 style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:16px;color:var(--text);margin:16px 0 6px">6. Prijava prevare i sporova</h3>
<p>U slučaju sumnje na prevaru ili bilo koji oblik zloupotrebe, Korisnici su dužni prijaviti incident nadležnim organima (policija, tužilaštvo). Platforma može pružiti administrativnu podršku organima gonjenja dostavljanjem podataka o Korisnicima isključivo na osnovu valjane sudske odluke ili naloga nadležnog organa, u skladu sa važećim zakonodavstvom BiH i Srbije.</p>
<p>Platforma <strong style="color:var(--text)">ne arbitrira</strong> u sporovima između Korisnika i nije nadležna za rješavanje reklamacija.</p>

<h3 style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:16px;color:var(--text);margin:16px 0 6px">7. Politika privatnosti i zaštita podataka</h3>
<p>Platforma prikuplja sljedeće lične podatke pri registraciji: ime i prezime, grad, adresa, broj telefona i email adresa. Ovi podaci se koriste isključivo za funkcionisanje Platforme i komunikaciju između Korisnika.</p>
<p>Platforma ne prodaje, ne iznajmljuje niti ne dijeli lične podatke Korisnika trećim stranama u komercijalne svrhe. Podaci se čuvaju na sigurnom serveru i zaštićeni su standardnim sigurnosnim mjerama.</p>
<p>Korisnik ima pravo zatražiti brisanje svog naloga i svih povezanih podataka slanjem zahtjeva na: <strong style="color:var(--orange)">berzakatalizatora@gmail.com</strong></p>

<h3 style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:16px;color:var(--text);margin:16px 0 6px">8. Kolačići (Cookies)</h3>
<p>Platforma koristi isključivo funkcionalne kolačiće neophodne za rad (sesija, prijava). Ne koriste se kolačići za praćenje, profilisanje ili oglašavanje.</p>

<h3 style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:16px;color:var(--text);margin:16px 0 6px">9. Izmjene Uslova</h3>
<p>Platforma zadržava pravo izmjene ovih Uslova u bilo kojem trenutku. Korisnici će biti obaviješteni o značajnim izmjenama putem obavještenja na Platformi. Nastavak korišćenja Platforme nakon objave izmjena smatra se prihvatanjem novih Uslova.</p>

<h3 style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:16px;color:var(--text);margin:16px 0 6px">10. Nadležnost i mjerodavno pravo</h3>
<p>Na ove Uslove primjenjuje se pravo Bosne i Hercegovine. Za sve sporove koji bi mogli nastati iz korišćenja Platforme nadležan je sud u Bijeljini, Bosna i Hercegovina.</p>

<h3 style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:16px;color:var(--text);margin:16px 0 6px">11. Kontakt</h3>
<p>Za sva pitanja u vezi sa ovim Uslovima možete nas kontaktirati na: <strong style="color:var(--orange)">berzakatalizatora@gmail.com</strong></p>
    `;
  }
  document.getElementById('ov-terms').classList.add('on');
  _pushBack(() => closeOv('ov-terms'));
}

function acceptTermsAndClose() {
  const chk = document.getElementById('reg-terms');
  if (chk) chk.checked = true;
  closeOv('ov-terms');
  toast('✅ Uslovi prihvaćeni', 'ok');
}
// ═══════════════════════════════════════════════════════
function initCookieBanner() {
  if (!localStorage.getItem('cookie_consent')) {
    setTimeout(() => {
      const b = document.getElementById('cookie-banner');
      if (b) b.style.display = 'block';
    }, 1200);
  }
}

function acceptCookies() {
  localStorage.setItem('cookie_consent', 'all');
  const b = document.getElementById('cookie-banner');
  if (b) { b.style.opacity='0'; b.style.transition='opacity .3s'; setTimeout(()=>b.remove(),300); }
}

function declineCookies() {
  localStorage.setItem('cookie_consent', 'necessary');
  const b = document.getElementById('cookie-banner');
  if (b) { b.style.opacity='0'; b.style.transition='opacity .3s'; setTimeout(()=>b.remove(),300); }
}

// INIT
initAC('reg-city', 'reg-country');
initCookieBanner();

// ── PWA Install ──────────────────────────────────────────
let _installPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _installPrompt = e;
  // Prikaži dugme samo na hero stranici
  const btn = document.getElementById('install-btn');
  if (btn) btn.style.display = '';
});

async function installPWA() {
  if (!_installPrompt) {
    toast('Aplikacija je već instalirana ili nije dostupna na ovom uređaju', '');
    return;
  }
  _installPrompt.prompt();
  const result = await _installPrompt.userChoice;
  if (result.outcome === 'accepted') {
    toast('✅ Aplikacija instalirana!', 'ok');
    const btn = document.getElementById('install-btn');
    if (btn) btn.style.display = 'none';
    _installPrompt = null;
  }
}

window.addEventListener('appinstalled', () => {
  const btn = document.getElementById('install-btn');
  if (btn) btn.style.display = 'none';
  _installPrompt = null;
});

// ── Service Worker registracija ──────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

tryAutoLogin().then(() => {
  if (!CU) { showPage('page-hero'); history.replaceState({page:'page-hero'}, ''); }
});