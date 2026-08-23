// ============================================================
//  FUNPAY SELECTOR: РАЗДЕЛЬНЫЕ МОДУЛИ ПРОДАЖ И ФИНАНСОВ
//  - Заказы / Продажи (/orders/*, /orders/trade): Выручка, Себестоимость, Прибыль
//  - Финансы / Баланс (/account/balance, /account/*): Поступления, Списания, Баланс
// ============================================================

const IS_FINANCE = window.location.href.toLowerCase().includes('/account') || 
                   window.location.href.toLowerCase().includes('/balance') || 
                   window.location.href.toLowerCase().includes('/finances') || 
                   !!document.querySelector('.tc-finance, .transactions');

const STORAGE_KEY      = IS_FINANCE ? 'financeSelectorEnabled' : 'orderSelectorEnabled';
const SELECTED_KEY     = IS_FINANCE ? 'financeSelectorSelected' : 'orderSelectorSelected';
const COSTS_KEY        = 'orderSelectorCosts';
const ORDERS_CACHE_KEY = 'fp_orders_cache';

let selectorActive = false;
let selectedOrders = new Map(); // id -> item data
let titleCosts     = {};        // title -> себестоимость за штуку (для заказов)
let ordersCache    = {};        // orderId -> { title, user, price, status, date }
let panelEl = null;
let styleEl = null;
let mutObs  = null;

let pendingFetchIds = new Set();
let fetchTimeout    = null;
let isFetching      = false;

// ─── Автоматический сбор заказов на странице продаж ──────────
function harvestOrdersFromPage() {
  if (IS_FINANCE) return;
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
      if (!prev || (o.title && prev.title !== o.title) || (o.user && prev.user !== o.user) || (o.status && prev.status !== o.status)) {
        cache[o.id] = {
          id: o.id,
          title: o.title || (prev ? prev.title : ''),
          user: o.user || (prev ? prev.user : ''),
          price: o.price !== undefined ? o.price : (prev ? prev.price : 0),
          priceStr: o.priceStr || (prev ? prev.priceStr : ''),
          status: o.status || (prev ? prev.status : ''),
          date: o.date || (prev ? prev.date : ''),
          updatedAt: Date.now()
        };
        changed = true;
      }
    });

    if (changed) {
      ordersCache = cache;
      await chrome.storage.local.set({ [ORDERS_CACHE_KEY]: cache });
    }
  } catch (e) {
    console.warn('[FunPay] Failed to save orders cache:', e);
  }
}

// Запускаем сбор на странице заказов
if (!IS_FINANCE) {
  harvestOrdersFromPage();
  const passiveObserver = new MutationObserver(() => harvestOrdersFromPage());
  passiveObserver.observe(document.body, { childList: true, subtree: true });
} else {
  // На странице финансов загружаем кэш и обогащаем строки
  chrome.storage.local.get([ORDERS_CACHE_KEY], res => {
    ordersCache = res[ORDERS_CACHE_KEY] || {};
    enrichAllVisibleRows();
  });
  const financePassiveObserver = new MutationObserver(() => enrichAllVisibleRows());
  financePassiveObserver.observe(document.body, { childList: true, subtree: true });
}

// ─── Извлечение ID заказа ────────────────────────────────────
function extractOrderId(row) {
  const orderLink = row.querySelector('a[href*="/orders/"]');
  if (orderLink) {
    const href = orderLink.getAttribute('href') || '';
    const m = href.match(/\/orders\/([A-Za-z0-9]+)/i);
    if (m && m[1] && m[1].toLowerCase() !== 'trade') return m[1].toUpperCase();
  }
  const titleEl = row.querySelector('.tc-desc .tc-title') || row.querySelector('.tc-title') || row.querySelector('.tc-desc');
  if (titleEl) {
    const text = titleEl.textContent || '';
    const m = text.match(/#([A-Za-z0-9]{4,16})\b/);
    if (m && m[1]) return m[1].toUpperCase();
  }
  const dataOrder = row.getAttribute('data-order');
  if (dataOrder) return dataOrder.replace('#', '').trim().toUpperCase();
  return null;
}

// ─── Обогащение строк финансов ───────────────────────────────
function enrichAllVisibleRows(forceUpdate = false) {
  if (!IS_FINANCE) return;
  document.querySelectorAll('.tc-item').forEach(row => {
    const orderId = extractOrderId(row);
    if (!orderId) return;

    const descEl = row.querySelector('.tc-desc') || row.querySelector('.tc-title')?.parentElement;
    if (!descEl) return;

    let detailsEl = descEl.querySelector('.fp-order-details');
    if (!detailsEl) {
      detailsEl = document.createElement('div');
      detailsEl.className = 'fp-order-details';
      descEl.appendChild(detailsEl);
    }

    const isLoaded = detailsEl.getAttribute('data-order-loaded') === orderId;
    if (isLoaded && !forceUpdate) return;

    const order = ordersCache[orderId];
    if (order && (order.title || order.user)) {
      const titleText = order.title || 'Товар без названия';
      const shortTitle = titleText.length > 48 ? titleText.slice(0, 45) + '…' : titleText;
      const buyerText = order.user || '—';

      detailsEl.innerHTML = `
        ${order.title ? `<span class="fp-badge-title" title="${esc(titleText)}">📦 <b>${esc(shortTitle)}</b></span>` : ''}
        ${order.user ? `<span class="fp-badge-buyer" title="Покупатель: ${esc(buyerText)}">👤 <b>${esc(buyerText)}</b></span>` : ''}
        <a class="fp-badge-link" href="https://funpay.com/orders/${esc(orderId)}/" target="_blank" title="Открыть страницу заказа #${esc(orderId)}">#${esc(orderId)} ↗</a>
      `;
      detailsEl.setAttribute('data-order-loaded', orderId);
    } else {
      detailsEl.innerHTML = `
        <span class="fp-badge-loading" title="Загрузка данных заказа #${esc(orderId)}">⏳ #${esc(orderId)} (загрузка...)</span>
        <a class="fp-badge-link" href="https://funpay.com/orders/${esc(orderId)}/" target="_blank">#${esc(orderId)} ↗</a>
      `;
      queueOrderForFetch(orderId);
    }
  });
}

function queueOrderForFetch(orderId) {
  if (!orderId || (ordersCache[orderId] && ordersCache[orderId].title) || pendingFetchIds.has(orderId)) return;
  pendingFetchIds.add(orderId);
  if (fetchTimeout) clearTimeout(fetchTimeout);
  fetchTimeout = setTimeout(processFetchQueue, 350);
}

async function processFetchQueue() {
  if (isFetching || pendingFetchIds.size === 0) return;
  isFetching = true;
  try {
    const idsToFetch = Array.from(pendingFetchIds);
    pendingFetchIds.clear();
    await syncOrdersFromSales(false);
    const remainingIds = idsToFetch.filter(id => !ordersCache[id] || (!ordersCache[id].title && !ordersCache[id].user));
    for (const id of remainingIds.slice(0, 10)) {
      await fetchSingleOrder(id);
      await new Promise(r => setTimeout(r, 300));
    }
  } catch (e) {
    console.warn('[FunPay] Fetch queue error:', e);
  } finally {
    isFetching = false;
    enrichAllVisibleRows(true);
  }
}

async function syncOrdersFromSales(showStatus = true) {
  try {
    const resp = await fetch('https://funpay.com/orders/trade', { credentials: 'include' });
    if (!resp.ok) return;
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const harvested = [];
    doc.querySelectorAll('.tc-item').forEach(link => {
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
      if (title || user) harvested.push({ id, title, user, price, priceStr: priceRaw, status, date });
    });
    if (harvested.length > 0) {
      await saveOrdersToCache(harvested);
      enrichAllVisibleRows(true);
      if (panelEl) updatePanel();
    }
  } catch (err) {
    console.warn('[FunPay] Could not sync orders:', err);
  }
}

async function fetchSingleOrder(orderId) {
  if (!orderId || (ordersCache[orderId] && ordersCache[orderId].title)) return;
  try {
    const resp = await fetch(`https://funpay.com/orders/${orderId}/`, { credentials: 'include' });
    if (!resp.ok) return;
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = doc.querySelector('.order-desc div')?.textContent?.trim() ||
                  doc.querySelector('.order-desc')?.textContent?.trim() ||
                  doc.querySelector('.param-item div.text-bold')?.textContent?.trim() || '';
    const user = doc.querySelector('.media-user-name span')?.textContent?.trim() ||
                 doc.querySelector('.media-user-name')?.textContent?.trim() ||
                 doc.querySelector('a[href*="/users/"] span')?.textContent?.trim() || '';
    const status = doc.querySelector('.tc-status')?.textContent?.trim() || '';
    if (title || user) {
      await saveOrdersToCache([{ id: orderId, title, user, status }]);
    }
  } catch (err) {
    console.warn(`[FunPay] Could not fetch single order #${orderId}:`, err);
  }
}

// ─── Инициализация селектора ────────────────────────────────
chrome.storage.local.get([STORAGE_KEY], (res) => {
  selectorActive = !!res[STORAGE_KEY];
  if (selectorActive) activate();
});

// Слушаем изменение в хранилище (мгновенная синхронизация)
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
  if (!IS_FINANCE && msg.action === 'toggle_order_selector') {
    selectorActive = msg.enabled;
    chrome.storage.local.set({ [STORAGE_KEY]: selectorActive });
    selectorActive ? activate() : deactivate();
  } else if (IS_FINANCE && msg.action === 'toggle_finance_selector') {
    selectorActive = msg.enabled;
    chrome.storage.local.set({ [STORAGE_KEY]: selectorActive });
    selectorActive ? activate() : deactivate();
  }
});

// ─── Активация ───────────────────────────────────────────────
async function activate() {
  injectStyles();

  const keys = IS_FINANCE ? [SELECTED_KEY] : [SELECTED_KEY, COSTS_KEY];
  const stored = await new Promise(r => chrome.storage.local.get(keys, r));
  selectedOrders = new Map(Object.entries(stored[SELECTED_KEY] || {}));
  titleCosts     = stored[COSTS_KEY] || {};

  processAllRows();
  createPanel();

  if (!mutObs) {
    mutObs = new MutationObserver(() => { if (selectorActive) processAllRows(); });
    mutObs.observe(document.body, { childList: true, subtree: true });
  }
}

// ─── Деактивация ─────────────────────────────────────────────
function deactivate() {
  document.querySelectorAll('.fp-sel-btn, .fp-title-btn').forEach(b => b.remove());
  document.querySelectorAll('.tc-item').forEach(el => {
    el.removeAttribute('data-fp-done');
    el.classList.remove('fp-link-selected');
    el.classList.remove('finance-selected');
    el.style.position = '';
  });
  selectedOrders.clear();
  saveSelected();
  if (panelEl) { panelEl.remove(); panelEl = null; }
  if (styleEl) { styleEl.remove(); styleEl = null; }
  if (mutObs)  { mutObs.disconnect(); mutObs = null; }
}

// ─── Сохранение ──────────────────────────────────────────────
function saveSelected() {
  const obj = {};
  selectedOrders.forEach((val, key) => { obj[key] = val; });
  chrome.storage.local.set({ [SELECTED_KEY]: obj });
}

function saveCosts() {
  if (!IS_FINANCE) {
    chrome.storage.local.set({ [COSTS_KEY]: titleCosts });
  }
}

// ─── Обработка строк таблицы ─────────────────────────────────
function processAllRows() {
  if (!IS_FINANCE) {
    // ════════════════ РЕЖИМ ПРОДАЖ (ЗАКАЗЫ) ════════════════
    document.querySelectorAll('.tc-item:not([data-fp-done])').forEach(link => {
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
  } else {
    // ════════════════ РЕЖИМ ФИНАНСОВ (БАЛАНС) ════════════════
    document.querySelectorAll('.tc-item:not([data-fp-done])').forEach(row => {
      row.setAttribute('data-fp-done', '1');

      const transId = row.getAttribute('data-transaction');
      const titleEl = row.querySelector('.tc-desc .tc-title') || row.querySelector('.tc-title');
      const id = transId ? transId.trim() : (titleEl ? titleEl.textContent.trim() : '');
      if (!id) return;

      const priceRaw = row.querySelector('.tc-price')?.textContent.trim() || '0';
      const isNegative = /[−\-]/.test(priceRaw);
      const cleanNum = priceRaw.replace(/[^\d.,]/g, '').replace(',', '.');
      let price = parseFloat(cleanNum) || 0;
      if (isNegative) price = -price;

      const title = titleEl ? titleEl.textContent.trim() : (row.querySelector('.tc-desc')?.textContent.trim() || 'Операция');
      const requisites = row.querySelector('.tc-payment-number')?.textContent.trim() || '';
      const status = row.querySelector('.tc-status')?.textContent.trim() || '';
      const date = row.querySelector('.tc-date-time')?.textContent.trim() || row.querySelector('.tc-date')?.textContent.trim() || '';

      const orderId = extractOrderId(row);
      const order = orderId ? ordersCache[orderId] : null;

      row.style.position = 'relative';

      const btn = document.createElement('button');
      btn.className = 'fp-sel-btn finance-btn';
      btn.type = 'button';
      btn.title = 'Выбрать операцию';
      const isOn = selectedOrders.has(id);
      btn.innerHTML = isOn ? '✓' : '+';
      if (isOn) { btn.classList.add('on'); row.classList.add('fp-link-selected', 'finance-selected'); }
      row.appendChild(btn);

      btn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const curOrder = orderId ? ordersCache[orderId] : null;
        toggleOrder(id, {
          price,
          priceStr: priceRaw,
          title,
          requisites,
          status,
          date,
          isWithdrawal: price < 0,
          orderId: orderId || '',
          orderTitle: curOrder?.title || '',
          buyer: curOrder?.user || ''
        }, this, row);
      });
    });
  }
}

// ─── Переключить один элемент ────────────────────────────────
function toggleOrder(id, data, btn, link) {
  if (selectedOrders.has(id)) {
    selectedOrders.delete(id);
    btn.innerHTML = '+';
    btn.classList.remove('on');
    link.classList.remove('fp-link-selected', 'finance-selected');
  } else {
    selectedOrders.set(id, data);
    btn.innerHTML = '✓';
    btn.classList.add('on');
    link.classList.add('fp-link-selected');
    if (IS_FINANCE) link.classList.add('finance-selected');
  }
  saveSelected();
  updatePanel();
}

// ─── Выбрать все заказы с таким же названием (для заказов) ──
function selectAllByTitle(title) {
  if (IS_FINANCE) return;
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

  if (!IS_FINANCE) {
    // ════════════════ ПАНЕЛЬ ПРОДАЖ (ЗАКАЗЫ) ════════════════
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
      setTimeout(() => { if (btn) btn.textContent = '📋 Копировать'; }, 1800);
    });

  } else {
    // ════════════════ ПАНЕЛЬ ФИНАНСОВ (БАЛАНС) ════════════════
    panelEl.innerHTML = `
      <div id="fp-cp-header" style="background: #162447;">💰 Выбор финансов</div>

      <div id="fp-cp-stats">
        <div id="fp-cp-count">Ничего не выбрано</div>
        <div class="fp-stat-row">
          <span class="fp-stat-label">Поступления (+)</span>
          <span id="fp-fin-pos" style="color: #2ecc71; font-weight: 600;">—</span>
        </div>
        <div class="fp-stat-row">
          <span class="fp-stat-label">Списания (−)</span>
          <span id="fp-fin-neg" style="color: #e94560; font-weight: 600;">—</span>
        </div>
        <div class="fp-stat-row fp-profit-row">
          <span class="fp-stat-label">Итоговый баланс</span>
          <span id="fp-fin-total" style="color: #3498db; font-size: 16px; font-weight: 700;">—</span>
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
        b.closest('.tc-item')?.classList.remove('fp-link-selected', 'finance-selected');
      });
      selectedOrders.clear();
      saveSelected();
      updatePanel();
    });

    document.getElementById('fp-cp-copy').addEventListener('click', () => {
      if (!selectedOrders.size) return;
      const rows = [...selectedOrders.entries()].map(([id, o]) => {
        const order = (o.orderId && ordersCache[o.orderId]) ? ordersCache[o.orderId] : null;
        const orderTitle = order?.title || o.orderTitle || o.title || '';
        const buyer = order?.user || o.buyer || '';
        const typeStr = o.isWithdrawal ? 'Списание/Вывод' : 'Поступление';
        const orderStr = o.orderId ? '#' + o.orderId : '';
        return `${id}\t${orderStr}\t${orderTitle}\t${buyer}\t${o.date || ''}\t${o.requisites || ''}\t${o.price.toFixed(2)}\t${typeStr}\t${o.status || ''}`;
      });
      navigator.clipboard.writeText(
        `ID транзакции\t#Заказ\tТовар/Описание\tПокупатель\tДата\tРеквизиты\tСумма\tТип\tСтатус\n${rows.join('\n')}`
      );
      const btn = document.getElementById('fp-cp-copy');
      btn.textContent = '✅ Скопировано';
      setTimeout(() => { if (btn) btn.textContent = '📋 Копировать'; }, 1800);
    });
  }

  updatePanel();
}

// ─── Обновить панель ─────────────────────────────────────────
function updatePanel() {
  const countEl = document.getElementById('fp-cp-count');
  const listEl  = document.getElementById('fp-cp-list');
  if (!countEl) return;

  const n = selectedOrders.size;

  if (!IS_FINANCE) {
    // ════════════════ ОБНОВЛЕНИЕ ПАНЕЛИ ПРОДАЖ ════════════════
    const revenueEl = document.getElementById('fp-cp-revenue');
    const costTotEl = document.getElementById('fp-cp-cost-total');
    const profitEl  = document.getElementById('fp-cp-profit');

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

  } else {
    // ════════════════ ОБНОВЛЕНИЕ ПАНЕЛИ ФИНАНСОВ ════════════════
    const posEl   = document.getElementById('fp-fin-pos');
    const negEl   = document.getElementById('fp-fin-neg');
    const totalEl = document.getElementById('fp-fin-total');

    const items = [...selectedOrders.values()];
    const posSum = items.filter(o => o.price > 0).reduce((s, o) => s + o.price, 0);
    const negSum = items.filter(o => o.price < 0).reduce((s, o) => s + o.price, 0);
    const total  = posSum + negSum;

    countEl.textContent = n === 0 ? 'Ничего не выбрано' : `${n} операци${pluralFinance(n)}`;
    posEl.textContent   = n === 0 ? '—' : '+ ' + fmt(posSum) + ' ₽';
    negEl.textContent   = n === 0 ? '—' : (negSum === 0 ? '0.00 ₽' : '− ' + fmt(Math.abs(negSum)) + ' ₽');

    if (n === 0) {
      totalEl.textContent = '—';
      totalEl.style.color = '#3498db';
      listEl.innerHTML = '<div class="fp-hint">Нажмите + справа от операции</div>';
      return;
    }

    totalEl.textContent = (total >= 0 ? '+' : '') + fmt(total) + ' ₽';
    totalEl.style.color = total >= 0 ? '#2ecc71' : '#e94560';

    listEl.innerHTML = '';
    items.forEach(o => {
      const row = document.createElement('div');
      row.className = 'fp-group-row';
      const isNeg = o.price < 0;
      const priceColor = isNeg ? '#e94560' : '#2ecc71';
      const priceSign = o.price > 0 ? '+ ' : (isNeg ? '− ' : '');

      const order = (o.orderId && ordersCache[o.orderId]) ? ordersCache[o.orderId] : null;
      const displayTitle = order?.title || o.orderTitle || o.title;
      const buyer = order?.user || o.buyer || '';
      const shortTitle = displayTitle.length > 38 ? displayTitle.slice(0, 35) + '…' : displayTitle;

      row.innerHTML = `
        <div class="fp-group-title" title="${esc(displayTitle)}">
          ${order?.title ? '📦 ' : ''}${esc(shortTitle)}
        </div>
        <div class="fp-group-sub" style="display: flex; gap: 4px; align-items: center; margin-bottom: 3px; flex-wrap: wrap;">
          ${buyer ? `<span class="fp-buyer-tag" title="Покупатель">👤 ${esc(buyer)}</span>` : ''}
          ${o.orderId ? `<span class="fp-order-tag">#${esc(o.orderId)}</span>` : ''}
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 10px; color: #888;">${esc(o.date)}</span>
          <span style="font-size: 11px; font-weight: 700; color: ${priceColor};">${priceSign}${fmt(Math.abs(o.price))} ₽</span>
        </div>
      `;
      listEl.appendChild(row);
    });
  }
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

function pluralFinance(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'я';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'и';
  return 'й';
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Стили ───────────────────────────────────────────────────
function injectStyles() {
  if (styleEl) return;
  styleEl = document.createElement('style');
  styleEl.textContent = `
    /* ── Бейджи товара и покупателя в таблице финансов ── */
    .fp-order-details {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
      line-height: 1.2;
    }
    .fp-badge-title {
      background: rgba(15, 52, 96, 0.75);
      border: 1px solid rgba(52, 152, 219, 0.45);
      color: #a8d8ea;
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 11px;
      max-width: 320px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .fp-badge-buyer {
      background: rgba(46, 204, 113, 0.15);
      border: 1px solid rgba(46, 204, 113, 0.4);
      color: #2ecc71;
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 11px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .fp-badge-link {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: #999;
      border-radius: 4px;
      padding: 2px 5px;
      font-size: 10px;
      text-decoration: none;
      transition: all 0.15s;
      display: inline-flex;
      align-items: center;
    }
    .fp-badge-link:hover {
      color: #3498db;
      border-color: #3498db;
      background: rgba(52, 152, 219, 0.15);
      text-decoration: none;
    }
    .fp-badge-loading {
      color: #888;
      font-size: 10px;
      font-style: italic;
    }
    .fp-buyer-tag {
      font-size: 10px;
      color: #2ecc71;
      background: rgba(46, 204, 113, 0.12);
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 600;
    }
    .fp-order-tag {
      font-size: 10px;
      color: #3498db;
      background: rgba(52, 152, 219, 0.12);
      padding: 1px 5px;
      border-radius: 3px;
    }

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

    .fp-sel-btn.finance-btn:hover {
      border-color: #3498db;
      color: #3498db;
      background: rgba(52,152,219,0.15);
    }
    .fp-sel-btn.finance-btn.on {
      border-color: #3498db !important;
      background: #3498db !important;
      box-shadow: 0 2px 10px rgba(52,152,219,0.4) !important;
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
    .tc-item.fp-link-selected.finance-selected {
      background: rgba(52, 152, 219, 0.08) !important;
      border-left: 3px solid #3498db !important;
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
