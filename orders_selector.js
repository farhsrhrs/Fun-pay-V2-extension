// ============================================================
//  ORDERS SELECTOR — ТОЛЬКО ДЛЯ СТРАНИЦЫ ЗАКАЗОВ (/orders/*)
//  - Кнопка + / ✓ справа в каждой строке
//  - Кнопка ⊕ для выбора всех заказов с тем же товаром
//  - Панель: Выручка, Себестоимость по товарам, Чистая прибыль
// ============================================================

const STORAGE_KEY      = 'orderSelectorEnabled';
const SELECTED_KEY     = 'orderSelectorSelected';
const COSTS_KEY        = 'orderSelectorCosts';
const ORDERS_CACHE_KEY = 'fp_orders_cache';

let selectorActive = false;
let selectedOrders = new Map(); // id -> { price, priceStr, user, title, status }
let titleCosts     = {};        // title -> себестоимость за штуку
let panelEl = null;
let styleEl = null;

// Наблюдатель и защита от каскадных циклов DOM
let mainObserver     = null;
let isUpdatingDOM    = false;
let domUpdateTimeout = null;

// ─── Автоматический сбор и кэширование заказов ──────────────
function harvestOrdersFromPage() {
  const harvested = [];
  document.querySelectorAll('.tc-item').forEach(link => {
    const id = link.querySelector('.tc-order')?.textContent.trim().replace('#', '') || '';
    if (!id) return;

    const priceRaw = link.querySelector('.tc-price')?.textContent.trim() || '0';
    const price    = parseFloat(priceRaw.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
    const user     = link.querySelector('.media-user-name span')?.textContent.trim() || 
                     link.querySelector('.media-user-name')?.textContent.trim() || '';
    const title    = link.querySelector('.order-desc div')?.textContent.trim() || 
                     link.querySelector('.order-desc')?.textContent.trim() || '';
    const status   = link.querySelector('.tc-status')?.textContent.trim() || '';
    const date     = link.querySelector('.tc-date-time')?.textContent.trim() || 
                     link.querySelector('.tc-date')?.textContent.trim() || '';

    if (title || user) {
      harvested.push({ id, title, user, price, priceStr: priceRaw, status, date });
    }
  });

  if (harvested.length > 0) {
    saveOrdersToCache(harvested);
  }
}

async function saveOrdersToCache(ordersList) {
  if (!ordersList || !ordersList.length) return;
  try {
    const stored = await new Promise(r => chrome.storage.local.get([ORDERS_CACHE_KEY], r));
    const cache = stored[ORDERS_CACHE_KEY] || {};
    let changed = false;

    ordersList.forEach(o => {
      if (!o.id) return;
      const prev = cache[o.id];
      if (!prev || prev.title !== o.title || prev.user !== o.user || prev.status !== o.status) {
        cache[o.id] = {
          id: o.id,
          title: o.title || (prev ? prev.title : ''),
          user: o.user || (prev ? prev.user : ''),
          price: o.price !== undefined ? o.price : (prev ? prev.price : 0),
          priceStr: o.priceStr || (prev ? prev.priceStr : ''),
          status: o.status || (prev ? prev.status : ''),
          date: o.date || (prev ? prev.date : ''),
          notFound: false,
          updatedAt: Date.now()
        };
        changed = true;
      }
    });

    if (changed) {
      await chrome.storage.local.set({ [ORDERS_CACHE_KEY]: cache });
    }
  } catch (e) {
    console.warn('[FunPay Orders] Failed to cache orders:', e);
  }
}

// ─── Наблюдатель за DOM с дебаунсом ─────────────────────────
function setupObserver() {
  if (mainObserver) return;

  mainObserver = new MutationObserver((mutations) => {
    if (isUpdatingDOM) return;

    let hasRelevantChanges = false;
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length > 0) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) {
            if (node.id === 'fp-corner-panel' || 
                node.classList?.contains('fp-sel-btn') || 
                node.classList?.contains('fp-title-btn')) {
              continue;
            }
            if (node.classList?.contains('tc-item') || 
                node.querySelector?.('.tc-item') || 
                node.classList?.contains('tc-table') || 
                node.classList?.contains('table')) {
              hasRelevantChanges = true;
              break;
            }
          }
        }
      }
      if (hasRelevantChanges) break;
    }

    if (hasRelevantChanges) {
      scheduleDOMUpdate();
    }
  });

  mainObserver.observe(document.body, { childList: true, subtree: true });
}

function scheduleDOMUpdate() {
  if (domUpdateTimeout) clearTimeout(domUpdateTimeout);
  domUpdateTimeout = setTimeout(() => {
    requestAnimationFrame(() => {
      harvestOrdersFromPage();
      if (selectorActive) {
        processAllRows();
      }
    });
  }, 80);
}

// ─── Инициализация селектора ────────────────────────────────
async function init() {
  injectStyles();
  harvestOrdersFromPage();
  setupObserver();

  const res = await new Promise(r => chrome.storage.local.get([STORAGE_KEY], r));
  selectorActive = !!res[STORAGE_KEY];
  if (selectorActive) {
    activate();
  }
}

init();

// Слушаем изменение в хранилище
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_KEY] !== undefined) {
    const newState = !!changes[STORAGE_KEY].newValue;
    if (newState !== selectorActive) {
      selectorActive = newState;
      selectorActive ? activate() : deactivate();
    }
  }
});

// Слушаем сообщения из popup
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'toggle_order_selector') {
    selectorActive = msg.enabled;
    chrome.storage.local.set({ [STORAGE_KEY]: selectorActive });
    selectorActive ? activate() : deactivate();
  }
});

// ─── Активация ───────────────────────────────────────────────
async function activate() {
  injectStyles();

  const stored = await new Promise(r => chrome.storage.local.get([SELECTED_KEY, COSTS_KEY], r));
  selectedOrders = new Map(Object.entries(stored[SELECTED_KEY] || {}));
  titleCosts     = stored[COSTS_KEY] || {};

  processAllRows();
  createPanel();
}

// ─── Деактивация ─────────────────────────────────────────────
function deactivate() {
  isUpdatingDOM = true;
  try {
    document.querySelectorAll('.fp-sel-btn, .fp-title-btn').forEach(b => b.remove());
    document.querySelectorAll('.tc-item').forEach(link => {
      link.removeAttribute('data-fp-done');
      link.classList.remove('fp-link-selected');
      link.style.position = '';
    });
  } finally {
    isUpdatingDOM = false;
  }
  selectedOrders.clear();
  saveSelected();
  if (panelEl) { panelEl.remove(); panelEl = null; }
  if (styleEl) { styleEl.remove(); styleEl = null; }
}

// ─── Сохранение ──────────────────────────────────────────────
function saveSelected() {
  const obj = {};
  selectedOrders.forEach((val, key) => { obj[key] = val; });
  chrome.storage.local.set({ [SELECTED_KEY]: obj });
}

function saveCosts() {
  chrome.storage.local.set({ [COSTS_KEY]: titleCosts });
}

// ─── Обработка строк таблицы заказов ─────────────────────────
function processAllRows() {
  const newItems = document.querySelectorAll('.tc-item:not([data-fp-done])');
  if (newItems.length === 0) return;

  isUpdatingDOM = true;
  try {
    newItems.forEach(link => {
      link.setAttribute('data-fp-done', '1');

      const id = link.querySelector('.tc-order')?.textContent.trim().replace('#', '') || '';
      if (!id) return;

      const priceRaw = link.querySelector('.tc-price')?.textContent.trim() || '0';
      const price    = parseFloat(priceRaw.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
      const user     = link.querySelector('.media-user-name span')?.textContent.trim() || 
                       link.querySelector('.media-user-name')?.textContent.trim() || '';
      const title    = link.querySelector('.order-desc div')?.textContent.trim() || 
                       link.querySelector('.order-desc')?.textContent.trim() || '';
      const status   = link.querySelector('.tc-status')?.textContent.trim() || '';

      link.style.position = 'relative';

      // ── Кнопка выбора (большая, справа) ──
      const btn = document.createElement('button');
      btn.className = 'fp-sel-btn';
      btn.type = 'button';
      btn.title = 'Выбрать заказ';
      const isOn = selectedOrders.has(id);
      btn.innerHTML = isOn ? '✓' : '+';
      if (isOn) { btn.classList.add('on'); link.classList.add('fp-link-selected'); }
      link.appendChild(btn);

      btn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        toggleOrder(id, { price, priceStr: priceRaw, user, title, status }, this, link);
      });

      // ── Кнопка «все с таким названием» ──
      const titleEl = link.querySelector('.order-desc div') || link.querySelector('.order-desc');
      if (titleEl && title && !titleEl.querySelector('.fp-title-btn')) {
        const allBtn = document.createElement('button');
        allBtn.className = 'fp-title-btn';
        allBtn.type = 'button';
        allBtn.title = 'Выбрать все заказы с таким названием';
        allBtn.textContent = '⊕';
        titleEl.style.position = 'relative';
        titleEl.appendChild(allBtn);

        allBtn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          selectAllByTitle(title);
        });
      }
    });
  } finally {
    isUpdatingDOM = false;
  }
}

// ─── Переключить заказ ───────────────────────────────────────
function toggleOrder(id, data, btn, link) {
  if (selectedOrders.has(id)) {
    selectedOrders.delete(id);
    btn.innerHTML = '+';
    btn.classList.remove('on');
    link.classList.remove('fp-link-selected');
  } else {
    selectedOrders.set(id, data);
    btn.innerHTML = '✓';
    btn.classList.add('on');
    link.classList.add('fp-link-selected');
  }
  saveSelected();
  updatePanel();
}

// ─── Выбрать все с таким же названием ────────────────────────
function selectAllByTitle(title) {
  document.querySelectorAll('.tc-item[data-fp-done]').forEach(link => {
    const t = link.querySelector('.order-desc div')?.textContent.trim() || 
              link.querySelector('.order-desc')?.textContent.trim() || '';
    if (t !== title) return;

    const id = link.querySelector('.tc-order')?.textContent.trim().replace('#', '') || '';
    if (!id) return;

    if (!selectedOrders.has(id)) {
      const priceRaw = link.querySelector('.tc-price')?.textContent.trim() || '0';
      const price    = parseFloat(priceRaw.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
      const user     = link.querySelector('.media-user-name span')?.textContent.trim() || 
                       link.querySelector('.media-user-name')?.textContent.trim() || '';
      const status   = link.querySelector('.tc-status')?.textContent.trim() || '';

      selectedOrders.set(id, { price, priceStr: priceRaw, user, title, status });

      const btn = link.querySelector('.fp-sel-btn');
      if (btn) { btn.innerHTML = '✓'; btn.classList.add('on'); }
      link.classList.add('fp-link-selected');
    }
  });
  saveSelected();
  updatePanel();
}

// ─── Угловая панель ──────────────────────────────────────────
function createPanel() {
  if (panelEl) return;

  panelEl = document.createElement('div');
  panelEl.id = 'fp-corner-panel';
  panelEl.innerHTML = `
    <div id="fp-cp-header">📦 Выбор заказов</div>

    <div id="fp-cp-stats">
      <div id="fp-cp-count">Ничего не выбрано</div>
      <div class="fp-stat-row">
        <span class="fp-stat-label">Выручка</span>
        <span id="fp-cp-revenue">—</span>
      </div>
      <div class="fp-stat-row">
        <span class="fp-stat-label">Себест.</span>
        <span id="fp-cp-cost-total">—</span>
      </div>
      <div class="fp-stat-row fp-profit-row">
        <span class="fp-stat-label">Прибыль</span>
        <span id="fp-cp-profit">—</span>
      </div>
    </div>

    <div id="fp-cp-list"></div>

    <div id="fp-cp-actions">
      <button id="fp-cp-copy">📋 Копировать</button>
      <button id="fp-cp-clear">✕ Сброс</button>
    </div>
  `;
  document.body.appendChild(panelEl);

  document.getElementById('fp-cp-clear').addEventListener('click', () => {
    document.querySelectorAll('.fp-sel-btn.on').forEach(b => {
      b.innerHTML = '+';
      b.classList.remove('on');
      b.closest('.tc-item')?.classList.remove('fp-link-selected');
    });
    selectedOrders.clear();
    saveSelected();
    updatePanel();
  });

  document.getElementById('fp-cp-copy').addEventListener('click', () => {
    if (!selectedOrders.size) return;
    const rows = [...selectedOrders.entries()].map(([id, o]) => {
      const cost = titleCosts[o.title] || 0;
      const profit = o.price - cost;
      return `#${id}\t${o.user || ''}\t${o.priceStr || o.price.toFixed(2)}\t${cost.toFixed(2)}\t${profit.toFixed(2)}\t${o.status || ''}\t${o.title || ''}`;
    });
    navigator.clipboard.writeText(
      `#Заказ\tПокупатель\tВыручка\tСебест.\tПрибыль\tСтатус\tТовар\n${rows.join('\n')}`
    );
    const btn = document.getElementById('fp-cp-copy');
    btn.textContent = '✅ Скопировано';
    setTimeout(() => btn.textContent = '📋 Копировать', 1800);
  });

  updatePanel();
}

// ─── Обновить панель ─────────────────────────────────────────
function updatePanel() {
  const countEl    = document.getElementById('fp-cp-count');
  const revenueEl  = document.getElementById('fp-cp-revenue');
  const costTotEl  = document.getElementById('fp-cp-cost-total');
  const profitEl   = document.getElementById('fp-cp-profit');
  const listEl     = document.getElementById('fp-cp-list');
  if (!countEl) return;

  const n = selectedOrders.size;
  const totalRevenue = [...selectedOrders.values()].reduce((s, o) => s + o.price, 0);

  // Группировка по названию
  const groups = new Map(); // title -> { count, revenue }
  selectedOrders.forEach(o => {
    if (!groups.has(o.title)) groups.set(o.title, { count: 0, revenue: 0 });
    const g = groups.get(o.title);
    g.count++;
    g.revenue += o.price;
  });

  // Себестоимость и прибыль
  let totalCost = 0;
  groups.forEach((g, title) => {
    totalCost += (titleCosts[title] || 0) * g.count;
  });
  const profit = totalRevenue - totalCost;

  countEl.textContent = n === 0 ? 'Ничего не выбрано' : `${n} заказ${plural(n)}`;
  revenueEl.textContent = n === 0 ? '—' : fmt(totalRevenue) + ' ₽';
  costTotEl.textContent  = n === 0 ? '—' : fmt(totalCost) + ' ₽';

  if (n === 0) {
    profitEl.textContent = '—';
    profitEl.style.color = '#4ecca3';
  } else {
    profitEl.textContent = (profit >= 0 ? '+' : '') + fmt(profit) + ' ₽';
    profitEl.style.color = profit >= 0 ? '#4ecca3' : '#e94560';
  }

  // Список групп с полем себестоимости
  if (n === 0) {
    listEl.innerHTML = '<div class="fp-hint">Нажмите + справа от заказа<br>или ⊕ рядом с названием</div>';
    return;
  }

  listEl.innerHTML = '';
  groups.forEach((g, title) => {
    const cost = titleCosts[title] || '';
    const shortTitle = title.length > 38 ? title.slice(0, 35) + '…' : title;
    const row = document.createElement('div');
    row.className = 'fp-group-row';
    row.innerHTML = `
      <div class="fp-group-title" title="${esc(title)}">${esc(shortTitle)}</div>
      <div class="fp-group-meta">
        <span class="fp-group-cnt">${g.count} шт · ${fmt(g.revenue)} ₽</span>
        <label class="fp-cost-label">
          Себест./шт:
          <input class="fp-cost-input" type="number" min="0" step="0.01"
            value="${cost}" placeholder="0" data-title="${esc(title)}">
          <span class="fp-cost-unit">₽</span>
        </label>
      </div>
    `;
    listEl.appendChild(row);
  });

  // Обработчики полей себестоимости
  listEl.querySelectorAll('.fp-cost-input').forEach(input => {
    input.addEventListener('input', function() {
      const t = this.getAttribute('data-title');
      const v = parseFloat(this.value) || 0;
      titleCosts[t] = v;
      saveCosts();
      updatePanel();
    });
    input.addEventListener('click', e => e.stopPropagation());
  });
}

// ─── Утилиты ─────────────────────────────────────────────────
function fmt(n) {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function plural(n) {
  if (n % 10 === 1 && n % 100 !== 11) return '';
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 'а';
  return 'ов';
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Стили ───────────────────────────────────────────────────
function injectStyles() {
  if (styleEl) return;
  styleEl = document.createElement('style');
  styleEl.textContent = `
    /* ── Кнопка выбора (большая) ── */
    .fp-sel-btn {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      z-index: 100;
      width: 36px;
      height: 36px;
      border: 2px solid rgba(255,255,255,0.18);
      border-radius: 8px;
      background: rgba(15, 52, 96, 0.92);
      color: #777;
      font-size: 18px;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
      padding: 0;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      user-select: none;
    }
    .fp-sel-btn:hover {
      border-color: #4ecca3;
      color: #4ecca3;
      background: rgba(78,204,163,0.15);
      transform: translateY(-50%) scale(1.08);
    }
    .fp-sel-btn.on {
      color: #fff !important;
      border-color: #4ecca3 !important;
      background: #4ecca3 !important;
      box-shadow: 0 2px 10px rgba(78,204,163,0.4) !important;
    }

    /* ── Кнопка «все с таким названием» ── */
    .fp-title-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border: 1px solid rgba(78,204,163,0.4);
      border-radius: 50%;
      background: rgba(78,204,163,0.08);
      color: #4ecca3;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      margin-left: 6px;
      vertical-align: middle;
      transition: all 0.15s;
      padding: 0;
      flex-shrink: 0;
    }
    .fp-title-btn:hover {
      background: rgba(78,204,163,0.25);
      transform: scale(1.2);
    }

    /* Выделенная строка */
    .tc-item.fp-link-selected {
      background: rgba(78, 204, 163, 0.08) !important;
      border-left: 3px solid #4ecca3 !important;
    }

    /* ── Угловая панель ── */
    #fp-corner-panel {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999999;
      width: 280px;
      background: #1a1a2e;
      border: 1px solid rgba(78,204,163,0.3);
      border-radius: 14px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.55);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #eee;
      overflow: hidden;
    }
    #fp-cp-header {
      background: #0f3460;
      padding: 10px 14px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.3px;
      color: #ccc;
    }
    #fp-cp-stats {
      padding: 10px 14px 8px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    #fp-cp-count {
      font-size: 11px;
      color: #888;
      margin-bottom: 8px;
    }
    .fp-stat-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      padding: 2px 0;
    }
    .fp-stat-label { color: #666; }
    .fp-stat-row span:last-child { font-weight: 600; color: #ccc; }
    .fp-profit-row {
      margin-top: 4px;
      padding-top: 6px;
      border-top: 1px dashed rgba(255,255,255,0.08);
    }
    .fp-profit-row .fp-stat-label { color: #aaa; font-weight: 700; }
    #fp-cp-profit {
      font-size: 16px !important;
      font-weight: 700 !important;
      color: #4ecca3;
    }

    #fp-cp-list {
      max-height: 200px;
      overflow-y: auto;
      padding: 6px 14px;
      scrollbar-width: thin;
      scrollbar-color: #333 transparent;
    }
    .fp-hint {
      font-size: 11px;
      color: #555;
      padding: 4px 0;
      line-height: 1.6;
    }
    .fp-group-row {
      padding: 6px 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .fp-group-title {
      font-size: 10px;
      color: #ccc;
      margin-bottom: 4px;
      line-height: 1.3;
    }
    .fp-group-meta {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .fp-group-cnt {
      font-size: 10px;
      color: #4ecca3;
      font-weight: 600;
    }
    .fp-cost-label {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 10px;
      color: #777;
    }
    .fp-cost-input {
      width: 60px;
      background: #0f3460;
      border: 1px solid rgba(78,204,163,0.3);
      border-radius: 4px;
      color: #eee;
      font-size: 11px;
      padding: 2px 5px;
      outline: none;
    }
    .fp-cost-input:focus { border-color: #4ecca3; }
    .fp-cost-unit { color: #888; }

    #fp-cp-actions {
      display: flex;
      gap: 8px;
      padding: 10px 14px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    #fp-cp-actions button {
      flex: 1;
      padding: 8px 0;
      border: none;
      border-radius: 7px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    #fp-cp-actions button:hover { opacity: 0.8; }
    #fp-cp-copy  { background: #0f3460; color: #fff; }
    #fp-cp-clear { background: #3a0f0f; color: #e9a0a0; }
  `;
  document.head.appendChild(styleEl);
}
