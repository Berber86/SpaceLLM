// market.js — рынок: эхо-копии, топливо, ресурсы (v3: + alloys tier-5)

import { subscribeMarket, incrementSaleCount } from "./firebase.js";
import {
  addToInventory, getUid,
  renderInventory, showToast,
  getFuelCapacity, getFuel, getFuelStorage,
  addCredits, spendCredits, getCredits,
  receiveFuelFromMarket, withdrawFuelForSale,
  addResources, spendResources,
  ITEM_SCHEMA_VERSION,
  renderEffectsDisplay,
} from "./player.js";

export const FUEL_MARKET = {
  buyPricePerLiter:  12,
  sellPricePerLiter: 7,
};

export function initMarket() {
  subscribeMarket(renderMarket);
  renderFuelMarket();
  renderResourceMarket();
}

// ─────────────────────────────────────────────────────────────
// ARTIFACT MARKET
// ─────────────────────────────────────────────────────────────

function renderMarket(items) {
  const list = document.getElementById("market-list");
  if (!list) return;

  const myUid = getUid();

  const artifactItems = (items ?? []).filter(i =>
    !i.isFuelListing &&
    !i.isResourceListing &&
    i.schemaVersion === ITEM_SCHEMA_VERSION
  );

  if (!artifactItems.length) {
    list.innerHTML = `
      <div class="empty-state">
        Нет артефактов на рынке (или лоты устарели после вайпа).
        Создайте в Кузне — эхо-копия появится здесь.
      </div>`;
    return;
  }

  list.innerHTML = artifactItems.map(item => {
    const isMine = item.authorUid === myUid;
    const sales  = item.salesCount ?? 0;
    const price  = item.price?.credits ?? 0;

    const salesBadge = sales >= 5
      ? `<span class="sales-badge ${sales >= 20 ? "hot" : "popular"}">
           ${sales >= 20 ? "🔥" : "📈"} ×${sales} продаж
         </span>`
      : "";

    // Тег типа модуля (показываем recipeType иконкой)
    const recipeTag = item.recipeType
      ? `<span class="recipe-tag">${recipeIcon(item.recipeType)}</span>`
      : "";

    return `
      <div class="market-card">
        <div class="market-card-header">
          <span class="artifact-rarity rarity-${item.rarity ?? "common"}">
            ${rarityLabel(item.rarity)}
          </span>
          ${recipeTag}
          ${salesBadge}
          <span class="echo-power">⚡ ${Math.round((item.echoPower ?? 0.6) * 100)}%</span>
        </div>

        <div class="artifact-name">${escHtml(item.name)}</div>
        <div class="artifact-desc">${escHtml(item.description ?? "")}</div>
        <div class="market-author">✍️ ${escHtml(item.authorName ?? "Неизвестный")}</div>

        <div class="artifact-stats">
          ${renderEffectsDisplay(item)}
        </div>

        ${item.specialEffect ? `
          <div class="special-effect-badge">
            <span class="se-icon">✨</span>
            <span>${escHtml(item.specialEffect.description ?? item.specialEffect.type)}</span>
          </div>` : ""}

        <div class="market-price">💰 ${price} кредитов</div>

        ${isMine
          ? `<button class="btn-secondary" disabled>Ваш артефакт</button>`
          : `<button class="btn-primary"
               onclick="window._buyEcho('${escHtml(item.id ?? "")}')">
               🛒 Купить (${price} кр.)
             </button>`}
      </div>
    `;
  }).join("");

  window._marketItems = artifactItems;
}

// ─────────────────────────────────────────────────────────────
// FUEL MARKET UI
// ─────────────────────────────────────────────────────────────

function renderFuelMarket() {
  const el = document.getElementById("fuel-market-section");
  if (!el) return;

  const fuel     = getFuel();
  const storage  = getFuelStorage();
  const capacity = getFuelCapacity();
  const credits  = getCredits();

  el.innerHTML = `
    <div class="market-section-title">⛽ Топливо</div>

    <div class="fuel-market-prices">
      <div class="fuel-price-card">
        <div class="fuel-price-label">Купить</div>
        <div class="fuel-price-value">${FUEL_MARKET.buyPricePerLiter} кр./л</div>
      </div>
      <div class="fuel-price-card sell">
        <div class="fuel-price-label">Продать</div>
        <div class="fuel-price-value">${FUEL_MARKET.sellPricePerLiter} кр./л</div>
      </div>
    </div>

    <div class="fuel-market-status">
      ⛽ В баке: ${Math.floor(fuel)}/${Math.round(capacity)}л
      · 📦 На складе: ${Math.floor(storage)}л
      · 💰 Кредиты: ${Math.floor(credits)}
    </div>

    <div class="fuel-market-controls">
      <div class="fuel-action-row">
        <label>Купить</label>
        <input type="number" id="fuel-buy-amount" min="1" value="50" style="width:90px">
        <span>л =</span>
        <span id="fuel-buy-cost" class="fuel-cost-preview">
          ${50 * FUEL_MARKET.buyPricePerLiter} кр.
        </span>
        <button class="btn-primary" style="width:auto;padding:6px 14px"
                onclick="window._buyFuel()">Купить</button>
      </div>

      <div class="fuel-action-row">
        <label>Продать</label>
        <input type="number" id="fuel-sell-amount" min="1" value="50" style="width:90px">
        <span>л =</span>
        <span id="fuel-sell-income" class="fuel-cost-preview sell">
          ${50 * FUEL_MARKET.sellPricePerLiter} кр.
        </span>
        <button class="btn-secondary" style="width:auto;padding:6px 14px"
                onclick="window._sellFuel()">Продать</button>
      </div>
    </div>
  `;

  document.getElementById("fuel-buy-amount")?.addEventListener("input", e => {
    const liters = parseInt(e.target.value) || 0;
    const cost   = document.getElementById("fuel-buy-cost");
    if (cost) cost.textContent = `${liters * FUEL_MARKET.buyPricePerLiter} кр.`;
  });

  document.getElementById("fuel-sell-amount")?.addEventListener("input", e => {
    const liters = parseInt(e.target.value) || 0;
    const income = document.getElementById("fuel-sell-income");
    if (income) income.textContent = `${liters * FUEL_MARKET.sellPricePerLiter} кр.`;
  });
}

// ─────────────────────────────────────────────────────────────
// RESOURCE MARKET UI
// ─────────────────────────────────────────────────────────────

// ── alloys добавлены: дорогие (боевые сплавы редкие) ─────────
const RESOURCE_PRICES = {
  isotopes: { buy: 10,     sell: 7     },
  minerals: { buy: 100,    sell: 75    },
  metals:   { buy: 1000,   sell: 800   },
  data:     { buy: 10000,  sell: 8500  },
  alloys:   { buy: 25000,  sell: 20000 }, // ← tier-5
};

function renderResourceMarket() {
  const el = document.getElementById("resource-market-section");
  if (!el) return;

  el.innerHTML = `
    <div class="market-section-title">🪨 Ресурсы</div>
    <div class="resource-market-grid">
      ${Object.entries(RESOURCE_PRICES).map(([res, prices]) => `
        <div class="resource-market-card">
          <div class="resource-market-name">${resIcon(res)} ${resLabel(res)}</div>
          <div class="resource-market-prices">
            <span class="buy-price">▲ ${prices.buy} кр.</span>
            <span class="sell-price">▼ ${prices.sell} кр.</span>
          </div>
          <div class="resource-market-controls">
            <input type="number" id="res-amount-${res}"
                   min="1" value="10" style="width:60px">
            <button class="btn-mini-buy"
                    onclick="window._buyResource('${res}')">Купить</button>
            <button class="btn-mini-sell"
                    onclick="window._sellResource('${res}')">Продать</button>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// BUY / SELL FUEL
// ─────────────────────────────────────────────────────────────

window._buyFuel = async function() {
  const liters = parseInt(document.getElementById("fuel-buy-amount")?.value) || 0;
  if (liters <= 0) return;

  const totalCost = liters * FUEL_MARKET.buyPricePerLiter;
  const ok        = await spendCredits(totalCost);

  if (!ok) {
    showToast(`💰 Нужно ${totalCost} кредитов. Есть: ${Math.floor(getCredits())}`, "warning");
    return;
  }

  const res = await receiveFuelFromMarket(liters);
  if (res.toTank > 0 && res.toStorage > 0) {
    showToast(`⛽ Куплено ${liters}л: в бак +${res.toTank}л, на склад +${res.toStorage}л`, "success");
  } else if (res.toTank > 0) {
    showToast(`⛽ Куплено ${liters}л: в бак +${res.toTank}л`, "success");
  } else {
    showToast(`⛽ Куплено ${liters}л: на склад +${res.toStorage}л`, "success");
  }

  renderFuelMarket();
};

window._sellFuel = async function() {
  const liters = parseInt(document.getElementById("fuel-sell-amount")?.value) || 0;
  if (liters <= 0) return;

  const sold = await withdrawFuelForSale(liters);
  if (sold <= 0) {
    showToast("⛽ Нет топлива для продажи.", "warning");
    return;
  }

  const income = sold * FUEL_MARKET.sellPricePerLiter;
  await addCredits(income);
  showToast(`⛽ Продано ${sold}л топлива за ${income} кр.`, "success");
  renderFuelMarket();
};

// ─────────────────────────────────────────────────────────────
// BUY / SELL RESOURCES
// ─────────────────────────────────────────────────────────────

window._buyResource = async function(resource) {
  const amount = parseInt(document.getElementById(`res-amount-${resource}`)?.value) || 0;
  if (amount <= 0) return;

  const prices    = RESOURCE_PRICES[resource];
  if (!prices) return;

  const totalCost = amount * prices.buy;
  const ok        = await spendCredits(totalCost);

  if (!ok) {
    showToast(`💰 Нужно ${totalCost} кредитов.`, "warning");
    return;
  }

  await addResources({ [resource]: amount });
  showToast(
    `${resIcon(resource)} Куплено ${amount} ${resLabel(resource)} за ${totalCost} кр.`,
    "success"
  );
  renderResourceMarket();
};

window._sellResource = async function(resource) {
  const amount = parseInt(document.getElementById(`res-amount-${resource}`)?.value) || 0;
  if (amount <= 0) return;

  const prices = RESOURCE_PRICES[resource];
  if (!prices) return;

  const { getResources } = await import("./player.js");
  const have = getResources()[resource] ?? 0;

  if (have < amount) {
    showToast(`${resIcon(resource)} Недостаточно ресурсов (есть: ${have}).`, "warning");
    return;
  }

  const ok = await spendResources({ [resource]: amount });
  if (!ok) return;

  const income = amount * prices.sell;
  await addCredits(income);
  showToast(
    `${resIcon(resource)} Продано ${amount} за ${income} кр.`,
    "success"
  );
  renderResourceMarket();
};

// ─────────────────────────────────────────────────────────────
// BUY ECHO
// ─────────────────────────────────────────────────────────────

window._buyEcho = async function(itemId) {
  const items = window._marketItems ?? [];
  const item  = items.find(i => i.id === itemId);
  if (!item) return;

  const price = item.price?.credits ?? 0;

  const ok = await spendCredits(price);
  if (!ok) {
    showToast(`💰 Нужно ${price} кредитов. Есть: ${Math.floor(getCredits())}`, "warning");
    return;
  }

  const echoCopy = {
    ...item,
    original: false,
    id:       "echo_" + Math.random().toString(36).slice(2, 10),
    boughtAt: Date.now(),
  };

  await addToInventory(echoCopy);
  await incrementSaleCount(itemId);
  renderInventory();
  showToast(`✅ Куплено: ${item.name} за ${price} кр.`, "success");
};

// ─────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────

function resIcon(key) {
  return {
    isotopes: "☢️",
    minerals: "🪨",
    metals:   "⚙️",
    data:     "💾",
    alloys:   "🔩",   // ← tier-5
  }[key] ?? key;
}

function resLabel(key) {
  return {
    isotopes: "Изотопы",
    minerals: "Минералы",
    metals:   "Металлы",
    data:     "Данные",
    alloys:   "Боевые сплавы",   // ← tier-5
  }[key] ?? key;
}

function rarityLabel(r) {
  return {
    bad:      "Плохой",
    common:   "Обычный",
    improved: "Улучшенный",
    quality:  "Качественный",
    elite:    "Элитный",
    perfect:  "Совершенный",
  }[r] ?? r ?? "";
}

// ── Иконки рецептов (для тега типа модуля на карточке) ───────
function recipeIcon(recipeType) {
  return {
    fuel:             "⛽",
    cargo_module:     "🗃️",
    drill_module:     "⛏️",
    fuel_tank_module: "🛢️",
    engine_module:    "🚀",
    plating_module:   "🛡️",
    autopilot_module: "🤖",
    solar_module:     "☀️",
    eshield_module:   "⚡",
    ai_drill_module:  "🧠",
    // ── tier-5 ──────────────────────────────────────────────
    rocket_module:    "🚀",
    thermal_module:   "🔥",
    maneuvre_module:  "🛸",
    kinetic_module:   "💥",
    stealth_module:   "👁️",
  }[recipeType] ?? "🔧";
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}