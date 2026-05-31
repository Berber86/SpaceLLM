// workshop.js — Мастерская (Химеризация) v3 + Sci-Fi UI
// Восстановлена глубокая логика эффектов, генеалогия и LLM-промпты.
// Добавлена стоимость 1000 кр, анимация синтеза и новый интерфейс.

import {
  getState, getUid,
  addCredits, spendCredits, addToInventory, removeFromInventory,
  getInventory, renderInventory, showToast,
  ITEM_SCHEMA_VERSION,
} from "./player.js";
import { updatePlayer } from "./firebase.js";

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const WORKSHOP_COST = 1000;
const FAILURE_CHANCE = 0.10;

// ─────────────────────────────────────────────────────────────
// EFFECTS
// ─────────────────────────────────────────────────────────────
const EFFECTS = {
  fuel_tank_mult:                    { label: "Объём топливного бака",        kind: "mult" },
  cargo_capacity_mult:               { label: "Вместимость трюма",            kind: "mult" },
  flight_speed_mult:                 { label: "Скорость полёта",              kind: "mult" },
  return_speed_mult:                 { label: "Скорость возврата",            kind: "mult" },
  mining_speed_mult:                 { label: "Скорость добычи",              kind: "mult" },
  fuel_compress_mult:                { label: "Сжатие топлива",               kind: "mult" },
  fuel_efficiency_mult:              { label: "Экономичность добычи",         kind: "mult" },
  fuel_gen_add:                      { label: "Генерация топлива",            kind: "add"  },
  shield_mult:                       { label: "Мощность щита",                kind: "mult" },
  penetration_mult:                  { label: "Пробитие",                     kind: "mult" },
  hp_mult:                           { label: "Прочность корпуса",            kind: "mult" },
  mining_yield_mult:                 { label: "Объём хвата за цикл",          kind: "mult" },
  fuel_flight_efficiency_mult:       { label: "Экономичность перелёта",       kind: "mult" },
  cargo_compact_mult:                { label: "Уплотнение груза",             kind: "mult" },
  guard_stealth_mult:                { label: "Скрытность от охраны",         kind: "mult" },
  ore_upgrade_share_add:             { label: "Доля апгрейда руды",           kind: "add"  },
  autopilot_guard_ignore_chance_add: { label: "Обход охраны (автопилот)",     kind: "add"  },
  fuel_drain_add:                    { label: "Утечки топлива",               kind: "add"  },
  autopilot_cycles_add:              { label: "Автоциклы добычи",             kind: "add"  },
  dodge_chance_add:                  { label: "Мощность энергощита",          kind: "add"  },
  ore_quality_chance_add:            { label: "Шанс апгрейда руды",           kind: "add"  },
};

// ─────────────────────────────────────────────────────────────
// LLM
// ─────────────────────────────────────────────────────────────
const HYDRA_API_URL = "https://api.hydraai.ru/v1/chat/completions";
const HYDRA_MODEL   = "minimax-m2.7";

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
let workshopItems = [];
let slotA = null;
let slotB = null;

// ─────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────
export async function initWorkshop() {
  await loadWorkshopState();
  renderWorkshop();
  window._workshopMerge  = onMergeClick;
  window._workshopScrap  = onScrapClick;
  window._renderWorkshop = renderWorkshop;
}

// ─────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────
async function loadWorkshopState() {
  const state = getState();
  workshopItems = Array.isArray(state?.workshop) ? [...state.workshop] : [];
}

async function saveWorkshopState() {
  const state = getState();
  if (state) state.workshop = workshopItems;
  try {
    const uid = getUid();
    const clean = JSON.parse(JSON.stringify(workshopItems));
    await updatePlayer(uid, { workshop: clean });
  } catch (e) {
    console.error("[WORKSHOP] saveWorkshopState error:", e?.name, e?.message, e);
  }
}

// ─────────────────────────────────────────────────────────────
// Отправка из инвентаря в мастерскую
// ─────────────────────────────────────────────────────────────
export async function sendToWorkshop(itemId) {
  const state = getState();
  const item  = state?.inventory?.find(i => i.id === itemId);
  if (!item) {
    showToast("Предмет не найден в инвентаре.", "error");
    return;
  }

  // Удаляем из глобального инвентаря
  await removeFromInventory(itemId);
  
  // Добавляем в склад мастерской
  workshopItems.push(item);
  await saveWorkshopState();

  // Обновляем UI
  renderInventory();
  renderWorkshop();
  showToast(`📦 «${item.name}» перемещён в мастерскую.`, "info");
}

// ─────────────────────────────────────────────────────────────
// UI
// ─────────────────────────────────────────────────────────────
function renderWorkshop() {
  renderWorkshopSlots();
  renderWorkshopStorage();
}

function renderWorkshopSlots() {
  const root = document.getElementById("workshop-slots");
  if (!root) return;

  const itemA = workshopItems.find(i => i.id === slotA) ?? null;
  const itemB = workshopItems.find(i => i.id === slotB) ?? null;

  const canMerge = !!(itemA && itemB);
  const canScrap = !!(itemA || itemB);
  const sameType = canMerge && (itemA.recipeType === itemB.recipeType);

  root.innerHTML = `
    <div class="workshop-slots-grid">
      ${renderSlotCard("A", itemA)}
      <div class="workshop-divider"><div class="ws-plus">+</div></div>
      ${renderSlotCard("B", itemB)}
    </div>

    <div class="workshop-controls">
      ${canMerge && !sameType ? `<div class="ws-warn">⚠️ Модули разного типа. Результат непредсказуем.</div>` : ""}
      <button
        id="btn-merge-chimera"
        onclick="window._workshopMerge()"
        class="btn-primary btn-merge"
        ${!canMerge ? "disabled" : ""}>
        🧬 Синтезировать Химеру (${WORKSHOP_COST} кр.)
      </button>
      <button
        onclick="window._workshopScrap()"
        class="btn-secondary"
        style="margin-top: 10px; max-width: 320px;"
        ${!canScrap ? "disabled" : ""}>
        🗑️ Сдать в металлолом
      </button>
    </div>
  `;
}

function renderSlotCard(slotKey, item) {
  if (!item) {
    return `
      <div class="ws-slot empty">
        <div class="ws-slot-label">Слот ${slotKey}</div>
        <div class="ws-slot-text">Пусто</div>
      </div>
    `;
  }

  const isChimera = item.isChimera ?? false;
  const badge = isChimera
    ? `<span class="chimera-badge">ХИМЕРА ${item.generation ? `(gen ${item.generation})` : ''}</span>`
    : `<span class="${item.original ? "original-badge" : "echo-badge"}">${item.original ? "ОРИГИНАЛ" : "ЭХОКОПИЯ"}</span>`;

  const rarityBadge = !isChimera
    ? `<span class="artifact-rarity rarity-${item.rarity ?? "common"}">${rarityLabel(item.rarity)}</span>`
    : "";

  const statsHtml = Object.entries(item.stats ?? {}).map(([k, v]) => {
    const isNeg = String(v).startsWith("−") || String(v).startsWith("-");
    return `<div class="stat-line"><span class="stat-name">${escHtml(k)}</span><span class="stat-val ${isNeg ? "stat-negative" : ""}">${escHtml(String(v))}</span></div>`;
  }).join("");

  return `
    <div class="ws-slot filled">
      <div class="ws-slot-label">Слот ${slotKey}</div>
      <button class="btn-icon ws-remove" onclick="window._workshopClearSlot('${slotKey}')">✕</button>
      
      <div class="inv-badges" style="margin-top: 6px;">${badge} ${rarityBadge}</div>
      <div class="artifact-name" style="margin: 8px 0;">${escHtml(item.name)}</div>
      
      <div class="artifact-stats-mini">${statsHtml}</div>
    </div>
  `;
}

function renderWorkshopStorage() {
  const root = document.getElementById("workshop-storage");
  if (!root) return;

  const available = workshopItems.filter(i => i.id !== slotA && i.id !== slotB);

  if (!available.length) {
    root.innerHTML = `<div class="empty-state">Склад пуст. Отправьте предметы из инвентаря.</div>`;
    return;
  }

  root.innerHTML = available.map(item => {
    const isChimera = item.isChimera ?? false;

    const badge = isChimera
      ? `<span class="chimera-badge">ХИМЕРА</span>`
      : `<span class="${item.original ? "original-badge" : "echo-badge"}">${item.original ? "ОРИГИНАЛ" : "ЭХОКОПИЯ"}</span>`;

    const rarityBadge = !isChimera
      ? `<span class="artifact-rarity rarity-${item.rarity ?? "common"}">${rarityLabel(item.rarity)}</span>`
      : "";

    const generationHtml = isChimera && item.generation
      ? `<div class="workshop-generation" style="font-size: 11px; color: #c4b5fd;">🧬 Поколение: ${item.generation}</div>`
      : "";

    const statsHtml = Object.entries(item.stats ?? {}).map(([k, v]) => {
      const isNeg = String(v).startsWith("−") || String(v).startsWith("-");
      return `<div class="stat-line"><span class="stat-name">${escHtml(k)}</span><span class="stat-val ${isNeg ? "stat-negative" : ""}">${escHtml(String(v))}</span></div>`;
    }).join("");

    const ancestryBtn = isChimera
      ? `<button class="btn-secondary" onclick="window._workshopShowAncestry('${item.id}')">🌳 Генеалогия</button>`
      : "";

    return `
      <div class="inventory-card">
        <div class="inv-badges">${badge} ${rarityBadge}</div>
        <div class="artifact-name">${escHtml(item.name)}</div>
        ${generationHtml}
        <div class="artifact-desc">${escHtml(item.description ?? "")}</div>
        <div class="artifact-stats" style="margin-top: 6px;">${statsHtml}</div>
        
        <div class="inv-actions" style="flex-wrap: wrap;">
          <button class="btn-secondary" onclick="window._workshopPickSlot('A','${item.id}')">→ Слот A</button>
          <button class="btn-secondary" onclick="window._workshopPickSlot('B','${item.id}')">→ Слот B</button>
          ${ancestryBtn}
          <button class="btn-disassemble" onclick="window._workshopReturnToInventory('${item.id}')" style="width: 100%;">↩️ В инвентарь</button>
        </div>
      </div>
    `;
  }).join("");
}

// ─────────────────────────────────────────────────────────────
// Глобальные обработчики
// ─────────────────────────────────────────────────────────────
window._workshopPickSlot = function(slot, itemId) {
  if (slot === "A") slotA = itemId;
  if (slot === "B") slotB = itemId;
  renderWorkshop();
};

window._workshopClearSlot = function(slot) {
  if (slot === "A") slotA = null;
  if (slot === "B") slotB = null;
  renderWorkshop();
};

window._workshopReturnToInventory = async function(itemId) {
  const idx = workshopItems.findIndex(i => i.id === itemId);
  if (idx === -1) return;

  const [item] = workshopItems.splice(idx, 1);
  await saveWorkshopState();
  
  // Возвращаем в глобальный инвентарь
  await addToInventory(item);

  if (slotA === itemId) slotA = null;
  if (slotB === itemId) slotB = null;

  renderInventory();
  renderWorkshop();
  showToast(`↩️ «${item.name}» возвращён в инвентарь`, "info");
};

window._workshopShowAncestry = function(itemId) {
  const item = workshopItems.find(i => i.id === itemId);
  if (!item) return;
  const modal = document.getElementById("modal-ancestry");
  const treeEl = document.getElementById("ancestry-tree");
  if (!modal || !treeEl) return;
  treeEl.innerHTML = buildAncestryHtml(item, 0, 5);
  modal.classList.remove("hidden");
};

document.addEventListener("click", e => {
  const modal = document.getElementById("modal-ancestry");
  if (modal && e.target === modal) modal.classList.add("hidden");
});

// ─────────────────────────────────────────────────────────────
// MERGE
// ─────────────────────────────────────────────────────────────
async function onMergeClick() {
  const itemA = workshopItems.find(i => i.id === slotA);
  const itemB = workshopItems.find(i => i.id === slotB);
  
  if (!itemA || !itemB) {
    showToast("⚠️ Выберите два предмета в слоты A и B", "warning");
    return;
  }

  const confirmed = confirm(
    `Соединить «${itemA.name}» и «${itemB.name}» за ${WORKSHOP_COST} кр.?\n\n` +
    `⚠️ ${FAILURE_CHANCE * 100}% шанс провала — оба предмета уничтожены.\n` +
    `✓ ${(1 - FAILURE_CHANCE) * 100}% шанс — получить химеру.`
  );
  if (!confirmed) return;

  const ok = await spendCredits(WORKSHOP_COST);
  if (!ok) {
    showToast("💰 Недостаточно кредитов для синтеза!", "warning");
    return;
  }

  // --- Анимация скрещивания ---
  const btn = document.getElementById("btn-merge-chimera");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="border-left-color: #8b5cf6;"></span> СИНТЕЗ ГЕНОМА...';
    btn.classList.add("glitch-text");
  }
  
  const slotsGrid = document.querySelector(".workshop-slots-grid");
  if (slotsGrid) {
    slotsGrid.style.animation = "forge-scan 0.5s infinite";
    slotsGrid.style.filter = "hue-rotate(45deg) contrast(1.5)";
  }

  await sleep(4000);

  if (slotsGrid) {
    slotsGrid.style.animation = "none";
    slotsGrid.style.filter = "none";
  }
  // --- Конец анимации ---

  // Провал
  if (Math.random() < FAILURE_CHANCE) {
    const comp = calcScrapValue(itemA) + calcScrapValue(itemB);
    await addCredits(comp);
    workshopItems = workshopItems.filter(i => i.id !== slotA && i.id !== slotB);
    slotA = null;
    slotB = null;
    await saveWorkshopState();
    renderWorkshop();
    showToast(`💥 Провал соединения! Оба модуля уничтожены. Компенсация: 💰 ${comp} кредитов`, "warning");
    return;
  }

  // Успех
  const apiKey = (localStorage.getItem("openrouter_api_key") ?? "").trim();
  if (!apiKey) {
    showToast("⚠️ Укажите OpenRouter API Key в настройках", "warning");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `🧬 Синтезировать Химеру (${WORKSHOP_COST} кр.)`;
      btn.classList.remove("glitch-text");
    }
    return;
  }

  if (btn) {
    btn.innerHTML = '<span class="spinner" style="border-left-color: #8b5cf6;"></span> Расшифровка структуры...';
    btn.classList.remove("glitch-text");
  }

  try {
    const chimera = await craftChimera(apiKey, itemA, itemB);
    workshopItems = workshopItems.filter(i => i.id !== slotA && i.id !== slotB);
    slotA = null;
    slotB = null;
    await saveWorkshopState();
    await addToInventory(chimera);
    renderInventory();
    renderWorkshop();
    showToast(`✅ Химера создана: ${chimera.name}`, "success");
  } catch (e) {
    console.error("[WORKSHOP] merge error:", e?.name, e?.message, e);
    showToast(`❌ Ошибка: ${e?.message || "неизвестная ошибка"}`, "warning");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `🧬 Синтезировать Химеру (${WORKSHOP_COST} кр.)`;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// SCRAP
// ─────────────────────────────────────────────────────────────
async function onScrapClick() {
  const itemA = workshopItems.find(i => i.id === slotA);
  const itemB = workshopItems.find(i => i.id === slotB);
  const items = [itemA, itemB].filter(Boolean);

  if (!items.length) {
    showToast("⚠️ Выберите предмет в слот", "warning");
    return;
  }

  const total = items.reduce((s, i) => s + calcScrapValue(i), 0);
  const names = items.map(i => `«${i.name}»`).join(" и ");

  const confirmed = confirm(`Сдать в металлолом ${names}?\n\nПолучите 💰 ${total} кредитов.`);
  if (!confirmed) return;

  await addCredits(total);

  const idsToRemove = new Set(items.map(i => i.id));
  workshopItems = workshopItems.filter(i => !idsToRemove.has(i.id));

  if (idsToRemove.has(slotA)) slotA = null;
  if (idsToRemove.has(slotB)) slotB = null;

  await saveWorkshopState();
  renderWorkshop();
  showToast(`🗑️ Сдано в металлолом. Получено 💰 ${total} кредитов`, "success");
}

function calcScrapValue(item) {
  if (!item) return 0;
  const tierMap = { bad: 25, common: 70, improved: 180, quality: 420, elite: 1000, perfect: 3200 };
  let base;

  if (item.isChimera) {
    const effectCount = Object.keys(item.effects ?? {}).length;
    base = Math.max(50, effectCount * 60);
  } else {
    base = tierMap[item.rarity] ?? 50;
  }

  let bonusCount = 0;
  for (const [key, val] of Object.entries(item.effects ?? {})) {
    const def = EFFECTS[key];
    if (!def) continue;
    if (def.kind === "mult" && Number(val) > 1) bonusCount++;
    if (def.kind === "add"  && Number(val) > 0) bonusCount++;
  }
  return Math.max(10, Math.round(base + bonusCount * 20));
}

// ─────────────────────────────────────────────────────────────
// CHIMERA CRAFT
// ─────────────────────────────────────────────────────────────
async function craftChimera(apiKey, parentA, parentB) {
  const generation = Math.max(parentA.generation ?? 1, parentB.generation ?? 1) + 1;

  const allKeys = new Set([
    ...Object.keys(parentA.effects ?? {}),
    ...Object.keys(parentB.effects ?? {}),
  ]);

  const guaranteed = [];
  const cancelled  = [];
  const lottery    = [];

  for (const key of allKeys) {
    const def = EFFECTS[key];
    if (!def) continue;

    const hasA = key in (parentA.effects ?? {});
    const hasB = key in (parentB.effects ?? {});
    const valA = parentA.effects?.[key];
    const valB = parentB.effects?.[key];

    if (hasA && hasB) {
      if (isBonus(def, valA) !== isBonus(def, valB)) {
        cancelled.push(key);
      } else {
        guaranteed.push({ key, a: valA, b: valB });
      }
    } else {
      lottery.push({ key, val: hasA ? valA : valB });
    }
  }

  const effects = {};
  for (const g of guaranteed) {
    if (Object.keys(effects).length >= 4) break;
    const def = EFFECTS[g.key];
    if (!def) continue;
    const lo = Math.min(Number(g.a), Number(g.b)) * 0.6;
    const hi = Number(g.a) + Number(g.b);
    effects[g.key] = def.kind === "mult" ? round3(lerp(lo, hi, Math.random())) : round1(lerp(lo, hi, Math.random()));
  }

  const shuffled = [...lottery].sort(() => Math.random() - 0.5);
  for (const l of shuffled) {
    if (Object.keys(effects).length >= 4) break;
    const def = EFFECTS[l.key];
    if (!def) continue;
    const mult = 0.7 + Math.random() * 0.6;
    effects[l.key] = def.kind === "mult" ? round3(Number(l.val) * mult) : round1(Number(l.val) * mult);
  }

  const uiStats = buildUiStatsFromEffects(effects);
  const ancestry = mergeAncestry(parentA, parentB);

  const text = await fetchChimeraText(apiKey, parentA, parentB, effects, uiStats, guaranteed, cancelled, lottery);

  const chimera = {
    schemaVersion: ITEM_SCHEMA_VERSION,
    id:          "chimera_" + Math.random().toString(36).slice(2, 10),
    isChimera:   true,
    generation,
    name:        text.name,
    description: text.description,
    flavor:      text.flavor,
    stats:       uiStats,
    effects,
    parents:     [parentA.id, parentB.id],
    ancestry,
    original:    true,
    echoPower:   1.0,
    ownerId:     getUid(),
    ownerName:   getState()?.name ?? "Pilot",
    createdAt:   Date.now(),
    weight:      round1((parentA.weight ?? 1) + (parentB.weight ?? 1)),
  };

  return JSON.parse(JSON.stringify(chimera));
}

function isBonus(def, val) {
  if (def.kind === "mult") return Number(val) > 1;
  if (def.kind === "add")  return Number(val) > 0;
  return false;
}

// ─────────────────────────────────────────────────────────────
// ANCESTRY
// ─────────────────────────────────────────────────────────────
function mergeAncestry(a, b) {
  const out = {};
  out[a.id] = makeSnapshot(a, 0);
  out[b.id] = makeSnapshot(b, 0);

  for (const [id, snap] of Object.entries(a.ancestry ?? {})) {
    const d = (snap.depth ?? 0) + 1;
    if (d >= 5) continue;
    if (!out[id]) out[id] = { ...snap, depth: d };
  }
  for (const [id, snap] of Object.entries(b.ancestry ?? {})) {
    const d = (snap.depth ?? 0) + 1;
    if (d >= 5) continue;
    if (!out[id]) out[id] = { ...snap, depth: d };
  }
  return out;
}

function makeSnapshot(item, depth) {
  return {
    depth,
    name:        item.name        ?? "",
    description: item.description ?? "",
    flavor:      item.flavor      ?? "",
    isChimera:   item.isChimera   ?? false,
    generation:  item.generation  ?? null,
    rarity:      item.rarity      ?? null,
    stats:       Object.fromEntries(Object.entries(item.stats ?? {}).slice(0, 4)),
    effects:     item.effects     ?? {},
    parents:     Array.isArray(item.parents) ? item.parents : [],
  };
}

function buildAncestryHtml(item, depth, maxDepth) {
  if (depth >= maxDepth) return "";

  const isChimera = item.isChimera ?? false;
  const badge = isChimera
    ? `<span class="chimera-badge">ХИМЕРА ${item.generation ?? ""}</span>`
    : `<span class="artifact-rarity rarity-${item.rarity ?? "common"}">${rarityLabel(item.rarity)}</span>`;

  const statsPreview = Object.entries(item.stats ?? {}).slice(0, 3).map(([k, v]) => {
    const isNeg = String(v).startsWith("−") || String(v).startsWith("-");
    return `<span class="ancestry-stat ${isNeg ? "stat-negative" : ""}">${escHtml(k)}: ${escHtml(String(v))}</span>`;
  }).join(" · ");

  const descHtml = item.description ? `<div class="ancestry-desc" style="font-size:11px;color:var(--muted);">${escHtml(item.description)}</div>` : "";

  let childrenHtml = "";
  for (const pid of item.parents ?? []) {
    const snap = item.ancestry?.[pid];
    if (!snap) continue;
    const fakeItem = { ...snap, ancestry: item.ancestry };
    childrenHtml += buildAncestryHtml(fakeItem, depth + 1, maxDepth);
  }

  return `
    <div class="ancestry-node" style="margin-left:${depth * 20}px; border-left: 2px solid rgba(255,255,255,0.1); padding-left: 10px; margin-bottom: 8px;">
      <div class="ancestry-node-header" style="display:flex;gap:8px;align-items:center;">
        <span class="ancestry-node-name" style="font-weight:700;color:var(--gold);">${escHtml(item.name ?? "—")}</span>
        ${badge}
      </div>
      <div class="ancestry-stats-row" style="font-size:10px;font-family:var(--font-mono);">${statsPreview}</div>
      ${descHtml}
    </div>
    ${childrenHtml}
  `;
}

// ─────────────────────────────────────────────────────────────
// LLM (обновлённый стиль v3)
// ─────────────────────────────────────────────────────────────
async function fetchChimeraText(apiKey, parentA, parentB, effects, uiStats, guaranteed, cancelled, lottery) {
  const pilotName = getState()?.name ?? "Пилот";
  const statsLines = Object.entries(uiStats).map(([k, v]) => `${v} — ${k}`).join("\n");

  const systemPrompt = `Придумай 4 случайных слова. Затем ассоциативно свободно используй их как источник случайности, чтобы создать разнообразный, небанальный и качественный ответ на задачу. Ты не должен употреблять придуманные слова - они лишь источник большего разнообразия конечных токенов твоего ответа:

Ты — озлобленный инженер-гоблин, который пишет описания химер в игре Cosmic Forge.
Hard sci-fi. Промышленный ад. Чёрный юмор. Мат — это язык, а не украшение.
Химера — это НОВЫЙ ЁБАНЫЙ АГРЕГАТ, который ты ПРИДУМАЛ САМ, разобрав два старых модуля до последнего болта.
НЕ «спайка». НЕ «соединение». Это НОВАЯ КОНСТРУКЦИЯ с новой функцией.

Description объясняет:
- ЧТО ЗА ХУЙНЯ получилась (новый принцип работы)
- КАК эта хуйня работает физически
- ПОЧЕМУ именно такие свойства (компромиссы, побочки, косяки конструкции)
- Хорошие статы — хвалим через ощущения, плохие — ругаем или объясняем. до 10% это маленькие и не заметные штрафы и бонусы до 30% уже средние. штраф выше 50% это нереально большой штраф, а вот бонус может быть и 2000% 

Flavor (бортжурнал) — максимально живой злой сленг. Разборка, ебля с деталями, первый тест, косяки, радость или разочарование. Обязательно упоминай то из чего делал(исходные молули)
Тон: жёсткий, злой, самоироничный, фактурный. Мат естественный и по делу. Без цензуры. Без героики.

ПРИМЕР ОЖИДАЕМОГО ОТВЕТА:
```json
{
  "name": "Топливный бак «Кровавый Симбиот» Mk.2",
  "description": "Сплав генератора щита и старого бака. Я пустил излишки энергии прямо в топливную магистраль. Ёмкость выросла до небес, но утечки такие, что скоро мы тут все задохнемся от паров изотопов.",
  "flavor": "Бортжурнал Пилот_01: Ебучая химера работает.\nВоняет страшно.\nЗато щит теперь питается от испарений. Посмотрим, что ебанет первым."
}
```

Отвечай ТОЛЬКО валидным JSON.
{
  "name": "функцианальное назначение модуля + едкое название. С отражением того из чего он был сделан и получившейся сути предмета.",
  "description": "3–5 предложений. Что за узел, как работает, почему такие свойства. Технические детали обязательны. Можно материться если это естественно.",
  "flavor": "Бортжурнал ${pilotName}: 5–9 строк через \\n. Максимально живой язык."
}`.trim();

  const userPrompt = [ 
    `Создан новый агрегат из родителей:`,
    `- «${parentA.name}»`,
    `- «${parentB.name}»`,
    ``,
    `Свойства нового узла:`,
    statsLines,
    ``,
    `Объясни физику работы. Будь злым, честным и фактурным. Матерись естественно.`,
  ].filter(Boolean).join("\n");

  const callOnce = async (pass, temperature, extra = "") => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 70_000);
    
    try {
      const resp = await fetch(HYDRA_API_URL, {
        method: "POST", signal: controller.signal,
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: HYDRA_MODEL,
          messages: [{ role: "system", content: systemPrompt + extra }, { role: "user", content: userPrompt }],
          temperature, max_tokens: 1000, top_p: 0.95, stream: false,
        })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const raw = String(data?.choices?.[0]?.message?.content ?? "").trim();
      
      const parsed = safeJsonParse(raw);
      const norm = normalizeChimeraText(parsed);
      return norm.ok ? { ok: true, text: norm.text } : { ok: false, reason: norm.reason, raw };
    } finally {
      clearTimeout(timeout);
    }
  };

  let r = await callOnce(1, 0.95);
  if (!r.ok) {
    await sleep(500);
    r = await callOnce(2, 0.75, "\n\nПредыдущий ответ был слабым или куцым. Сделай МАКСИМАЛЬНО мощно, зло и фактурно. Опиши НОВЫЙ узел с физикой работы.");
  }
  if (!r.ok) {
    await sleep(700);
    r = await callOnce(3, 0.62, "\n\nПОСЛЕДНЯЯ ПОПЫТКА. Придумай агрегат с характером и душой. Технические обоснования бонусов и штрафов обязательны.");
  }
  if (r.ok) return r.text;

  console.warn("[WORKSHOP] LLM fallback. reason:", r.reason);
  return buildFallbackText(parentA, parentB, uiStats);
}

function normalizeChimeraText(parsed) {
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "invalid" };
  const name = String(parsed.name || "").trim();
  const desc = String(parsed.description || "").trim();
  const flav = String(parsed.flavor || "").trim();
  if (desc.length < 140) return { ok: false, reason: "desc_short" };
  if (flav.length < 120) return { ok: false, reason: "flavor_short" };
  return { ok: true, text: { name: name || "Химера", description: desc, flavor: flav } };
}

function buildFallbackText(parentA, parentB, uiStats) {
  const penStr = Object.entries(uiStats)
    .filter(([, v]) => String(v).startsWith("−") || String(v).startsWith("-"))
    .map(([k]) => k).join(", ") || "—";
  return {
    name: "Сварной агрегат",
    description: `Модуль собран из «${parentA.name}» и «${parentB.name}». Узлы состыкованы на нестандартных переходниках, часть контуров запараллелена. Тепловой режим компромиссный, но держится. Штрафы: ${penStr}.`,
    flavor: `Разобрал обоих.\nВыложил на верстак — два комплекта деталей.\nТри часа пайки и примерок.\nНа стенде ровно. В поле — запоёт.\nЗаписал в журнал и пошёл спать.`,
  };
}

function safeJsonParse(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch {}
  const noFences = s.replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(noFences); } catch {}
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i !== -1 && j > i) {
    try { return JSON.parse(s.slice(i, j + 1)); } catch {}
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// UI stats builder & Utils
// ─────────────────────────────────────────────────────────────
function buildUiStatsFromEffects(effects) {
  const out = {};
  for (const [k, v] of Object.entries(effects ?? {})) {
    const def = EFFECTS[k];
    if (!def) continue;
    if (def.kind === "add") {
      if (k === "autopilot_cycles_add") {
        const n = Math.max(0, Math.round(Number(v)));
        out[def.label] = `+${n} цикл${pluralRu(n, "", "а", "ов")}`;
      } else if (k === "dodge_chance_add") {
        out[def.label] = `${Number(v) >= 0 ? "+" : "−"}${round1(Math.abs(Number(v)))} щит`;
      } else if (k === "ore_quality_chance_add") {
        out[def.label] = `${Number(v) >= 0 ? "+" : "−"}${round1(Math.abs(Number(v)))}% шанс`;
      } else if (k === "autopilot_guard_ignore_chance_add") {
        out[def.label] = `${Number(v) >= 0 ? "+" : "−"}${round1(Math.abs(Number(v)))}%`;
      } else if (k === "ore_upgrade_share_add") {
        out[def.label] = `${Number(v) >= 0 ? "+" : "−"}${round1(Math.abs(Number(v)))} п.п.`;
      } else if (k === "fuel_drain_add") {
        out[def.label] = `−${round1(Math.abs(Number(v)))} л/ч`;
      } else {
        out[def.label] = `${Number(v) >= 0 ? "+" : "−"}${round1(Math.abs(Number(v)))} л/ч`;
      }
      continue;
    }
    const pct = Math.round((Number(v) - 1) * 100);
    if (pct === 0) continue;
    out[def.label] = `${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`;
  }
  return out;
}

function rarityLabel(name) { return { bad: "Плохой", common: "Обычный", improved: "Улучшенный", quality: "Качественный", elite: "Элитный", perfect: "Совершенный", }[name] ?? (name ?? ""); }
function lerp(a, b, t)  { return a + (b - a) * t; }
function round1(x)      { return Math.round(x * 10)   / 10;   }
function round3(x)      { return Math.round(x * 1000) / 1000; }
function pluralRu(n, one, few, many) {
  const mod10  = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
function escHtml(str) { return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
