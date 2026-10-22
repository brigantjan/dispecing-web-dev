/* ════════════════════════════════════════════════════════════════════════════
   MODUL PORUCHY v DISPEČINGU – poruchy_modul_v2.js
   KROK 3a: kostra + prepínač Balíčky | Poruchy + token
   KROK 3b: zoznam porúch (všetky stĺpce a filtre ako Poruchy Web), rýchle filtre
            z dashboardu, triedenie podľa LT, šírky stĺpcov, export do Excelu
   ────────────────────────────────────────────────────────────────────────────
   • Načítava sa z index.html AŽ PO hlavnom skripte (používa api, toast, setStatus,
     currentUser z Dispečingu).
   • Dáta porúch ostávajú v DB Porúch – modul volá existujúci backend Porúch
     (poruchy-api / poruchy-api-dev) s tokenom, ktorý vydá Dispečing
     (POST /api/poruchy/token). Druhé prihlásenie netreba.
   • Všetky id prvkov modulu majú predponu „pm-“ (žiadna kolízia s Dispečingom).
   • Prístup k Poruchám: rola admin / dispečér / vedenie (vedenie = len čítanie,
     všetky strediská) + zapnutý modul „poruchy“ v users.moduly.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const VERZIA = 'v2 (3b)';
  const ROLY_S_PRISTUPOM = ['admin', 'dispečér', 'vedenie'];
  const STR_LABEL = { zilina: 'Žilina', bratislava: 'Bratislava', trencin: 'Trenčín' };
  const STAVY = ['Otvorená', 'Zrealizovaná', 'Provizórna', 'Stornovaná', 'Zaparkovaná'];

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
  let domHotovy = false;

  const S = {
    zaklad: 'nie',                  // 'nie' | 'nacitavam' | 'ok' | 'chyba'
    chyba: '',
    me: null,                       // /me z backendu Porúch (role, stredisko, vsetky)
    cis: { dopady: [], typy: [], media: [] },
    technici: [],
    dash: {},                       // počty z /dashboard
    quickFilter: null,              // rýchly filter z dashboardu
    sortByLt: false,                // dočasné triedenie podľa LT (len pri „Otvorené“)
    rows: [],
    loadSeq: 0,                     // ochrana proti starším odpovediam (rýchle písanie vo filtri)
    lastSavedId: null,              // použije krok 3c (zvýraznenie uloženého riadku)
  };

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
  function maBalicky() { return moduly.has('balicky') || !maPoruchy(); }
  function lenCitanie() { return rola() === 'vedenie' || (S.me && S.me.role === 'citatel'); }
  function vsetkyStrediska() { return !!(S.me && S.me.vsetky); }
  function kluc() {
    const e = (typeof currentUser !== 'undefined' && currentUser && currentUser.email) || '';
    return 'dispecing_rezim_' + e;
  }
  function stat(msg, k) { if (typeof setStatus === 'function') setStatus(msg, k || 'info'); }
  function hlas(msg) { if (typeof toast === 'function') toast(msg); }

  // ── FORMÁTOVANIE (rovnaké ako Poruchy Web) ─────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const pad = n => String(n).padStart(2, '0');
  function fmtDate(v) {
    if (!v) return '';
    const d = new Date(v);
    return isNaN(d) ? String(v) : d.toLocaleDateString('sk-SK');
  }
  function fmtDateTime(v) {
    if (!v) return '';
    const d = new Date(v);
    return isNaN(d) ? String(v) : d.toLocaleDateString('sk-SK') + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtMoney(v) {
    if (v === null || v === undefined || v === '') return '';
    return Number(v).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }
  function rowStavClass(r) {
    if (r.stav === 'Otvorená' && !r.planovany_datum) return 'pm-r-nenaplanovana';
    return ({ 'Zrealizovaná': 'pm-r-zrealizovana', 'Provizórna': 'pm-r-provizorna', 'Stornovaná': 'pm-r-stornovana',
      'Zaparkovaná': 'pm-r-zaparkovana', 'Otvorená': 'pm-r-otvorena' })[r.stav] || '';
  }
  // Čas do/po LT v tvare hh:mm (backend: do_po_lt_hod v hodinách). Zelená = v termíne, červená = po termíne.
  function ltHoursCell(r) {
    const h = r.do_po_lt_hod;
    if (h === null || h === undefined) return '<span class="pm-badge">—</span>';
    const sign = h < 0 ? '-' : '';
    const tm = Math.round(Math.abs(h) * 60);
    return `<span class="pm-badge pm-b-${h < 0 ? 'cervena' : 'zelena'}">${sign}${Math.floor(tm / 60)}:${pad(tm % 60)}</span>`;
  }
  const neuct = (flag, val) => flag ? 'neúčtuje sa' : val;

  // ── STĹPCE ZOZNAMU (poradie a šírky ako Poruchy Web; „stredisko“ len pre vedenie) ──
  //   f: typ filtra v druhom riadku hlavičky
  const DATE2 = (a, b, t) => ({ typ: 'date2', a, b, t });
  const COLS = [
    { k: 'stav',        l: 'Stav',          w: 78,  f: { typ: 'select', id: 'pm-f-stav', ph: 'Všetky' }, v: r => esc(r.stav) },
    { k: 'id',          l: 'ID',            w: 118, v: r => esc(r.externe_id || '') },
    { k: 'stredisko',   l: 'Stredisko',     w: 82,  len: 'vsetky', v: r => esc(STR_LABEL[r.stredisko] || r.stredisko || '') },
    { k: 'dopad',       l: 'Dopad',         w: 58,  f: { typ: 'select', id: 'pm-f-dopad', ph: 'Všetky' }, v: r => esc(r.dopad_kod || '') },
    { k: 'typ',         l: 'Typ',           w: 58,  f: { typ: 'select', id: 'pm-f-typ', ph: 'Všetky' }, v: r => esc(r.typ_kod || '') },
    { k: 'siet',        l: 'Sieť',          w: 34,  v: r => r.siet ? 'Áno' : 'Nie' },
    { k: 'medium',      l: 'Médium',        w: 58,  f: { typ: 'select', id: 'pm-f-medium', ph: 'Všetky' }, v: r => esc(r.medium_kod || '') },
    { k: 'popis',       l: 'Popis',         w: 140, t: r => r.popis, v: r => esc(r.popis || '') },
    { k: 'adresa',      l: 'Adresa',        w: 130, t: r => r.adresa, v: r => esc(r.adresa || '') },
    { k: 'meno',        l: 'Meno/Subjekt',  w: 80,  t: r => r.meno_subjekt, v: r => esc(r.meno_subjekt || '') },
    { k: 'zadane',      l: 'Zadané',        w: 120, f: DATE2('pm-f-zadanie-od', 'pm-f-zadanie-do', 'Zadané'), v: r => fmtDateTime(r.datum_zadania) },
    { k: 'ltdo',        l: 'LT do',         w: 120, f: DATE2('pm-f-lt-od', 'pm-f-lt-do', 'LT do'), v: r => fmtDateTime(r.lt_vybavit_do) },
    { k: 'realizacia',  l: 'Realizácia',    w: 120, f: DATE2('pm-f-realizacia-od', 'pm-f-realizacia-do', 'Realizácia'), v: r => fmtDateTime(r.datum_realizacie) },
    { k: 'plan',        l: 'Plán',          w: 98,  v: r => fmtDateTime(r.planovany_datum) },
    { k: 'lthod',       l: 'LT (hh:mm)',    w: 92,  f: { typ: 'ltstatus', id: 'pm-f-lt-status' }, v: ltHoursCell },
    { k: 'realizuje',   l: 'Realizuje',     w: 120, f: { typ: 'select', id: 'pm-f-technik', ph: 'Všetci' }, t: r => r.technici_aktivni, v: r => esc(r.technici_aktivni || '') },
    { k: 'spmzad',      l: 'SPM zadaný',    w: 120, f: DATE2('pm-f-spm-zadany-od', 'pm-f-spm-zadany-do', 'SPM zadaný'), v: r => neuct(r.spm_zadany_neuctuje_sa, fmtDate(r.spm_zadany)) },
    { k: 'spmsch',      l: 'SPM schválený', w: 120, f: DATE2('pm-f-spm-schvaleny-od', 'pm-f-spm-schvaleny-do', 'SPM schválený'), v: r => neuct(r.spm_schvaleny_neuctuje_sa, fmtDate(r.spm_schvaleny)) },
    { k: 'spmc',        l: 'SPM č.',        w: 85,  f: { typ: 'text', id: 'pm-f-spm-cislo', ph: 'SPM č.' }, v: r => esc(r.spm_cislo || '') },
    { k: 'cenap',       l: 'Cena práce',    w: 80,  v: r => neuct(r.cena_prace_neuctuje_sa, fmtMoney(r.cena_prace)) },
    { k: 'cenam',       l: 'Cena mat.',     w: 80,  v: r => neuct(r.cena_materialu_neuctuje_sa, fmtMoney(r.cena_materialu)) },
    { k: 'trzba',       l: 'Tržba',         w: 80,  v: r => fmtMoney(r.trzba_spolu) },
    { k: 'zakazka',     l: 'Zákazka',       w: 115, f: { typ: 'zakazka' }, v: r => esc(r.cislo_zakazky || '') },
    { k: 'faktura',     l: 'Faktúra',       w: 90,  v: r => esc(r.faktura_stav || '') },
    { k: 'poznamka',    l: 'Poznámka',      w: 150, t: r => r.poznamka, v: r => esc(r.poznamka || '') },
  ];
  function aktivneCols() { return COLS.filter(c => c.len !== 'vsetky' || vsetkyStrediska()); }

  const F_SELECT_IDS = ['pm-f-stav', 'pm-f-dopad', 'pm-f-typ', 'pm-f-medium', 'pm-f-technik', 'pm-f-lt-status'];
  const F_DATUM_IDS = ['pm-f-zadanie-od', 'pm-f-zadanie-do', 'pm-f-lt-od', 'pm-f-lt-do', 'pm-f-realizacia-od', 'pm-f-realizacia-do',
    'pm-f-spm-zadany-od', 'pm-f-spm-zadany-do', 'pm-f-spm-schvaleny-od', 'pm-f-spm-schvaleny-do'];
  const F_TEXT_IDS = ['pm-f-spm-cislo', 'pm-f-zakazka'];
  // id filtra → parameter backendu (rovnaké názvy ako Poruchy Web)
  const F_PARAM = {
    'pm-f-stav': 'stav', 'pm-f-dopad': 'dopad_id', 'pm-f-typ': 'typ_id', 'pm-f-medium': 'medium_id',
    'pm-f-technik': 'technik_id', 'pm-f-hladat': 'hladat',
    'pm-f-zadanie-od': 'zadanie_od', 'pm-f-zadanie-do': 'zadanie_do', 'pm-f-lt-od': 'lt_od', 'pm-f-lt-do': 'lt_do',
    'pm-f-realizacia-od': 'realizacia_od', 'pm-f-realizacia-do': 'realizacia_do',
    'pm-f-spm-zadany-od': 'spm_zadany_od', 'pm-f-spm-zadany-do': 'spm_zadany_do',
    'pm-f-spm-schvaleny-od': 'spm_schvaleny_od', 'pm-f-spm-schvaleny-do': 'spm_schvaleny_do',
    'pm-f-spm-cislo': 'spm_cislo', 'pm-f-lt-status': 'lt_filter',
  };

  // Dashboard porúch (sidebar) – rovnaké položky a rýchle filtre ako Poruchy Web
  const DASH = [
    { k: 'otvorene',         l: 'Otvorené',          c: 'c-blue' },
    { k: 'blizi_sa_lt',      l: 'Blíži sa LT 🟠',    c: 'c-orange' },
    { k: 'po_lt',            l: 'Po LT 🔴',          c: 'c-red' },
    { k: 'nenaplanovane',    l: 'Nenaplánované 🔴',  c: 'c-red' },
    { k: 'espm_nezadane',    l: 'Nezadané ESPM',     c: 'c-yellow' },
    { k: 'espm_neschvalene', l: 'Neschválené ESPM',  c: 'c-yellow' },
    { k: 'provizorne',       l: 'Provizórne 💚',     c: 'c-green' },
    { k: 'poznamky',         l: 'Poznámky 📝',       c: '' },
  ];
  const QUICK_LABEL = Object.fromEntries(DASH.map(d => [d.k, d.l]));

  const VIEWS = [
    { id: 'zoznam',     ico: '📋', nazov: 'Zoznam porúch', krok: '3b' },
    { id: 'prehlad',    ico: '💰', nazov: 'Prehľad',        krok: '3d' },
    { id: 'technici',   ico: '👷', nazov: 'Technici',       krok: '3e' },
    { id: 'poznamky',   ico: '📝', nazov: 'Poznámky',       krok: '3e' },
    { id: 'nastavenia', ico: '⚙️', nazov: 'Nastavenia',     krok: '3e' },
  ];

  // ── CSS (injektované) ──────────────────────────────────────────────────────
  const CSS = `
#app.mod-poruchy .sidebar > .sidebar-nav,
#app.mod-poruchy #dash-title-wrap,
#app.mod-poruchy #dash-section,
#app.mod-poruchy .tabbar,
#app.mod-poruchy .tab-content,
#app.mod-poruchy #polt-badge{display:none!important}
#pm-side,#pm-root{display:none}
#app.mod-poruchy #pm-side{display:flex;flex-direction:column;flex:1;min-height:0}
#app.mod-poruchy #pm-root{display:flex}
#pm-switch{display:none;background:rgba(255,255,255,.14);border-radius:16px;padding:2px;gap:2px}
#pm-switch.on{display:inline-flex}
#pm-switch button{background:transparent;border:none;color:rgba(255,255,255,.85);font-size:11px;font-weight:600;padding:4px 11px;border-radius:14px;cursor:pointer;letter-spacing:.3px}
#pm-switch button.act{background:#fff;color:var(--accent)}
#pm-switch button:not(.act):hover{background:rgba(255,255,255,.18)}
#pm-side .sb-nav-item.act{background:var(--accent-light);color:var(--accent);border-left-color:var(--accent);font-weight:600}
#pm-dash{padding:6px 10px 10px;overflow-y:auto;flex:1;display:grid;grid-template-columns:1fr 1fr;gap:6px;align-content:start}
#pm-dash .dash-card{margin:0;padding:7px 9px}
#pm-dash .dash-val{font-size:18px}
#pm-dash .dash-card.klik{cursor:pointer}
#pm-dash .dash-card.klik:hover{border-color:var(--accent);background:var(--accent-light)}
#pm-dash .dash-card.act{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
#pm-root{flex:1;flex-direction:column;overflow:hidden;min-height:0}
#pm-tabbar{display:flex;align-items:center;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;padding:0 8px}
#pm-tabbar .tab-btn.act{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
#pm-body{flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0}
.pm-view{display:none;flex:1;min-height:0;flex-direction:column;overflow:auto;padding:12px 14px}
.pm-view.act{display:flex}
.pm-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px 18px;box-shadow:var(--sh);max-width:760px}
.pm-card h3{font-size:15px;margin-bottom:10px;color:var(--text)}
.pm-ro{display:inline-block;background:var(--yellow-bg);color:var(--yellow);border-radius:10px;padding:1px 8px;font-size:10px;font-weight:700;margin-left:6px;vertical-align:middle}
.pm-err{color:var(--red-t);font-weight:600}
/* ── Zoznam porúch ── */
#pm-v-zoznam{overflow:hidden;padding-bottom:8px}
.pm-zhdr{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;flex-shrink:0}
.pm-zhdr h2{font-size:16px;font-weight:700;margin-right:auto;color:var(--text)}
.pm-zhdr h2 small{font-weight:400;color:var(--muted);font-size:12px;margin-left:6px}
.pm-zhdr input{border:1px solid var(--border2);border-radius:6px;padding:5px 9px;width:260px;background:#fff}
#pm-qf{display:flex;justify-content:space-between;align-items:center;gap:8px;background:#fff3e0;color:#ef6c00;border-radius:6px;padding:6px 10px;margin-bottom:8px;font-size:12px;font-weight:600;flex-shrink:0}
#pm-qf.hid{display:none}
#pm-sort-lt.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.pm-twrap{flex:1;min-height:0;overflow:auto;background:#fff;border:1px solid var(--border);border-radius:6px}
table.pm-tbl{border-collapse:collapse;table-layout:fixed;font-size:11.5px}
.pm-tbl th,.pm-tbl td{padding:4px 6px;text-align:left;border-bottom:1px solid #dcdfe3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-tbl thead th{background:#eef1f4;position:sticky;top:0;z-index:2;user-select:none;font-size:11px;font-weight:600;color:var(--text2)}
.pm-tbl tr.pm-hrow th{height:24px}
.pm-tbl tr.pm-frow th{top:24px;padding:3px 4px;font-weight:400;vertical-align:top}
.pm-tbl .pm-cf{width:100%;font-size:10.5px;padding:2px 3px;border:1px solid #dcdfe3;border-radius:3px;background:#fff}
.pm-tbl .pm-cf-d{display:flex;flex-direction:column;gap:2px}
.pm-tbl .pm-cf-z label{display:flex;align-items:center;gap:3px;font-size:9.5px;color:var(--muted);margin-top:2px}
.pm-tbl .pm-cf-z input[type=checkbox]{width:auto}
.pm-tbl th{position:sticky}
.pm-tbl .pm-rh{position:absolute;right:0;top:0;width:6px;height:100%;cursor:col-resize;z-index:3}
.pm-tbl .pm-rh:hover,.pm-tbl .pm-rh.on{background:var(--accent);opacity:.5}
.pm-tbl tbody tr{cursor:pointer}
.pm-tbl tbody tr:hover{background:#f0f4ff}
.pm-tbl tr.pm-r-zrealizovana{background:#8fe38f}.pm-tbl tr.pm-r-zrealizovana:hover{background:#d4ecd6}
.pm-tbl tr.pm-r-stornovana{background:#ffeb3b}.pm-tbl tr.pm-r-stornovana:hover{background:#fff59d}
.pm-tbl tr.pm-r-zaparkovana{background:#64b5f6}.pm-tbl tr.pm-r-zaparkovana:hover{background:#bbdefb}
.pm-tbl tr.pm-r-otvorena{background:#fff}
.pm-tbl tr.pm-r-nenaplanovana{background:#ffb3b3}.pm-tbl tr.pm-r-nenaplanovana:hover{background:#ff9999}
.pm-tbl tr.pm-r-provizorna{background:#aef73e}.pm-tbl tr.pm-r-provizorna:hover{background:#d4ffa0}
.pm-tbl tr.pm-r-saved{outline:3px solid var(--accent);outline-offset:-3px}
.pm-badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap}
.pm-b-zelena{background:#8fe38f;color:#1b5e20}.pm-b-cervena{background:#ffb3b3;color:#b71c1c}
.pm-zfoot{font-size:11px;color:var(--muted);padding-top:5px;flex-shrink:0}
`;

  // ── DOM: prepínač, bočné menu, stránka Porúch (raz) ────────────────────────
  function pripravDom() {
    if (domHotovy) return;
    const st = document.createElement('style');
    st.id = 'pm-css';
    st.textContent = CSS;
    document.head.appendChild(st);

    const sw = document.createElement('div');
    sw.id = 'pm-switch';
    sw.innerHTML = '<button data-r="balicky">📦 Balíčky</button><button data-r="poruchy">🔧 Poruchy</button>';
    sw.addEventListener('click', e => { const b = e.target.closest('button[data-r]'); if (b) prepni(b.dataset.r); });
    const notif = document.getElementById('notif-btn');
    if (notif && notif.parentNode) notif.parentNode.insertBefore(sw, notif);

    const side = document.createElement('div');
    side.id = 'pm-side';
    side.innerHTML =
      '<div class="sidebar-nav"><div class="sb-nav-lbl">Poruchy</div>' +
      VIEWS.map(v => `<div class="sb-nav-item" data-v="${v.id}"><span class="icon">${v.ico}</span>${v.nazov}</div>`).join('') +
      '</div><div style="padding:4px 10px 4px;border-top:1px solid var(--border)"><div class="dash-title">Dashboard porúch</div></div>' +
      '<div id="pm-dash"></div>';
    side.addEventListener('click', e => {
      const it = e.target.closest('[data-v]');
      if (it) { ukazView(it.dataset.v); return; }
      const dc = e.target.closest('[data-dash]');
      if (dc) klikDash(dc.dataset.dash);
    });
    const nav = document.querySelector('.sidebar > .sidebar-nav');
    if (nav) nav.after(side);

    const root = document.createElement('div');
    root.id = 'pm-root';
    root.innerHTML =
      '<div id="pm-tabbar">' +
      VIEWS.map(v => `<div class="tab-btn" data-v="${v.id}">${v.ico} ${v.nazov}</div>`).join('') +
      '</div><div id="pm-body">' +
      VIEWS.map(v => `<div class="pm-view" id="pm-v-${v.id}"></div>`).join('') +
      '</div>';
    root.querySelector('#pm-tabbar').addEventListener('click', e => { const it = e.target.closest('[data-v]'); if (it) ukazView(it.dataset.v); });
    const tc = document.querySelector('.main .tab-content');
    if (tc) tc.after(root);

    // Skratky Balíčkov (Ctrl+N, Ctrl+F, F2) v režime Poruchy nesmú prepínať skryté záložky Balíčkov.
    // Ctrl+F v Poruchách = skok do vyhľadávania v zozname porúch.
    window.addEventListener('keydown', e => {
      if (rezim !== 'poruchy') return;
      const k = (e.key || '').toLowerCase();
      if (((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (k === 'n' || k === 'f')) || e.key === 'F2') {
        e.stopImmediatePropagation();
        if (k === 'n' || k === 'f') e.preventDefault();
        if (k === 'f' && (e.ctrlKey || e.metaKey)) {
          ukazView('zoznam');
          const h = document.getElementById('pm-f-hladat');
          if (h) { h.focus(); h.select(); }
        }
      }
    }, true);

    // Stĺpec „LT (hh:mm)“ beží voči aktuálnemu času → každých 30 min potichu obnov zoznam
    // (len keď je otvorený režim Poruchy a záložka Zoznam), plus dashboard.
    setInterval(() => {
      if (rezim === 'poruchy' && pmView === 'zoznam' && S.zaklad === 'ok') { loadPoruchy(true); loadDashboard(); }
    }, 30 * 60 * 1000);

    domHotovy = true;
  }

  // ── PREPÍNANIE REŽIMU A ZÁLOŽIEK ───────────────────────────────────────────
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
      if (S.zaklad === 'nie' || S.zaklad === 'chyba') nacitajZaklad();
      else { loadDashboard(); }
    }
  }

  function ukazView(v) {
    pmView = v;
    document.querySelectorAll('#pm-side [data-v], #pm-tabbar [data-v]').forEach(el => el.classList.toggle('act', el.dataset.v === v));
    document.querySelectorAll('#pm-body .pm-view').forEach(el => el.classList.toggle('act', el.id === 'pm-v-' + v));
    if (v !== 'zoznam') renderPlaceholder(v);
  }

  function renderPlaceholder(v) {
    const el = document.getElementById('pm-v-' + v);
    if (!el || el.dataset.hotovo) return;
    const d = VIEWS.find(x => x.id === v);
    el.innerHTML = `<div class="pm-card"><h3>${d.ico} ${esc(d.nazov)}</h3>
      <div style="font-size:12px;color:var(--muted)">Táto časť sa pripravuje (krok ${d.krok}). Zatiaľ ju používaj v pôvodnom webe Poruchy.</div></div>`;
    el.dataset.hotovo = '1';
  }

  // ── ZÁKLADNÉ NAČÍTANIE: /me, číselníky, technici, dashboard, zoznam ─────────
  async function nacitajZaklad() {
    S.zaklad = 'nacitavam';
    renderZoznamStav('<span class="spin-sm dark"></span>&nbsp;Pripájam sa k Poruchám… (prvé spojenie môže trvať do 1 min.)');
    stat('Poruchy: pripájam sa… (prvé spojenie môže trvať do 1 min.)', 'info');
    try {
      S.me = await papi('GET', '/me');
      const [dopady, typy, media, technici] = await Promise.all([
        papi('GET', '/ciselniky/dopady'), papi('GET', '/ciselniky/typy'), papi('GET', '/ciselniky/media'), papi('GET', '/technici'),
      ]);
      S.cis = { dopady: dopady || [], typy: typy || [], media: media || [] };
      S.technici = technici || [];
      S.zaklad = 'ok';
      stat('Poruchy: spojenie OK', 'ok');
      buildZoznam();
      await Promise.all([loadDashboard(), loadPoruchy()]);
    } catch (e) {
      S.zaklad = 'chyba';
      S.chyba = e.message;
      stat('Poruchy: ' + e.message, 'err');
      renderZoznamStav(`<span class="pm-err">❌ ${esc(e.message)}</span>
        <div style="margin-top:10px"><button class="btn btn-outline" id="pm-retry">↻ Skúsiť znova</button></div>`);
      const rb = document.getElementById('pm-retry');
      if (rb) rb.onclick = () => { token = null; nacitajZaklad(); };
    }
  }

  function renderZoznamStav(html) {
    const el = document.getElementById('pm-v-zoznam');
    if (el) el.innerHTML = `<div class="pm-card"><h3>📋 Zoznam porúch</h3><div style="font-size:12px">${html}</div></div>`;
  }

  // ── DASHBOARD ──────────────────────────────────────────────────────────────
  async function loadDashboard() {
    try {
      S.dash = (await papi('GET', '/dashboard')) || {};
    } catch (e) { console.warn('Poruchy dashboard:', e.message); }
    renderDash();
  }

  function renderDash() {
    const el = document.getElementById('pm-dash');
    if (!el) return;
    el.innerHTML = DASH.map(d => {
      const n = Number(S.dash[d.k] ?? 0);
      const klik = n > 0 ? ' klik' : '';
      const act = S.quickFilter === d.k ? ' act' : '';
      return `<div class="dash-card ${d.c}${klik}${act}" data-dash="${d.k}" title="${n > 0 ? 'Klik = zobraziť v zozname' : ''}">
        <div class="dash-val">${esc(S.dash[d.k] ?? '–')}</div><div class="dash-lbl">${esc(d.l)}</div></div>`;
    }).join('');
  }

  function klikDash(k) {
    if (!(Number(S.dash[k]) > 0)) return;
    if (k === 'poznamky') { ukazView('poznamky'); return; }
    applyQuickFilter(k);
  }

  // ── ZOZNAM: stavba DOM ─────────────────────────────────────────────────────
  function filterHtml(c) {
    const f = c.f;
    if (!f) return '';
    if (f.typ === 'select') return `<select id="${f.id}" class="pm-cf"><option value="">${f.ph}</option></select>`;
    if (f.typ === 'text') return `<input id="${f.id}" class="pm-cf" placeholder="${f.ph}">`;
    if (f.typ === 'date2') return `<div class="pm-cf-d"><input type="date" id="${f.a}" class="pm-cf" title="${f.t} od"><input type="date" id="${f.b}" class="pm-cf" title="${f.t} do"></div>`;
    if (f.typ === 'ltstatus') return `<select id="${f.id}" class="pm-cf"><option value="">Všetky</option><option value="do_lt">Do LT</option><option value="po_lt">Po LT</option></select>`;
    if (f.typ === 'zakazka') return `<div class="pm-cf-z"><input id="pm-f-zakazka" class="pm-cf" placeholder="Zákazka"><label><input type="checkbox" id="pm-f-zakazka-prazdna">Bez zákazky</label></div>`;
    return '';
  }

  function buildZoznam() {
    const el = document.getElementById('pm-v-zoznam');
    if (!el) return;
    const cols = aktivneCols();
    const me = S.me || {};
    const kde = vsetkyStrediska() ? 'všetky strediská' : (STR_LABEL[me.stredisko] || me.stredisko || '');
    el.innerHTML = `
      <div class="pm-zhdr">
        <h2>Zoznam porúch<small>${esc(kde)}</small>${lenCitanie() ? '<span class="pm-ro">LEN ČÍTANIE</span>' : ''}</h2>
        <input id="pm-f-hladat" placeholder="Hľadať (adresa, meno, popis, ID, zákazka)…" title="Ctrl+F">
        <button class="btn btn-outline" id="pm-f-reset">Zrušiť filtre</button>
        <button class="btn btn-outline" id="pm-export">⬇️ Export do Excelu</button>
        <button class="btn btn-outline" id="pm-reload" title="Obnoviť zoznam a dashboard">↻</button>
      </div>
      <div id="pm-qf" class="hid"><span id="pm-qf-text"></span>
        <span style="display:flex;gap:6px">
          <button class="btn btn-outline btn-xs" id="pm-sort-lt" style="display:none">Zoradiť podľa LT</button>
          <button class="btn btn-outline btn-xs" id="pm-qf-clear">Zobraziť všetky poruchy</button>
        </span></div>
      <div class="pm-twrap" id="pm-twrap">
        <table class="pm-tbl" id="pm-tbl">
          <colgroup>${cols.map(c => `<col data-k="${c.k}" style="width:${c.w}px">`).join('')}</colgroup>
          <thead>
            <tr class="pm-hrow">${cols.map(c => `<th data-k="${c.k}">${esc(c.l)}</th>`).join('')}</tr>
            <tr class="pm-frow">${cols.map(c => `<th data-k="${c.k}">${filterHtml(c)}</th>`).join('')}</tr>
          </thead>
          <tbody id="pm-tbody"></tbody>
        </table>
      </div>
      <div class="pm-zfoot" id="pm-zfoot"></div>`;

    fillSelect('pm-f-stav', STAVY.map(s => ({ id: s, nazov: s })), 'id', 'nazov', 'Všetky');
    fillSelect('pm-f-dopad', S.cis.dopady, 'id', 'nazov', 'Všetky');
    fillSelect('pm-f-typ', S.cis.typy, 'id', 'nazov', 'Všetky');
    fillSelect('pm-f-medium', S.cis.media, 'id', 'nazov', 'Všetky');
    fillSelect('pm-f-technik', S.technici, 'id', 'meno', 'Všetci');

    const zrusQ = () => { S.quickFilter = null; S.sortByLt = false; };
    [...F_SELECT_IDS, ...F_DATUM_IDS].forEach(id => {
      const x = document.getElementById(id);
      if (x) x.addEventListener('change', () => { zrusQ(); loadPoruchy(); });
    });
    const zp = document.getElementById('pm-f-zakazka-prazdna');
    zp.addEventListener('change', () => {
      document.getElementById('pm-f-zakazka').disabled = zp.checked;
      zrusQ(); loadPoruchy();
    });
    let tmr = null;
    ['pm-f-hladat', ...F_TEXT_IDS].forEach(id => {
      document.getElementById(id).addEventListener('input', () => {
        zrusQ(); clearTimeout(tmr); tmr = setTimeout(() => loadPoruchy(), 350);
      });
    });
    document.getElementById('pm-f-reset').onclick = () => { zrusQ(); resetFiltre(); loadPoruchy(); };
    document.getElementById('pm-qf-clear').onclick = () => { zrusQ(); loadPoruchy(); };
    document.getElementById('pm-sort-lt').onclick = () => { S.sortByLt = !S.sortByLt; loadPoruchy(); };
    document.getElementById('pm-export').onclick = exportExcel;
    document.getElementById('pm-reload').onclick = () => { loadPoruchy(); loadDashboard(); };
    // Dvojklik (nie jeden klik) – z riadku sa často kopíruje ID myšou (rovnako ako Poruchy Web)
    document.getElementById('pm-tbody').addEventListener('dblclick', e => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) otvorDetail(Number(tr.dataset.id));
    });
    initColumnResize();
  }

  function fillSelect(elId, items, valKey, labelKey, placeholder) {
    const el = document.getElementById(elId);
    if (!el) return;
    const cur = el.value;
    el.innerHTML = (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') +
      (items || []).map(it => `<option value="${esc(it[valKey])}">${esc(it[labelKey])}</option>`).join('');
    el.value = cur || '';
  }

  function resetFiltre() {
    F_SELECT_IDS.forEach(id => { const x = document.getElementById(id); if (x) x.value = ''; });
    F_DATUM_IDS.forEach(id => { const x = document.getElementById(id); if (x) x.value = ''; });
    F_TEXT_IDS.forEach(id => { const x = document.getElementById(id); if (x) x.value = ''; });
    const h = document.getElementById('pm-f-hladat'); if (h) h.value = '';
    const zp = document.getElementById('pm-f-zakazka-prazdna'); if (zp) zp.checked = false;
    const z = document.getElementById('pm-f-zakazka'); if (z) z.disabled = false;
  }

  function applyQuickFilter(k) {
    S.quickFilter = k;
    S.sortByLt = false;                // triedenie podľa LT je vždy len dočasné
    resetFiltre();
    ukazView('zoznam');
    loadPoruchy();
  }

  // ── ŠÍRKY STĹPCOV (ťahanie; pamätá si ich prehliadač) ──────────────────────
  // Nový kľúč podľa názvu stĺpca. Ak ho ešte nemá, prevezme šírky zo starého webu Porúch
  // (rovnaká doména → rovnaký localStorage; tam boli podľa poradia 0–23).
  const COLW_KEY = 'pm_col_widths_v1';
  const STARE_PORADIE = ['stav', 'id', 'dopad', 'typ', 'siet', 'medium', 'popis', 'adresa', 'meno', 'zadane', 'ltdo', 'realizacia',
    'plan', 'lthod', 'realizuje', 'spmzad', 'spmsch', 'spmc', 'cenap', 'cenam', 'trzba', 'zakazka', 'faktura', 'poznamka'];
  function nacitajSirky() {
    try {
      const raw = localStorage.getItem(COLW_KEY);
      if (raw) return JSON.parse(raw) || {};
      const stare = JSON.parse(localStorage.getItem('poruchy_col_widths') || '{}');
      const out = {};
      Object.keys(stare).forEach(i => { const k = STARE_PORADIE[Number(i)]; if (k && Number(stare[i]) > 0) out[k] = Number(stare[i]); });
      return out;
    } catch (_) { return {}; }
  }
  function updateTableWidth() {
    const t = document.getElementById('pm-tbl');
    if (!t) return;
    let total = 0;
    t.querySelectorAll('colgroup col').forEach(c => { const w = parseInt(c.style.width, 10); total += isNaN(w) ? 90 : w; });
    t.style.width = total + 'px';     // explicitná šírka – stĺpec sa dá zúžiť aj pod šírku obsahu
  }
  function initColumnResize() {
    const saved = nacitajSirky();
    const t = document.getElementById('pm-tbl');
    t.querySelectorAll('tr.pm-hrow th[data-k]').forEach(th => {
      const k = th.dataset.k;
      const col = t.querySelector(`colgroup col[data-k="${k}"]`);
      if (!col) return;
      if (saved[k]) col.style.width = saved[k] + 'px';
      const h = document.createElement('div');
      h.className = 'pm-rh';
      th.appendChild(h);
      h.addEventListener('mousedown', e => {
        e.preventDefault(); e.stopPropagation();
        const x0 = e.clientX, w0 = col.getBoundingClientRect().width;
        h.classList.add('on');
        const mv = ev => { col.style.width = Math.max(20, Math.round(w0 + ev.clientX - x0)) + 'px'; updateTableWidth(); };
        const up = () => {
          h.classList.remove('on');
          document.removeEventListener('mousemove', mv);
          document.removeEventListener('mouseup', up);
          saved[k] = parseInt(col.style.width, 10);
          try { localStorage.setItem(COLW_KEY, JSON.stringify(saved)); } catch (_) {}
        };
        document.addEventListener('mousemove', mv);
        document.addEventListener('mouseup', up);
      });
    });
    updateTableWidth();
  }

  // ── ZOZNAM: parametre, načítanie, vykreslenie ──────────────────────────────
  // Rovnaké parametre ako Poruchy Web – používa ich zoznam aj export (export = presne to, čo je na obrazovke).
  function buildParams() {
    const p = new URLSearchParams();
    if (S.quickFilter) {
      p.set('rychly', S.quickFilter);
      if (S.quickFilter === 'otvorene' && S.sortByLt) p.set('sort', 'lt_asc');
      return p;
    }
    Object.keys(F_PARAM).forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const v = String(el.value || '').trim();
      if (v) p.set(F_PARAM[id], v);
    });
    const zp = document.getElementById('pm-f-zakazka-prazdna');
    const z = document.getElementById('pm-f-zakazka');
    if (zp && zp.checked) p.set('cislo_zakazky_prazdne', 'true');
    else if (z && z.value.trim()) p.set('cislo_zakazky', z.value.trim());
    return p;
  }
  function hasActiveFilters() { return !!S.quickFilter || Array.from(buildParams().keys()).length > 0; }

  async function loadPoruchy(ticho) {
    const tbody = document.getElementById('pm-tbody');
    if (!tbody) return;
    const qf = document.getElementById('pm-qf');
    const sb = document.getElementById('pm-sort-lt');
    if (S.quickFilter) {
      document.getElementById('pm-qf-text').textContent = 'Rýchly filter: ' + (QUICK_LABEL[S.quickFilter] || S.quickFilter);
      qf.classList.remove('hid');
      sb.style.display = S.quickFilter === 'otvorene' ? '' : 'none';
      sb.classList.toggle('on', S.quickFilter === 'otvorene' && S.sortByLt);
    } else {
      qf.classList.add('hid');
    }
    renderDash();                      // zvýraznenie aktívneho rýchleho filtra
    const ncol = aktivneCols().length;
    if (!ticho) tbody.innerHTML = `<tr><td colspan="${ncol}">Načítavam…</td></tr>`;
    const seq = ++S.loadSeq;
    try {
      const rows = await papi('GET', '/poruchy?' + buildParams().toString());
      if (seq !== S.loadSeq) return;   // medzitým prišla novšia požiadavka
      S.rows = Array.isArray(rows) ? rows : [];
      renderTable();
      applyLastSavedHighlight();
    } catch (e) {
      if (seq !== S.loadSeq) return;
      tbody.innerHTML = `<tr><td colspan="${ncol}" class="pm-err">Chyba: ${esc(e.message)}</td></tr>`;
    }
  }

  function rowHtml(r, cols) {
    return cols.map(c => {
      const t = c.t ? c.t(r) : null;
      return `<td${t ? ` title="${esc(t)}"` : ''}>${c.v(r)}</td>`;
    }).join('');
  }

  function renderTable() {
    const tbody = document.getElementById('pm-tbody');
    const cols = aktivneCols();
    const foot = document.getElementById('pm-zfoot');
    if (!S.rows.length) {
      tbody.innerHTML = `<tr><td colspan="${cols.length}">Žiadne záznamy.</td></tr>`;
    } else {
      tbody.innerHTML = S.rows.map(r => `<tr class="${rowStavClass(r)}" data-id="${Number(r.id)}">${rowHtml(r, cols)}</tr>`).join('');
    }
    if (foot) foot.textContent = `${S.rows.length} porúch · dvojklik na riadok = detail · aktualizované ${new Date().toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' })}`;
  }

  // Tichá aktualizácia jedného riadku po uložení (krok 3c). Len bez filtrov – inak normálny reload.
  function tryPatchRowInPlace(r) {
    if (hasActiveFilters()) return false;
    const tr = document.querySelector(`#pm-tbody tr[data-id="${Number(r.id)}"]`);
    if (!tr) return false;
    const i = S.rows.findIndex(x => x.id === r.id);
    if (i >= 0) S.rows[i] = r;
    tr.className = rowStavClass(r);
    tr.innerHTML = rowHtml(r, aktivneCols());
    return true;
  }

  function applyLastSavedHighlight() {
    if (!S.lastSavedId) return;
    const id = S.lastSavedId;
    S.lastSavedId = null;
    const tr = document.querySelector(`#pm-tbody tr[data-id="${Number(id)}"]`);
    if (!tr) return;
    tr.classList.add('pm-r-saved');
    tr.scrollIntoView({ block: 'center' });
    setTimeout(() => tr.classList.remove('pm-r-saved'), 5000);
  }

  function otvorDetail(id) {
    // Formulár poruchy príde v kroku 3c
    hlas('Detail / úprava poruchy príde v kroku 3c – zatiaľ ju otvor v pôvodnom webe Poruchy');
  }

  // ── EXPORT DO EXCELU (rovnaké filtre ako na obrazovke) ─────────────────────
  async function exportExcel() {
    const btn = document.getElementById('pm-export');
    const txt = btn.textContent;
    btn.disabled = true; btn.textContent = 'Exportujem…';
    try {
      const res = await papi('GET', '/export/excel?' + buildParams().toString(), null, { raw: true });
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename="?([^"]+)"?/);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = m ? m[1] : 'poruchy_export.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) {
      hlas('❌ Export sa nepodaril: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = txt;
    }
  }

  // ── VSTUPNÝ BOD – volá Dispečing po načítaní /api/me (users.moduly) ────────
  function init(m) {
    moduly = new Set(m && m.size ? m : ['balicky']);
    pripravDom();
    const sw = document.getElementById('pm-switch');
    const oba = maPoruchy() && maBalicky();
    if (sw) sw.classList.toggle('on', oba);
    const side = document.getElementById('pm-side');
    if (side && !maPoruchy()) side.remove();

    let start = 'balicky';
    if (!maBalicky()) start = 'poruchy';
    else if (oba) { try { if (localStorage.getItem(kluc()) === 'poruchy') start = 'poruchy'; } catch (_) {} }
    prepni(start);
    // Server Porúch sa môže prebúdzať – zobuď ho na pozadí hneď po prihlásení
    if (maPoruchy() && start !== 'poruchy') fetch(PORUCHY_API_URL + '/health').catch(() => {});
  }

  // Verejné rozhranie (ďalšie kroky ho rozšíria)
  window.PoruchyModul = {
    init, papi, prepni, verzia: VERZIA,
    get rezim() { return rezim; },
    _test: { S, buildParams, tryPatchRowInPlace, loadPoruchy, applyQuickFilter },
  };
})();
