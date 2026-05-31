import { isActionType, getActionLabel, DIRECTIONAL_ACTIONS } from "./actions.js";
import { buildCombatState, runRound, LIMITS, accuracyAtDist, stealthThresholdAtDist, previewSocialGain, distDamageMult } from "./combat_alpha_engine.js";
// combat.js — бой, слоты экипировки, модалка снаряжения
// v2: фильтр schema + новые редкости
// v3: + tier-5 alloys, боевые эффекты, враги tier5/6

import {
  getInventory, spendResources, getResources, addResources,
  getExpedition, showToast,
} from "./player.js";

// ─────────────────────────────────────────────────────────────────────────────
// ЗАЧИЩЕННЫЕ АСТЕРОИДЫ
// ─────────────────────────────────────────────────────────────────────────────
const CLEARED_DURATION_MS = 2  *60*  60 * 1000;

export function getClearedAsteroids() {
  try {
    const raw  = localStorage.getItem("cleared_asteroids");
    if (!raw) return new Set();
    const data = JSON.parse(raw);
    const now  = Date.now();
    const active = new Set();
    for (const [id, expiry] of Object.entries(data)) {
      if (expiry > now) active.add(id);
    }
    return active;
  } catch { return new Set(); }
}

export function markAsteroidCleared(asteroidId) {
  try {
    const raw  = localStorage.getItem("cleared_asteroids");
    const data = raw ? JSON.parse(raw) : {};
    data[asteroidId] = Date.now() + CLEARED_DURATION_MS;
    localStorage.setItem("cleared_asteroids", JSON.stringify(data));
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// СЛОТЫ ЭКИПИРОВКИ
// ─────────────────────────────────────────────────────────────────────────────
const SLOT_COUNT = 4;
export let equippedItems = [null, null, null, null];

export function initCombat() {
  const saved = localStorage.getItem("equipped_slots");
  if (saved) {
    try {
      const ids       = JSON.parse(saved);
      const inventory = getInventory();
      equippedItems   = ids.map(id =>
        id ? (inventory.find(i => i.id === id) ?? null) : null
      );
    } catch {
      equippedItems = [null, null, null, null];
    }
  }
  renderEquipmentSlots();
  _setupEquipmentModal();
}

export function saveEquipment() {
  localStorage.setItem(
    "equipped_slots",
    JSON.stringify(equippedItems.map(i => i?.id ?? null))
  );
}

export function getEquippedItems() {
  return equippedItems.filter(Boolean);
}

export function equipItem(item, slotIndex) {
  if (slotIndex < 0 || slotIndex >= SLOT_COUNT) return;

  const existing = equippedItems.findIndex(e => e?.id === item.id);
  if (existing !== -1) equippedItems[existing] = null;

  equippedItems[slotIndex] = item;
  saveEquipment();
  renderEquipmentSlots();
  _renderEquipmentModal();

  import("./player.js").then(({ normalizeFuelOnBase, autoRefuelFromStorage, renderFuel }) => {
    normalizeFuelOnBase();
    autoRefuelFromStorage();
    renderFuel();
  });
}

export function unequipSlot(slotIndex) {
  equippedItems[slotIndex] = null;
  saveEquipment();
  renderEquipmentSlots();
  _renderEquipmentModal();

  import("./player.js").then(({ normalizeFuelOnBase, renderFuel }) => {
    normalizeFuelOnBase();
    renderFuel();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// КОНФИГУРАЦИЯ ХАРАКТЕРИСТИК ДЛЯ ОТОБРАЖЕНИЯ
// ─────────────────────────────────────────────────────────────────────────────
const SHIP_STAT_DEFS = [
  // ── БОЙ ──────────────────────────────────────────────────────────────────
  {
    key: "hp", label: "HP", icon: "❤️", unit: "", section: "combat",
    higherIsBetter: true, refMax: 500,
    getter: eq => _combatFromList(eq).hp,
  },
  {
    key: "attack", label: "Атака", icon: "⚔️", unit: "", section: "combat",
    higherIsBetter: true, refMax: 200,
    getter: eq => _combatFromList(eq).attack,
  },
  {
    key: "defense", label: "Защита", icon: "🛡️", unit: "", section: "combat",
    higherIsBetter: true, refMax: 100,
    getter: eq => _combatFromList(eq).defense,
  },
  {
    key: "speed_combat", label: "Скорость", icon: "⚡", unit: "", section: "combat",
    higherIsBetter: true, refMax: 80,
    getter: eq => _combatFromList(eq).speed,
  },
  {
    key: "dodge", label: "Уклонение", icon: "🌀", unit: "%", section: "combat",
    higherIsBetter: true, refMax: 95,
    getter: eq => {
      const bonus   = _addFromList(eq, "dodge_chance_add");
      const reflect = 100 + Math.max(0, bonus);
      return Math.min(95, Math.round(reflect / (reflect + 100) * 100));
    },
    fmt: v => `${v}%`,
  },
  // ── БОЕВЫЕ tier-5 ────────────────────────────────────────────────────────
  {
    key: "rocket_salvo", label: "Ракетный залп", icon: "🚀", unit: "×", section: "combat",
    higherIsBetter: true, refMax: 5,
    getter: eq => {
      const m = _multFromList(eq, "rocket_salvo_mult");
      return m === 1 ? 0 : +m.toFixed(2);
    },
    fmt: v => v === 0 ? "—" : `×${v}`,
  },
  {
    key: "rocket_ammo", label: "Боезапас ракет", icon: "🎯", unit: "шт.", section: "combat",
    higherIsBetter: true, refMax: 20,
    getter: eq => Math.max(0, Math.round(_addFromList(eq, "rocket_ammo_add"))),
    fmt: v => v === 0 ? "—" : `+${v}шт.`,
  },
  {
    key: "thermal_dmg", label: "Тепловой урон", icon: "🔥", unit: "×", section: "combat",
    higherIsBetter: true, refMax: 5,
    getter: eq => {
      const m = _multFromList(eq, "thermal_damage_mult");
      return m === 1 ? 0 : +m.toFixed(2);
    },
    fmt: v => v === 0 ? "—" : `×${v}`,
  },
  {
    key: "thermal_burn", label: "Ожог/сек", icon: "🌡️", unit: "ед/с", section: "combat",
    higherIsBetter: true, refMax: 20,
    getter: eq => {
      const v = _addFromList(eq, "thermal_burn_add");
      return v > 0 ? +v.toFixed(1) : 0;
    },
    fmt: v => v === 0 ? "—" : `+${v}ед/с`,
  },
  {
    key: "evade_charges", label: "Заряды уклон.", icon: "💨", unit: "шт.", section: "combat",
    higherIsBetter: true, refMax: 15,
    getter: eq => Math.max(0, Math.round(_addFromList(eq, "evade_charge_add"))),
    fmt: v => v === 0 ? "—" : `+${v}шт.`,
  },
  {
    key: "kinetic_dmg", label: "Кинет. урон", icon: "💥", unit: "×", section: "combat",
    higherIsBetter: true, refMax: 5,
    getter: eq => {
      const m = _multFromList(eq, "kinetic_damage_mult");
      return m === 1 ? 0 : +m.toFixed(2);
    },
    fmt: v => v === 0 ? "—" : `×${v}`,
  },
  {
    key: "armor_pierce", label: "Пробитие брони", icon: "🔩", unit: "×", section: "combat",
    higherIsBetter: true, refMax: 5,
    getter: eq => {
      const m = _multFromList(eq, "armor_pierce_mult");
      return m === 1 ? 0 : +m.toFixed(2);
    },
    fmt: v => v === 0 ? "—" : `×${v}`,
  },
  {
    key: "sensor_jam", label: "Помехи сенсоров", icon: "📡", unit: "%", section: "combat",
    higherIsBetter: true, refMax: 100,
    getter: eq => {
      const v = _addFromList(eq, "sensor_jam_add");
      return v > 0 ? Math.round(v) : 0;
    },
    fmt: v => v === 0 ? "—" : `+${v}%`,
  },
  {
    key: "cloak_dur", label: "Маскировка", icon: "👁️", unit: "с", section: "combat",
    higherIsBetter: true, refMax: 60,
    getter: eq => Math.max(0, Math.round(_addFromList(eq, "cloak_duration_add"))),
    fmt: v => v === 0 ? "—" : `+${v}с`,
  },
  // ── ДОБЫЧА ───────────────────────────────────────────────────────────────
  {
    key: "mining_speed", label: "Скор. добычи", icon: "⛏️", unit: "%", section: "mining",
    higherIsBetter: true, refMax: 80,
    getter: eq => Math.round((_multFromList(eq, "mining_speed_mult") - 1) * 100),
    fmt: v => v >= 0 ? `+${v}%` : `${v}%`,
  },
  {
    key: "mining_yield", label: "Хват/цикл", icon: "📦", unit: "%", section: "mining",
    higherIsBetter: true, refMax: 200,
    getter: eq => Math.round((_multFromList(eq, "mining_yield_mult") - 1) * 100),
    fmt: v => v >= 0 ? `+${v}%` : `${v}%`,
  },
  {
    key: "ore_quality", label: "Апгрейд руды", icon: "⬆️", unit: "%", section: "mining",
    higherIsBetter: true, refMax: 80,
    getter: eq => {
      const bonus = _addFromList(eq, "ore_quality_chance_add");
      return Math.min(80, Math.round(10 + Math.max(0, bonus)));
    },
    fmt: v => `${v}%`,
  },
  {
    key: "stealth", label: "Скрытность", icon: "🕵️", unit: "×", section: "mining",
    higherIsBetter: true, refMax: 5,
    getter: eq => +_multFromList(eq, "guard_stealth_mult").toFixed(2),
    fmt: v => `${v}×`,
  },

  // ── ПОЛЁТ ────────────────────────────────────────────────────────────────
  {
    key: "flight_speed", label: "Скор. полёта", icon: "🚀", unit: "%", section: "flight",
    higherIsBetter: true, refMax: 80,
    getter: eq => Math.round((_multFromList(eq, "flight_speed_mult") - 1) * 100),
    fmt: v => v >= 0 ? `+${v}%` : `${v}%`,
  },
  {
    key: "return_speed", label: "Скор. возврата", icon: "🔙", unit: "%", section: "flight",
    higherIsBetter: true, refMax: 80,
    getter: eq => Math.round((_multFromList(eq, "return_speed_mult") - 1) * 100),
    fmt: v => v >= 0 ? `+${v}%` : `${v}%`,
  },
  {
    key: "flight_eff", label: "Экон. перелёта", icon: "⛽", unit: "×", section: "flight",
    higherIsBetter: true, refMax: 4,
    getter: eq => +_multFromList(eq, "fuel_flight_efficiency_mult").toFixed(2),
    fmt: v => `${v}×`,
  },

  // ── ТРЮМ ─────────────────────────────────────────────────────────────────
  {
    key: "cargo_cap", label: "Трюм", icon: "🗃️", unit: "т", section: "cargo",
    higherIsBetter: true, refMax: 1000,
    getter: eq => {
      const m = Math.min(Math.max(_multFromList(eq, "cargo_capacity_mult"), 0.25), 10);
      return Math.max(Math.round(100 * m), 50);
    },
    fmt: v => `${v}т`,
  },
  {
    key: "compact", label: "Уплотнение", icon: "📐", unit: "×", section: "cargo",
    higherIsBetter: true, refMax: 4,
    getter: eq => +_multFromList(eq, "cargo_compact_mult").toFixed(2),
    fmt: v => `${v}×`,
  },

  // ── ТОПЛИВО ──────────────────────────────────────────────────────────────
  {
    key: "fuel_cap", label: "Ёмкость бака", icon: "🛢️", unit: "л", section: "fuel",
    higherIsBetter: true, refMax: 500,
    getter: eq => {
      const m = Math.min(Math.max(_multFromList(eq, "fuel_tank_mult"), 0.25), 100);
      return Math.max(Math.round(100 * m), 50);
    },
    fmt: v => `${v}л`,
  },
  {
    key: "fuel_eff", label: "КПД добычи", icon: "🔋", unit: "×", section: "fuel",
    higherIsBetter: true, refMax: 4,
    getter: eq => +_multFromList(eq, "fuel_efficiency_mult").toFixed(2),
    fmt: v => `${v}×`,
  },
  {
    key: "fuel_gen", label: "Генерация", icon: "☀️", unit: "л/ч", section: "fuel",
    higherIsBetter: true, refMax: 50,
    getter: eq => {
      let gen = _addFromList(eq, "fuel_gen_add") + _addFromList(eq, "fuel_drain_add");
      for (const item of eq) {
        const power = item.original ? 1.0 : (item.echoPower ?? 0.6);
        const eff   = item?.specialEffect;
        if (eff?.type === "fuel_bonus")
          gen += Math.min(Math.max(parseFloat(eff.value) || 0, 0), 20) * power;
      }
      return +Math.max(0, gen).toFixed(1);
    },
    fmt: v => `+${v}л/ч`,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ — РАСЧЁТ ПО ПРОИЗВОЛЬНОМУ СПИСКУ
// ─────────────────────────────────────────────────────────────────────────────
function _clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function _effMult(raw, power) {
  const m = Number(raw);
  if (!isFinite(m) || m <= 0) return 1;
  const p = _clamp(Number(power ?? 1), 0, 1);
  return 1 + (m - 1) * p;
}
function _effAdd(raw, power) {
  const a = Number(raw);
  if (!isFinite(a)) return 0;
  return a * _clamp(Number(power ?? 1), 0, 1);
}

function _multFromList(list, key) {
  let mult = 1;
  for (const item of list) {
    const power = item.original ? 1.0 : (item.echoPower ?? 0.6);
    const raw   = item.effects?.[key];
    if (raw !== undefined) mult *= _effMult(raw, power);
  }
  return mult;
}
function _addFromList(list, key) {
  let sum = 0;
  for (const item of list) {
    const power = item.original ? 1.0 : (item.echoPower ?? 0.6);
    const raw   = item.effects?.[key];
    if (raw !== undefined) sum += _effAdd(raw, power);
  }
  return sum;
}

function _applySpecEff(effect, raw) {
  if (!effect?.type) return;
  switch (effect.type) {
    case "stat_multiplier": {
      const mult = _clamp(parseFloat(effect.value) || 1, 0.5, 3.0);
      if (effect.target === "shield")      raw.shield      *= mult;
      if (effect.target === "penetration") raw.penetration *= mult;
      if (effect.target === "energy")      raw.energy      *= mult;
      if (effect.target === "compute")     raw.compute     *= mult;
      break;
    }
    case "stat_conversion": {
      const ratio = _clamp(parseFloat(effect.ratio) || 0, 0, 0.5);
      if (effect.from in raw && effect.to in raw) {
        const c = raw[effect.from] * ratio;
        raw[effect.from] -= c;
        raw[effect.to]   += c;
      }
      break;
    }
    case "aura_boost": {
      const f = 1 + _clamp(parseFloat(effect.value) || 0, 0, 20) / 100;
      raw.shield *= f; raw.penetration *= f; raw.energy *= f; raw.compute *= f;
      break;
    }
  }
}

function _combatFromList(list) {
  const raw = { shield: 0, penetration: 0, energy: 0, compute: 0 };

  for (const item of list) {
    const power = item.original ? 1.0 : (item.echoPower ?? 0.6);

    // ── Старые stat-строки ───────────────────────────────────
    for (const [key, val] of Object.entries(item.stats ?? {})) {
      const k      = key.toLowerCase();
      const numStr = String(val).trim();
      const isNeg  = numStr.startsWith("−") || numStr.startsWith("-");
      const num    = parseFloat(numStr.replace(/[^0-9.]/g, ""));
      if (isNaN(num)) continue;

      const signed = isNeg ? -num : num;

      if (k.includes("щит")    || k.includes("shield"))                           raw.shield      += signed * power;
      if (k.includes("пробит") || k.includes("penetrat"))                         raw.penetration += signed * power;
      if (k.includes("энерги") || k.includes("energy"))                           raw.energy      += signed * power;
      if (k.includes("вычисл") || k.includes("compute") || k.includes("tflops"))  raw.compute     += signed * power;
    }

    // ── Боевые effects tier-5 → конвертируем в combat-сырьё ──
    const eff = item.effects ?? {};

    // Ракетное орудие: залп → penetration
    if (eff.rocket_salvo_mult !== undefined) {
      const m = _effMult(eff.rocket_salvo_mult, power);
      raw.penetration += (m - 1) * 60;
    }
    // Доп. боезапас → penetration (небольшой вклад)
    if (eff.rocket_ammo_add !== undefined) {
      raw.penetration += _effAdd(eff.rocket_ammo_add, power) * 4;
    }

    // Термическое → energy
    if (eff.thermal_damage_mult !== undefined) {
      const m = _effMult(eff.thermal_damage_mult, power);
      raw.energy += (m - 1) * 55;
    }
    if (eff.thermal_burn_add !== undefined) {
      raw.energy += _effAdd(eff.thermal_burn_add, power) * 8;
    }

    // Кинетическое → penetration
    if (eff.kinetic_damage_mult !== undefined) {
      const m = _effMult(eff.kinetic_damage_mult, power);
      raw.penetration += (m - 1) * 65;
    }
    if (eff.armor_pierce_mult !== undefined) {
      const m = _effMult(eff.armor_pierce_mult, power);
      raw.penetration += (m - 1) * 40;
    }

    // Маневровые → speed (через compute) + shield
    if (eff.evade_charge_add !== undefined) {
      raw.compute += _effAdd(eff.evade_charge_add, power) * 5;
    }

    // Маскировка → compute (помехи путают врага)
    if (eff.sensor_jam_add !== undefined) {
      raw.compute += _effAdd(eff.sensor_jam_add, power) * 1.2;
    }
    if (eff.cloak_duration_add !== undefined) {
      raw.compute += _effAdd(eff.cloak_duration_add, power) * 2;
    }

    _applySpecEff(item.specialEffect, raw);
  }

  return {
    hp:      Math.max(10, Math.round(50 + raw.shield      * 1.0)),
    attack:  Math.max(5,  Math.round(10 + raw.penetration * 0.4 + raw.energy * 0.3)),
    defense: Math.max(1,  Math.round(5  + raw.shield      * 0.2)),
    speed:   Math.max(1,  Math.round(8  + raw.compute     * 0.1)),
  };
}

function _calcAllStats(list) {
  const out = {};
  for (const def of SHIP_STAT_DEFS) {
    try { out[def.key] = def.getter(list); }
    catch { out[def.key] = 0; }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// БОЕВЫЕ СТАТЫ ИГРОКА (публичный API)
// ─────────────────────────────────────────────────────────────────────────────
export function getPlayerCombatStats() {
  const raw = { shield: 0, penetration: 0, energy: 0, compute: 0 };
  const equipped = getEquippedItems();

  for (const item of equipped) {
    const power = item.original ? 1.0 : (item.echoPower ?? 0.6);

    for (const [key, val] of Object.entries(item.stats ?? {})) {
      const k      = key.toLowerCase();
      const numStr = String(val).trim();
      const isNeg  = numStr.startsWith("−") || numStr.startsWith("-");
      const num    = parseFloat(numStr.replace(/[^0-9.]/g, ""));
      if (isNaN(num)) continue;

      const signed = isNeg ? -num : num;

      if (k.includes("щит")    || k.includes("shield"))                           raw.shield      += signed * power;
      if (k.includes("пробит") || k.includes("penetrat"))                         raw.penetration += signed * power;
      if (k.includes("энерги") || k.includes("energy"))                           raw.energy      += signed * power;
      if (k.includes("вычисл") || k.includes("compute") || k.includes("tflops"))  raw.compute     += signed * power;
    }

    // ── Боевые effects tier-5 ──────────────────────────────
    const eff = item.effects ?? {};

    if (eff.rocket_salvo_mult  !== undefined) raw.penetration += (_effMult(eff.rocket_salvo_mult, power)  - 1) * 60;
    if (eff.rocket_ammo_add    !== undefined) raw.penetration += _effAdd(eff.rocket_ammo_add, power) * 4;

    if (eff.thermal_damage_mult!== undefined) raw.energy      += (_effMult(eff.thermal_damage_mult, power) - 1) * 55;
    if (eff.thermal_burn_add   !== undefined) raw.energy      += _effAdd(eff.thermal_burn_add, power) * 8;

    if (eff.kinetic_damage_mult!== undefined) raw.penetration += (_effMult(eff.kinetic_damage_mult, power) - 1) * 65;
    if (eff.armor_pierce_mult  !== undefined) raw.penetration += (_effMult(eff.armor_pierce_mult, power)  - 1) * 40;

    if (eff.evade_charge_add   !== undefined) raw.compute     += _effAdd(eff.evade_charge_add, power) * 5;
    if (eff.sensor_jam_add     !== undefined) raw.compute     += _effAdd(eff.sensor_jam_add, power) * 1.2;
    if (eff.cloak_duration_add !== undefined) raw.compute     += _effAdd(eff.cloak_duration_add, power) * 2;

    applySpecialEffect(item.specialEffect, raw);
  }

  const weaknessTypes = [];
  if (raw.compute     > 50)  weaknessTypes.push("compute");
  if (raw.penetration > 50)  weaknessTypes.push("penetration");
  if (raw.energy      > 30)  weaknessTypes.push("energy");
  if (raw.shield      > 100) weaknessTypes.push("shield");

  return {
    hp:      Math.max(10, Math.round(50 + raw.shield      * 1.0)),
    attack:  Math.max(5,  Math.round(10 + raw.penetration * 0.4 + raw.energy * 0.3)),
    defense: Math.max(1,  Math.round(5  + raw.shield      * 0.2)),
    speed:   Math.max(1,  Math.round(8  + raw.compute     * 0.1)),
    weaknessTypes,
    raw,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// СПЕЦИАЛЬНЫЕ ЭФФЕКТЫ
// ─────────────────────────────────────────────────────────────────────────────
function applySpecialEffect(effect, raw) {
  if (!effect?.type) return;

  switch (effect.type) {
    case "stat_multiplier": {
      const mult = _clamp(parseFloat(effect.value) || 1, 0.5, 3.0);
      if (effect.target === "shield")      raw.shield      *= mult;
      if (effect.target === "penetration") raw.penetration *= mult;
      if (effect.target === "energy")      raw.energy      *= mult;
      if (effect.target === "compute")     raw.compute     *= mult;
      break;
    }
    case "stat_conversion": {
      const ratio = _clamp(parseFloat(effect.ratio) || 0, 0, 0.5);
      if (effect.from in raw && effect.to in raw) {
        const c = raw[effect.from] * ratio;
        raw[effect.from] -= c;
        raw[effect.to]   += c;
      }
      break;
    }
    case "aura_boost": {
      const f = 1 + _clamp(parseFloat(effect.value) || 0, 0, 20) / 100;
      raw.shield *= f; raw.penetration *= f; raw.energy *= f; raw.compute *= f;
      break;
    }
  }
}

export function getSpecialMiningBonus() {
  let bonus = 0;
  for (const item of getEquippedItems()) {
    const eff = item?.specialEffect;
    if (eff?.type === "mining_bonus")
      bonus += Math.min(parseFloat(eff.value) || 0, 30)
             * (item.original ? 1.0 : (item.echoPower ?? 0.6));
  }
  return bonus;
}

export function getSpecialFuelBonus() {
  let bonus = 0;
  for (const item of getEquippedItems()) {
    const eff = item?.specialEffect;
    if (eff?.type === "fuel_bonus")
      bonus += Math.min(parseFloat(eff.value) || 0, 20)
             * (item.original ? 1.0 : (item.echoPower ?? 0.6));
  }
  return bonus;
}


// ─────────────────────────────────────────────────────────────────────────────
// РЕАЛЬНЫЙ БОЙ (ИНТЕГРАЦИЯ С АЛЬФА-ДВИЖКОМ)
// ─────────────────────────────────────────────────────────────────────────────

export function pickEnemy(asteroidTier) {
  if (asteroidTier <= 2) return null;
  const pools = {
    3: [ { key: "minor_pirate", scale: 1.0, reward: { metals: 30, isotopes: 20 }, label: "Мелкий пират" }, 
         { key: "belt_guard", scale: 1.0, reward: { minerals: 40, metals: 10 }, label: "Охрана пояса" } ],
    4: [ { key: "belt_guard", scale: 1.5, reward: { data: 20, metals: 50 }, label: "Ветеран охраны" }, 
         { key: "corp_agent", scale: 1.5, reward: { data: 40, isotopes: 50 }, label: "Корпоративный агент" } ],
    5: [ { key: "pirate_pack", scale: 2.2, reward: { alloys: 15, data: 30 }, label: "Пиратская стая" }, 
         { key: "berserker", scale: 2.0, reward: { alloys: 10, metals: 100 }, label: "Берсерк" } ],
    6: [ { key: "berserker", scale: 3.5, reward: { alloys: 30, data: 80 }, label: "Безумный берсерк" }, 
         { key: "pirate_pack", scale: 3.0, reward: { alloys: 25, isotopes: 200 }, label: "Пиратская армада" }, 
         { key: "corp_agent", scale: 3.5, reward: { alloys: 40, metals: 150 }, label: "Элитный агент" } ]
  };
  const pool = pools[asteroidTier] || pools[6];
  return pool[Math.floor(Math.random() * pool.length)];
}

const CACHE_KEY = "combat_cards_cache_v3";
function safeJsonParse(str, fallback) { try { return JSON.parse(str) || fallback; } catch { return fallback; } }
function comboKey(id1, id2) { return ["COMBO", ...[id1, id2].sort()].join("__+__"); }

function normalizeCardLite(card) {
  const out = {
    origin_key:       String(card?.origin_key ?? "").trim(),
    card_name:        String(card?.card_name ?? card?.origin_key ?? "CARD").trim(),
    lore_description: String(card?.lore_description ?? "").trim(),
    chaos_reason:     String(card?.chaos_reason ?? "").trim(),
    actions: [],
  };
  const acts = Array.isArray(card?.actions) ? card.actions : [];
  for (const a of acts.filter(x => x?.role !== "chaos").slice(0, 2)) {
    const t = String(a?.type ?? "").trim();
    const m = Number(a?.mult ?? 1);
    if (!isActionType(t)) continue;
    out.actions.push({ type: t, mult: Math.max(0.6, Math.min(1.8, m)), role: "normal" });
  }
  while (out.actions.filter(a => a.role === "normal").length < 2) {
    out.actions.push({ type: "NEGOTIATE_DELAY", mult: 1.0, role: "normal" });
  }
  if (out.actions[0].type === out.actions[1].type) out.actions[1].type = "DISTANCE_PUSH";
  const chaosRaw    = acts.find(x => x?.role === "chaos") || acts[2];
  const chaosType   = String(chaosRaw?.type ?? "").trim();
  const chaosMultRaw = Number(chaosRaw?.mult ?? 0);
  const inLow       = chaosMultRaw >= 0.2 && chaosMultRaw <= 0.5;
  const inHigh      = chaosMultRaw >= 1.8 && chaosMultRaw <= 2.5;
  out.actions.push({
    type:  isActionType(chaosType) ? chaosType : "NEGOTIATE_DELAY",
    mult:  (inLow || inHigh) ? chaosMultRaw : (Math.random() < 0.5 ? 0.3 : 2.0),
    role:  "chaos",
  });
  return out;
}

function loadDeckFromCache(equippedItems) {
  const cache = safeJsonParse(localStorage.getItem(CACHE_KEY), {});
  const ids   = equippedItems.map(it => it.id);
  const deck  = [];
  for (const id of ids) if (cache[id]) deck.push(normalizeCardLite(cache[id]));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const k = comboKey(ids[i], ids[j]);
      if (cache[k]) deck.push(normalizeCardLite(cache[k]));
    }
  }
  return deck;
}

function cargoUnitsFromPlayerState() {
  try {
    return Object.values(window.CF_GET_STATE()?.cargo || {}).reduce((s, v) => s + (Number(v) || 0), 0);
  } catch { return 0; }
}

let REAL_STATE = null;
let REAL_CALLBACK = null;

export async function showCombatModal(enemyCfg, onFinish) {
  const modal = document.getElementById("modal-combat");
  const content = document.getElementById("combat-content");
  if (!modal || !content) return;
  
  REAL_CALLBACK = onFinish;
  
  const equippedItems = getEquippedItems();
  const deck = loadDeckFromCache(equippedItems);
  
  if (deck.length < 4) {
     const { showToast } = await import("./player.js");
     showToast("ВНИМАНИЕ: Колода собрана не полностью. Сгенерируйте карты в Снаряжении!", "warning");
  }
  
  const { getCredits } = await import("./player.js");

  REAL_STATE = buildCombatState({
    equippedItems,
    deckCards: deck,
    enemyKey: enemyCfg.key,
    playerCredits: getCredits(),
    playerCargoUnits: cargoUnitsFromPlayerState(),
    playerFuel: (await import("./player.js")).getFuel(),
    playerMaxFuel: (await import("./player.js")).getFuelCapacity(),
    tierScale: enemyCfg.scale,
  });
  REAL_STATE.enemy.reward = enemyCfg.reward;
  REAL_STATE.enemy.label = enemyCfg.label;
  
  content.innerHTML = `
    <style>
      .combat-sim-hud { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:10px; }
      .combat-sim-main { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
      .combat-sim-card { background:rgba(255,255,255,0.04); border:1px solid var(--border); border-radius:10px; padding:10px; transition:border-color .15s; }
      .combat-sim-card.escape-hint { border-color:var(--green); box-shadow:0 0 8px rgba(16,185,129,0.25); }
      .combat-sim-card-title { font-weight:800; margin-bottom:6px; color:var(--accent); }
      .combat-sim-card-lore { font-size:12px; opacity:.92; white-space:pre-wrap; margin-bottom:8px; color:var(--muted); font-style:italic;}
      .combat-sim-effect-lines { font-size:12px; line-height:1.35; margin:6px 0 8px; }
      .combat-sim-chaos-preview { margin-top: 8px; padding: 5px 8px; border-radius: 6px; border: 1px dashed rgba(255,255,255,0.2); font-size: 11px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
      .combat-sim-dir-btns { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:6px; }
      .combat-sim-dir-btn { padding:8px 6px; font-weight:700; font-size:12px; }
      .combat-sim-play-btn { width:100%; padding:10px 12px; font-weight:800; margin-top:6px; }
      @media (max-width:768px) {
        .combat-sim-hud, .combat-sim-main, .combat-sim-dir-btns { grid-template-columns:1fr; }
      }
    </style>
    <div id="real-combat-hud" class="combat-sim-hud"></div>
    <div class="combat-sim-main">
      <div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">
          🃏 Ваши действия: выберите карту или манёвр
          <span style="color:var(--green)"> · зелёный = отступление</span>
        </div>
        <div id="real-combat-hand" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;"></div>
      </div>
      <div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">📜 Лог</div>
        <div id="real-combat-log" class="combat-log" style="height:350px;"></div>
      </div>
    </div>
  `;
  
  const actionsContainer = modal.querySelector(".combat-modal-actions");
  actionsContainer.innerHTML = `
    <button id="btn-real-combat-close" class="btn-primary hidden">Завершить бой</button>
  `;
  
  const closeBtn = document.getElementById("btn-real-combat-close");
  closeBtn.onclick = () => {
    rc_clearChaosFlash();
    modal.classList.add("hidden");
    if (REAL_CALLBACK) REAL_CALLBACK(REAL_STATE);
  };
  
  modal.querySelector("h2").textContent = "⚔️ БОЕВОЙ КОНТАКТ";
  modal.classList.remove("hidden");
  rc_renderAll();
}

// -------------------------------------------------------------
// UI Rendering for Real Combat
// -------------------------------------------------------------
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function pct01(x) { return `${Math.round(clamp(x, 0, 1) * 100)}%`; }
function bar(val, max, color = "var(--accent)") {
  const pct = clamp(val / Math.max(1, max) * 100, 0, 100);
  return `<div style="height:6px;border-radius:3px;background:rgba(255,255,255,0.08);margin:3px 0 6px;overflow:hidden;">
    <div style="height:100%;width:${pct}%;background:${color};border-radius:3px;transition:width .2s;"></div>
  </div>`;
}

function rc_renderHud() {
  const el = document.getElementById("real-combat-hud");
  if (!el || !REAL_STATE) return;
  const s = REAL_STATE;

  const stealthHint = s.distance >= LIMITS.ESCAPE_DIST
    ? `<span style="color:var(--green)">(dist-побег доступен)</span>`
    : `<span style="color:var(--muted)">(нужно: скрытность ≥${stealthThresholdAtDist(s.distance)}, удержание ${s.stealthLock??0}/${LIMITS.STEALTH_LOCK_REQUIRED})</span>`;

  const plea     = Number(s.social?.plea   ?? 0);
  const threat   = Number(s.social?.threat ?? 0);
  const detColor = s.detonationRisk >= 50 ? "var(--red)" : "var(--accent)";
  const fatigue  = Math.round(s.engineFatigue ?? 0);
  const fatColor = fatigue >= 60 ? "var(--red)" : fatigue >= 30 ? "#ff9800" : "var(--muted)";
  const eDown    = (s.enemy.modules || []).reduce((acc, m) => acc + (m.destroyed?1:0), 0);
  const eTotal   = (s.enemy.modules || []).length;
  
  let pAcc = accuracyAtDist(s.distance, true);
  let eAcc = accuracyAtDist(s.distance, false);
  if ((s.enemy.accuracyDebuffRounds ?? 0) > 0) eAcc *= 0.8;
  if ((s.player.evasionPct ?? 0) > 0) eAcc *= (1 - clamp(s.player.evasionPct, 0, 85) / 100);

  el.innerHTML = `
    <div class="combat-sim-card">
      <div class="combat-sim-card-title">🚀 Игрок</div>
      <div>🛡 щит: <b>${s.player.shield}</b>/${s.player.maxShield}</div>
      ${bar(s.player.shield, s.player.maxShield, "var(--accent)")}
      <div>🧱 обшивка: <b>${s.player.hull}</b>/${s.player.maxHull}</div>
      ${bar(s.player.hull, s.player.maxHull, "#8d6e63")}

      <div>📏 Дистанция: <b>${Math.round(s.distance)}</b> <span style="color:var(--muted)">(побег ≥${LIMITS.ESCAPE_DIST})</span></div>
      <div>🎯 попадание: вы <b>${pct01(pAcc)}</b> · враг <b>${pct01(eAcc)}</b></div>

      <div style="margin-top:6px;">
        <div>🕵 Скрытность: <b>${s.stealth.toFixed(0)}</b>/100 ${stealthHint}</div>
        ${bar(s.stealth, 100, "var(--green)")}
        <div style="color:${fatColor}">⚙️ Перегрев двиг.: <b>${fatigue}%</b></div>
        ${bar(fatigue, 90, fatColor)}
        <div>🤲 Убеждение: <b>${plea.toFixed(1)}</b>/${LIMITS.SOCIAL_PLEA_WIN}</div>
        ${bar(plea, LIMITS.SOCIAL_PLEA_WIN, "#26a69a")}
        <div>☢️ Угроза: <b>${threat.toFixed(1)}</b>/${LIMITS.SOCIAL_THREAT_WIN}</div>
        ${bar(threat, LIMITS.SOCIAL_THREAT_WIN, "#ef5350")}
        <div style="color:${detColor}">💥 Риск взрыва: <b>${s.detonationRisk.toFixed(0)}%</b></div>
        ${bar(s.detonationRisk, 100, detColor)}
      </div>
    </div>
    <div class="combat-sim-card">
      <div class="combat-sim-card-title">☠️ ${_esc(s.enemy.label)}</div>
      <div>🛡 щит: <b>${s.enemy.shield}</b>/${s.enemy.maxShield}</div>
      ${bar(s.enemy.shield, s.enemy.maxShield, "#7986cb")}
      <div>🧱 корпус: <b>${s.enemy.hull}</b>/${s.enemy.maxHull}</div>
      ${bar(s.enemy.hull, s.enemy.maxHull, "#a1887f")}

      <div>🔧 системы: <b>${eTotal-eDown}</b>/${eTotal} <span style="color:var(--muted)">(сломано: ${eDown})</span></div>
      <div>🌡 Горение: <b>${Number(s.enemy.burn).toFixed(0)}</b></div>
      <div>💢 агрессия: <b>${((s.enemy.aggression??0.7)*100).toFixed(0)}%</b></div>
      <div>🔍 Скан-модуль: <b>${Math.round((s.enemy.scanPower??0)*100)}%</b></div>
      <div>🎯 Баз. урон: <b>${s.enemy.baseDamage}</b></div>
      <div>⏳ Раунд: <b>${s.round}</b>/${LIMITS.MAX_ROUNDS}</div>
      <div style="margin-top:8px;font-size:12px;color:var(--muted);">
        ${s.over ? `<b>ИТОГ: ${_esc({win_kill:'Враг уничтожен',win_flee:'Побег',win_stealth:'Скрылся',win_social_plea:'Договорился',win_social_threat:'Враг отступил',lose_board:'Абордаж',lose_modules:'Корабль разбит',lose_detonation:'Детонация бака'}[s.result] || s.result)}</b>` : "Бой продолжается…"}
      </div>
    </div>
  `;
}

function rc_actionName(type) {
  const ACTION_SHORT = {
    ATTACK_KINETIC: "Кинетический залп", ATTACK_THERMAL: "Термический прожиг", ATTACK_SHRAPNEL: "Шрапнель по сектору",
    ATTACK_EMP: "ЭМИ-удар", PIERCE: "Бронебойный прокол", FOCUS_FIRE: "Фокус-огонь", DISRUPT_SENSORS: "Срыв сенсоров",
    FUEL_IGNITE: "Поджог топлива", ROCKET_SALVO: "Ракетный залп", SHIELD_REGEN: "Реген щита", SHIELD_SPIKE: "Пик щита",
    HULL_BRACE: "Укрепить корпус", EMERGENCY_REPAIR: "Аварийный ремонт", DAMAGE_CONTROL: "Контроль повреждений",
    DISTANCE_PUSH: "Манёвр (от/к)", DISTANCE_PULL: "Сближение", FULL_BURN: "Полный форсаж (от/к)", DRIFT_SILENT: "Тихий дрейф (от/к)",
    EVADE_SPIKE: "Резкий уклон", SENSOR_JAM: "Глушилка сенсоров", SIGNAL_BLUFF: "Блеф в эфире", DATA_SPOOF: "Спуфинг меток",
    FAKE_MELTDOWN: "Ложная авария", EMP_STUN: "ЭМИ-стан", DECOY_DUMP: "Сброс приманок", OFFER_BRIBE: "Подкуп",
    BROADCAST_PLEA: "Мольба в эфир", NEGOTIATE_DELAY: "Тянуть время", THREATEN_DETONATION: "Угроза подрыва",
    FUEL_BURN: "Сжечь топливо", CARGO_JETTISON: "Сброс груза", CALL_REINFORCEMENTS: "Вызов подкрепления"
  };
  return ACTION_SHORT[type] || getActionLabel(type) || type;
}

function rc_previewActionLine(s, a, dir) {
  const type = String(a?.type || "").trim();
  const mult = clamp(Number(a?.mult ?? 1), 0.1, 3.0);
  const eff = s?.player?._eff || {};
  const speedMult = clamp(eff.flight_speed_mult ?? 1, 0.15, 18.0);
  const fatMult = 1 - clamp(s.engineFatigue ?? 0, 0, 90) / 100;
  
  const dm = distDamageMult(type, s.distance);
  let base = 0;
  if (type === "ATTACK_KINETIC") base = 5 * mult * (eff.kinetic_damage_mult ?? 1);
  else if (type === "ATTACK_THERMAL") base = 5 * mult * (eff.thermal_damage_mult ?? 1);
  else if (type === "ATTACK_SHRAPNEL") base = 4 * mult * (eff.rocket_salvo_mult ?? 1);
  else if (type === "ROCKET_SALVO") base = 10 * mult * (eff.rocket_salvo_mult ?? 1);
  else if (type === "PIERCE") base = 4 * mult * (eff.armor_pierce_mult ?? 1);
  else if (type === "FOCUS_FIRE") base = 9 * mult * (eff.kinetic_damage_mult ?? 1);
  else if (type === "FUEL_IGNITE") base = 5 * mult * (eff.thermal_damage_mult ?? 1);
  
  const dmg = Math.round(base * dm);

  if (type === "DRIFT_SILENT") {
     const sAway = Math.round(20 * mult * (eff.guard_stealth_mult ?? 1) * (1 + (eff.cloak_duration_add ?? 0) / 10));
     const sToward = Math.round(sAway * 1.3);
     const delta = Math.round(6 * mult * speedMult);
     return `Тихий дрейф: дист. ±${delta}, скрытность +${sAway} (от) / +${sToward} (к)`;
  }
  if (type === "DISTANCE_PUSH") {
     const delta = Math.round(12 * mult * speedMult * fatMult);
     return `Манёвр: дист. ±${delta}`;
  }
  if (type === "FULL_BURN") {
     const delta = Math.round(20 * mult * speedMult * fatMult);
     return `Форсаж: дист. ±${delta} (щит −10)`;
  }
  if (type === "DISTANCE_PULL") {
     const pull = Math.round(12 * mult * speedMult * fatMult);
     return `Сближение: дист. −${pull}`;
  }
  if (type === "CARGO_JETTISON") {
     return `Сброс балласта: −33% трюма, дист. +${Math.round(15 * mult * speedMult)}`;
  }
  if (type === "FUEL_BURN") {
     return `Сжечь топливо: −25% бака, дист. +${Math.round(25 * mult * speedMult)}`;
  }

  if (base > 0) return `${rc_actionName(type)}: ~${dmg} урона (расст.×${dm.toFixed(2)})`;
  
  if (type === "SHIELD_REGEN") return `Реген щита: +${Math.round(15*mult*(eff.shield_mult??1))}`;
  if (type === "SHIELD_SPIKE") return `Пик щита: +${Math.round(25*mult*(eff.shield_mult??1))}`;
  if (type === "EMERGENCY_REPAIR") return `Ремонт: +${Math.round(10*mult*(eff.hp_mult??1))}`;
  if (type === "THREATEN_DETONATION") return `Угроза подрыва: риск взрыва +5%`;
  
  return `${rc_actionName(type)}`;
}

function rc_renderHand() {
  const el = document.getElementById("real-combat-hand");
  const s = REAL_STATE;
  if (!el || !s) return;
  
  if (s.over) {
    el.innerHTML = "";
    document.getElementById("btn-real-combat-close")?.classList.remove("hidden");
    return;
  }

  el.innerHTML = "";
  const cards = (s.hand || []).slice(0, 2);
  
  for (let idx = 0; idx < 2; idx++) {
    const c = cards[idx];
    const cardEl = document.createElement("div");
    cardEl.className = "combat-sim-card";

    if (!c) {
      cardEl.innerHTML = `<div class="combat-sim-card-title" style="opacity:.6">Нет карты</div>`;
      el.appendChild(cardEl);
      continue;
    }

    const normalActions = (c.actions || []).filter(a => a.role !== "chaos");
    const hasDirectional = normalActions.some(a => DIRECTIONAL_ACTIONS.has(String(a?.type || "")));

    const normalLinesHtml = normalActions.slice(0, 2).map(a => {
      const line = rc_previewActionLine(s, a, "away");
      return `<div>${_esc(line)}</div>`;
    }).join("");

    const chaosPreviewHtml = `
      <div class="combat-sim-chaos-preview">
        <span class="chaos-icon">⚡</span>
        <span style="color:var(--muted);"><b>Скрытая аномалия</b></span>
      </div>`;

    cardEl.innerHTML = `
      <div class="combat-sim-card-title">${_esc(c.card_name || c.origin_key)}</div>
      <div class="combat-sim-card-lore">${_esc(c.lore_description || "")}</div>
      <div class="combat-sim-effect-lines">${normalLinesHtml}</div>
      ${chaosPreviewHtml}
    `;

    const playWithChaosFlash = (direction) => {
      if (s.over) return;
      runRound(s, idx, direction);
      rc_renderAll();
      if (s._lastChaos) setTimeout(() => rc_showChaosFlash(s._lastChaos), 300);
    };

    if (hasDirectional) {
      const btnDiv = document.createElement("div");
      btnDiv.className = "combat-sim-dir-btns";
      btnDiv.innerHTML = `
        <button type="button" class="btn-secondary combat-sim-dir-btn toward" ${s.over ? "disabled" : ""}>⬅ К врагу</button>
        <button type="button" class="btn-primary combat-sim-dir-btn away" ${s.over ? "disabled" : ""}>От врага ➡</button>
      `;
      const [btnT, btnA] = btnDiv.querySelectorAll("button");
      btnT.addEventListener("click", (e) => { e.stopPropagation(); playWithChaosFlash("toward"); });
      btnA.addEventListener("click", (e) => { e.stopPropagation(); playWithChaosFlash("away"); });
      cardEl.appendChild(btnDiv);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn-primary combat-sim-play-btn`;
      btn.disabled = s.over;
      btn.textContent = "▶ Сыграть эту карту";
      btn.addEventListener("click", (e) => { e.stopPropagation(); playWithChaosFlash(null); });
      cardEl.addEventListener("click", () => playWithChaosFlash(null));
      cardEl.appendChild(btn);
    }
    el.appendChild(cardEl);
  }
}

function rc_renderLog() {
  const el = document.getElementById("real-combat-log");
  if (!el || !REAL_STATE) return;
  el.innerHTML = "";
  for (const entry of REAL_STATE.log.slice(-240)) {
    const line = document.createElement("div");
    line.className = "log-line";
    const isResult = entry.title === "ИТОГ";
    if (isResult) line.classList.add("log-result");
    else if (entry.who === "player") line.classList.add("log-player");
    else if (entry.who === "enemy") line.classList.add("log-enemy");

    const msgs = (entry.messages || []).map(m => {
      const s = String(m);
      if (s.startsWith("⚡ CHAOS")) return `<span style="color:#ff9800;font-weight:600;">${_esc(s)}</span>`;
      return _esc(s);
    }).join("<br>");

    line.innerHTML = `<b>[${entry.round}] ${_esc(entry.who)}: ${_esc(entry.title)}</b><br>${msgs}`;
    el.appendChild(line);
  }
  el.scrollTop = el.scrollHeight;
}

function rc_renderAll() {
  rc_renderHud();
  rc_renderHand();
  rc_renderLog();
}

function rc_showChaosFlash(chaos) {
  rc_clearChaosFlash();
  if (!chaos) return;
  const chaosMult = Number(chaos.mult);
  const isHigh = chaosMult >= 1.8;
  const isBad = chaosMult <= 0.4;
  const color = isHigh ? "#ff9800" : isBad ? "#ef5350" : "#ce93d8";
  const emoji = isHigh ? "⚡🔥" : isBad ? "⚡💀" : "⚡";
  const borderColor = isHigh ? "rgba(255,152,0,0.6)" : isBad ? "rgba(239,83,80,0.6)" : "rgba(206,147,216,0.4)";

  const overlay = document.createElement("div");
  overlay.id = "real-chaos-flash";
  overlay.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);pointer-events:auto;`;
  
  overlay.innerHTML = `
    <div style="background:rgba(10,10,15,0.96);border:2px solid ${borderColor};border-radius:16px;padding:24px 32px;max-width:480px;text-align:center;">
      <div style="font-size:28px;margin-bottom:8px;">${emoji}</div>
      <div style="font-size:13px;font-weight:900;color:${color};margin-bottom:12px;">CHAOS СРАБОТАЛ</div>
      <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:10px;">${_esc(rc_actionName(chaos.type))} ×${chaosMult.toFixed(2)}</div>
      <div style="font-size:14px;color:#ddd;margin-bottom:16px;">${_esc(chaos.result)}</div>
      ${chaos.chaos_reason ? `<div style="font-size:12px;color:#888;font-style:italic;">«${_esc(chaos.chaos_reason)}»</div>` : ""}
      <button id="btn-real-chaos-ok" class="btn-primary" style="margin-top:16px;">ПОНЯТНО</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("#btn-real-chaos-ok").onclick = rc_clearChaosFlash;
}
function rc_clearChaosFlash() {
  document.getElementById("real-chaos-flash")?.remove();
}

// ─────────────────────────────────────────────────────────────────────────────
// UI: КОМПАКТНАЯ ПАНЕЛЬ СЛОТОВ
// ─────────────────────────────────────────────────────────────────────────────
export function renderEquipmentSlots() {
  const container = document.getElementById("equipment-slots");
  if (!container) return;

  const stats       = getPlayerCombatStats();
  const filledCount = equippedItems.filter(Boolean).length;
  const equipWeight = equippedItems.filter(Boolean).reduce((s, i) => s + (i.weight ?? 0), 0);

  container.innerHTML = `
    <div class="equipment-header">
      <span class="equip-title">⚔️ Снаряжение (${filledCount}/${SLOT_COUNT})</span>
      <div class="combat-stats-mini">
        <span title="HP">❤️ ${stats.hp}</span>
        <span title="Атака">⚔️ ${stats.attack}</span>
        <span title="Защита">🛡️ ${stats.defense}</span>
        <span title="Скорость">⚡ ${stats.speed}</span>
        ${equipWeight > 0 ? `<span title="Вес снаряжения">⚖️ ${equipWeight}т</span>` : ""}
      </div>
    </div>
    <div class="slots-grid">
      ${equippedItems.map((item, i) => `
        <div class="equip-slot ${item ? "filled" : "empty"}">
          ${item ? `
            <div class="equip-slot-inner">
              <span class="equip-rarity-dot rarity-dot-${item.rarity ?? "common"}"></span>
              <span class="equip-name" title="${_esc(item.name)}">${_esc(item.name)}</span>
              ${item.weight ? `<span class="equip-weight">⚖️ ${item.weight}т</span>` : ""}
              ${item.specialEffect ? `<span class="equip-special" title="${_esc(item.specialEffect.description ?? "")}">✨</span>` : ""}
              <button class="btn-unequip"
                      onclick="event.stopPropagation(); window._unequipSlot(${i})"
                      title="Снять (только на базе)">✕</button>
            </div>
           `:` <div class="equip-slot-empty">Слот ${i + 1}</div>`}
        </div>
      `).join("")}
    </div>
    <div class="equip-open-hint">🔍 Нажмите для детального просмотра и управления снаряжением</div>
  `;

  container.onclick = (e) => {
    if (e.target.classList.contains("btn-unequip")) return;
    _openEquipmentModal();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// МОДАЛКА СНАРЯЖЕНИЯ
// ─────────────────────────────────────────────────────────────────────────────
function _setupEquipmentModal() {
  const modal    = document.getElementById("modal-equipment");
  const btnClose = document.getElementById("btn-equipment-close");
  if (!modal) return;

  if (btnClose) {
    btnClose.onclick = () => modal.classList.add("hidden");
  }

  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("hidden");
  });
}

function _openEquipmentModal() {
  const modal = document.getElementById("modal-equipment");
  if (!modal) return;
  modal.classList.remove("hidden");
  _renderEquipmentModal();
}

let _hoverItemId = null;

function _renderEquipmentModal() {
  const modal = document.getElementById("modal-equipment");
  if (!modal || modal.classList.contains("hidden")) return;

  _renderStatsBar();
  _renderModalSlots();
  _renderModalInventory();
}

// ─── Стат-бар ───────────────────────────────────────────────────────────────
function _renderStatsBar() {
  const el = document.getElementById("equip-modal-stats-bar");
  if (!el) return;

  const currentEq    = equippedItems.filter(Boolean);
  const currentStats = _calcAllStats(currentEq);

  let previewStats = null;
  let hoverItem    = null;

  if (_hoverItemId) {
    hoverItem = getInventory().find(i => i.id === _hoverItemId);
    if (hoverItem && !equippedItems.some(e => e?.id === _hoverItemId)) {
      previewStats = _calcAllStats([...currentEq, hoverItem]);
    }
  }

  const SECTIONS = [
    { id: "combat", label: "⚔️ Бой" },
    { id: "mining", label: "⛏️ Добыча" },
    { id: "flight", label: "🚀 Полёт" },
    { id: "cargo",  label: "🗃️ Трюм" },
    { id: "fuel",   label: "⛽ Топливо" },
  ];

  let html = "";

  for (const sec of SECTIONS) {
    const defs = SHIP_STAT_DEFS.filter(d => d.section === sec.id);
    if (!defs.length) continue;

    // Скрываем боевые tier-5 строки если все нули (нет оружия)
    const visibleDefs = defs.filter(def => {
      const v = currentStats[def.key] ?? 0;
      const p = previewStats ? (previewStats[def.key] ?? 0) : 0;

      // Для "combat" tier-5 показываем только если есть значение > 0
      const isTier5Combat = [
        "rocket_salvo","rocket_ammo","thermal_dmg","thermal_burn",
        "evade_charges","kinetic_dmg","armor_pierce","sensor_jam","cloak_dur",
      ].includes(def.key);

      if (isTier5Combat && v === 0 && p === 0) return false;
      return true;
    });

    if (!visibleDefs.length) continue;

    html += `<div style="margin-bottom:12px;">
      <div class="equip-stats-section-label">${sec.label}</div>
      <div class="equip-stats-grid">`;

    for (const def of visibleDefs) {
      const cur = currentStats[def.key] ?? 0;
      const pre = previewStats ? (previewStats[def.key] ?? 0) : null;

      const delta    = pre !== null ? pre - cur : 0;
      const hasDelta = pre !== null && Math.abs(delta) > 0.001;
      const good     = def.higherIsBetter ? delta > 0 : delta < 0;
      const cardCls  = hasDelta ? (good ? "has-bonus" : "has-penalty") : "";

      const pct      = Math.min(100, Math.max(0, Math.abs(cur) / (def.refMax || 1) * 100));
      const barColor = cur >= 0 ? "var(--accent)" : "var(--red)";

      const fmt    = def.fmt;
      const curStr = fmt ? fmt(cur) : `${cur}${def.unit}`;

      let deltaStr = "";
      let deltaCls = "neu";

      if (hasDelta) {
        const sign = delta > 0 ? "+" : "";
        const dAbs = Math.abs(delta);
        const dFmt = fmt ? fmt(+dAbs.toFixed(2)) : `${Math.abs(Math.round(delta))}${def.unit}`;
        deltaStr = delta > 0 ? `+${dFmt}` : `−${dFmt}`;
        deltaCls = good ? "pos" : "neg";
      }

      html += `
        <div class="equip-stat-card ${cardCls}">
          <div class="equip-stat-icon-label"><span>${def.icon}</span><span>${def.label}</span></div>
          <div class="equip-stat-value">${curStr}</div>
          <div class="equip-stat-delta ${deltaCls}">${deltaStr || "·"}</div>
          <div class="equip-stat-bar-wrap">
            <div class="equip-stat-bar-fill" style="width:${pct}%;background:${barColor}"></div>
          </div>
        </div>`;
    }
    html += `</div></div>`;
  }

  if (hoverItem && previewStats) {
    html += `<div class="equip-preview-banner">
      👁️ Превью: <strong>${_esc(hoverItem.name)}</strong>
      &nbsp;—&nbsp; <span style="color:var(--green)">зелёный</span> = улучшение,
      <span style="color:var(--red)">красный</span> = ухудшение
    </div>`;
  }

  el.innerHTML = html;
}

// ─── Слоты в модалке ────────────────────────────────────────────────────────
function _renderModalSlots() {
  const el = document.getElementById("equip-modal-slots");
  if (!el) return;

  const onBase = !getExpedition();

  el.innerHTML = `
    <div class="equip-modal-slots-title">🔧 Установленные модули</div>
    <div class="equip-modal-slots-grid">
      ${equippedItems.map((item, i) => {
        if (!item) {
          return `
            <div class="equip-modal-slot empty">
              <div class="equip-modal-slot-num">Слот ${i + 1}</div>
              <div class="equip-modal-slot-empty-text">Пусто<br>
                <span style="font-size:10px;color:var(--muted)">Нажмите на предмет ниже</span>
              </div>
            </div>`;
        }

        const effLines = _buildEffectLines(item).slice(0, 6);

        return `
          <div class="equip-modal-slot filled">
            <div class="equip-modal-slot-num">Слот ${i + 1}</div>
            <span class="artifact-rarity rarity-${item.rarity ?? "common"}" style="font-size:9px;padding:1px 5px;">
              ${_rarityLabel(item.rarity)}
            </span>
            <div class="equip-modal-slot-name">${_esc(item.name)}</div>
            ${item.weight ? `<div style="font-size:10px;color:var(--muted);">⚖️ ${item.weight}т</div>` : ""}

            <div class="equip-modal-slot-effects">
              ${effLines.map(l => `
                <div class="slot-eff-line">
                  <span class="slot-eff-name">${l.label}</span>
                  <span class="slot-eff-val ${l.pos ? "pos" : l.neg ? "neg" : ""}">${l.value}</span>
                </div>`).join("")}
            </div>

            ${item.specialEffect ? `
              <div class="equip-modal-slot-special">
                ✨ ${_esc(item.specialEffect.description ?? item.specialEffect.type)}
              </div>` : ""}

            ${onBase
              ? `<button class="equip-modal-slot-unequip"
                         onclick="window._unequipSlotModal(${i})">✕ Снять</button>`
              : `<div style="font-size:10px;color:var(--muted);margin-top:4px;">⚓ Только на базе</div>`}
          </div>`;
      }).join("")}
    </div>`;
}

// ─── Инвентарь в модалке ────────────────────────────────────────────────────
function _renderModalInventory() {
  const el = document.getElementById("equip-modal-inventory");
  if (!el) return;

  const inventory = getInventory();
  const onBase    = !getExpedition();

  if (!inventory.length) {
    el.innerHTML = `<div class="equip-modal-empty">Инвентарь пуст. Создайте модули в Кузне 🔥</div>`;
    return;
  }

  const equippedIds  = new Set(equippedItems.map(i => i?.id).filter(Boolean));
  const currentStats = _calcAllStats(equippedItems.filter(Boolean));

  el.innerHTML = inventory.map(item => {
    const isEquipped = equippedIds.has(item.id);
    const effLines   = _buildEffectLines(item);
    const deltaLines = isEquipped ? [] : _buildDeltaLines(item, currentStats);

    const hasFreeSlot = equippedItems.some(e => e === null);
    const canEquip    = onBase && !isEquipped && hasFreeSlot;
    const allFull     = onBase && !isEquipped && !hasFreeSlot;

    return `
      <div class="equip-inv-card ${isEquipped ? "is-equipped" : ""}"
           onmouseenter="window._equipHover('${_esc(item.id)}')"
           onmouseleave="window._equipHoverEnd()">
        <div class="equip-inv-card-name">${_esc(item.name)}</div>
        <div class="equip-inv-card-badges">
          <span class="artifact-rarity rarity-${item.rarity ?? "common"}">${_rarityLabel(item.rarity)}</span>
          <span class="${item.original ? "original-badge" : "echo-badge"}">
            ${item.original ? "ОРИГИНАЛ" : "ЭХОКОПИЯ"}
          </span>
          ${isEquipped ? '<span class="equipped-indicator">✓ Надет</span>' : ""}
          ${item.weight ? `<span class="equip-inv-weight">⚖️ ${item.weight}т</span>` : ""}
        </div>
        <div class="equip-inv-card-desc">${_esc(item.description ?? "")}</div>

        <div class="equip-inv-card-effects">
          ${effLines.map(l => `
            <div class="equip-inv-eff-line">
              <span class="inv-eff-name">${l.label}</span>
              <span class="inv-eff-val ${l.pos ? "pos" : l.neg ? "neg" : ""}">${l.value}</span>
            </div>`).join("")}
        </div>

        ${item.specialEffect ? `
          <div class="special-effect-badge" style="margin-top:4px;">
            <span class="se-icon">✨</span>
            <span>${_esc(item.specialEffect.description ?? item.specialEffect.type)}</span>
          </div>` : ""}

        <div class="equip-inv-delta-block">
          ${deltaLines.length
            ? deltaLines.map(d => `
              <div class="delta-line">
                <span class="delta-stat-name">${d.icon} ${d.label}</span>
                <span class="delta-val ${d.cls}">${d.delta}</span>
              </div>`).join("")
            : `<div class="delta-empty-note">
                ${isEquipped ? "Уже экипирован" : "Нет изменений характеристик"}
               </div>`}
        </div>

        <div class="equip-inv-card-actions">
          ${isEquipped
            ? `<button class="btn-equip-modal already-equipped" disabled>✓ Экипирован</button>`
            : !onBase
              ? `<button class="btn-equip-modal" disabled>⚓ Только на базе</button>`
              : canEquip
                ? `<button class="btn-equip-modal" onclick="window._equipFromModal('${_esc(item.id)}')">⚔️ Экипировать</button>`
                : allFull
                  ? `<button class="btn-equip-modal" disabled title="Сначала снимите один из модулей">🔒 Слоты заняты</button>`
                  : `<button class="btn-equip-modal" disabled>⚔️ Экипировать</button>`}
        </div>
      </div>`;
  }).join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// ПОСТРОЕНИЕ СТРОК ЭФФЕКТОВ
// ─────────────────────────────────────────────────────────────────────────────
const EFF_LABELS = {
  // ── Существующие ──────────────────────────────────────────────────────────
  flight_speed_mult:                 { label: "Скор. полёта",       fmt: v => `×${v.toFixed(2)}` },
  return_speed_mult:                 { label: "Скор. возврата",     fmt: v => `×${v.toFixed(2)}` },
  mining_speed_mult:                 { label: "Скор. добычи",       fmt: v => `×${v.toFixed(2)}` },
  mining_yield_mult:                 { label: "Хват/цикл",          fmt: v => `×${v.toFixed(2)}` },
  fuel_efficiency_mult:              { label: "КПД добычи",         fmt: v => `×${v.toFixed(2)}` },
  fuel_flight_efficiency_mult:       { label: "Экон. перелёта",     fmt: v => `×${v.toFixed(2)}` },
  fuel_compress_mult:                { label: "Сжатие топлива",     fmt: v => `×${v.toFixed(2)}` },
  fuel_tank_mult:                    { label: "Ёмкость бака",       fmt: v => `×${v.toFixed(2)}` },
  cargo_capacity_mult:               { label: "Ёмкость трюма",      fmt: v => `×${v.toFixed(2)}` },
  cargo_compact_mult:                { label: "Уплотнение груза",   fmt: v => `×${v.toFixed(2)}` },
  shield_mult:                       { label: "Щит ×",              fmt: v => `×${v.toFixed(2)}` },
  hp_mult:                           { label: "HP ×",               fmt: v => `×${v.toFixed(2)}` },
  penetration_mult:                  { label: "Пробитие ×",         fmt: v => `×${v.toFixed(2)}` },
  guard_stealth_mult:                { label: "Скрытность",         fmt: v => `×${v.toFixed(2)}` },

  fuel_gen_add:                      { label: "Генерация топл.",    fmt: v => `+${v.toFixed(1)} л/ч` },
  fuel_drain_add:                    { label: "Утечки топлива",     fmt: v => `${v.toFixed(1)} л/ч` },
  dodge_chance_add:                  { label: "Уклонение",          fmt: v => `+${v.toFixed(0)}` },
  ore_quality_chance_add:            { label: "Апгрейд руды",       fmt: v => `+${v.toFixed(0)}%` },
  ore_upgrade_share_add:             { label: "Доля апгрейда",      fmt: v => `+${v.toFixed(0)}пп` },
  autopilot_guard_ignore_chance_add: { label: "Обход охраны",       fmt: v => `+${v.toFixed(0)}%` },
  autopilot_cycles_add:              { label: "Автопилот",          fmt: v => `+${Math.floor(v)} цикл.` },

  // ── Боевые tier-5 ─────────────────────────────────────────────────────────
  rocket_salvo_mult:                 { label: "Ракетный залп",      fmt: v => `×${v.toFixed(2)}` },
  rocket_ammo_add:                   { label: "Боезапас ракет",     fmt: v => `+${Math.round(v)}шт.` },
  thermal_damage_mult:               { label: "Тепловой урон",      fmt: v => `×${v.toFixed(2)}` },
  thermal_burn_add:                  { label: "Ожог/сек",           fmt: v => `+${v.toFixed(1)} ед/с` },
  evade_charge_add:                  { label: "Заряды уклон.",      fmt: v => `+${Math.round(v)}шт.` },
  kinetic_damage_mult:               { label: "Кинет. урон",        fmt: v => `×${v.toFixed(2)}` },
  armor_pierce_mult:                 { label: "Пробитие брони",     fmt: v => `×${v.toFixed(2)}` },
  sensor_jam_add:                    { label: "Помехи сенсоров",    fmt: v => `+${v.toFixed(0)}%` },
  cloak_duration_add:                { label: "Маскировка",         fmt: v => `+${Math.round(v)}с` },
};

function _buildEffectLines(item) {
  const lines = [];
  const power = item.original ? 1.0 : (item.echoPower ?? 0.6);
  const effs  = item.effects ?? {};

  for (const [key, rawVal] of Object.entries(effs)) {
    const def = EFF_LABELS[key];
    if (!def) continue;

    const isMult     = key.endsWith("_mult");
    const displayVal = isMult ? rawVal : rawVal * power;
    const str        = def.fmt(displayVal);
    const neg        = isMult ? displayVal < 1 : displayVal < 0;
    const pos        = isMult ? displayVal > 1 : displayVal > 0;

    lines.push({ label: def.label, value: str, pos, neg });
  }
  return lines;
}

function _buildDeltaLines(item, currentStats) {
  const simList  = [...equippedItems.filter(Boolean), item];
  const newStats = _calcAllStats(simList);
  const lines    = [];

  for (const def of SHIP_STAT_DEFS) {
    const cur   = currentStats[def.key] ?? 0;
    const next  = newStats[def.key] ?? 0;
    const delta = next - cur;

    if (Math.abs(delta) < 0.001) continue;

    const good = def.higherIsBetter ? delta > 0 : delta < 0;
    const cls  = good ? "pos" : "neg";
    const sign = delta > 0 ? "+" : "−";
    const fmt  = def.fmt;
    const abs  = Math.abs(delta);
    const dStr = fmt ? `${sign}${fmt(+abs.toFixed(2))}` : `${sign}${Math.round(abs)}${def.unit}`;

    lines.push({ icon: def.icon, label: def.label, delta: dStr, cls });
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// ГЛОБАЛЬНЫЕ ХЭНДЛЕРЫ
// ─────────────────────────────────────────────────────────────────────────────
window._equipFromModal = function(itemId) {
  if (getExpedition()) {
    showToast("⚓ Экипировку можно менять только на базе.", "warning");
    return;
  }
  const item = getInventory().find(i => i.id === itemId);
  if (!item) return;
  if (equippedItems.some(e => e?.id === itemId)) return;

  const freeSlot = equippedItems.findIndex(e => e === null);
  if (freeSlot === -1) {
    showToast("Все 4 слота заняты. Сначала снимите модуль.", "warning");
    return;
  }

  equipItem(item, freeSlot);
  import("./player.js").then(({ renderInventory }) => renderInventory());
};

window._unequipSlotModal = function(slotIndex) {
  if (getExpedition()) {
    showToast("⚓ Снять снаряжение можно только на базе.", "warning");
    return;
  }
  unequipSlot(slotIndex);
  import("./player.js").then(({ renderInventory }) => renderInventory());
};

window._equipHover = function(itemId) {
  _hoverItemId = itemId;
  _renderStatsBar();
};

window._equipHoverEnd = function() {
  _hoverItemId = null;
  _renderStatsBar();
};

window._unequipSlot = function(slotIndex) {
  import("./player.js").then(({ getExpedition: gExp, showToast: st, renderInventory }) => {
    if (gExp()) {
      st("⚓ Снять снаряжение можно только на базе.", "warning");
      return;
    }
    unequipSlot(slotIndex);
    renderInventory();
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// УТИЛИТЫ
// ─────────────────────────────────────────────────────────────────────────────
function _resIcon(key) {
  return {
    isotopes: "☢️",
    minerals: "🪨",
    metals:   "⚙️",
    data:     "💾",
    alloys:   "🔩",   // ← tier-5
  }[key] ?? key;
}

function _esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function _rarityLabel(r) {
  return {
    bad:      "Плохой",
    common:   "Обычный",
    improved: "Улучшенный",
    quality:  "Качественный",
    elite:    "Элитный",
    perfect:  "Совершенный",
  }[r] ?? r ?? "";
}

function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }