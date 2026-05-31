// forge.js — Кузня (v13: Tech Tree Update)
// - Полный отказ от слепых слотов
// - Дерево технологий с тирами
// - Ползунки ресурсов
// - Кросс-навигация на майнинг и рынок

import { publishToMarket } from "./firebase.js";
import {
  getState, getResources,
  reserveResources, commitReservedResources, releaseReservedResources,
  addResources,
  addToInventory, getUid, renderInventory,
  receiveFuelFromForge, showToast,
  ITEM_SCHEMA_VERSION,
  renderEffectsDisplay,
} from "./player.js";

const MIN_CRAFT_TOTAL = 50;
const MIN_SLOT1_RATIO = 0.10;
const TIER_POWER = { 1: 1.0, 2: 1.6, 3: 2.6, 4: 4.2, 5: 6.8 };

const RES = {
  isotopes: { icon:"☢️", label:"Топливо-изотопы",   tier:1, weight:1    },
  minerals: { icon:"🪨", label:"Палладиевый камень", tier:2, weight:10   },
  metals:   { icon:"⚙️", label:"Тяговой сплав",      tier:3, weight:100  },
  data:     { icon:"💾", label:"Микросхемы",         tier:4, weight:1000 },
  alloys:   { icon:"🔩", label:"Боевые сплавы",      tier:5, weight:500  },
};

const RECIPE = {
  FUEL:      "fuel",
  CARGO:     "cargo_module",
  DRILL:     "drill_module",
  TANK:      "fuel_tank_module",
  ENGINE:    "engine_module",
  PLATING:   "plating_module",
  AUTOPILOT: "autopilot_module",
  SOLAR:     "solar_module",
  ESHIELD:   "eshield_module",
  AI_DRILL:  "ai_drill_module",
  ROCKET:    "rocket_module",
  THERMAL:   "thermal_module",
  MANEUVRE:  "maneuvre_module",
  KINETIC:   "kinetic_module",
  STEALTH:   "stealth_module",
};

// ── ДЕРЕВО ТЕХНОЛОГИЙ (BLUEPRINTS) ──
const BLUEPRINTS = [
  // Tier 1
  { type: RECIPE.FUEL,      tier: 1, reqs: ["isotopes"] },
  { type: RECIPE.CARGO,     tier: 1, reqs: ["minerals"] },
  { type: RECIPE.TANK,      tier: 1, reqs: ["isotopes", "minerals"] },
  // Tier 2
  { type: RECIPE.DRILL,     tier: 2, reqs: ["metals"] },
  { type: RECIPE.ENGINE,    tier: 2, reqs: ["isotopes", "metals"] },
  { type: RECIPE.PLATING,   tier: 2, reqs: ["minerals", "metals"] },
  // Tier 3
  { type: RECIPE.AUTOPILOT, tier: 3, reqs: ["data"] },
  { type: RECIPE.SOLAR,     tier: 3, reqs: ["data", "isotopes"] },
  { type: RECIPE.ESHIELD,   tier: 3, reqs: ["data", "minerals"] },
  { type: RECIPE.AI_DRILL,  tier: 3, reqs: ["data", "metals"] },
  // Tier 4 (Боевые / Эндгейм)
  { type: RECIPE.ROCKET,    tier: 4, reqs: ["alloys"] },
  { type: RECIPE.THERMAL,   tier: 4, reqs: ["alloys", "isotopes"] },
  { type: RECIPE.MANEUVRE,  tier: 4, reqs: ["alloys", "minerals"] },
  { type: RECIPE.KINETIC,   tier: 4, reqs: ["alloys", "metals"] },
  { type: RECIPE.STEALTH,   tier: 4, reqs: ["alloys", "data"] },
];

const RECIPE_MIN_QUALITY = {
  [RECIPE.FUEL]:0, [RECIPE.CARGO]:0, [RECIPE.DRILL]:2, [RECIPE.TANK]:0, [RECIPE.ENGINE]:1,
  [RECIPE.PLATING]:0, [RECIPE.AUTOPILOT]:2, [RECIPE.SOLAR]:1, [RECIPE.ESHIELD]:1,
  [RECIPE.AI_DRILL]:2, [RECIPE.ROCKET]:2, [RECIPE.THERMAL]:2, [RECIPE.MANEUVRE]:2,
  [RECIPE.KINETIC]:2, [RECIPE.STEALTH]:3,
};

const RECIPE_MAX_QUALITY = {
  [RECIPE.FUEL]:2, [RECIPE.CARGO]:3, [RECIPE.DRILL]:5, [RECIPE.TANK]:2, [RECIPE.ENGINE]:4,
  [RECIPE.PLATING]:3, [RECIPE.AUTOPILOT]:5, [RECIPE.SOLAR]:4, [RECIPE.ESHIELD]:4,
  [RECIPE.AI_DRILL]:5, [RECIPE.ROCKET]:5, [RECIPE.THERMAL]:5, [RECIPE.MANEUVRE]:5,
  [RECIPE.KINETIC]:5, [RECIPE.STEALTH]:5,
};

const RARITIES = [
  { name:"bad",      label:"Плохой",       index:0, bonus:2, pen:2, penMult:1.65, power:0.85, maxMult:2.5  },
  { name:"common",   label:"Обычный",      index:1, bonus:2, pen:2, penMult:1.05, power:1.00, maxMult:3.2  },
  { name:"improved", label:"Улучшенный",   index:2, bonus:2, pen:1, penMult:0.75, power:1.25, maxMult:4.8  },
  { name:"quality",  label:"Качественный", index:3, bonus:2, pen:0, penMult:0.00, power:1.55, maxMult:6.5  },
  { name:"elite",    label:"Элитный",      index:4, bonus:3, pen:0, penMult:0.00, power:2.05, maxMult:8.0  },
  { name:"perfect",  label:"Совершенный",  index:5, bonus:3, pen:0, penMult:0.00, power:2.80, maxMult:10.0 },
];

const RARITY_ORDER = RARITIES.map(r => r.name);
function rarityRank(name) {
  const i = RARITY_ORDER.indexOf(name);
  return i === -1 ? 0 : i;
}

const QUALITY_DIVISORS = [null, 100, 100, 1000, 10000, 100000];
const IMP_BOOST = 4.0;

// ─────────────────────────────────────────────────────────────
// Effects & Modules Configuration
// ─────────────────────────────────────────────────────────────
const EFFECTS = {
  fuel_tank_mult:        { label:"Объём топливного бака",        kind:"mult", bonusPct:[10, 90],  penPct:[6,  50] },
  cargo_capacity_mult:   { label:"Вместимость трюма",            kind:"mult", bonusPct:[12, 110], penPct:[7,  55] },
  flight_speed_mult:     { label:"Скорость полёта",              kind:"mult", bonusPct:[6,  45],  penPct:[8,  65] },
  return_speed_mult:     { label:"Скорость возврата",            kind:"mult", bonusPct:[6,  40],  penPct:[8,  60] },
  mining_speed_mult:     { label:"Скорость добычи",              kind:"mult", bonusPct:[8,  60],  penPct:[8,  65] },
  fuel_compress_mult:    { label:"Сжатие топлива",               kind:"mult", bonusPct:[8,  95],  penPct:[8,  60] },
  fuel_efficiency_mult:  { label:"Экономичность добычи",         kind:"mult", bonusPct:[8,  90],  penPct:[8,  65] },
  fuel_gen_add:          { label:"Генерация топлива",            kind:"add",  bonusAdd:[0.5, 10.0]              },
  shield_mult:           { label:"Мощность щита",                kind:"mult", bonusPct:[8,  100], penPct:[8,  65] },
  penetration_mult:      { label:"Пробитие",                     kind:"mult", bonusPct:[8,  100], penPct:[8,  65] },
  hp_mult:               { label:"Прочность корпуса",            kind:"mult", bonusPct:[8,  90],  penPct:[10, 75] },
  mining_yield_mult:     { label:"Объём хвата за цикл",          kind:"mult", bonusPct:[10, 85],  penPct:[8,  65] },
  fuel_flight_efficiency_mult:{ label:"Экономичность перелёта",  kind:"mult", bonusPct:[6,  40],  penPct:[8,  60] },
  cargo_compact_mult:    { label:"Уплотнение груза",             kind:"mult", bonusPct:[8,  55],  penPct:[8,  55] },
  guard_stealth_mult:    { label:"Скрытность от охраны",         kind:"mult", bonusPct:[10, 55],  penPct:[10, 85] },
  ore_upgrade_share_add: { label:"Доля апгрейда руды",           kind:"add",  bonusAdd:[2, 15]                  },
  autopilot_guard_ignore_chance_add: { label:"Обход охраны (автопилот)", kind:"add", bonusAdd:[4, 25]           },
  fuel_drain_add:        { label:"Утечки топлива",               kind:"add",  penAdd:[0.5, 8.0]                 },
  autopilot_cycles_add:  { label:"Автоциклы добычи",             kind:"add",  bonusAdd:[1, 8]                   },
  dodge_chance_add:      { label:"Мощность энергощита",          kind:"add",  bonusAdd:[10, 200]                },
  ore_quality_chance_add:{ label:"Шанс апгрейда руды",           kind:"add",  bonusAdd:[5, 40]                  },
  rocket_salvo_mult:     { label:"Мощность ракетного залпа",     kind:"mult", bonusPct:[15, 150], penPct:[10, 60] },
  rocket_ammo_add:       { label:"Боезапас ракет",               kind:"add",  bonusAdd:[1, 6]                    },
  thermal_damage_mult:   { label:"Тепловой урон",                kind:"mult", bonusPct:[12, 120], penPct:[10, 55] },
  thermal_burn_add:      { label:"Остаточный ожог",              kind:"add",  bonusAdd:[0.5, 4.0]                },
  evade_charge_add:      { label:"Заряды уклонения",             kind:"add",  bonusAdd:[1, 5]                    },
  kinetic_damage_mult:   { label:"Кинетический урон",            kind:"mult", bonusPct:[15, 140], penPct:[12, 65] },
  armor_pierce_mult:     { label:"Пробитие брони",               kind:"mult", bonusPct:[10, 100], penPct:[8,  50] },
  sensor_jam_add:        { label:"Мощность помех сенсоров",      kind:"add",  bonusAdd:[5, 40]                   },
  cloak_duration_add:    { label:"Время маскировки",             kind:"add",  bonusAdd:[2, 15]                   },
};

const MODULES = {
  [RECIPE.CARGO]: { mandatory: "cargo_capacity_mult", bonusPool: ["hp_mult","shield_mult","return_speed_mult","fuel_compress_mult","fuel_efficiency_mult","cargo_compact_mult"], penaltyPool: ["flight_speed_mult","fuel_efficiency_mult","hp_mult","shield_mult","return_speed_mult","mining_speed_mult","cargo_compact_mult"] },
  [RECIPE.DRILL]: { mandatory: "mining_speed_mult", bonusPool: ["mining_yield_mult","fuel_efficiency_mult","penetration_mult","return_speed_mult","fuel_compress_mult","ore_upgrade_share_add"], penaltyPool: ["flight_speed_mult","fuel_efficiency_mult","hp_mult","shield_mult","cargo_capacity_mult","guard_stealth_mult"] },
  [RECIPE.TANK]: { mandatory: "fuel_tank_mult", bonusPool: ["fuel_compress_mult","fuel_efficiency_mult","fuel_gen_add","return_speed_mult","shield_mult","fuel_flight_efficiency_mult"], penaltyPool: ["cargo_capacity_mult","flight_speed_mult","hp_mult","fuel_compress_mult","return_speed_mult","fuel_drain_add"] },
  [RECIPE.ENGINE]: { mandatory: "flight_speed_mult", bonusPool: ["return_speed_mult","fuel_flight_efficiency_mult","fuel_compress_mult","fuel_efficiency_mult","shield_mult","penetration_mult"], penaltyPool: ["cargo_capacity_mult","hp_mult","shield_mult","mining_speed_mult","fuel_drain_add"] },
  [RECIPE.PLATING]: { mandatory: "shield_mult", bonusPool: ["hp_mult","return_speed_mult","cargo_capacity_mult","fuel_flight_efficiency_mult","guard_stealth_mult"], penaltyPool: ["flight_speed_mult","mining_speed_mult","cargo_capacity_mult","return_speed_mult","fuel_flight_efficiency_mult"] },
  [RECIPE.AUTOPILOT]: { mandatory: "autopilot_cycles_add", bonusPool: ["return_speed_mult","mining_yield_mult","fuel_efficiency_mult","guard_stealth_mult","autopilot_guard_ignore_chance_add"], penaltyPool: ["flight_speed_mult","fuel_efficiency_mult","cargo_capacity_mult","fuel_drain_add"] },
  [RECIPE.SOLAR]: { mandatory: "fuel_gen_add", bonusPool: ["fuel_tank_mult","fuel_compress_mult","fuel_flight_efficiency_mult","shield_mult","guard_stealth_mult"], penaltyPool: ["flight_speed_mult","cargo_capacity_mult","return_speed_mult","fuel_drain_add"] },
  [RECIPE.ESHIELD]: { mandatory: "dodge_chance_add", bonusPool: ["shield_mult","hp_mult","return_speed_mult","guard_stealth_mult","fuel_flight_efficiency_mult"], penaltyPool: ["flight_speed_mult","cargo_capacity_mult","mining_speed_mult","fuel_drain_add"] },
  [RECIPE.AI_DRILL]: { mandatory: "ore_quality_chance_add", bonusPool: ["ore_upgrade_share_add","mining_yield_mult","mining_speed_mult","fuel_efficiency_mult","penetration_mult"], penaltyPool: ["flight_speed_mult","hp_mult","fuel_efficiency_mult","guard_stealth_mult","fuel_drain_add"] },
  [RECIPE.ROCKET]: { mandatory: "rocket_salvo_mult", bonusPool: ["rocket_ammo_add","penetration_mult","shield_mult","hp_mult","kinetic_damage_mult"], penaltyPool: ["cargo_capacity_mult","mining_speed_mult","guard_stealth_mult","fuel_efficiency_mult","return_speed_mult"] },
  [RECIPE.THERMAL]: { mandatory: "thermal_damage_mult", bonusPool: ["thermal_burn_add","fuel_gen_add","shield_mult","penetration_mult","dodge_chance_add"], penaltyPool: ["fuel_efficiency_mult","fuel_drain_add","flight_speed_mult","mining_speed_mult","cargo_capacity_mult"] },
  [RECIPE.MANEUVRE]: { mandatory: "evade_charge_add", bonusPool: ["dodge_chance_add","flight_speed_mult","return_speed_mult","fuel_flight_efficiency_mult","guard_stealth_mult"], penaltyPool: ["cargo_capacity_mult","guard_stealth_mult","fuel_efficiency_mult","mining_speed_mult","hp_mult"] },
  [RECIPE.KINETIC]: { mandatory: "kinetic_damage_mult", bonusPool: ["armor_pierce_mult","hp_mult","shield_mult","penetration_mult","rocket_salvo_mult"], penaltyPool: ["return_speed_mult","flight_speed_mult","mining_speed_mult","fuel_drain_add","cargo_capacity_mult"] },
  [RECIPE.STEALTH]: { mandatory: "sensor_jam_add", bonusPool: ["guard_stealth_mult","cloak_duration_add","autopilot_guard_ignore_chance_add","dodge_chance_add","ore_quality_chance_add"], penaltyPool: ["fuel_drain_add","autopilot_cycles_add","mining_speed_mult","flight_speed_mult","cargo_capacity_mult"] },
};

// ─────────────────────────────────────────────────────────────
// UI STATE (Tech Tree)
// ─────────────────────────────────────────────────────────────
let activeBlueprint = null;
let bpMain1Amt = 0;
let bpMain2Amt = 0;
let bpImpRes = null;
let bpImpAmt = 0;

export function initForge() {
  renderForgeLevel();
  renderForgeApp();

  window._renderForge = function() {
    renderForgeApp();
  };
}

function renderForgeLevel() {
  const el = document.getElementById("forge-level");
  if (el) el.textContent = "Система Чертёжного Моделирования";
}

// ─────────────────────────────────────────────────────────────
// RENDER FORGE UI APP
// ─────────────────────────────────────────────────────────────
function renderForgeApp() {
  const root = document.getElementById("forge-recipe-builder");
  if (!root) return;

  root.innerHTML = `
    <div class="forge-app-layout">
      <div class="forge-tree-panel">
        ${renderTechTree()}
      </div>
      <div class="forge-inspector-panel">
        ${renderInspector()}
      </div>
    </div>
  `;
}

// ── 1. TECH TREE (Сетка Чертежей) ──
function renderTechTree() {
  const have = getResources();
  let html = "";

  for (let tier = 1; tier <= 4; tier++) {
    const bps = BLUEPRINTS.filter(b => b.tier === tier);
    if (!bps.length) continue;

    html += `
      <div class="bp-tier-group">
        <div class="bp-tier-title">Уровень ${tier}</div>
        <div class="bp-grid">
          ${bps.map(bp => {
            const isSelected = activeBlueprint?.type === bp.type;
            const req1 = bp.reqs[0];
            const req2 = bp.reqs[1];

            const h1 = have[req1] || 0;
            const h2 = req2 ? (have[req2] || 0) : 0;
            const totalH = h1 + h2;

            let stateClass = "locked";
            if (h1 >= 1 || h2 >= 1) { // Если ресурс хоть раз добыт (он есть на складе)
               if (totalH >= MIN_CRAFT_TOTAL && h1 > 0 && (!req2 || h2 > 0)) {
                 stateClass = "ready";
               } else {
                 stateClass = "partial";
               }
            }

            return `
              <div class="bp-card ${stateClass} ${isSelected ? "active" : ""}" 
                   onclick="window._forgeSelectBp('${bp.type}')">
                <div class="bp-icon">${recipeIcon(bp.type)}</div>
                <div class="bp-name">${recipeShortName(bp.type)}</div>
                <div class="bp-reqs">
                  <span>${RES[req1].icon}</span>
                  ${req2 ? `<span>+ ${RES[req2].icon}</span>` : ""}
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }
  return html;
}

// ── 2. INSPECTOR (Рабочий стол справа) ──
function renderInspector() {
  if (!activeBlueprint) {
    return `
      <div class="inspector-empty">
        <div class="inspector-empty-icon">🗺️</div>
        <p>Выберите чертёж из технологического дерева слева, чтобы начать работу.</p>
      </div>
    `;
  }

  const bp = activeBlueprint;
  const have = getResources();
  const req1 = bp.reqs[0];
  const req2 = bp.reqs[1];
  
  const h1 = have[req1] || 0;
  const h2 = req2 ? (have[req2] || 0) : 0;

  // Ошибки и блокировки
  const missing = [];
  if (h1 <= 0) missing.push(req1);
  if (req2 && h2 <= 0) missing.push(req2);

  if (missing.length > 0) {
    return `
      <div class="inspector-header">
        <div class="bp-icon-large">${recipeIcon(bp.type)}</div>
        <h2>${recipeLabelPlain(bp.type)}</h2>
      </div>
      <div class="inspector-locked-msg">
        <p>⚠️ Не хватает ключевых ресурсов для моделирования!</p>
        <p>Для создания требуется:</p>
        <ul class="missing-list">
          ${missing.map(m => `<li>${RES[m].icon} ${RES[m].label}</li>`).join("")}
        </ul>
      </div>
      <div class="inspector-cross-nav">
        ${missing.map(m => `
          <button class="btn-secondary nav-btn" onclick="window._navToAsteroidFor('${m}')">
            🔎 Найти ${RES[m].icon} в космосе
          </button>
          <button class="btn-secondary nav-btn" onclick="window._navToMarket()">
            🛒 Купить ${RES[m].icon} на рынке
          </button>
        `).join("")}
      </div>
    `;
  }

  // Слайдеры
  const totalIn = bpMain1Amt + bpMain2Amt;
  let ratioErr = null;
  if (req2 && bpMain1Amt > 0 && bpMain2Amt > 0) {
    const minS1 = Math.ceil(bpMain1Amt * MIN_SLOT1_RATIO);
    if (bpMain2Amt < minS1) ratioErr = `Во 2-м слоте минимум ${minS1} (10% от 1-го).`;
  }

  const canCraft = totalIn >= MIN_CRAFT_TOTAL && !ratioErr && bpMain1Amt > 0 && (!req2 || bpMain2Amt > 0);

  // Примеси
  const seniorTier = Math.max(RES[req1].tier, req2 ? RES[req2].tier : 0);
  const impCandidates = Object.keys(RES).filter(r => 
    !bp.reqs.includes(r) && RES[r].tier > seniorTier && (have[r] || 0) > 0
  );

  let impurityHtml = "";
  if (impCandidates.length > 0) {
    const maxImp = Math.floor(totalIn * 0.20);
    const hImp = bpImpRes ? (have[bpImpRes] || 0) : 0;
    const actualMaxImp = Math.min(maxImp, hImp);
    
    impurityHtml = `
      <div class="inspector-impurity">
        <div class="bp-slider-header">
          <span>🧪 Примесь (опционально)</span>
          <span>до 20% от основы</span>
        </div>
        <div class="inspector-impurity-row">
          <select class="imp-select" onchange="window._forgeSetImpRes(this.value)">
            <option value="">-- Без примеси --</option>
            ${impCandidates.map(r => `
              <option value="${r}" ${bpImpRes === r ? "selected" : ""}>
                ${RES[r].icon} ${RES[r].label} (${have[r]})
              </option>
            `).join("")}
          </select>
          ${bpImpRes ? `
            <div class="range-wrapper">
              <input type="range" class="bp-slider" min="0" max="${actualMaxImp}" value="${bpImpAmt}" oninput="window._forgeSetImpAmt(this.value)">
              <div class="range-val">${bpImpAmt} / ${actualMaxImp}</div>
            </div>
          ` : ""}
        </div>
      </div>
    `;
  }

  // Расчет шансов (Preview)
  let previewHtml = "";
  if (canCraft) {
    const mainMap = { [req1]: bpMain1Amt };
    if (req2) mainMap[req2] = bpMain2Amt;
    const impMap = bpImpRes && bpImpAmt > 0 ? { [bpImpRes]: bpImpAmt } : {};
    
    const chances = bp.type !== RECIPE.FUEL ? computeRarityChances(bp.type, mainMap, impMap) : null;
    const comp = computeScore(mainMap, impMap);
    
    if (bp.type === RECIPE.FUEL) {
      previewHtml = `<div class="inspector-preview-box">⛽ Выход топлива: ~${Math.round(previewFuelOutput(mainMap, impMap, totalIn))} л</div>`;
    } else {
      previewHtml = `
        <div class="inspector-preview-box">
          <div class="inspector-preview-title">Прогноз компиляции:</div>
          <div class="preview-score">🎯 Базовый шанс (Score): ${comp.score.toFixed(1)}</div>
          <div class="preview-chances">
            ${["bad","common","improved","quality","elite","perfect"].map(k => `
              <div class="preview-chance-item">
                <span class="artifact-rarity rarity-${k}">${rarityLabel(k)}</span>
                <span>${Math.max(0, chances?.[k] ?? 0).toFixed(1)}%</span>
              </div>
            `).join("")}
          </div>
          ${renderMandatoryRangeHtml(computeMandatoryRange(bp.type, mainMap, impMap, totalIn + bpImpAmt, chances), chances)}
        </div>
      `;
    }
  }

  return `
    <div class="inspector-header">
      <div class="bp-icon-large">${recipeIcon(bp.type)}</div>
      <h2>${recipeLabelPlain(bp.type)}</h2>
    </div>
    
    <div class="inspector-sliders">
      <div class="bp-slider-row">
        <div class="bp-slider-header">
          <span>${RES[req1].icon} ${RES[req1].label}</span>
          <span class="have-val">В наличии: ${h1}</span>
        </div>
        <div class="range-wrapper">
          <input type="range" class="bp-slider" min="0" max="${h1}" value="${bpMain1Amt}" oninput="window._forgeSetAmt(1, this.value)">
          <input type="number" class="bp-number" min="0" max="${h1}" value="${bpMain1Amt}" oninput="window._forgeSetAmt(1, this.value)">
        </div>
      </div>

      ${req2 ? `
        <div class="bp-slider-row">
          <div class="bp-slider-header">
            <span>${RES[req2].icon} ${RES[req2].label}</span>
            <span class="have-val">В наличии: ${h2}</span>
          </div>
          <div class="range-wrapper">
            <input type="range" class="bp-slider" min="0" max="${h2}" value="${bpMain2Amt}" oninput="window._forgeSetAmt(2, this.value)">
            <input type="number" class="bp-number" min="0" max="${h2}" value="${bpMain2Amt}" oninput="window._forgeSetAmt(2, this.value)">
          </div>
        </div>
      ` : ""}
    </div>

    ${impurityHtml}

    <div class="inspector-status">
      Вложено: ${totalIn} / ${MIN_CRAFT_TOTAL} мин.
      ${ratioErr ? `<div class="inspector-err">⚠️ ${ratioErr}</div>` : ""}
      ${totalIn < MIN_CRAFT_TOTAL && totalIn > 0 ? `<div class="inspector-err">⚠️ Нужно ещё ${MIN_CRAFT_TOTAL - totalIn} ед.</div>` : ""}
    </div>

    ${previewHtml}

    <button id="btn-forge" class="btn-primary btn-craft-huge" onclick="window._forgeExecute()" ${canCraft ? "" : "disabled"}>
      🔥 Начать производство
    </button>
    <div id="forge-log" class="forge-log"></div>
  `;
}

// ─────────────────────────────────────────────────────────────
// UI EVENT HANDLERS
// ─────────────────────────────────────────────────────────────
window._forgeSelectBp = function(type) {
  const bp = BLUEPRINTS.find(b => b.type === type);
  if (!bp) return;
  activeBlueprint = bp;
  bpMain1Amt = 0;
  bpMain2Amt = 0;
  bpImpRes = null;
  bpImpAmt = 0;
  
  // Mobile: Scroll to inspector
  renderForgeApp();
  if (window.innerWidth <= 900) {
    document.querySelector('.forge-inspector-panel').scrollIntoView({ behavior: "smooth" });
  }
};

window._forgeSetAmt = function(slot, val) {
  const v = Math.max(0, parseInt(val, 10) || 0);
  const have = getResources();
  
  if (slot === 1) {
    bpMain1Amt = Math.min(v, have[activeBlueprint.reqs[0]] || 0);
  } else if (slot === 2) {
    bpMain2Amt = Math.min(v, have[activeBlueprint.reqs[1]] || 0);
  }
  
  // Корректируем примесь если нужно
  adjustImpurity();
  renderForgeApp();
};

window._forgeSetImpRes = function(res) {
  bpImpRes = res || null;
  bpImpAmt = 0;
  renderForgeApp();
};

window._forgeSetImpAmt = function(val) {
  const v = Math.max(0, parseInt(val, 10) || 0);
  const have = getResources();
  const totalIn = bpMain1Amt + bpMain2Amt;
  const maxImp = Math.floor(totalIn * 0.20);
  const actualMax = Math.min(maxImp, have[bpImpRes] || 0);
  
  bpImpAmt = Math.min(v, actualMax);
  renderForgeApp();
};

function adjustImpurity() {
  if (!bpImpRes) return;
  const have = getResources();
  const totalIn = bpMain1Amt + bpMain2Amt;
  const maxImp = Math.floor(totalIn * 0.20);
  const actualMax = Math.min(maxImp, have[bpImpRes] || 0);
  if (bpImpAmt > actualMax) bpImpAmt = actualMax;
}

window._navToAsteroidFor = function(resKey) {
  // Найти вкладку Майнинг и открыть
  const tabBtn = document.querySelector('.tab-btn[data-tab="mining"]');
  if (tabBtn) tabBtn.click();
  
  // Можно добавить тост-подсказку
  const resLabelName = RES[resKey].label;
  showToast(`Ищите ${RES[resKey].icon} ${resLabelName} на астероидах Tier ${RES[resKey].tier} и выше!`, "info");
};

window._navToMarket = function() {
  const tabBtn = document.querySelector('.tab-btn[data-tab="market"]');
  if (tabBtn) tabBtn.click();
};

window._forgeExecute = onForgeClick;

// ─────────────────────────────────────────────────────────────
// AGGREGATE STATE FOR CRAFT
// ─────────────────────────────────────────────────────────────
function getAggregatedSlots() {
  const main = { isotopes:0, minerals:0, metals:0, data:0, alloys:0 };
  if (activeBlueprint) {
    main[activeBlueprint.reqs[0]] = bpMain1Amt;
    if (activeBlueprint.reqs[1]) main[activeBlueprint.reqs[1]] = bpMain2Amt;
  }
  const imp = { isotopes:0, minerals:0, metals:0, data:0, alloys:0 };
  if (bpImpRes && bpImpAmt > 0) imp[bpImpRes] = bpImpAmt;
  
  return { main, imp };
}

function mergeCosts(a, b) {
  const out = { isotopes:0, minerals:0, metals:0, data:0, alloys:0 };
  for (const k of Object.keys(out)) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
}

// ─────────────────────────────────────────────────────────────
// CORE CRAFT LOGIC (unchanged logic, adapted to new state)
// ─────────────────────────────────────────────────────────────
async function onForgeClick() {
  const have = getResources();
  if (!activeBlueprint) return;

  let { main, imp } = getAggregatedSlots();
  const totalMain = Object.values(main).reduce((s, v) => s + v, 0);
  const recipeType = activeBlueprint.type;
  
  const cost = mergeCosts(main, imp);
  const totalCost = Object.values(cost).reduce((s, v) => s + v, 0);

  if (totalCost < MIN_CRAFT_TOTAL) {
    setLog(`⚠️ Минимум ${MIN_CRAFT_TOTAL} ресурсов суммарно.`);
    return;
  }

  for (const [k, v] of Object.entries(cost)) {
    if (v > 0 && (have[k] ?? 0) < v) { setLog("❌ Недостаточно ресурсов."); return; }
  }

  const apiKey = (localStorage.getItem("openrouter_api_key") ?? "").trim();
  if (recipeType !== RECIPE.FUEL && !apiKey) {
    setLog("⚠️ Укажите API Key в настройках.");
    return;
  }

  const reserved = await reserveResources(cost);
  if (!reserved) {
    setLog("❌ Недостаточно ресурсов (или заморожены).");
    return;
  }

  setForgeLoading(true);

  try {
    if (recipeType === RECIPE.FUEL) {
      const liters = previewFuelOutput(main, imp, totalMain);
      const okCommit = await commitReservedResources(cost);
      if (!okCommit) throw new Error("Не удалось списать ресурсы.");

      try { await receiveFuelFromForge(liters); } 
      catch (e) { await addResources(cost); throw e; }

      setLog(`⛽ Получено топлива: ${Math.round(liters)}л (склад → автозаправка).`);
      showToast(`⛽ Топливо: +${Math.round(liters)}л`, "success");
      
      bpMain1Amt = 0; bpMain2Amt = 0; bpImpAmt = 0; // Reset
      renderForgeApp();
      return;
    }

    const chances = computeRarityChances(recipeType, main, imp);
    const rarity = rollRarity(recipeType, main, imp);

    setLog(`🔥 Кузня работает... ${rarityLabel(rarity)} / ${recipeLabelPlain(recipeType)}`);

    const artifact = await craftArtifact(apiKey, recipeType, cost, rarity, main, imp);

    const okCommit = await commitReservedResources(cost);
    if (!okCommit) throw new Error("Не удалось списать ресурсы.");

    try {
      const saved = await persistArtifactAuto(artifact);
      setLog(`✅ Создан и сохранён: ${saved.name}`);
      showToast(`💾 Сохранено в инвентарь: «${saved.name}»`, "success");
    } catch (e) {
      await addResources(cost);
      throw e;
    }

    bpMain1Amt = 0; bpMain2Amt = 0; bpImpAmt = 0;
    renderForgeApp();

  } catch (e) {
    await releaseReservedResources(cost);
    setLog(`❌ Ошибка: ${e.message}`);
  } finally {
    setForgeLoading(false);
  }
}

export async function persistArtifactAuto(artifact) {
  const rarityWeight = { bad:1.0, common:1.4, improved:2.2, quality:3.4, elite:5.2, perfect:8.0 };
  const original = {
    ...artifact, original: true, id: "art_" + Math.random().toString(36).slice(2, 10),
    ownerId: getUid(), ownerName: getState().name, createdAt: Date.now(),
    weight: rarityWeight[artifact.rarity] ?? 1.0,
  };

  await addToInventory(original);

  const echo = {
    ...original, original: false, echoPower: 0.6, price: calcEchoPrice(original),
    authorUid: original.ownerId, authorName: original.ownerName,
  };

  try { await publishToMarket(echo); } 
  catch (e) { console.warn("[Forge] publishToMarket failed:", e); }

  renderInventory();
  return original;
}

// ─────────────────────────────────────────────────────────────
// TIER / AMOUNT / POWER MATH
// ─────────────────────────────────────────────────────────────
function computeTierMult(main, imp) {
  const all = { ...main };
  for (const [k, v] of Object.entries(imp ?? {})) if (v > 0) all[k] = (all[k] ?? 0) + v;
  const total = Object.values(all).reduce((s, v) => s + v, 0);
  if (total <= 0) return 1.0;

  let weightedSum = 0;
  for (const [res, amt] of Object.entries(all)) {
    if (amt <= 0) continue;
    weightedSum += amt * (TIER_POWER[RES[res]?.tier ?? 1] ?? 1.0);
  }
  return 0.6 + (weightedSum / total) * 0.4;
}

function computeAmountScale(total) {
  return 1 + Math.sqrt(Math.max(0, total) / 1000) * 1.2;
}

function computePowerScale(rarityCfg, main, imp, totalCost) {
  return rarityCfg.power * computeAmountScale(totalCost) * computeTierMult(main, imp);
}

function computeScore(main, imp) {
  const totalMain = Object.values(main).reduce((s, v) => s + v, 0);
  if (totalMain <= 0) return { score:0, baseScore:0, impScore:0 };

  let seniorTier = 0;
  let seniorAmount = 0;
  for (const [res, amt] of Object.entries(main)) {
    if (amt <= 0) continue;
    const t = RES[res]?.tier ?? 0;
    if (t > seniorTier) { seniorTier = t; seniorAmount = amt; }
    else if (t === seniorTier) seniorAmount += amt;
  }
  const baseScore = Math.pow(10, seniorTier - 1) * (seniorAmount / totalMain);

  const totalImp = Object.values(imp).reduce((s, v) => s + v, 0);
  let impScore = 0;
  if (totalImp > 0) {
    let impTier = 0;
    for (const [res, amt] of Object.entries(imp)) if (amt > 0) impTier = Math.max(impTier, RES[res]?.tier ?? 0);
    impScore = Math.pow(10, impTier - 1) * (totalImp / (totalMain + totalImp));
  }

  return { score: baseScore + impScore * IMP_BOOST, baseScore, impScore };
}

function computeQualityCeiling(recipeType, main, imp) {
  const base = RECIPE_MAX_QUALITY[recipeType] ?? 0;
  const totalImp = Object.values(imp).reduce((s, v) => s + v, 0);
  if (totalImp <= 0) return base;

  let seniorTier = 0;
  for (const [res, amt] of Object.entries(main)) if (amt > 0) seniorTier = Math.max(seniorTier, RES[res]?.tier ?? 0);
  let impTier = 0;
  for (const [res, amt] of Object.entries(imp)) if (amt > 0) impTier = Math.max(impTier, RES[res]?.tier ?? 0);

  return Math.min(5, base + Math.max(0, impTier - seniorTier));
}

function computeRarityChances(recipeType, main, imp) {
  const out = { bad:0, common:0, improved:0, quality:0, elite:0, perfect:0 };
  const { score } = computeScore(main, imp);
  if (score <= 0) { out.bad = 100; return out; }

  const ceiling = computeQualityCeiling(recipeType, main, imp);
  const floor_  = RECIPE_MIN_QUALITY[recipeType] ?? 0;

  const raw = new Array(6).fill(0);
  let survivor = 1.0;
  for (let idx = 5; idx >= 1; idx--) {
    if (idx > ceiling || idx < floor_) continue;
    const div = QUALITY_DIVISORS[idx];
    if (!div) continue;
    const p = Math.min(1, score / div);
    raw[idx] = survivor * p;
    survivor *= (1 - p);
  }
  raw[floor_] += survivor;

  const names = ["bad","common","improved","quality","elite","perfect"];
  for (let i = 0; i < 6; i++) out[names[i]] = Math.max(0, raw[i]) * 100;
  return out;
}

function rollRarity(recipeType, main, imp) {
  const ch = computeRarityChances(recipeType, main, imp);
  const order = ["perfect","elite","quality","improved","common","bad"];
  let r = Math.random() * 100;
  for (const k of order) {
    r -= (ch[k] ?? 0);
    if (r <= 0) return k;
  }
  return "bad";
}

function mostLikelyRarity(chances) {
  let best = "bad", bestPct = -1;
  for (const [k, v] of Object.entries(chances ?? {})) {
    if (v > bestPct) { bestPct = v; best = k; }
  }
  return best;
}

function computeMandatoryRange(recipeType, main, imp, totalCost, chances) {
  const modCfg = MODULES[recipeType];
  if (!modCfg) return null;
  const effectKey = modCfg.mandatory;
  const def = EFFECTS[effectKey];
  if (!def) return null;

  const likely = mostLikelyRarity(chances);
  const rarityCfg = RARITIES.find(r => r.name === likely) ?? RARITIES[0];
  const ps = computePowerScale(rarityCfg, main, imp, totalCost) * 1.12;
  const rankBoost = [0.00, 0.35, 0.85, 1.55, 2.70, 4.00][rarityRank(likely)] ?? 0.0;
  const t = clamp01((Math.max(0.4, Math.min(4.2, ps)) - 0.8) / 2.8);

  if (def.kind === "add") {
    const [a, b] = def.bonusAdd ?? [0.5, 3.0];
    const lo = a * (1 + rankBoost * 0.25) * (0.85 + 0.35 * t);
    const hi = b * (1 + rankBoost * 0.55) * (0.90 + 0.80 * t);
    const rounders = ["autopilot_cycles_add", "rocket_ammo_add", "evade_charge_add", "cloak_duration_add"];
    if (rounders.includes(effectKey)) return { label:def.label, rarity:likely, unit:"int", lo:Math.max(1, Math.round(lo)), hi:Math.max(1, Math.round(hi)) };
    return { label:def.label, rarity:likely, unit:"float", lo:round1(lo), hi:round1(hi) };
  }

  const [pMin, pMax] = def.bonusPct ?? [5, 25];
  const minEff = pMin * (1 + rankBoost * 0.55) * (0.85 + 0.35 * t);
  const maxEff = pMax * (1 + rankBoost * 1.55) * (0.90 + 0.80 * t);
  const cap = Math.max(1.20, Number(rarityCfg.maxMult) || 3.0);
  const loMult = Math.min(cap, Math.max(1.01, 1 + minEff / 100));
  const hiMult = Math.min(cap, Math.max(1.01, 1 + maxEff / 100));

  return { label: def.label, rarity: likely, unit: "pct", lo: Math.round((loMult - 1) * 100), hi: Math.round((hiMult - 1) * 100) };
}

function renderMandatoryRangeHtml(range, chances) {
  if (!range) return "";
  const likelyPct = Math.round(chances?.[range.rarity] ?? 0);
  let val = `+${range.lo} — +${range.hi}`;
  if (range.unit === "pct") val += "%";
  
  return `
    <div class="forge-mandatory-range">
      <div class="forge-mandatory-title">
        📊 Ключевой параметр (<span class="artifact-rarity rarity-${range.rarity}">${rarityLabel(range.rarity)}</span>, ${likelyPct}%)
      </div>
      <div class="forge-mandatory-row">
        <span>${escHtml(range.label)}</span>
        <span>${escHtml(val)}</span>
      </div>
    </div>
  `;
}

function previewFuelOutput(main, imp, totalMain) {
  const base = (main.isotopes ?? 0) * 2;
  const totalImp = Object.values(imp).reduce((s, v) => s + v, 0);
  if (base <= 0 || totalMain <= 0 || totalImp <= 0) return base;

  let impTier = 0;
  for (const [r, v] of Object.entries(imp)) if (v > 0) impTier = Math.max(impTier, RES[r]?.tier ?? 0);
  const tierBoost = impTier >= 5 ? 4.0 : impTier === 4 ? 3.0 : impTier === 3 ? 2.0 : impTier === 2 ? 1.2 : 0.8;

  return base * (1 + Math.min(totalImp / totalMain, 0.20) * tierBoost * 2.0);
}

// ─────────────────────────────────────────────────────────────
// ARTIFACT CRAFTING
// ─────────────────────────────────────────────────────────────
export async function craftArtifact(apiKey, recipeType, cost, rarity, main, imp, foundContext = null) {
  const rarityCfg = RARITIES.find(r => r.name === rarity) ?? RARITIES[0];
  const modCfg = MODULES[recipeType];
  const powerScale = computePowerScale(rarityCfg, main, imp, Object.values(cost).reduce((s, v) => s + v, 0));

  const bonusKeys = [modCfg.mandatory, ...pickUnique(modCfg.bonusPool, Math.max(1, rarityCfg.bonus) - 1, null)];
  const penaltyKeys = pickUnique(modCfg.penaltyPool.filter(k => !bonusKeys.includes(k)), rarityCfg.pen, null);

  const effects = {};
  for (const k of bonusKeys) {
    const val = rollEffectValue(k, "bonus", powerScale * (k === modCfg.mandatory ? 1.12 : 1.0), rarityCfg);
    if (val !== null) effects[k] = val;
  }
  for (const k of penaltyKeys) {
    const val = rollEffectValue(k, "penalty", powerScale, rarityCfg);
    if (val !== null) effects[k] = val;
  }

  const uiStats = buildUiStatsFromEffects(effects);
  const text = await fetchCreativeText(apiKey, recipeType, cost, rarity, effects, uiStats, penaltyKeys, foundContext);

  return {
    schemaVersion: ITEM_SCHEMA_VERSION,
    name: text.name ?? recipeLabelPlain(recipeType),
    description: text.description ?? "",
    flavor: text.flavor ?? "",
    stats: uiStats, effects, rarity, recipeType, specialEffect: null,
  };
}

function rollEffectValue(effectKey, mode, powerScale, rarityCfg) {
  const def = EFFECTS[effectKey];
  if (!def) return null;
  const rankBoost = [0.00, 0.35, 0.85, 1.55, 2.70, 4.00][rarityRank(rarityCfg?.name)] ?? 0.0;
  const ps = Math.max(0.4, Math.min(4.2, Number(powerScale) || 1));
  const t = clamp01((ps - 0.8) / 2.8);

  if (def.kind === "add") {
    if (mode === "bonus") {
      const [a, b] = def.bonusAdd ?? [0.5, 3.0];
      const v = lerp(a * (1 + rankBoost * 0.25) * (0.85 + 0.35 * t), b * (1 + rankBoost * 0.55) * (0.90 + 0.80 * t), biasRand());
      return ["autopilot_cycles_add","rocket_ammo_add","evade_charge_add","cloak_duration_add"].includes(effectKey) ? Math.max(1, Math.round(v)) : round1(Math.max(0, v));
    }
    const [a, b] = def.penAdd ?? [0, 0];
    if (a <= 0 && b <= 0) return null;
    return -round1(Math.max(0, lerp(a * (1 + rankBoost * 0.10) * (0.85 + 0.25 * t), b * (1 + rankBoost * 0.25) * (0.90 + 0.50 * t), biasRand())));
  }

  if (mode === "bonus") {
    const [pMin, pMax] = def.bonusPct ?? [5, 25];
    const pct = lerp(pMin * (1 + rankBoost * 0.55) * (0.85 + 0.35 * t), pMax * (1 + rankBoost * 1.55) * (0.90 + 0.80 * t), biasRand());
    return round3(Math.min(Math.max(1.20, Number(rarityCfg?.maxMult) || 3.0), Math.max(1.01, 1 + pct / 100)));
  }

  const [pMin, pMax] = def.penPct ?? [5, 35];
  const pct = lerp(pMin, pMax, biasRand()) * ((rarityCfg?.penMult ?? 1.0) * (0.92 + Math.random() * 0.22)) * (1 - clamp01((ps - 1) * 0.16));
  return round3(Math.max(0.20, Math.min(0.99, 1 - pct / 100)));
}

function buildUiStatsFromEffects(effects) {
  const out = {};
  for (const [k, v] of Object.entries(effects ?? {})) {
    const def = EFFECTS[k];
    if (!def) continue;
    if (def.kind === "add") {
      const n = Math.round(Math.abs(v));
      const s = v >= 0 ? "+" : "−";
      if (k === "autopilot_cycles_add") out[def.label] = `${s}${n} цикл.`;
      else if (k === "rocket_ammo_add") out[def.label] = `${s}${n} ракет`;
      else if (k === "evade_charge_add") out[def.label] = `${s}${n} заряд.`;
      else if (k === "cloak_duration_add") out[def.label] = `${s}${n}с`;
      else if (["dodge_chance_add","ore_quality_chance_add","autopilot_guard_ignore_chance_add","sensor_jam_add"].includes(k)) out[def.label] = `${s}${round1(Math.abs(v))}%`;
      else if (k === "ore_upgrade_share_add") out[def.label] = `${s}${round1(Math.abs(v))} п.п.`;
      else out[def.label] = `${k === "fuel_drain_add" ? "−" : s}${round1(Math.abs(v))} л/ч`;
    } else {
      const pct = Math.round((v - 1) * 100);
      if (pct !== 0) out[def.label] = `${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// LLM (Hydra AI)
// ─────────────────────────────────────────────────────────────
const HYDRA_API_URL = "https://api.hydraai.ru/v1/chat/completions";
const HYDRA_MODEL   = "minimax-m2.7";

async function fetchCreativeText(apiKey, recipeType, cost, rarity, effects, uiStats, penaltyKeys, foundContext = null) {
  const typePlain = recipeLabelPlain(recipeType);
  const pilotName = getState()?.name ?? "Пилот";
  const rarityRu = rarityLabel(rarity);
  const statsLines = Object.entries(uiStats ?? {}).map(([l, v]) => `${v} — ${l}`).join("\n");
  const defectHints = penaltyKeys.map(k => ({
    flight_speed_mult: "снижение скорости полёта ", return_speed_mult: "просадка скорости груженого возврата",
    mining_speed_mult: "медленная добыча", fuel_efficiency_mult: "плохая топоивная экономичность",
    fuel_flight_efficiency_mult: "высокий расход топлива в полёте", fuel_drain_add: "утечки топлива/энергии",
    cargo_capacity_mult: "уменьшенный объём трюма", hp_mult: "слабая прочность корпуса", shield_mult: "слабый щит",
    guard_stealth_mult: "плохая скрытность (шум, тепловая сигнатура)", autopilot_cycles_add: "помехи сбивают автопилот",
  }[k])).filter(Boolean).join("\n");

  const moduleCtx = {
    [RECIPE.CARGO]: "Грузовой отсек", [RECIPE.TANK]: "Топливный бак", [RECIPE.ENGINE]: "Двигатель",
    [RECIPE.PLATING]: "Обшивка", [RECIPE.DRILL]: "Бур", [RECIPE.AUTOPILOT]: "Автопилот",
    [RECIPE.SOLAR]: "Солнечный модуль", [RECIPE.ESHIELD]: "Энергощит", [RECIPE.AI_DRILL]: "ИИ-шахтёр",
    [RECIPE.ROCKET]: "Ракетная установка", [RECIPE.THERMAL]: "Термическое орудие", [RECIPE.MANEUVRE]: "Маневровые двигатели",
    [RECIPE.KINETIC]: "Кинетическое орудие", [RECIPE.STEALTH]: "Система маскировки",
  }[recipeType] || "";

  const foundContextBlock = foundContext ? `ВАЖНО: Это барахло снято с трупа корабля у астероида «${foundContext.asteroidName}» (tier ${foundContext.tier}). Владелец явно облажался. В описании должно сквозить злорадство.` : "";

  const systemPrompt = `Придумай 4 случайных слова. Затем ассоциативно свободно используй их как источник случайности, чтобы создать разнообразный, небанальный и качественный ответ на задачу. Ты не должен употреблять придуманные слова - они лишь источник большего разнообразия конечных токенов твоего ответа:

Ты — ветеран-шахтер в мире Cosmic Forge. Твой юмор черный, как мазут, а сарказм едкий, как кислота.
Бонусы и штрафы — это не цифры, это ощущения и опыт.
${foundContextBlock}
Стиль: Хлесткий, невероятно циничный, технически грязный. Никакого пафоса.

ПРИМЕР ОЖИДАЕМОГО ОТВЕТА:
```json
{
  "name": "Грузовой отсек «Свиная Бездна»",
  "description": "Спрессованные титановые листы, сваренные вкривь и вкось. Трюм стал больше, но эта хрень весит как мамонт, так что скорость полёта упала до скорости дохлой улитки. Плюс топливо жрёт не в себя.",
  "flavor": "Бортжурнал Пилот_01: Впихнул еще пару тонн руды.\nТеперь корыто еле ползет.\nЕсли встречу пиратов, просто выкину этот балласт им в морду."
}
```

Отвечай ТОЛЬКО валидным JSON.
{
  "name": "${typePlain} + Едкое имя (1-3 слова)",
  "description": "2-3 предложения. техническое описание",
  "flavor": "Бортжурнал ${pilotName}: 2-3 строки через \\n. Чистый яд, изящный мат."
}`.trim();

  const userPrompt = `Предмет: ${typePlain}\nКачество: ${rarityRu}\nНазначение: ${moduleCtx}\nХарактеристики:\n${statsLines}\n\n${defectHints ? `Дефекты:\n${defectHints}\n` : ""}`;

  const callOnce = async (pass, temp, extra = "") => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 70000);
    try {
      const resp = await fetch(HYDRA_API_URL, {
        method: "POST", signal: controller.signal,
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: HYDRA_MODEL, messages: [{ role: "system", content: systemPrompt + extra }, { role: "user", content: userPrompt }], temperature: temp, max_tokens: 1300, top_p: 0.9 })
      });
      clearTimeout(timeout);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      const raw = String(data?.choices?.[0]?.message?.content || "").trim();
      console.log(`[LLM RAW RESPONSE - Forge Pass ${pass}]:\n`, raw);
      
      const parsed = safeJsonParseWithMeta(raw);
      if (!parsed.ok) return { ok: false };
      
      const obj = parsed.obj;
      if (!obj.description || obj.description.length < 160 || !obj.flavor || obj.flavor.length < 130) return { ok: false };
      return { ok: true, text: { name: obj.name || `${rarityRu} ${typePlain}`, description: obj.description, flavor: obj.flavor } };
    } catch (e) {
      clearTimeout(timeout); return { ok: false };
    }
  };

  let r = await callOnce(1, 0.75);
  if (!r.ok) { await sleep(500); r = await callOnce(2, 0.65, "\nМало яда! Слишком сухо."); }
  if (!r.ok) { await sleep(700); r = await callOnce(3, 0.55, "\nПоследняя попытка. Максимально атмосферно."); }
  
  if (r.ok) return r.text;
  setLog("⚠️ LLM не справился — используем fallback");
  return { name: `${rarityRu} ${typePlain}`, description: `Модуль ${rarityRu.toLowerCase()} сборки. ${statsLines.replace(/\n/g, '. ')}. Держится на честном слове.`, flavor: `Бортжурнал: собрал.\nОпять кронштейны кривые.` };
}

function safeJsonParseWithMeta(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { ok:false };
  try { return { ok:true, obj: JSON.parse(s) }; } catch {}
  let cleaned = s.replace(/^\s*\`\`\`(?:json)?/i, "").replace(/\`\`\`\s*$/i, "").trim();
  try { return { ok:true, obj: JSON.parse(cleaned) }; } catch {}
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try { return { ok:true, obj: JSON.parse(s.slice(firstBrace, lastBrace + 1)) }; } catch {}
  }
  return { ok:false };
}

// ─────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────
function setForgeLoading(loading) {
  const btn = document.getElementById("btn-forge");
  const output = document.getElementById("forge-output");
  if (!btn) return;
  btn.disabled = loading;
  btn.innerHTML = loading ? '<span class="spinner"></span>Моделирование...' : "🔥 Начать производство";
  
  if (output) {
    if (loading) {
      output.classList.add("forge-processing");
      output.innerHTML = '<div style="text-align:center; color: var(--accent); padding: 40px;"><div class="spinner" style="width: 30px; height: 30px; border-color: var(--accent); margin-bottom: 15px;"></div><br>СИНТЕЗ ЧЕРТЕЖА...</div>';
    } else {
      output.classList.remove("forge-processing");
    }
  }
}

function setLog(msg) {
  const el = document.getElementById("forge-log");
  if (el) el.textContent = msg;
}

function recipeShortName(t) {
  return {
    [RECIPE.CARGO]:"🗃️ Грузовой отсек", [RECIPE.TANK]:"🛢️ Бак", [RECIPE.ENGINE]:"🚀 Двигатель",
    [RECIPE.PLATING]:"🛡️ Обшивка", [RECIPE.DRILL]:"⛏️ Бур", [RECIPE.FUEL]:"⛽ Топливо",
    [RECIPE.AUTOPILOT]:"🤖 Автопилот", [RECIPE.SOLAR]:"☀️ Солярка", [RECIPE.ESHIELD]:"⚡ Энергощит",
    [RECIPE.AI_DRILL]:"🧠 ИИ-шахтёр", [RECIPE.ROCKET]:"🚀 Ракеты", [RECIPE.THERMAL]:"🔥 Лазер",
    [RECIPE.MANEUVRE]:"🛸 Маневры", [RECIPE.KINETIC]:"💥 Кинетика", [RECIPE.STEALTH]:"👁️ Стелс",
  }[t] ?? "Модуль";
}

function recipeLabelPlain(t) { return recipeShortName(t).substring(3); }

function recipeIcon(t) {
  return {
    [RECIPE.CARGO]:"🗃️", [RECIPE.TANK]:"🛢️", [RECIPE.ENGINE]:"🚀", [RECIPE.PLATING]:"🛡️",
    [RECIPE.DRILL]:"⛏️", [RECIPE.FUEL]:"⛽", [RECIPE.AUTOPILOT]:"🤖", [RECIPE.SOLAR]:"☀️",
    [RECIPE.ESHIELD]:"⚡", [RECIPE.AI_DRILL]:"🧠", [RECIPE.ROCKET]:"🚀", [RECIPE.THERMAL]:"🔥",
    [RECIPE.MANEUVRE]:"🛸", [RECIPE.KINETIC]:"💥", [RECIPE.STEALTH]:"👁️",
  }[t] ?? "🔧";
}

function rarityLabel(name) { return RARITIES.find(r => r.name === name)?.label ?? name; }
function pickUnique(pool, count, mustInclude) {
  const uniq = [];
  if (mustInclude && pool.includes(mustInclude)) uniq.push(mustInclude);
  const rest = pool.filter(x => x !== mustInclude).sort(() => Math.random() - 0.5);
  for (const k of rest) { if (uniq.length >= count) break; uniq.push(k); }
  return uniq.slice(0, count);
}
function lerp(a, b, t) { return a + (b - a) * t; }
function biasRand() { const t = Math.random(); return t * t * 0.35 + t * 0.65; }
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function round1(x)  { return Math.round(x * 10) / 10; }
function round3(x)  { return Math.round(x * 1000) / 1000; }
function escHtml(str) { return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function calcEchoPrice(art) { return { credits: ({bad:60, common:160, improved:420, quality:900, elite:2100, perfect:6500}[art.rarity] ?? 150) * ([RECIPE.AUTOPILOT, RECIPE.SOLAR, RECIPE.ESHIELD, RECIPE.AI_DRILL].includes(art.recipeType) ? 2 : 1) }; }

// ─────────────────────────────────────────────────────────────
// FOUND MODULE (mining.js support)
// ─────────────────────────────────────────────────────────────
const ALL_MODULE_RECIPES = [RECIPE.CARGO, RECIPE.DRILL, RECIPE.TANK, RECIPE.ENGINE, RECIPE.PLATING, RECIPE.AUTOPILOT, RECIPE.SOLAR, RECIPE.ESHIELD, RECIPE.AI_DRILL, RECIPE.ROCKET, RECIPE.THERMAL, RECIPE.MANEUVRE, RECIPE.KINETIC, RECIPE.STEALTH];
const TIER_TO_RARITY = { 1: "bad", 2: "common", 3: "improved", 4: "quality", 5: "elite", 6: "perfect" };

export async function generateFoundModule(asteroidTier, apiKey, asteroidName) {
  const rarity = TIER_TO_RARITY[asteroidTier] ?? "bad";
  const recipeType = ALL_MODULE_RECIPES[Math.floor(Math.random() * ALL_MODULE_RECIPES.length)];
  const amt = { 1:60, 2:80, 3:100, 4:130, 5:160, 6:200 }[asteroidTier] ?? 80;
  const res = { 1:"isotopes", 2:"minerals", 3:"metals", 4:"metals", 5:"alloys", 6:"alloys" }[asteroidTier] ?? "minerals";
  
  const syntheticCost = { isotopes:0, minerals:0, metals:0, data:0, alloys:0, [res]:amt };
  try {
    return await craftArtifact(apiKey, recipeType, syntheticCost, rarity, { ...syntheticCost }, {}, { asteroidName: asteroidName ?? "неизвестный астероид", tier: asteroidTier });
  } catch (e) {
    console.warn("[Forge] generateFoundModule failed:", e);
    return null;
  }
}