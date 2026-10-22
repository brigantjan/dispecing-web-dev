/* ════════════════════════════════════════════════════════════════════════════
   MODUL PORUCHY v DISPEČINGU – poruchy_modul_v1.js  (KROK 3a: kostra + prepínač)
   ────────────────────────────────────────────────────────────────────────────
   • Načítava sa z index.html AŽ PO hlavnom skripte (používa api, toast, setStatus,
     currentUser z Dispečingu).
   • Dáta porúch ostávajú v DB Porúch – modul volá existujúci backend Porúch
     (poruchy-api / poruchy-api-dev) s tokenom, ktorý vydá Dispečing
     (POST /api/poruchy/token). Druhé prihlásenie netreba.
   • Prepínač Balíčky | Poruchy v hornej lište. Kto má len jeden modul, prepínač
     nevidí a rovno pracuje v tom svojom.
   • Prístup k Poruchám: rola admin / dispečér / vedenie (vedenie = len čítanie,
     všetky strediská) + zapnutý modul „poruchy“ v users.moduly.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const VERZIA = 'v1 (3a)';
  const ROLY_S_PRISTUPOM = ['admin', 'dispečér', 'vedenie'];
  const STR_LABEL = { zilina: 'Žilina', bratislava: 'Bratislava', trencin: 'Trenčín' };

  // DEV frontend → DEV backend Porúch, inak PROD (rovnaké pravidlo ako API_URL Dispečingu)
  const PORUCHY_API_URL = (() => {
    const h = window.location.hostname + window.location.pathname;
    return (h.includes('dispecing-web-dev') || h.includes('localhost') || h.includes('127.0.0.1'))
      ? 'https://poruchy-api-dev.onrender.com' : 'https://poruchy-api.onrender.com';
  })();

  // ── STAV MODULU ────────────────────────────────────────────────────────────
  let moduly = new Set(['balicky']);
  let rezim = 'balicky';            // 'balicky' | 'poruchy'
  let pmView = 'zoznam';            // aktívna záložka v Poruchách
  let pmInfo = null;                // { me, dash, technikov } po prvom načítaní
  let pmNacitavam = false;
  let domHotovy = false;

  // ── TOKEN PORÚCH ───────────────────────────────────────────────────────────
  let token = null, tokenExp = 0, tokenPromise = null;

  function jwtExpMs(t) {
    try {
      let b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      const p = JSON.parse(atob(b));
      return (Number(p.exp) || 0) * 1000;
    } catch (_) { return 0; }
  }

  // Vráti platný token. Obnoví ho, ak chýba, ak o 5 min vyprší, alebo ak force=true.
  // Súbežné volania čakajú na jedno spoločné obnovenie (žiadne duplicitné požiadavky).
  async function getToken(force) {
    if (!force && token && Date.now() < tokenExp - 5 * 60 * 1000) return token;
    if (tokenPromise) return tokenPromise;
    tokenPromise = (async () => {
      try {
        const r = await api('POST', '/api/poruchy/token');
        if (!r || !r.token) throw new Error('Dispečing nevydal token pre Poruchy');
        token = r.token;
        tokenExp = jwtExpMs(token) || (Date.now() + 11 * 3600 * 1000);
        return token;
      } finally { tokenPromise = null; }
    })();
    return tokenPromise;
  }

  // Volanie backendu Porúch. Pri 401 si raz vypýta nový token a požiadavku zopakuje.
  //   method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'; body: objekt (JSON) alebo null
  //   opt.raw = true → vráti surový Response (napr. Excel export)
  async function papi(method, path, body, opt) {
    opt = opt || {};
    for (let pokus = 0; pokus < 2; pokus++) {
      const t = await getToken(pokus > 0);
      const o = { method: method || 'GET', headers: { 'Authorization': 'Bearer ' + t } };
      if (body !== undefined && body !== null) {
        o.headers['Content-Type'] = 'application/json';
        o.body = JSON.stringify(body);
      }
      let res;
      try {
        res = await fetch(PORUCHY_API_URL + path, o);
      } catch (e) {
        throw new Error('Server Porúch je nedostupný (možno sa prebúdza – skús o chvíľu znova)');
      }
      if (res.status === 401 && pokus === 0) { token = null; continue; }
      if (!res.ok) {
        let d = '';
        try { const j = await res.json(); d = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail || ''); } catch (_) {}
        throw new Error(`Poruchy HTTP ${res.status}${d ? ' – ' + d : ''}`);
      }
      if (opt.raw) return res;
      if (res.status === 204) return null;
      const txt = await res.text();
      return txt ? JSON.parse(txt) : null;
    }
  }

  // ── PRÍSTUPY ───────────────────────────────────────────────────────────────
  function rola() { return (typeof currentUser !== 'undefined' && currentUser && currentUser.rola) || ''; }
  function maPoruchy() { return moduly.has('poruchy') && ROLY_S_PRISTUPOM.includes(rola()); }
  // Balíčky má každý, kto má modul balicky – alebo kto nemá použiteľné Poruchy (nikdy nesmie ostať bez ničoho)
  function maBalicky() { return moduly.has('balicky') || !maPoruchy(); }
  function lenCitanie() { return rola() === 'vedenie'; }

  function kluc() {
    const e = (typeof currentUser !== 'undefined' && currentUser && currentUser.email) || '';
    return 'dispecing_rezim_' + e;
  }

  // ── CSS (injektované – index.html sa kvôli modulu takmer nemení) ───────────
  const CSS = `
#app.mod-poruchy .sidebar > .sidebar-nav,
#app.mod-poruchy #dash-title-wrap,
#app.mod-poruchy #dash-section,
#app.mod-poruchy .tabbar,
#app.mod-poruchy .tab-content,
#app.mod-poruchy #polt-badge{display:none!important}
#pm-side,#pm-root{display:none}
#app.mod-poruchy #pm-side{display:block}
#app.mod-poruchy #pm-root{display:flex}
#pm-switch{display:none;background:rgba(255,255,255,.14);border-radius:16px;padding:2px;gap:2px}
#pm-switch.on{display:inline-flex}
#pm-switch button{background:transparent;border:none;color:rgba(255,255,255,.85);font-size:11px;font-weight:600;padding:4px 11px;border-radius:14px;cursor:pointer;letter-spacing:.3px}
#pm-switch button.act{background:#fff;color:var(--accent)}
#pm-switch button:not(.act):hover{background:rgba(255,255,255,.18)}
#pm-root{flex:1;flex-direction:column;overflow:hidden;min-height:0}
#pm-tabbar{display:flex;align-items:center;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;padding:0 8px}
#pm-tabbar .tab-btn.act{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
#pm-body{flex:1;overflow:auto;padding:16px}
.pm-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px 18px;box-shadow:var(--sh);max-width:760px}
.pm-card h3{font-size:15px;margin-bottom:10px;color:var(--text)}
.pm-row{display:flex;gap:8px;font-size:12px;padding:3px 0;color:var(--text2)}
.pm-row b{color:var(--text);min-width:150px;font-weight:600}
.pm-ok{color:var(--green-t);font-weight:600}.pm-err{color:var(--red-t);font-weight:600}
.pm-ro{display:inline-block;background:var(--yellow-bg);color:var(--yellow);border-radius:10px;padding:1px 8px;font-size:10px;font-weight:700;margin-left:6px}
#pm-side .sb-nav-item.act{background:var(--accent-light);color:var(--accent);border-left-color:var(--accent);font-weight:600}
#pm-dash{padding:6px 10px;font-size:12px;color:var(--text2)}
#pm-dash .pm-dv{font-size:20px;font-weight:700;color:var(--accent)}
`;

  const VIEWS = [
    { id: 'zoznam',     ico: '📋', nazov: 'Zoznam porúch', krok: '3b' },
    { id: 'prehlad',    ico: '💰', nazov: 'Prehľad',        krok: '3d' },
    { id: 'technici',   ico: '👷', nazov: 'Technici',       krok: '3e' },
    { id: 'poznamky',   ico: '📝', nazov: 'Poznámky',       krok: '3e' },
    { id: 'nastavenia', ico: '⚙️', nazov: 'Nastavenia',     krok: '3e' },
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── DOM: vloží prepínač, bočné menu a stránku Porúch (raz) ─────────────────
  function pripravDom() {
    if (domHotovy) return;
    const st = document.createElement('style');
    st.id = 'pm-css';
    st.textContent = CSS;
    document.head.appendChild(st);

    // Prepínač do hornej lišty (pred zvonček notifikácií)
    const sw = document.createElement('div');
    sw.id = 'pm-switch';
    sw.innerHTML = '<button data-r="balicky">📦 Balíčky</button><button data-r="poruchy">🔧 Poruchy</button>';
    sw.addEventListener('click', e => { const b = e.target.closest('button[data-r]'); if (b) prepni(b.dataset.r); });
    const notif = document.getElementById('notif-btn');
    if (notif && notif.parentNode) notif.parentNode.insertBefore(sw, notif);

    // Bočné menu Porúch (za navigáciu Balíčkov)
    const side = document.createElement('div');
    side.id = 'pm-side';
    side.innerHTML =
      '<div class="sidebar-nav"><div class="sb-nav-lbl">Poruchy</div>' +
      VIEWS.map(v => `<div class="sb-nav-item" data-v="${v.id}"><span class="icon">${v.ico}</span>${v.nazov}</div>`).join('') +
      '</div><div style="padding:4px 10px 4px;border-top:1px solid var(--border)"><div class="dash-title">Dashboard porúch</div></div>' +
      '<div id="pm-dash">–</div>';
    side.addEventListener('click', e => { const it = e.target.closest('[data-v]'); if (it) ukazView(it.dataset.v); });
    const nav = document.querySelector('.sidebar .sidebar-nav');
    if (nav) nav.after(side);

    // Stránka Porúch (vedľa .tab-content Balíčkov)
    const root = document.createElement('div');
    root.id = 'pm-root';
    root.innerHTML =
      '<div id="pm-tabbar">' +
      VIEWS.map(v => `<div class="tab-btn" data-v="${v.id}">${v.ico} ${v.nazov}</div>`).join('') +
      '</div><div id="pm-body"></div>';
    root.querySelector('#pm-tabbar').addEventListener('click', e => { const it = e.target.closest('[data-v]'); if (it) ukazView(it.dataset.v); });
    const tc = document.querySelector('.main .tab-content');
    if (tc) tc.after(root);

    // Skratky Balíčkov (Ctrl+N, Ctrl+F, F2) v režime Poruchy nesmú prepínať skryté záložky Balíčkov.
    // Capture fáza na window beží PRED listenermi na document.
    window.addEventListener('keydown', e => {
      if (rezim !== 'poruchy') return;
      const k = (e.key || '').toLowerCase();
      if (((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (k === 'n' || k === 'f')) || e.key === 'F2') {
        e.stopImmediatePropagation();
        if (k === 'n' || k === 'f') e.preventDefault();
      }
    }, true);

    domHotovy = true;
  }

  // ── PREPÍNANIE REŽIMU ──────────────────────────────────────────────────────
  function prepni(r) {
    if (r === 'poruchy' && !maPoruchy()) return;
    if (r === 'balicky' && !maBalicky()) return;
    rezim = r;
    const app = document.getElementById('app');
    if (app) app.classList.toggle('mod-poruchy', r === 'poruchy');
    document.querySelectorAll('#pm-switch button').forEach(b => b.classList.toggle('act', b.dataset.r === r));
    const tf = document.querySelector('.topbar-title');
    if (tf) tf.innerHTML = 'DISPECING <span style="font-weight:300;font-size:12px;opacity:.8">· ' + (r === 'poruchy' ? 'Poruchy' : 'Zriaďovanie') + '</span>';
    try { localStorage.setItem(kluc(), r); } catch (_) {}
    if (r === 'poruchy') {
      ukazView(pmView);
      if (!pmInfo && !pmNacitavam) nacitajZaklad();
    }
  }

  function ukazView(v) {
    pmView = v;
    document.querySelectorAll('#pm-side [data-v], #pm-tabbar [data-v]').forEach(el => el.classList.toggle('act', el.dataset.v === v));
    renderBody();
  }

  // ── NAČÍTANIE (3a: overenie spojenia + základné čísla) ─────────────────────
  async function nacitajZaklad() {
    pmNacitavam = true;
    renderBody();
    if (typeof setStatus === 'function') setStatus('Poruchy: pripájam sa… (prvé spojenie môže trvať do 1 min.)', 'info');
    try {
      const me = await papi('GET', '/me');
      const [dash, tech] = await Promise.all([papi('GET', '/dashboard'), papi('GET', '/technici')]);
      pmInfo = { me, dash, technikov: Array.isArray(tech) ? tech.length : 0, chyba: null };
      if (typeof setStatus === 'function') setStatus('Poruchy: spojenie OK', 'ok');
    } catch (e) {
      pmInfo = { chyba: e.message };
      if (typeof setStatus === 'function') setStatus('Poruchy: ' + e.message, 'err');
    } finally {
      pmNacitavam = false;
      renderBody();
      renderDash();
    }
  }

  function renderDash() {
    const el = document.getElementById('pm-dash');
    if (!el) return;
    if (!pmInfo || pmInfo.chyba) { el.textContent = pmInfo && pmInfo.chyba ? 'Nedostupné' : '–'; return; }
    const d = pmInfo.dash || {};
    el.innerHTML = `<div class="pm-dv">${esc(d.otvorene ?? '–')}</div><div>otvorených porúch</div>`;
  }

  function renderBody() {
    const body = document.getElementById('pm-body');
    if (!body) return;
    const v = VIEWS.find(x => x.id === pmView) || VIEWS[0];
    let stav;
    if (pmNacitavam) {
      stav = '<div class="pm-row"><span class="spin-sm dark"></span>&nbsp;Pripájam sa k Poruchám… (prvé spojenie môže trvať do 1 min.)</div>';
    } else if (!pmInfo) {
      stav = '';
    } else if (pmInfo.chyba) {
      stav = `<div class="pm-row"><b>Spojenie</b><span class="pm-err">❌ ${esc(pmInfo.chyba)}</span></div>
              <div style="margin-top:10px"><button class="btn btn-outline" id="pm-retry">↻ Skúsiť znova</button></div>`;
    } else {
      const me = pmInfo.me || {};
      const kde = me.vsetky ? 'všetky strediská' : (STR_LABEL[me.stredisko] || me.stredisko || '–');
      stav = `
        <div class="pm-row"><b>Spojenie</b><span class="pm-ok">✅ OK</span></div>
        <div class="pm-row"><b>Stredisko</b><span>${esc(kde)}</span></div>
        <div class="pm-row"><b>Rola v Poruchách</b><span>${esc(me.role || '–')}${lenCitanie() ? '<span class="pm-ro">LEN ČÍTANIE</span>' : ''}</span></div>
        <div class="pm-row"><b>Otvorené poruchy</b><span>${esc((pmInfo.dash || {}).otvorene ?? '–')}</span></div>
        <div class="pm-row"><b>Technikov</b><span>${esc(pmInfo.technikov)}</span></div>`;
    }
    body.innerHTML = `
      <div class="pm-card">
        <h3>${v.ico} ${esc(v.nazov)}</h3>
        <div style="font-size:12px;color:var(--muted);margin-bottom:12px">
          Táto časť sa pripravuje (krok ${v.krok}). Zatiaľ pracuj v pôvodnom webe Poruchy.
        </div>
        ${stav}
        <div style="font-size:10px;color:var(--muted);margin-top:14px">Modul Poruchy ${VERZIA} · ${esc(PORUCHY_API_URL.replace('https://', ''))}</div>
      </div>`;
    const rb = document.getElementById('pm-retry');
    if (rb) rb.onclick = () => { pmInfo = null; token = null; nacitajZaklad(); };
  }

  // ── VSTUPNÝ BOD – volá Dispečing po načítaní /api/me (users.moduly) ────────
  function init(m) {
    moduly = new Set(m && m.size ? m : ['balicky']);
    pripravDom();
    const sw = document.getElementById('pm-switch');
    const oba = maPoruchy() && maBalicky();
    if (sw) sw.classList.toggle('on', oba);
    // Bočné menu Porúch existuje len pre toho, kto má Poruchy
    const side = document.getElementById('pm-side');
    if (side && !maPoruchy()) side.remove();

    let start = 'balicky';
    if (!maBalicky()) start = 'poruchy';
    else if (oba) { try { if (localStorage.getItem(kluc()) === 'poruchy') start = 'poruchy'; } catch (_) {} }
    prepni(start);
    // Server Porúch (free/Starter) sa môže prebúdzať – zobuď ho na pozadí hneď po prihlásení
    if (maPoruchy() && start !== 'poruchy') fetch(PORUCHY_API_URL + '/health').catch(() => {});
  }

  // Verejné rozhranie (ďalšie kroky ho rozšíria)
  window.PoruchyModul = { init, papi, prepni, verzia: VERZIA, get rezim() { return rezim; } };
})();
