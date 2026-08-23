if (!window.__funpay_parser_started__) {
  window.__funpay_parser_started__ = true;

  start();
}

async function start() {
  console.log("Parser started");

  await clickLoadMore();

  const data = parseOperations();

  console.log("DATA:", data);

  chrome.runtime.sendMessage({ orders: data });
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// анти-редирект стабилизация
async function clickLoadMore() {
  while (true) {
    const btn = document.querySelector('.dyn-table-continue');
    if (!btn) break;

    btn.click();
    await wait(1500);
  }
}

function parseOperations() {
  let ops = [];

  document.querySelectorAll('.tc-item').forEach(el => {
    ops.push({
      title: el.querySelector('.tc-desc')?.innerText?.trim(),
      amount: el.querySelector('.tc-price')?.innerText?.trim(),
      user: el.querySelector('.tc-user')?.innerText?.trim()
    });
  });

  return ops;
}