// combat.js — бой, слоты экипировки, модалка снаряжения
// v2: фильтр schema + новые редкости
// v3: + tier-5 alloys, боевые эффекты, враги tier5/6

import {
  getInventory, spendResources, getResources, addResources,
  getExpedition, showToast,
} from "./player.js";

// ─────────────────────────────────────────────────────────────────────────────
// ПУЛЫ ВРАГОВ
// ─────────────────────────────────────────────────────────────────────────────

const ENEMY_POOL = {
  tier3: [
    {
      id: "patrol_drone", name: "Патрульный дрон", icon: "🤖",
      flavor: "Устаревшая модель автономной охраны. Медленный, но упрямый.",
      hp: 120, attack: 25, defense: 10, speed: 5,
      reward: { isotopes: 20, metals: 15 },
    },
    {
      id: "pirate_scout", name: "Пиратский разведчик", icon: "☠️",
      flavor: "Одиночка на лёгком корабле. Опасен только для неподготовленных.",
      hp: 90, attack: 35, defense: 5, speed: 12,
      reward: { isotopes: 15, minerals: 20 },
    },
    {
      id: "mining_claim", name: "Клеймовый страж", icon: "⚖️",
      flavor: "Корпоративный охранник. Действует строго по протоколу.",
      hp: 150, attack: 20, defense: 20, speed: 3,
      reward: { minerals: 30, data: 10 },
    },
  ],
  tier4: [
    {
      id: "void_hunter", name: "Охотник Пустоты", icon: "🕳️",
      flavor: "Неизвестного происхождения. Реагирует только на движение добывающего оборудования.",
      hp: 280, attack: 60, defense: 25, speed: 18,
      reward: { isotopes: 80, data: 50 },
    },
    {
      id: "station_guardian", name: "Страж Станции", icon: "🏰",
      flavor: "Тяжёлый боевой модуль. Никогда не отступает.",
      hp: 400, attack: 45, defense: 40, speed: 5,
      reward: { metals: 100, minerals: 60 },
    },
    {
      id: "rogue_ai", name: "Бунтующий ИИ", icon: "👾",
      flavor: "Старая управляющая система шахты. Решила что люди — угроза.",
      hp: 200, attack: 80, defense: 10, speed: 25,
      reward: { data: 100, isotopes: 40 },
    },
  ],
  // ── Tier-5: Кладбище Плат ───────────────────────────────────────────────
  tier5: [
    {
      id: "wraith_gunship", name: "Призрачный канонир", icon: "💀",
      flavor: "Автономный боевой корабль из обломков верфи. Системы повреждены, но орудия работают.",
      hp: 550, attack: 110, defense: 35, speed: 20,
      reward: { alloys: 12, data: 40 },
    },
    {
      id: "salvage_enforcer", name: "Страж Обломков", icon: "🦾",
      flavor: "Тяжёлый охранный дрон, переделанный из промышленного манипулятора. Медленный, но бьёт как таран.",
      hp: 750, attack: 85, defense: 70, speed: 8,
      reward: { alloys: 15, metals: 80 },
    },
    {
      id: "pirate_warlord", name: "Пиратский атаман", icon: "🏴‍☠️",
      flavor: "Прожжённый пират с боевыми сплавами на корпусе и злобой в алгоритмах.",
      hp: 480, attack: 130, defense: 30, speed: 30,
      reward: { alloys: 10, isotopes: 120, minerals: 60 },
    },
  ],
  // ── Tier-6: Чёрная Дуга ─────────────────────────────────────────────────
  tier6: [
    {
      id: "arc_sentinel", name: "Страж Дуги", icon: "🕳️",
      flavor: "Неизвестной постройки. Реагирует на любой сигнал. Цели не регистрирует — просто уничтожает.",
      hp: 1100, attack: 180, defense: 90, speed: 22,
      reward: { alloys: 25, data: 80 },
    },
    {
      id: "ghost_fleet_remnant", name: "Остаток Призрачного Флота", icon: "👻",
      flavor: "Три состыкованных корпуса, управляемых одним сошедшим с ума ИИ. Каждый корпус стреляет отдельно.",
      hp: 900, attack: 220, defense: 50, speed: 40,
      reward: { alloys: 20, data: 100, isotopes: 150 },
    },
    {
      id: "black_arc_titan", name: "Титан Чёрной Дуги", icon: "⚫",
      flavor: "Монстр. Откуда взялся — никто не знает. Уходить не собирается.",
      hp: 1500, attack: 160, defense: 130, speed: 12,
      reward: { alloys: 30, metals: 200, minerals: 150 },
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// УЯЗВИМОСТИ ВРАГОВ
// ─────────────────────────────────────────────────────────────────────────────

const ENEMY_WEAKNESSES = {
  patrol_drone:          "compute",
  pirate_scout:          "penetration",
  mining_claim:          "shield",
  void_hunter:           "energy",
  station_guardian:      "energy",
  rogue_ai:              "compute",
  // ── tier-5 ──────────────────────────────────────────────
  wraith_gunship:        "penetration",
  salvage_enforcer:      "energy",
  pirate_warlord:        "compute",
  // ── tier-6 ──────────────────────────────────────────────
  arc_sentinel:          "compute",
  ghost_fleet_remnant:   "shield",
  black_arc_titan:       "penetration",
};

const WEAKNESS_BONUS = 1.5;

// ─────────────────────────────────────────────────────────────────────────────
// ЗАЧИЩЕННЫЕ АСТЕРОИДЫ
// ─────────────────────────────────────────────────────────────────────────────

const CLEARED_DURATION_MS = 2 * 60 * 60 * 1000;

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
      if (k.includes("вычисл") || k.includes("compute") || k.includes("tflops")) raw.compute     += signed * power;
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
      if (k.includes("вычисл") || k.includes("compute") || k.includes("tflops")) raw.compute     += signed * power;
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
// ВРАГИ
// ─────────────────────────────────────────────────────────────────────────────

export function pickEnemy(asteroidTier) {
  // tier 1-2 — охраны нет, но на всякий случай fallback
  if (asteroidTier <= 2) {
    const pool = ENEMY_POOL.tier3;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  if (asteroidTier === 3) {
    const pool = ENEMY_POOL.tier3;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  if (asteroidTier === 4) {
    const pool = ENEMY_POOL.tier4;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  if (asteroidTier === 5) {
    const pool = ENEMY_POOL.tier5;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  // tier 6+
  const pool = ENEMY_POOL.tier6;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─────────────────────────────────────────────────────────────────────────────
// СИМУЛЯЦИЯ БОЯ
// ─────────────────────────────────────────────────────────────────────────────

function calcDamage(attack, defense, weaknessActive = false) {
  const base   = Math.max(1, attack - defense / 2);
  const spread = base * 0.2;
  const raw    = base + (Math.random() * 2 - 1) * spread;
  return Math.max(1, Math.round(raw * (weaknessActive ? WEAKNESS_BONUS : 1)));
}

export function simulateCombat(playerStats, enemy) {
  let playerHp = playerStats.hp;
  let enemyHp  = enemy.hp;
  const log    = [];
  let round    = 1;

  const weakness       = ENEMY_WEAKNESSES[enemy.id];
  const weaknessActive = !!(weakness && playerStats.weaknessTypes?.includes(weakness));
  const playerFirst    = playerStats.speed >= enemy.speed;

  while (playerHp > 0 && enemyHp > 0 && round <= 30) {
    if (playerFirst) {
      const d1 = calcDamage(playerStats.attack, enemy.defense, weaknessActive);
      enemyHp -= d1;
      log.push({ round, actor: "player", dmg: d1, enemyHp: Math.max(0, enemyHp), critical: weaknessActive });
      if (enemyHp <= 0) break;
      const d2 = calcDamage(enemy.attack, playerStats.defense, false);
      playerHp -= d2;
      log.push({ round, actor: "enemy", dmg: d2, playerHp: Math.max(0, playerHp) });
    } else {
      const d1 = calcDamage(enemy.attack, playerStats.defense, false);
      playerHp -= d1;
      log.push({ round, actor: "enemy", dmg: d1, playerHp: Math.max(0, playerHp) });
      if (playerHp <= 0) break;
      const d2 = calcDamage(playerStats.attack, enemy.defense, weaknessActive);
      enemyHp -= d2;
      log.push({ round, actor: "player", dmg: d2, enemyHp: Math.max(0, enemyHp), critical: weaknessActive });
    }
    round++;
  }

  return {
    victory:       enemyHp <= 0,
    rounds:        round,
    finalPlayerHp: Math.max(0, playerHp),
    finalEnemyHp:  Math.max(0, enemyHp),
    weaknessActive,
    log,
    reward: enemyHp <= 0 ? enemy.reward : null,
  };
}

function estimateWinChance(playerStats, enemy) {
  const weakness       = ENEMY_WEAKNESSES[enemy.id];
  const weaknessActive = !!(weakness && playerStats.weaknessTypes?.includes(weakness));
  const pDps = Math.max(1, (playerStats.attack - enemy.defense  / 2) * (weaknessActive ? WEAKNESS_BONUS : 1));
  const eDps = Math.max(1,  enemy.attack        - playerStats.defense / 2);
  const pTtk = enemy.hp       / pDps;
  const eTtk = playerStats.hp / eDps;
  return Math.round(_clamp(eTtk / (pTtk + eTtk) * 100, 5, 95));
}

// ─────────────────────────────────────────────────────────────────────────────
// ШТРАФ ЗА ПОРАЖЕНИЕ
// ─────────────────────────────────────────────────────────────────────────────

export async function applyDefeatPenalty(ratio = 0.20) {
  const resources = getResources();
  const penalty   = {};
  for (const [k, v] of Object.entries(resources)) penalty[k] = Math.floor(v * ratio);
  await spendResources(penalty);
  return penalty;
}

// ─────────────────────────────────────────────────────────────────────────────
// МОДАЛКА БОЯ
// ─────────────────────────────────────────────────────────────────────────────

export function showCombatModal(enemy, onVictory, onDefeat) {
  const playerStats = getPlayerCombatStats();
  const result      = simulateCombat(playerStats, enemy);
  const winChance   = estimateWinChance(playerStats, enemy);

  const modal   = document.getElementById("modal-combat");
  const content = document.getElementById("combat-content");
  if (!modal || !content) return;

  content.innerHTML = _renderCombatPreview(enemy, playerStats, winChance);
  modal.classList.remove("hidden");

  const btnStart   = document.getElementById("btn-combat-start");
  const btnRetreat = document.getElementById("btn-combat-retreat");
  const btnConfirm = document.getElementById("btn-combat-confirm");

  if (btnConfirm) btnConfirm.classList.add("hidden");
  if (btnStart)   btnStart.classList.remove("hidden");
  if (btnRetreat) btnRetreat.classList.remove("hidden");

  if (btnStart) {
    const newStart = btnStart.cloneNode(true);
    btnStart.parentNode.replaceChild(newStart, btnStart);
    newStart.onclick = async () => {
      newStart.disabled = true;
      if (btnRetreat) btnRetreat.disabled = true;
      await _runCombatAnimation(result, enemy);
      if (result.victory) {
        await addResources(result.reward);
        if (btnConfirm) {
          btnConfirm.textContent = "🎉 Продолжить добычу";
          btnConfirm.classList.remove("hidden");
          btnConfirm.onclick = () => { modal.classList.add("hidden"); onVictory(result); };
        }
      } else {
        const penalty = await applyDefeatPenalty(0.20);
        if (btnConfirm) {
          btnConfirm.textContent = "💀 Отступить";
          btnConfirm.classList.remove("hidden");
          btnConfirm.onclick = () => { modal.classList.add("hidden"); onDefeat(result, penalty); };
        }
      }
      newStart.classList.add("hidden");
      if (btnRetreat) btnRetreat.classList.add("hidden");
    };
  }

  if (btnRetreat) {
    const newRetreat = btnRetreat.cloneNode(true);
    btnRetreat.parentNode.replaceChild(newRetreat, btnRetreat);
    newRetreat.onclick = async () => {
      const penalty = await applyDefeatPenalty(0.10);
      modal.classList.add("hidden");
      onDefeat({ victory: false, retreated: true }, penalty);
    };
  }
}

function _renderCombatPreview(enemy, playerStats, winChance) {
  const chanceClass  = winChance >= 60 ? "good" : winChance >= 40 ? "neutral" : "bad";
  const rewardStr    = Object.entries(enemy.reward).map(([k, v]) => `${_resIcon(k)} +${v}`).join("  ");
  const weakness     = ENEMY_WEAKNESSES[enemy.id];
  const hasAdvantage = !!(weakness && playerStats.weaknessTypes?.includes(weakness));
  const weakLabel    = {
    compute:     "💻 Вычислит. мощность",
    penetration: "⚔️ Пробитие",
    energy:      "⚡ Энергия",
    shield:      "🛡️ Щит",
  }[weakness];

  return `
    <div class="combat-preview">
      <div class="combatant">
        <div class="combatant-icon">🚀</div>
        <div class="combatant-name">Ваш корабль</div>
        <div class="combatant-stats">
          <span>❤️ ${playerStats.hp}</span>
          <span>⚔️ ${playerStats.attack}</span>
          <span>🛡️ ${playerStats.defense}</span>
          <span>⚡ ${playerStats.speed}</span>
        </div>
      </div>
      <div class="combat-vs">
        <div class="vs-text">VS</div>
        <div class="win-chance ${chanceClass}">${winChance}% победы</div>
        ${weakness ? `
          <div class="weakness-hint ${hasAdvantage ? "advantage" : "neutral-hint"}">
            ${hasAdvantage ? `✅ Слабость: ${weakLabel}` : `💡 Слаб к: ${weakLabel}`}
          </div>` : ""}
      </div>
      <div class="combatant">
        <div class="combatant-icon">${enemy.icon}</div>
        <div class="combatant-name">${_esc(enemy.name)}</div>
        <div class="combatant-flavor">${_esc(enemy.flavor)}</div>
        <div class="combatant-stats">
          <span>❤️ ${enemy.hp}</span>
          <span>⚔️ ${enemy.attack}</span>
          <span>🛡️ ${enemy.defense}</span>
          <span>⚡ ${enemy.speed}</span>
        </div>
      </div>
    </div>
    <div class="combat-reward">Награда за победу: ${rewardStr}</div>
    <div id="combat-log" class="combat-log"></div>
  `;
}

async function _runCombatAnimation(result, enemy) {
  const logEl = document.getElementById("combat-log");
  if (!logEl) return;
  logEl.innerHTML = "";
  for (const event of result.log) {
    await _delay(280);
    const line = document.createElement("div");
    line.className = `log-line ${event.actor === "player" ? "log-player" : "log-enemy"}`;
    if (event.actor === "player") {
      line.textContent = `⚔️ Вы: ${event.dmg} урона${event.critical ? " ⚡ СЛАБОСТЬ!" : ""} → враг: ${event.enemyHp} HP`;
      if (event.critical) line.classList.add("log-critical");
    } else {
      line.textContent = `💥 ${enemy.name}: ${event.dmg} урона → вы: ${event.playerHp} HP`;
    }
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }
  await _delay(300);
  const resultLine = document.createElement("div");
  resultLine.className = `log-line log-result ${result.victory ? "log-victory" : "log-defeat"}`;
  resultLine.textContent = result.victory ? "🎉 ПОБЕДА!" : "💀 ПОРАЖЕНИЕ";
  logEl.appendChild(resultLine);
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
          ` : `<div class="equip-slot-empty">Слот ${i + 1}</div>`}
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