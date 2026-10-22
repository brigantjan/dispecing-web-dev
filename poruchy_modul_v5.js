/* ════════════════════════════════════════════════════════════════════════════
   MODUL PORUCHY v DISPEČINGU – poruchy_modul_v5.js
   KROK 3a: kostra + prepínač Balíčky | Poruchy + token
   KROK 3b: zoznam porúch (všetky stĺpce a filtre ako Poruchy Web), rýchle filtre
            z dashboardu, triedenie podľa LT, šírky stĺpcov, export do Excelu
   KROK 3c: formulár poruchy (nová / úprava / zmazanie), priradenia technikov
            (blokovanie dovolenky), spoločná kapacita, otvorené a posledné poruchy
   v4:      bočný panel a dashboard vzhľadom ako Poruchy Web (tmavomodrý, užší);
            zoznamy vpravo sa dajú zbaliť do lišty (celá výška pre kapacitu)
   v5:      bez 3-dňovej vyťaženosti vo formulári (nahradila ju kapacita vpravo);
            povinné Externé ID + Dátum zadania; kapacita po uložení hneď (bez 60 s cache);
            pri zmene plánovaného dátumu ponúkne posun neukončených priradení technikov
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

  const VERZIA = 'v5 (3c)';
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
  let pmView = 'porucha';           // aktívna záložka v Poruchách (vedenie: zoznam)
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
    { id: 'porucha',    ico: '➕', nazov: 'Nová porucha',  krok: '3c' },
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
/* Bočný panel v režime Poruchy – rovnaký vzhľad ako Poruchy Web (tmavomodrý, 160 px) */
#app.mod-poruchy .sidebar{width:160px!important;min-width:160px!important;background:#0d2b4e;color:#e4e7eb;border-right-color:#0d2b4e}
#app.mod-poruchy .sidebar-brand{border-bottom-color:#1c4a7f;padding:12px 10px 10px}
#app.mod-poruchy .sb-logo{color:#fff;font-size:15px}
#app.mod-poruchy .sb-sub{color:#9aa5b1}
#pm-side{overflow-y:auto}
#pm-side h2{padding:10px 10px;margin:0;font-size:14px;font-weight:700;border-bottom:1px solid #1c4a7f;color:#e4e7eb}
#pm-dash{padding:10px 10px;font-size:11.5px;border-bottom:1px solid #1c4a7f}
#pm-dash div{display:flex;justify-content:space-between;gap:4px;padding:6px 4px;border:1px solid #fff;border-radius:3px;margin-bottom:4px}
#pm-dash div:last-child{margin-bottom:0}
#pm-dash div.klik{cursor:pointer}
#pm-dash div.klik:hover,#pm-dash div.act{background:rgba(255,255,255,.15)}
#pm-nav{padding:8px 0;flex:1}
#pm-nav .pm-nav-i{display:block;width:100%;text-align:left;color:#e4e7eb;padding:9px 10px;font-size:12.5px;cursor:pointer;user-select:none}
#pm-nav .pm-nav-i:hover,#pm-nav .pm-nav-i.act{background:#1c4a7f}
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
/* ── Formulár poruchy (3c) ── */
#pm-root .hid{display:none!important}
#pm-v-porucha{padding:0;overflow:hidden}
.pm-split{display:flex;flex:1;min-height:0;overflow:hidden}
.pm-lp{width:640px;flex-shrink:0;overflow-y:auto;overflow-x:hidden;background:var(--surface);padding:8px 12px 14px}
.pm-fhdr{display:flex;align-items:center;gap:8px;margin-bottom:6px;position:sticky;top:-8px;background:var(--surface);z-index:3;padding:6px 0;border-bottom:1px solid var(--border)}
.pm-fhdr h2{font-size:15px;font-weight:700;margin-right:auto;color:var(--accent)}
.pm-ro-msg{display:none;background:var(--yellow-bg);color:var(--yellow);border-radius:6px;padding:6px 10px;font-size:12px;font-weight:600;margin-bottom:6px}
.pm-readonly .pm-ro-msg{display:block}
.pm-readonly #pm-paste-box,.pm-readonly #pm-prir-add,.pm-readonly .pm-edit,.pm-readonly #pm-f-save,.pm-readonly #pm-f-save-top,
.pm-readonly #pm-f-delete,.pm-readonly #pm-suv-search,.pm-readonly #pm-btn-balicek{display:none!important}
.pm-paste{background:#eef4ff;border:1px solid #c8dbfb;border-radius:6px;padding:7px 9px;margin-bottom:6px;display:flex;flex-direction:column;gap:4px}
.pm-paste label{font-size:10.5px;color:var(--muted)}
.pm-paste textarea{font-family:var(--mono);font-size:11.5px;resize:vertical;border:1px solid var(--border2);border-radius:5px;padding:4px 6px}
.pm-fgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px 10px;align-items:end}
.pm-fgrid .pm-full{grid-column:1/-1}.pm-fgrid .pm-span2{grid-column:span 2}
.pm-chk{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text);padding:6px 0;cursor:pointer;white-space:nowrap}
.pm-chk input{width:auto!important;margin:0}
.pm-sec{font-size:10.5px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.5px;margin:10px 0 4px;padding-top:7px;border-top:1px solid var(--border)}
.pm-inp{width:100%;border:1px solid var(--border2);border-radius:5px;padding:5px 8px;background:#fff}
.pm-hint{font-size:11px;color:var(--muted)}
.pm-warn{background:#fde2e2;color:var(--red);border-radius:5px;padding:6px 9px;font-size:12px;font-weight:600;margin-top:5px}
.pm-pick{padding:4px 6px;border-bottom:1px solid #eef0f3;cursor:pointer;font-size:12px}.pm-pick:hover{background:var(--accent-light)}
.pm-spm{max-width:470px}
.pm-spm-row{display:flex;align-items:flex-end;gap:14px}
.pm-spm-row .field{flex:1}
.pm-povinne{border-color:var(--red-t)!important;background:#fde2e2!important}
.pm-zak-prazdna{background:#fff3e0!important;border-color:#f0a94a!important}
.pm-prow{display:flex;gap:6px;align-items:center;font-size:12px;padding:4px 0;border-bottom:1px solid #f0f0f0;flex-wrap:wrap}
.pm-pinfo{flex:1}
.pm-pedit{display:flex;gap:5px;align-items:center;flex-wrap:wrap;background:var(--surface2);border-radius:5px;padding:5px;margin:3px 0}
.pm-pedit input,.pm-pedit select{border:1px solid var(--border2);border-radius:4px;padding:3px 5px;font-size:12px}
.pm-prir-add{background:#fbfbfc;border:1px solid var(--border);border-radius:6px;padding:8px;margin-top:5px}
.pm-tech-cbs{display:flex;flex-wrap:wrap;gap:3px 12px;max-height:170px;overflow-y:auto}
.pm-tech-cbs label{display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;white-space:nowrap}
.pm-tech-cbs label.pm-dov{color:var(--red-t);text-decoration:line-through;cursor:not-allowed}
.pm-auto{background:#fff9db!important;border-color:#f0c419!important}
.pm-factions{display:flex;gap:8px;align-items:center;margin-top:10px;padding-top:8px;border-top:1px solid var(--border)}
#pm-rp{min-width:0}
.pm-mini{overflow:auto;flex:1;font-size:11.5px}
.pm-mrow{display:flex;gap:8px;align-items:center;padding:4px 8px;border-bottom:1px solid #eef0f3;cursor:pointer;white-space:nowrap}
.pm-mrow:hover{filter:brightness(.95)}
.pm-mrow .pm-mid{font-weight:600;min-width:96px}.pm-mrow .pm-madr{flex:1;overflow:hidden;text-overflow:ellipsis}
.pm-mrow .pm-mlt{color:var(--text2)}.pm-mrow .pm-mtech{color:var(--muted);max-width:140px;overflow:hidden;text-overflow:ellipsis}
.pm-mrow.pm-r-zrealizovana{background:#8fe38f}.pm-mrow.pm-r-stornovana{background:#ffeb3b}.pm-mrow.pm-r-zaparkovana{background:#64b5f6}
.pm-mrow.pm-r-nenaplanovana{background:#ffb3b3}.pm-mrow.pm-r-provizorna{background:#aef73e}
.pm-lbar{flex-shrink:0;padding:6px 10px;background:#f0f4fa;border-top:1px solid var(--border);font-size:11px;font-weight:600;color:var(--accent);cursor:pointer;user-select:none}
.pm-lbar:hover{background:var(--accent-light)}
.pm-ov{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto;z-index:900}
.pm-mbox{background:var(--surface);border-radius:10px;max-width:100%;box-shadow:var(--sh2);font-size:13px}
.pm-mhdr{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid var(--border)}
.pm-mbody{padding:12px 14px;max-height:75vh;overflow:auto}
.pm-cards{display:flex;flex-direction:column;gap:6px}
.pm-cardi{display:flex;justify-content:space-between;align-items:center;gap:8px;background:#fff;border:1px solid var(--border);border-radius:6px;padding:8px 12px}
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
      '<h2>⚡ Poruchy</h2><div id="pm-dash"></div><div id="pm-nav">' +
      VIEWS.map(v => `<div class="pm-nav-i" data-v="${v.id}">${v.ico} ${v.nazov}</div>`).join('') +
      '</div>';
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
        if (k === 'n' && (e.ctrlKey || e.metaKey) && S.zaklad === 'ok' && !lenCitanie()) {
          if (F.id) otvorFormular(null); else ukazView('porucha');
          setTimeout(() => { const p = document.getElementById('pm-paste-input'); if (p) p.focus(); }, 50);
        }
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
    if (r !== 'poruchy') presunKapacitu(false);
    if (r === 'poruchy') {
      ukazView(pmView);
      if (S.zaklad === 'nie' || S.zaklad === 'chyba') nacitajZaklad();
      else { loadDashboard(); }
    }
  }

  let bocneAt = 0;
  function ukazView(v) {
    if (v === 'porucha' && lenCitanie() && !F.id) v = 'zoznam';   // vedenie: formulár len pri otvorenom detaile
    pmView = v;
    document.querySelectorAll('#pm-side [data-v], #pm-tabbar [data-v]').forEach(el => el.classList.toggle('act', el.dataset.v === v));
    document.querySelectorAll('#pm-body .pm-view').forEach(el => el.classList.toggle('act', el.id === 'pm-v-' + v));
    if (v === 'porucha') {
      presunKapacitu(true);
      if (F.hotovy && listyOtvorene() && Date.now() - bocneAt > 60 * 1000) { bocneAt = Date.now(); loadBocneZoznamy(); }
    } else if (v !== 'zoznam') renderPlaceholder(v);
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
      buildForm();
      await otvorFormular(null, null, true);
      if (pmView === 'porucha') ukazView('porucha');
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
      return `<div class="${klik}${act}" data-dash="${d.k}"><span>${esc(d.l)}</span><b>${esc(S.dash[d.k] ?? '–')}</b></div>`;
    }).join('');
    nastavListy();                     // počet otvorených v zbalenej lište
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

  function otvorDetail(id) { otvorFormular(id, 'zoznam'); }

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

  // ════════════════════════════════════════════════════════════════════════
  // KROK 3c – FORMULÁR PORUCHY (nová aj úprava) – logika 1:1 s Poruchy Web
  // ════════════════════════════════════════════════════════════════════════
  const PORUCHA_FIELDS = [
    { key: 'dopad_id', label: 'Dopad', type: 'ciselnik', cis: 'dopady' },
    { key: 'typ_id', label: 'Typ', type: 'ciselnik', cis: 'typy' },
    { key: 'medium_id', label: 'Médium', type: 'ciselnik', cis: 'media' },
    { key: 'siet', label: 'Sieťová porucha', type: 'checkbox' },
    { key: 'popis', label: 'Popis', type: 'text-list', full: true },
    { key: 'adresa', label: 'Adresa', type: 'text', full: true },
    { key: 'meno_subjekt', label: 'Meno / Subjekt', type: 'text' },
    { key: 'datum_zadania', label: 'Dátum zadania', type: 'datetime' },
    { key: 'lt_vybavit_do', label: 'LT – vybaviť do', type: 'datetime' },
    { key: 'planovany_datum', label: 'Plánovaný dátum', type: 'datetime' },
    { key: 'datum_realizacie', label: 'Dátum realizácie', type: 'datetime' },
    { key: 'spm_zadany', label: 'SPM zadaný', type: 'date' },
    { key: 'spm_zadany_neuctuje_sa', label: 'SPM zadaný – neúčtuje sa', type: 'checkbox' },
    { key: 'spm_schvaleny', label: 'SPM schválený', type: 'date' },
    { key: 'spm_schvaleny_neuctuje_sa', label: 'SPM schválený – neúčtuje sa', type: 'checkbox' },
    { key: 'spm_cislo', label: 'SPM číslo', type: 'text' },
    { key: 'cena_prace', label: 'Cena práce (€)', type: 'number' },
    { key: 'cena_prace_neuctuje_sa', label: 'Cena práce – neúčtuje sa', type: 'checkbox' },
    { key: 'cena_materialu', label: 'Cena materiálu (€)', type: 'number' },
    { key: 'cena_materialu_neuctuje_sa', label: 'Cena materiálu – neúčtuje sa', type: 'checkbox' },
    { key: 'cislo_zakazky', label: 'Číslo zákazky', type: 'text' },
    { key: 'faktura_stav', label: 'Faktúra', type: 'select', options: ['Pripravená', 'Odoslaná', 'Neúčtuje sa'], allowEmpty: true },
    { key: 'poznamka', label: 'Poznámka', type: 'text-list', full: true },
  ];
  // Tieto polia majú vlastný statický blok (SPM / ceny / faktúra), nie všeobecnú mriežku
  const SPM_BLOCK_KEYS = new Set(['spm_zadany', 'spm_zadany_neuctuje_sa', 'spm_schvaleny', 'spm_schvaleny_neuctuje_sa',
    'spm_cislo', 'cena_prace', 'cena_prace_neuctuje_sa', 'cena_materialu', 'cena_materialu_neuctuje_sa', 'faktura_stav']);
  const $ = id => document.getElementById(id);
  const PF = k => $('pm-pf-' + k);

  const F = {                 // stav formulára
    hotovy: false,
    id: null,                 // null = nová porucha
    data: null,               // načítaná porucha (pri úprave)
    navrat: 'zoznam',         // kam sa vrátiť po uložení/zatvorení úpravy
    pending: [],              // priradenia novej poruchy (uložia sa po vytvorení poruchy)
    suvisiacaId: null,
    dirty: false,
    saving: false,
    lastAdresa: null,
    popisHistory: [],
  };

  function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function addDaysStr(s, n) {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + n);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  }
  function toLocalDatetimeInput(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function parseSkDatetime(s) {
    const m = String(s || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const [, d, mo, y, h, mi] = m;
    return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`;
  }

  function inputHtmlFor(f, value) {
    const id = 'pm-pf-' + f.key;
    if (f.type === 'checkbox') {
      return `<label class="pm-chk"><input type="checkbox" id="${id}" ${value ? 'checked' : ''}> ${esc(f.label)}</label>`;
    }
    let inner;
    if (f.type === 'select') {
      inner = `<select id="${id}">${(f.allowEmpty ? ['<option value="">–</option>'] : []).concat(
        f.options.map(o => `<option value="${esc(o)}" ${value === o ? 'selected' : ''}>${esc(o)}</option>`)).join('')}</select>`;
    } else if (f.type === 'ciselnik') {
      const items = S.cis[f.cis] || [];
      inner = `<select id="${id}"><option value="">–</option>${items.map(it =>
        `<option value="${esc(it.id)}" ${String(value) === String(it.id) ? 'selected' : ''}>${esc(it.nazov)} (${esc(it.kod)})</option>`).join('')}</select>`;
    } else if (f.type === 'datetime') {
      inner = `<input type="datetime-local" id="${id}" value="${value ? toLocalDatetimeInput(value) : ''}">`;
    } else if (f.type === 'date') {
      inner = `<input type="date" id="${id}" value="${value ? String(value).slice(0, 10) : ''}">`;
    } else if (f.type === 'number') {
      inner = `<input type="number" step="0.01" id="${id}" value="${value ?? ''}">`;
    } else if (f.type === 'text-list') {
      inner = `<input list="${id}-list" id="${id}" value="${esc(value || '')}" autocomplete="off">
        <datalist id="${id}-list">${F.popisHistory.map(p => `<option value="${esc(p)}">`).join('')}</datalist>`;
    } else {
      inner = `<input type="text" id="${id}" value="${esc(value || '')}">`;
    }
    const pov = f.key === 'datum_zadania' ? ' <span style="color:var(--red-t)">*</span>' : '';
    return `<div class="field${f.full ? ' pm-full' : ''}"><label for="${id}">${esc(f.label)}${pov}</label>${inner}</div>`;
  }

  // ── DOM formulára (raz) ────────────────────────────────────────────────────
  function buildForm() {
    const el = $('pm-v-porucha');
    if (!el) return;
    el.innerHTML = `
    <div class="pm-split">
      <div class="pm-lp" id="pm-lp">
        <div class="pm-fhdr">
          <h2 id="pm-f-title">Nová porucha</h2>
          <button class="btn btn-outline" id="pm-f-close-top" type="button">Zavrieť</button>
          <button class="btn btn-accent" id="pm-f-save-top" type="button">💾 Uložiť</button>
        </div>
        <div class="pm-ro-msg" id="pm-ro-msg">👁 Len na prezeranie – zmeny sa nedajú uložiť.</div>
        <div class="pm-paste" id="pm-paste-box">
          <label>Rýchle vloženie zo ST MWF (ID / adresa / meno / zadané / LT / popis — každé na samostatnom riadku, posledný riadok popis je nepovinný)</label>
          <textarea id="pm-paste-input" rows="3" placeholder="Sem vlož skopírovaný blok (5 alebo 6 riadkov)…"></textarea>
          <div><button class="btn btn-outline btn-xs" id="pm-paste-fill" type="button">Rozdeliť a vyplniť</button>
          <span id="pm-paste-status" class="pm-hint"></span></div>
        </div>
        <div class="pm-fgrid pm-top">
          <div class="field"><label for="pm-pf-stav">Stav</label><select id="pm-pf-stav">
            ${STAVY.map(s => `<option value="${s}">${s}</option>`).join('')}</select></div>
          <div class="field pm-span2"><label for="pm-pf-externe_id">Externé ID (Telekom) <span style="color:var(--red-t)">*</span></label><input type="text" id="pm-pf-externe_id"></div>
        </div>
        <div id="pm-dup-warning" class="pm-warn hid"></div>
        <div class="pm-sec">Súvisiaca porucha</div>
        <input type="text" id="pm-suv-search" class="pm-inp" placeholder="Hľadať podľa ID alebo adresy…">
        <div id="pm-suv-results"></div>
        <div id="pm-suv-selected" class="pm-hint" style="margin-top:3px"></div>
        <div class="pm-sec">Údaje poruchy</div>
        <div class="pm-fgrid" id="pm-porucha-form"></div>
        <div style="margin:4px 0 2px">
          <button class="btn btn-outline btn-xs" id="pm-btn-balicek" type="button">Kto inštaloval balíček?</button>
          <span id="pm-balicek-status" class="pm-hint"></span>
        </div>
        <div class="pm-sec">SPM / ceny / faktúra</div>
        <div class="pm-spm" id="pm-spm-blok">
          <div class="pm-spm-row"><div class="field"><label>SPM zadaný</label><input type="date" id="pm-pf-spm_zadany"></div>
            <label class="pm-chk"><input type="checkbox" id="pm-pf-spm_zadany_neuctuje_sa"> Neúčtuje sa</label></div>
          <div class="pm-spm-row"><div class="field"><label>SPM schválený</label><input type="date" id="pm-pf-spm_schvaleny"></div>
            <label class="pm-chk"><input type="checkbox" id="pm-pf-spm_schvaleny_neuctuje_sa"> Neúčtuje sa</label></div>
          <div class="pm-spm-row"><div class="field"><label>SPM číslo</label><input type="text" id="pm-pf-spm_cislo"></div>
            <label class="pm-chk"><input type="checkbox" id="pm-pf-spm_cislo_neuctuje_sa" disabled title="Odvodené automaticky od SPM zadaný"> Neúčtuje sa</label></div>
          <div class="pm-spm-row"><div class="field"><label>Cena práce (€)</label><input type="number" step="0.01" id="pm-pf-cena_prace"></div>
            <label class="pm-chk"><input type="checkbox" id="pm-pf-cena_prace_neuctuje_sa"> Neúčtuje sa</label></div>
          <div class="pm-spm-row"><div class="field"><label>Cena materiálu (€)</label><input type="number" step="0.01" id="pm-pf-cena_materialu"></div>
            <label class="pm-chk"><input type="checkbox" id="pm-pf-cena_materialu_neuctuje_sa"> Neúčtuje sa</label></div>
          <div class="pm-spm-row"><div class="field"><label>Faktúra</label><select id="pm-pf-faktura_stav">
            <option value="">–</option><option value="Pripravená">Pripravená</option><option value="Odoslaná">Odoslaná</option><option value="Neúčtuje sa">Neúčtuje sa</option></select></div></div>
        </div>
        <div id="pm-stav-warning" class="pm-warn hid"></div>
        <div class="pm-sec">Priradenia technikov</div>
        <div id="pm-prir-list"></div>
        <div class="pm-prir-add" id="pm-prir-add">
          <div class="pm-hint" style="margin-bottom:4px">Pridať technika/technikov (dá sa vybrať viac naraz). 🏖️ = dovolenka v zvolených dňoch (nedá sa priradiť).</div>
          <div class="pm-tech-cbs" id="pm-tech-cbs"></div>
          <div style="display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap">
            <input type="date" id="pm-pr-od" class="pm-inp" style="width:auto" title="Od">
            <input type="date" id="pm-pr-do" class="pm-inp" style="width:auto" title="Do (voliteľné)">
            <button class="btn btn-outline" id="pm-pr-add" type="button">+ Priradiť vybraných</button>
          </div>
        </div>
        <div class="pm-hint" style="margin-top:6px">Rozpísané zmeny sa priebežne ukladajú aj lokálne v prehliadači – ak vypadne pripojenie, o dáta neprídeš.</div>
        <div class="pm-factions">
          <button class="btn btn-red" id="pm-f-delete" type="button">Zmazať poruchu</button>
          <button class="btn btn-outline" id="pm-f-close" type="button" style="margin-left:auto">Zavrieť</button>
          <button class="btn btn-green btn-big" id="pm-f-save" type="button">✅ ULOŽIŤ PORUCHU</button>
        </div>
      </div>
      <div class="vdivider" id="pm-vdiv"></div>
      <div class="rp" id="pm-rp">
        <div id="pm-cap-host" class="rp-sec" style="flex:2;min-height:80px"></div>
        <div id="pm-lists" style="flex:2;display:flex;flex-direction:column;min-height:0">
        <div class="rp-sec" style="flex:1;min-height:60px">
          <div class="rp-sec-hdr"><span class="rp-title">Otvorené poruchy podľa LT</span>
            <span class="rp-legend" style="font-style:italic">klik = upraviť</span>
            <button class="btn btn-outline btn-xs" id="pm-side-reload" title="Obnoviť">↻</button></div>
          <div id="pm-otv-box" class="pm-mini"></div>
        </div>
        <div class="rp-sec" style="flex:1;min-height:60px">
          <div class="rp-sec-hdr"><span class="rp-title">Posledné zapísané poruchy</span>
            <span class="rp-legend" style="font-style:italic">klik = upraviť</span></div>
          <div id="pm-rec-box" class="pm-mini"></div>
        </div>
        </div>
        <div id="pm-lists-bar" class="pm-lbar" title="Zbaliť / rozbaliť zoznamy porúch"></div>
      </div>
    </div>`;

    // šírka ľavého panelu (ťahanie)
    $('pm-vdiv').addEventListener('mousedown', e => {
      e.preventDefault();
      const lp = $('pm-lp'), x0 = e.clientX, w0 = lp.offsetWidth;
      const mv = ev => { lp.style.width = Math.max(420, Math.min(1000, w0 + ev.clientX - x0)) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });

    const lp = $('pm-lp');
    lp.addEventListener('input', e => { if (e.target.id !== 'pm-paste-input' && e.target.id !== 'pm-suv-search') { F.dirty = true; scheduleDraftSave(); } });
    lp.addEventListener('change', e => { if (e.target.id !== 'pm-suv-search') { F.dirty = true; scheduleDraftSave(); } });
    lp.addEventListener('focusout', e => { if (e.target && e.target.id === 'pm-pf-adresa') checkPodobnaAdresa(); });
    lp.addEventListener('input', e => { if (e.target && e.target.classList.contains('pm-povinne') && String(e.target.value).trim()) e.target.classList.remove('pm-povinne'); });
    lp.addEventListener('input', e => { if (e.target && e.target.id === 'pm-pf-cislo_zakazky') updateCisloZakazkyHighlight(); });

    $('pm-pf-stav').addEventListener('change', handleStavChange);
    let dupT = null;
    $('pm-pf-externe_id').addEventListener('input', e => { clearTimeout(dupT); const v = e.target.value; dupT = setTimeout(() => checkDuplicateExterneId(v), 400); });
    $('pm-pf-spm_zadany_neuctuje_sa').addEventListener('change', e => {
      if (e.target.checked) {
        $('pm-pf-spm_schvaleny_neuctuje_sa').checked = true;
        $('pm-pf-cena_prace_neuctuje_sa').checked = true;
        $('pm-pf-cena_materialu_neuctuje_sa').checked = true;
      }
      updateSpmCisloIndicator();
    });
    let suvT = null;
    $('pm-suv-search').addEventListener('input', () => { clearTimeout(suvT); suvT = setTimeout(hladajSuvisiacu, 300); });
    $('pm-paste-fill').onclick = pasteFill;
    $('pm-btn-balicek').onclick = hladajBalicek;
    $('pm-pr-add').onclick = pridajPriradenia;
    $('pm-pr-od').addEventListener('change', () => { $('pm-pr-od').classList.remove('pm-auto'); oznacDovolenky(); });
    $('pm-pr-do').addEventListener('change', oznacDovolenky);
    $('pm-f-save').onclick = ulozPoruchu;
    $('pm-f-save-top').onclick = ulozPoruchu;
    $('pm-f-close').onclick = () => zavriFormular();
    $('pm-f-close-top').onclick = () => zavriFormular();
    $('pm-f-delete').onclick = zmazPoruchu;
    $('pm-side-reload').onclick = () => { loadBocneZoznamy(); obnovKapacitu(true); };
    $('pm-lists-bar').onclick = () => prepniListy(!listyOtvorene());
    nastavListy();
    ['pm-otv-box', 'pm-rec-box'].forEach(id => $(id).addEventListener('click', e => {
      const r = e.target.closest('[data-id]'); if (r) otvorFormular(Number(r.dataset.id), 'porucha');
    }));
    F.hotovy = true;
  }

  // ── OTVORENIE FORMULÁRA ────────────────────────────────────────────────────
  // id = null → nová porucha; navrat = záložka, kam sa vrátiť po uložení / zatvorení úpravy
  async function otvorFormular(id, navrat, ticho) {
    if (!F.hotovy) return;
    if (F.dirty && !lenCitanie() && !(id && id === F.id)) {
      if (!confirm('Vo formulári máš neuložené zmeny. Zahodiť ich a pokračovať?')) { ukazView('porucha'); return; }
    }
    if (id && id === F.id && !F.dirty) { ukazView('porucha'); return; }
    let data = { stav: 'Otvorená' };
    if (id) {
      try { data = await papi('GET', '/poruchy/' + id); }
      catch (e) { hlas('❌ Poruchu sa nepodarilo načítať: ' + e.message); return; }
    }
    F.id = id || null;
    F.data = id ? data : null;
    F.navrat = id ? (navrat || pmView || 'zoznam') : 'porucha';
    if (F.navrat === 'porucha' && id) F.navrat = 'porucha';
    F.pending = [];
    F.lastAdresa = null;
    F.popisHistory = Array.from(new Set(S.rows.map(r => r.popis).filter(Boolean))).slice(0, 400);

    $('pm-f-title').textContent = id ? `${lenCitanie() ? 'Detail' : 'Úprava'} poruchy ${data.externe_id || '#' + id}` : 'Nová porucha';
    $('pm-f-delete').style.display = (id && !lenCitanie()) ? '' : 'none';
    $('pm-paste-input').value = '';
    $('pm-paste-status').textContent = '';
    $('pm-stav-warning').classList.add('hid');

    $('pm-porucha-form').innerHTML = PORUCHA_FIELDS.filter(f => !SPM_BLOCK_KEYS.has(f.key)).map(f => inputHtmlFor(f, data[f.key])).join('');
    $('pm-pf-stav').value = data.stav || 'Otvorená';
    $('pm-pf-externe_id').value = data.externe_id || '';
    $('pm-dup-warning').classList.add('hid');
    $('pm-pf-externe_id').classList.remove('pm-povinne');

    setDate('spm_zadany', data.spm_zadany); setChk('spm_zadany_neuctuje_sa', data.spm_zadany_neuctuje_sa);
    setDate('spm_schvaleny', data.spm_schvaleny); setChk('spm_schvaleny_neuctuje_sa', data.spm_schvaleny_neuctuje_sa);
    setVal('spm_cislo', data.spm_cislo);
    setVal('cena_prace', data.cena_prace); setChk('cena_prace_neuctuje_sa', data.cena_prace_neuctuje_sa);
    setVal('cena_materialu', data.cena_materialu); setChk('cena_materialu_neuctuje_sa', data.cena_materialu_neuctuje_sa);
    PF('faktura_stav').value = data.faktura_stav || '';
    updateSpmCisloIndicator();
    updateCisloZakazkyHighlight();

    PF('datum_realizacie').addEventListener('input', handleStavChange);
    handleStavChange();

    F.suvisiacaId = data.suvisiaca_porucha_id || null;
    $('pm-suv-search').value = '';
    $('pm-suv-results').innerHTML = '';
    renderSuvisiaca();

    renderTechnikCheckboxes();
    $('pm-pr-od').value = ''; $('pm-pr-od').classList.remove('pm-auto'); $('pm-pr-do').value = '';
    if (id) renderPriradeniaList(data.priradenia || []); else renderPendingList();

    PF('planovany_datum').addEventListener('change', autoFillPrOdFromPlan);
    autoFillPrOdFromPlan();

    // lokálny koncept tej istej poruchy (napr. po výpadku pripojenia)
    try {
      const raw = localStorage.getItem(draftKey());
      if (raw && !lenCitanie()) {
        const d = JSON.parse(raw);
        if (d.poruchaId === (id || null)) {
          if (confirm(`Našiel som neuloženú rozpracovanú zmenu tejto poruchy z ${new Date(d.savedAt).toLocaleString('sk-SK')} (napr. z výpadku pripojenia). Chceš ju obnoviť?`)) {
            applyDraftValues(d.values);
          } else clearDraft();
        }
      }
    } catch (_) {}

    applyReadOnly();
    F.dirty = false;
    nastavTabFormulara();
    if (!ticho) ukazView('porucha');
    $('pm-lp').scrollTop = 0;
  }

  function nastavTabFormulara() {
    const ico = F.id ? (lenCitanie() ? '👁' : '✏️') : '➕';
    const txt = F.id ? (lenCitanie() ? 'Detail poruchy' : 'Úprava poruchy') : 'Nová porucha';
    document.querySelectorAll('#pm-tabbar [data-v="porucha"], #pm-side [data-v="porucha"]').forEach(el => {
      el.textContent = ico + ' ' + txt;
      // vedenie (len čítanie) vidí záložku len pri otvorenom detaile
      el.style.display = (lenCitanie() && !F.id) ? 'none' : '';
    });
  }

  function setDate(k, v) { const el = PF(k); if (el) el.value = v ? String(v).slice(0, 10) : ''; }
  function setChk(k, v) { const el = PF(k); if (el) el.checked = !!v; }
  function setVal(k, v) { const el = PF(k); if (el) el.value = v ?? ''; }

  function applyReadOnly() {
    const ro = lenCitanie();
    $('pm-v-porucha').classList.toggle('pm-readonly', ro);
    document.querySelectorAll('#pm-lp input, #pm-lp select, #pm-lp textarea').forEach(el => {
      if (el.id === 'pm-pf-spm_cislo_neuctuje_sa') return;            // vždy odvodené
      if (ro) el.disabled = true;
    });
    if (!ro) { updateSpmCisloIndicator(); handleStavChange(); }
  }

  // ── STAV ↔ DÁTUM REALIZÁCIE (ako Poruchy Web) ──────────────────────────────
  function handleStavChange() {
    const stav = $('pm-pf-stav').value;
    const realEl = PF('datum_realizacie');
    const w = $('pm-stav-warning');
    if (!realEl) return;
    if (stav === 'Otvorená') {
      realEl.value = '';
      realEl.disabled = true;
      w.classList.add('hid');
    } else if (stav === 'Zrealizovaná' || stav === 'Stornovaná' || stav === 'Provizórna') {
      realEl.disabled = lenCitanie();
      if (!realEl.value) {
        w.textContent = `Stav '${stav}' vyžaduje vyplnený dátum realizácie — bez neho sa porucha neuloží.`;
        w.classList.remove('hid');
      } else w.classList.add('hid');
    } else {
      realEl.disabled = lenCitanie();
      w.classList.add('hid');
    }
  }

  // SPM číslo – neúčtuje sa = len odraz „SPM zadaný – neúčtuje sa“ (nie je v DB)
  function updateSpmCisloIndicator() {
    const n = $('pm-pf-spm_zadany_neuctuje_sa').checked;
    $('pm-pf-spm_cislo_neuctuje_sa').checked = n;
    $('pm-pf-spm_cislo').disabled = n || lenCitanie();
  }
  function updateCisloZakazkyHighlight() {
    const el = PF('cislo_zakazky');
    if (el) el.classList.toggle('pm-zak-prazdna', !el.value.trim());
  }

  // ── DUPLICITA EXTERNÉHO ID ─────────────────────────────────────────────────
  async function checkDuplicateExterneId(val) {
    const w = $('pm-dup-warning');
    const v = String(val || '').trim();
    if (!v) { w.classList.add('hid'); return; }
    try {
      const rows = await papi('GET', '/poruchy?hladat=' + encodeURIComponent(v));
      const m = (rows || []).find(r => (r.externe_id || '').trim().toLowerCase() === v.toLowerCase() && r.id !== F.id);
      if (m) {
        w.textContent = `⚠ Porucha s ID '${v}' už v systéme existuje (stav: ${m.stav}, adresa: ${m.adresa || '-'}). Skontroluj, či nejde o duplicitu.`;
        w.classList.remove('hid');
      } else w.classList.add('hid');
    } catch (_) {}
  }

  // ── PODOBNÁ ADRESA (len pri novej poruche) ─────────────────────────────────
  async function checkPodobnaAdresa() {
    if (F.id) return;
    const el = PF('adresa');
    if (!el) return;
    const adresa = el.value.trim();
    if (adresa.length < 4 || adresa === F.lastAdresa) return;
    F.lastAdresa = adresa;
    let m;
    try { m = await papi('GET', '/poruchy/podobne?' + new URLSearchParams({ adresa }).toString()); } catch (_) { return; }
    if (m && m.length) showPodobnaAdresa(m);
  }
  function showPodobnaAdresa(matches) {
    const zoznam = `<p style="margin-bottom:10px">Na tejto (alebo veľmi podobnej) adrese sme už niečo riešili:</p>
      <div class="pm-cards">${matches.map(m => `<div class="pm-cardi"><span><b>${esc(m.externe_id || ('#' + m.id))}</b> — ${fmtDateTime(m.datum_realizacie || m.planovany_datum || m.datum_zadania)} (${esc(m.stav)})<br>
        <span class="pm-hint">${esc(m.adresa)}</span></span><button class="btn btn-outline btn-xs" data-pa="${Number(m.id)}" type="button">Zobraziť</button></div>`).join('')}</div>`;
    const box = modal('Podobná adresa', zoznam);
    box.addEventListener('click', async e => {
      const b = e.target.closest('[data-pa]');
      if (!b) return;
      let d;
      try { d = await papi('GET', '/poruchy/' + b.dataset.pa); } catch (er) { hlas('❌ ' + er.message); return; }
      box.querySelector('.pm-mbody').innerHTML = `<div style="line-height:1.8">
        <div><b>${esc(d.externe_id || ('#' + d.id))}</b> — ${esc(d.stav)}</div>
        <div><b>Adresa:</b> ${esc(d.adresa || '')}</div><div><b>Meno/Subjekt:</b> ${esc(d.meno_subjekt || '')}</div>
        <div><b>Zadané:</b> ${fmtDateTime(d.datum_zadania)}</div><div><b>Realizácia:</b> ${fmtDateTime(d.datum_realizacie)}</div>
        <div><b>Popis:</b> ${esc(d.popis || '')}</div><div><b>Poznámka:</b> ${esc(d.poznamka || '')}</div></div>
        <button class="btn btn-outline btn-xs" type="button" data-back style="margin-top:10px">« Späť na zoznam</button>`;
      box.querySelector('[data-back]').onclick = () => { box.querySelector('.pm-mbody').innerHTML = zoznam; };
    });
  }

  // ── KTO INŠTALOVAL BALÍČEK ─────────────────────────────────────────────────
  async function hladajBalicek() {
    const adresa = (PF('adresa')?.value || '').trim();
    const meno = (PF('meno_subjekt')?.value || '').trim();
    const st = $('pm-balicek-status');
    if (adresa.length < 4) { hlas('Najprv vyplň adresu (aspoň 4 znaky) – podľa nej sa vyhľadáva.'); return; }
    st.textContent = 'Hľadám…';
    let odp;
    try {
      const p = new URLSearchParams({ adresa });
      if (meno) p.set('meno', meno);
      odp = await papi('GET', '/balicky/vyhladaj?' + p.toString());
    } catch (e) { st.textContent = ''; hlas('❌ Vyhľadávanie zlyhalo: ' + e.message); return; }
    st.textContent = '';
    const vys = (odp && odp.vysledky) || [], chyba = odp && odp.zdroj_zivy_chyba;
    const karta = (v, presna) => `<div class="pm-cardi" style="align-items:flex-start;${presna ? 'border-left:4px solid #16a34a;background:#f0fdf4' : 'border-left:4px solid var(--border)'}">
      <span style="line-height:1.7"><b>${esc(v.id_balicka || '–')}</b>${v.typ ? ' · ' + esc(v.typ) : ''}${v.balik ? ' / ' + esc(v.balik) : ''}<br>
      ${esc(v.adresa || '')}<br><span class="pm-hint">${esc(v.meno || '–')}</span><br>
      Zadané: ${v.datum_zadania ? fmtDate(v.datum_zadania) : '–'} · Realizované: ${v.datum_realizacie ? fmtDate(v.datum_realizacie) : '–'}<br>
      <b>Technik(i):</b> ${v.technici && v.technici.length ? esc(v.technici.join(', ')) : '–'}</span></div>`;
    let html = chyba ? `<div class="pm-warn" style="margin-bottom:12px">⚠️ ${esc(chyba)}<br><b>Výsledok nižšie preveruje len archívne dáta – aktuálny Dispečing balíčkov sa neprehľadal.</b></div>` : '';
    if (!vys.length) {
      html += `<p class="pm-hint">Na tejto adrese sa nenašla žiadna evidovaná inštalácia balíčka${chyba ? ' v archíve' : ' (ani v archíve, ani v aktuálnom Dispečingu balíčkov)'}.</p>`;
    } else {
      const presne = vys.filter(v => v.zhoda_adresa >= 0.999), podobne = vys.filter(v => v.zhoda_adresa < 0.999);
      if (presne.length) html += `<p style="font-weight:600;color:#16a34a;margin:0 0 6px">Presná zhoda adresy</p><div class="pm-cards">${presne.map(v => karta(v, true)).join('')}</div>`;
      if (podobne.length) html += `<p style="font-weight:600;color:var(--muted);margin:${presne.length ? '16px' : '0'} 0 6px">Podobné adresy (nie presná zhoda)</p><div class="pm-cards">${podobne.map(v => karta(v, false)).join('')}</div>`;
    }
    modal('Kto inštaloval balíček', html, 560);
  }

  // ── SÚVISIACA PORUCHA ──────────────────────────────────────────────────────
  async function renderSuvisiaca() {
    const el = $('pm-suv-selected');
    if (!F.suvisiacaId) { el.textContent = 'Žiadna súvisiaca porucha.'; return; }
    const id = F.suvisiacaId;
    try {
      const p = await papi('GET', '/poruchy/' + id);
      if (F.suvisiacaId !== id) return;
      el.innerHTML = `Súvisí s: <b>${esc(p.externe_id || ('#' + p.id))}</b> — ${esc(p.adresa || '')}
        <button type="button" class="btn btn-outline btn-xs pm-edit" id="pm-suv-clear" style="margin-left:6px">Odobrať</button>`;
      $('pm-suv-clear').onclick = () => { F.suvisiacaId = null; F.dirty = true; renderSuvisiaca(); };
    } catch (e) { el.textContent = 'Súvisiacu poruchu (ID ' + id + ') sa nepodarilo načítať.'; }
  }
  async function hladajSuvisiacu() {
    const q = $('pm-suv-search').value.trim();
    const res = $('pm-suv-results');
    if (!q) { res.innerHTML = ''; return; }
    try {
      const rows = await papi('GET', '/poruchy?hladat=' + encodeURIComponent(q) + '&limit=8');
      const f = (rows || []).filter(r => r.id !== F.id);
      if (!f.length) { res.innerHTML = '<div class="pm-hint">Nič nenájdené.</div>'; return; }
      res.innerHTML = f.map(r => `<div class="pm-pick" data-pick="${Number(r.id)}"><b>${esc(r.externe_id || ('#' + r.id))}</b> — ${esc(r.adresa || '')} <i>(${esc(r.stav)})</i></div>`).join('');
      res.querySelectorAll('[data-pick]').forEach(x => x.onclick = () => {
        F.suvisiacaId = Number(x.dataset.pick); F.dirty = true;
        $('pm-suv-search').value = ''; res.innerHTML = ''; renderSuvisiaca();
      });
    } catch (_) {}
  }

  // ── DOVOLENKA TECHNIKA (rovnaké pravidlo ako Balíčky: technikMaDovolenkuVDen) ──
  // Väzba: technici.dispecing_user_id (Poruchy) = users.id (Dispečing, /api/technici/detail).
  function dispMeno(technikId) {
    const t = S.technici.find(x => Number(x.id) === Number(technikId));
    if (!t || !t.dispecing_user_id || typeof TECHNICI_DETAIL === 'undefined') return null;
    for (const m in TECHNICI_DETAIL) if (Number(TECHNICI_DETAIL[m].id) === Number(t.dispecing_user_id)) return m;
    return null;
  }
  function dovolenkaDni(technikId, od, doo) {
    if (!od || typeof technikMaDovolenkuVDen !== 'function') return [];
    const m = dispMeno(technikId);
    if (!m) return [];
    const out = [];
    let d = od;
    const koniec = (doo && doo >= od) ? doo : od;
    for (let i = 0; i < 400 && d <= koniec; i++) { if (technikMaDovolenkuVDen(m, d)) out.push(d); d = addDaysStr(d, 1); }
    return out;
  }
  function msgDov(meno, dni) {
    const txt = dni.length > 3 ? `${fmtDate(dni[0])} … ${fmtDate(dni[dni.length - 1])} (${dni.length} dní)` : dni.map(fmtDate).join(', ');
    return `⛔ Technik ${meno} má dovolenku – nie je možné mu priradiť poruchu na ${txt}.`;
  }

  // ── PRIRADENIA TECHNIKOV ───────────────────────────────────────────────────
  function renderTechnikCheckboxes() {
    const el = $('pm-tech-cbs');
    if (!S.technici.length) { el.innerHTML = '<span class="pm-hint">Zatiaľ žiadni technici.</span>'; return; }
    el.innerHTML = S.technici.map(t => `<label data-tid="${Number(t.id)}"><input type="checkbox" class="pm-tech-cb" value="${Number(t.id)}" data-meno="${esc(t.meno)}"> <span>${esc(t.meno)}</span></label>`).join('');
    oznacDovolenky();
  }
  // Označí (🏖️) a zablokuje technikov, ktorí majú v zvolených dňoch dovolenku
  function oznacDovolenky() {
    const od = $('pm-pr-od').value, doo = $('pm-pr-do').value;
    document.querySelectorAll('#pm-tech-cbs label[data-tid]').forEach(l => {
      const cb = l.querySelector('input');
      const dni = od ? dovolenkaDni(l.dataset.tid, od, doo) : [];
      const dov = dni.length > 0;
      l.classList.toggle('pm-dov', dov);
      l.title = dov ? msgDov(cb.dataset.meno, dni) : '';
      if (dov) cb.checked = false;
      cb.disabled = dov || lenCitanie();
      const sp = l.querySelector('span');
      sp.textContent = (dov ? '🏖️ ' : '') + cb.dataset.meno;
    });
  }
  function renderPendingList() {
    const el = $('pm-prir-list');
    if (!F.pending.length) { el.innerHTML = '<p class="pm-hint">Zatiaľ žiadni priradení technici (priradia sa hneď po uložení poruchy).</p>'; return; }
    el.innerHTML = F.pending.map((p, i) => `<div class="pm-prow"><span class="pm-pinfo"><b>${esc(p.technik_meno)}</b> — ${fmtDate(p.datum_od)} ${p.datum_do ? '→ ' + fmtDate(p.datum_do) : '(bez konca)'} <i>(priradí sa po uložení)</i></span>
      <button class="btn btn-outline btn-xs pm-edit" data-prm="${i}" type="button">Odobrať</button></div>`).join('');
    el.querySelectorAll('[data-prm]').forEach(b => b.onclick = () => { F.pending.splice(Number(b.dataset.prm), 1); renderPendingList(); });
  }
  function renderPriradeniaList(items) {
    const el = $('pm-prir-list');
    if (!items.length) { el.innerHTML = '<p class="pm-hint">Zatiaľ žiadni priradení technici.</p>'; return; }
    el.innerHTML = items.map(p => {
      const aktivny = !p.datum_do || p.datum_do > todayStr();
      const pid = Number(p.id);
      return `<div class="pm-prow"><span class="pm-pinfo"><b>${esc(p.technik_meno)}</b> — ${fmtDate(p.datum_od)} ${p.datum_do ? '→ ' + fmtDate(p.datum_do) : '(aktívny)'}</span>
          ${aktivny ? `<button class="btn btn-outline btn-xs pm-edit" data-pend="${pid}" type="button">Ukončiť dnes</button>` : ''}
          <button class="btn btn-outline btn-xs pm-edit" data-pedit="${pid}" type="button">Upraviť</button>
          <button class="btn btn-red btn-xs pm-edit" data-pdel="${pid}" type="button">Zmazať</button></div>
        <div class="pm-pedit hid" id="pm-pe-${pid}" data-tech="${Number(p.technik_id)}" data-od="${esc(p.datum_od || '')}" data-do="${esc(p.datum_do || '')}">
          <select id="pm-pe-t-${pid}">${S.technici.map(t => `<option value="${Number(t.id)}">${esc(t.meno)}</option>`).join('')}</select>
          <input type="date" id="pm-pe-od-${pid}" value="${esc(p.datum_od || '')}">
          <input type="date" id="pm-pe-do-${pid}" value="${esc(p.datum_do || '')}">
          <button class="btn btn-accent btn-xs" data-psave="${pid}" type="button">Uložiť zmeny</button>
          <button class="btn btn-outline btn-xs" data-pcancel="${pid}" type="button">Zrušiť</button></div>`;
    }).join('');
    items.forEach(p => { const s = $('pm-pe-t-' + Number(p.id)); if (s) s.value = p.technik_id; });
    const box = el;
    box.onclick = async e => {
      const b = e.target.closest('button');
      if (!b || lenCitanie()) return;
      try {
        if (b.dataset.pend) {
          await papi('PATCH', '/priradenia/' + b.dataset.pend, { datum_do: todayStr() });
          await refreshPriradenia();
        } else if (b.dataset.pedit) {
          $('pm-pe-' + b.dataset.pedit).classList.toggle('hid');
        } else if (b.dataset.pcancel) {
          $('pm-pe-' + b.dataset.pcancel).classList.add('hid');
        } else if (b.dataset.pdel) {
          if (!confirm('Naozaj zmazať toto priradenie technika k poruche?')) return;
          await papi('DELETE', '/priradenia/' + b.dataset.pdel);
          await refreshPriradenia();
        } else if (b.dataset.psave) {
          const pid = b.dataset.psave, box2 = $('pm-pe-' + pid);
          const technik_id = Number($('pm-pe-t-' + pid).value);
          const datum_od = $('pm-pe-od-' + pid).value;
          const datum_do = $('pm-pe-do-' + pid).value || null;
          if (datum_do && datum_do < datum_od) { hlas("Dátum 'do' nemôže byť skorší ako dátum 'od'."); return; }
          // Dovolenka: blokuj len pri zmene technika alebo dátumov (ako pri úprave balíčka)
          const zmena = technik_id !== Number(box2.dataset.tech) || datum_od !== box2.dataset.od || (datum_do || '') !== box2.dataset.do;
          const dni = zmena ? dovolenkaDni(technik_id, datum_od, datum_do) : [];
          if (dni.length) { const t = S.technici.find(x => x.id === technik_id); hlas(msgDov(t ? t.meno : 'technik', dni)); return; }
          await papi('PATCH', '/priradenia/' + pid, { technik_id, datum_od, datum_do });
          await refreshPriradenia();
        }
      } catch (er) { hlas('❌ Chyba: ' + er.message); }
    };
  }
  async function refreshPriradenia() {
    const d = await papi('GET', '/poruchy/' + F.id);
    renderPriradeniaList(d.priradenia || []);
    loadPoruchy(true);
    obnovKapacitu(true);
  }
  async function pridajPriradenia() {
    const checked = Array.from(document.querySelectorAll('.pm-tech-cb:checked'));
    const datum_od = $('pm-pr-od').value;
    const datum_do = $('pm-pr-do').value || null;
    if (!checked.length) { hlas('Zaškrtni aspoň jedného technika.'); return; }
    if (!datum_od) { hlas('Vyplň dátum od.'); return; }
    if (datum_do && datum_do < datum_od) { hlas("Dátum 'do' nemôže byť skorší ako dátum 'od'."); return; }
    const dov = checked.map(cb => ({ meno: cb.dataset.meno, dni: dovolenkaDni(cb.value, datum_od, datum_do) })).filter(x => x.dni.length);
    if (dov.length) { hlas(msgDov(dov[0].meno, dov[0].dni)); oznacDovolenky(); return; }
    try {
      const vyt = await papi('GET', '/technici/vytazenost?datum=' + datum_od);
      const pre = checked.map(cb => ({ meno: cb.dataset.meno, rec: (vyt || []).find(v => String(v.id) === String(cb.value)) }))
        .filter(x => x.rec && x.rec.pocet_poruch > 0);
      if (pre.length && !confirm(`Títo technici už majú v tento deň priradené poruchy: ${pre.map(x => `${x.meno} (už ${x.rec.pocet_poruch})`).join(', ')}. Naozaj pokračovať?`)) return;
      if (F.id) {
        for (const cb of checked) await papi('POST', '/priradenia', { porucha_id: F.id, technik_id: Number(cb.value), datum_od, datum_do });
        const d = await papi('GET', '/poruchy/' + F.id);
        renderPriradeniaList(d.priradenia || []);
        loadPoruchy(true);
        obnovKapacitu(true);
      } else {
        checked.forEach(cb => F.pending.push({ technik_id: Number(cb.value), technik_meno: cb.dataset.meno, datum_od, datum_do }));
        renderPendingList();
      }
      document.querySelectorAll('.pm-tech-cb:checked').forEach(cb => { cb.checked = false; });
      $('pm-pr-od').value = ''; $('pm-pr-od').classList.remove('pm-auto'); $('pm-pr-do').value = '';
      oznacDovolenky();
    } catch (e) { hlas('❌ Chyba: ' + e.message); }
  }
  function autoFillPrOdFromPlan() {
    const plan = PF('planovany_datum'), od = $('pm-pr-od');
    if (!plan || !od || !plan.value) return;
    if (!od.value || od.classList.contains('pm-auto')) { od.value = plan.value.slice(0, 10); od.classList.add('pm-auto'); oznacDovolenky(); }
  }

  // ── RÝCHLE VLOŽENIE ZO ST MWF ──────────────────────────────────────────────
  function pasteFill() {
    const lines = $('pm-paste-input').value.split('\n').map(l => l.trim()).filter(l => l !== '');
    const st = $('pm-paste-status');
    if (lines.length < 5) {
      st.style.color = 'var(--red-t)';
      st.textContent = 'Očakávam 5 riadkov: ID, adresa, meno, zadané, LT do (6. riadok popis je nepovinný).';
      return;
    }
    const [idL, adrL, menoL, zadL, ltL] = lines;
    const popisL = lines.length > 5 ? lines.slice(5).join(' ') : null;
    $('pm-pf-externe_id').value = idL;
    if (PF('adresa')) PF('adresa').value = adrL;
    if (PF('meno_subjekt')) PF('meno_subjekt').value = (menoL === '-' ? '' : menoL);
    const zv = parseSkDatetime(zadL); if (PF('datum_zadania') && zv) PF('datum_zadania').value = zv;
    const lv = parseSkDatetime(ltL); if (PF('lt_vybavit_do') && lv) PF('lt_vybavit_do').value = lv;
    if (PF('popis') && popisL) PF('popis').value = popisL;
    F.dirty = true; scheduleDraftSave();
    checkDuplicateExterneId(idL);
    if (adrL) checkPodobnaAdresa();
    st.style.color = 'var(--green-t)';
    st.textContent = popisL ? 'Vyplnené — skontroluj a doplň Dopad/Typ/Médium.' : 'Vyplnené — skontroluj a doplň Dopad/Typ/Médium/Popis.';
  }

  // ── LOKÁLNY KONCEPT (ochrana pri výpadku pripojenia) ───────────────────────
  // Vlastný kľúč (oddelene DEV/PROD a používateľ) – starý web má „poruchy_draft_v1“.
  function draftKey() {
    const e = (typeof currentUser !== 'undefined' && currentUser && currentUser.email) || '';
    return 'pm_draft_v1_' + (PORUCHY_API_URL.includes('-dev') ? 'dev' : 'prod') + '_' + e;
  }
  let draftT = null;
  function collectDraftValues() {
    const v = { stav: $('pm-pf-stav').value, externe_id: $('pm-pf-externe_id').value };
    PORUCHA_FIELDS.forEach(f => { const el = PF(f.key); if (el) v[f.key] = f.type === 'checkbox' ? el.checked : el.value; });
    return v;
  }
  function saveDraftNow() {
    if (lenCitanie() || !F.dirty) return;
    try { localStorage.setItem(draftKey(), JSON.stringify({ poruchaId: F.id || null, savedAt: new Date().toISOString(), values: collectDraftValues() })); } catch (_) {}
  }
  function scheduleDraftSave() { clearTimeout(draftT); draftT = setTimeout(saveDraftNow, 800); }
  function clearDraft() { clearTimeout(draftT); try { localStorage.removeItem(draftKey()); } catch (_) {} }
  function applyDraftValues(values) {
    Object.entries(values || {}).forEach(([k, val]) => {
      const el = PF(k);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!val; else el.value = val ?? '';
    });
    updateSpmCisloIndicator(); updateCisloZakazkyHighlight(); handleStavChange();
  }

  // ── ULOŽENIE (payload identický s Poruchy Web) ─────────────────────────────
  function zostavPayload() {
    const payload = { stav: $('pm-pf-stav').value, externe_id: $('pm-pf-externe_id').value || null };
    PORUCHA_FIELDS.forEach(f => {
      const el = PF(f.key);
      if (!el) return;
      if (f.type === 'checkbox') { payload[f.key] = el.checked; return; }
      if (f.type === 'ciselnik') { payload[f.key] = el.value ? Number(el.value) : null; return; }
      if (f.type === 'number') { payload[f.key] = el.value === '' ? null : Number(el.value); return; }
      if (f.type === 'datetime') { payload[f.key] = el.value ? new Date(el.value).toISOString() : null; return; }
      if (f.type === 'date') { payload[f.key] = el.value || null; return; }
      payload[f.key] = el.value || null;
    });
    if (payload.stav === 'Otvorená') payload.datum_realizacie = null;
    payload.suvisiaca_porucha_id = F.suvisiacaId || null;
    return payload;
  }

  // Povinné: Externé ID + Dátum zadania. Nová porucha vždy; pri úprave staršej poruchy,
  // ktorá ich nemala, sa nevyžadujú (dá sa ďalej upravovať), ale vyplnené sa nedajú vymazať.
  function chybajucePovinne() {
    const ext = $('pm-pf-externe_id'), zad = PF('datum_zadania');
    const nova = !F.data;
    const chyby = [];
    const treba = (el, mal) => nova || !!mal;
    const okExt = !treba(ext, F.data && String(F.data.externe_id || '').trim()) || ext.value.trim() !== '';
    const okZad = !treba(zad, F.data && F.data.datum_zadania) || (zad && zad.value);
    ext.classList.toggle('pm-povinne', !okExt);
    if (zad) zad.classList.toggle('pm-povinne', !okZad);
    if (!okExt) chyby.push('Externé ID');
    if (!okZad) chyby.push('Dátum zadania');
    return chyby;
  }

  async function ulozPoruchu() {
    if (F.saving || lenCitanie()) return;
    const chyby = chybajucePovinne();
    if (chyby.length) {
      hlas(`⚠ Poruchu nemožno uložiť – vyplň: ${chyby.join(' a ')}.`);
      const prve = chyby[0] === 'Externé ID' ? $('pm-pf-externe_id') : PF('datum_zadania');
      if (prve) { prve.scrollIntoView({ block: 'center' }); prve.focus(); }
      return;
    }
    const stav = $('pm-pf-stav').value;
    if ((stav === 'Zrealizovaná' || stav === 'Stornovaná' || stav === 'Provizórna') && !PF('datum_realizacie').value) {
      hlas(`Stav '${stav}' vyžaduje vyplnený dátum realizácie.`);
      $('pm-stav-warning').classList.remove('hid');
      return;
    }
    const payload = zostavPayload();
    F.saving = true;
    const btns = [$('pm-f-save'), $('pm-f-save-top')];
    const lbl = btns.map(b => b.textContent);
    btns.forEach(b => { b.disabled = true; b.textContent = 'Ukladám…'; });
    try {
      let patched = false, nova = !F.data;
      if (F.id) {
        const upd = await papi('PUT', '/poruchy/' + F.id, payload);
        const posunute = F.data ? await posunPriradeniaNaPlan() : 0;
        if (upd && typeof upd === 'object' && 'id' in upd && !F.pending.length && !posunute) patched = tryPatchRowInPlace(upd);
      } else {
        const created = await papi('POST', '/poruchy', payload);
        F.id = created.id;                       // ak by zlyhalo priradenie, ďalšie Uložiť už robí úpravu (nie duplicitu)
      }
      const savedId = F.id;
      // Priradenia novej poruchy (po vytvorení). Pri chybe ostanú v zozname a pri ďalšom Uložiť sa dopíšu.
      while (F.pending.length) {
        const p = F.pending[0];
        await papi('POST', '/priradenia', { porucha_id: savedId, technik_id: p.technik_id, datum_od: p.datum_od, datum_do: p.datum_do });
        F.pending.shift();
      }
      S.lastSavedId = savedId;
      clearDraft();
      F.dirty = false;
      if (!patched) loadPoruchy(true); else applyLastSavedHighlight();
      loadDashboard();
      loadBocneZoznamy();
      obnovKapacitu(true);
      const ext = payload.externe_id ? ' ' + payload.externe_id : '';
      hlas(nova ? `✅ Porucha${ext} zapísaná` : `✅ Porucha${ext} uložená`);
      const navrat = F.navrat;
      await otvorFormular(null);                 // formulár späť na „Nová porucha“
      if (!nova && navrat && navrat !== 'porucha') ukazView(navrat);
    } catch (e) {
      // Zámerne nič nezatvárame – rozpísané dáta ostávajú (aj v lokálnom koncepte)
      if (!F.id || F.pending.length) renderPendingList();
      hlas('❌ Chyba pri ukladaní: ' + e.message + ' – rozpísané dáta zostávajú, skús znova.');
      saveDraftNow();
    } finally {
      F.saving = false;
      btns.forEach((b, i) => { b.disabled = false; b.textContent = lbl[i]; });
    }
  }

  // Zmenil sa plánovaný dátum existujúcej poruchy → ponúkni posun NEUKONČENÝCH priradení technikov
  // na nový deň (kapacita počíta podľa dátumov priradenia, nie podľa plánovaného dátumu).
  // Priradenie s rozsahom od–do sa posunie celé (zachová sa počet dní). Ukončené ostávajú ako história.
  // Vracia počet posunutých priradení.
  async function posunPriradeniaNaPlan() {
    const plan = (PF('planovany_datum')?.value || '').slice(0, 10);
    const povodny = F.data.planovany_datum ? toLocalDatetimeInput(F.data.planovany_datum).slice(0, 10) : '';
    if (!plan || plan === povodny) return 0;
    const d = await papi('GET', '/poruchy/' + F.id);                 // aktuálne priradenia (mohli sa meniť vo formulári)
    const dnes = todayStr();
    const kandidati = (d.priradenia || []).filter(p => (!p.datum_do || p.datum_do > dnes) && p.datum_od !== plan);
    if (!kandidati.length) return 0;
    const dni = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
    const mena = Array.from(new Set(kandidati.map(p => p.technik_meno))).join(', ');
    if (!confirm(`Plánovaný dátum sa zmenil na ${fmtDate(plan)}.\nPosunúť aj priradenia technikov (${mena}) na tento deň?`)) return 0;
    let n = 0;
    const preskoceni = [];
    for (const p of kandidati) {
      const od = plan;
      const doo = p.datum_do ? addDaysStr(plan, dni(p.datum_od, p.datum_do)) : null;
      const dov = dovolenkaDni(p.technik_id, od, doo);
      if (dov.length) { preskoceni.push(msgDov(p.technik_meno, dov)); continue; }
      await papi('PATCH', '/priradenia/' + p.id, { datum_od: od, datum_do: doo });
      n++;
    }
    if (preskoceni.length) setTimeout(() => hlas(preskoceni.join(' ') + ' (priradenie ostalo bez zmeny)'), 3200);
    return n;
  }

  async function zavriFormular() {
    if (F.dirty && !lenCitanie() && !confirm('Zahodiť neuložené zmeny vo formulári?')) return;
    const navrat = F.id ? F.navrat : null;
    clearDraft();
    F.dirty = false;
    if (lenCitanie()) { F.id = null; F.data = null; nastavTabFormulara(); ukazView(navrat && navrat !== 'porucha' ? navrat : 'zoznam'); return; }
    await otvorFormular(null);
    if (navrat && navrat !== 'porucha') ukazView(navrat);
  }

  async function zmazPoruchu() {
    if (!F.id || lenCitanie()) return;
    if (!confirm('Naozaj natrvalo zmazať túto poruchu? Táto akcia sa nedá vrátiť späť.')) return;
    try {
      await papi('DELETE', '/poruchy/' + F.id);
      const navrat = F.navrat;
      clearDraft(); F.dirty = false;
      hlas('🗑 Porucha zmazaná');
      loadPoruchy(true); loadDashboard(); loadBocneZoznamy(); obnovKapacitu(true);
      await otvorFormular(null);
      if (navrat && navrat !== 'porucha') ukazView(navrat);
    } catch (e) { hlas('❌ Chyba pri mazaní: ' + e.message); }
  }

  // ── MODÁLNE OKNO (podobná adresa, balíček) ─────────────────────────────────
  function modal(titul, html, sirka) {
    const ov = document.createElement('div');
    ov.className = 'pm-ov';
    ov.innerHTML = `<div class="pm-mbox" style="width:${sirka || 480}px"><div class="pm-mhdr"><b>${esc(titul)}</b><button class="btn btn-outline btn-xs" data-x type="button">✕ Zavrieť</button></div><div class="pm-mbody">${html}</div></div>`;
    const zavri = () => { ov.remove(); document.removeEventListener('keydown', esc_); };
    const esc_ = e => { if (e.key === 'Escape') zavri(); };
    ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-x]')) zavri(); });
    document.addEventListener('keydown', esc_);
    document.body.appendChild(ov);
    return ov.querySelector('.pm-mbox');
  }

  // ── PRAVÝ PANEL: spoločná kapacita + otvorené + posledné zapísané ──────────
  // Sekcia „Kapacita technikov“ z Balíčkov (#rp0) sa v režime Poruchy PRESUNIE sem
  // (rovnaký DOM, rovnaké funkcie refreshCap/loadPoruchyKapacita) a pri návrate do Balíčkov späť.
  function presunKapacitu(doPoruch) {
    const rp0 = document.getElementById('rp0');
    const host = $('pm-cap-host');
    if (!rp0 || !host) return;
    if (doPoruch) {
      if (rp0.parentNode !== host) { host.appendChild(rp0); rp0.dataset.pmFlex = rp0.style.flex; rp0.style.flex = '1'; rp0.style.height = ''; }
      if (typeof refreshCap === 'function') { try { refreshCap(); } catch (_) {} }
    } else {
      const rph0 = document.getElementById('rph0');
      if (rph0 && rp0.parentNode === host) { rph0.parentNode.insertBefore(rp0, rph0); rp0.style.flex = rp0.dataset.pmFlex || '2'; }
    }
  }
  function obnovKapacitu(force) {
    if (typeof loadPoruchyKapacita !== 'function') return;
    loadPoruchyKapacita(!!force, !!force).then(z => { if (typeof refreshCap === 'function' && document.getElementById('cap-wrap')) { try { refreshCap(); } catch (_) {} } }).catch(() => {});
  }
  function miniRow(r, extra) {
    return `<div class="pm-mrow ${rowStavClass(r)}" data-id="${Number(r.id)}" title="${esc(r.popis || '')}">
      <span class="pm-mid">${esc(r.externe_id || ('#' + r.id))}</span><span class="pm-madr">${esc(r.adresa || '')}</span>${extra}</div>`;
  }
  // Zoznamy vpravo (otvorené + posledné) – zbaliteľné do lišty na spodku; voľbu si pamätá prehliadač.
  // Predvolene ZBALENÉ – celá pravá časť patrí kapacite technikov.
  function listyKluc() {
    const e = (typeof currentUser !== 'undefined' && currentUser && currentUser.email) || '';
    return 'pm_zoznamy_vpravo_' + e;
  }
  function listyOtvorene() { try { return localStorage.getItem(listyKluc()) === '1'; } catch (_) { return false; } }
  function nastavListy() {
    const box = $('pm-lists'), bar = $('pm-lists-bar');
    if (!box || !bar) return;
    const o = listyOtvorene();
    box.style.display = o ? 'flex' : 'none';
    const n = S.dash && S.dash.otvorene != null ? S.dash.otvorene : '–';
    bar.innerHTML = o ? '▾ Skryť zoznamy porúch (celá výška pre kapacitu technikov)'
      : `▴ Otvorené poruchy podľa LT <b>(${esc(n)})</b> · Posledné zapísané — klik = zobraziť`;
  }
  function prepniListy(otvorit) {
    try { localStorage.setItem(listyKluc(), otvorit ? '1' : '0'); } catch (_) {}
    nastavListy();
    if (otvorit) { bocneAt = Date.now(); loadBocneZoznamy(); }
  }
  async function loadBocneZoznamy() {
    const otv = $('pm-otv-box'), rec = $('pm-rec-box');
    if (!otv || !listyOtvorene()) return;
    try {
      const [o, r] = await Promise.all([
        papi('GET', '/poruchy?rychly=otvorene&sort=lt_asc'),
        papi('GET', '/poruchy?zadanie_od=' + addDaysStr(todayStr(), -45)),
      ]);
      otv.innerHTML = (o || []).length ? o.map(x => miniRow(x, `<span class="pm-mlt">${fmtDateTime(x.lt_vybavit_do)}</span>${ltHoursCell(x)}<span class="pm-mtech">${esc(x.technici_aktivni || '—')}</span>`)).join('')
        : '<div class="pm-hint" style="padding:8px">Žiadne otvorené poruchy.</div>';
      const posl = (r || []).slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || b.id - a.id).slice(0, 10);
      rec.innerHTML = posl.length ? posl.map(x => miniRow(x, `<span class="pm-mlt">${esc(x.stav)}</span><span class="pm-mtech">${x.created_at ? fmtDateTime(x.created_at) : ''}</span>`)).join('')
        : '<div class="pm-hint" style="padding:8px">Žiadne záznamy.</div>';
    } catch (e) {
      otv.innerHTML = `<div class="pm-err" style="padding:8px">${esc(e.message)}</div>`;
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
    if (lenCitanie()) {
      pmView = 'zoznam';
      document.querySelectorAll('#pm-tabbar [data-v="porucha"], #pm-side [data-v="porucha"]').forEach(el => { el.style.display = 'none'; });
    }

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
    _test: { S, F, buildParams, tryPatchRowInPlace, loadPoruchy, applyQuickFilter, otvorFormular, zostavPayload, dovolenkaDni },
  };
})();
