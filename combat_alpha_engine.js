// combat_alpha_engine.js — card-combat alpha engine (v10)
// CHANGES v10:
// - chaos action разыгрывается после normal, результат помечается в логе
// - playCard возвращает { normalMsgs, chaosResult } для UI
// - остальное без изменений

import { isActionType, DIRECTIONAL_ACTIONS } from "./actions.js";

export const LIMITS = {
  DIST_MIN: 0,
  DIST_MAX: 1000,
  BOARD_DIST: 0,
  ESCAPE_DIST: 100,
  STEALTH_WIN_MIN: 40,
  STEALTH_WIN_MAX: 95,
  STEALTH_LOCK_REQUIRED: 2,
  SOCIAL_PLEA_WIN: 10,
  SOCIAL_THREAT_WIN: 12,
  MAX_ROUNDS: 40,
};

const BASE_PLAYER = { shield: 20, hull: 60 };

const RARITY_MODULE_HP = {
  bad: 15, common: 20, improved: 28,
  quality: 38, elite: 52, perfect: 70,
};

const ENGINE_FATIGUE_PER_USE = 30;
const ENGINE_FATIGUE_REGEN   = 10;
const ENGINE_FATIGUE_MAX     = 90;

const STEALTH_SCAN_THRESHOLD = 40;
const STEALTH_SCAN_CHANCE    = 0.33;

// ─────────────────────────────────────────────────────────────
// Distance damage multipliers
// ─────────────────────────────────────────────────────────────

export function distDamageMult(actionType, dist) {
  const d = clamp(dist, LIMITS.DIST_MIN, LIMITS.ESCAPE_DIST);
  const t = d / LIMITS.ESCAPE_DIST;

  switch (actionType) {
    case "ATTACK_KINETIC":
      return 1.4 - t * 0.8;

    case "PIERCE":
      return 1.5 - t * 1.0;

    case "FOCUS_FIRE":
      return 1.3 - t * 0.6;

    case "FUEL_IGNITE":
      return 1.4 - t * 1.0;

    case "ATTACK_THERMAL": {
      const peak = 0.40;
      const half = 0.55;
      const dev  = Math.abs(t - peak) / half;
      return Math.max(0.7, 1.0 + 0.4 * Math.max(0, 1 - dev * dev));
    }

    case "ATTACK_SHRAPNEL": {
      const peak = 0.50;
      const half = 0.55;
      const dev  = Math.abs(t - peak) / half;
      return Math.max(0.7, 1.0 + 0.4 * Math.max(0, 1 - dev * dev));
    }

    case "ROCKET_SALVO":
      return 0.5 + t * 1.1;

    case "ATTACK_EMP":
    case "DISRUPT_SENSORS":
    default:
      return 1.0;
  }
}

// ─────────────────────────────────────────────────────────────
// Base damage table
// ─────────────────────────────────────────────────────────────

const ENEMY_BASE_DAMAGE_TABLE = {
  //                    ×0.5  ×1.0  ×1.5  ×2.0  ×2.5  ×3.5
  minor_pirate:         [  4,    7,   10,   14,   19,   28],
  belt_guard:           [  6,   10,   14,   19,   26,   38],
  corp_agent:           [  8,   13,   18,   25,   34,   50],
  pirate_pack:          [ 10,   17,   24,   32,   44,   65],
  berserker:            [ 12,   20,   28,   38,   52,   76],
};

const TIER_SCALE_INDEX = [0.5, 1.0, 1.5, 2.0, 2.5, 3.5];

function baseDamageFromTier(enemyKey, tierScale) {
  const row = ENEMY_BASE_DAMAGE_TABLE[enemyKey] || ENEMY_BASE_DAMAGE_TABLE.minor_pirate;
  const ts  = clamp(Number(tierScale || 1), 0.5, 3.5);

  let lo = 0;
  for (let i = 0; i < TIER_SCALE_INDEX.length - 1; i++) {
    if (ts >= TIER_SCALE_INDEX[i]) lo = i;
  }
  const hi = Math.min(lo + 1, TIER_SCALE_INDEX.length - 1);
  if (lo === hi) return row[lo];

  const t = (ts - TIER_SCALE_INDEX[lo]) / (TIER_SCALE_INDEX[hi] - TIER_SCALE_INDEX[lo]);
  return Math.round(row[lo] + (row[hi] - row[lo]) * t);
}

// ─────────────────────────────────────────────────────────────
// Enemies
// ─────────────────────────────────────────────────────────────

export const ENEMIES = [
  {
    key: "minor_pirate",
    label: "Мелкий пират",
    shield: 20, hull: 55,
    baseDamage: 10,
    moveSpeed: -7, aggression: 0.70,
    modulesCount: 2, moduleHp: 18,
    scanPower: 0.15,
    socialThreshold: 0.40,
    socialTrackMult: { plea: 1.15, threat: 1.05 },
    socialMult: {
      OFFER_BRIBE: 1.5, BROADCAST_PLEA: 0.8, THREATEN_DETONATION: 1.2,
      SIGNAL_BLUFF: 1.3, FAKE_MELTDOWN: 1.1, NEGOTIATE_DELAY: 1.0,
    },
    radio: {
      onAttack:  ["Стой и не рыпайся.", "Ха, шахтёришка!"],
      onHit:     ["Попал, мразь."],
      onMiss:    ["Чёрт, увернулся."],
      onDamaged: ["Сука, это больно!", "Ты за это заплатишь."],
      onBoard:   ["Ну всё, теперь руками."],
      onScan:    ["Куда делся этот ублюдок?", "Сигнал пропал — ищем."],
    },
  },
  {
    key: "belt_guard",
    label: "Охрана пояса",
    shield: 45, hull: 85,
    baseDamage: 14,
    moveSpeed: -5, aggression: 0.78,
    modulesCount: 3, moduleHp: 22,
    scanPower: 0.30,
    socialThreshold: 0.25,
    socialTrackMult: { plea: 1.10, threat: 0.75 },
    socialMult: {
      OFFER_BRIBE: 0.5, BROADCAST_PLEA: 1.5, THREATEN_DETONATION: 0.3,
      SIGNAL_BLUFF: 0.8, FAKE_MELTDOWN: 0.5, NEGOTIATE_DELAY: 1.2,
    },
    radio: {
      onAttack:  ["Нарушитель, лечь в дрейф.", "Досмотр по регламенту."],
      onHit:     ["Предупреждение принято."],
      onMiss:    ["Следующий — по двигателям."],
      onDamaged: ["Огонь в ответ разрешён."],
      onBoard:   ["Шлюз готов. Досмотр."],
      onScan:    ["Активирую сканер зоны.", "Помехи в секторе — проверяю."],
    },
  },
  {
    key: "corp_agent",
    label: "Корпоративный агент",
    shield: 60, hull: 100,
    baseDamage: 18,
    moveSpeed: -4, aggression: 0.62,
    modulesCount: 3, moduleHp: 26,
    scanPower: 0.55,
    socialThreshold: 0.30,
    socialTrackMult: { plea: 0.85, threat: 0.95 },
    socialMult: {
      OFFER_BRIBE: 2.0, BROADCAST_PLEA: 0.3, THREATEN_DETONATION: 0.5,
      SIGNAL_BLUFF: 1.5, FAKE_MELTDOWN: 1.1, NEGOTIATE_DELAY: 0.8,
    },
    radio: {
      onAttack:  ["Зона закрыта. Уберите ведро.", "Корпоративная собственность."],
      onHit:     ["Следующий точнее."],
      onMiss:    ["Манёвренный. Забавно."],
      onDamaged: ["Откуда у шахтёра такие зубы?"],
      onBoard:   ["Инвентаризация актива."],
      onScan:    ["Сенсорный пакет активирован.", "Сигнатура цели восстанавливается."],
    },
  },
  {
    key: "pirate_pack",
    label: "Пиратская стая",
    shield: 80, hull: 120,
    baseDamage: 22,
    moveSpeed: -8, aggression: 0.82,
    modulesCount: 4, moduleHp: 22,
    scanPower: 0.20,
    socialThreshold: 0.35,
    socialTrackMult: { plea: 0.75, threat: 1.25 },
    socialMult: {
      OFFER_BRIBE: 1.2, BROADCAST_PLEA: 0.4, THREATEN_DETONATION: 2.0,
      SIGNAL_BLUFF: 0.8, FAKE_MELTDOWN: 1.4, NEGOTIATE_DELAY: 0.6,
    },
    radio: {
      onAttack:  ["Нас больше. Сдавайся.", "Снимай щит, шахтёр."],
      onHit:     ["Щит не спасёт."],
      onMiss:    ["Петляет. Дай ему по ферме!"],
      onDamaged: ["Ах ты... Огонь всем бортом!"],
      onBoard:   ["Досмотр с монтировкой."],
      onScan:    ["Где эта падаль?", "Рассредоточиться, ищем цель."],
    },
  },
  {
    key: "berserker",
    label: "Берсерк-одиночка",
    shield: 30, hull: 150,
    baseDamage: 30,
    moveSpeed: -12, aggression: 0.95,
    modulesCount: 3, moduleHp: 24,
    scanPower: 0.05,
    socialThreshold: 0.15,
    socialTrackMult: { plea: 0.55, threat: 1.05 },
    socialMult: {
      OFFER_BRIBE: 0.3, BROADCAST_PLEA: 0.2, THREATEN_DETONATION: 1.8,
      SIGNAL_BLUFF: 0.5, FAKE_MELTDOWN: 0.8, NEGOTIATE_DELAY: 0.3,
    },
    radio: {
      onAttack:  ["ААА!!", "УМРИ!"],
      onHit:     ["ДА!"],
      onMiss:    ["СТОЙ!"],
      onDamaged: ["Только злее.", "Это щекотка."],
      onBoard:   ["Ты мой."],
      onScan:    ["ГДЕ?!", "НАЙДУ."],
    },
  },
];

export function createEnemy(key, tierScale = 1.0) {
  const e = ENEMIES.find(x => x.key === key) || ENEMIES[0];
  const s = clamp(Number(tierScale || 1), 0.5, 4.0);

  const modulesCount = Math.max(1, Math.round(e.modulesCount ?? 2));
  const moduleHp     = Math.round((e.moduleHp ?? 18) * s);

  const modules = Array.from({ length: modulesCount }, (_, i) => ({
    id:        `enemy_mod_${i + 1}`,
    name:      `Секция ${i + 1}`,
    hp:        moduleHp,
    maxHp:     moduleHp,
    destroyed: false,
  }));

  return JSON.parse(JSON.stringify({
    ...e,
    shield:     Math.round(e.shield    * s),
    hull:       Math.round(e.hull      * s),
    maxShield:  Math.round(e.shield    * s),
    maxHull:    Math.round(e.hull      * s),
    baseDamage: baseDamageFromTier(key, tierScale),
    burn: 0,
    accuracyDebuffRounds: 0,
    stunned: false,
    modules,
  }));
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function rPick(arr) { return (!Array.isArray(arr) || !arr.length) ? null : arr[Math.floor(Math.random() * arr.length)]; }
function countDestroyed(mods) { return (mods || []).reduce((s, m) => s + (m?.destroyed ? 1 : 0), 0); }

export function stealthThresholdAtDist(dist) {
  const d = clamp(dist, LIMITS.DIST_MIN, LIMITS.ESCAPE_DIST);
  return Math.round(
    LIMITS.STEALTH_WIN_MAX -
    (d / LIMITS.ESCAPE_DIST) * (LIMITS.STEALTH_WIN_MAX - LIMITS.STEALTH_WIN_MIN)
  );
}

function stealthDistBonus(dist) {
  return 1 + clamp(dist / LIMITS.ESCAPE_DIST, 0, 1) * 0.5;
}

function updateStealthLockAndMaybeEscape(state) {
  if (state.over) return true;
  if (state.distance >= LIMITS.ESCAPE_DIST) { state.stealthLock = 0; return false; }

  const needed = stealthThresholdAtDist(state.distance);
  if (state.stealth >= needed) {
    state.stealthLock = Math.min(LIMITS.STEALTH_LOCK_REQUIRED, (state.stealthLock ?? 0) + 1);
  } else {
    state.stealthLock = 0;
  }

  if (state.stealthLock < LIMITS.STEALTH_LOCK_REQUIRED) return false;

  const where =
    state.distance <= 10 ? "прямо под носом у врага" :
    state.distance <= 30 ? "в обломках астероида" :
    state.distance <= 60 ? "среди каменных глыб" :
                           "в пыльном облаке пояса";

  end(state, "win_stealth",
    `👻 Контакт сорван: удержали маскировку ${LIMITS.STEALTH_LOCK_REQUIRED} раунда. ` +
    `Dist=${Math.round(state.distance)}, stealth=${Math.round(state.stealth)}/${needed}. (${where})`
  );
  return true;
}

function applyCloseRangeStealthDecay(state) {
  if (state.distance <= LIMITS.BOARD_DIST + 5) { state.stealth = 0; return; }
  if (state.distance < 20)       state.stealth = clamp(state.stealth - 20, 0, 100);
  else if (state.distance < 40)  state.stealth = clamp(state.stealth - 10, 0, 100);
  else if (state.distance < 70)  state.stealth = clamp(state.stealth - 5,  0, 100);
}

// ─────────────────────────────────────────────────────────────
// Card helpers
// ─────────────────────────────────────────────────────────────

function markCooldown(card) { return { ...card, _cooldown: true }; }
function isCooldown(card)   { return card?._cooldown === true; }

function liveModuleIds(state) {
  return new Set(
    state.player.modules
      .filter(m => !m.destroyed)
      .map(m => m.id)
  );
}

function cardBelongsToLiveModules(card, liveIds) {
  const key = String(card?.origin_key || "");
  if (key.startsWith("SOCIAL_FALLBACK__")) return true;
  if (key.startsWith("COMBO__+__")) {
    const parts = key.split("__+__");
    return liveIds.has(parts[1]) && liveIds.has(parts[2]);
  }
  return liveIds.has(key);
}

// ─────────────────────────────────────────────────────────────
// Effects
// ─────────────────────────────────────────────────────────────

function effPower(item) {
  return item?.original ? 1.0 : clamp(Number(item?.echoPower ?? 0.6), 0, 1);
}
function effMult(raw, power) {
  const m = Number(raw);
  if (!Number.isFinite(m) || m <= 0) return 1;
  return 1 + (m - 1) * clamp(power, 0, 1);
}
function effAdd(raw, power) {
  const a = Number(raw);
  if (!Number.isFinite(a)) return 0;
  return a * clamp(power, 0, 1);
}

const EFFECT_KIND = {
  shield_mult:                 "mult",
  hp_mult:                     "mult",
  fuel_tank_mult:              "mult",
  guard_stealth_mult:          "mult",
  flight_speed_mult:           "mult",
  fuel_flight_efficiency_mult: "mult",
  kinetic_damage_mult:         "mult",
  thermal_damage_mult:         "mult",
  rocket_salvo_mult:           "mult",
  armor_pierce_mult:           "mult",
  thermal_burn_add:            "add",
  rocket_ammo_add:             "add",
  evade_charge_add:            "add",
  sensor_jam_add:              "add",
  cloak_duration_add:          "add",
  dodge_chance_add:            "add",
};

export function mergeEffectsFromItems(items) {
  const merged = {};
  for (const it of (items || [])) {
    const p  = effPower(it);
    const fx = it?.effects || {};
    for (const [k, raw] of Object.entries(fx)) {
      const kind = EFFECT_KIND[k];
      if (!kind) continue;
      if (kind === "mult") merged[k] = (merged[k] ?? 1) * effMult(raw, p);
      else                 merged[k] = (merged[k] ?? 0) + effAdd(raw, p);
    }
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────
// Accuracy
// ─────────────────────────────────────────────────────────────

export function accuracyAtDist(dist, isPlayer) {
  const d = clamp(dist, 0, 100);
  if (d <= 19) return isPlayer ? 0.95 : 0.95;
  if (d <= 49) return isPlayer ? 0.85 : 0.80;
  if (d <= 64) return isPlayer ? 0.65 : 0.65;
  if (d <= 79) return isPlayer ? 0.45 : 0.40;
  return isPlayer ? 0.20 : 0.25;
}

// ─────────────────────────────────────────────────────────────
// SOCIAL
// ─────────────────────────────────────────────────────────────

function enemyHpPct(state) {
  const e = state.enemy;
  return (e.shield + e.hull) / Math.max(1, (e.maxShield + e.maxHull));
}
function playerModsDown(state) { return countDestroyed(state.player?.modules || []); }
function enemyModsDown(state)  { return countDestroyed(state.enemy?.modules  || []); }

function weaponScore(state) {
  const eff = state?.player?._eff || {};
  return Math.max(1, ...[
    Number(eff.kinetic_damage_mult ?? 1),
    Number(eff.thermal_damage_mult ?? 1),
    Number(eff.rocket_salvo_mult   ?? 1),
    Number(eff.armor_pierce_mult   ?? 1),
  ].filter(Number.isFinite));
}

function threatHardwareBonus(state) {
  const det = clamp(Number(state.detonationRisk ?? 0), 0, 100);
  const w   = weaponScore(state);
  return 1 + clamp((w - 1) * 0.55, 0, 1.25) + clamp(det / 100 * 0.35, 0, 0.35);
}

function bluffHardwareBonus(state) {
  const det = clamp(Number(state.detonationRisk ?? 0), 0, 100);
  const w   = weaponScore(state);
  return 1 + clamp((w - 1) * 0.30, 0, 0.70) + clamp(det / 100 * 0.18, 0, 0.18);
}

function pleaScale(state) {
  const pDown   = playerModsDown(state);
  const eDown   = enemyModsDown(state);
  const hullPct = state.player.hull / Math.max(1, state.player.maxHull);
  let s = 1 + 0.35 * pDown - 0.15 * eDown;
  if (hullPct < 0.35) s += 0.25;
  return clamp(s, 0.65, 2.35);
}

function threatScale(state) {
  const pDown = playerModsDown(state);
  const eDown = enemyModsDown(state);
  let s = 1 + 0.35 * eDown - 0.15 * pDown;
  s *= threatHardwareBonus(state);
  return clamp(s, 0.65, 3.25);
}

function desperateMult(state) {
  const hp = enemyHpPct(state);
  const th = Number(state.enemy.socialThreshold ?? 0.3);
  return (hp < th) ? 1.5 : 1.0;
}

export function previewSocialGain(state, actionType, basePts, track) {
  const e      = state.enemy;
  const aMult  = Number(e.socialMult?.[actionType] ?? 1);
  const tMult  = Number(e.socialTrackMult?.[track] ?? 1);
  const scale  = (track === "plea") ? pleaScale(state) : threatScale(state);
  const dMult  = desperateMult(state);
  let raw = basePts * aMult * tMult * scale * dMult;
  if (actionType === "SIGNAL_BLUFF") raw *= bluffHardwareBonus(state);
  return Math.max(0.5, raw);
}

function applySocial(state, actionType, basePts, track, juicyLine = "") {
  if (!state.social) state.social = { plea: 0, threat: 0 };
  const gain = previewSocialGain(state, actionType, basePts, track);
  if (track === "plea") {
    state.social.plea   = Math.min(LIMITS.SOCIAL_PLEA_WIN   * 1.35, state.social.plea   + gain);
    state.social.threat = Math.max(0, state.social.threat - gain * 0.35);
  } else {
    state.social.threat = Math.min(LIMITS.SOCIAL_THREAT_WIN * 1.35, state.social.threat + gain);
    state.social.plea   = Math.max(0, state.social.plea   - gain * 0.30);
  }
  const p = state.social.plea.toFixed(1);
  const t = state.social.threat.toFixed(1);
  return `🗣 ${juicyLine} (+${gain.toFixed(1)} ${track === "plea" ? "plea" : "threat"}) → plea=${p}/${LIMITS.SOCIAL_PLEA_WIN}, threat=${t}/${LIMITS.SOCIAL_THREAT_WIN}`;
}

function applySocialBluffMixed(state, basePts, juicyLine = "") {
  if (!state.social) state.social = { plea: 0, threat: 0 };
  const gainP = previewSocialGain(state, "SIGNAL_BLUFF", basePts * 0.60, "plea");
  const gainT = previewSocialGain(state, "SIGNAL_BLUFF", basePts * 0.40, "threat");
  state.social.plea   = Math.min(LIMITS.SOCIAL_PLEA_WIN   * 1.35, state.social.plea   + gainP);
  state.social.threat = Math.min(LIMITS.SOCIAL_THREAT_WIN * 1.35, state.social.threat + gainT);
  state.social.plea   = Math.max(0, state.social.plea - gainT * 0.10);
  const p = state.social.plea.toFixed(1);
  const t = state.social.threat.toFixed(1);
  return `🗣 ${juicyLine} (+${gainP.toFixed(1)} plea, +${gainT.toFixed(1)} threat) → plea=${p}/${LIMITS.SOCIAL_PLEA_WIN}, threat=${t}/${LIMITS.SOCIAL_THREAT_WIN}`;
}

function checkSocialWin(state) {
  if (!state.social) return false;
  if (state.social.plea >= LIMITS.SOCIAL_PLEA_WIN) {
    end(state, "win_social_plea", "🤲 Они купились на жалость/деньги. Контакт закрыт без выстрела.");
    return true;
  }
  if (state.social.threat >= LIMITS.SOCIAL_THREAT_WIN) {
    end(state, "win_social_threat", "☢️ Они поверили, что ты реально хлопнешь. Контакт закрыт.");
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// Damage model
// ─────────────────────────────────────────────────────────────

function moduleDamageShareAtDist(dist) {
  const d = clamp(dist, 0, 100);
  return clamp(0.35 + (1 - d / 100) * 0.35, 0.35, 0.70);
}

function purgeCardsByModuleId(state, id) {
  const has    = (c) => String(c?.origin_key || "").includes(id);
  const deck0  = state.deck.length;
  const hand0  = state.hand.length;
  const disc0  = state.discard.length;
  state.deck    = state.deck.filter(c => !has(c));
  state.hand    = state.hand.filter(c => !has(c));
  state.discard = state.discard.filter(c => !has(c));
  return (deck0 - state.deck.length) + (hand0 - state.hand.length) + (disc0 - state.discard.length);
}

const SOCIAL_FALLBACK_PAIRS = [
  ["SIGNAL_BLUFF",        "NEGOTIATE_DELAY"],
  ["BROADCAST_PLEA",      "NEGOTIATE_DELAY"],
  ["OFFER_BRIBE",         "NEGOTIATE_DELAY"],
  ["THREATEN_DETONATION", "SIGNAL_BLUFF"],
  ["THREATEN_DETONATION", "NEGOTIATE_DELAY"],
  ["OFFER_BRIBE",         "SIGNAL_BLUFF"],
];

function createFallbackSocialCard(state, reason = "") {
  state._fallbackSeq = (state._fallbackSeq ?? 0) + 1;
  const [a, b] = SOCIAL_FALLBACK_PAIRS[Math.floor(Math.random() * SOCIAL_FALLBACK_PAIRS.length)];
  const m1 = clamp(0.85 + Math.random() * 0.30, 0.6, 1.8);
  const m2 = clamp(0.85 + Math.random() * 0.30, 0.6, 1.8);

  // fallback карты тоже получают chaos-действие
  const chaosTypes = ["NEGOTIATE_DELAY", "BROADCAST_PLEA", "SIGNAL_BLUFF", "OFFER_BRIBE", "DISTANCE_PUSH"];
  const chaosType  = chaosTypes[Math.floor(Math.random() * chaosTypes.length)];
  const chaosMult  = Math.random() < 0.5
    ? Math.round((0.2 + Math.random() * 0.2) * 100) / 100
    : Math.round((1.8 + Math.random() * 0.7) * 100) / 100;

  return {
    origin_key:       `SOCIAL_FALLBACK__${state._fallbackSeq}`,
    card_name:        `Голос вместо железа${reason ? ` / ${reason}` : ""}`,
    lore_description:
      "Секция отвалилась, шины искрят, половина твоих красивых кнопок стала декором. " +
      "Остаётся только эфир: грязный торг, тупой блеф и такая угроза, в которую ты сам почти веришь.",
    chaos_reason: "Бортовой ИИ в панике нажал всё подряд. Одна кнопка оказалась лишней.",
    evidence: ["(fallback) module destroyed", "(fallback) open channel"],
    actions: [
      { type: a, mult: m1, role: "normal" },
      { type: b, mult: m2, role: "normal" },
      { type: chaosType, mult: chaosMult, role: "chaos" },
    ],
  };
}

function addFallbackSocialCards(state, count, reason = "") {
  const n = Math.max(0, Math.floor(count || 0));
  for (let i = 0; i < n; i++) state.deck.unshift(createFallbackSocialCard(state, reason));
}

function onPlayerModuleDestroyed(state, mod, reasonMsg = "") {
  state.log.push({
    round: state.round, who: "system", title: "SYSTEM",
    messages: [`💥 Модуль уничтожен: ${mod.name}${reasonMsg ? ` (${reasonMsg})` : ""}`],
  });
  const removed = purgeCardsByModuleId(state, mod.id);
  addFallbackSocialCards(state, removed, mod.name);
  recomputePlayerCaps(state);
}

function applyDamageToPlayerModules(state, amount, messages) {
  let rem   = Math.max(0, Math.round(amount || 0));
  let dealt = 0;
  while (rem > 0) {
    const alive  = state.player.modules.filter(m => !m.destroyed);
    if (!alive.length) break;
    const target = alive[Math.floor(Math.random() * alive.length)];
    const hit    = Math.min(rem, target.hp);
    target.hp    = Math.max(0, target.hp - hit);
    rem   -= hit;
    dealt += hit;
    if (target.hp <= 0 && !target.destroyed) {
      target.destroyed = true;
      if (messages) messages.push(`⚙️ ${target.name}: −${hit}hp → 0/${target.maxHp} (уничтожен)`);
      onPlayerModuleDestroyed(state, target, "схлопнулся от попадания");
    } else {
      if (messages) messages.push(`⚙️ ${target.name}: −${hit}hp → ${target.hp}/${target.maxHp}`);
    }
  }
  if (state.player.modules.every(m => m.destroyed)) end(state, "lose_modules");
  return dealt;
}

function applyDamageToEnemyModules(state, amount, messages) {
  const e   = state.enemy;
  let rem   = Math.max(0, Math.round(amount || 0));
  let dealt = 0;
  while (rem > 0) {
    const alive  = e.modules.filter(m => !m.destroyed);
    if (!alive.length) break;
    const target = alive[Math.floor(Math.random() * alive.length)];
    const hit    = Math.min(rem, target.hp);
    target.hp    = Math.max(0, target.hp - hit);
    rem   -= hit;
    dealt += hit;
    if (target.hp <= 0 && !target.destroyed) {
      target.destroyed = true;
      if (messages) messages.push(`🔧 Враг теряет систему: ${target.name} (сломана)`);
    }
  }
  return dealt;
}

function applyDamageToPlayer(state, amount) {
  const messages = [];

  if (amount > 0) {
    state.stealth     = 0;
    state.stealthLock = 0;
    messages.push(`🔦 Контакт: скрытность сброшена.`);
  }

  if (state.player.dmgReduction > 0) {
    amount = Math.round(amount * (1 - state.player.dmgReduction));
    state.player.dmgReduction = 0;
  }

  let rem      = Math.max(0, Math.round(amount || 0));
  const original = rem;

  if (rem > 0 && state.player.shield > 0) {
    const s = Math.min(rem, state.player.shield);
    state.player.shield -= s;
    rem -= s;
    messages.push(`🛡️ Щит: −${s} → ${state.player.shield}/${state.player.maxShield}`);
  }

  let hullDealt = 0;
  if (rem > 0) {
    const shareToModules = (state.player.hull <= 0) ? 1.0 : moduleDamageShareAtDist(state.distance);
    let toModules = Math.round(rem * shareToModules);
    let toHull    = rem - toModules;

    if (toHull > 0 && state.player.hull > 0) {
      const h = Math.min(toHull, state.player.hull);
      state.player.hull -= h;
      hullDealt += h;
      toHull    -= h;
      messages.push(`🧱 Корпус: −${h} → ${state.player.hull}/${state.player.maxHull}`);
      if (toHull > 0) toModules += toHull;
    } else if (toHull > 0) {
      toModules += toHull;
    }

    if (hullDealt > 0) {
      recomputePlayerCaps(state);
      const tank = (state.player._eff?.fuel_tank_mult ?? 1);
      state.detonationRisk = clamp(
        state.detonationRisk + (hullDealt / Math.max(1, state.player.maxHull)) * 30 * tank,
        0, 100
      );
    }

    if (toModules > 0) {
      const md = applyDamageToPlayerModules(state, toModules, messages);
      if (md > 0) state.detonationRisk = clamp(state.detonationRisk + md * 0.15, 0, 100);
    }
  }

  return { dealt: original, hullDealt, messages };
}

// ─────────────────────────────────────────────────────────────
// Bribe / economy
// ─────────────────────────────────────────────────────────────

function bribeBaseCostCredits(state) {
  return Math.round(15_000 + (state.enemy.maxShield + state.enemy.maxHull) * 450);
}
function bribeCostCredits(state, mult) {
  const base     = bribeBaseCostCredits(state);
  const attempts = Number(state.economy?.bribeAttempts ?? 0);
  const m        = clamp(Number(mult ?? 1), 0.6, 2.5);
  return Math.round(base * (1 + attempts * 0.35) * (0.85 + 0.25 * m));
}

function applyBribe(state, mult) {
  if (!state.economy) state.economy = {
    credits: 0, cargoUnits: 0, spentCredits: 0, dumpedCargoUnits: 0, bribeAttempts: 0,
  };
  const cost = bribeCostCredits(state, mult);
  state.economy.bribeAttempts = (state.economy.bribeAttempts ?? 0) + 1;

  const haveC     = Math.max(0, Math.round(state.economy.credits    ?? 0));
  const haveCargo = Math.max(0, Math.round(state.economy.cargoUnits ?? 0));

  const paid   = Math.min(cost, haveC);
  state.economy.credits      = haveC - paid;
  state.economy.spentCredits = (state.economy.spentCredits ?? 0) + paid;

  const dumped = haveCargo;
  state.economy.cargoUnits       = 0;
  state.economy.dumpedCargoUnits = (state.economy.dumpedCargoUnits ?? 0) + dumped;

  const payFactor       = clamp(paid / Math.max(1, cost), 0, 1);
  const cargoBonus      = dumped > 0 ? clamp(0.15 + Math.log10(1 + dumped) / 6, 0.15, 0.35) : 0;
  const effectiveFactor = clamp(0.20 + 0.70 * payFactor + cargoBonus, 0.20, 1.15);
  const basePts         = 2.0 * mult * effectiveFactor;

  if (paid > 0 || dumped > 0) {
    state.enemy.aggression = clamp((state.enemy.aggression ?? 0.7) - 0.06 * effectiveFactor, 0.25, 0.98);
  } else {
    state.enemy.aggression = clamp((state.enemy.aggression ?? 0.7) + 0.05, 0.25, 0.98);
  }

  const juicy = dumped > 0
    ? `Подкуп: «Я выгружаю трюм прямо сейчас. Забирай и катись нахрен.»`
    : `Подкуп: «У меня есть деньги. Не честь — зато живёшь.»`;

  const line = applySocial(state, "OFFER_BRIBE", basePts, "plea", juicy);
  return `${line}\n💸 ${paid}/${cost} cr · 🗑️ трюм −${dumped} · агрессия → ${(state.enemy.aggression).toFixed(2)}`;
}

// ─────────────────────────────────────────────────────────────
// State build
// ─────────────────────────────────────────────────────────────

export function buildCombatState({
  equippedItems,
  deckCards,
  enemyKey,
  playerCredits    = 0,
  playerCargoUnits = 0,
  tierScale        = 1.0,
} = {}) {
  const enemy = createEnemy(enemyKey, tierScale);

  const modules = (equippedItems || []).slice(0, 4).map(it => ({
    id:         it.id,
    name:       it.name,
    rarity:     it.rarity || "common",
    recipeType: it.recipeType || null,
    hp:         RARITY_MODULE_HP[it.rarity] ?? 20,
    maxHp:      RARITY_MODULE_HP[it.rarity] ?? 20,
    destroyed:  false,
    _itemRef:   it,
  }));

  const state = {
    round: 0, over: false, result: null,
    distance:      50,
    stealth:        0, stealthLock: 0,
    detonationRisk: 0,
    engineFatigue:  0,
    social:   { plea: 0, threat: 0 },
    economy: {
      credits:          Math.max(0, Math.round(Number(playerCredits    || 0))),
      cargoUnits:       Math.max(0, Math.round(Number(playerCargoUnits || 0))),
      spentCredits:     0,
      dumpedCargoUnits: 0,
      bribeAttempts:    0,
    },
    _fallbackSeq:  0,
    // последний chaos-результат для UI (не часть игровой логики)
    _lastChaos:    null,
    player: {
      shield: 0, maxShield: 0,
      hull:   0, maxHull:   0,
      modules,
      dmgReduction:     0,
      evasionPct:       0,
      fakeMeltdownUsed: false,
      _eff: {},
    },
    enemy,
    deck:    shuffle([...(deckCards || [])]),
    hand:    [], discard: [], log: [],
  };

  recomputePlayerCaps(state);
  state.player.shield = state.player.maxShield;
  state.player.hull   = state.player.maxHull;

  state.log.push({
    round: 0, who: "system", title: "BALANCE",
    messages: [
      `Враг: ${enemyKey} · tier ×${tierScale} → baseDamage = ${state.enemy.baseDamage}`,
      `Игрок HP: щит ${state.player.maxShield} + корпус ${state.player.maxHull} = ${state.player.maxShield + state.player.maxHull}`,
    ],
  });

  drawHand(state);
  return state;
}

function activeModuleItems(state) {
  return state.player.modules.filter(m => !m.destroyed).map(m => m._itemRef);
}

export function recomputePlayerCaps(state) {
  const eff = mergeEffectsFromItems(activeModuleItems(state));
  state.player._eff      = eff;
  state.player.maxShield = Math.max(1, Math.round(BASE_PLAYER.shield * (eff.shield_mult ?? 1)));
  state.player.maxHull   = Math.max(1, Math.round(BASE_PLAYER.hull   * (eff.hp_mult    ?? 1)));
  state.player.shield    = Math.min(state.player.shield, state.player.maxShield);
  state.player.hull      = Math.min(state.player.hull,   state.player.maxHull);
}

// ─────────────────────────────────────────────────────────────
// Deck
// ─────────────────────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function drawHand(state) {
  const live = liveModuleIds(state);
  state.hand = state.hand.filter(c => cardBelongsToLiveModules(c, live));

  while (state.hand.length < 2) {
    if (state.deck.length === 0) {
      state.deck    = shuffle(state.discard.filter(c => cardBelongsToLiveModules(c, live)));
      state.discard = [];
      if (state.deck.length === 0) break;
    }

    let found = false;
    while (state.deck.length > 0) {
      const card = state.deck.shift();

      if (!cardBelongsToLiveModules(card, live)) {
        state.discard.push(card);
        continue;
      }
      if (isCooldown(card)) {
        state.discard.push({ ...card, _cooldown: false });
        continue;
      }

      state.hand.push(card);
      found = true;
      break;
    }
    if (!found) break;
  }
}

// ─────────────────────────────────────────────────────────────
// Play card
// ─────────────────────────────────────────────────────────────

/**
 * Разыгрывает карту.
 * Нормальные действия — сразу.
 * Chaos-действие — сохраняется в state._lastChaos для UI,
 *   разыгрывается движком сразу после normal, но UI показывает его отдельно.
 *
 * @param {object} state
 * @param {number} cardIndex
 * @param {"away"|"toward"|null} direction
 */
export function playCard(state, cardIndex, direction = null) {
  if (state.over) return;
  const card = state.hand[cardIndex];
  if (!card) return;

  // сбрасываем предыдущий chaos
  state._lastChaos = null;

  state.hand.splice(cardIndex, 1);
  const rejected = state.hand.splice(0);
  state.discard.push(...rejected);

  const normalActions = (card.actions || []).filter(a => a.role !== "chaos");
  const chaosAction   = (card.actions || []).find(a => a.role === "chaos");

  const normalMsgs = [];

  // разыгрываем нормальные действия
  for (const a of normalActions) {
    normalMsgs.push(resolvePlayerAction(state, a, direction));
    if (state.over) break;
  }

  // разыгрываем chaos (даже если normal закончил бой — chaos всё равно происходит,
  // но если state.over — пропускаем чтобы не менять финальный результат)
  let chaosMsgText = null;
  if (chaosAction && !state.over) {
    chaosMsgText = resolvePlayerAction(state, chaosAction, null);

    // сохраняем для UI
    state._lastChaos = {
      type:        chaosAction.type,
      mult:        chaosAction.mult,
      result:      chaosMsgText,
      chaos_reason: card.chaos_reason || "",
    };
  }

  state.discard.push(markCooldown(card));

  // в лог: нормальные + chaos отдельной строкой
  const allMsgs = [...normalMsgs.filter(Boolean)];
  if (chaosMsgText) {
    allMsgs.push(`⚡ CHAOS [${chaosAction.type} ×${Number(chaosAction.mult).toFixed(2)}]: ${chaosMsgText}`);
  }

  state.log.push({
    round:    state.round,
    who:      "player",
    title:    card.card_name || card.origin_key,
    messages: allMsgs,
    _hasChaos: !!chaosAction,
  });
}

// ─────────────────────────────────────────────────────────────
// Engine fatigue
// ─────────────────────────────────────────────────────────────

function applyEngineFatigue(state) {
  const fatigue = clamp(state.engineFatigue ?? 0, 0, ENGINE_FATIGUE_MAX);
  const mult    = 1 - fatigue / 100;
  state.engineFatigue = clamp(fatigue + ENGINE_FATIGUE_PER_USE, 0, ENGINE_FATIGUE_MAX);
  return mult;
}

// ─────────────────────────────────────────────────────────────
// Social juice lines
// ─────────────────────────────────────────────────────────────

const SOCIAL_JUICE = {
  OFFER_BRIBE: [
    "Подкуп: «Слушай, без героизма. У меня тут цифры. Берёшь — и исчезаешь.»",
    "Подкуп: «Я плачу, ты молчишь. Сделка уровня никто не умер.»",
    "Подкуп: «Открой рот — и тебе в него насыпят кредитов.»",
  ],
  BROADCAST_PLEA: [
    "Мольба: «Я грузовик, не военный. Не будь сукой, дай уйти.»",
    "Мольба: «Системы горят, люди живые. Отвали, пока ещё можно.»",
    "Мольба: «Пожалуйста — и да, мне самому противно это говорить.»",
  ],
  THREATEN_DETONATION: [
    "Угроза: «Ещё метр — и я рву бак. Мы оба станем красивым облаком.»",
    "Угроза: «Подойди ближе — я нажму кнопку, и тебя будут собирать веником.»",
    "Угроза: «У меня реактор на соплях. Не проверяй, как он хлопает.»",
  ],
  SIGNAL_BLUFF: [
    "Блеф: «Транспондер служебный. Тронешь — тебя запишут как мусор.»",
    "Блеф: «Ты сейчас бьёшь чужого. Подумай, как это звучит в эфире.»",
    "Блеф: «Я не один. Просто остальные пока молчат.»",
  ],
  NEGOTIATE_DELAY: [
    "Тянуть время: «Давай поговорим. Дай мне секунду… две… ещё одну, сука.»",
    "Тянуть время: «Окей-окей. Слушаю. Только не стреляй, я записываю…»",
    "Тянуть время: «У меня связь шумит. Повтори. МЕДЛЕННО.»",
  ],
  FAKE_MELTDOWN: [
    "Ложная авария: «Реактор пошёл в разнос. Если хочешь умереть — подлетай.»",
    "Ложная авария: «У меня утечка и перегрев. Сейчас всё нахрен взлетит.»",
  ],
};

// ─────────────────────────────────────────────────────────────
// Action resolver
// ─────────────────────────────────────────────────────────────

function resolvePlayerAction(state, action, direction = null) {
  const type = String(action?.type || "").trim();
  // chaos mult может выходить за стандартный диапазон
  const mult = clamp(Number(action?.mult ?? 1), 0.1, 3.0);
  if (!isActionType(type)) return `UNKNOWN_ACTION: ${type}`;

  recomputePlayerCaps(state);
  const eff       = state.player._eff || {};
  const accP      = () => accuracyAtDist(state.distance, true);
  const hitRoll   = (acc) => Math.random() <= clamp(acc, 0, 1);
  const speedMult = () => clamp(eff.flight_speed_mult ?? 1, 0.15, 18.0);
  const dir       = direction === "toward" ? "toward" : "away";

  const dmgEnemyMixed = (amount, pierceRatio = 0) => {
    const total  = Math.max(1, Math.round(amount));
    const direct = Math.round(total * clamp(pierceRatio, 0, 1));
    const normal = total - direct;
    if (normal > 0) applyDamageToEnemy(state, normal, false);
    if (direct > 0) applyDamageToEnemy(state, direct, true);
    return total;
  };

  const dmgWithDistMult = (base, actionType, pierceRatio = 0) => {
    const dm     = distDamageMult(actionType, state.distance);
    const amount = base * dm;
    const total  = dmgEnemyMixed(amount, pierceRatio);
    return { total, dm };
  };

  switch (type) {

    // ── OFFENSE ─────────────────────────────────────────────

    case "ATTACK_KINETIC": {
      const base = 9 * mult * (eff.kinetic_damage_mult ?? 1);
      if (!hitRoll(accP())) return "Кинетика: мимо. Только пыль по датчикам.";
      const { total, dm } = dmgWithDistMult(base, type);
      return `Кинетика: ${total} урона (dist×${dm.toFixed(2)}).`;
    }

    case "ATTACK_THERMAL": {
      const base = 7 * mult * (eff.thermal_damage_mult ?? 1);
      if (!hitRoll(accP())) return "Термик: мимо. Греем космос, молодцы.";
      const { total, dm } = dmgWithDistMult(base, type);
      const burnAdd = Math.max(0, (eff.thermal_burn_add ?? 0) + 2.5 * mult);
      state.enemy.burn = Math.min(30, state.enemy.burn + burnAdd);
      return `Термик: ${total} урона (dist×${dm.toFixed(2)}) + burn +${burnAdd.toFixed(1)}.`;
    }

    case "ATTACK_SHRAPNEL": {
      const base = 6 * mult * (eff.rocket_salvo_mult ?? 1);
      const { total, dm } = dmgWithDistMult(base, type);
      return `Шрапнель: ${total} урона (dist×${dm.toFixed(2)}). Сектор залит мусором.`;
    }

    case "ROCKET_SALVO": {
      const base = 14 * mult * (eff.rocket_salvo_mult ?? 1);
      const { total, dm } = dmgWithDistMult(base, type);
      const ammoBonus = Math.floor(eff.rocket_ammo_add ?? 0);
      if (ammoBonus > 0) {
        const { total: bonus } = dmgWithDistMult(base * 0.4 * ammoBonus, type);
        return `Ракетный залп: ${total} урона (dist×${dm.toFixed(2)}) + доп. ${bonus} (ammo).`;
      }
      return `Ракетный залп: ${total} урона (dist×${dm.toFixed(2)}).`;
    }

    case "ATTACK_EMP": {
      state.enemy.accuracyDebuffRounds = Math.max(state.enemy.accuracyDebuffRounds, 2);
      return "ЭМИ: враг слепнет на 2 раунда.";
    }

    case "PIERCE": {
      const base = 6 * mult * (eff.armor_pierce_mult ?? 1);
      if (!hitRoll(accP())) return "Прокол: мимо.";
      const pierceRatio   = clamp(0.40 + ((eff.armor_pierce_mult ?? 1) - 1) * 0.20, 0.40, 0.85);
      const { total, dm } = dmgWithDistMult(base, type, pierceRatio);
      return `Пробитие: ${total} урона (dist×${dm.toFixed(2)}, ${Math.round(pierceRatio * 100)}% в hull).`;
    }

    case "FOCUS_FIRE": {
      const base = 12 * mult * (eff.kinetic_damage_mult ?? 1);
      if (!hitRoll(accP() * 0.9)) return "Фокус: мимо.";
      const { total, dm } = dmgWithDistMult(base, type);
      return `Фокус: ${total} урона (dist×${dm.toFixed(2)}).`;
    }

    case "DISRUPT_SENSORS": {
      state.enemy.accuracyDebuffRounds = Math.max(state.enemy.accuracyDebuffRounds, 2);
      return "Помехи: наведение врага ест дерьмо (2 раунда).";
    }

    case "FUEL_IGNITE": {
      const base = 5 * mult * (eff.thermal_damage_mult ?? 1);
      if (!hitRoll(accP())) return "Поджог: мимо.";
      const { total, dm } = dmgWithDistMult(base, type);
      state.detonationRisk = clamp(state.detonationRisk + 10, 0, 100);
      return `Поджог: ${total} урона (dist×${dm.toFixed(2)}), detonation +10%.`;
    }

    // ── DEFENSE ──────────────────────────────────────────────

    case "SHIELD_REGEN": {
      const add = Math.round(15 * mult * (eff.shield_mult ?? 1));
      state.player.shield = Math.min(state.player.maxShield, state.player.shield + add);
      return `Реген щита: +${add}.`;
    }

    case "SHIELD_SPIKE": {
      const add = Math.round(25 * mult * (eff.shield_mult ?? 1));
      state.player.shield = Math.min(state.player.maxShield + add, state.player.shield + add);
      return `Пик щита: +${add} (временно).`;
    }

    case "HULL_BRACE": {
      state.player.dmgReduction = Math.max(state.player.dmgReduction, 0.5);
      return "Корпус укреплён: следующий урон −50%.";
    }

    case "EMERGENCY_REPAIR": {
      const add = Math.round(10 * mult * (eff.hp_mult ?? 1));
      state.player.hull = Math.min(state.player.maxHull, state.player.hull + add);
      return `Аварийный ремонт: +${add} обшивки.`;
    }

    case "DAMAGE_CONTROL": {
      const add = Math.round(6 * mult * (eff.hp_mult ?? 1));
      state.player.hull = Math.min(state.player.maxHull, state.player.hull + add);
      state.detonationRisk = clamp(state.detonationRisk - 5, 0, 100);
      return `Контроль урона: +${add} обшивки, detonation −5%.`;
    }

    // ── MANEUVER ─────────────────────────────────────────────

    case "DISTANCE_PUSH": {
      const fatMult  = applyEngineFatigue(state);
      const delta    = Math.round(20 * mult * speedMult() * fatMult);
      const fatigue  = Math.round(state.engineFatigue);
      if (dir === "toward") {
        state.distance = clamp(state.distance - delta, LIMITS.DIST_MIN, LIMITS.DIST_MAX);
        return `Манёвр к врагу: −${delta} → dist=${Math.round(state.distance)} · уст.двиг ${fatigue}%`;
      }
      state.distance = clamp(state.distance + delta, LIMITS.DIST_MIN, LIMITS.DIST_MAX);
      return `Манёвр от врага: +${delta} → dist=${Math.round(state.distance)} · уст.двиг ${fatigue}%`;
    }

    case "DISTANCE_PULL": {
      const fatMult  = applyEngineFatigue(state);
      const pull     = Math.round(20 * mult * fatMult);
      state.distance = clamp(state.distance - pull, LIMITS.DIST_MIN, LIMITS.DIST_MAX);
      const fatigue  = Math.round(state.engineFatigue);
      return `Сближение: −${pull} → dist=${Math.round(state.distance)} · уст.двиг ${fatigue}%`;
    }

    case "FULL_BURN": {
      const fatMult    = applyEngineFatigue(state);
      const delta      = Math.round(35 * mult * speedMult() * fatMult);
      const shieldCost = Math.round(5 / Math.max(0.3, speedMult()));
      state.player.shield = Math.max(0, state.player.shield - shieldCost);
      const fatigue = Math.round(state.engineFatigue);
      if (dir === "toward") {
        state.distance = clamp(state.distance - delta, LIMITS.DIST_MIN, LIMITS.DIST_MAX);
        return `Форсаж к врагу: −${delta} → dist=${Math.round(state.distance)} (щит −${shieldCost}) · уст. ${fatigue}%`;
      }
      state.distance = clamp(state.distance + delta, LIMITS.DIST_MIN, LIMITS.DIST_MAX);
      return `Форсаж прочь: +${delta} → dist=${Math.round(state.distance)} (щит −${shieldCost}) · уст. ${fatigue}%`;
    }

    case "DRIFT_SILENT": {
      const stealthMult = clamp(eff.guard_stealth_mult ?? 1, 0.25, 50.0);
      const cloakBonus  = 1 + (eff.cloak_duration_add ?? 0) / 10;
      const distB       = stealthDistBonus(state.distance);
      const distDelta   = Math.round(10 * mult * speedMult());

      if (dir === "toward") {
        const stealthGain = 20 * mult * stealthMult * cloakBonus * distB * 1.3;
        state.stealth   = clamp(state.stealth + stealthGain, 0, 100);
        state.distance  = clamp(state.distance - distDelta, LIMITS.DIST_MIN, LIMITS.DIST_MAX);
        return `Тихий дрейф к врагу: stealth +${stealthGain.toFixed(0)} → ${state.stealth.toFixed(0)} (×1.3, lock заморожен), dist −${distDelta} → ${Math.round(state.distance)}.`;
      }
      const stealthGain = 20 * mult * stealthMult * cloakBonus * distB;
      state.stealth   = clamp(state.stealth + stealthGain, 0, 100);
      state.distance  = clamp(state.distance + distDelta, LIMITS.DIST_MIN, LIMITS.DIST_MAX);
      if (state.distance < LIMITS.ESCAPE_DIST) {
        const need = stealthThresholdAtDist(state.distance);
        return `Тихий дрейф: stealth +${stealthGain.toFixed(0)} → ${state.stealth.toFixed(0)} (нужно ${need}), dist +${distDelta} → ${Math.round(state.distance)}.`;
      }
      return `Тихий дрейф: stealth +${stealthGain.toFixed(0)} → ${state.stealth.toFixed(0)}, dist +${distDelta} → ${Math.round(state.distance)}.`;
    }

    case "EVADE_SPIKE": {
      const e = (15 * mult * speedMult()) +
        (eff.dodge_chance_add  ?? 0) * 0.25 +
        (eff.evade_charge_add  ?? 0) * 3;
      state.player.evasionPct = Math.max(state.player.evasionPct, clamp(e, 0, 85));
      return `Уклон: враг мажет на −${state.player.evasionPct.toFixed(0)}% (1 атака).`;
    }

    // ── TRICKS ───────────────────────────────────────────────

    case "SENSOR_JAM": {
      const s = 25 * mult * (1 + (eff.sensor_jam_add ?? 0) / 50) * stealthDistBonus(state.distance);
      state.stealth = clamp(state.stealth + s, 0, 100);
      state.enemy.accuracyDebuffRounds = Math.max(state.enemy.accuracyDebuffRounds, 1);
      if (state.distance < LIMITS.ESCAPE_DIST) {
        const need = stealthThresholdAtDist(state.distance);
        return `Глушилка: stealth +${s.toFixed(0)} → ${state.stealth.toFixed(0)} (нужно ${need}), враг хуже видит.`;
      }
      return `Глушилка: stealth +${s.toFixed(0)} → ${state.stealth.toFixed(0)}, враг хуже видит.`;
    }

    case "DATA_SPOOF": {
      const s = 15 * mult * stealthDistBonus(state.distance) * 0.9;
      state.stealth = clamp(state.stealth + s, 0, 100);
      return `Спуфинг: stealth +${s.toFixed(0)} → ${state.stealth.toFixed(0)}.`;
    }

    case "FAKE_MELTDOWN": {
      if (state.player.fakeMeltdownUsed) return "Ложная авария: враг уже не верит.";
      state.player.fakeMeltdownUsed = true;
      const juicy   = rPick(SOCIAL_JUICE.FAKE_MELTDOWN) || "Ложная авария.";
      const basePts = 3.5 * mult * (1 + state.detonationRisk / 100);
      state.detonationRisk = clamp(state.detonationRisk + 6, 0, 100);
      return applySocial(state, "FAKE_MELTDOWN", basePts, "threat", juicy) +
        ` · detonation ${Math.round(state.detonationRisk)}%`;
    }

    case "EMP_STUN": {
      state.enemy.stunned = true;
      return "ЭМИ-стан: враг пропускает ход.";
    }

    case "DECOY_DUMP": {
      const s = (15 * mult + (eff.cloak_duration_add ?? 0) * 2) * stealthDistBonus(state.distance);
      state.stealth = clamp(state.stealth + s, 0, 100);
      state.enemy.stunned = true;
      if (state.distance < LIMITS.ESCAPE_DIST) {
        const need = stealthThresholdAtDist(state.distance);
        return `Приманки: stealth +${s.toFixed(0)} → ${state.stealth.toFixed(0)} (нужно ${need}), враг отвлечён.`;
      }
      return `Приманки: stealth +${s.toFixed(0)} → ${state.stealth.toFixed(0)}, враг отвлечён.`;
    }

    // ── SOCIAL ───────────────────────────────────────────────

    case "OFFER_BRIBE":
      return applyBribe(state, mult);

    case "BROADCAST_PLEA": {
      const juicy = rPick(SOCIAL_JUICE.BROADCAST_PLEA) || "Мольба.";
      return applySocial(state, "BROADCAST_PLEA", 1.2 * mult, "plea", juicy);
    }

    case "NEGOTIATE_DELAY": {
      const juicy = rPick(SOCIAL_JUICE.NEGOTIATE_DELAY) || "Тянуть время.";
      state.stealth = clamp(state.stealth + 4, 0, 100);
      return applySocial(state, "NEGOTIATE_DELAY", 1.0 * mult, "plea", juicy) + " · stealth +4";
    }

    case "THREATEN_DETONATION": {
      const juicy   = rPick(SOCIAL_JUICE.THREATEN_DETONATION) || "Угроза подрыва.";
      const basePts = 2.0 * mult * (1 + state.detonationRisk / 100);
      state.detonationRisk = clamp(state.detonationRisk + 5, 0, 100);
      return applySocial(state, "THREATEN_DETONATION", basePts, "threat", juicy) +
        ` · риск ${Math.round(state.detonationRisk)}%`;
    }

    case "SIGNAL_BLUFF": {
      const juicy = rPick(SOCIAL_JUICE.SIGNAL_BLUFF) || "Блеф.";
      return applySocialBluffMixed(state, 1.0 * mult * (1 + state.stealth / 100), juicy);
    }

    // ── DESPERATION (заглушки) ───────────────────────────────

    case "FUEL_BURN":
      return `Сжигаем топливо (×${mult.toFixed(2)}): резервный манёвр.`;

    case "CARGO_JETTISON": {
      const dumped = Math.round(state.economy?.cargoUnits ?? 0);
      if (state.economy) state.economy.cargoUnits = 0;
      return `Сброс груза: −${dumped} ед. трюма. Облегчились.`;
    }

    case "CALL_REINFORCEMENTS":
      return `Вызов подкрепления (×${mult.toFixed(2)}): сигнал ушёл в эфир. Ждём.`;

    default:
      return `[${type}] — пока не реализовано.`;
  }
}

// ─────────────────────────────────────────────────────────────
// Enemy turn
// ─────────────────────────────────────────────────────────────

export function enemyTurn(state) {
  if (state.over) return;
  const e    = state.enemy;
  const msgs = [];

  if (e.burn > 0) {
    const burnDmg = Math.round(e.burn * 0.5);
    e.hull  = Math.max(0, e.hull - burnDmg);
    e.burn  = Math.max(0, e.burn - 1);
    msgs.push(`Burn: враг получает ${burnDmg} урона.`);
  }

  const old      = state.distance;
  const fullMove = e.moveSpeed ?? -6;

  const willScan =
    state.stealth >= STEALTH_SCAN_THRESHOLD &&
    Math.random() < STEALTH_SCAN_CHANCE;

  const actualMove = willScan ? Math.ceil(fullMove / 2) : fullMove;
  state.distance   = clamp(state.distance + actualMove, LIMITS.DIST_MIN, LIMITS.DIST_MAX);
  msgs.push(
    `Враг: ${Math.round(old)} → ${Math.round(state.distance)}` +
    (willScan ? " (полудвиж. — сканирует)" : "") + "."
  );

  applyCloseRangeStealthDecay(state);

  if (state.distance <= LIMITS.BOARD_DIST) {
    msgs.push(`📻 «${pickLine(e.radio?.onBoard)}»`);
    state.log.push({ round: state.round, who: "enemy", title: e.label, messages: msgs });
    end(state, "lose_board");
    return;
  }

  if (willScan) {
    const scanPower   = clamp(e.scanPower ?? 0.15, 0, 1);
    const stealthDrop = Math.round(state.stealth * (0.5 + scanPower * 0.5));
    state.stealth     = Math.max(0, state.stealth - stealthDrop);
    state.stealthLock = 0;
    msgs.push(`🔍 Скан: stealth −${stealthDrop} → ${Math.round(state.stealth)}`);
    msgs.push(`📻 «${pickLine(e.radio?.onScan)}»`);
    state.log.push({ round: state.round, who: "enemy", title: e.label, messages: msgs });
    return;
  }

  if (e.stunned) {
    e.stunned = false;
    msgs.push("Враг оглушён — пропускает атаку.");
    state.log.push({ round: state.round, who: "enemy", title: e.label, messages: msgs });
    return;
  }

  if (Math.random() >= clamp(e.aggression ?? 0.7, 0, 1)) {
    msgs.push("Враг маневрирует.");
    state.log.push({ round: state.round, who: "enemy", title: e.label, messages: msgs });
    return;
  }

  let acc = accuracyAtDist(state.distance, false);
  if (e.accuracyDebuffRounds > 0) { acc *= 0.8; e.accuracyDebuffRounds--; }
  if (state.player.evasionPct > 0) {
    acc *= (1 - clamp(state.player.evasionPct, 0, 85) / 100);
    state.player.evasionPct = 0;
  }

  msgs.push(`📻 «${pickLine(e.radio?.onAttack)}»`);

  if (Math.random() > acc) {
    msgs.push("Враг промахнулся.");
    msgs.push(`📻 «${pickLine(e.radio?.onMiss)}»`);
    state.log.push({ round: state.round, who: "enemy", title: e.label, messages: msgs });
    return;
  }

  const dmg = Math.round((e.baseDamage ?? 12) * (0.85 + Math.random() * 0.3));
  const res  = applyDamageToPlayer(state, dmg);
  msgs.push(`Враг попал: ${res.dealt} урона.`);
  msgs.push(...(res.messages || []));
  msgs.push(`📻 «${pickLine(e.radio?.onHit)}»`);

  if (rollDetonation(state)) {
    msgs.push("Сработала детонация.");
    state.log.push({ round: state.round, who: "enemy", title: e.label, messages: msgs });
    end(state, "lose_detonation");
    return;
  }

  state.log.push({ round: state.round, who: "enemy", title: e.label, messages: msgs });
}

// ─────────────────────────────────────────────────────────────
// Damage to enemy
// ─────────────────────────────────────────────────────────────

function applyDamageToEnemy(state, amount, pierceShield) {
  let rem     = amount;
  let hullHit = 0;

  if (!pierceShield && state.enemy.shield > 0) {
    const s = Math.min(rem, state.enemy.shield);
    state.enemy.shield -= s;
    rem -= s;
  }
  if (rem > 0) {
    const h = Math.min(rem, state.enemy.hull);
    state.enemy.hull = Math.max(0, state.enemy.hull - h);
    rem     -= h;
    hullHit += h;

    const modDmg = Math.round(hullHit * (0.35 + 0.15 * Math.random()));
    if (modDmg > 0) {
      const mMsgs = [];
      applyDamageToEnemyModules(state, modDmg, mMsgs);
      if (mMsgs.length) {
        state.log.push({
          round: state.round, who: "system", title: "ENEMY SYSTEMS",
          messages: mMsgs.slice(0, 3),
        });
      }
    }
  }

  if (state.enemy.hull <= 0) end(state, "win_kill");
  return amount;
}

function rollDetonation(state) {
  const r = clamp(state.detonationRisk, 0, 100);
  if (r <= 0) return false;
  return (Math.random() * 100) < r;
}

// ─────────────────────────────────────────────────────────────
// Round runner
// ─────────────────────────────────────────────────────────────

export function runRound(state, chosenCardIndex, direction = null) {
  if (state.over) return state;

  if (state.round >= LIMITS.MAX_ROUNDS) {
    end(state, "win_flee", "⏱ Вы дожили до окна ухода и оторвались.");
    return state;
  }

  state.round++;

  // сбрасываем chaos перед новым раундом
  state._lastChaos = null;

  playCard(state, chosenCardIndex, direction);
  if (state.over) return state;

  if (state.distance >= LIMITS.ESCAPE_DIST) {
    end(state, "win_flee", "🚀 Вы рванули на дистанцию и вышли из контакта.");
    return state;
  }

  if (checkSocialWin(state)) return state;

  enemyTurn(state);
  if (state.over) return state;

  // регенерация усталости двигателей
  state.engineFatigue = Math.max(0, (state.engineFatigue ?? 0) - ENGINE_FATIGUE_REGEN);

  // затухание скрытности
  if (!state.over) state.stealth = clamp(state.stealth - 10, 0, 100);

  if (!state.over && state.distance >= LIMITS.ESCAPE_DIST) {
    end(state, "win_flee", "🚀 Враг потерял вас на дистанции.");
    return state;
  }
  if (!state.over && checkSocialWin(state)) return state;
  if (!state.over && state.enemy.hull <= 0) { end(state, "win_kill"); return state; }

  updateStealthLockAndMaybeEscape(state);
  if (state.over) return state;

  drawHand(state);
  return state;
}

function end(state, result, extraMsg = null) {
  if (state.over) return;
  state.over   = true;
  state.result = result;

  const msg = {
    win_kill:          "🏆 Победа: враг уничтожен.",
    win_flee:          "🚀 Победа: улетел.",
    win_stealth:       "👻 Победа: спрятался в астероидах.",
    win_social_plea:   "🤲 Победа: выторговал пощаду.",
    win_social_threat: "☢️ Победа: задавил страхом.",
    lose_board:        "⚓ Поражение: абордаж.",
    lose_modules:      "💀 Поражение: все модули выведены из строя.",
    lose_detonation:   "💥 Поражение: детонация.",
  }[result] || result;

  state.log.push({
    round: state.round, who: "system", title: "RESULT",
    messages: [msg].concat(extraMsg ? [extraMsg] : []),
  });
}

function pickLine(arr) {
  if (!Array.isArray(arr) || !arr.length) return "…";
  return arr[Math.floor(Math.random() * arr.length)];
}