/*
  Schulferien-Heatmaps (2026–2028) – statische JSON-Version

  Neu:
  - JSON-Schema unterstützt Feiertage:
      * feiertage.bundesweit[]
      * feiertage.regional.<bundesland>[]
      * optional auch in states[].type="feiertag"
  - Regionale Feiertage zählen wie ein Ferientag (für das jeweilige Bundesland)
  - Feiertage des ausgewählten Bundeslandes werden zusätzlich rot schraffiert
  - Jahreszahl (144px) ist dauerhaft sichtbar (wird nur ausgeblendet, wenn zu wenig Platz)
*/

(() => {
  'use strict';

  const YEARS = [2026, 2027, 2028];

  const STATES = [
    { code: 'bw', name: 'Baden-Württemberg' },
    { code: 'by', name: 'Bayern' },
    { code: 'be', name: 'Berlin' },
    { code: 'bb', name: 'Brandenburg' },
    { code: 'hb', name: 'Bremen' },
    { code: 'hh', name: 'Hamburg' },
    { code: 'he', name: 'Hessen' },
    { code: 'mv', name: 'Mecklenburg-Vorpommern' },
    { code: 'ni', name: 'Niedersachsen' },
    { code: 'nw', name: 'Nordrhein-Westfalen' },
    { code: 'rp', name: 'Rheinland-Pfalz' },
    { code: 'sl', name: 'Saarland' },
    { code: 'sn', name: 'Sachsen' },
    { code: 'st', name: 'Sachsen-Anhalt' },
    { code: 'sh', name: 'Schleswig-Holstein' },
    { code: 'th', name: 'Thüringen' }
  ];

  // --- DOM ---
  const stateSelect = document.getElementById('stateSelect');
  const stateCheckboxes = document.getElementById('stateCheckboxes');
  const heatmapsWrap = document.getElementById('heatmapsWrap');
  const legendEl = document.getElementById('legend');
  const statusEl = document.getElementById('status');
  const tooltipEl = document.getElementById('tooltip');
  const chipIncluded = document.getElementById('chipIncluded');
  const chipSelected = document.getElementById('chipSelected');
  const chipScale = document.getElementById('chipScale');
  const summaryEl = document.getElementById('summary');

  const showDetailsBtn = document.getElementById('showDetailsBtn');
  const selectAllBtn = document.getElementById('selectAllBtn');
  const selectNoneBtn = document.getElementById('selectNoneBtn');
  const reloadBtn = document.getElementById('reloadBtn');

  const modalBackdrop = document.getElementById('modalBackdrop');
  const modalClose = document.getElementById('modalClose');
  const modalOk = document.getElementById('modalOk');
  const modalTitle = document.getElementById('modalTitle');
  const modalMeta = document.getElementById('modalMeta');
  const modalBody = document.getElementById('modalBody');

  const CONFIG = {
    tooltipOffset: 14,
    inclusiveEnd: true,
    defaultIncluded: new Set(STATES.map(s => s.code)),
    defaultSelected: 'be'
  };

  // --- Data provider ---
  const DATA_PROVIDER = {
    async fetchYear(year) {
      const url = `./data/holidays-${encodeURIComponent(year)}.json`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Datei konnte nicht geladen werden: ${url} (${res.status} ${res.statusText}) ${txt}`);
      }
      const data = await res.json();
      if (!data || typeof data !== 'object' || !data.states || typeof data.states !== 'object') {
        throw new Error(`Ungültiges JSON-Format in ${url}. Erwartet: { meta, states }.`);
      }
      console.info('[Daten geladen]', url);
      return { year, data };
    },

    normalizeStateArray(arr) {
      if (!Array.isArray(arr)) return [];
      return arr
        .map(item => ({
          type: item.type ?? 'ferien',
          scope: item.scope ?? 'regional',
          name: item.name ?? 'Ferien',
          start: item.start,
          end: item.end
        }))
        .filter(x => x.name && x.start && x.end);
    },

    normalizeHolidayArray(arr) {
      if (!Array.isArray(arr)) return [];
      return arr
        .map(item => ({
          type: 'feiertag',
          name: item.name ?? 'Feiertag',
          date: item.date
        }))
        .filter(x => x.name && x.date);
    }
  };

  const appState = {
    selected: CONFIG.defaultSelected,
    included: new Set(CONFIG.defaultIncluded),

    // per year
    eventsByYear: new Map(),     // year -> Map(stateCode -> events[] (ferien + states-feiertag))
    holidaysByYear: new Map(),   // year -> { bundesweit: Map(date->names[]), regional: Map(state->Map(date->names[])) }
    dayMapByYear: new Map(),     // year -> Map(dateIso -> slot)

    globalMaxOverlap: 0,
    totalEventsByYear: new Map(),
    renderTargets: new Map()
  };

  // --- Utils ---
  const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  function isoDate(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function parseIso(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, (m - 1), d);
  }

  function addDays(d, days) {
    const x = new Date(d);
    x.setDate(x.getDate() + days);
    return x;
  }

  function startOfWeekMonday(d) {
    const x = new Date(d);
    const day = x.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    x.setDate(x.getDate() + diff);
    x.setHours(0,0,0,0);
    return x;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function stateName(code) {
    return STATES.find(s => s.code === code)?.name ?? code;
  }

  function formatDate(iso) {
    const d = parseIso(iso);
    return d.toLocaleDateString('de-DE', { weekday: 'short', year: 'numeric', month: 'short', day: '2-digit' });
  }

  function monthShort(monthIndex) {
    const d = new Date(2020, monthIndex, 1);
    return d.toLocaleDateString('de-DE', { month: 'short' });
  }

  function setStatus(msg, kind = 'info') {
    const icon = kind === 'error' ? '⚠️' : kind === 'ok' ? '✅' : 'ℹ️';
    statusEl.innerHTML = `<strong>${icon}</strong>&nbsp;${escapeHtml(msg)}`;
  }

  // --- Color scale ---
  function colorForCount(count, max, palette, isWeekend) {
    if (!max || max <= 0) return 'rgba(255,255,255,0.03)';

    const ratio = clamp(count / max, 0, 1);

    let h, sMin, sMax, lMin, lMax;
    if (palette === 'yellow') {
      h = 46;
      sMin = 78;
      sMax = 92;
      lMin = 22;
      lMax = 62;
    } else {
      h = 217;
      sMin = 48;
      sMax = 72;
      lMin = 16;
      lMax = 56;
    }

    let s = sMin + (sMax - sMin) * ratio;
    let l = lMin + (lMax - lMin) * ratio;

    if (isWeekend) {
      s = clamp(s * 1.08, 0, 100);
      l = clamp(l + 1.2, 0, 100);
    }

    if (count === 0) {
      if (palette === 'yellow') return 'hsl(46, 42%, 20%)';
      return 'rgba(255,255,255,0.03)';
    }

    return `hsl(${h}, ${s.toFixed(1)}%, ${l.toFixed(1)}%)`;
  }

  // --- Fallback: bundesweite Feiertage berechnen ---
  function computeEasterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
  }

  function computeStandardBundesweit(year) {
    const map = new Map();
    const add = (d, name) => map.set(isoDate(d), [name]);

    add(new Date(year, 0, 1), 'Neujahr');
    add(new Date(year, 4, 1), 'Tag der Arbeit');
    add(new Date(year, 9, 3), 'Tag der Deutschen Einheit');
    add(new Date(year, 11, 25), '1. Weihnachtstag');
    add(new Date(year, 11, 26), '2. Weihnachtstag');

    const easter = computeEasterSunday(year);
    add(addDays(easter, -2), 'Karfreitag');
    add(addDays(easter, 1), 'Ostermontag');
    add(addDays(easter, 39), 'Christi Himmelfahrt');
    add(addDays(easter, 50), 'Pfingstmontag');

    return map;
  }

  // --- UI init ---
  function initStateSelect() {
    stateSelect.innerHTML = STATES.map(s => `<option value="${s.code}">${escapeHtml(s.name)}</option>`).join('');
    stateSelect.value = appState.selected;

    stateSelect.addEventListener('change', () => {
      appState.selected = stateSelect.value;
      chipSelected.textContent = `Ausgewählt: ${stateName(appState.selected)}`;
      rebuildAllDayMaps();
      renderLegend();
      renderAllHeatmaps();
    });

    showDetailsBtn.addEventListener('click', openModalForSelected);
  }

  function initCheckboxes() {
    stateCheckboxes.innerHTML = '';

    for (const s of STATES) {
      const row = document.createElement('div');
      row.className = 'cb';

      const left = document.createElement('div');
      left.style.display = 'grid';
      left.style.gap = '1px';

      const label = document.createElement('label');
      label.textContent = s.name;
      label.setAttribute('for', `cb-${s.code}`);

      const small = document.createElement('small');
      small.textContent = s.code.toUpperCase();

      left.appendChild(label);
      left.appendChild(small);

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `cb-${s.code}`;
      cb.checked = appState.included.has(s.code);
      cb.addEventListener('change', () => {
        if (cb.checked) appState.included.add(s.code);
        else appState.included.delete(s.code);

        chipIncluded.textContent = `Einbezogen: ${appState.included.size} / ${STATES.length}`;
        rebuildAllDayMaps();
        renderLegend();
        renderAllHeatmaps();
      });

      row.appendChild(left);
      row.appendChild(cb);
      stateCheckboxes.appendChild(row);
    }

    selectAllBtn.addEventListener('click', () => {
      appState.included = new Set(STATES.map(s => s.code));
      syncCheckboxes();
      rebuildAllDayMaps();
      renderLegend();
      renderAllHeatmaps();
    });

    selectNoneBtn.addEventListener('click', () => {
      appState.included = new Set();
      syncCheckboxes();
      rebuildAllDayMaps();
      renderLegend();
      renderAllHeatmaps();
    });

    reloadBtn.addEventListener('click', reloadAll);

    chipIncluded.textContent = `Einbezogen: ${appState.included.size} / ${STATES.length}`;
    chipSelected.textContent = `Ausgewählt: ${stateName(appState.selected)}`;
  }

  function syncCheckboxes() {
    for (const s of STATES) {
      const cb = document.getElementById(`cb-${s.code}`);
      if (cb) cb.checked = appState.included.has(s.code);
    }
    chipIncluded.textContent = `Einbezogen: ${appState.included.size} / ${STATES.length}`;
  }

  // --- Modal ---
  function openModal(title, meta, bodyHtml) {
    modalTitle.textContent = title;
    modalMeta.textContent = meta;
    modalBody.innerHTML = bodyHtml;
    modalBackdrop.classList.add('open');
    modalBackdrop.setAttribute('aria-hidden', 'false');
    modalOk.focus();
  }

  function closeModal() {
    modalBackdrop.classList.remove('open');
    modalBackdrop.setAttribute('aria-hidden', 'true');
  }

  modalClose.addEventListener('click', closeModal);
  modalOk.addEventListener('click', closeModal);
  modalBackdrop.addEventListener('click', (e) => {
    if (e.target === modalBackdrop) closeModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalBackdrop.classList.contains('open')) closeModal();
  });

  function openModalForSelected() {
    const code = appState.selected;

    const blocks = YEARS.map(year => {
      const events = appState.eventsByYear.get(year)?.get(code) ?? [];
      const ferien = events.filter(e => (e.type ?? 'ferien') === 'ferien');

      const hol = appState.holidaysByYear.get(year);
      const bundesweit = Array.from(hol?.bundesweit.entries() ?? [])
        .flatMap(([date, names]) => names.map(n => ({ date, name: n, scope: 'bundesweit' })));

      const regionalMap = hol?.regional.get(code) ?? new Map();
      const regional = Array.from(regionalMap.entries())
        .flatMap(([date, names]) => names.map(n => ({ date, name: n, scope: 'regional' })));

      const fromEvents = events
        .filter(e => e.type === 'feiertag')
        .map(e => ({ date: e.start, name: e.name, scope: e.scope ?? 'regional' }));

      const feiertage = [...bundesweit, ...regional, ...fromEvents]
        .filter(x => x.date)
        .sort((a,b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

      const ferienCards = ferien
        .slice()
        .sort((a,b) => a.start.localeCompare(b.start))
        .map(h => {
          const n = escapeHtml(h.name);
          const range = `${escapeHtml(h.start)} → ${escapeHtml(h.end)}`;
          const days = countDaysInclusive(h.start, h.end);
          return `
            <div class="holidayCard">
              <div class="name">${n}</div>
              <div class="range">${range} <span class="muted">(${days} Tage)</span></div>
            </div>
          `;
        })
        .join('');

      const feiertagCards = feiertage
        .map(h => {
          const tag = h.scope === 'bundesweit' ? 'bundesweit' : 'regional';
          return `
            <div class="holidayCard">
              <div class="name">${escapeHtml(h.name)} <span class="muted">(${tag})</span></div>
              <div class="range">${escapeHtml(h.date)}</div>
            </div>
          `;
        })
        .join('');

      return `
        <div>
          <div class="sectionTitle">${year} – Ferien (${ferien.length})</div>
          ${ferienCards || `<div class="holidayCard"><div class="name">Keine Daten</div><div class="range muted">Keine Ferienzeiträume im JSON für ${year}.</div></div>`}

          <div class="sectionTitle">${year} – Feiertage (${feiertage.length})</div>
          ${feiertagCards || `<div class="holidayCard"><div class="name">Keine Daten</div><div class="range muted">Keine Feiertage im JSON/Regelwerk.</div></div>`}
        </div>
      `;
    }).join('');

    const meta = `Ausgewähltes Bundesland: ${stateName(code)} • Jahre: ${YEARS.join(', ')}`;
    openModal(`${stateName(code)} – Details`, meta, blocks);
  }

  function countDaysInclusive(startIso, endIso) {
    const s = parseIso(startIso);
    const e = parseIso(endIso);
    const days = Math.floor((e - s) / 86400000) + 1;
    return Math.max(1, days);
  }

  // --- Loading ---
  async function reloadAll() {
    hideTooltip(true);
    setStatus('Lade lokale Daten …');

    try {
      const results = await Promise.all(YEARS.map(y => DATA_PROVIDER.fetchYear(y)));

      appState.eventsByYear = new Map();
      appState.holidaysByYear = new Map();
      appState.totalEventsByYear = new Map();

      for (const { year, data } of results) {
        // states events
        const stateMap = new Map();
        let totalEvents = 0;
        for (const { code } of STATES) {
          const arr = data.states?.[code] ?? [];
          const normalized = DATA_PROVIDER.normalizeStateArray(arr);
          stateMap.set(code, normalized);
          totalEvents += normalized.length;
        }
        appState.eventsByYear.set(year, stateMap);
        appState.totalEventsByYear.set(year, totalEvents);

        // feiertage from JSON
        const bundesweitArr = DATA_PROVIDER.normalizeHolidayArray(data.feiertage?.bundesweit ?? []);
        const bundesweitMap = new Map();
        for (const h of bundesweitArr) {
          if (!bundesweitMap.has(h.date)) bundesweitMap.set(h.date, []);
          bundesweitMap.get(h.date).push(h.name);
        }

        const regionalObj = data.feiertage?.regional ?? {};
        const regionalMap = new Map();
        for (const { code } of STATES) {
          const arr = DATA_PROVIDER.normalizeHolidayArray(regionalObj?.[code] ?? []);
          const map = new Map();
          for (const h of arr) {
            if (!map.has(h.date)) map.set(h.date, []);
            map.get(h.date).push(h.name);
          }
          regionalMap.set(code, map);
        }

        // fallback: if no bundesweit provided, compute default
        if (bundesweitMap.size === 0) {
          const computed = computeStandardBundesweit(year);
          for (const [date, names] of computed.entries()) {
            bundesweitMap.set(date, names);
          }
        }

        appState.holidaysByYear.set(year, { bundesweit: bundesweitMap, regional: regionalMap });
      }

      rebuildAllDayMaps();
      renderLegend();
      renderAllHeatmaps();
      updateSummary();

      setStatus('Daten geladen.', 'ok');

    } catch (e) {
      console.error(e);
      setStatus(`Konnte lokale Daten nicht laden: ${e.message}.`, 'error');
    }
  }

  function updateSummary() {
    const parts = YEARS.map(y => {
      const ev = appState.totalEventsByYear.get(y) ?? 0;
      const hol = appState.holidaysByYear.get(y);
      const b = hol?.bundesweit.size ?? 0;
      const r = Array.from(hol?.regional.values() ?? []).reduce((acc, m) => acc + (m?.size ?? 0), 0);
      return `${y}: ${ev} Ereignisse, ${b} bundesw. Feiertage, ${r} regionale Feiertage`;
    });
    summaryEl.textContent = parts.join(' • ');
  }

  // --- Day maps ---
  function rebuildAllDayMaps() {
    appState.dayMapByYear = new Map();

    let globalMax = 0;

    for (const year of YEARS) {
      const dayMap = buildDayMapForYear(year);
      appState.dayMapByYear.set(year, dayMap);

      let maxOverlap = 0;
      for (const slot of dayMap.values()) maxOverlap = Math.max(maxOverlap, slot.states.size);
      globalMax = Math.max(globalMax, maxOverlap);
    }

    appState.globalMaxOverlap = globalMax;
    chipScale.textContent = `Skala: 0 → ${globalMax}`;
  }

  function buildDayMapForYear(year) {
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);

    const holidays = appState.holidaysByYear.get(year) ?? { bundesweit: new Map(), regional: new Map() };
    const eventsByState = appState.eventsByYear.get(year) ?? new Map();

    const dayMap = new Map();
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
      const key = isoDate(d);
      dayMap.set(key, {
        states: new Set(),
        holidayNamesByState: new Map(),
        selectedHasFeiertag: false,
        selectedFeiertagNames: []
      });
    }

    // Apply bundesweite Feiertage to all states
    for (const [dateIso, names] of holidays.bundesweit.entries()) {
      const slot = dayMap.get(dateIso);
      if (!slot) continue;

      for (const { code } of STATES) {
        if (!slot.holidayNamesByState.has(code)) slot.holidayNamesByState.set(code, new Set());
        for (const n of names) slot.holidayNamesByState.get(code).add(n);
        if (appState.included.has(code)) slot.states.add(code);
      }

      // selected state gets red hatch
      slot.selectedHasFeiertag = true;
      slot.selectedFeiertagNames.push(...names);
    }

    // Apply per-state events (ferien + states-feiertag)
    for (const { code } of STATES) {
      const events = (eventsByState.get(code) ?? []).slice();

      // Add regional holidays from feiertage.regional
      const reg = holidays.regional.get(code) ?? new Map();
      for (const [dateIso, names] of reg.entries()) {
        // each name as one-day event
        for (const name of names) {
          events.push({ type: 'feiertag', scope: 'regional', name, start: dateIso, end: dateIso });
        }
      }

      for (const ev of events) {
        const s = parseIso(ev.start);
        const e = parseIso(ev.end);
        if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) continue;

        const last = CONFIG.inclusiveEnd ? e : addDays(e, -1);
        for (let d = new Date(s); d <= last; d = addDays(d, 1)) {
          if (d.getFullYear() !== year) continue;
          const key = isoDate(d);
          const slot = dayMap.get(key);
          if (!slot) continue;

          if (!slot.holidayNamesByState.has(code)) slot.holidayNamesByState.set(code, new Set());
          slot.holidayNamesByState.get(code).add(ev.name);

          if (appState.included.has(code)) slot.states.add(code);

          if (code === appState.selected && ev.type === 'feiertag') {
            slot.selectedHasFeiertag = true;
            slot.selectedFeiertagNames.push(ev.name);
          }
        }
      }
    }

    return dayMap;
  }

  // --- Rendering ---
    function renderLegend() {
    const max = Math.max(0, appState.globalMaxOverlap);

    const steps = max <= 0
      ? [0]
      : Array.from(new Set([0, 1, Math.ceil(max/4), Math.ceil(max/2), Math.ceil((3*max)/4), max]))
          .filter(v => v >= 0 && v <= max)
          .sort((a,b) => a-b);

    const swatchesBlue = steps.map(v => {
      const c = colorForCount(v, max || 1, 'blue', false);
      return `<div class="legend__cell" title="${v}" style="background:${c}"></div>`;
    }).join('');

    const swatchesYellow = steps.map(v => {
      const c = colorForCount(v, max || 1, 'yellow', false);
      return `<div class="legend__cell" title="${v}" style="background:${c}"></div>`;
    }).join('');

    legendEl.innerHTML = `
      <div class="legend__row">
        <div class="legend__label">Überschneidung</div>
        <div class="legend__cells">${swatchesBlue}</div>
        <div class="legend__tag">0 → ${max}</div>
      </div>
      <div class="legend__row">
        <div class="legend__label">Ausgewählt</div>
        <div class="legend__cells">${swatchesYellow}</div>
        <div class="legend__tag">0 → ${max}</div>
      </div>
      <div class="legend__row">
        <div class="legend__cell" style="background: ${colorForCount(Math.ceil(max/2)||1, max||1, 'yellow', false)}; position: relative;">
          <span style="position:absolute; inset:0; background: repeating-linear-gradient(135deg, rgba(255,59,59,0) 0px, rgba(255,59,59,0) 6px, rgba(255,59,59,0.70) 6px, rgba(255,59,59,0.70) 9px); border-radius:4px; opacity:.75"></span>
        </div>
        <div class="legend__label">Feiertag (Auswahl-Bundesland)</div>
      </div>
    `;
  }

  function renderAllHeatmaps() {
    ensureHeatmapBlocks();

    for (const year of YEARS) {
      const target = appState.renderTargets.get(year);
      if (!target) continue;
      renderYearHeatmap(year, target.monthLabelsEl, target.heatmapEl);
    }
  }

  function renderYearHeatmap(year, monthLabelsEl, heatmapEl) {
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);

    const gridStart = startOfWeekMonday(start);
    const gridEnd = addDays(startOfWeekMonday(addDays(end, 1)), 6);

    const max = Math.max(1, appState.globalMaxOverlap || 1);

    renderMonthLabels(year, gridStart, monthLabelsEl);

    const dayMap = appState.dayMapByYear.get(year);
    heatmapEl.innerHTML = '';
    const frag = document.createDocumentFragment();

    for (let d = new Date(gridStart); d <= gridEnd; d = addDays(d, 1)) {
      const key = isoDate(d);
      const inYear = d.getFullYear() === year;
      const weekdayMon0 = (d.getDay() + 6) % 7;
      const isWeekend = weekdayMon0 >= 5;

      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.style.gridRow = String(weekdayMon0 + 1);

      if (isWeekend) cell.classList.add('cell--weekend');

      if (!inYear) {
        cell.style.opacity = '0.25';
        cell.style.backgroundColor = 'rgba(255,255,255,0.03)';
      } else {
        const slot = dayMap?.get(key);
        const count = slot ? slot.states.size : 0;
        const selectedHasAny = slot?.holidayNamesByState?.has(appState.selected) ?? false;

        const palette = selectedHasAny ? 'yellow' : 'blue';
        cell.style.backgroundColor = colorForCount(count, max, palette, isWeekend);

        if (slot?.selectedHasFeiertag) {
          cell.classList.add('cell--selectedHoliday');
        }

        cell.addEventListener('mouseenter', (e) => {
          showTooltipForDate(year, key, e.clientX, e.clientY);
        });
        cell.addEventListener('mousemove', (e) => {
          moveTooltip(e.clientX, e.clientY);
        });
        cell.addEventListener('mouseleave', () => {
          hideTooltip();
        });
      }

      frag.appendChild(cell);
    }

    heatmapEl.appendChild(frag);
  }

  function renderMonthLabels(year, gridStartMonday, monthLabelsEl) {
    const cols = Array.from({ length: 53 }, () => '');
    const used = new Set();

    for (let m = 0; m < 12; m++) {
      const mid = new Date(year, m, 15);
      const wk = startOfWeekMonday(mid);
      const idx = Math.round((wk - gridStartMonday) / (7 * 86400000));
      let pos = clamp(idx, 0, 52);

      if (used.has(pos)) {
        for (let step = 1; step < 4; step++) {
          if (pos + step <= 52 && !used.has(pos + step)) { pos = pos + step; break; }
          if (pos - step >= 0 && !used.has(pos - step)) { pos = pos - step; break; }
        }
      }

      used.add(pos);
      cols[pos] = monthShort(m);
    }

    monthLabelsEl.innerHTML = cols.map(t => `<div>${escapeHtml(t)}</div>`).join('');
  }

  // --- Tooltip ---
  function showTooltipForDate(year, dateIso, x, y) {
    const dayMap = appState.dayMapByYear.get(year);
    const slot = dayMap?.get(dateIso);
    if (!slot) return;

    const count = slot.states.size;
    const includedTotal = appState.included.size;

    const includedStates = Array.from(slot.states).map(stateName).sort((a,b) => a.localeCompare(b));
    const selectedSet = slot.holidayNamesByState.get(appState.selected);
    const selectedNames = selectedSet ? Array.from(selectedSet).sort() : [];

    const selectedLine = selectedNames.length
      ? `<div class="t-row"><strong>Ausgewählt:</strong> ${escapeHtml(stateName(appState.selected))} (${selectedNames.map(escapeHtml).join(', ')})</div>`
      : `<div class="t-row"><strong>Ausgewählt:</strong> ${escapeHtml(stateName(appState.selected))} (keine Ereignisse)</div>`;

    const feiertagPill = slot.selectedHasFeiertag
      ? `<div class="t-row" style="margin-top:6px"><span class="pill pill--holiday">Feiertag: ${escapeHtml((slot.selectedFeiertagNames||[]).join(', '))}</span></div>`
      : '';

    const listAll = includedStates.length ? escapeHtml(includedStates.join(', ')) : '—';

    tooltipEl.innerHTML = `
      <div class="t-title">${escapeHtml(formatDate(dateIso))} <span class="muted">(${year})</span></div>
      <div class="t-row"><strong>Bundesländer mit Ereignis (einbezogen):</strong> ${count} / ${includedTotal}</div>
      ${selectedLine}
      ${feiertagPill}
      <div class="t-row" style="margin-top:6px"><strong>Liste:</strong> ${listAll}</div>
    `;

    tooltipEl.classList.add('visible');
    tooltipEl.setAttribute('aria-hidden', 'false');
    moveTooltip(x, y);
  }

  function moveTooltip(x, y) {
    const pad = CONFIG.tooltipOffset;
    const rect = tooltipEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = x + pad;
    let top = y + pad;

    if (left + rect.width + pad > vw) left = x - rect.width - pad;
    if (top + rect.height + pad > vh) top = y - rect.height - pad;

    tooltipEl.style.left = `${clamp(left, 10, vw - rect.width - 10)}px`;
    tooltipEl.style.top = `${clamp(top, 10, vh - rect.height - 10)}px`;
  }

  function hideTooltip() {
    tooltipEl.classList.remove('visible');
    tooltipEl.setAttribute('aria-hidden', 'true');
  }

  // --- Render blocks ---
  function ensureHeatmapBlocks() {
    if (appState.renderTargets.size) return;

    heatmapsWrap.innerHTML = '';
    appState.renderTargets = new Map();

    for (const year of YEARS) {
      const block = document.createElement('div');
      block.className = 'yearBlock';
      block.dataset.year = String(year);

      const watermark = document.createElement('div');
      watermark.className = 'yearWatermark';
      watermark.textContent = String(year);

      const monthLabels = document.createElement('div');
      monthLabels.className = 'monthLabels';

      const axes = document.createElement('div');
      axes.className = 'axes';

      const dayLabels = document.createElement('div');
      dayLabels.className = 'dayLabels';
      dayLabels.setAttribute('aria-hidden', 'true');
      dayLabels.innerHTML = '<div>Mo</div><div>Di</div><div>Mi</div><div>Do</div><div>Fr</div><div>Sa</div><div>So</div>';

      const heatmap = document.createElement('div');
      heatmap.className = 'heatmap';
      heatmap.setAttribute('aria-label', `Heatmap ${year}`);

      axes.appendChild(dayLabels);
      axes.appendChild(heatmap);

      block.appendChild(watermark);
      block.appendChild(monthLabels);
      block.appendChild(axes);

      heatmapsWrap.appendChild(block);

      appState.renderTargets.set(year, { monthLabelsEl: monthLabels, heatmapEl: heatmap });
    }
  }

  // --- Boot ---
  function init() {
    initStateSelect();
    initCheckboxes();
    reloadAll();
  }

  init();
})();
