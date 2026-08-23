import { MY_NICKNAME, FINANCE_STOP_TRANSACTION, ORDERS_STOP_ID, GOOGLE_SCRIPT_URL } from './config.js';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "start_finances") {
    runAutomation("https://funpay.com/account/balance", "finances");
  } else if (request.action === "start_orders") {
    runAutomation("https://funpay.com/orders/trade", "orders");
  } else if (request.action === "track_competitors") {
    const categoryUrl = request.category === "spotify" ? "https://funpay.com/lots/1217/" : "https://funpay.com/lots/923/";
    runAutomation(categoryUrl, "competitors", request.filter, request.customUrl);
  } else if (request.action === "start_auto_timer") {
    chrome.alarms.create("auto_scan_alarm", { periodInMinutes: Math.max(1, parseInt(request.intervalMinutes) || 5) });
  } else if (request.action === "stop_auto_timer") {
    chrome.alarms.clear("auto_scan_alarm");
  } else if (request.action === "trigger_scan_all") {
    executeScanAll();
  } else if (request.action === "toggle_lots") {
    const categoryUrls = { "discord": "https://funpay.com/lots/923/trade", "spotify": "https://funpay.com/lots/1217/trade" };
    const startUrl = categoryUrls[request.category];
    if (startUrl) processCategory(startUrl, request.active);
  }
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "auto_scan_alarm") {
    executeScanAll();
  }
});

async function executeScanAll() {
  const itemsToScan = [
    { f: "Nitro", c: "discord", k: "urlNitro" },
    { f: "Nitro Basic", c: "discord", k: "urlNitroBasic" },
    { f: "Individual", c: "spotify", k: "urlSpotifyIndividual" },
    { f: "Duo", c: "spotify", k: "urlSpotifyDuo" },
    { f: "Family", c: "spotify", k: "urlSpotifyFamily" }
  ];

  const storage = await chrome.storage.local.get(itemsToScan.map(i => i.k));

  for (const item of itemsToScan) {
    const customUrl = storage[item.k];
    if (!customUrl) continue;

    const categoryUrl = item.c === "spotify" ? "https://funpay.com/lots/1217/" : "https://funpay.com/lots/923/";
    const myPrice = await getPriceFromEditPage(customUrl);

    // ВАЖНО: Мы не ждем завершения, но делаем паузу между запуском лотов
    executeCompetitorsFlow(categoryUrl, item.f, myPrice);
    await new Promise(r => setTimeout(r, 15000));
  }
}

async function playNotificationSound() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Notification for price change'
    });
  } catch (e) {
    // Document might already exist
  }
  chrome.runtime.sendMessage({ action: 'play_sound' });

  setTimeout(() => {
    chrome.offscreen.closeDocument().catch(() => { });
  }, 5000);
}

function showBrowserNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    title: title,
    message: message,
    priority: 2
  });
}

async function runAutomation(url, type, filter, customUrl) {
  if (type === "competitors") {
    const myPrice = await getPriceFromEditPage(customUrl);
    executeCompetitorsFlow(url, filter, myPrice);
    return;
  }
  const tab = await chrome.tabs.create({ url: url, active: false });
  chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
    if (tabId === tab.id && info.status === 'complete') {
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(() => {
        if (type === "finances") executeFinances(tabId);
        else if (type === "orders") executeOrders(tabId);
      }, 2500);
    }
  });
}

async function getPriceFromEditPage(url) {
  if (!url) return null;
  const tab = await chrome.tabs.create({ url: url, active: false });
  return new Promise((resolve) => {
    chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(async () => {
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => {
                const input = document.querySelector('input[name="price"]');
                return input ? parseFloat(input.value) : null;
              }
            });
            chrome.tabs.remove(tab.id).catch(() => { });
            resolve(results[0].result);
          } catch (e) {
            chrome.tabs.remove(tab.id).catch(() => { });
            resolve(null);
          }
        }, 2000);
      }
    });
  });
}

async function executeCompetitorsFlow(url, filter, myPrice) {
  const tab = await chrome.tabs.create({ url: url, active: false });
  chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
    if (tabId === tab.id && info.status === 'complete') {
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(() => { executeCompetitors(tab.id, filter, myPrice); }, 2500);
    }
  });
}

async function executeFinances(tabId) {
  const targetText = FINANCE_STOP_TRANSACTION; // задаётся в config.js
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: async (target) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 50; i++) {
        const titles = Array.from(document.querySelectorAll('.tc-title'));
        if (titles.some(el => el.textContent.includes(target))) break;
        const moreBtn = document.querySelector('.dyn-table-continue');
        if (moreBtn && moreBtn.offsetParent !== null) { moreBtn.click(); await sleep(1500); } else break;
      }
      const items = document.querySelectorAll('.tc-item');
      const res = [];
      for (let item of items) {
        const titleText = item.querySelector('.tc-title')?.textContent.trim() || "";
        const transactionId = item.getAttribute('data-transaction') || "";
        let rawPrice = item.querySelector('.tc-price')?.textContent.replace(/[−-]/g, '').replace(/[^\d.]/g, '').replace('.', ',').trim() || "";
        const isWithdrawal = titleText.toLowerCase().includes("вывод");
        let priceForCashOut = (transactionId === target || titleText.includes(target)) ? "" : rawPrice;
        res.push({ id: transactionId, date: item.querySelector('.tc-date-time')?.textContent.trim() || "", title: titleText, val1: isWithdrawal ? "" : rawPrice, val2: item.querySelector('.unit')?.textContent.trim() || "₽", val3: isWithdrawal ? priceForCashOut : "", isCashOut: isWithdrawal, type: "FINANCE" });
        if (titleText.includes(target)) break;
      }
      return res;
    },
    args: [targetText]
  }).then(results => sendToGoogle(results[0].result, tabId));
}

async function executeOrders(tabId) {
  const targetOrderId = ORDERS_STOP_ID; // задаётся в config.js
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: async (target) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 50; i++) {
        const orderIds = Array.from(document.querySelectorAll('.tc-order'));
        if (orderIds.some(el => el.textContent.includes(target))) break;
        const moreBtn = document.querySelector('.dyn-table-continue');
        if (moreBtn && moreBtn.offsetParent !== null) { moreBtn.click(); await sleep(1500); } else break;
      }
      const rows = document.querySelectorAll('.tc-item');
      const res = [];
      for (let row of rows) {
        const idElem = row.querySelector('.tc-order');
        if (idElem) {
          const idText = idElem.textContent.trim().replace('#', '');
          let orderPrice = row.querySelector('.tc-price')?.textContent.replace(/[^\d.−-]/g, '').replace('.', ',').trim() || "";
          res.push({ id: idText, date: row.querySelector('.tc-date-time')?.textContent.trim() || "", title: row.querySelector('.order-desc div')?.textContent.trim() || "", val1: row.querySelector('.media-user-name')?.textContent.trim() || "", val2: row.querySelector('.tc-status')?.textContent.trim() || "", val3: orderPrice, type: "ORDER" });
          if (idText.includes(target)) break;
        }
      }
      return res;
    },
    args: [targetOrderId]
  }).then(async results => {
    const orders = results[0]?.result;
    if (orders && orders.length) {
      try {
        const storage = await chrome.storage.local.get(['fp_orders_cache']);
        const cache = storage.fp_orders_cache || {};
        orders.forEach(o => {
          if (o.id) {
            cache[o.id] = {
              id: o.id,
              title: o.title || (cache[o.id]?.title || ''),
              user: o.val1 || (cache[o.id]?.user || ''),
              status: o.val2 || (cache[o.id]?.status || ''),
              priceStr: o.val3 || (cache[o.id]?.priceStr || ''),
              date: o.date || (cache[o.id]?.date || ''),
              updatedAt: Date.now()
            };
          }
        });
        await chrome.storage.local.set({ fp_orders_cache: cache });
      } catch (e) {}
    }
    sendToGoogle(orders, tabId);
  });
}

async function executeCompetitors(tabId, filterName, myPriceFromTrade) {
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: async (fName, myPrice, MY_NICKNAME_PARAM) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      // --- ЭТАП 1: ПРИМЕНЕНИЕ ФИЛЬТРОВ ---

      // 1. Клик по категории (Nitro/Basic/Spotify)
      const categoryBtn = document.querySelector(`button[value="${fName}"]`);
      if (categoryBtn) {
        categoryBtn.click();
        await sleep(3500); // Ждем долго, чтобы AJAX успел сработать
      }

      // 2. Дополнительные фильтры (Только для Discord)
      if (fName.toLowerCase().includes("nitro")) {
        const methodSelect = document.querySelector('select[name="f-method"]');
        if (methodSelect) {
          methodSelect.value = "С заходом на аккаунт";
          methodSelect.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(3000);
        }
        const oldNitroSelect = document.querySelector('select[name="f-oldnitro"]');
        if (oldNitroSelect) {
          oldNitroSelect.value = "Да";
          oldNitroSelect.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(3000);
        }
      }

      // 3. Сортировка по цене
      const priceSortBtn = document.querySelector('.tc-price.sort');
      if (priceSortBtn) {
        priceSortBtn.click();
        await sleep(3000);
      }

      // --- ЭТАП 2: ПОДГРУЗКА И СБОР ---

      // 4. Подгружаем лоты
      for (let i = 0; i < 7; i++) {
        const moreBtn = document.querySelector('.dyn-table-continue');
        if (moreBtn && moreBtn.offsetParent !== null) {
          moreBtn.click();
          await sleep(1500);
        } else break;
      }

      // 5. Собираем данные (ТОЛЬКО ТЕ, ЧТО НЕ HIDDEN)
      // На FunPay лоты, не подходящие под фильтр, получают класс .hidden
      const rawItems = Array.from(document.querySelectorAll('a.tc-item:not(.hidden)'));
      const targetNickname = MY_NICKNAME_PARAM; // передаётся из background через args

      let allLots = rawItems.map(item => {
        const priceVal = parseFloat(item.querySelector('.tc-price')?.getAttribute('data-s')) || 0;
        return {
          seller: item.querySelector('.media-user-name')?.textContent.trim(),
          priceNum: priceVal,
          priceStr: priceVal.toFixed(2).replace('.', ','),
          desc: item.querySelector('.tc-desc')?.textContent.trim()
        };
      }).filter(l => l.seller); // Убираем пустые строки

      // 6. Математическая сортировка
      allLots.sort((a, b) => a.priceNum - b.priceNum);

      // 7. Поиск нашей позиции
      let ourIndex = allLots.findIndex(l => l.seller === targetNickname);
      let isVirtual = false;

      if (ourIndex === -1 && myPrice) {
        isVirtual = true;
        ourIndex = allLots.findIndex(l => l.priceNum > myPrice);
        if (ourIndex === -1) ourIndex = allLots.length;
      }

      if (ourIndex === -1) return [{ error: `Не найден лот K3ND0 или место для цены ${myPrice}`, type: "COMPETITORS", filter: fName }];

      // 8. Финальный результат
      const finalRes = [];
      const getDetails = (lot, pos) => ({ seller: lot.seller, price: lot.priceStr, desc: lot.desc, position: pos, filter: fName });

      for (let i = Math.max(0, ourIndex - 3); i < ourIndex; i++) {
        finalRes.push(getDetails(allLots[i], "Lower Price"));
      }

      if (isVirtual) {
        finalRes.push({ seller: targetNickname, price: myPrice.toFixed(2).replace('.', ','), desc: "Ваш лот (Offline)", position: "OURS (OFFLINE)", filter: fName });
      } else {
        finalRes.push(getDetails(allLots[ourIndex], "OURS"));
      }

      for (let i = ourIndex + (isVirtual ? 0 : 1); i < Math.min(allLots.length, ourIndex + (isVirtual ? 3 : 4)); i++) {
        if (allLots[i]) finalRes.push(getDetails(allLots[i], "Higher Price"));
      }

      return finalRes;
    },
    args: [filterName, myPriceFromTrade, MY_NICKNAME]
  }).then(async results => {
    const data = results[0].result;
    const storage = await chrome.storage.local.get(['price_history', 'all_results']);
    const history = storage.price_history || {};
    const allResults = storage.all_results || {};
    const now = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

    const enrichedData = data.map(item => {
      if (item.error) return item;
      const key = `${filterName}_${item.seller}`;
      const prevPriceStr = history[key];
      let trend = "";
      if (prevPriceStr) {
        const curr = parseFloat(item.price.replace(',', '.'));
        const prev = parseFloat(prevPriceStr.replace(',', '.'));
        if (curr < prev) {
          trend = "down";
          if (item.position === "Lower Price") {
            showBrowserNotification(`Снижение цены: ${filterName}`, `${item.seller} снизил до ${item.price} ₽`);
            playNotificationSound();
          }
        } else if (curr > prev) {
          trend = "up";
        }
      }
      history[key] = item.price;
      return { ...item, trend, lastUpdate: now };
    });

    allResults[filterName] = enrichedData;
    chrome.storage.local.set({ all_results: allResults, price_history: history }, () => {
      chrome.runtime.sendMessage({ action: "update_results" }).catch(() => { });
      sendToGoogle(enrichedData, tabId);
    });
  });
}

async function sendToGoogle(data, tabId) {
  const scriptUrl = GOOGLE_SCRIPT_URL; // задаётся в config.js
  try { if (data && data.length > 0) { await fetch(scriptUrl, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(data) }); } } catch (e) { }
  if (tabId) setTimeout(() => { chrome.tabs.remove(tabId).catch(() => { }); }, 1000);
}

// Слушатели теперь в начале файла

async function processCategory(url, shouldBeActive) {
  const mainTab = await chrome.tabs.create({ url: url, active: false });
  chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
    if (tabId === mainTab.id && info.status === 'complete') {
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.scripting.executeScript({ target: { tabId: tabId }, func: () => { return Array.from(document.querySelectorAll('a.tc-item')).map(a => a.href); } }).then(async (results) => {
        const offerUrls = results[0].result;
        chrome.tabs.remove(mainTab.id);
        for (const offerUrl of offerUrls) await manageSingleOffer(offerUrl, shouldBeActive);
      });
    }
  });
}

async function manageSingleOffer(url, shouldBeActive) {
  return new Promise(async (resolve) => {
    const tab = await chrome.tabs.create({ url: url, active: false });
    chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.scripting.executeScript({
          target: { tabId: tabId }, func: (activeState) => {
            const checkbox = document.querySelector('input[name="active"]');
            const saveBtn = document.querySelector('.js-btn-save');
            if (checkbox && saveBtn) {
              if (checkbox.checked !== activeState) { checkbox.click(); setTimeout(() => { saveBtn.click(); }, 400); return "Updated"; }
              return "Already in state";
            }
            return "Not found";
          }, args: [shouldBeActive]
        }).then(() => { setTimeout(() => { chrome.tabs.remove(tab.id); resolve(); }, 2500); });
      }
    });
  });
}