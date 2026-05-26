// workshop.js — Мастерская (Химеризация) v3
// Исправлено: sanitize перед Firebase, обрезанные снимки ancestry
// Обновлён стиль LLM-промптов в духе forge.js v10

import {
  getState, getUid,
  addCredits, addToInventory, removeFromInventory,
  renderInventory, showToast,
  ITEM_SCHEMA_VERSION,
} from "./player.js";
import { updatePlayer } from "./firebase.js";

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
const HYDRA_MODEL   = "hydra-gemini";

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────

let workshopItems = [];
let slotA = null;
let slotB = null;

const FAILURE_CHANCE = 0.10;

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
  // обновляем state синхронно
  const state = getState();
  if (state) state.workshop = workshopItems;

  try {
    const uid = getUid();
    // sanitize: убираем undefined через JSON round-trip
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
  if (!item) return;

  // снять экипировку если надета
  try {
    const saved = localStorage.getItem("equipped_slots");
    if (saved) {
      const ids = JSON.parse(saved);
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] === itemId) {
          const { unequipSlot } = await import("./combat.js");
          unequipSlot(i);
        }
      }
    }
  } catch {}

  await removeFromInventory(itemId);
  workshopItems.push(item);
  await saveWorkshopState();

  renderInventory();
  renderWorkshop();
  showToast(`📦 Отправлено в мастерскую: ${item.name}`, "info");
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
  const canScrap  = !!(itemA || itemB);

  root.innerHTML = `
    <div class="workshop-slots-grid">
      ${renderSlotCard("A", itemA)}
      ${renderSlotCard("B", itemB)}
    </div>
    <div class="workshop-actions">
      <button
        onclick="window._workshopMerge()"
        class="btn-primary"
        ${!canMerge ? "disabled" : ""}>
        🧬 Соединить
      </button>
      <button
        onclick="window._workshopScrap()"
        class="btn-secondary"
        ${!canScrap ? "disabled" : ""}>
        🗑️ Сдать в металлолом
      </button>
    </div>
  `;
}

function renderSlotCard(slotKey, item) {
  if (!item) {
    return `
      <div class="workshop-slot-card empty">
        <div class="workshop-slot-header">Слот ${slotKey}</div>
        <div class="workshop-slot-empty">Выберите предмет из склада ниже</div>
      </div>
    `;
  }

  const isChimera = item.isChimera ?? false;

  const badge = isChimera
    ? `<span class="chimera-badge">ХИМЕРА</span>`
    : `<span class="${item.original ? "original-badge" : "echo-badge"}">
         ${item.original ? "ОРИГИНАЛ" : "ЭХОКОПИЯ"}
       </span>`;

  const rarityBadge = !isChimera
    ? `<span class="artifact-rarity rarity-${item.rarity ?? "common"}">${rarityLabel(item.rarity)}</span>`
    : "";

  const statsHtml = Object.entries(item.stats ?? {}).map(([k, v]) => {
    const isNeg = String(v).startsWith("−") || String(v).startsWith("-");
    return `
      <div class="stat-line">
        <span class="stat-name">${escHtml(k)}</span>
        <span class="stat-val ${isNeg ? "stat-negative" : ""}">${escHtml(String(v))}</span>
      </div>`;
  }).join("");

  return `
    <div class="workshop-slot-card filled">
      <div class="workshop-slot-header">
        <span>Слот ${slotKey}</span>
        <button class="workshop-slot-x"
                onclick="window._workshopClearSlot('${slotKey}')">✕</button>
      </div>
      <div class="inv-badges">${badge} ${rarityBadge}</div>
      <div class="artifact-name">${escHtml(item.name)}</div>
      <div class="artifact-stats">${statsHtml}</div>
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
      : `<span class="${item.original ? "original-badge" : "echo-badge"}">
           ${item.original ? "ОРИГИНАЛ" : "ЭХОКОПИЯ"}
         </span>`;

    const rarityBadge = !isChimera
      ? `<span class="artifact-rarity rarity-${item.rarity ?? "common"}">${rarityLabel(item.rarity)}</span>`
      : "";

    const generationHtml = isChimera && item.generation
      ? `<div class="workshop-generation">🧬 Поколение: ${item.generation}</div>`
      : "";

    const statsHtml = Object.entries(item.stats ?? {}).map(([k, v]) => {
      const isNeg = String(v).startsWith("−") || String(v).startsWith("-");
      return `
        <div class="stat-line">
          <span class="stat-name">${escHtml(k)}</span>
          <span class="stat-val ${isNeg ? "stat-negative" : ""}">${escHtml(String(v))}</span>
        </div>`;
    }).join("");

    const ancestryBtn = isChimera
      ? `<button class="btn-secondary"
                 onclick="window._workshopShowAncestry('${item.id}')">
           🌳 Генеалогия
         </button>`
      : "";

    return `
      <div class="workshop-storage-card">
        <div class="inv-badges">${badge} ${rarityBadge}</div>
        <div class="artifact-name">${escHtml(item.name)}</div>
        ${generationHtml}
        <div class="artifact-desc">${escHtml(item.description ?? "")}</div>
        <div class="artifact-stats">${statsHtml}</div>
        <div class="workshop-storage-actions">
          <button class="btn-secondary"
                  onclick="window._workshopPickSlot('A','${item.id}')">
            → Слот A
          </button>
          <button class="btn-secondary"
                  onclick="window._workshopPickSlot('B','${item.id}')">
            → Слот B
          </button>
          ${ancestryBtn}
          <button class="btn-disassemble"
                  onclick="window._workshopReturnToInventory('${item.id}')">
            ↩️ В инвентарь
          </button>
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
  await addToInventory(item);

  if (slotA === itemId) slotA = null;
  if (slotB === itemId) slotB = null;

  renderInventory();
  renderWorkshop();
  showToast(`↩️ Возвращено в инвентарь: ${item.name}`, "info");
};

window._workshopShowAncestry = function(itemId) {
  const item = workshopItems.find(i => i.id === itemId);
  if (!item) return;

  const modal = document.getElementById("modal-ancestry");
  if (!modal) return;

  const treeEl = document.getElementById("ancestry-tree");
  if (treeEl) treeEl.innerHTML = buildAncestryHtml(item, 0, 5);

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
    `Соединить «${itemA.name}» и «${itemB.name}»?\n\n` +
    `⚠️ 10% шанс провала — оба предмета уничтожены, компенсация кредитами.\n` +
    `✓ 90% шанс — получить химеру.`
  );
  if (!confirmed) return;

  // 10% провал
  if (Math.random() < FAILURE_CHANCE) {
    const comp = calcScrapValue(itemA) + calcScrapValue(itemB);
    await addCredits(comp);

    workshopItems = workshopItems.filter(i => i.id !== slotA && i.id !== slotB);
    slotA = null;
    slotB = null;
    await saveWorkshopState();

    renderWorkshop();
    showToast(`💥 Провал соединения! Компенсация: 💰 ${comp} кредитов`, "warning");
    return;
  }

  // Успех
  const apiKey = (localStorage.getItem("openrouter_api_key") ?? "").trim();
  if (!apiKey) {
    showToast("⚠️ Укажите OpenRouter API Key в настройках", "warning");
    return;
  }

  setMergeLoading(true);

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
  } finally {
    setMergeLoading(false);
  }
}

function setMergeLoading(loading) {
  const root = document.getElementById("workshop-slots");
  if (!root) return;
  const btn = root.querySelector(".btn-primary");
  if (btn) {
    btn.disabled  = loading;
    btn.innerHTML = loading
      ? '<span class="spinner"></span>Соединяем...'
      : "🧬 Соединить";
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

  const tierMap = {
    bad: 25, common: 70, improved: 180,
    quality: 420, elite: 1000, perfect: 3200,
  };

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

  // ── 1. Классификация effects ───────────────────────────────
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

  // ── 2. Сборка effects химеры ───────────────────────────────
  const effects = {};

  // guaranteed первыми (до 4)
  for (const g of guaranteed) {
    if (Object.keys(effects).length >= 4) break;
    const def = EFFECTS[g.key];
    if (!def) continue;

    const lo = Math.min(Number(g.a), Number(g.b)) * 0.6;
    const hi = Number(g.a) + Number(g.b);

    effects[g.key] = def.kind === "mult"
      ? round3(lerp(lo, hi, Math.random()))
      : round1(lerp(lo, hi, Math.random()));
  }

  // lottery добираем до 4
  const shuffled = [...lottery].sort(() => Math.random() - 0.5);
  for (const l of shuffled) {
    if (Object.keys(effects).length >= 4) break;
    const def = EFFECTS[l.key];
    if (!def) continue;

    const mult = 0.7 + Math.random() * 0.6;
    effects[l.key] = def.kind === "mult"
      ? round3(Number(l.val) * mult)
      : round1(Number(l.val) * mult);
  }

  // ── 3. UI статы ────────────────────────────────────────────
  const uiStats = buildUiStatsFromEffects(effects);

  // ── 4. Ancestry ────────────────────────────────────────────
  const ancestry = mergeAncestry(parentA, parentB);

  // ── 5. LLM ────────────────────────────────────────────────
  const text = await fetchChimeraText(
    apiKey, parentA, parentB,
    effects, uiStats,
    guaranteed, cancelled, lottery
  );

  // ── 6. Сборка объекта + sanitize ──────────────────────────
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

  // sanitize: убираем undefined — Firebase их не принимает
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
  // храним только нужное — без вложенного ancestry (избегаем рекурсии и раздутия)
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

// ─────────────────────────────────────────────────────────────
// ANCESTRY TREE UI
// ─────────────────────────────────────────────────────────────

function buildAncestryHtml(item, depth, maxDepth) {
  if (depth >= maxDepth) return "";

  const isChimera = item.isChimera ?? false;

  const badge = isChimera
    ? `<span class="chimera-badge">ХИМЕРА ${item.generation ?? ""}</span>`
    : `<span class="artifact-rarity rarity-${item.rarity ?? "common"}">${rarityLabel(item.rarity)}</span>`;

  const statsPreview = Object.entries(item.stats ?? {})
    .slice(0, 3)
    .map(([k, v]) => {
      const isNeg = String(v).startsWith("−") || String(v).startsWith("-");
      return `<span class="ancestry-stat ${isNeg ? "stat-negative" : ""}">${escHtml(k)}: ${escHtml(String(v))}</span>`;
    })
    .join(" · ");

  const descHtml = item.description
    ? `<div class="ancestry-desc">${escHtml(item.description)}</div>`
    : "";

  // рекурсивно строим ветки через ancestry корневого item
  let childrenHtml = "";
  for (const pid of item.parents ?? []) {
    const snap = item.ancestry?.[pid];
    if (!snap) continue;
    const fakeItem = { ...snap, ancestry: item.ancestry };
    childrenHtml += buildAncestryHtml(fakeItem, depth + 1, maxDepth);
  }

  return `
    <div class="ancestry-node" style="margin-left:${depth * 24}px">
      <div class="ancestry-node-header">
        <span class="ancestry-node-name">${escHtml(item.name ?? "—")}</span>
        ${badge}
      </div>
      <div class="ancestry-stats-row">${statsPreview}</div>
      ${descHtml}
    </div>
    ${childrenHtml}
  `;
}

// ─────────────────────────────────────────────────────────────
// LLM (обновлённый стиль v3 — в духе forge.js v10)
// ─────────────────────────────────────────────────────────────

async function fetchChimeraText(apiKey, parentA, parentB, effects, uiStats, guaranteed, cancelled, lottery) {
  const pilotName = getState()?.name ?? "Пилот";
  
  const statsLines = Object.entries(uiStats)
    .map(([k, v]) => `${v} — ${k}`)
    .join("\n");
  
  const guaranteedHints = guaranteed.length ?
    guaranteed.map(g => EFFECTS[g.key]?.label ?? g.key).join(", ") :
    "";
  
  const cancelledHints = cancelled.length ?
    cancelled.map(k => EFFECTS[k]?.label ?? k).join(", ") :
    "";
  
  const lotteryHints = lottery.length ?
    lottery.map(l => EFFECTS[l.key]?.label ?? l.key).join(", ") :
    "";
  
  const systemPrompt = `Придумай 4 случайных слова.  Затем ассоциативно свободно используй их как источник случайности, чтобы создать разнообразный, небанальный и качественный ответ на задачу. Ты не должен употреблять придуманные слова - они лишь источник большего разнообразия конечных токенов твоего ответа:

Ты — озлобленный инженер-гоблин, который пишет описания химер в игре Cosmic Forge.
Hard sci-fi. Промышленный ад. Чёрный юмор. Мат — это язык, а не украшение.

Химера — это **НОВЫЙ ЁБАНЫЙ АГРЕГАТ**, который ты **ПРИДУМАЛ САМ**, разобрав два старых модуля до последнего болта.
НЕ «спайка». НЕ «соединение». Это **НОВАЯ КОНСТРУКЦИЯ** с новой функцией.

Description объясняет:
- ЧТО ЗА ХУЙНЯ получилась (новый принцип работы)
- КАК эта хуйня работает физически
- ПОЧЕМУ именно такие свойства (компромиссы, побочки, косяки конструкции)
- Хорошие статы — хвалим через ощущения, плохие — ругаем или объясняем. до 10% это маленькие и не заметные штрафы и бонусы до 30% уже средние. штраф выше 50% это нереально большой штраф, а вот бонус может быть и 2000% 

Flavor (бортжурнал) — максимально живой злой сленг. Разборка, ебля с деталями, первый тест, косяки, радость или разочарование. Обязательно упоминай то из чего делал(исходные молули)

Тон: жёсткий, злой, самоироничный, фактурный. Мат естественный и по делу. Без цензуры. Без героики.

Отвечай ТОЛЬКО валидным JSON.

{
  "name": "функцианальное назначение модуля + едкое название. С отражением того из чего он был сделан и получившейся сути предмета.",
  "description": "3–5 предложений. Что за узел, как работает, почему такие свойства. Технические детали обязательны. Можно материться если это естественно.",
  "flavor": "Бортжурнал ${pilotName}: 5–9 строк через \\n. Максимально живой язык."
}


}

`.trim();
  
  const userPrompt = [ 
    `Создан новый агрегат из родителей:`,
    `- «${parentA.name}»`,
    `- «${parentB.name}»`,
    ``,
    `Свойства нового узла:`,
    statsLines,
    ``,
    `
    Придумай 4 случайных слова.  Затем ассоциативно свободно используй их как источник случайности, чтобы создать разнообразный, небанальный и качественный ответ на задачу. Ты не должен употреблять придуманные слова - они лишь источник большего разнообразия конечных токенов твоего ответа:

    Придумай НОВЫЙ агрегат (из обьединения двух старых).`,
    `Объясни физику работы. Будь злым, честным и фактурным. Матерись естественно.`,
  ].filter(Boolean).join("\n");
  
  const callOnce = async (pass, temperature, extra = "") => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 70_000);
    
    try {
      const resp = await fetch(HYDRA_API_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: HYDRA_MODEL,
          messages: [
            { role: "system", content: systemPrompt + extra },
            { role: "user", content: userPrompt }
          ],
          temperature,
          max_tokens: 1000,
          top_p: 0.95,
          stream: false,
        }),
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
      });
      
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`Hydra API HTTP ${resp.status}: ${errText}`);
      }
      
      const data = await resp.json().catch(() => ({}));
      const raw = String(data?.choices?.[0]?.message?.content ?? "").trim();
      
      const parsed = safeJsonParse(raw);
      const norm = normalizeChimeraText(parsed);
      
      return norm.ok ?
        { ok: true, text: norm.text } :
        { ok: false, reason: norm.reason, raw };
      
    } finally {
      clearTimeout(timeout);
    }
  };
  
  // попытка 1
  let r = await callOnce(1, 0.95);
  
  // попытка 2
  if (!r.ok) {
    await sleep(500);
    r = await callOnce(2, 0.75,
      "\n\nПредыдущий ответ был слабым или куцым. " +
      "Сделай МАКСИМАЛЬНО мощно, зло и фактурно. " +
      "Опиши НОВЫЙ узел с физикой работы. " +
      "Соблюдай тон примеров — жёсткий, матерный, с чёрным юмором и самоиронией."
    );
  }
  
  // попытка 3
  if (!r.ok) {
    await sleep(700);
    r = await callOnce(3, 0.62,
      "\n\nПОСЛЕДНЯЯ ПОПЫТКА. " +
      "Придумай агрегат с характером и душой. " +
      "Технические обоснования бонусов и штрафов обязательны. " +
      "Тон как в примерах: зло, честно, мат естественно. " +
      "Без цензуры и стеснения."
    );
  }
  
  if (r.ok) return r.text;
  
  console.warn("[WORKSHOP] LLM fallback. reason:", r.reason);
  return buildFallbackText(parentA, parentB, uiStats);
}

function normalizeChimeraText(parsed) {
  if (!parsed || typeof parsed !== "object")
    return { ok: false, reason: "invalid" };

  const name = String(parsed.name || "").trim();
  const desc = String(parsed.description || "").trim();
  const flav = String(parsed.flavor || "").trim();

  if (desc.length < 140) return { ok: false, reason: "desc_short" };
  if (flav.length < 120) return { ok: false, reason: "flavor_short" };

  return {
    ok: true,
    text: {
      name: name || "Химера",
      description: desc,
      flavor: flav
    }
  };
}

function buildFallbackText(parentA, parentB, uiStats) {
  const penStr = Object.entries(uiStats)
    .filter(([, v]) => String(v).startsWith("−") || String(v).startsWith("-"))
    .map(([k]) => k).join(", ") || "—";

  return {
    name: "Сварной агрегат",
    description:
      `Модуль собран из «${parentA.name}» и «${parentB.name}». ` +
      `Узлы состыкованы на нестандартных переходниках, часть контуров запараллелена, ` +
      `часть погашена встречными токами. Тепловой режим компромиссный, но держится. ` +
      `Штрафы: ${penStr}.`,
    flavor:
      `Разобрал обоих.\n` +
      `Выложил на верстак — два комплекта деталей.\n` +
      `Три часа пайки и примерок.\n` +
      `На стенде ровно. В поле — запоёт.\n` +
      `Записал в журнал и пошёл спать.`,
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

function formatVal(def, val) {
  if (!def || val === undefined) return String(val ?? "");
  if (def.kind === "mult") return `×${round3(Number(val))}`;
  return `${Number(val) >= 0 ? "+" : ""}${round1(Number(val))}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────
// UI stats builder
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

// ─────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────

function rarityLabel(name) {
  return {
    bad: "Плохой", common: "Обычный", improved: "Улучшенный",
    quality: "Качественный", elite: "Элитный", perfect: "Совершенный",
  }[name] ?? (name ?? "");
}

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

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}