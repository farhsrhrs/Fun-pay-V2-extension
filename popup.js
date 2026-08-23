document.addEventListener('DOMContentLoaded', () => {
  const status = document.getElementById('status');
  const resultsWrapper = document.getElementById('resultsWrapper');
  const resultsList = document.getElementById('resultsList');
  const loader = document.getElementById('loader');

  // ─── Тоггл выбора заказов (Продажи) ────────────────────────
  const orderSelectorBtn = document.getElementById('orderSelectorToggle');
  const updateOrderSelectorBtn = (enabled) => {
    if (enabled) {
      orderSelectorBtn.classList.add('active');
      orderSelectorBtn.innerHTML = `<span id="orderSelectorIcon">🟢</span> Выбор заказов (Продажи): ВКЛ`;
    } else {
      orderSelectorBtn.classList.remove('active');
      orderSelectorBtn.innerHTML = `<span id="orderSelectorIcon">⚪</span> Выбор заказов (Продажи): ВЫКЛ`;
    }
  };

  // ─── Тоггл выбора финансов (Баланс) ─────────────────────────
  const financeSelectorBtn = document.getElementById('financeSelectorToggle');
  const updateFinanceSelectorBtn = (enabled) => {
    if (enabled) {
      financeSelectorBtn.classList.add('active');
      financeSelectorBtn.innerHTML = `<span id="financeSelectorIcon">🔵</span> Выбор финансов (Баланс): ВКЛ`;
    } else {
      financeSelectorBtn.classList.remove('active');
      financeSelectorBtn.innerHTML = `<span id="financeSelectorIcon">⚪</span> Выбор финансов (Баланс): ВЫКЛ`;
    }
  };

  chrome.storage.local.get(['orderSelectorEnabled', 'financeSelectorEnabled'], (res) => {
    updateOrderSelectorBtn(!!res.orderSelectorEnabled);
    updateFinanceSelectorBtn(!!res.financeSelectorEnabled);
  });

  orderSelectorBtn.addEventListener('click', () => {
    chrome.storage.local.get(['orderSelectorEnabled'], (res) => {
      const newState = !res.orderSelectorEnabled;
      chrome.storage.local.set({ orderSelectorEnabled: newState });
      updateOrderSelectorBtn(newState);

      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          if (tab.url && tab.url.includes('funpay.com')) {
            chrome.tabs.sendMessage(tab.id, { action: 'toggle_order_selector', enabled: newState }).catch(() => {});
          }
        });
      });

      status.textContent = newState ? 'Выбор заказов: ВКЛ' : 'Выбор заказов: ВЫКЛ';
      setTimeout(() => { status.textContent = 'Готов к работе'; }, 2000);
    });
  });

  financeSelectorBtn.addEventListener('click', () => {
    chrome.storage.local.get(['financeSelectorEnabled'], (res) => {
      const newState = !res.financeSelectorEnabled;
      chrome.storage.local.set({ financeSelectorEnabled: newState });
      updateFinanceSelectorBtn(newState);

      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          if (tab.url && tab.url.includes('funpay.com')) {
            chrome.tabs.sendMessage(tab.id, { action: 'toggle_finance_selector', enabled: newState }).catch(() => {});
          }
        });
      });

      status.textContent = newState ? 'Выбор финансов: ВКЛ' : 'Выбор финансов: ВЫКЛ';
      setTimeout(() => { status.textContent = 'Готов к работе'; }, 2000);
    });
  });
  // ────────────────────────────────────────────────────────────


  const urlKeys = ['urlNitro', 'urlNitroBasic', 'urlSpotifyIndividual', 'urlSpotifyDuo', 'urlSpotifyFamily'];
  const inputs = {};
  urlKeys.forEach(key => inputs[key] = document.getElementById(key));
  
  const saveUrlsBtn = document.getElementById('saveUrls');
  const scanAllBtn = document.getElementById('scanAll');
  
  const autoUpdateToggle = document.getElementById('autoUpdateToggle');
  const updateIntervalInput = document.getElementById('updateInterval');

  // 1. Загружаем все данные из хранилища
  chrome.storage.local.get(['all_results', 'autoUpdate', 'updateInterval', ...urlKeys], (result) => {
    // Восстанавливаем результаты всех лотов
    if (result.all_results) {
      renderAllResults(result.all_results);
    }
    
    // Восстанавливаем ссылки
    urlKeys.forEach(key => {
      if (result[key]) inputs[key].value = result[key];
    });

    // Восстанавливаем состояние авто-обновления (ВАЖНО)
    if (result.autoUpdate !== undefined) {
        autoUpdateToggle.checked = result.autoUpdate;
    }
    if (result.updateInterval) {
        updateIntervalInput.value = result.updateInterval;
    }
  });

  // Сохранение настроек
  const saveSettings = () => {
    const toSave = {
        autoUpdate: autoUpdateToggle.checked,
        updateInterval: parseInt(updateIntervalInput.value) || 5
    };
    urlKeys.forEach(key => toSave[key] = inputs[key].value.trim());
    
    chrome.storage.local.set(toSave, () => {
      status.textContent = "Настройки сохранены";
      
      // Обновляем таймер в фоне
      if (autoUpdateToggle.checked) {
          chrome.runtime.sendMessage({ action: "start_auto_timer", intervalMinutes: toSave.updateInterval });
      } else {
          chrome.runtime.sendMessage({ action: "stop_auto_timer" });
      }

      setTimeout(() => { status.textContent = "Готов к работе"; }, 2000);
    });
  };

  saveUrlsBtn.addEventListener('click', saveSettings);

  // Обработка кнопок быстрого времени
  document.querySelectorAll('.btn-time').forEach(btn => {
      btn.addEventListener('click', () => {
          updateIntervalInput.value = btn.getAttribute('data-time');
          autoUpdateToggle.checked = true; // При выборе времени обычно хотят сразу включить
          saveSettings();
      });
  });

  // Обработка переключателя (чтобы сразу сохранялось при клике)
  autoUpdateToggle.addEventListener('change', saveSettings);

  // 2. Функция отрисовки всех результатов (столбиком)
  const renderAllResults = (allData) => {
    if (!resultsList || !resultsWrapper) return;
    
    loader.style.display = 'none';
    resultsWrapper.style.display = 'block';
    resultsList.innerHTML = '';

    const lotNames = Object.keys(allData);
    if (lotNames.length === 0) {
        resultsWrapper.style.display = 'none';
        return;
    }

    lotNames.forEach(lotName => {
        const data = allData[lotName];
        if (!data || data.length === 0) return;

        const lotSection = document.createElement('div');
        lotSection.className = 'lot-result-section';
        lotSection.style.marginBottom = '20px';
        lotSection.style.border = '1px solid #1a1a2e';
        lotSection.style.borderRadius = '8px';
        lotSection.style.padding = '10px';
        lotSection.style.background = 'rgba(255,255,255,0.02)';

        let tableHtml = `
            <div style="font-size: 11px; font-weight: bold; color: var(--primary); margin-bottom: 8px; border-bottom: 1px solid #333; padding-bottom: 4px;">
                ${lotName}
            </div>
            <table style="width: 100%; border-collapse: collapse; font-size: 10px;">
                <thead>
                    <tr style="text-align: left; color: #888;">
                        <th style="padding: 4px;">Статус</th>
                        <th style="padding: 4px;">Продавец</th>
                        <th style="padding: 4px;">Цена</th>
                    </tr>
                </thead>
                <tbody>
        `;

        data.forEach(item => {
            if (item.error) {
                tableHtml += `<tr><td colspan="3" style="color: #e94560; padding: 10px;">${item.error}</td></tr>`;
                return;
            }

            let badgeLabel = "";
            let badgeClass = "";
            if (item.position === "Lower Price") { badgeLabel = "ДЕШЕВЛЕ"; badgeClass = "badge-lower"; }
            else if (item.position.includes("OURS")) { 
                badgeLabel = item.position.includes("OFFLINE") ? "ВЫ (OFF)" : "ЭТО ВЫ"; 
                badgeClass = "badge-ours"; 
            }
            else { badgeLabel = "ДОРОЖЕ"; badgeClass = "badge-higher"; }

            let trendIcon = "";
            if (item.trend === "down") trendIcon = ' <span style="color: #4eca00;">▼</span>';
            else if (item.trend === "up") trendIcon = ' <span style="color: #e94560;">▲</span>';

            const timeStr = item.lastUpdate ? `<div style="font-size: 8px; color: #666;">${item.lastUpdate}</div>` : "";
            const descStr = item.desc ? `<div style="font-size: 9px; color: #aaa; font-style: italic; margin-top: 4px; border-top: 1px solid #222; padding-top: 2px;">${item.desc}</div>` : "";

            tableHtml += `
                <tr style="${item.position.includes("OURS") ? 'background: rgba(78, 204, 163, 0.05);' : ''}">
                    <td style="padding: 6px 4px; vertical-align: top;"><span class="badge ${badgeClass}" style="font-size: 8px;">${badgeLabel}</span></td>
                    <td style="padding: 6px 4px; vertical-align: top;"><div class="seller" style="max-width: 80px;">${item.seller}</div></td>
                    <td style="padding: 6px 4px; vertical-align: top; font-weight: bold;">
                        ${item.price} ₽ ${trendIcon} 
                        ${timeStr}
                        ${descStr}
                    </td>
                </tr>
            `;
        });

        tableHtml += `</tbody></table>`;
        lotSection.innerHTML = tableHtml;
        resultsList.appendChild(lotSection);
    });
  };

  // 3. Слушаем обновления от фонового скрипта
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "update_results") {
      // Когда приходит обновление, мы перерисовываем всё на основе нового состояния в storage
      chrome.storage.local.get(['all_results'], (res) => {
          renderAllResults(res.all_results || {});
      });
      status.textContent = "Обновлено";
    }
  });

  // Очистка
  document.getElementById('clearResults').addEventListener('click', () => {
    chrome.storage.local.remove(['all_results', 'price_history'], () => {
      resultsList.innerHTML = '';
      resultsWrapper.style.display = 'none';
      status.textContent = "Всё очищено";
    });
  });

  // Открыть FunPay
  document.getElementById('openFunPay').addEventListener('click', () => {
    chrome.tabs.create({ url: "https://funpay.com/lots/923/", active: true });
  });

  // Обработчики кнопок
  const startTrack = (filter, category = "discord") => {
    chrome.storage.local.get(urlKeys, (res) => {
        let key = "";
        if (filter === "Nitro") key = "urlNitro";
        else if (filter === "Nitro Basic") key = "urlNitroBasic";
        else if (filter === "Individual") key = "urlSpotifyIndividual";
        else if (filter === "Duo") key = "urlSpotifyDuo";
        else if (filter === "Family") key = "urlSpotifyFamily";

        const targetUrl = res[key];
        if (!targetUrl) {
            status.textContent = `Ошибка: Укажите ссылку на ${filter}!`;
            return;
        }
        chrome.runtime.sendMessage({ 
            action: "track_competitors", 
            filter: filter, 
            category: category,
            customUrl: targetUrl 
        });
        loader.style.display = 'block';
        status.textContent = `Анализ ${filter}...`;
    });
  };

  const executeScanAll = () => {
      chrome.runtime.sendMessage({ action: "trigger_scan_all" });
      status.textContent = "Запуск фонового сканирования...";
      setTimeout(() => { status.textContent = "Сканирование в процессе..."; }, 2000);
  };

  scanAllBtn.addEventListener('click', executeScanAll);

  document.getElementById('parseFinances').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: "start_finances" });
  });

  document.getElementById('parseOrders').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: "start_orders" });
  });

  document.getElementById('onDiscord').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: "toggle_lots", category: "discord", active: true });
  });

  document.getElementById('offDiscord').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: "toggle_lots", category: "discord", active: false });
  });

  document.getElementById('onSpotify').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: "toggle_lots", category: "spotify", active: true });
  });

  document.getElementById('offSpotify').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: "toggle_lots", category: "spotify", active: false });
  });

  document.getElementById('trackNitro').addEventListener('click', () => startTrack("Nitro", "discord"));
  document.getElementById('trackNitroBasic').addEventListener('click', () => startTrack("Nitro Basic", "discord"));
  document.getElementById('trackSpotifyIndividual').addEventListener('click', () => startTrack("Individual", "spotify"));
  document.getElementById('trackSpotifyDuo').addEventListener('click', () => startTrack("Duo", "spotify"));
  document.getElementById('trackSpotifyFamily').addEventListener('click', () => startTrack("Family", "spotify"));
});