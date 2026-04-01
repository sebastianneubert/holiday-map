/*
  DE Schulferien heatmap (static JSON version)

  New in this iteration:
  - Axis Mon..Sun (Monday-first)
  - Month labels centered per month (placed at mid-month week)
  - Weekends slightly more saturated
  - Blue palette for overlap (included states)
  - Yellow palette for selected Bundesland days (shade uses overlap level)
  - Nationwide public holidays (Feiertage) shown with orange hatch overlay
*/

(() => {
  'use strict';

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
  const yearSelect = document.getElementById('yearSelect');
  const stateSelect = document.getElementById('stateSelect');
  const stateCheckboxes = document.getElementById('stateCheckboxes');
  const heatmapEl = document.getElementById('heatmap');
  const monthLabelsEl = document.getElementById('monthLabels');
  const legendEl = document.getElementById('legend');
  const statusEl = document.getElementById('status');
  const tooltipEl = document.getElementById('tooltip');
  const chipIncluded = document.getElementById('chipIncluded');
  const chipSelected = document.getElementById('chipSelected');
  const chipScale = document.getElementById('chipScale');

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
    levels: 6,          // 0..5
    tooltipOffset: 14,
    inclusiveEnd: true,
    defaultIncluded: new Set(STATES.map(s => s.code)),
    defaultSelected: 'be'
  };

  // --- Static JSON provider ---
  const DATA_PROVIDER = {
    async fetchAllStates(year) {
      const url = `./data/holidays-${encodeURIComponent(year)}.json`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Failed to load ${url}: ${res.status} ${res.statusText} ${txt}`);
      }
      const data = await res.json();
      if (!data || typeof data !== 'object' || !data.states || typeof data.states !== 'object') {
        throw new Error(`Invalid JSON structure in ${url}. Expected { meta, states }.`);
      }
      return data;
    },
    normalizeStateArray(arr) {
      if (!Array.isArray(arr)) return [];
      return arr
        .map(item => ({
          name: item.name ?? 'Ferien',
          start: item.start,
          end: item.end
        }))
        .filter(x => x.name && x.start && x.end);
    }
  };

  const appState = {
    year: new Date().getFullYear(),
    selected: CONFIG.defaultSelected,
    included: new Set(CONFIG.defaultIncluded),
    holidaysByState: new Map(),
    dayMap: new Map(),
    publicHolidays: new Map(), // iso -> name
    pinnedCell: null,
    pinnedDate: null
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

  // Monday-first start of week
  function startOfWeekMonday(d) {
    const x = new Date(d);
    const day = x.getDay(); // Sun=0..Sat=6
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
    return d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: '2-digit' });
  }

  function monthShort(monthIndex) {
    const d = new Date(2020, monthIndex, 1);
    return d.toLocaleDateString(undefined, { month: 'short' });
  }

  function setStatus(msg, kind = 'info') {
    const icon = kind === 'error' ? '⚠️' : kind === 'ok' ? '✅' : 'ℹ️';
    statusEl.innerHTML = `<strong>${icon}</strong>&nbsp;${escapeHtml(msg)}`;
  }

  // --- German nationwide public holidays (Feiertage) ---
  // We include the common nationwide ones:
  // Neujahr, Karfreitag, Ostermontag, Tag der Arbeit, Christi Himmelfahrt, Pfingstmontag,
  // Tag der Deutschen Einheit, 1. Weihnachtstag, 2. Weihnachtstag.
  function computeEasterSunday(year) {
    // Meeus/Jones/Butcher algorithm (Gregorian)
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
    const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=March, 4=April
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
  }

  function buildNationwideHolidays(year) {
    const map = new Map();
    const add = (d, name) => map.set(isoDate(d), name);

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
  function initYearSelect() {
    const now = new Date().getFullYear();
    const years = [now - 1, now, now + 1, now + 2];
    yearSelect.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
    yearSelect.value = String(appState.year);
    yearSelect.addEventListener('change', () => {
      appState.year = Number(yearSelect.value);
      reloadAll();
    });
  }

  function initStateSelect() {
    stateSelect.innerHTML = STATES.map(s => `<option value="${s.code}">${escapeHtml(s.name)}</option>`).join('');
    stateSelect.value = appState.selected;
    stateSelect.addEventListener('change', () => {
      appState.selected = stateSelect.value;
      chipSelected.textContent = `Selected: ${stateName(appState.selected)}`;
      buildDayMap();
      renderHeatmap();
    });

    showDetailsBtn.addEventListener('click', () => openModalForSelected());
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

        chipIncluded.textContent = `Included: ${appState.included.size} / ${STATES.length}`;
        buildDayMap();
        renderHeatmap();
      });

      row.appendChild(left);
      row.appendChild(cb);
      stateCheckboxes.appendChild(row);
    }

    selectAllBtn.addEventListener('click', () => {
      appState.included = new Set(STATES.map(s => s.code));
      syncCheckboxes();
      buildDayMap();
      renderHeatmap();
    });

    selectNoneBtn.addEventListener('click', () => {
      appState.included = new Set();
      syncCheckboxes();
      buildDayMap();
      renderHeatmap();
    });

    reloadBtn.addEventListener('click', () => reloadAll());

    chipIncluded.textContent = `Included: ${appState.included.size} / ${STATES.length}`;
    chipSelected.textContent = `Selected: ${stateName(appState.selected)}`;
  }

  function syncCheckboxes() {
    for (const s of STATES) {
      const cb = document.getElementById(`cb-${s.code}`);
      if (cb) cb.checked = appState.included.has(s.code);
    }
    chipIncluded.textContent = `Included: ${appState.included.size} / ${STATES.length}`;
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
    const items = appState.holidaysByState.get(code) ?? [];

    const meta = `Year ${appState.year} • ${items.length} holiday periods`;

    const cards = items
      .slice()
      .sort((a,b) => a.start.localeCompare(b.start))
      .map(h => {
        const n = escapeHtml(h.name);
        const range = `${escapeHtml(h.start)} → ${escapeHtml(h.end)}`;
        const days = countDaysInclusive(h.start, h.end);
        return `
          <div class="holidayCard">
            <div class="name">${n}</div>
            <div class="range">${range} <span class="muted">(${days} days)</span></div>
          </div>
        `;
      })
      .join('');

    const body = cards || `<div class="holidayCard"><div class="name">No data</div><div class="range muted">No holiday periods found for this Bundesland in your JSON file.</div></div>`;

    openModal(`${stateName(code)} – holidays`, meta, body);
  }

  function countDaysInclusive(startIso, endIso) {
    const s = parseIso(startIso);
    const e = parseIso(endIso);
    const days = Math.floor((e - s) / 86400000) + 1;
    return Math.max(1, days);
  }

  // --- Load + aggregation ---
  async function reloadAll() {
    appState.pinnedCell = null;
    appState.pinnedDate = null;
    hideTooltip(true);

    setStatus(`Loading local holiday data for ${appState.year} …`);

    try {
      const payload = await DATA_PROVIDER.fetchAllStates(appState.year);

      appState.holidaysByState = new Map();
      for (const { code } of STATES) {
        const arr = payload.states?.[code] ?? [];
        appState.holidaysByState.set(code, DATA_PROVIDER.normalizeStateArray(arr));
      }

      appState.publicHolidays = buildNationwideHolidays(appState.year);

      buildDayMap();
      renderLegend();
      renderHeatmap();

      const totalPeriods = Array.from(appState.holidaysByState.values()).reduce((a, x) => a + (x?.length ?? 0), 0);
      setStatus(`Loaded ./data/holidays-${appState.year}.json • ${totalPeriods} holiday periods • ${appState.publicHolidays.size} nationwide holidays.`, 'ok');

    } catch (e) {
      console.error(e);
      setStatus(`Failed to load local data: ${e.message}. Ensure ./data/holidays-${appState.year}.json exists and you run a local web server.`, 'error');
    }
  }

  function buildDayMap() {
    const year = appState.year;
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);

    const dayMap = new Map();
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
      const key = isoDate(d);
      dayMap.set(key, {
        states: new Set(),
        holidayNamesByState: new Map(),
        selectedHas: false,
        isPublicHoliday: appState.publicHolidays.has(key),
        publicHolidayName: appState.publicHolidays.get(key) ?? null
      });
    }

    for (const { code } of STATES) {
      const periods = appState.holidaysByState.get(code) ?? [];
      for (const p of periods) {
        const s = parseIso(p.start);
        const e = parseIso(p.end);
        if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) continue;

        const last = CONFIG.inclusiveEnd ? e : addDays(e, -1);
        for (let d = new Date(s); d <= last; d = addDays(d, 1)) {
          if (d.getFullYear() !== year) continue;
          const key = isoDate(d);
          const slot = dayMap.get(key);
          if (!slot) continue;

          if (!slot.holidayNamesByState.has(code)) slot.holidayNamesByState.set(code, new Set());
          slot.holidayNamesByState.get(code).add(p.name);

          if (appState.included.has(code)) slot.states.add(code);
        }
      }
    }

    for (const slot of dayMap.values()) {
      slot.selectedHas = slot.holidayNamesByState.has(appState.selected);
    }

    appState.dayMap = dayMap;

    let maxOverlap = 0;
    for (const slot of dayMap.values()) maxOverlap = Math.max(maxOverlap, slot.states.size);
    chipScale.textContent = `Max overlap: ${maxOverlap}`;
    chipIncluded.textContent = `Included: ${appState.included.size} / ${STATES.length}`;
    chipSelected.textContent = `Selected: ${stateName(appState.selected)}`;
  }

  // --- Rendering ---
  function renderLegend() {
    const blueCells = Array.from({ length: CONFIG.levels }, (_, i) => `<div class="legend__cell" style="background:${blueColor(i)}"></div>`).join('');
    const yellowCells = Array.from({ length: CONFIG.levels }, (_, i) => `<div class="legend__cell" style="background:${yellowColor(i)}"></div>`).join('');

    legendEl.innerHTML = `
      <div class="legend__row">
        <div class="legend__label">Overlap</div>
        <div class="legend__cells">${blueCells}</div>
        <div class="legend__tag">blue</div>
      </div>
      <div class="legend__row">
        <div class="legend__label">Selected</div>
        <div class="legend__cells">${yellowCells}</div>
        <div class="legend__tag">yellow</div>
      </div>
      <div class="legend__row">
        <div class="legend__cell" style="background: var(--blue3); position: relative;">
          <span style="position:absolute; inset:0; background: repeating-linear-gradient(135deg, rgba(255,138,42,0) 0px, rgba(255,138,42,0) 6px, rgba(255,138,42,0.55) 6px, rgba(255,138,42,0.55) 9px); border-radius:4px; opacity:.55"></span>
        </div>
        <div class="legend__label">Feiertag (DE)</div>
      </div>
    `;
  }

  function blueColor(level) {
    switch (level) {
      case 0: return 'rgba(255,255,255,0.03)';
      case 1: return 'var(--blue1)';
      case 2: return 'var(--blue2)';
      case 3: return 'var(--blue3)';
      case 4: return 'var(--blue4)';
      case 5: return 'var(--blue5)';
      default: return 'var(--blue5)';
    }
  }

  function yellowColor(level) {
    switch (level) {
      case 0: return 'var(--yellow0)';
      case 1: return 'var(--yellow1)';
      case 2: return 'var(--yellow2)';
      case 3: return 'var(--yellow3)';
      case 4: return 'var(--yellow4)';
      case 5: return 'var(--yellow5)';
      default: return 'var(--yellow5)';
    }
  }

  function computeLevel(count, maxCount) {
    if (count <= 0 || maxCount <= 0) return 0;
    const top = CONFIG.levels - 1;
    const scaled = Math.ceil((count / maxCount) * top);
    return clamp(scaled, 1, top);
  }

  function renderMonthLabels(gridStartMonday) {
    // Place labels at mid-month (15th) week to center them.
    const year = appState.year;
    const cols = Array.from({ length: 53 }, () => '');
    const used = new Set();

    for (let m = 0; m < 12; m++) {
      const mid = new Date(year, m, 15);
      const wk = startOfWeekMonday(mid);
      const idx = Math.round((wk - gridStartMonday) / (7 * 86400000));
      let pos = clamp(idx, 0, 52);

      // resolve collisions by shifting
      if (used.has(pos)) {
        let found = false;
        for (let step = 1; step < 4; step++) {
          if (pos + step <= 52 && !used.has(pos + step)) { pos = pos + step; found = true; break; }
          if (pos - step >= 0 && !used.has(pos - step)) { pos = pos - step; found = true; break; }
        }
        if (!found) {
          // give up; keep original
        }
      }

      used.add(pos);
      cols[pos] = monthShort(m);
    }

    monthLabelsEl.innerHTML = cols.map(t => `<div>${escapeHtml(t)}</div>`).join('');
  }

  function renderHeatmap() {
    const year = appState.year;
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);

    const gridStart = startOfWeekMonday(start);
    const gridEnd = addDays(startOfWeekMonday(addDays(end, 1)), 6);

    let maxOverlap = 0;
    for (const slot of appState.dayMap.values()) maxOverlap = Math.max(maxOverlap, slot.states.size);

    renderMonthLabels(gridStart);

    heatmapEl.innerHTML = '';
    const frag = document.createDocumentFragment();

    for (let d = new Date(gridStart); d <= gridEnd; d = addDays(d, 1)) {
      const key = isoDate(d);
      const inYear = d.getFullYear() === year;
      const weekdayMon0 = (d.getDay() + 6) % 7; // Mon=0..Sun=6

      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.date = key;
      cell.style.gridRow = String(weekdayMon0 + 1);

      // Weekend flag (Sat=5, Sun=6 in Mon0 system)
      if (weekdayMon0 >= 5) cell.classList.add('cell--weekend');

      if (!inYear) {
        cell.style.opacity = '0.25';
        cell.style.cursor = 'default';
        cell.dataset.level = '0';
        cell.dataset.palette = 'blue';
      } else {
        const slot = appState.dayMap.get(key);
        const count = slot ? slot.states.size : 0;
        const level = computeLevel(count, maxOverlap);

        const selectedHas = slot?.selectedHas ?? false;
        cell.dataset.level = String(level);
        cell.dataset.palette = selectedHas ? 'yellow' : 'blue';

        // If selected has holiday but overlap=0, keep a subtle yellow0
        if (selectedHas && count === 0) {
          cell.dataset.level = '0';
          cell.dataset.palette = 'yellow';
        }

        // Public holiday overlay
        if (slot?.isPublicHoliday) {
          cell.classList.add('cell--publicHoliday');
        }

        // Tooltip handlers
        cell.addEventListener('mouseenter', (e) => {
          if (appState.pinnedDate && appState.pinnedDate === key) return;
          showTooltipForDate(key, e.clientX, e.clientY);
        });
        cell.addEventListener('mousemove', (e) => {
          if (appState.pinnedDate && appState.pinnedDate === key) return;
          moveTooltip(e.clientX, e.clientY);
        });
        cell.addEventListener('mouseleave', () => {
          if (appState.pinnedDate) return;
          hideTooltip();
        });

        cell.addEventListener('click', (e) => {
          if (appState.pinnedDate === key) {
            appState.pinnedDate = null;
            if (appState.pinnedCell) appState.pinnedCell.classList.remove('cell--pinned');
            appState.pinnedCell = null;
            hideTooltip(true);
          } else {
            if (appState.pinnedCell) appState.pinnedCell.classList.remove('cell--pinned');
            appState.pinnedDate = key;
            appState.pinnedCell = cell;
            cell.classList.add('cell--pinned');
            showTooltipForDate(key, e.clientX, e.clientY, true);
          }
        });
      }

      frag.appendChild(cell);
    }

    heatmapEl.appendChild(frag);

    document.getElementById('heatmapTitle').textContent = `Heatmap – ${year} (selected: ${stateName(appState.selected)}, included: ${appState.included.size})`;
  }

  // --- Tooltip ---
  function showTooltipForDate(dateIso, x, y, pinned = false) {
    const slot = appState.dayMap.get(dateIso);
    if (!slot) return;

    const count = slot.states.size;
    const includedStates = Array.from(slot.states).map(stateName);
    const selectedNames = Array.from(slot.holidayNamesByState.get(appState.selected) ?? []).sort();

    const pills = includedStates.slice(0, 10).map(n => `<span class="pill">${escapeHtml(n)}</span>`).join('');
    const more = includedStates.length > 10 ? `<span class="pill">+${includedStates.length - 10} more</span>` : '';

    const selectedLine = slot.selectedHas
      ? `<div class="t-row"><strong>Selected:</strong> ${escapeHtml(stateName(appState.selected))} (${selectedNames.map(escapeHtml).join(', ') || 'holiday'})</div>`
      : `<div class="t-row"><strong>Selected:</strong> ${escapeHtml(stateName(appState.selected))} (no holiday)</div>`;

    const feiertag = slot.isPublicHoliday
      ? `<div class="t-row" style="margin-top:6px"><span class="pill pill--holiday">Feiertag (DE): ${escapeHtml(slot.publicHolidayName)}</span></div>`
      : '';

    tooltipEl.innerHTML = `
      <div class="t-title">${escapeHtml(formatDate(dateIso))}</div>
      <div class="t-row"><strong>Overlap (included):</strong> ${count} Bundesländer on holiday</div>
      ${selectedLine}
      ${feiertag}
      <div class="t-row" style="margin-top:6px"><strong>Included states on holiday:</strong></div>
      <div class="t-row">${pills}${more}</div>
      <div class="t-row" style="margin-top:6px">${pinned ? 'Pinned (click again to unpin)' : 'Click to pin'}</div>
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

  function hideTooltip(force = false) {
    if (!force && appState.pinnedDate) return;
    tooltipEl.classList.remove('visible');
    tooltipEl.setAttribute('aria-hidden', 'true');
  }

  // --- Boot ---
  function init() {
    initYearSelect();
    initStateSelect();
    initCheckboxes();
    renderLegend();
    reloadAll();
  }

  init();
})();
