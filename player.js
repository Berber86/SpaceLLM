// player.js — состояние игрока, ресурсы, топливо, трюм, кредиты
// v2: мультипликативные эффекты + reserve ресурсов + jettison + НОВЫЕ редкости (6 уровней)
// v2.2: добавлены эффекты для майнинга/охраны/уплотнения/перелёта/утечек
// v2.3: workshop support (склад мастерской)
// v2.4: tier-5 alloys + боевые эффекты (rocket/thermal/kinetic/stealth/maneuvre)

import { loadPlayer, savePlayer, updatePlayer } from "./firebase.js";

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA / WIPE
// ─────────────────────────────────────────────────────────────────────────────
export const PLAYER_SCHEMA_VERSION = 2;
export const ITEM_SCHEMA_VERSION   = 2;

// ─────────────────────────────────────────────────────────────────────────────
// ФИЗИЧЕСКИЕ КОНСТАНТЫ КОРАБЛЯ
// ─────────────────────────────────────────────────────────────────────────────
export const SHIP = {
  baseSpeed:          0.5,
  baseFuelCapacity:   100,
  baseCargoCapacity:  100,
  baseShipMass:       10,
  fuelPerDistPerTon:  0.01,
  fuelPerMiningCycle: 5,
  fuelDensityTonPerL: 0.05,

  startingFuel:        100,
  startingFuelStorage: 0,
  startingCredits:     500000,
};

export const RESOURCE_WEIGHT = {
  isotopes: 0.5,
  minerals: 1.0,
  metals:   2.0,
  data:     4.0,
  alloys:   3.0,   // ← tier-5: тяжелее metals, но легче data (боевые сплавы плотные)
};

const DEFAULT_RESOURCES = { isotopes: 50, minerals: 0, metals: 0, data: 0, alloys: 0 };
const EMPTY_RES_MAP     = { isotopes: 0,  minerals: 0, metals: 0, data: 0, alloys: 0 };

const DEFAULT_PLAYER = {
  schemaVersion: PLAYER_SCHEMA_VERSION,
  name:         "Pilot_0001",
  credits:      SHIP.startingCredits,
  resources:    { ...DEFAULT_RESOURCES },
  fuel:         SHIP.startingFuel,
  fuelStorage:  SHIP.startingFuelStorage,
  inventory:    [],
  workshop:     [],
  expedition:   null,
  cargo:        { ...EMPTY_RES_MAP },
  reservedResources: { ...EMPTY_RES_MAP },
  reservedExpiresAt: 0,
};

let state = null;
let uid   = null;

// ─────────────────────────────────────────────────────────────────────────────
// СТАРТОВЫЙ МОДУЛЬ
// ─────────────────────────────────────────────────────────────────────────────
export const STARTER_AUTOPILOT = {
  schemaVersion: ITEM_SCHEMA_VERSION,
  id:            "starter_autopilot",
  original:      true,
  ownerId:       null,
  ownerName:     null,
  createdAt:     0,
  weight:        1.0,
  foundOn:       null,
  rarity:        "common",
  recipeType:    "autopilot_module",
  specialEffect: null,
  name: "Автопилот УП-3 «Черепаха»",
  description:
    "Учебный автопилот третьего поколения, списанный с флота ещё до твоего рождения. " +
    "Корпус исцарапан, разъёмы окислены, прошивка обновлялась последний раз когда ты ещё пешком под стол ходил. " +
    "Тем не менее — запускается, держит курс, выполняет циклы. " +
    "Три цикла подряд без твоих рук на штурвале. Негусто, но для начала сойдёт.",
  flavor:
    "Достал из ящика с надписью «УТИЛЬ». Подключил.\n" +
    "Оно пикнуло. Я чуть не выронил кофе.\n" +
    "Запустил тест — прошёл. Медленно, с хрипами, но прошёл.\n" +
    "На корпусе чья-то гравировка: «Не трогай реле №4».\n" +
    "Реле №4 я, конечно, потрогал. Всё нормально, кажется.\n" +
    "Буду использовать пока не сломается. Или пока не найду что-то лучше.",
  effects: {
    autopilot_cycles_add: 3,
  },
  stats: {
    "Автоциклы добычи": "+3 цикла",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
export async function initPlayer() {
  uid = localStorage.getItem("player_uid");
  if (!uid) {
    uid = "p_" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("player_uid", uid);
  }

  const saved = await loadPlayer(uid);

  if (!saved || saved.schemaVersion !== PLAYER_SCHEMA_VERSION) {
    state = { ...DEFAULT_PLAYER };
    try { localStorage.removeItem("equipped_slots"); } catch {}
    try { localStorage.removeItem("cleared_asteroids"); } catch {}

    const savedName = localStorage.getItem("pilot_name");
    if (savedName) state.name = savedName;

    await savePlayer(uid, state);
  } else {
    state = {
      ...DEFAULT_PLAYER,
      ...saved,
      // ← alloys: 0 в DEFAULT_RESOURCES гарантирует поле для старых сейвов
      resources: { ...DEFAULT_RESOURCES, ...saved.resources },
      cargo:     { ...EMPTY_RES_MAP,     ...saved.cargo     },
      workshop:  saved.workshop ?? [],
      reservedResources: { ...EMPTY_RES_MAP, ...(saved.reservedResources ?? {}) },
      reservedExpiresAt: saved.reservedExpiresAt ?? 0,
    };
  }

  await cleanupExpiredReservation(true);
  await autoRefuelFromStorage();
  await normalizeFuelOnBase();

  return state;
}

export function getState()       { return state; }
export function getUid()         { return uid; }
export function getCargo()       { return state.cargo; }
export function getExpedition()  { return state.expedition ?? null; }
export function getFuel()        { return state.fuel ?? 0; }
export function getFuelStorage() { return state.fuelStorage ?? 0; }
export function getCredits()     { return state.credits ?? 0; }
export function getInventory() { 
  const all = state?.inventory ?? [];
  const wsIds = new Set((state?.workshop ?? []).map(i => i.id));
  return all.filter(i => !wsIds.has(i.id)); 
}
export function getRawInventory() { return state?.inventory ?? []; } // Для внутренних нужд (если надо)


// ─────────────────────────────────────────────────────────────────────────────
// RESERVATION SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
function nowMs() { return Date.now(); }

function reservedIsEmpty(map) {
  const m = map ?? EMPTY_RES_MAP;
  return Object.values(m).every(v => (v ?? 0) <= 0);
}

async function cleanupExpiredReservation(persistIfCleared = false) {
  if (!state) return false;
  if (!state.reservedExpiresAt) return false;
  if (state.reservedExpiresAt > nowMs()) return false;

  state.reservedResources = { ...EMPTY_RES_MAP };
  state.reservedExpiresAt = 0;

  if (persistIfCleared) {
    await updatePlayer(uid, {
      reservedResources: state.reservedResources,
      reservedExpiresAt: state.reservedExpiresAt,
    });
  }

  renderResources();
  try { if (typeof window._renderForge === "function") window._renderForge(); } catch {}

  return true;
}

function getReservedResources() {
  return state?.reservedResources ?? { ...EMPTY_RES_MAP };
}

function getAvailableResources() {
  const base = state?.resources ?? { ...EMPTY_RES_MAP };
  const resv = getReservedResources();
  const out  = { ...EMPTY_RES_MAP };
  for (const k of Object.keys(out)) {
    out[k] = Math.max(0, (base[k] ?? 0) - (resv[k] ?? 0));
  }
  return out;
}

export function getResources() {
  if (state?.reservedExpiresAt && state.reservedExpiresAt <= nowMs()) {
    state.reservedResources = { ...EMPTY_RES_MAP };
    state.reservedExpiresAt = 0;
  }
  return getAvailableResources();
}

export async function reserveResources(cost, ttlMs = 3  *60*  1000) {
  await cleanupExpiredReservation(true);
  const available = getAvailableResources();

  for (const [k, v] of Object.entries(cost ?? {})) {
    if (v <= 0) continue;
    if ((available[k] ?? 0) < v) return false;
  }

  const resv = getReservedResources();
  for (const [k, v] of Object.entries(cost ?? {})) {
    if (v <= 0) continue;
    resv[k] = (resv[k] ?? 0) + v;
  }

  state.reservedResources = resv;
  state.reservedExpiresAt = nowMs() + Math.max(30_000, ttlMs);

  await updatePlayer(uid, {
    reservedResources: state.reservedResources,
    reservedExpiresAt: state.reservedExpiresAt,
  });

  renderResources();
  try { if (typeof window._renderForge === "function") window._renderForge(); } catch {}
  return true;
}

export async function commitReservedResources(cost) {
  await cleanupExpiredReservation(true);
  const resv = getReservedResources();

  for (const [k, v] of Object.entries(cost ?? {})) {
    if (v <= 0) continue;
    if ((resv[k] ?? 0) < v) return false;
  }

  for (const [k, v] of Object.entries(cost ?? {})) {
    if (v <= 0) continue;
    state.resources[k] = Math.max(0, (state.resources[k] ?? 0) - v);
    resv[k] = Math.max(0, (resv[k] ?? 0) - v);
  }

  state.reservedResources = resv;
  if (reservedIsEmpty(resv)) state.reservedExpiresAt = 0;

  await updatePlayer(uid, {
    resources:         state.resources,
    reservedResources: state.reservedResources,
    reservedExpiresAt: state.reservedExpiresAt,
  });

  renderResources();
  try { if (typeof window._renderForge === "function") window._renderForge(); } catch {}
  return true;
}

export async function releaseReservedResources(cost) {
  await cleanupExpiredReservation(true);
  const resv = getReservedResources();

  for (const [k, v] of Object.entries(cost ?? {})) {
    if (v <= 0) continue;
    resv[k] = Math.max(0, (resv[k] ?? 0) - v);
  }

  state.reservedResources = resv;
  if (reservedIsEmpty(resv)) state.reservedExpiresAt = 0;

  await updatePlayer(uid, {
    reservedResources: state.reservedResources,
    reservedExpiresAt: state.reservedExpiresAt,
  });

  renderResources();
  try { if (typeof window._renderForge === "function") window._renderForge(); } catch {}
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// EFFECTS (multipliers/adds)
// ─────────────────────────────────────────────────────────────────────────────
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function effectiveMult(rawMult, power) {
  const m = Number(rawMult);
  if (!isFinite(m) || m <= 0) return 1;
  const p = clamp(Number(power ?? 1), 0, 1);
  return 1 + (m - 1) * p;
}

function effectiveAdd(rawAdd, power) {
  const a = Number(rawAdd);
  if (!isFinite(a)) return 0;
  const p = clamp(Number(power ?? 1), 0, 1);
  return a * p;
}

function getEquippedFromInventory() {
  try {
    const saved = localStorage.getItem("equipped_slots");
    if (!saved) return [];
    const ids       = JSON.parse(saved);
    const inventory = getInventory();
    return ids
      .filter(Boolean)
      .map(id => inventory.find(i => i.id === id))
      .filter(Boolean);
  } catch { return []; }
}

function getEffectMult(key) {
  let mult = 1;
  for (const item of getEquippedFromInventory()) {
    const power = item.original ? 1.0 : (item.echoPower ?? 0.6);
    const raw   = item.effects?.[key];
    if (raw === undefined) continue;
    mult *= effectiveMult(raw, power);
  }
  return mult;
}

function getEffectAdd(key) {
  let sum = 0;
  for (const item of getEquippedFromInventory()) {
    const power = item.original ? 1.0 : (item.echoPower ?? 0.6);
    const raw   = item.effects?.[key];
    if (raw === undefined) continue;
    sum += effectiveAdd(raw, power);
  }
  return sum;
}

// ─────────────────────────────────────────────────────────────────────────────
// CAPS
// ─────────────────────────────────────────────────────────────────────────────
function capSpeedMult(m)        { return clamp(m, 0.15, 18.0); }
function capCapacityMult(m)     { return clamp(m, 0.25, 100.0); }
function capCompressMult(m)     { return clamp(m, 0.35, 40.0); }
function capEfficiencyMult(m)   { return clamp(m, 0.25, 40.0); }
function capFlightEffMult(m)    { return clamp(m, 0.35, 40.0); }
function capCompactMult(m)      { return clamp(m, 0.35, 40.0); }
function capYieldMult(m)        { return clamp(m, 0.25, 40.0); }
function capGuardStealthMult(m) { return clamp(m, 0.25, 50.0); }

// ── Боевые капы ──────────────────────────────────────────────
function capDamageMult(m)       { return clamp(m, 0.10, 20.0); }
function capPierceMult(m)       { return clamp(m, 0.10, 20.0); }

// ─────────────────────────────────────────────────────────────────────────────
// SHIP derived
// ─────────────────────────────────────────────────────────────────────────────
export function getFuelCapacity() {
  const mult = capCapacityMult(getEffectMult("fuel_tank_mult"));
  return Math.max(Math.round(SHIP.baseFuelCapacity * mult), 50);
}
export function getCargoCapacity() {
  const mult = capCapacityMult(getEffectMult("cargo_capacity_mult"));
  return Math.max(Math.round(SHIP.baseCargoCapacity * mult), 50);
}
export function getFuelMassMultiplier() {
  const compress = capCompressMult(getEffectMult("fuel_compress_mult"));
  return 1 / compress;
}
export function getFuelEfficiencyMultiplier() {
  return capEfficiencyMult(getEffectMult("fuel_efficiency_mult"));
}
export function getFuelFlightEfficiencyMultiplier() {
  return capFlightEffMult(getEffectMult("fuel_flight_efficiency_mult"));
}
export function getCargoCompactMultiplier() {
  return capCompactMult(getEffectMult("cargo_compact_mult"));
}
export function getMiningYieldMultiplier() {
  return capYieldMult(getEffectMult("mining_yield_mult"));
}
export function getGuardStealthMultiplier() {
  return capGuardStealthMult(getEffectMult("guard_stealth_mult"));
}
export function getAutopilotGuardIgnoreChance() {
  return clamp(getEffectAdd("autopilot_guard_ignore_chance_add"), 0, 60);
}

export function getOreUpgradeShare() {
  const base  = 0.10;
  const addPp = Math.max(0, getEffectAdd("ore_upgrade_share_add"));
  return clamp(base + addPp / 100, 0.10, 0.35);
}

// ── Боевые derived (tier-5) ───────────────────────────────────────────────────

/** Множитель ракетного залпа (произведение всех rocket_salvo_mult) */
export function getRocketSalvoMultiplier() {
  return capDamageMult(getEffectMult("rocket_salvo_mult"));
}

/** Суммарный боезапас ракет */
export function getRocketAmmoAdd() {
  return Math.max(0, Math.round(getEffectAdd("rocket_ammo_add")));
}

/** Множитель теплового урона */
export function getThermalDamageMultiplier() {
  return capDamageMult(getEffectMult("thermal_damage_mult"));
}

/** Остаточный ожог (доп. урон в единицах в секунду) */
export function getThermalBurnAdd() {
  return Math.max(0, getEffectAdd("thermal_burn_add"));
}

/** Заряды уклонения (целое) */
export function getEvadeChargeAdd() {
  return Math.max(0, Math.round(getEffectAdd("evade_charge_add")));
}

/** Множитель кинетического урона */
export function getKineticDamageMultiplier() {
  return capDamageMult(getEffectMult("kinetic_damage_mult"));
}

/** Пробитие брони */
export function getArmorPierceMultiplier() {
  return capPierceMult(getEffectMult("armor_pierce_mult"));
}

/** Мощность помех сенсоров (%) */
export function getSensorJamAdd() {
  return clamp(getEffectAdd("sensor_jam_add"), 0, 100);
}

/** Время активной маскировки (секунды) */
export function getCloakDurationAdd() {
  return Math.max(0, Math.round(getEffectAdd("cloak_duration_add")));
}

// ─────────────────────────────────────────────────────────────────────────────
// CARGO MASS
// ─────────────────────────────────────────────────────────────────────────────
export function getCargoMass() {
  const cargo = state.cargo;
  let sum = Object.entries(cargo).reduce((s, [res, amt]) => {
    return s + (amt ?? 0) * (RESOURCE_WEIGHT[res] ?? 1);
  }, 0);

  const compact = getCargoCompactMultiplier();
  sum = sum / Math.max(0.05, compact);

  return sum;
}

export function getCargoUsed() {
  return getCargoMass();
}

export function getTotalShipMass() {
  let mass = SHIP.baseShipMass;
  for (const item of getEquippedFromInventory()) mass += item.weight ?? 0;
  mass += getFuel()  *SHIP.fuelDensityTonPerL*  getFuelMassMultiplier();
  mass += getCargoMass();
  return Math.max(mass, 1);
}

export function calcFuelForFlight(distance, extraCargoMass = 0) {
  const mass = getTotalShipMass() + (Number(extraCargoMass) || 0);
  const base = distance  *mass*  SHIP.fuelPerDistPerTon;
  const eff  = getFuelFlightEfficiencyMultiplier();
  return base / Math.max(0.05, eff);
}

export function calcFuelPerCycle() {
  const eff  = getFuelEfficiencyMultiplier();
  const base = SHIP.fuelPerMiningCycle;
  return Math.max(1, base / eff);
}

export function getFuelGenPerHour() {
  let gen = getEffectAdd("fuel_gen_add");
  gen += getEffectAdd("fuel_drain_add"); // drain хранится отрицательным

  for (const item of getEquippedFromInventory()) {
    const power  = item.original ? 1.0 : (item.echoPower ?? 0.6);
    const effect = item?.specialEffect;
    if (effect?.type === "fuel_bonus") {
      gen += Math.min(Math.max(parseFloat(effect.value) || 0, 0), 20) * power;
    }
  }
  return Math.max(0, gen);
}

// ─────────────────────────────────────────────────────────────────────────────
// SPEED multipliers
// ─────────────────────────────────────────────────────────────────────────────
export function getFlightSpeedMultiplier()  { return capSpeedMult(getEffectMult("flight_speed_mult")); }
export function getReturnSpeedMultiplier()  { return capSpeedMult(getEffectMult("return_speed_mult")); }

export function getMiningSpeedMultiplier() {
  let mult = capSpeedMult(getEffectMult("mining_speed_mult"));
  for (const item of getEquippedFromInventory()) {
    const power  = item.original ? 1.0 : (item.echoPower ?? 0.6);
    const effect = item?.specialEffect;
    if (effect?.type === "mining_bonus") {
      const pct = Math.min(Math.max(parseFloat(effect.value) || 0, 0), 30) * power;
      mult *= (1 + pct / 100);
    }
  }
  return capSpeedMult(mult);
}

export function getFlightSpeedBonus() { return (getFlightSpeedMultiplier() - 1) * 100; }
export function getReturnSpeedBonus() { return (getReturnSpeedMultiplier() - 1) * 100; }
export function getMiningSpeedBonus() { return (getMiningSpeedMultiplier() - 1) * 100; }

export function calcFlightTime(distance, speedMult, shipMass) {
  const m           = Math.max(0.05, Number(speedMult) || 1);
  const massPenalty = Math.min((shipMass - SHIP.baseShipMass) * 0.005, 0.7);
  const effective   = SHIP.baseSpeed  *m*  (1 - massPenalty);
  const speed       = Math.max(effective, SHIP.baseSpeed * 0.05);
  return Math.round(distance / speed);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTOPILOT / SHIELD / AI DRILL
// ─────────────────────────────────────────────────────────────────────────────
export function getAutopilotCycles() {
  let total = 0;
  for (const item of getEquippedFromInventory()) {
    const power = item.original ? 1.0 : (item.echoPower ?? 0.6);
    const raw   = item.effects?.autopilot_cycles_add;
    if (raw === undefined) continue;
    total += Math.floor(effectiveAdd(raw, power));
  }
  return Math.max(0, total);
}

const BASE_REFLECT_POWER = 100;
export function getReflectPower() {
  let bonus = 0;
  for (const item of getEquippedFromInventory()) {
    const power = item.original ? 1.0 : (item.echoPower ?? 0.6);
    const raw   = item.effects?.dodge_chance_add;
    if (raw === undefined) continue;
    bonus += effectiveAdd(raw, power);
  }
  return BASE_REFLECT_POWER + Math.max(0, bonus);
}

export function calcDodgeChance(laserPenetration = 100) {
  const reflect = getReflectPower();
  const pen     = Math.max(1, Number(laserPenetration) || 100);
  const chance  = reflect / (reflect + pen);
  return Math.min(95, Math.round(chance * 100));
}

const BASE_ORE_QUALITY_CHANCE = 10;
const MAX_ORE_QUALITY_CHANCE  = 80;

export function getOreQualityUpgradeChance() {
  let bonus = 0;
  for (const item of getEquippedFromInventory()) {
    const power = item.original ? 1.0 : (item.echoPower ?? 0.6);
    const raw   = item.effects?.ore_quality_chance_add;
    if (raw === undefined) continue;
    bonus += effectiveAdd(raw, power);
  }
  return Math.min(MAX_ORE_QUALITY_CHANCE, BASE_ORE_QUALITY_CHANCE + Math.max(0, bonus));
}

export function getDataModuleStats() {
  return {
    autopilotCycles:     getAutopilotCycles(),
    fuelGenPerHour:      getFuelGenPerHour(),
    reflectPower:        getReflectPower(),
    dodgeChancePct:      calcDodgeChance(100),
    oreQualityChancePct: getOreQualityUpgradeChance(),
  };
}

/** Сводка боевых статов от tier-5 модулей (для combat.js / deck-генератора) */
export function getCombatStats() {
  return {
    rocketSalvoMult:     getRocketSalvoMultiplier(),
    rocketAmmo:          getRocketAmmoAdd(),
    thermalDamageMult:   getThermalDamageMultiplier(),
    thermalBurn:         getThermalBurnAdd(),
    evadeCharges:        getEvadeChargeAdd(),
    kineticDamageMult:   getKineticDamageMultiplier(),
    armorPierceMult:     getArmorPierceMultiplier(),
    sensorJamPct:        getSensorJamAdd(),
    cloakDurationSec:    getCloakDurationAdd(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUEL (tank)
// ─────────────────────────────────────────────────────────────────────────────
function rerenderMiningIfMounted() {
  try { if (typeof window._renderAsteroids === "function") window._renderAsteroids(); } catch {}
}
function rerenderForgeIfMounted() {
  try { if (typeof window._renderForge === "function") window._renderForge(); } catch {}
}

export async function addFuel(amount) {
  state.fuel = Math.min((state.fuel ?? 0) + amount, getFuelCapacity());
  await updatePlayer(uid, { fuel: state.fuel });
  renderFuel();
  rerenderMiningIfMounted();
}

export async function spendFuel(amount) {
  if ((state.fuel ?? 0) < amount - 0.001) return false;
  state.fuel = Math.max(0, (state.fuel ?? 0) - amount);
  await updatePlayer(uid, { fuel: state.fuel });
  renderFuel();
  rerenderMiningIfMounted();
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUEL storage + автозаправка
// ─────────────────────────────────────────────────────────────────────────────
export async function addFuelToStorage(amount) {
  state.fuelStorage = Math.max(0, (state.fuelStorage ?? 0) + amount);
  await updatePlayer(uid, { fuelStorage: state.fuelStorage });
}

export async function autoRefuelFromStorage() {
  if (!state) return 0;
  if (getExpedition()) return 0;

  const capacity = getFuelCapacity();
  const current  = getFuel();
  const need     = Math.max(0, capacity - current);

  const fromStor = Math.min(need, getFuelStorage());
  if (fromStor <= 0) return 0;

  state.fuel        = current + fromStor;
  state.fuelStorage = getFuelStorage() - fromStor;
  await updatePlayer(uid, { fuel: state.fuel, fuelStorage: state.fuelStorage });

  renderFuel();
  rerenderMiningIfMounted();
  return fromStor;
}

export async function normalizeFuelOnBase() {
  if (!state) return;
  if (getExpedition()) return;

  const cap = getFuelCapacity();
  const cur = getFuel();
  if (cur <= cap + 0.001) return;

  const overflow    = cur - cap;
  state.fuel        = cap;
  state.fuelStorage = getFuelStorage() + overflow;

  await updatePlayer(uid, { fuel: state.fuel, fuelStorage: state.fuelStorage });
  renderFuel();
  rerenderMiningIfMounted();
}

export async function receiveFuelFromForge(amount) {
  await addFuelToStorage(amount);
  await autoRefuelFromStorage();
}

const ISOTOPE_TO_FUEL_RATIO = 2;

export async function autoProduceFuelFromIsotopes() {
  if (!state) return null;
  if (getExpedition()) return null;

  const capacity    = getFuelCapacity();
  const currentFuel = getFuel() + getFuelStorage();
  const need        = Math.max(0, capacity - currentFuel);
  if (need <= 0) return null;

  const isotopes = state.resources?.isotopes ?? 0;
  if (isotopes <= 0) return null;

  const isotopeNeeded = Math.ceil(need / ISOTOPE_TO_FUEL_RATIO);
  const isotopeUsed   = Math.min(isotopeNeeded, isotopes);
  const fuelProduced  = isotopeUsed * ISOTOPE_TO_FUEL_RATIO;

  if (fuelProduced <= 0) return null;

  state.resources.isotopes = Math.max(0, isotopes - isotopeUsed);
  state.fuelStorage        = (state.fuelStorage ?? 0) + fuelProduced;

  await updatePlayer(uid, {
    resources:   state.resources,
    fuelStorage: state.fuelStorage,
  });

  renderResources();
  renderFuel();

  return { isotopeUsed, fuelProduced };
}

export async function receiveFuelFromMarket(amount) {
  if (getExpedition()) {
    await addFuelToStorage(amount);
    return { toTank: 0, toStorage: amount };
  }

  const capacity = getFuelCapacity();
  const current  = getFuel();
  const canFit   = Math.max(0, capacity - current);

  const toTank    = Math.min(amount, canFit);
  const toStorage = Math.max(0, amount - toTank);

  if (toTank > 0)    state.fuel        = current + toTank;
  if (toStorage > 0) state.fuelStorage = getFuelStorage() + toStorage;

  await updatePlayer(uid, { fuel: state.fuel, fuelStorage: state.fuelStorage });
  renderFuel();
  rerenderMiningIfMounted();

  return { toTank, toStorage };
}

export async function withdrawFuelForSale(amount) {
  let need = Math.max(0, amount);

  const fromStorage = Math.min(need, getFuelStorage());
  need -= fromStorage;

  const fromTank = Math.min(need, getFuel());
  need -= fromTank;

  const sold = fromStorage + fromTank;
  if (sold <= 0) return 0;

  state.fuelStorage = getFuelStorage() - fromStorage;
  state.fuel        = getFuel() - fromTank;

  await updatePlayer(uid, { fuel: state.fuel, fuelStorage: state.fuelStorage });
  renderFuel();
  rerenderMiningIfMounted();

  return sold;
}

// ─────────────────────────────────────────────────────────────────────────────
// CREDITS
// ─────────────────────────────────────────────────────────────────────────────
export async function addCredits(amount) {
  state.credits = (state.credits ?? 0) + amount;
  await updatePlayer(uid, { credits: state.credits });
  renderCredits();
}
export async function spendCredits(amount) {
  if ((state.credits ?? 0) < amount) return false;
  state.credits = Math.max(0, (state.credits ?? 0) - amount);
  await updatePlayer(uid, { credits: state.credits });
  renderCredits();
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOURCES
// ─────────────────────────────────────────────────────────────────────────────
export async function addResources(delta) {
  for (const [k, v] of Object.entries(delta)) {
    if (k in state.resources)
      state.resources[k] = Math.max(0, (state.resources[k] ?? 0) + v);
  }
  await updatePlayer(uid, { resources: state.resources });
  renderResources();
  rerenderForgeIfMounted();
}

export async function spendResources(cost) {
  await cleanupExpiredReservation(true);
  const available = getAvailableResources();

  for (const [k, v] of Object.entries(cost ?? {})) {
    if (v <= 0) continue;
    if ((available[k] ?? 0) < v) return false;
  }
  for (const [k, v] of Object.entries(cost ?? {})) {
    if (v <= 0) continue;
    state.resources[k] = Math.max(0, (state.resources[k] ?? 0) - v);
  }
  await updatePlayer(uid, { resources: state.resources });
  renderResources();
  rerenderForgeIfMounted();
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// CARGO
// ─────────────────────────────────────────────────────────────────────────────
export async function addToCargo(resource, amount) {
  const capacity = getCargoCapacity();
  const used     = getCargoUsed();
  const weight   = RESOURCE_WEIGHT[resource] ?? 1;

  const canFit   = Math.max(0, Math.floor((capacity - used) / weight));
  const actual   = Math.min(amount, canFit);

  if (actual > 0) {
    state.cargo[resource] = (state.cargo[resource] ?? 0) + actual;
    await updatePlayer(uid, { cargo: state.cargo });
    renderCargo();
  }
  return actual;
}

export function isCargoFull() {
  return getCargoUsed() >= getCargoCapacity() - 0.1;
}

export async function unloadCargo() {
  for (const [res, amt] of Object.entries(state.cargo)) {
    if (amt > 0) state.resources[res] = (state.resources[res] ?? 0) + amt;
  }
  state.cargo = { ...EMPTY_RES_MAP };
  await updatePlayer(uid, { resources: state.resources, cargo: state.cargo });

  renderResources();
  renderCargo();
  rerenderForgeIfMounted();
}

export async function clearCargo() {
  state.cargo = { ...EMPTY_RES_MAP };
  await updatePlayer(uid, { cargo: state.cargo });
  renderCargo();
}

export async function jettisonCargo(resource, amount) {
  if (!state?.cargo || !(resource in state.cargo)) return 0;
  const a    = Math.max(0, Math.floor(amount || 0));
  const have = state.cargo[resource] ?? 0;
  const drop = Math.min(a, have);
  if (drop <= 0) return 0;

  state.cargo[resource] = have - drop;
  await updatePlayer(uid, { cargo: state.cargo });
  renderCargo();
  rerenderMiningIfMounted();
  return drop;
}

export async function jettisonAllCargo() {
  const cargo = state?.cargo ?? {};
  const total = Object.values(cargo).reduce((s, v) => s + (v ?? 0), 0);
  if (total <= 0) return 0;

  state.cargo = { ...EMPTY_RES_MAP };
  await updatePlayer(uid, { cargo: state.cargo });
  renderCargo();
  rerenderMiningIfMounted();
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPEDITION
// ─────────────────────────────────────────────────────────────────────────────
export async function setExpedition(data) {
  state.expedition = data;
  await updatePlayer(uid, { expedition: data });

  if (!data) {
    await autoRefuelFromStorage();
    await normalizeFuelOnBase();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INVENTORY
// ─────────────────────────────────────────────────────────────────────────────
export async function addToInventory(artifact) {
  if (!state.inventory) state.inventory = [];
  state.inventory.push(artifact);
  await updatePlayer(uid, { inventory: state.inventory });
}

export async function removeFromInventory(artifactId) {
  state.inventory = state.inventory.filter(i => i.id !== artifactId);
  await updatePlayer(uid, { inventory: state.inventory });
}

export async function jettisonInventoryItem(itemId) {
  const item = getInventory().find(i => i.id === itemId);
  if (!item) return false;

  try {
    const combat = await import("./combat.js");
    const saved  = localStorage.getItem("equipped_slots");
    if (saved) {
      const ids = JSON.parse(saved);
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] === itemId) combat.unequipSlot(i);
      }
    }
  } catch {}

  await removeFromInventory(itemId);
  renderInventory();
  rerenderMiningIfMounted();
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// NAME
// ─────────────────────────────────────────────────────────────────────────────
export async function setPlayerName(name) {
  state.name = name;
  localStorage.setItem("pilot_name", name);
  await updatePlayer(uid, { name });
}

// ─────────────────────────────────────────────────────────────────────────────
// EQUIP (только на базе)
// ─────────────────────────────────────────────────────────────────────────────
window._equipFromInventory = function(itemId) {
  const exp = getExpedition();
  if (exp) {
    showToast("⚓ Экипировку можно менять только на базе.", "warning");
    return;
  }

  import("./combat.js").then(({ equipItem, equippedItems }) => {
    const item = getInventory().find(i => i.id === itemId);
    if (!item) return;

    if (equippedItems.some(e => e?.id === itemId)) return;

    const freeSlot = equippedItems.findIndex(e => e === null);
    if (freeSlot === -1) {
      showToast("Все 4 слота заняты. Снимите артефакт.", "warning");
      return;
    }

    equipItem(item, freeSlot);
    normalizeFuelOnBase();
    renderInventory();
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// WORKSHOP
// ─────────────────────────────────────────────────────────────────────────────
window._sendToWorkshop = async function(itemId) {
  const exp = getExpedition();
  if (exp) {
    showToast("⚓ Отправка в мастерскую доступна только на базе.", "warning");
    return;
  }
  
  // Проверяем, не надет ли предмет
  const { getEquippedItems } = await import("./combat.js");
  const isEq = getEquippedItems().some(i => i && i.id === itemId);
  if (isEq) {
    showToast("⚠️ Сначала снимите модуль с корабля!", "warning");
    return;
  }

  const { sendToWorkshop } = await import("./workshop.js");
  await sendToWorkshop(itemId);
};

// ─────────────────────────────────────────────────────────────────────────────
// NEWBIE HINT
// ─────────────────────────────────────────────────────────────────────────────
export function checkNewPlayerHint() {
  const r     = state?.resources ?? {};
  const total = Object.values(r).reduce((s, v) => s + v, 0);
  const inv   = getInventory().length;
  const hint  = document.getElementById("newbie-hint");
  if (!hint) return;

  if (total < 20 && inv === 0) {
    hint.classList.remove("hidden");
    hint.innerHTML = `
      <div class="newbie-hint-box">
        🚀 <strong>С чего начать?</strong>
        Отправьтесь на <em>Пояс Альфа</em> — там ждут изотопы.
        <button onclick="
          document.querySelector('[data-tab=mining]').click();
          document.getElementById('newbie-hint').classList.add('hidden');
        " class="btn-hint-go">⛏ Лететь туда →</button>
      </div>
    `;
  } else {
    hint.classList.add("hidden");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UI RENDER
// ─────────────────────────────────────────────────────────────────────────────
export function renderResources() {
  if (!state) return;
  const r = getResources();

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = Math.floor(val ?? 0);
  };

  set("res-isotopes", r.isotopes);
  set("res-minerals", r.minerals);
  set("res-metals",   r.metals);
  set("res-data",     r.data);
  set("res-alloys",   r.alloys);   // ← tier-5
}

export function renderFuel() {
  const fuel     = getFuel();
  const capacity = getFuelCapacity();
  const storage  = getFuelStorage();
  const pct      = Math.min(fuel / capacity * 100, 100);
  const gen      = getFuelGenPerHour();

  const el = document.getElementById("fuel-bar-fill");
  if (el) el.style.width = `${pct}%`;

  const label = document.getElementById("fuel-label");
  if (label) {
    const genStr     = gen > 0 ?  `+${gen.toFixed(1)}/ч` : "";
    const storageStr = storage > 0 ?  `· 🛢️ склад: ${Math.round(storage)}л` : "";
    label.textContent = `⛽ ${Math.round(fuel)}/${Math.round(capacity)}л${genStr}${storageStr}`;
  }
}

export function renderCredits() {
  const el = document.getElementById("res-credits");
  if (el) el.textContent = Math.floor(state.credits ?? 0);
}

export function renderCargo() {
  const el = document.getElementById("cargo-bar");
  if (!el) return;

  const used     = getCargoUsed();
  const capacity = getCargoCapacity();
  const pct      = Math.min(used / capacity * 100, 100);

  const cargo    = state.cargo;
  const cargoLines = Object.entries(cargo)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${resIcon(k)} ${v}`)
    .join("  ");

  el.innerHTML = `
    <div class="cargo-header">
      <span>🗃️ Трюм: ${Math.round(used)}/${Math.round(capacity)}т</span>
      <span class="cargo-contents">${cargoLines || "пусто"}</span>
    </div>
    <div class="cargo-progress-bar">
      <div class="cargo-progress-fill ${pct >= 100 ? "full" : ""}"
           style="width:${pct}%"></div>
    </div>
  `;
}

export function renderInventory() {
  const list = document.getElementById("inventory-list");
  if (!list) return;

  const items  = getInventory();
  const onBase = !getExpedition();

  import("./combat.js").then(({ getEquippedItems }) => {
    const equipped    = getEquippedItems();
    const equippedIds = new Set(equipped.map(i => i?.id).filter(Boolean));

    const cargoManager = !onBase ? `
      <div class="inventory-card" style="grid-column:1/-1">
        <div class="artifact-name">🛰 Управление грузом и сбросом</div>
        <div class="artifact-desc">
          В космосе можно сбрасывать руду из трюма и даже выбрасывать модули.
          Это уменьшает массу и может спасти возврат.
        </div>
        <div class="inv-actions">
          <button class="btn-secondary" onclick="window._dumpAllCargo()">
            🗑️ Сбросить весь трюм
          </button>
        </div>
      </div>
    ` : "";

    if (!items.length) {
      list.innerHTML = cargoManager + '<div class="empty-state">Инвентарь пуст. Создайте артефакт в Кузне.</div>';
      return;
    }

    list.innerHTML = cargoManager + items.map(item => {
      const isEquipped = equippedIds.has(item.id);
      const isChimera  = item.isChimera ?? false;
      const weightStr  = item.weight ?  `· ⚖️ ${item.weight}т` : "";

      const badge = isChimera
        ? `<span class="chimera-badge">ХИМЕРА</span>`
        : `<span class="${item.original ? "original-badge" : "echo-badge"}">
             ${item.original ? "ОРИГИНАЛ" : "ЭХОКОПИЯ"}
           </span>`;

      const rarityBadge = !isChimera
        ? `<span class="artifact-rarity rarity-${item.rarity ?? "common"}">${rarityLabel(item.rarity)}</span>`
        : "";

      return `
        <div class="inventory-card">
          <div class="inv-badges">
            ${badge}
            ${rarityBadge}
            ${isEquipped ? '<span class="equipped-indicator">⚔️ Экипирован</span>' : ""}
          </div>
          <div class="artifact-name">${escHtml(item.name)}</div>
          <div class="artifact-meta-line">${weightStr}</div>
          <div class="artifact-desc">${escHtml(item.description ?? "")}</div>
          ${item.flavor ? `<div class="artifact-flavor">"${escHtml(item.flavor)}"</div>` : ""}

          <div class="artifact-stats">
            ${renderEffectsDisplay(item)}
          </div>

          ${item.specialEffect ? `
            <div class="special-effect-badge">
              <span class="se-icon">✨</span>
              <span>${escHtml(item.specialEffect.description ?? item.specialEffect.type)}</span>
            </div>` : ""}

          <div class="inv-actions">
            ${onBase ? `
              <button class="btn-equip ${isEquipped ? "equipped" : ""}"
                      onclick="window._equipFromInventory('${item.id}')"
                      ${isEquipped ? "disabled" : ""}>
                ${isEquipped ? "✓ Экипировано" : "⚔️ Экипировать"}
              </button>
              <button class="btn-secondary"
                      onclick="window._sendToWorkshop('${item.id}')">
                📦 В мастерскую
              </button>
             `:` 
              <button class="btn-equip" disabled title="В космосе нельзя экипировать/переставлять.">
                ⚓ Только на базе
              </button>
              <button class="btn-disassemble"
                      onclick="window._jettisonItem('${item.id}')">
                🛰 Выбросить в космос
              </button>
            `}
          </div>
        </div>
      `;
    }).join("");
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// JETTISON UI handlers
// ─────────────────────────────────────────────────────────────────────────────
window._dumpCargo = async function(res) {
  const exp = getExpedition();
  if (!exp) { showToast("Сбрасывать груз можно только в экспедиции.", "warning"); return; }

  const el  = document.getElementById(`dump-${res}`);
  const amt = parseInt(el?.value) || 0;
  if (amt <= 0) return;

  if (!confirm(`Сбросить ${amt} единиц ${resLabel(res)} в космос?`)) return;

  const dropped = await jettisonCargo(res, amt);
  if (dropped > 0) showToast(`🛰 Сброшено: ${resIcon(res)} ${dropped}`, "success");
  renderInventory();
};

window._dumpCargoAll = async function(res) {
  const exp = getExpedition();
  if (!exp) { showToast("Сбрасывать груз можно только в экспедиции.", "warning"); return; }

  const have = state?.cargo?.[res] ?? 0;
  if (have <= 0) return;

  if (!confirm(`Сбросить ВЕСЬ ${resLabel(res)} (${have}) в космос?`)) return;

  const dropped = await jettisonCargo(res, have);
  if (dropped > 0) showToast(`🛰 Сброшено: ${resIcon(res)} ${dropped}`, "success");
  renderInventory();
};

window._dumpAllCargo = async function() {
  const exp = getExpedition();
  if (!exp) { showToast("Сбрасывать груз можно только в экспедиции.", "warning"); return; }

  const total = Object.values(state?.cargo ?? {}).reduce((s, v) => s + (v ?? 0), 0);
  if (total <= 0) return;

  if (!confirm("Сбросить ВЕСЬ трюм в космос?")) return;

  await jettisonAllCargo();
  showToast("🛰 Трюм сброшен.", "success");
  renderInventory();
};

window._jettisonItem = async function(itemId) {
  const exp = getExpedition();
  if (!exp) { showToast("Выбрасывать оборудование можно только в экспедиции.", "warning"); return; }

  const item = getInventory().find(i => i.id === itemId);
  if (!item) return;

  if (!confirm(`Выбросить «${item.name}» в космос?\nПредмет будет уничтожен.`)) return;

  const ok = await jettisonInventoryItem(itemId);
  if (ok) showToast("🛰 Предмет выброшен.", "success");
};

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────
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

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─────────────────────────────────────────────────────────────────────────────
// EFFECTS DISPLAY
// ─────────────────────────────────────────────────────────────────────────────
const PERCENT_EFFECTS = new Set([
  "fuel_tank_mult", "cargo_capacity_mult", "flight_speed_mult",
  "return_speed_mult", "mining_speed_mult", "fuel_compress_mult",
  "fuel_efficiency_mult", "shield_mult", "penetration_mult",
  "hp_mult", "mining_yield_mult", "fuel_flight_efficiency_mult",
  "cargo_compact_mult", "guard_stealth_mult",
  "ore_quality_chance_add", "autopilot_guard_ignore_chance_add",
  // ── Боевые ────────────────────────────────────────────────
  "rocket_salvo_mult", "thermal_damage_mult",
  "kinetic_damage_mult", "armor_pierce_mult",
  "sensor_jam_add",
]);

const EFFECT_UNITS = {
  // ── Существующие ──────────────────────────────────────────
  fuel_tank_mult:                     { label: "Объём топливного бака",        unit: "%" },
  cargo_capacity_mult:                { label: "Вместимость трюма",            unit: "%" },
  flight_speed_mult:                  { label: "Скорость полёта",              unit: "%" },
  return_speed_mult:                  { label: "Скорость возврата",            unit: "%" },
  mining_speed_mult:                  { label: "Скорость добычи",              unit: "%" },
  fuel_compress_mult:                 { label: "Сжатие топлива",               unit: "%" },
  fuel_efficiency_mult:               { label: "Экономичность добычи",         unit: "%" },
  fuel_gen_add:                       { label: "Генерация топлива",            unit: "л/ч" },
  shield_mult:                        { label: "Мощность щита",                unit: "%" },
  penetration_mult:                   { label: "Пробитие",                     unit: "%" },
  hp_mult:                            { label: "Прочность корпуса",            unit: "%" },
  mining_yield_mult:                  { label: "Объём хвата за цикл",          unit: "%" },
  fuel_flight_efficiency_mult:        { label: "Экономичность перелёта",       unit: "%" },
  cargo_compact_mult:                 { label: "Уплотнение груза",             unit: "%" },
  guard_stealth_mult:                 { label: "Скрытность от охраны",         unit: "%" },
  ore_upgrade_share_add:              { label: "Доля апгрейда руды",           unit: "п.п." },
  autopilot_guard_ignore_chance_add:  { label: "Обход охраны (автопилот)",     unit: "%" },
  fuel_drain_add:                     { label: "Утечки топлива",               unit: "л/ч" },
  autopilot_cycles_add:               { label: "Автоциклы добычи",             unit: "цикл." },
  dodge_chance_add:                   { label: "Мощность энергощита",          unit: "щит" },
  ore_quality_chance_add:             { label: "Шанс апгрейда руды",           unit: "%" },

  // ── Боевые tier-5 ─────────────────────────────────────────
  rocket_salvo_mult:                  { label: "Мощность ракетного залпа",     unit: "%" },
  rocket_ammo_add:                    { label: "Боезапас ракет",               unit: "шт." },
  thermal_damage_mult:                { label: "Тепловой урон",                unit: "%" },
  thermal_burn_add:                   { label: "Остаточный ожог",              unit: "ед/с" },
  evade_charge_add:                   { label: "Заряды уклонения",             unit: "шт." },
  kinetic_damage_mult:                { label: "Кинетический урон",            unit: "%" },
  armor_pierce_mult:                  { label: "Пробитие брони",               unit: "%" },
  sensor_jam_add:                     { label: "Мощность помех сенсоров",      unit: "%" },
  cloak_duration_add:                 { label: "Время активной маскировки",    unit: "с" },
};

function calcEffectiveValue(rawVal, power, isMult) {
  if (isMult) {
    const m = Number(rawVal);
    if (!isFinite(m) || m <= 0) return 1;
    const p = clamp(Number(power ?? 1), 0, 1);
    return 1 + (m - 1) * p;
  } else {
    const a = Number(rawVal);
    if (!isFinite(a)) return 0;
    return a * clamp(Number(power ?? 1), 0, 1);
  }
}

function formatEffectSymbol(effectKey, effectiveVal) {
  const isPercent = PERCENT_EFFECTS.has(effectKey);
  if (!isPercent) return null;

  let isPenalty, rawPct;

  if (effectKey.endsWith("_mult")) {
    isPenalty = effectiveVal < 1;
    rawPct    = Math.abs((effectiveVal - 1) * 100);
  } else {
    isPenalty = effectiveVal < 0;
    rawPct    = Math.abs(effectiveVal);
  }

  const pct = Math.round(rawPct);

  if (!isPenalty) {
    if (pct <= 10)  return "★";
    if (pct <= 32)  return "★★";
    if (pct <= 65)  return "★★★";
    if (pct <= 99)  return "★★★★";
    if (pct <= 199) return "★★★★★";
    return "🌟";
  } else {
    if (pct <= 9)   return "💩";
    if (pct <= 19)  return "💩💩";
    if (pct <= 29)  return "💩💩💩";
    if (pct <= 49)  return "💩💩💩💩";
    if (pct <= 69)  return "💩💩💩💩💩";
    return "💀";
  }
}

function formatAbsoluteValue(effectKey, effectiveVal) {
  const unit    = EFFECT_UNITS[effectKey]?.unit || "";
  const rounded = (
    effectKey === "autopilot_cycles_add" ||
    effectKey === "rocket_ammo_add"      ||
    effectKey === "evade_charge_add"     ||
    effectKey === "cloak_duration_add"
  )
    ? Math.round(Math.abs(effectiveVal))
    : Math.round(Math.abs(effectiveVal) * 10) / 10;

  const sign = effectiveVal >= 0 ? "+" : "−";
  return `${sign}${rounded} ${unit}`;
}

export function renderEffectsDisplay(item) {
  const effects = item.effects ?? {};
  if (!effects || Object.keys(effects).length === 0) return "";

  const power = item.original ? 1.0 : (item.echoPower ?? 0.6);
  const lines = [];

  for (const [key, rawVal] of Object.entries(effects)) {
    const isMult       = key.endsWith("_mult");
    const effectiveVal = calcEffectiveValue(rawVal, power, isMult);
    const isPercent    = PERCENT_EFFECTS.has(key);

    let displayVal;
    let isNeg = false;

    if (isPercent) {
      const symbol = formatEffectSymbol(key, effectiveVal);
      if (symbol) {
        displayVal = symbol;
        isNeg = isMult ? effectiveVal < 1 : effectiveVal < 0;
      } else {
        const pct = isMult
          ? Math.round((effectiveVal - 1) * 100)
          : Math.round(effectiveVal);
        displayVal = `${pct >= 0 ? "+" : "−"}${Math.abs(pct)}%`;
        isNeg = effectiveVal < 0;
      }
    } else {
      displayVal = formatAbsoluteValue(key, effectiveVal);
      isNeg      = effectiveVal < 0;
    }

    const label = EFFECT_UNITS[key]?.label || key;
    lines.push({ label, value: displayVal, isNeg });
  }

  return lines.map(l => `
    <div class="stat-line">
      <span class="stat-name">${escHtml(l.label)}</span>
      <span class="stat-val ${l.isNeg ? "stat-negative" : ""}">${escHtml(l.value)}</span>
    </div>
  `).join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────────────────────────────
export function showToast(text, type = "info") {
  const notif = document.createElement("div");
  notif.className = "drop-notification";
  notif.style.borderColor =
    type === "warning" ? "var(--red)"
  : type === "success" ? "var(--green)"
  : "var(--accent)";

  notif.innerHTML = `
    <div class="drop-notif-title" style="color:${
      type === "warning" ? "var(--red)"
    : type === "success" ? "var(--green)"
    : "var(--accent2)"}">
      ${escHtml(text)}
    </div>`;

  document.body.appendChild(notif);

  requestAnimationFrame(() => notif.classList.add("drop-notif-visible"));
  setTimeout(() => {
    notif.classList.remove("drop-notif-visible");
    setTimeout(() => notif.remove(), 400);
  }, 4500);
}

// ─────────────────────────────────────────────────────────────────────────────
// DEV-хуки (для deck-генератора и консоли)
// ─────────────────────────────────────────────────────────────────────────────
window.CF_GET_STATE = () => state;
window.CF_GET_ITEM  = (id) => state?.inventory?.find(it => it?.id === id);
Object.defineProperty(window, "CF_STATE", { get: () => state });