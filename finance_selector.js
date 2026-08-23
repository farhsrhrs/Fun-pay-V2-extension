// ============================================================
//  FINANCE SELECTOR — ТОЛЬКО ДЛЯ СТРАНИЦЫ ФИНАНСОВ (/account/*, /finances/*)
//  - Отображение описания товара (названия) и покупателя по ID заказа
//  - Кнопка + / ✓ справа в каждой строке транзакции
//  - Панель: Поступления (+), Списания (−), Итоговый баланс
//  - Синхронизация данных с разделом продаж (/orders/trade)
// ============================================================

const STORAGE_KEY      = 'financeSelectorEnabled';
const SELECTED_KEY     = 'financeSelectorSelected';
const ORDERS_CACHE_KEY = 'fp_orders_cache';

let selectorActive = false;
let selectedItems  = new Map(); // id -> item data
let ordersCache    = {};        // orderId -> { title, user, price, status, date, notFound }
let panelEl = null;
let styleEl = null;

// Наблюдатель и защита от каскадных циклов DOM
let mainObserver      = null;
let isUpdatingDOM     = false;
let domUpdateTimeout  = null;

// Очередь фоновых запросов
let attemptedOrderIds = new Set(); // Защита от повторных запросов в текущей сессии
let pendingFetchIds   = new Set(); // Очередь ID на дозагрузку
let fetchTimeout      = null;
let isFetching        = false;
let lastSalesSyncTime = 0;         // Троттлинг авто-синхронизации продаж (не чаще 1 раза в 60 сек)

// ─── Инициализация ──────────────────────────────────────────
async function init() {
  injectStyles();

  // Загружаем кэш заказов и состояние селектора
  const res = await new Promise(r => chrome.storage.local.get([STORAGE_KEY, ORDERS_CACHE_KEY], r));
  ordersCache = res[ORDERS_CACHE_KEY] || {};
  selectorActive = !!res[STORAGE_KEY];

  // Инициализируем наблюдатель DOM с дебаунсом
  setupObserver();

  // Первичная обработка видимых строк
  enrichVisibleRows();

  if (selectorActive) {
    activate();
  }
}

init();

// ─── Слушатели хранилища и сообщений ────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes[ORDERS_CACHE_KEY] !== undefined) {
    ordersCache = changes[ORDERS_CACHE_KEY].newValue || {};
    updateVisibleRowsBadges();
    if (panelEl) updatePanel();
  }

  if (changes[STORAGE_KEY] !== undefined) {
    const newState = !!changes[STORAGE_KEY].newValue;
    if (newState !== selectorActive) {
      selectorActive = newState;
      selectorActive ? activate() : deactivate();
    }
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'toggle_finance_selector') {
    selectorActive = msg.enabled;
    chrome.storage.local.set({ [STORAGE_KEY]: selectorActive });
    selectorActive ? activate() : deactivate();
  }
});

// ─── Наблюдатель за DOM (с дебаунсом и фильтрацией) ───────────
function setupObserver() {
  if (mainObserver) return;

  mainObserver = new MutationObserver((mutations) => {
    if (isUpdatingDOM) return;

    let hasRelevantChanges = false;
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length > 0) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) {
            // Игнорируем собственные элементы интерфейса расширения
            if (node.id === 'fp-corner-panel' || 
                node.classList?.contains('fp-sel-btn') || 
                node.classList?.contains('fp-order-details')) {
              continue;
            }
            // Проверяем, добавились ли строки или таблица
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
      enrichVisibleRows();
      if (selectorActive) {
        processVisibleRows();
      }
    });
  }, 80);
}

// ─── Активация селектора ─────────────────────────────────────
async function activate() {
  injectStyles();

  const stored = await new Promise(r => chrome.storage.local.get([SELECTED_KEY, ORDERS_CACHE_KEY], r));
  selectedItems = new Map(Object.entries(stored[SELECTED_KEY] || {}));
  ordersCache = stored[ORDERS_CACHE_KEY] || {};

  enrichVisibleRows();
  processVisibleRows();
  createPanel();
}

// ─── Деактивация селектора ───────────────────────────────────
function deactivate() {
  isUpdatingDOM = true;
  try {
    document.querySelectorAll('.fp-sel-btn').forEach(b => b.remove());
    document.querySelectorAll('.tc-item').forEach(row => {
      row.removeAttribute('data-fp-done');
      row.classList.remove('fp-link-selected');
      row.style.position = '';
    });
  } finally {
    isUpdatingDOM = false;
  }
  selectedItems.clear();
  saveSelected();
  if (panelEl) { panelEl.remove(); panelEl = null; }
}

// ─── Сохранение выбранных элементов ──────────────────────────
function saveSelected() {
  const obj = {};
  selectedItems.forEach((val, key) => { obj[key] = val; });
  chrome.storage.local.set({ [SELECTED_KEY]: obj });
}

// ─── Извлечение ID заказа из строки транзакции ───────────────
function extractOrderId(row) {
  // 1. Поиск ссылки на страницу заказа (/orders/ABC12345/)
  const orderLink = row.querySelector('a[href*="/orders/"]');
  if (orderLink) {
    const href = orderLink.getAttribute('href') || '';
    const m = href.match(/\/orders\/([A-Za-z0-9]+)/i);
    if (m && m[1] && m[1].toLowerCase() !== 'trade') {
      return m[1].toUpperCase();
    }
  }

  // 2. Поиск по тексту в заголовке / описании
  const titleEl = row.querySelector('.tc-desc .tc-title') || row.querySelector('.tc-title') || row.querySelector('.tc-desc');
  if (titleEl) {
    const text = titleEl.textContent || '';
    const m = text.match(/#([A-Za-z0-9]{4,16})\b/);
    if (m && m[1]) {
      return m[1].toUpperCase();
    }
  }

  // 3. Проверка data-атрибутов
  const dataOrder = row.getAttribute('data-order');
  if (dataOrder) {
    return dataOrder.replace('#', '').trim().toUpperCase();
  }

  return null;
}

// ─── Обогащение строк данными о товаре/покупателе ────────────
function enrichVisibleRows(forceAll = false) {
  isUpdatingDOM = true;
  try {
    const selector = forceAll ? '.tc-item' : '.tc-item:not([data-fp-enriched])';
    document.querySelectorAll(selector).forEach(row => {
      enrichFinanceRow(row);
    });
  } finally {
    isUpdatingDOM = false;
  }
}

function enrichFinanceRow(row) {
  const orderId = extractOrderId(row);
  if (!orderId) {
    row.setAttribute('data-fp-enriched', '1');
    return;
  }

  const descEl = row.querySelector('.tc-desc') || row.querySelector('.tc-title')?.parentElement;
  if (!descEl) {
    row.setAttribute('data-fp-enriched', '1');
    return;
  }

  let detailsEl = descEl.querySelector('.fp-order-details');
  if (!detailsEl) {
    detailsEl = document.createElement('div');
    detailsEl.className = 'fp-order-details';
    descEl.appendChild(detailsEl);
  }

  const currentLoaded = detailsEl.getAttribute('data-order-loaded');
  const order = ordersCache[orderId];

  if (order && (order.title || order.user)) {
    if (currentLoaded === `${orderId}_done`) {
      row.setAttribute('data-fp-enriched', '1');
      return;
    }
    const titleText = order.title || 'Товар без названия';
    const shortTitle = titleText.length > 48 ? titleText.slice(0, 45) + '…' : titleText;
    const buyerText = order.user || '—';

    detailsEl.innerHTML = `
      ${order.title ? `<span class="fp-badge-title" title="${esc(titleText)}">📦 <b>${esc(shortTitle)}</b></span>` : ''}
      ${order.user ? `<span class="fp-badge-buyer" title="Покупатель: ${esc(buyerText)}">👤 <b>${esc(buyerText)}</b></span>` : ''}
      <a class="fp-badge-link" href="https://funpay.com/orders/${esc(orderId)}/" target="_blank" title="Открыть страницу заказа #${esc(orderId)}">#${esc(orderId)} ↗</a>
    `;
    detailsEl.setAttribute('data-order-loaded', `${orderId}_done`);
  } else {
    // Если заказ помечен как notFound или уже проверялся
    if (currentLoaded === `${orderId}_link` || currentLoaded === `${orderId}_done`) {
      row.setAttribute('data-fp-enriched', '1');
      return;
    }
    detailsEl.innerHTML = `
      <a class="fp-badge-link" href="https://funpay.com/orders/${esc(orderId)}/" target="_blank" title="Открыть страницу заказа #${esc(orderId)}">📦 #${esc(orderId)} ↗</a>
    `;
    detailsEl.setAttribute('data-order-loaded', `${orderId}_link`);

    // Ставим в очередь только если ранее не запрашивали
    if (!order?.notFound && !attemptedOrderIds.has(orderId)) {
      queueOrderForFetch(orderId);
    }
  }

  row.setAttribute('data-fp-enriched', '1');
}

// ─── Точечное обновление бейджей без повторного запроса ──────
function updateVisibleRowsBadges() {
  isUpdatingDOM = true;
  try {
    document.querySelectorAll('.tc-item').forEach(row => {
      const orderId = extractOrderId(row);
      if (!orderId) return;

      const order = ordersCache[orderId];
      if (!order || (!order.title && !order.user)) return;

      const descEl = row.querySelector('.tc-desc') || row.querySelector('.tc-title')?.parentElement;
      if (!descEl) return;

      let detailsEl = descEl.querySelector('.fp-order-details');
      if (!detailsEl) {
        detailsEl = document.createElement('div');
        detailsEl.className = 'fp-order-details';
        descEl.appendChild(detailsEl);
      }

      if (detailsEl.getAttribute('data-order-loaded') !== `${orderId}_done`) {
        const titleText = order.title || 'Товар без названия';
        const shortTitle = titleText.length > 48 ? titleText.slice(0, 45) + '…' : titleText;
        const buyerText = order.user || '—';

        detailsEl.innerHTML = `
          ${order.title ? `<span class="fp-badge-title" title="${esc(titleText)}">📦 <b>${esc(shortTitle)}</b></span>` : ''}
          ${order.user ? `<span class="fp-badge-buyer" title="Покупатель: ${esc(buyerText)}">👤 <b>${esc(buyerText)}</b></span>` : ''}
          <a class="fp-badge-link" href="https://funpay.com/orders/${esc(orderId)}/" target="_blank" title="Открыть страницу заказа #${esc(orderId)}">#${esc(orderId)} ↗</a>
        `;
        detailsEl.setAttribute('data-order-loaded', `${orderId}_done`);
      }
    });
  } finally {
    isUpdatingDOM = false;
  }
}

// ─── Очередь и контролируемая фоновая подгрузка ───────────────
function queueOrderForFetch(orderId) {
  if (!orderId || attemptedOrderIds.has(orderId) || pendingFetchIds.has(orderId)) return;
  const cached = ordersCache[orderId];
  if (cached && (cached.title || cached.notFound)) return;

  pendingFetchIds.add(orderId);

  if (!fetchTimeout) {
    fetchTimeout = setTimeout(processFetchQueue, 400);
  }
}

async function processFetchQueue() {
  fetchTimeout = null;
  if (isFetching || pendingFetchIds.size === 0) return;
  isFetching = true;

  try {
    const idsToProcess = Array.from(pendingFetchIds).slice(0, 10);
    idsToProcess.forEach(id => {
      pendingFetchIds.delete(id);
      attemptedOrderIds.add(id);
    });

    // 1. Быстрая пакетная синхронизация со страницы продаж (не чаще 1 раза в 60 сек)
    const now = Date.now();
    if (now - lastSalesSyncTime > 60000) {
      lastSalesSyncTime = now;
      await syncOrdersFromSales(false);
    }

    // 2. Проверяем, какие заказы всё ещё не найдены
    const missingIds = idsToProcess.filter(id => {
      const o = ordersCache[id];
      return !o || (!o.title && !o.user && !o.notFound);
    });

    if (missingIds.length > 0) {
      // Дозагружаем строго до 5 заказов с паузой 500мс
      const toFetchIndividually = missingIds.slice(0, 5);
      const harvested = [];
      const notFoundIds = [];

      for (const id of toFetchIndividually) {
        const orderData = await fetchSingleOrder(id);
        if (orderData && (orderData.title || orderData.user)) {
          harvested.push(orderData);
        } else {
          notFoundIds.push(id);
        }
        await new Promise(r => setTimeout(r, 500));
      }

      // Пакетно сохраняем в кэш
      if (harvested.length > 0 || notFoundIds.length > 0) {
        await saveOrdersToCache(harvested, notFoundIds);
      }
    }
  } catch (e) {
    console.warn('[FunPay Finance] Error in fetch queue:', e);
  } finally {
    isFetching = false;
    updateVisibleRowsBadges();

    // Если остались заказы, планируем следующую порцию через 1.5 сек
    if (pendingFetchIds.size > 0) {
      fetchTimeout = setTimeout(processFetchQueue, 1500);
    }
  }
}

// ─── Синхронизация заказов со страницы продаж (/orders/trade) ─
async function syncOrdersFromSales(showStatus = true) {
  try {
    if (showStatus) updateSyncButtonState('loading');

    const resp = await fetch('https://funpay.com/orders/trade', { credentials: 'include' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
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

      if (title || user) {
        harvested.push({ id, title, user, price, priceStr: priceRaw, status, date });
      }
    });

    if (harvested.length > 0) {
      await saveOrdersToCache(harvested);
      updateVisibleRowsBadges();
      if (panelEl) updatePanel();
    }

    if (showStatus) updateSyncButtonState('success', harvested.length);
  } catch (err) {
    console.warn('[FunPay Finance] Could not sync from /orders/trade:', err);
    if (showStatus) updateSyncButtonState('error');
  }
}

// ─── Подгрузка страницы отдельного заказа ────────────────────
async function fetchSingleOrder(orderId) {
  if (!orderId) return null;
  try {
    const resp = await fetch(`https://funpay.com/orders/${orderId}/`, { credentials: 'include' });
    if (!resp.ok) return null;
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const title = doc.querySelector('.order-desc div')?.textContent?.trim() ||
                  doc.querySelector('.order-desc')?.textContent?.trim() ||
                  doc.querySelector('.param-item div.text-bold')?.textContent?.trim() ||
                  doc.querySelector('.param-item .param-item-value')?.textContent?.trim() ||
                  '';

    const user = doc.querySelector('.media-user-name span')?.textContent?.trim() ||
                 doc.querySelector('.media-user-name')?.textContent?.trim() ||
                 doc.querySelector('a[href*="/users/"] span')?.textContent?.trim() ||
                 doc.querySelector('a[href*="/users/"]')?.textContent?.trim() ||
                 '';

    const status = doc.querySelector('.tc-status')?.textContent?.trim() || '';

    if (title || user) {
      return { id: orderId, title, user, status };
    }
    return null;
  } catch (err) {
    console.warn(`[FunPay Finance] Could not fetch order #${orderId}:`, err);
    return null;
  }
}

// ─── Сохранение заказов в кэш ────────────────────────────────
async function saveOrdersToCache(ordersList = [], notFoundList = []) {
  if (!ordersList.length && !notFoundList.length) return;
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
          notFound: false,
          updatedAt: Date.now()
        };
        changed = true;
      }
    });

    notFoundList.forEach(id => {
      if (!id) return;
      if (!cache[id] || !cache[id].title) {
        cache[id] = {
          id: id,
          title: '',
          user: '',
          notFound: true,
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
    console.warn('[FunPay Finance] Failed to update orders cache:', e);
  }
}

// ─── Обработка строк таблицы финансов (кнопки выбора) ────────
function processVisibleRows() {
  if (!selectorActive) return;

  const newRows = document.querySelectorAll('.tc-item:not([data-fp-done])');
  if (newRows.length === 0) return;

  isUpdatingDOM = true;
  try {
    newRows.forEach(row => {
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

      row.style.position = 'relative';

      const btn = document.createElement('button');
      btn.className = 'fp-sel-btn';
      btn.type = 'button';
      btn.title = 'Выбрать операцию';
      const isOn = selectedItems.has(id);
      btn.innerHTML = isOn ? '✓' : '+';
      if (isOn) { 
        btn.classList.add('on'); 
        row.classList.add('fp-link-selected'); 
      }
      row.appendChild(btn);

      btn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        
        const currentOrder = orderId ? ordersCache[orderId] : null;
        toggleItem(id, {
          price,
          priceStr: priceRaw,
          title,
          requisites,
          status,
          date,
          isWithdrawal: price < 0,
          orderId: orderId || '',
          orderTitle: currentOrder?.title || '',
          buyer: currentOrder?.user || ''
        }, this, row);
      });
    });
  } finally {
    isUpdatingDOM = false;
  }
}

// ─── Переключить строку ──────────────────────────────────────
function toggleItem(id, data, btn, row) {
  if (selectedItems.has(id)) {
    selectedItems.delete(id);
    btn.innerHTML = '+';
    btn.classList.remove('on');
    row.classList.remove('fp-link-selected');
  } else {
    selectedItems.set(id, data);
    btn.innerHTML = '✓';
    btn.classList.add('on');
    row.classList.add('fp-link-selected');
  }
  saveSelected();
  updatePanel();
}

// ─── Создание угловой панели ─────────────────────────────────
function createPanel() {
  if (panelEl) return;

  panelEl = document.createElement('div');
  panelEl.id = 'fp-corner-panel';
  panelEl.innerHTML = `
    <div id="fp-cp-header">
      <span>💰 Выбор финансов</span>
    </div>

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
      <button id="fp-cp-copy" title="Скопировать выбранные операции в буфер обмена">📋 Копировать</button>
      <button id="fp-cp-sync" title="Синхронизировать данные о заказах со страницы продаж">🔄 Синхр.</button>
      <button id="fp-cp-clear" title="Снять выбор">✕ Сброс</button>
    </div>
  `;
  document.body.appendChild(panelEl);

  // Кнопка сброса
  document.getElementById('fp-cp-clear').addEventListener('click', () => {
    document.querySelectorAll('.fp-sel-btn.on').forEach(b => {
      b.innerHTML = '+';
      b.classList.remove('on');
      b.closest('.tc-item')?.classList.remove('fp-link-selected');
    });
    selectedItems.clear();
    saveSelected();
    updatePanel();
  });

  // Кнопка синхронизации заказов
  document.getElementById('fp-cp-sync').addEventListener('click', () => {
    syncOrdersFromSales(true);
  });

  // Кнопка копирования
  document.getElementById('fp-cp-copy').addEventListener('click', () => {
    if (!selectedItems.size) return;
    const rows = [...selectedItems.entries()].map(([id, o]) => {
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

  updatePanel();
}

// ─── Обновление состояния кнопки синхронизации ───────────────
function updateSyncButtonState(state, count = 0) {
  const btn = document.getElementById('fp-cp-sync');
  if (!btn) return;

  if (state === 'loading') {
    btn.textContent = '⏳ Загрузка...';
    btn.disabled = true;
  } else if (state === 'success') {
    btn.textContent = `✅ +${count}`;
    btn.disabled = false;
    setTimeout(() => { if (btn) btn.textContent = '🔄 Синхр.'; }, 2200);
  } else if (state === 'error') {
    btn.textContent = '❌ Ошибка';
    btn.disabled = false;
    setTimeout(() => { if (btn) btn.textContent = '🔄 Синхр.'; }, 2200);
  }
}

// ─── Обновление панели ───────────────────────────────────────
function updatePanel() {
  const countEl = document.getElementById('fp-cp-count');
  const posEl   = document.getElementById('fp-fin-pos');
  const negEl   = document.getElementById('fp-fin-neg');
  const totalEl = document.getElementById('fp-fin-total');
  const listEl  = document.getElementById('fp-cp-list');
  if (!countEl) return;

  const n = selectedItems.size;
  const items = [...selectedItems.values()];
  const posSum = items.filter(o => o.price > 0).reduce((s, o) => s + o.price, 0);
  const negSum = items.filter(o => o.price < 0).reduce((s, o) => s + o.price, 0);
  const total  = posSum + negSum;

  countEl.textContent = n === 0 ? 'Ничего не выбрано' : `${n} операци${plural(n)}`;
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

// ─── Утилиты ─────────────────────────────────────────────────
function fmt(n) {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function plural(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'я';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'и';
  return 'й';
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

    /* ── Кнопка выбора ── */
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
      border-color: #3498db;
      color: #3498db;
      background: rgba(52,152,219,0.15);
      transform: translateY(-50%) scale(1.08);
    }
    .fp-sel-btn.on {
      color: #fff !important;
      border-color: #3498db !important;
      background: #3498db !important;
      box-shadow: 0 2px 10px rgba(52,152,219,0.4) !important;
    }

    /* Выделенная строка */
    .tc-item.fp-link-selected {
      background: rgba(52, 152, 219, 0.08) !important;
      border-left: 3px solid #3498db !important;
    }

    /* ── Угловая панель ── */
    #fp-corner-panel {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999999;
      width: 290px;
      background: #1a1a2e;
      border: 1px solid rgba(52,152,219,0.3);
      border-radius: 14px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.55);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #eee;
      overflow: hidden;
    }
    #fp-cp-header {
      background: #162447;
      padding: 10px 14px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.3px;
      color: #ccc;
      display: flex;
      justify-content: space-between;
      align-items: center;
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
      margin-bottom: 2px;
      line-height: 1.3;
    }

    #fp-cp-actions {
      display: flex;
      gap: 6px;
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
    #fp-cp-copy  { background: #0f3460; color: #fff; flex: 1.2 !important; }
    #fp-cp-sync  { background: #162447; color: #4ecca3; border: 1px solid rgba(78,204,163,0.3) !important; }
    #fp-cp-clear { background: #3a0f0f; color: #e9a0a0; flex: 0.8 !important; }
  `;
  document.head.appendChild(styleEl);
}
