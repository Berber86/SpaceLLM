// forge.js — Кузня (v12)
// - добавлен ресурс tier-5: alloys (🔩 Боевые сплавы)
// - добавлены 5 новых рецептов (оружейные/боевые)
// - ИЗМЕНЕНИЕ: убрана ручная кнопка "Сохранить" — модуль после крафта
//   автоматически сохраняется в инвентарь и публикует эхо на рынке.
//   (Промпты LLM НЕ трогались.)

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

const MAX_MAIN_SLOTS  = 2;
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

  // tier-5
  ROCKET:    "rocket_module",       // 🔩
  THERMAL:   "thermal_module",      // 🔩+☢️
  MANEUVRE:  "maneuvre_module",     // 🔩+🪨
  KINETIC:   "kinetic_module",      // 🔩+⚙️
  STEALTH:   "stealth_module",      // 🔩+💾
};

const RECIPE_MIN_QUALITY = {
  [RECIPE.FUEL]:      0,
  [RECIPE.CARGO]:     0,
  [RECIPE.DRILL]:     2,
  [RECIPE.TANK]:      0,
  [RECIPE.ENGINE]:    1,
  [RECIPE.PLATING]:   0,
  [RECIPE.AUTOPILOT]: 2,
  [RECIPE.SOLAR]:     1,
  [RECIPE.ESHIELD]:   1,
  [RECIPE.AI_DRILL]:  2,

  [RECIPE.ROCKET]:    2,
  [RECIPE.THERMAL]:   2,
  [RECIPE.MANEUVRE]:  2,
  [RECIPE.KINETIC]:   2,
  [RECIPE.STEALTH]:   3,
};

const RECIPE_MAX_QUALITY = {
  [RECIPE.FUEL]:      2,
  [RECIPE.CARGO]:     3,
  [RECIPE.DRILL]:     5,
  [RECIPE.TANK]:      2,
  [RECIPE.ENGINE]:    4,
  [RECIPE.PLATING]:   3,
  [RECIPE.AUTOPILOT]: 5,
  [RECIPE.SOLAR]:     4,
  [RECIPE.ESHIELD]:   4,
  [RECIPE.AI_DRILL]:  5,

  [RECIPE.ROCKET]:    5,
  [RECIPE.THERMAL]:   5,
  [RECIPE.MANEUVRE]:  5,
  [RECIPE.KINETIC]:   5,
  [RECIPE.STEALTH]:   5,
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

const QUALITY_DIVISORS = [
  null,    // bad
  100,     // common
  100,     // improved
  1000,    // quality
  10000,   // elite
  100000,  // perfect
];

const IMP_BOOST = 4.0;

// ─────────────────────────────────────────────────────────────
// Effects
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

  // tier-5 боевые
  rocket_salvo_mult:     { label:"Мощность ракетного залпа",     kind:"mult", bonusPct:[15, 150], penPct:[10, 60] },
  rocket_ammo_add:       { label:"Боезапас ракет",               kind:"add",  bonusAdd:[1, 6]                    },
  thermal_damage_mult:   { label:"Тепловой урон",                kind:"mult", bonusPct:[12, 120], penPct:[10, 55] },
  thermal_burn_add:      { label:"Остаточный ожог (доп. урон)",  kind:"add",  bonusAdd:[0.5, 4.0]                },
  evade_charge_add:      { label:"Заряды уклонения",             kind:"add",  bonusAdd:[1, 5]                    },
  kinetic_damage_mult:   { label:"Кинетический урон",            kind:"mult", bonusPct:[15, 140], penPct:[12, 65] },
  armor_pierce_mult:     { label:"Пробитие брони",               kind:"mult", bonusPct:[10, 100], penPct:[8,  50] },
  sensor_jam_add:        { label:"Мощность помех сенсоров",      kind:"add",  bonusAdd:[5, 40]                   },
  cloak_duration_add:    { label:"Время активной маскировки",    kind:"add",  bonusAdd:[2, 15]                   },
};

// ─────────────────────────────────────────────────────────────
// Modules pools
// ─────────────────────────────────────────────────────────────

const MODULES = {
  [RECIPE.CARGO]: {
    mandatory:   "cargo_capacity_mult",
    bonusPool:   ["hp_mult","shield_mult","return_speed_mult","fuel_compress_mult","fuel_efficiency_mult","cargo_compact_mult"],
    penaltyPool: ["flight_speed_mult","fuel_efficiency_mult","hp_mult","shield_mult","return_speed_mult","mining_speed_mult","cargo_compact_mult"],
  },
  [RECIPE.DRILL]: {
    mandatory:   "mining_speed_mult",
    bonusPool:   ["mining_yield_mult","fuel_efficiency_mult","penetration_mult","return_speed_mult","fuel_compress_mult","ore_upgrade_share_add"],
    penaltyPool: ["flight_speed_mult","fuel_efficiency_mult","hp_mult","shield_mult","cargo_capacity_mult","guard_stealth_mult"],
  },
  [RECIPE.TANK]: {
    mandatory:   "fuel_tank_mult",
    bonusPool:   ["fuel_compress_mult","fuel_efficiency_mult","fuel_gen_add","return_speed_mult","shield_mult","fuel_flight_efficiency_mult"],
    penaltyPool: ["cargo_capacity_mult","flight_speed_mult","hp_mult","fuel_compress_mult","return_speed_mult","fuel_drain_add"],
  },
  [RECIPE.ENGINE]: {
    mandatory:   "flight_speed_mult",
    bonusPool:   ["return_speed_mult","fuel_flight_efficiency_mult","fuel_compress_mult","fuel_efficiency_mult","shield_mult","penetration_mult"],
    penaltyPool: ["cargo_capacity_mult","hp_mult","shield_mult","mining_speed_mult","fuel_drain_add"],
  },
  [RECIPE.PLATING]: {
    mandatory:   "shield_mult",
    bonusPool:   ["hp_mult","return_speed_mult","cargo_capacity_mult","fuel_flight_efficiency_mult","guard_stealth_mult"],
    penaltyPool: ["flight_speed_mult","mining_speed_mult","cargo_capacity_mult","return_speed_mult","fuel_flight_efficiency_mult"],
  },
  [RECIPE.AUTOPILOT]: {
    mandatory:   "autopilot_cycles_add",
    bonusPool:   ["return_speed_mult","mining_yield_mult","fuel_efficiency_mult","guard_stealth_mult","autopilot_guard_ignore_chance_add"],
    penaltyPool: ["flight_speed_mult","fuel_efficiency_mult","cargo_capacity_mult","fuel_drain_add"],
  },
  [RECIPE.SOLAR]: {
    mandatory:   "fuel_gen_add",
    bonusPool:   ["fuel_tank_mult","fuel_compress_mult","fuel_flight_efficiency_mult","shield_mult","guard_stealth_mult"],
    penaltyPool: ["flight_speed_mult","cargo_capacity_mult","return_speed_mult","fuel_drain_add"],
  },
  [RECIPE.ESHIELD]: {
    mandatory:   "dodge_chance_add",
    bonusPool:   ["shield_mult","hp_mult","return_speed_mult","guard_stealth_mult","fuel_flight_efficiency_mult"],
    penaltyPool: ["flight_speed_mult","cargo_capacity_mult","mining_speed_mult","fuel_drain_add"],
  },
  [RECIPE.AI_DRILL]: {
    mandatory:   "ore_quality_chance_add",
    bonusPool:   ["ore_upgrade_share_add","mining_yield_mult","mining_speed_mult","fuel_efficiency_mult","penetration_mult"],
    penaltyPool: ["flight_speed_mult","hp_mult","fuel_efficiency_mult","guard_stealth_mult","fuel_drain_add"],
  },

  // tier-5
  [RECIPE.ROCKET]: {
    mandatory:   "rocket_salvo_mult",
    bonusPool:   ["rocket_ammo_add","penetration_mult","shield_mult","hp_mult","kinetic_damage_mult"],
    penaltyPool: ["cargo_capacity_mult","mining_speed_mult","guard_stealth_mult","fuel_efficiency_mult","return_speed_mult"],
  },
  [RECIPE.THERMAL]: {
    mandatory:   "thermal_damage_mult",
    bonusPool:   ["thermal_burn_add","fuel_gen_add","shield_mult","penetration_mult","dodge_chance_add"],
    penaltyPool: ["fuel_efficiency_mult","fuel_drain_add","flight_speed_mult","mining_speed_mult","cargo_capacity_mult"],
  },
  [RECIPE.MANEUVRE]: {
    mandatory:   "evade_charge_add",
    bonusPool:   ["dodge_chance_add","flight_speed_mult","return_speed_mult","fuel_flight_efficiency_mult","guard_stealth_mult"],
    penaltyPool: ["cargo_capacity_mult","guard_stealth_mult","fuel_efficiency_mult","mining_speed_mult","hp_mult"],
  },
  [RECIPE.KINETIC]: {
    mandatory:   "kinetic_damage_mult",
    bonusPool:   ["armor_pierce_mult","hp_mult","shield_mult","penetration_mult","rocket_salvo_mult"],
    penaltyPool: ["return_speed_mult","flight_speed_mult","mining_speed_mult","fuel_drain_add","cargo_capacity_mult"],
  },
  [RECIPE.STEALTH]: {
    mandatory:   "sensor_jam_add",
    bonusPool:   ["guard_stealth_mult","cloak_duration_add","autopilot_guard_ignore_chance_add","dodge_chance_add","ore_quality_chance_add"],
    penaltyPool: ["fuel_drain_add","autopilot_cycles_add","mining_speed_mult","flight_speed_mult","cargo_capacity_mult"],
  },
};

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────

let slots = [
  { res:null, amount:0 },
  { res:null, amount:0 },
];
let impurity        = { res:null, amount:0 };

// оставляем переменную (чтобы не трогать лишнее), но больше не используем кнопку сохранения
let pendingArtifact = null;

// ─────────────────────────────────────────────────────────────

export function initForge() {
  renderForgeLevel();
  renderRecipeBuilder();
  updateForgePreview();
  wireButtons();

  // кнопка сохранения больше не нужна
  document.getElementById("btn-save-artifact")?.classList.add("hidden");

  window._renderForge = function() {
    renderRecipeBuilder();
    updateForgePreview();
  };
}

function wireButtons() {
  document.getElementById("btn-forge")?.addEventListener("click", onForgeClick);

  // Больше не используем ручное сохранение
  // document.getElementById("btn-save-artifact")?.addEventListener("click", onSaveClick);
  document.getElementById("btn-save-artifact")?.classList.add("hidden");
}

// ─────────────────────────────────────────────────────────────
// Tier/Amount/Power
// ─────────────────────────────────────────────────────────────

function computeTierMult(main, imp) {
  const all = { ...main };
  for (const [k, v] of Object.entries(imp ?? {})) if (v > 0) all[k] = (all[k] ?? 0) + v;

  const total = Object.values(all).reduce((s, v) => s + v, 0);
  if (total <= 0) return 1.0;

  let weightedSum = 0;
  for (const [res, amt] of Object.entries(all)) {
    if (amt <= 0) continue;
    const tier = RES[res]?.tier ?? 1;
    weightedSum += amt * (TIER_POWER[tier] ?? 1.0);
  }

  const tierScore = weightedSum / total;
  return 0.6 + tierScore * 0.4;
}

function computeAmountScale(total) {
  return 1 + Math.sqrt(Math.max(0, total) / 1000) * 1.2;
}

function computePowerScale(rarityCfg, main, imp, totalCost) {
  return rarityCfg.power * computeAmountScale(totalCost) * computeTierMult(main, imp);
}

// ─────────────────────────────────────────────────────────────
// Score + chances
// ─────────────────────────────────────────────────────────────

function computeScore(main, imp) {
  const totalMain = Object.values(main).reduce((s, v) => s + v, 0);
  if (totalMain <= 0) return { score:0, baseScore:0, impScore:0 };

  let seniorTier   = 0;
  let seniorAmount = 0;
  for (const [res, amt] of Object.entries(main)) {
    if (amt <= 0) continue;
    const t = RES[res]?.tier ?? 0;
    if (t > seniorTier) { seniorTier = t; seniorAmount = amt; }
    else if (t === seniorTier) seniorAmount += amt;
  }

  const seniorShare = seniorAmount / totalMain;
  const baseScore   = Math.pow(10, seniorTier - 1) * seniorShare;

  const totalImp = Object.values(imp).reduce((s, v) => s + v, 0);
  let impScore   = 0;
  if (totalImp > 0) {
    const totalAll = totalMain + totalImp;
    const impShare = totalImp / totalAll;
    let impTier = 0;
    for (const [res, amt] of Object.entries(imp)) {
      if (amt > 0) impTier = Math.max(impTier, RES[res]?.tier ?? 0);
    }
    impScore = Math.pow(10, impTier - 1) * impShare;
  }

  return { score: baseScore + impScore * IMP_BOOST, baseScore, impScore };
}

function computeQualityCeiling(recipeType, main, imp) {
  const base     = RECIPE_MAX_QUALITY[recipeType] ?? 0;
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
  const ch    = computeRarityChances(recipeType, main, imp);
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

// ─────────────────────────────────────────────────────────────
// Mandatory range (UI)
// ─────────────────────────────────────────────────────────────

function computeMandatoryRange(recipeType, main, imp, totalCost, chances) {
  const modCfg = MODULES[recipeType];
  if (!modCfg) return null;

  const effectKey = modCfg.mandatory;
  const def = EFFECTS[effectKey];
  if (!def) return null;

  const likely    = mostLikelyRarity(chances);
  const rarityCfg = RARITIES.find(r => r.name === likely) ?? RARITIES[0];

  const ps       = computePowerScale(rarityCfg, main, imp, totalCost) * 1.12;
  const rank     = rarityRank(likely);
  const rankBoost= [0.00, 0.35, 0.85, 1.55, 2.70, 4.00][rank] ?? 0.0;
  const psC      = Math.max(0.4, Math.min(4.2, ps));
  const t        = clamp01((psC - 0.8) / 2.8);

  if (def.kind === "add") {
    const [a, b] = def.bonusAdd ?? [0.5, 3.0];
    const lo = a * (1 + rankBoost * 0.25) * (0.85 + 0.35 * t);
    const hi = b * (1 + rankBoost * 0.55) * (0.90 + 0.80 * t);

    if (effectKey === "autopilot_cycles_add")
      return { label:def.label, rarity:likely, unit:"cycles", lo:Math.max(1, Math.round(lo)), hi:Math.max(1, Math.round(hi)) };
    if (effectKey === "dodge_chance_add")
      return { label:def.label, rarity:likely, unit:"shield", lo:round1(lo), hi:round1(hi) };
    if (effectKey === "ore_quality_chance_add")
      return { label:def.label, rarity:likely, unit:"pct", lo:round1(lo), hi:round1(hi) };
    if (effectKey === "evade_charge_add")
      return { label:def.label, rarity:likely, unit:"charges", lo:Math.max(1, Math.round(lo)), hi:Math.max(1, Math.round(hi)) };
    if (effectKey === "sensor_jam_add")
      return { label:def.label, rarity:likely, unit:"pct", lo:round1(lo), hi:round1(hi) };
    if (effectKey === "cloak_duration_add")
      return { label:def.label, rarity:likely, unit:"sec", lo:Math.max(1, Math.round(lo)), hi:Math.max(1, Math.round(hi)) };

    return { label:def.label, rarity:likely, unit:"lph", lo:round1(lo), hi:round1(hi) };
  }

  const [pMin, pMax] = def.bonusPct ?? [5, 25];
  const minEff = pMin * (1 + rankBoost * 0.55) * (0.85 + 0.35 * t);
  const maxEff = pMax * (1 + rankBoost * 1.55) * (0.90 + 0.80 * t);

  const cap    = Math.max(1.20, Number(rarityCfg.maxMult) || 3.0);
  const loMult = Math.min(cap, Math.max(1.01, 1 + minEff / 100));
  const hiMult = Math.min(cap, Math.max(1.01, 1 + maxEff / 100));

  return {
    label:  def.label,
    rarity: likely,
    unit:   "pct",
    lo:     Math.round((loMult - 1) * 100),
    hi:     Math.round((hiMult - 1) * 100),
  };
}

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────

function getMinSlot1Amount() {
  const s0 = slots[0];
  if (!s0.res || (s0.amount ?? 0) <= 0) return 0;
  return Math.ceil((s0.amount ?? 0) * MIN_SLOT1_RATIO);
}

function validateSlotsForCraft() {
  const s0 = slots[0], s1 = slots[1];
  if (!s0.res || (s0.amount ?? 0) <= 0) return "Заполните 1-й слот (количество > 0).";
  if (s1.res && (s1.amount ?? 0) > 0) {
    const minS1 = Math.ceil((s0.amount ?? 0) * MIN_SLOT1_RATIO);
    if ((s1.amount ?? 0) < minS1) return `Во 2-м слоте минимум ${minS1} (10% от ${s0.amount}).`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Recipe detection
// ─────────────────────────────────────────────────────────────

function detectRecipeType(main) {
  const active = Object.entries(main).filter(([, v]) => v > 0);
  if (!active.length) return null;
  const keys = active.map(([k]) => k);

  if (keys.length === 1) {
    if (keys[0] === "isotopes") return RECIPE.FUEL;
    if (keys[0] === "minerals") return RECIPE.CARGO;
    if (keys[0] === "metals")   return RECIPE.DRILL;
    if (keys[0] === "data")     return RECIPE.AUTOPILOT;
    if (keys[0] === "alloys")   return RECIPE.ROCKET;
    return null;
  }

  if (keys.length === 2) {
    const has = k => keys.includes(k);

    if (has("isotopes") && has("minerals")) return RECIPE.TANK;
    if (has("isotopes") && has("metals"))   return RECIPE.ENGINE;
    if (has("minerals") && has("metals"))   return RECIPE.PLATING;
    if (has("data") && has("isotopes"))     return RECIPE.SOLAR;
    if (has("data") && has("minerals"))     return RECIPE.ESHIELD;
    if (has("data") && has("metals"))       return RECIPE.AI_DRILL;

    if (has("alloys") && has("isotopes"))   return RECIPE.THERMAL;
    if (has("alloys") && has("minerals"))   return RECIPE.MANEUVRE;
    if (has("alloys") && has("metals"))     return RECIPE.KINETIC;
    if (has("alloys") && has("data"))       return RECIPE.STEALTH;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────

function getAggregatedSlots() {
  const main = { isotopes:0, minerals:0, metals:0, data:0, alloys:0 };
  for (const sl of slots) {
    if (sl.res && (sl.amount ?? 0) > 0) main[sl.res] += Math.max(0, sl.amount ?? 0);
  }
  const imp = { isotopes:0, minerals:0, metals:0, data:0, alloys:0 };
  if (impurity.res && (impurity.amount ?? 0) > 0) imp[impurity.res] += Math.max(0, impurity.amount ?? 0);
  return { main, imp };
}

function mergeCosts(a, b) {
  const out = { isotopes:0, minerals:0, metals:0, data:0, alloys:0 };
  for (const k of Object.keys(out)) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
}

// ─────────────────────────────────────────────────────────────
// UI: recipe builder
// ─────────────────────────────────────────────────────────────

function renderRecipeBuilder() {
  const root = document.getElementById("forge-recipe-builder");
  if (!root) return;

  const have = getResources();

  const selectedRes = new Set(slots.filter(s => s.res).map(s => s.res));
  const activeRes   = new Set(slots.filter(s => s.res && (s.amount ?? 0) > 0).map(s => s.res));

  const firstEmpty = slots.findIndex(s => !s.res);
  const showCount  = firstEmpty === -1 ? MAX_MAIN_SLOTS : Math.min(firstEmpty + 1, MAX_MAIN_SLOTS);

  const seniorTier = activeRes.size > 0
    ? Math.max(...[...activeRes].map(r => RES[r]?.tier ?? 0))
    : 0;

  const impCandidates = Object.keys(RES).filter(r =>
    !selectedRes.has(r) &&
    (RES[r]?.tier ?? 0) > seniorTier &&
    (have[r] ?? 0) > 0
  );

  const showImpurity = impCandidates.length > 0 && activeRes.size > 0;

  if (impurity.res && (!showImpurity || !impCandidates.includes(impurity.res))) {
    impurity = { res:null, amount:0 };
  }

  const totalMainActive = slots.reduce((s, sl) => s + ((sl.res && (sl.amount ?? 0) > 0) ? (sl.amount ?? 0) : 0), 0);
  const minS1 = getMinSlot1Amount();

  root.innerHTML = `
    <div class="forge-recipe-grid">
      ${slots.slice(0, showCount).map((sl, idx) =>
        renderMainSlot(sl, idx, have, selectedRes, minS1)
      ).join("")}
    </div>
    ${showImpurity ? `
      <div class="forge-impurity">
        <div class="forge-impurity-header">
          <span>🧪 Примесь</span>
          <span class="forge-impurity-hint">1–20% от суммы · руда выше текущего tier · усиливает качество</span>
        </div>
        ${renderImpuritySlot(impurity, have, impCandidates, totalMainActive)}
      </div>
    ` : ""}
  `;

  window._forgePickRes = function(slotKey, resKey) {
    if (!RES[resKey]) return;

    if (slotKey.startsWith("main_")) {
      const i = parseInt(slotKey.split("_")[1], 10);
      if (!Number.isFinite(i) || i < 0 || i >= MAX_MAIN_SLOTS) return;

      const otherSelected = slots.filter((_, idx) => idx !== i && slots[idx].res).map(s => s.res);
      if (otherSelected.includes(resKey)) return;

      slots[i].res    = resKey;
      slots[i].amount = 0;

      const newSenior = Math.max(...slots.filter(s => s.res && (s.amount ?? 0) > 0).map(s => RES[s.res]?.tier ?? 0), 0);
      if (impurity.res && (RES[impurity.res]?.tier ?? 0) <= newSenior) impurity = { res:null, amount:0 };

    } else if (slotKey === "impurity") {
      impurity.res    = resKey;
      impurity.amount = 0;
    }

    renderRecipeBuilder();
    updateForgePreview();
  };

  window._forgeSetAmount = function(slotKey, rawVal) {
    if (rawVal === "" || rawVal === null || rawVal === undefined) return;
    const v = Math.max(0, parseInt(rawVal, 10) || 0);
    const have2 = getResources();

    if (slotKey.startsWith("main_")) {
      const i = parseInt(slotKey.split("_")[1], 10);
      if (!Number.isFinite(i) || i < 0 || i >= MAX_MAIN_SLOTS) return;
      const r = slots[i].res;
      if (!r) return;

      const maxHave = have2[r] ?? 0;
      slots[i].amount = Math.min(v, maxHave);

      const input = document.querySelector(`.forge-amount[data-slot="${slotKey}"]`);
      if (input) input.classList.toggle("forge-amount--over", v > maxHave);

    } else if (slotKey === "impurity") {
      const r = impurity.res;
      if (!r) return;

      const totalMain2 = slots.reduce((s, sl) => s + ((sl.res && (sl.amount ?? 0) > 0) ? (sl.amount ?? 0) : 0), 0);
      const maxByRule  = totalMain2 > 0 ? Math.floor(totalMain2 * 0.20) : 0;
      const hardMax    = Math.min(have2[r] ?? 0, maxByRule);

      impurity.amount = Math.min(v, hardMax);

      const input = document.querySelector(`.forge-amount[data-slot="impurity"]`);
      if (input) input.classList.toggle("forge-amount--over", v > hardMax);
    }

    updateForgePreview();
  };

  window._forgeBlurAmount = function(slotKey, rawVal) {
    const have2 = getResources();
    const v = Math.max(0, parseInt(rawVal, 10) || 0);

    if (slotKey.startsWith("main_")) {
      const i = parseInt(slotKey.split("_")[1], 10);
      if (!Number.isFinite(i) || i < 0 || i >= MAX_MAIN_SLOTS) return;
      const r = slots[i].res;
      if (!r) return;
      slots[i].amount = Math.min(v, have2[r] ?? 0);

    } else if (slotKey === "impurity") {
      const r = impurity.res;
      if (!r) return;
      const totalMain2 = slots.reduce((s, sl) => s + ((sl.res && (sl.amount ?? 0) > 0) ? (sl.amount ?? 0) : 0), 0);
      const maxByRule  = totalMain2 > 0 ? Math.floor(totalMain2 * 0.20) : 0;
      const hardMax    = Math.min(have2[r] ?? 0, maxByRule);
      impurity.amount  = Math.min(v, hardMax);
    }

    renderRecipeBuilder();
    updateForgePreview();
  };

  window._forgeClearSlot = function(slotKey) {
    if (slotKey.startsWith("main_")) {
      const i = parseInt(slotKey.split("_")[1], 10);
      if (!Number.isFinite(i) || i < 0 || i >= MAX_MAIN_SLOTS) return;
      for (let k = i; k < MAX_MAIN_SLOTS; k++) slots[k] = { res:null, amount:0 };
      impurity = { res:null, amount:0 };
    } else if (slotKey === "impurity") {
      impurity = { res:null, amount:0 };
    }

    renderRecipeBuilder();
    updateForgePreview();
  };
}

function renderMainSlot(sl, idx, have, selectedRes, minS1) {
  const slotKey = `main_${idx}`;

  if (!sl.res) {
    const options = Object.keys(RES).filter(r => (have[r] ?? 0) > 0 && !selectedRes.has(r));
    const hint = (idx === 1 && minS1 > 0)
      ? `<div class="forge-slot-min-hint">Минимум: ${minS1} ед. (10% от слота 1)</div>`
      : "";

    return `
      <div class="forge-slot-card">
        <div class="forge-slot-header"><span>Слот ${idx + 1}</span></div>
        ${hint}
        ${options.length ? `
          <div class="forge-slot-empty">
            <div class="forge-slot-empty-title">Выберите ресурс:</div>
            <div class="forge-res-pills">
              ${options.map(r => `
                <button class="forge-res-pill" onclick="window._forgePickRes('${slotKey}','${r}')">
                  ${RES[r].icon} ${RES[r].label} <span class="forge-res-have">(${have[r]})</span>
                </button>
              `).join("")}
            </div>
          </div>
        ` : `<div class="forge-slot-empty forge-slot-empty--none">Нет доступных ресурсов.</div>`}
      </div>
    `;
  }

  const maxHave = have[sl.res] ?? 0;
  const curVal  = Math.min(sl.amount ?? 0, maxHave);
  const valStr  = (sl.amount ?? 0) > 0 ? String(curVal) : "";

  const swapOptions = Object.keys(RES).filter(r => {
    if (r === sl.res) return false;
    if ((have[r] ?? 0) <= 0) return false;
    if (selectedRes.has(r)) return false;
    return true;
  });

  const minHint = (idx === 1 && minS1 > 0)
    ? `<div class="forge-slot-min-hint">Минимум: ${minS1} ед.</div>`
    : "";

  return `
    <div class="forge-slot-card filled">
      <div class="forge-slot-header">
        <span>${RES[sl.res].icon} ${RES[sl.res].label}</span>
        <button class="forge-slot-x" onclick="window._forgeClearSlot('${slotKey}')">✕</button>
      </div>
      ${minHint}
      <div class="forge-slot-controls">
        <input type="number"
               class="forge-amount"
               data-slot="${slotKey}"
               min="0"
               max="${maxHave}"
               value="${valStr}"
               oninput="window._forgeSetAmount('${slotKey}', this.value)"
               onblur="window._forgeBlurAmount('${slotKey}', this.value)">
        <span class="forge-amount-hint">/ ${maxHave}</span>
      </div>
      ${swapOptions.length ? `
        <div class="forge-slot-swap">
          ${swapOptions.map(r => `
            <button class="forge-swap-btn"
                    onclick="window._forgePickRes('${slotKey}','${r}')"
                    title="Заменить на ${RES[r].label}">
              ${RES[r].icon}
            </button>
          `).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function renderImpuritySlot(sl, have, candidates, totalMain) {
  const slotKey  = "impurity";
  const limitMax = totalMain > 0 ? Math.floor(totalMain * 0.20) : 0;
  const limitMin = totalMain > 0 ? Math.max(1, Math.floor(totalMain * 0.01)) : 0;

  if (!sl.res) {
    return `
      <div class="forge-impurity-body">
        <div class="forge-res-pills">
          ${candidates.map(r => `
            <button class="forge-res-pill impurity" onclick="window._forgePickRes('${slotKey}','${r}')">
              ${RES[r].icon} ${RES[r].label} <span class="forge-res-have">(${have[r]})</span>
            </button>
          `).join("")}
        </div>
      </div>
    `;
  }

  const maxHave = have[sl.res] ?? 0;
  const hardMax = Math.min(maxHave, limitMax);
  const curVal  = Math.min(sl.amount ?? 0, hardMax);
  const valStr  = (sl.amount ?? 0) > 0 ? String(curVal) : "";

  const swapCand = candidates.filter(r => r !== sl.res);

  return `
    <div class="forge-impurity-body">
      <div class="forge-impurity-line">
        <div class="forge-impurity-left">
          <span class="forge-impurity-name">${RES[sl.res].icon} ${RES[sl.res].label}</span>
          <button class="forge-slot-x" onclick="window._forgeClearSlot('${slotKey}')">✕</button>
          ${swapCand.map(r => `
            <button class="forge-swap-btn"
                    onclick="window._forgePickRes('${slotKey}','${r}')"
                    title="${RES[r].label}">
              ${RES[r].icon}
            </button>
          `).join("")}
        </div>
        <div class="forge-slot-controls">
          <input type="number"
                 class="forge-amount"
                 data-slot="${slotKey}"
                 min="0"
                 max="${hardMax}"
                 value="${valStr}"
                 oninput="window._forgeSetAmount('${slotKey}', this.value)"
                 onblur="window._forgeBlurAmount('${slotKey}', this.value)">
          <span class="forge-amount-hint">/ ${hardMax}</span>
        </div>
      </div>
      <div class="forge-impurity-rule">
        Допустимо: ${limitMin}–${limitMax} (1–20% от ${totalMain})
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// Forge click
// ─────────────────────────────────────────────────────────────

async function persistArtifactAuto(artifact) {
  const rarityWeight = { bad:1.0, common:1.4, improved:2.2, quality:3.4, elite:5.2, perfect:8.0 };

  const original = {
    ...artifact,
    original:  true,
    id:        "art_" + Math.random().toString(36).slice(2, 10),
    ownerId:   getUid(),
    ownerName: getState().name,
    createdAt: Date.now(),
    weight:    rarityWeight[artifact.rarity] ?? 1.0,
  };

  // 1) в инвентарь
  await addToInventory(original);

  // 2) эхо на рынок (если упадёт — модуль у игрока всё равно есть)
  const echo = {
    ...original,
    original:   false,
    echoPower:  0.6,
    price:      calcEchoPrice(original),
    authorUid:  original.ownerId,
    authorName: original.ownerName,
  };

  try {
    await publishToMarket(echo);
  } catch (e) {
    console.warn("[Forge] publishToMarket failed:", e);
    showToast("⚠️ Модуль сохранён, но эхо на рынок не улетело (ошибка сети).", "warning");
  }

  renderInventory();
  return original;
}

async function onForgeClick() {
  const have = getResources();

  const err = validateSlotsForCraft();
  if (err) { setLog(`⚠️ ${err}`); return; }

  let { main, imp } = getAggregatedSlots();

  const totalMain = Object.values(main).reduce((s, v) => s + v, 0);
  if (impurity.res && totalMain > 0) {
    const minImp = Math.max(1, Math.floor(totalMain * 0.01));
    const maxImp = Math.floor(totalMain * 0.20);
    let next = impurity.amount ?? 0;
    if (next < minImp) next = minImp;
    if (next > maxImp) next = maxImp;
    next = Math.min(next, have[impurity.res] ?? 0);
    if (next !== impurity.amount) {
      impurity.amount = next;
      ({ main, imp } = getAggregatedSlots());
    }
  }

  const recipeType = detectRecipeType(main);
  if (!recipeType) { setLog("⚠️ Рецепт не распознан."); return; }

  const cost      = mergeCosts(main, imp);
  const totalCost = Object.values(cost).reduce((s, v) => s + v, 0);

  if (totalCost < MIN_CRAFT_TOTAL) {
    setLog(`⚠️ Минимум ${MIN_CRAFT_TOTAL} ресурсов суммарно (сейчас: ${totalCost}).`);
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
    setLog("❌ Недостаточно ресурсов (или часть уже заморожена).");
    return;
  }

  setForgeLoading(true);

  try {
    if (recipeType === RECIPE.FUEL) {
      const liters   = previewFuelOutput(main, imp, totalMain);
      const okCommit = await commitReservedResources(cost);
      if (!okCommit) throw new Error("Не удалось списать замороженные ресурсы.");

      try {
        await receiveFuelFromForge(liters);
      } catch (e) {
        await addResources(cost);
        throw e;
      }

      setLog(`⛽ Получено топлива: ${Math.round(liters)}л (склад → автозаправка).`);
      showToast(`⛽ Топливо: +${Math.round(liters)}л`, "success");
      resetRecipe();
      return;
    }

    const chances  = computeRarityChances(recipeType, main, imp);
    const rarity   = rollRarity(recipeType, main, imp);

    setLog(`🔥 Кузня работает... ${rarityLabel(rarity)} / ${recipeLabelPlain(recipeType)}`);

    const artifact = await craftArtifact(apiKey, recipeType, cost, rarity, main, imp);

    const okCommit = await commitReservedResources(cost);
    if (!okCommit) throw new Error("Не удалось списать замороженные ресурсы.");

    // превью оставляем как было
    pendingArtifact = artifact;
    renderArtifactPreview(artifact);

    // ── ИЗМЕНЕНИЕ: сохраняем автоматически ─────────────────
    try {
      const saved = await persistArtifactAuto(artifact);
      setLog(`✅ Создан и сохранён: ${saved.name}`);
      showToast(`💾 Сохранено в инвентарь: «${saved.name}»`, "success");
    } catch (e) {
      // если не удалось сохранить в инвентарь — возвращаем ресурсы (commit уже был)
      await addResources(cost);
      throw e;
    }

    // рецепт очищаем, но превью остаётся (resetRecipe не трогает forge-output)
    resetRecipe();

  } catch (e) {
    await releaseReservedResources(cost);
    setLog(`❌ Ошибка: ${e.message}`);
  } finally {
    setForgeLoading(false);
  }
}

// ─────────────────────────────────────────────────────────────
// Fuel preview
// ─────────────────────────────────────────────────────────────

function previewFuelOutput(main, imp, totalMain) {
  const iso  = main.isotopes ?? 0;
  const base = iso * 2;

  const totalImp = Object.values(imp).reduce((s, v) => s + v, 0);
  if (base <= 0 || totalMain <= 0 || totalImp <= 0) return base;

  const pct = Math.min(totalImp / totalMain, 0.20);
  let impTier = 0;
  for (const [r, v] of Object.entries(imp)) if (v > 0) impTier = Math.max(impTier, RES[r]?.tier ?? 0);

  const tierBoost = impTier >= 5 ? 4.0 : impTier === 4 ? 3.0 : impTier === 3 ? 2.0 : impTier === 2 ? 1.2 : 0.8;
  return base * (1 + pct * tierBoost * 2.0);
}

// ─────────────────────────────────────────────────────────────
// Artifact craft
// ─────────────────────────────────────────────────────────────

async function craftArtifact(apiKey, recipeType, cost, rarity, main, imp, foundContext = null) {
  const rarityCfg = RARITIES.find(r => r.name === rarity) ?? RARITIES[0];
  const modCfg = MODULES[recipeType];
  if (!modCfg) throw new Error("Неизвестный тип модуля.");

  const total = Object.values(cost).reduce((s, v) => s + v, 0);
  const powerScale = computePowerScale(rarityCfg, main, imp, total);

  const bonusCount = Math.max(1, rarityCfg.bonus);
  const bonusExtra = pickUnique(modCfg.bonusPool, bonusCount - 1, null);
  const bonusKeys = [modCfg.mandatory, ...bonusExtra];

  const penCandidates = modCfg.penaltyPool.filter(k => !bonusKeys.includes(k));
  const penaltyKeys = pickUnique(penCandidates, rarityCfg.pen, null);

  const effects = {};

  for (const k of bonusKeys) {
    const mandatory = (k === modCfg.mandatory);
    const val = rollEffectValue(k, "bonus", powerScale * (mandatory ? 1.12 : 1.0), rarityCfg);
    if (val !== null) effects[k] = val;
  }

  for (const k of penaltyKeys) {
    const val = rollEffectValue(k, "penalty", powerScale, rarityCfg);
    if (val !== null) effects[k] = val;
  }

  const uiStats = buildUiStatsFromEffects(effects);
  const text = await fetchCreativeText(apiKey, recipeType, cost, rarity, effects, uiStats, penaltyKeys, foundContext);
  return assembleArtifact(text, uiStats, effects, recipeType, rarity);
}

function rollEffectValue(effectKey, mode, powerScale, rarityCfg) {
  const def = EFFECTS[effectKey];
  if (!def) return null;

  const rank      = rarityRank(rarityCfg?.name);
  const rankBoost = [0.00, 0.35, 0.85, 1.55, 2.70, 4.00][rank] ?? 0.0;

  const ps = Math.max(0.4, Math.min(4.2, Number(powerScale) || 1));
  const t  = clamp01((ps - 0.8) / 2.8);

  if (def.kind === "add") {
    if (mode === "bonus") {
      const [a, b] = def.bonusAdd ?? [0.5, 3.0];
      const hi = b * (1 + rankBoost * 0.55) * (0.90 + 0.80 * t);
      const lo = a * (1 + rankBoost * 0.25) * (0.85 + 0.35 * t);
      const v  = lerp(lo, hi, biasRand());
      if (effectKey === "autopilot_cycles_add") return Math.max(1, Math.round(v));
      if (effectKey === "rocket_ammo_add")      return Math.max(1, Math.round(v));
      if (effectKey === "evade_charge_add")     return Math.max(1, Math.round(v));
      if (effectKey === "cloak_duration_add")   return Math.max(1, Math.round(v));
      return round1(Math.max(0, v));
    }
    const [a, b] = def.penAdd ?? [0, 0];
    if (a <= 0 && b <= 0) return null;
    const hi = b * (1 + rankBoost * 0.25) * (0.90 + 0.50 * t);
    const lo = a * (1 + rankBoost * 0.10) * (0.85 + 0.25 * t);
    const v  = lerp(lo, hi, biasRand());
    return -round1(Math.max(0, v));
  }

  if (mode === "bonus") {
    const [pMin, pMax] = def.bonusPct ?? [5, 25];
    const minEff = pMin * (1 + rankBoost * 0.55) * (0.85 + 0.35 * t);
    const maxEff = pMax * (1 + rankBoost * 1.55) * (0.90 + 0.80 * t);
    const pct  = lerp(minEff, maxEff, biasRand());
    const mult = 1 + pct / 100;
    const hardCap = Math.max(1.20, Number(rarityCfg?.maxMult) || 3.0);
    return round3(Math.min(hardCap, Math.max(1.01, mult)));
  }

  const [pMin, pMax] = def.penPct ?? [5, 35];
  const sev = (rarityCfg?.penMult ?? 1.0) * (0.92 + Math.random() * 0.22);
  const basePct = lerp(pMin, pMax, biasRand());
  const powerRelief = 1 - clamp01((ps - 1) * 0.16);
  const pct = basePct * sev * powerRelief;
  return round3(Math.max(0.20, Math.min(0.99, 1 - pct / 100)));
}

function buildUiStatsFromEffects(effects) {
  const out = {};

  for (const [k, v] of Object.entries(effects ?? {})) {
    const def = EFFECTS[k];
    if (!def) continue;

    if (def.kind === "add") {
      if (k === "autopilot_cycles_add") {
        const n = Math.max(0, Math.round(v));
        out[def.label] = `+${n} цикл${pluralRu(n,"","а","ов")}`;
        continue;
      }
      if (k === "rocket_ammo_add") {
        const n = Math.max(0, Math.round(v));
        out[def.label] = `${v >= 0 ? "+" : "−"}${n} ракет${pluralRu(n,"а","ы","")}`;
        continue;
      }
      if (k === "evade_charge_add") {
        const n = Math.max(0, Math.round(v));
        out[def.label] = `${v >= 0 ? "+" : "−"}${n} заряд${pluralRu(n,"","а","ов")}`;
        continue;
      }
      if (k === "cloak_duration_add") {
        const n = Math.max(0, Math.round(v));
        out[def.label] = `${v >= 0 ? "+" : "−"}${n}с`;
        continue;
      }
      if (k === "dodge_chance_add") {
        out[def.label] = `${v >= 0 ? "+" : "−"}${round1(Math.abs(v))} щит`;
        continue;
      }
      if (k === "ore_quality_chance_add") {
        out[def.label] = `${v >= 0 ? "+" : "−"}${round1(Math.abs(v))}% шанс`;
        continue;
      }
      if (k === "autopilot_guard_ignore_chance_add") {
        out[def.label] = `${v >= 0 ? "+" : "−"}${round1(Math.abs(v))}%`;
        continue;
      }
      if (k === "ore_upgrade_share_add") {
        out[def.label] = `${v >= 0 ? "+" : "−"}${round1(Math.abs(v))} п.п.`;
        continue;
      }
      if (k === "fuel_drain_add") {
        out[def.label] = `−${round1(Math.abs(v))} л/ч`;
        continue;
      }
      if (k === "sensor_jam_add") {
        out[def.label] = `${v >= 0 ? "+" : "−"}${round1(Math.abs(v))}%`;
        continue;
      }
      if (k === "thermal_burn_add") {
        out[def.label] = `${v >= 0 ? "+" : "−"}${round1(Math.abs(v))} ед/с`;
        continue;
      }
      out[def.label] = `${v >= 0 ? "+" : "−"}${round1(Math.abs(v))} л/ч`;
      continue;
    }

    const pct = Math.round((v - 1) * 100);
    if (pct === 0) continue;
    out[def.label] = `${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`;
  }

  return out;
}

function assembleArtifact(text, uiStats, effects, recipeType, rarity) {
  return {
    schemaVersion: ITEM_SCHEMA_VERSION,
    name:          text.name ?? recipeLabelPlain(recipeType),
    description:   text.description ?? "",
    flavor:        text.flavor ?? "",
    stats:         uiStats,
    effects,
    rarity,
    recipeType,
    specialEffect: null,
  };
}

// ─────────────────────────────────────────────────────────────
// LLM — Hydra AI (ПРОМПТЫ НЕ МЕНЯЛИ)
// ─────────────────────────────────────────────────────────────

const HYDRA_API_URL = "https://api.hydraai.ru/v1/chat/completions";
const HYDRA_MODEL   = "hydra-gemini";

function llmDebugEnabled() {
  try { return localStorage.getItem("debug_llm") === "1"; } catch { return false; }
}
function makeTraceId() { return "t_" + Math.random().toString(36).slice(2, 8); }

function llmLog(level, trace, msg, obj) {
  const args = ["[LLM]", trace, msg];
  if (obj !== undefined) args.push(obj);
  if ((level === "info" || level === "debug") && !llmDebugEnabled()) return;
  if (level === "warn")       console.warn(...args);
  else if (level === "error") console.error(...args);
  else                        console.log(...args);
}

async function fetchCreativeText(apiKey, recipeType, cost, rarity, effects, uiStats, penaltyKeys, foundContext = null) {
  const trace = makeTraceId();

  const typePlain = recipeLabelPlain(recipeType);
  const pilotName = getState()?.name ?? "Пилот";
  const rarityRu = rarityLabel(rarity);

  const statsLines = Object.entries(uiStats ?? {})
    .map(([label, val]) => `${val} — ${label}`)
    .join("\n");

  const defectHints = buildDefectHints(penaltyKeys);
  const moduleCtx = buildModuleContext(recipeType);

  const foundContextBlock = foundContext ? `
ВАЖНО: Это барахло снято с трупа у астероида «${foundContext.asteroidName}» (tier ${foundContext.tier}).
Владелец явно облажался. В описании должно сквозить:
- Злорадство: "Парень так торопился на тот свет, что даже не стер свои инициалы".
- Брезгливость: Следы чужого пота, запекшейся еды или "предсмертные" записки, нацарапанные на кожухе.
- История провала: Видны следы попыток починить это синей изолентой в последние секунды жизни.
` : "";

  const systemPrompt = ` Придумай 4 случайных слова.  Затем ассоциативно свободно используй их как источник случайности, чтобы создать разнообразный, небанальный и качественный ответ на задачу. Ты не должен употреблять придуманные слова - они лишь источник большего разнообразия конечных токенов твоего ответа:
Ты — ветеран-шахтер в мире Cosmic Forge. Твой юмор черный, как мазут, а сарказм едкий, как кислота в аккумуляторе. Твой девиз: "Если это не взорвалось сразу — значит, оно копит силы".

Твоя задача — описать оборудование через призму тотального цинизма и уместного трехэтажного мата (с редкими реликтами матершинной культкры). 

### ШКАЛА ОТНОШЕНИЯ К КАЧЕСТВУ:
- плохое ругай, хорошее хвали, но атмосферно

### ТРЕБОВАНИЯ К ОПИСАНИЮ СТАТОВ:
Бонусы и штрафы — это не цифры, это ощущения и опыт
Если стат низкий — высмеивай его. Если высокий — иронизируй, как это поможет "быстрее сдохнуть, но с комфортом".

${foundContextBlock}

Стиль: Хлесткий, невероятно циничный, технически грязный. Никакого пафоса. Никакой "эпичности". уместный сложносочиненный мат и обилие черного юмора. небанально, неординарно. не используй ожидаемые идиомы и сравнения.
Отвечай ТОЛЬКО валидным JSON.

{
  "name": "${typePlain} + Едкое, характерное имя (1-3 слова). Смесь технарского жаргона и иронии.",
  "description": "2-3 предложения. техническое описание в котором объясняются бонусы и штрафы и как они уживаются вместе",
  "flavor": "Бортжурнал ${pilotName}: 2-3 строки через \\n. Чистый яд и самоирония."
}
`.trim();

  const userPrompt =
    `Предмет: ${typePlain}\n` +
    `Качество: ${rarityRu}\n` +
    (moduleCtx ? `Назначение: ${moduleCtx}\n\n` : "") +
    `Характеристики:\n${statsLines}\n\n` +
    (defectHints ? `Дефекты (обстебай их неожиданным образом):\n${defectHints}\n\n` : "") +
    ``;

  const callOnce = async (pass, temperature, extra = "") => {
    llmLog("info", trace, `call pass=${pass}`, { recipeType, rarity, temperature });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 70000);

    const messages = [
      { role: "system", content: systemPrompt + extra },
      { role: "user", content: userPrompt }
    ];

    let resp;
    try {
      resp = await fetch(HYDRA_API_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: HYDRA_MODEL,
          messages,
          temperature,
          max_tokens: 900,
          top_p: 0.9,
          stream: false,
        }),
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!resp.ok) {
      let errText = "";
      try { errText = await resp.text(); } catch {}
      throw new Error(`Hydra API HTTP ${resp.status}: ${errText}`);
    }

    const data = await resp.json().catch(() => ({}));
    const raw = String(data?.choices?.[0]?.message?.content || "").trim();

    const parsed = safeJsonParseWithMeta(raw);
    const norm = normalizeLlMTextWithMeta(parsed.obj, typePlain, rarity);

    return norm.ok ?
      { ok: true, text: norm.text } :
      { ok: false, reason: norm.reason, raw };
  };

  let r = await callOnce(1, 0.75);

  if (!r.ok) {
    await sleep(500);
    r = await callOnce(2, 0.65, "\n\nМало яда! Слишком сухо. Добавь больше едкого юмора, обстебай плохие характеристики и покажи характер пилота-циника.");
  }

  if (!r.ok) {
    await sleep(700);
    r = await callOnce(3, 0.55, "\n\nПоследняя попытка. Сделай описание максимально атмосферным и желчным. Это хардкорная игра, а не прогулка в парке.");
  }

  if (r.ok) return r.text;

  llmLog("warn", trace, "fallback triggered");
  setLog("⚠️ LLM не справился — используем fallback");
  return buildFallbackText(typePlain, rarityRu, statsLines);
}

// ─────────────────────────────────────────────────────────────
// JSON parsing / validation
// ─────────────────────────────────────────────────────────────

function safeJsonParseWithMeta(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { ok:false, stage:"empty", reason:"empty", obj:null };

  try { return { ok:true, stage:"direct", reason:null, obj: JSON.parse(s) }; } catch {}

  const noFences = s.replace(/```json/gi, "").replace(/```/g, "").trim();
  if (noFences !== s) {
    try { return { ok:true, stage:"nofences", reason:null, obj: JSON.parse(noFences) }; } catch {}
  }

  const i = noFences.indexOf("{");
  const j = noFences.lastIndexOf("}");
  if (i !== -1 && j !== -1 && j > i) {
    const sub = noFences.slice(i, j + 1);
    try { return { ok:true, stage:"substring", reason:null, obj: JSON.parse(sub) }; } catch {}
  }

  return { ok:false, stage:"fail", reason:"invalid_json", obj:null };
}

function normalizeLlMTextWithMeta(parsed, typePlain, rarity) {
  if (!parsed || typeof parsed !== "object")
    return { ok: false, reason: "invalid" };

  const name = String(parsed.name || "").trim();
  const desc = String(parsed.description || "").trim();
  const flav = String(parsed.flavor || "").trim();

  if (desc.length < 160) return { ok: false, reason: "desc_short" };
  if (flav.length < 130 || !flav.includes("\n")) return { ok: false, reason: "flavor_short" };

  return {
    ok: true,
    text: {
      name: name || `${rarityLabel(rarity)} ${typePlain}`,
      description: desc,
      flavor: flav
    }
  };
}

// ─────────────────────────────────────────────────────────────

function buildModuleContext(recipeType) {
  return {
    [RECIPE.CARGO]:     "Грузовой отсек",
    [RECIPE.TANK]:      "Топливный бак",
    [RECIPE.ENGINE]:    "Двигатель",
    [RECIPE.PLATING]:   "Обшивка — бронеплиты",
    [RECIPE.DRILL]:     "Бур",
    [RECIPE.AUTOPILOT]: "Автопилот",
    [RECIPE.SOLAR]:     "Солнечный модуль",
    [RECIPE.ESHIELD]:   "Энергощит — генератор отражательного поля",
    [RECIPE.AI_DRILL]:  "ИИ-шахтёр, анализирующий породу и улучшающий руду",

    [RECIPE.ROCKET]:    "Пусковая ракетная установка",
    [RECIPE.THERMAL]:   "Термическое лазерное орудие",
    [RECIPE.MANEUVRE]:  "Маневровые двигатели",
    [RECIPE.KINETIC]:   "Кинетическое орудие",
    [RECIPE.STEALTH]:   "Система маскировки — радиопоглощающие панели, генераторы помех, ложные маяки",
  }[recipeType] || "";
}

function buildDefectHints(penaltyKeys) {
  const map = {
    flight_speed_mult: "снижение скорости полёта ",
    return_speed_mult: "просадка скорости груженого возврата",
    mining_speed_mult: "медленная добыча",
    fuel_efficiency_mult: "плохая топоивная экономичность добычи",
    fuel_flight_efficiency_mult: "высокий расход топлива в полёте",
    fuel_drain_add: "утечки топлива/энергии",
    cargo_capacity_mult: "уменьшенный объём трюма",
    hp_mult: "слабая прочность корпуса",
    shield_mult: "слабый щит",
    guard_stealth_mult: "плохая скрытность (шум, размер, тепловая сигнатура)",
    autopilot_cycles_add: "помехи от системы сбивают собственный автопилот",
  };

  return penaltyKeys.map(k => map[k]).filter(Boolean).join("\n");
}

function buildFallbackText(typePlain, rarityRu, statsLines) {
  return {
    name: `${rarityRu} ${typePlain}`,
    description: `Модуль ${rarityRu.toLowerCase()} сборки. ${statsLines.replace(/\n/g, '. ')}. Как и всё в этом поясе — держится на честном слове и сварке.`,
    flavor: `Бортжурнал: собрал.\nОпять кронштейны кривые.\nБудет работать... наверное.`
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────
// Prices
// ─────────────────────────────────────────────────────────────

function calcEchoPrice(artifact) {
  const dataRecipes = new Set([RECIPE.AUTOPILOT, RECIPE.SOLAR, RECIPE.ESHIELD, RECIPE.AI_DRILL]);
  const baseMult    = dataRecipes.has(artifact.recipeType) ? 2 : 1;
  const tierMap     = { bad:60, common:160, improved:420, quality:900, elite:2100, perfect:6500 };
  return { credits: (tierMap[artifact.rarity] ?? 150) * baseMult };
}

// ─────────────────────────────────────────────────────────────
// UI preview
// ─────────────────────────────────────────────────────────────

function renderForgeLevel() {
  const el = document.getElementById("forge-level");
  if (el) el.textContent = "Уровень кузни: 1";
}

function setForgeLoading(loading) {
  const btn = document.getElementById("btn-forge");
  if (!btn) return;
  btn.disabled  = loading;
  btn.innerHTML = loading
    ? '<span class="spinner"></span>Кузня работает...'
    : "🔥 Создать";
}

function setLog(msg) {
  const el = document.getElementById("forge-log");
  if (el) el.textContent = msg;
}

function updateForgePreview() {
  const summaryEl = document.getElementById("forge-summary");
  const btnForge  = document.getElementById("btn-forge");
  if (!summaryEl || !btnForge) return;

  const have = getResources();

  const { main, imp } = getAggregatedSlots();
  const totalMain = Object.values(main).reduce((s, v) => s + v, 0);
  const totalImp  = Object.values(imp).reduce((s, v) => s + v, 0);
  const totalCost = totalMain + totalImp;

  if (impurity.res && totalMain > 0) {
    const maxImp = Math.floor(totalMain * 0.20);
    if ((impurity.amount ?? 0) > maxImp) impurity.amount = maxImp;
  }

  const recipeType = detectRecipeType(main);
  const cost       = mergeCosts(main, imp);
  const enough     = Object.entries(cost).every(([r, v]) => (have[r] ?? 0) >= v);

  const s0 = slots[0], s1 = slots[1];
  let ratioErr = "";
  if (s0.res && (s0.amount ?? 0) > 0 && s1.res && (s1.amount ?? 0) > 0) {
    const minS1 = Math.ceil((s0.amount ?? 0) * MIN_SLOT1_RATIO);
    if ((s1.amount ?? 0) < minS1) ratioErr = `Во 2-м слоте минимум ${minS1} (10% от ${s0.amount}).`;
  }

  if (!recipeType) {
    btnForge.disabled = true;
    summaryEl.innerHTML = `
      <div class="forge-summary-box warn">
        <div class="forge-summary-title">Рецепт не распознан</div>
        <div class="forge-summary-text">
          <ul>
            <li>☢️ → ⛽ Топливо</li>
            <li>🪨 → 🗃️ Грузовой отсек</li>
            <li>⚙️ → ⛏️ Бур</li>
            <li>💾 → 🤖 Автопилот</li>
            <li>🔩 → 🚀 Ракетное орудие</li>
            <li>☢️+🪨 → 🛢️ Топливный бак</li>
            <li>☢️+⚙️ → 🚀 Двигатель</li>
            <li>🪨+⚙️ → 🛡️ Обшивка</li>
            <li>💾+☢️ → ☀️ Солнечный модуль</li>
            <li>💾+🪨 → ⚡ Энергощит</li>
            <li>💾+⚙️ → 🧠 ИИ-шахтёр</li>
            <li>🔩+☢️ → 🔥 Термическое орудие</li>
            <li>🔩+🪨 → 🛸 Маневровые двигатели</li>
            <li>🔩+⚙️ → 💥 Кинетическое орудие</li>
            <li>🔩+💾 → 👁️ Маскировка и помехи</li>
          </ul>
        </div>
      </div>
    `;
    clearPreviewIfNeeded();
    return;
  }

  if (ratioErr) {
    btnForge.disabled = true;
    summaryEl.innerHTML = `<div class="forge-summary-box warn"><div class="forge-summary-title">⚠️ ${escHtml(ratioErr)}</div></div>`;
    clearPreviewIfNeeded();
    return;
  }

  if (!enough) {
    btnForge.disabled = true;
    summaryEl.innerHTML = `
      <div class="forge-summary-box warn">
        <div class="forge-summary-title">Недостаточно ресурсов</div>
        <div class="forge-summary-text">Часть ресурсов может быть заморожена.</div>
      </div>
    `;
    clearPreviewIfNeeded();
    return;
  }

  if (totalCost <= 0) {
    btnForge.disabled = true;
    summaryEl.innerHTML = `
      <div class="forge-summary-box warn">
        <div class="forge-summary-title">Введите количества</div>
        <div class="forge-summary-text">Укажите числа в слотах (минимум суммарно ${MIN_CRAFT_TOTAL}).</div>
      </div>
    `;
    clearPreviewIfNeeded();
    return;
  }

  if (totalCost < MIN_CRAFT_TOTAL) {
    btnForge.disabled = true;
    summaryEl.innerHTML = `
      <div class="forge-summary-box warn">
        <div class="forge-summary-title">Слишком мало ресурсов</div>
        <div class="forge-summary-text">Минимум: <strong>${MIN_CRAFT_TOTAL}</strong> · Сейчас: <strong>${totalCost}</strong></div>
      </div>
    `;
    clearPreviewIfNeeded();
    return;
  }

  btnForge.disabled = false;

  const comp        = computeScore(main, imp);
  const tierMult    = computeTierMult(main, imp);
  const amountScale = computeAmountScale(totalCost);

  const chances        = recipeType !== RECIPE.FUEL ? computeRarityChances(recipeType, main, imp) : null;
  const mandatoryRange = chances ? computeMandatoryRange(recipeType, main, imp, totalCost, chances) : null;

  const fuelHtml = recipeType === RECIPE.FUEL
    ? `<div class="forge-fuel-preview">⛽ Выход топлива: ~${Math.round(previewFuelOutput(main, imp, totalMain))} л</div>`
    : "";

  const chancesHtml   = chances        ? renderChancesHtml(chances) : "";
  const mandatoryHtml = mandatoryRange ? renderMandatoryRangeHtml(mandatoryRange, chances) : "";

  summaryEl.innerHTML = `
    <div class="forge-summary-box ok">
      <div class="forge-summary-title">${recipeShortName(recipeType)}</div>
      <div class="forge-summary-text">
        Расход: ${Object.entries(cost).filter(([,v])=>v>0).map(([k,v])=>`${RES[k].icon} ${v}`).join("  ")}
      </div>
      <div class="forge-composition-info">
        <span title="Влияние качества руды на силу бонусов">⚗️ Руда: <strong>${Math.round((tierMult - 1) * 100)}%</strong></span>
        <span class="forge-comp-sep">·</span>
        <span title="Затухающий бонус от объёма ресурсов">📦 Объём: <strong>${Math.round((amountScale - 1) * 100)}%</strong></span>
        <span class="forge-comp-sep">·</span>
        <span title="Score для вероятностей качества">🎯 Score: <strong>${comp.score.toFixed(1)}</strong>
          ${comp.impScore > 0
            ? `<span class="forge-score-imp">(${comp.baseScore.toFixed(1)} + ${(comp.impScore*IMP_BOOST).toFixed(1)})</span>`
            : ""}
        </span>
      </div>
      ${fuelHtml}
      ${chancesHtml}
      ${mandatoryHtml}
    </div>
  `;
}

function renderChancesHtml(ch) {
  const order = ["bad","common","improved","quality","elite","perfect"];
  const lines = order.map(k => `
    <div class="forge-chance-line">
      <span class="artifact-rarity rarity-${k}">${rarityLabel(k)}</span>
      <span class="forge-chance-pct">${Math.max(0, ch?.[k] ?? 0).toFixed(1)}%</span>
    </div>
  `).join("");

  return `
    <div class="forge-chances">
      <div class="forge-chances-title">🎲 Вероятности качества</div>
      <div class="forge-chances-list">${lines}</div>
    </div>
  `;
}

function renderMandatoryRangeHtml(range, chances) {
  const likelyPct = Math.round(chances?.[range.rarity] ?? 0);

  let val;
  if (range.unit === "cycles")      val = `${range.lo}–${range.hi} цикл${pluralRu(range.hi,"","а","ов")}`;
  else if (range.unit === "charges")val = `${range.lo}–${range.hi} заряд${pluralRu(range.hi,"","а","ов")}`;
  else if (range.unit === "sec")    val = `${range.lo}–${range.hi}с`;
  else if (range.unit === "shield") val = `+${range.lo} — +${range.hi} щит`;
  else if (range.unit === "lph")    val = `+${range.lo} — +${range.hi} л/ч`;
  else                              val = `+${range.lo}% — +${range.hi}%`;

  return `
    <div class="forge-mandatory-range">
      <div class="forge-mandatory-title">
        📊 Ключевой параметр
        <span class="forge-mandatory-rarity">
          (<span class="artifact-rarity rarity-${range.rarity}">${rarityLabel(range.rarity)}</span>, ${likelyPct}%)
        </span>
      </div>
      <div class="forge-mandatory-row">
        <span class="forge-mandatory-label">${escHtml(range.label)}</span>
        <span class="forge-mandatory-val">${escHtml(val)}</span>
      </div>
    </div>
  `;
}

function clearPreviewIfNeeded() {
  const output = document.getElementById("forge-output");
  if (output) {
    output.classList.add("empty");
    output.innerHTML = '<span class="placeholder-text">Соберите рецепт в слотах</span>';
  }
  document.getElementById("btn-save-artifact")?.classList.add("hidden");
}

function resetRecipe() {
  slots           = [{ res:null, amount:0 }, { res:null, amount:0 }];
  impurity        = { res:null, amount:0 };
  pendingArtifact = null;
  document.getElementById("btn-save-artifact")?.classList.add("hidden");
  renderRecipeBuilder();
  updateForgePreview();
}

function renderArtifactPreview(artifact) {
  const el = document.getElementById("forge-output");
  if (!el) return;

  el.classList.remove("empty");
  el.innerHTML = `
    <span class="artifact-rarity rarity-${artifact.rarity}">${rarityLabel(artifact.rarity)}</span>
    <div class="artifact-name">${escHtml(artifact.name)}</div>
    <div class="artifact-desc">${escHtml(artifact.description)}</div>
    ${artifact.flavor ? `<div class="artifact-flavor">"${escHtmlNl2br(artifact.flavor)}"</div>` : ""}
    <div class="artifact-stats">
      ${renderEffectsDisplay(artifact)}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// Labels
// ─────────────────────────────────────────────────────────────

function recipeShortName(t) {
  return {
    [RECIPE.CARGO]:     "🗃️ Грузовой отсек",
    [RECIPE.TANK]:      "🛢️ Топливный бак",
    [RECIPE.ENGINE]:    "🚀 Двигатель",
    [RECIPE.PLATING]:   "🛡️ Обшивка",
    [RECIPE.DRILL]:     "⛏️ Бур",
    [RECIPE.FUEL]:      "⛽ Топливо",
    [RECIPE.AUTOPILOT]: "🤖 Автопилот",
    [RECIPE.SOLAR]:     "☀️ Солнечный модуль",
    [RECIPE.ESHIELD]:   "⚡ Энергощит",
    [RECIPE.AI_DRILL]:  "🧠 ИИ-шахтёр",

    [RECIPE.ROCKET]:    "🚀 Ракетное орудие",
    [RECIPE.THERMAL]:   "🔥 Термическое орудие",
    [RECIPE.MANEUVRE]:  "🛸 Маневровые двигатели",
    [RECIPE.KINETIC]:   "💥 Кинетическое орудие",
    [RECIPE.STEALTH]:   "👁️ Система маскировки",
  }[t] ?? "Модуль";
}

function recipeLabelPlain(t) {
  return {
    [RECIPE.CARGO]:     "Грузовой отсек",
    [RECIPE.TANK]:      "Топливный бак",
    [RECIPE.ENGINE]:    "Двигатель",
    [RECIPE.PLATING]:   "Обшивка",
    [RECIPE.DRILL]:     "Буровой модуль",
    [RECIPE.FUEL]:      "Топливо",
    [RECIPE.AUTOPILOT]: "Автопилот",
    [RECIPE.SOLAR]:     "Солнечный модуль",
    [RECIPE.ESHIELD]:   "Энергетический щит",
    [RECIPE.AI_DRILL]:  "ИИ-шахтёр",

    [RECIPE.ROCKET]:    "Ракетное орудие",
    [RECIPE.THERMAL]:   "Термическое орудие",
    [RECIPE.MANEUVRE]:  "Боевые маневровые двигатели",
    [RECIPE.KINETIC]:   "Кинетическое орудие",
    [RECIPE.STEALTH]:   "Система маскировки и помех",
  }[t] ?? "Модуль";
}

function rarityLabel(name) {
  return RARITIES.find(r => r.name === name)?.label ?? name;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function pickUnique(pool, count, mustInclude) {
  const uniq = [];
  if (mustInclude && pool.includes(mustInclude)) uniq.push(mustInclude);
  const rest     = pool.filter(x => x !== mustInclude);
  const shuffled = [...rest].sort(() => Math.random() - 0.5);
  for (const k of shuffled) {
    if (uniq.length >= count) break;
    uniq.push(k);
  }
  return uniq.slice(0, count);
}

function lerp(a, b, t) { return a + (b - a) * t; }
function biasRand() {
  const t = Math.random();
  return t * t * 0.35 + t * 0.65;
}
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function round1(x)  { return Math.round(x * 10)   / 10;  }
function round3(x)  { return Math.round(x * 1000) / 1000; }

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

function escHtmlNl2br(str) {
  return escHtml(str).replace(/\n/g, "<br>");
}

// ─────────────────────────────────────────────────────────────
// PUBLIC: генерация найденного модуля (вызывается из mining.js)
// ─────────────────────────────────────────────────────────────

const ALL_MODULE_RECIPES = [
  RECIPE.CARGO, RECIPE.DRILL, RECIPE.TANK, RECIPE.ENGINE,
  RECIPE.PLATING, RECIPE.AUTOPILOT, RECIPE.SOLAR,
  RECIPE.ESHIELD, RECIPE.AI_DRILL,
  RECIPE.ROCKET, RECIPE.THERMAL, RECIPE.MANEUVRE,
  RECIPE.KINETIC, RECIPE.STEALTH,
];

const TIER_TO_RARITY = {
  1: "bad",
  2: "common",
  3: "improved",
  4: "quality",
  5: "elite",
  6: "perfect",
};

function _buildSyntheticCost(tier) {
  const resForTier = { 1: "isotopes", 2: "minerals", 3: "metals", 4: "metals", 5: "alloys", 6: "alloys" };
  const amounts = { 1: 60, 2: 80, 3: 100, 4: 130, 5: 160, 6: 200 };
  const res = resForTier[tier] ?? "minerals";
  const amt = amounts[tier] ?? 80;
  return { isotopes: 0, minerals: 0, metals: 0, data: 0, alloys: 0, [res]: amt };
}

export async function generateFoundModule(asteroidTier, apiKey, asteroidName) {
  const rarity = TIER_TO_RARITY[asteroidTier] ?? "bad";
  const recipeType = ALL_MODULE_RECIPES[Math.floor(Math.random() * ALL_MODULE_RECIPES.length)];

  const syntheticCost = _buildSyntheticCost(asteroidTier);
  const syntheticMain = { ...syntheticCost };
  const syntheticImp = {};

  const foundContext = {
    asteroidName: asteroidName ?? "неизвестный астероид",
    tier: asteroidTier,
  };

  try {
    const artifact = await craftArtifact(
      apiKey,
      recipeType,
      syntheticCost,
      rarity,
      syntheticMain,
      syntheticImp,
      foundContext,
    );
    return artifact;
  } catch (e) {
    console.warn("[Forge] generateFoundModule failed:", e);
    return null;
  }
}