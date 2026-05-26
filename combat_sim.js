// combat_sim.js — UI wrapper for alpha combat simulation (v11)
// CHANGES v11:
// - chaos action показывается ПОСЛЕ выбора карты, как вспышка/анимация
// - при нажатии кнопки "Сыграть": сначала рендерим нормальные действия,
//   затем через 600ms показываем chaos-результат из state._lastChaos
// - chaos превью на карте показывает только type и mult (без результата)
// - chaos-флэш рендерится поверх руки как overlay

import { getInventory, showToast, getCredits, getCargo } from "./player.js";
import { isActionType, getActionLabel, DIRECTIONAL_ACTIONS } from "./actions.js";
import {
  buildCombatState,
  runRound,
  ENEMIES,
  LIMITS,
  accuracyAtDist,
  stealthThresholdAtDist,
  previewSocialGain,
  distDamageMult,
} from "./combat_alpha_engine.js";

const CACHE_KEY = "combat_cards_cache_v2";

// ─────────────────────────────────────────────────────────────
// utils
// ─────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function safeJsonParse(str, fallback) {
  try { const v = JSON.parse(str); return (v ?? fallback); } catch { return fallback; }
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function pct01(x) { return `${Math.round(clamp(x, 0, 1) * 100)}%`; }
function bar(val, max, color = "var(--accent)") {
  const pct = clamp(val / Math.max(1, max) * 100, 0, 100);
  return `<div style="height:6px;border-radius:3px;background:rgba(255,255,255,0.08);margin:3px 0 6px;overflow:hidden;">
    <div style="height:100%;width:${pct}%;background:${color};border-radius:3px;transition:width .2s;"></div>
  </div>`;
}

function comboKey(id1, id2) {
  return ["COMBO", ...[id1, id2].sort()].join("__+__");
}

function normalizeCardLite(card) {
  const out = {
    origin_key:       String(card?.origin_key ?? "").trim(),
    card_name:        String(card?.card_name ?? card?.origin_key ?? "CARD").trim(),
    lore_description: String(card?.lore_description ?? "").trim(),
    chaos_reason:     String(card?.chaos_reason ?? "").trim(),
    actions: [],
  };

  const acts = Array.isArray(card?.actions) ? card.actions : [];

  // нормальные (role !== chaos)
  for (const a of acts.filter(x => x?.role !== "chaos").slice(0, 2)) {
    const t = String(a?.type ?? "").trim();
    const m = Number(a?.mult ?? 1);
    if (!isActionType(t)) continue;
    out.actions.push({ type: t, mult: clamp(m, 0.6, 1.8), role: "normal" });
  }
  while (out.actions.filter(a => a.role === "normal").length < 2) {
    out.actions.push({ type: "NEGOTIATE_DELAY", mult: 1.0, role: "normal" });
  }
  if (out.actions[0].type === out.actions[1].type) out.actions[1].type = "DISTANCE_PUSH";

  // chaos
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

function resolveEquippedItemsFromState() {
  const ids = safeJsonParse(localStorage.getItem("equipped_slots"), []);
  const inv  = getInventory();
  return (Array.isArray(ids) ? ids : [])
    .map(id => inv.find(it => it?.id === id))
    .filter(Boolean);
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
    const c = getCargo?.() || {};
    return Object.values(c).reduce((s, v) => s + (Number(v) || 0), 0);
  } catch { return 0; }
}

function getTierScale() {
  return clamp(Number(document.getElementById("combat-sim-tierscale")?.value || 1), 0.5, 4.0);
}

function engineFatigueMult(state) {
  return 1 - clamp(state.engineFatigue ?? 0, 0, 90) / 100;
}

// ─────────────────────────────────────────────────────────────
// Chaos flash overlay
// ─────────────────────────────────────────────────────────────

let _chaosFlashTimeout = null;

function showChaosFlash(chaos) {
  // убираем предыдущий
  clearChaosFlash();

  if (!chaos) return;

  const chaosMult   = Number(chaos.mult);
  const isHigh      = chaosMult >= 1.8;
  const isBad       = chaosMult <= 0.4;
  const color       = isHigh ? "#ff9800" : isBad ? "#ef5350" : "#ce93d8";
  const emoji       = isHigh ? "⚡🔥" : isBad ? "⚡💀" : "⚡";
  const borderColor = isHigh ? "rgba(255,152,0,0.6)" : isBad ? "rgba(239,83,80,0.6)" : "rgba(206,147,216,0.4)";

  // создаём overlay поверх всей модалки
  const overlay = document.createElement("div");
  overlay.id = "combat-chaos-flash";
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    z-index: 99999;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    animation: chaosFlashIn 0.15s ease-out;
  `;

  overlay.innerHTML = `
    <div style="
      background: rgba(10,10,15,0.96);
      border: 2px solid ${borderColor};
      border-radius: 16px;
      padding: 24px 32px;
      max-width: 480px;
      width: 90%;
      text-align: center;
      box-shadow: 0 0 40px ${borderColor}, 0 0 80px rgba(0,0,0,0.8);
      animation: chaosCardIn 0.2s cubic-bezier(0.34,1.56,0.64,1);
    ">
      <div style="font-size: 28px; margin-bottom: 8px;">${emoji}</div>
      <div style="font-size: 13px; font-weight: 900; color: ${color}; letter-spacing: 2px; margin-bottom: 12px;">
        CHAOS СРАБОТАЛ
      </div>
      <div style="font-size: 15px; font-weight: 700; margin-bottom: 6px;">
        ${esc(chaos.type)} ×${chaosMult.toFixed(2)}
      </div>
      <div style="font-size: 13px; opacity: 0.9; margin-bottom: 12px; line-height: 1.4;">
        ${esc(chaos.result)}
      </div>
      ${chaos.chaos_reason ? `
        <div style="
          font-size: 11px;
          color: var(--muted, #888);
          font-style: italic;
          border-top: 1px solid rgba(255,255,255,0.1);
          padding-top: 10px;
          margin-top: 4px;
          line-height: 1.4;
        ">
          «${esc(chaos.chaos_reason)}»
        </div>
      ` : ""}
    </div>
  `;

  document.body.appendChild(overlay);

  // убираем через 2.2 секунды
  _chaosFlashTimeout = setTimeout(() => {
    clearChaosFlash();
  }, 2200);

  // клик убирает досрочно
  overlay.style.pointerEvents = "auto";
  overlay.addEventListener("click", () => clearChaosFlash(), { once: true });
}

function clearChaosFlash() {
  if (_chaosFlashTimeout) {
    clearTimeout(_chaosFlashTimeout);
    _chaosFlashTimeout = null;
  }
  document.getElementById("combat-chaos-flash")?.remove();
}

// ─────────────────────────────────────────────────────────────
// CSS для анимаций chaos
// ─────────────────────────────────────────────────────────────

function injectChaosStyles() {
  if (document.getElementById("chaos-flash-style")) return;
  const st = document.createElement("style");
  st.id = "chaos-flash-style";
  st.textContent = `
    @keyframes chaosFlashIn {
      from { background: rgba(255,100,0,0.15); }
      to   { background: rgba(10,10,15,0.85); }
    }
    @keyframes chaosCardIn {
      from { transform: scale(0.7) rotate(-3deg); opacity: 0; }
      to   { transform: scale(1) rotate(0deg); opacity: 1; }
    }
  `;
  document.head.appendChild(st);
}

// ─────────────────────────────────────────────────────────────
// Action display + preview
// ─────────────────────────────────────────────────────────────

const ACTION_SHORT = {
  ATTACK_KINETIC:      "Кинетический залп",
  ATTACK_THERMAL:      "Термический прожиг",
  ATTACK_SHRAPNEL:     "Шрапнель по сектору",
  ATTACK_EMP:          "ЭМИ-удар",
  PIERCE:              "Бронебойный прокол",
  FOCUS_FIRE:          "Фокус-огонь",
  DISRUPT_SENSORS:     "Срыв сенсоров",
  FUEL_IGNITE:         "Поджог топлива",
  ROCKET_SALVO:        "Ракетный залп",
  SHIELD_REGEN:        "Реген щита",
  SHIELD_SPIKE:        "Пик щита",
  HULL_BRACE:          "Укрепить корпус",
  EMERGENCY_REPAIR:    "Аварийный ремонт",
  DAMAGE_CONTROL:      "Контроль повреждений",
  DISTANCE_PUSH:       "Манёвр (выбор направления)",
  DISTANCE_PULL:       "Сближение",
  FULL_BURN:           "Полный форсаж (выбор направления)",
  DRIFT_SILENT:        "Тихий дрейф (выбор направления)",
  EVADE_SPIKE:         "Резкий уклон",
  SENSOR_JAM:          "Глушилка сенсоров",
  SIGNAL_BLUFF:        "Блеф в эфире",
  DATA_SPOOF:          "Спуфинг меток",
  FAKE_MELTDOWN:       "Ложная авария",
  EMP_STUN:            "ЭМИ-стан",
  DECOY_DUMP:          "Сброс приманок",
  OFFER_BRIBE:         "Подкуп",
  BROADCAST_PLEA:      "Мольба в эфир",
  NEGOTIATE_DELAY:     "Тянуть время",
  THREATEN_DETONATION: "Угроза подрыва",
  FUEL_BURN:           "Сжечь топливо",
  CARGO_JETTISON:      "Сброс груза",
  CALL_REINFORCEMENTS: "Вызов подкрепления",
};

function actionName(type) {
  return ACTION_SHORT[type] || getActionLabel(type) || type;
}

function previewPlayerHitChance(state, actionType) {
  let acc = accuracyAtDist(state.distance, true);
  if (actionType === "FOCUS_FIRE") acc *= 0.9;
  return clamp(acc, 0, 1);
}

function previewEnemyHitChance(state) {
  let acc = accuracyAtDist(state.distance, false);
  if ((state.enemy.accuracyDebuffRounds ?? 0) > 0) acc *= 0.8;
  if ((state.player.evasionPct ?? 0) > 0) acc *= (1 - clamp(state.player.evasionPct, 0, 85) / 100);
  return clamp(acc, 0, 1);
}

function stealthDistBonus(dist) {
  return 1 + clamp(dist / LIMITS.ESCAPE_DIST, 0, 1) * 0.5;
}

function enemyModulesDown(state) {
  return (state?.enemy?.modules || []).reduce((s, m) => s + (m?.destroyed ? 1 : 0), 0);
}

function bribeCostApprox(state, mult) {
  const base = Math.round(15_000 + (state.enemy.maxShield + state.enemy.maxHull) * 450);
  const m    = clamp(Number(mult ?? 1), 0.6, 2.5);
  return Math.round(base * (0.85 + 0.25 * m));
}

function maneuverGivesEscape(state, a, dir) {
  const type      = String(a?.type || "");
  const mult      = clamp(Number(a?.mult ?? 1), 0.6, 2.5);
  const eff       = state?.player?._eff || {};
  const speedMult = clamp(eff.flight_speed_mult ?? 1, 0.15, 18.0);
  const fatMult   = engineFatigueMult(state);

  if (type === "DISTANCE_PUSH") {
    if (dir === "toward") return false;
    return clamp(state.distance + 20 * mult * speedMult * fatMult, LIMITS.DIST_MIN, LIMITS.DIST_MAX) >= LIMITS.ESCAPE_DIST;
  }
  if (type === "FULL_BURN") {
    if (dir === "toward") return false;
    return clamp(state.distance + 35 * mult * speedMult * fatMult, LIMITS.DIST_MIN, LIMITS.DIST_MAX) >= LIMITS.ESCAPE_DIST;
  }
  if (type === "DRIFT_SILENT" && dir !== "toward") {
    const stealthMult = clamp(eff.guard_stealth_mult ?? 1, 0.25, 50.0);
    const cloakBonus  = 1 + (eff.cloak_duration_add ?? 0) / 10;
    const distB       = stealthDistBonus(state.distance);
    const nextS = clamp(state.stealth + 20 * mult * stealthMult * cloakBonus * distB, 0, 100);
    const nextD = clamp(state.distance + 10 * mult * speedMult, LIMITS.DIST_MIN, LIMITS.DIST_MAX);
    if (nextD >= LIMITS.ESCAPE_DIST) return true;
    if ((state.stealthLock ?? 0) >= 1 && nextS >= stealthThresholdAtDist(nextD)) return true;
  }
  return false;
}

function actionGivesEscapeNow(state, a) {
  if (DIRECTIONAL_ACTIONS.has(String(a?.type || ""))) {
    return maneuverGivesEscape(state, a, "away");
  }
  const type = String(a?.type || "");
  const mult = clamp(Number(a?.mult ?? 1), 0.6, 2.5);
  const eff  = state?.player?._eff || {};
  if (["SENSOR_JAM", "DECOY_DUMP", "DATA_SPOOF"].includes(type)) {
    if ((state.stealthLock ?? 0) >= 1 && state.distance < LIMITS.ESCAPE_DIST) {
      const s =
        type === "SENSOR_JAM"
          ? 25 * mult * (1 + (eff.sensor_jam_add ?? 0) / 50) * stealthDistBonus(state.distance)
          : type === "DECOY_DUMP"
          ? (15 * mult + (eff.cloak_duration_add ?? 0) * 2) * stealthDistBonus(state.distance)
          : 15 * mult * stealthDistBonus(state.distance) * 0.9;
      if (clamp(state.stealth + s, 0, 100) >= stealthThresholdAtDist(state.distance)) return true;
    }
  }
  return false;
}

function previewSocialLine(state, type, mult) {
  const baseByType = {
    OFFER_BRIBE:         () => 2.0 * mult,
    BROADCAST_PLEA:      () => 1.2 * mult,
    NEGOTIATE_DELAY:     () => 1.0 * mult,
    THREATEN_DETONATION: () => 2.0 * mult * (1 + (state.detonationRisk ?? 0) / 100),
    FAKE_MELTDOWN:       () => 3.5 * mult * (1 + (state.detonationRisk ?? 0) / 100),
    SIGNAL_BLUFF:        () => 1.0 * mult * (1 + (state.stealth ?? 0) / 100),
  }[type];
  if (!baseByType) return `${actionName(type)}: (соц)`;
  const basePts = baseByType();
  if (type === "SIGNAL_BLUFF") {
    const p = previewSocialGain(state, "SIGNAL_BLUFF", basePts * 0.60, "plea");
    const t = previewSocialGain(state, "SIGNAL_BLUFF", basePts * 0.40, "threat");
    return `${actionName(type)}: +${p.toFixed(1)} plea, +${t.toFixed(1)} threat`;
  }
  if (type === "THREATEN_DETONATION" || type === "FAKE_MELTDOWN") {
    const g = previewSocialGain(state, type, basePts, "threat");
    return `${actionName(type)}: +${g.toFixed(1)} threat`;
  }
  if (type === "OFFER_BRIBE") {
    const g      = previewSocialGain(state, type, basePts, "plea");
    const cost   = bribeCostApprox(state, mult);
    const haveC  = Math.round(state.economy?.credits ?? 0);
    const canPay = haveC >= cost ? "✅" : "⚠️";
    return `${actionName(type)}: +${g.toFixed(1)} plea · ~${cost}cr ${canPay}`;
  }
  const g = previewSocialGain(state, type, basePts, "plea");
  return `${actionName(type)}: +${g.toFixed(1)} plea`;
}

function previewActionLine(state, a, dir = "away") {
  const type      = String(a?.type || "").trim();
  const mult      = clamp(Number(a?.mult ?? 1), 0.1, 3.0);
  const eff       = state?.player?._eff || {};
  const speedMult = clamp(eff.flight_speed_mult ?? 1, 0.15, 18.0);
  const fatMult   = engineFatigueMult(state);
  const fatPct    = Math.round(state.engineFatigue ?? 0);
  const fatSuffix = fatPct > 0 ? ` · уст.двиг ${fatPct}%` : "";

  const hitChance = (t) => pct01(previewPlayerHitChance(state, t));

  const dmgPreview = (base, actionType) => {
    const dm  = distDamageMult(actionType, state.distance);
    const dmg = Math.round(base * dm);
    return { dmg, dm };
  };

  switch (type) {
    case "ATTACK_KINETIC": {
      const { dmg, dm } = dmgPreview(9 * mult * (eff.kinetic_damage_mult ?? 1), type);
      return `${actionName(type)}: ~${dmg} урона (dist×${dm.toFixed(2)}) · шанс ${hitChance(type)}`;
    }
    case "ATTACK_THERMAL": {
      const { dmg, dm } = dmgPreview(7 * mult * (eff.thermal_damage_mult ?? 1), type);
      const burn = Math.max(0, (eff.thermal_burn_add ?? 0) + 2.5 * mult);
      return `${actionName(type)}: ~${dmg} урона (dist×${dm.toFixed(2)}) + burn +${burn.toFixed(1)} · шанс ${hitChance(type)}`;
    }
    case "ATTACK_SHRAPNEL": {
      const { dmg, dm } = dmgPreview(6 * mult * (eff.rocket_salvo_mult ?? 1), type);
      return `${actionName(type)}: ~${dmg} урона (dist×${dm.toFixed(2)}) · без промаха`;
    }
    case "ROCKET_SALVO": {
      const { dmg, dm } = dmgPreview(14 * mult * (eff.rocket_salvo_mult ?? 1), type);
      const ammoBonus   = Math.floor(eff.rocket_ammo_add ?? 0);
      const ammoStr     = ammoBonus > 0 ? ` + доп. залп (ammo ×${ammoBonus})` : "";
      const hint        = state.distance < 35 ? " ⚠️ близко" : state.distance >= 65 ? " ✅ оптимум" : "";
      return `${actionName(type)}: ~${dmg} урона (dist×${dm.toFixed(2)}${hint})${ammoStr}`;
    }
    case "PIERCE": {
      const { dmg, dm } = dmgPreview(6 * mult * (eff.armor_pierce_mult ?? 1), type);
      const pr = clamp(0.40 + ((eff.armor_pierce_mult ?? 1) - 1) * 0.20, 0.40, 0.85);
      return `${actionName(type)}: ~${dmg} урона (dist×${dm.toFixed(2)}, ${Math.round(pr * 100)}% в hull) · шанс ${hitChance(type)}`;
    }
    case "FOCUS_FIRE": {
      const { dmg, dm } = dmgPreview(12 * mult * (eff.kinetic_damage_mult ?? 1), type);
      return `${actionName(type)}: ~${dmg} урона (dist×${dm.toFixed(2)}) · шанс ${hitChance(type)}`;
    }
    case "FUEL_IGNITE": {
      const { dmg, dm } = dmgPreview(5 * mult * (eff.thermal_damage_mult ?? 1), type);
      return `${actionName(type)}: ~${dmg} урона (dist×${dm.toFixed(2)}) + det +10% · шанс ${hitChance(type)}`;
    }
    case "ATTACK_EMP":
      return `${actionName(type)}: враг ×0.8 точность на 2 раунда`;
    case "DISRUPT_SENSORS":
      return `${actionName(type)}: враг ×0.8 точность на 2 раунда`;
    case "SHIELD_REGEN": {
      const add = Math.round(15 * mult * (eff.shield_mult ?? 1));
      return `${actionName(type)}: +${add} щита`;
    }
    case "SHIELD_SPIKE": {
      const add = Math.round(25 * mult * (eff.shield_mult ?? 1));
      return `${actionName(type)}: +${add} щита (временно)`;
    }
    case "EMERGENCY_REPAIR": {
      const add = Math.round(10 * mult * (eff.hp_mult ?? 1));
      return `${actionName(type)}: +${add} обшивки`;
    }
    case "DAMAGE_CONTROL": {
      const add = Math.round(6 * mult * (eff.hp_mult ?? 1));
      return `${actionName(type)}: +${add} обшивки · det −5%`;
    }
    case "HULL_BRACE":
      return `${actionName(type)}: следующий урон −50%`;
    case "DISTANCE_PUSH": {
      const delta  = Math.round(20 * mult * speedMult * fatMult);
      const away   = clamp(state.distance + delta, LIMITS.DIST_MIN, LIMITS.DIST_MAX);
      const toward = clamp(state.distance - delta, LIMITS.DIST_MIN, LIMITS.DIST_MAX);
      const awayH  = away >= LIMITS.ESCAPE_DIST ? " 🚀" : "";
      return `${actionName(type)}: от врага +${delta}→${Math.round(away)}${awayH} · к врагу −${delta}→${Math.round(toward)}${fatSuffix}`;
    }
    case "FULL_BURN": {
      const delta      = Math.round(35 * mult * speedMult * fatMult);
      const shieldCost = Math.round(5 / Math.max(0.3, speedMult));
      const away       = clamp(state.distance + delta, LIMITS.DIST_MIN, LIMITS.DIST_MAX);
      const toward     = clamp(state.distance - delta, LIMITS.DIST_MIN, LIMITS.DIST_MAX);
      const awayH      = away >= LIMITS.ESCAPE_DIST ? " 🚀" : "";
      return `${actionName(type)}: от +${delta}→${Math.round(away)}${awayH} · к −${delta}→${Math.round(toward)} (щит −${shieldCost})${fatSuffix}`;
    }
    case "DRIFT_SILENT": {
      const stealthMult = clamp(eff.guard_stealth_mult ?? 1, 0.25, 50.0);
      const cloakBonus  = 1 + (eff.cloak_duration_add ?? 0) / 10;
      const distB       = stealthDistBonus(state.distance);
      const sAway       = Math.round(20 * mult * stealthMult * cloakBonus * distB);
      const sToward     = Math.round(20 * mult * stealthMult * cloakBonus * distB * 1.3);
      const dDelta      = Math.round(10 * mult * speedMult);
      const nextDAway   = clamp(state.distance + dDelta, LIMITS.DIST_MIN, LIMITS.DIST_MAX);
      const nextDToward = clamp(state.distance - dDelta, LIMITS.DIST_MIN, LIMITS.DIST_MAX);
      const needAway    = stealthThresholdAtDist(nextDAway);
      const awayH       = nextDAway >= LIMITS.ESCAPE_DIST ? " 🚀" : "";
      return `${actionName(type)}: от stealth+${sAway}→${Math.round(state.stealth+sAway)}/${needAway}, dist+${dDelta}→${Math.round(nextDAway)}${awayH} · к stealth+${sToward}(lock заморожен), dist−${dDelta}→${Math.round(nextDToward)}`;
    }
    case "DISTANCE_PULL": {
      const pull = Math.round(20 * mult * fatMult);
      const next = clamp(state.distance - pull, LIMITS.DIST_MIN, LIMITS.DIST_MAX);
      return `${actionName(type)}: −${pull} → ${Math.round(next)}${fatSuffix}`;
    }
    case "EVADE_SPIKE": {
      const e = clamp(
        (15 * mult * speedMult) + (eff.dodge_chance_add ?? 0) * 0.25 + (eff.evade_charge_add ?? 0) * 3,
        0, 85
      );
      return `${actionName(type)}: враг ×${(1 - e / 100).toFixed(2)} точность`;
    }
    case "SENSOR_JAM": {
      const s    = Math.round(25 * mult * (1 + (eff.sensor_jam_add ?? 0) / 50) * stealthDistBonus(state.distance));
      const nextS = clamp(state.stealth + s, 0, 100);
      const need  = stealthThresholdAtDist(state.distance);
      return `${actionName(type)}: stealth +${s} → ${Math.round(nextS)}/${need} · враг хуже видит`;
    }
    case "DECOY_DUMP": {
      const s    = Math.round((15 * mult + (eff.cloak_duration_add ?? 0) * 2) * stealthDistBonus(state.distance));
      const nextS = clamp(state.stealth + s, 0, 100);
      const need  = stealthThresholdAtDist(state.distance);
      return `${actionName(type)}: stealth +${s} → ${Math.round(nextS)}/${need} · враг пропускает ход`;
    }
    case "EMP_STUN":
      return `${actionName(type)}: враг пропускает ход`;
    case "DATA_SPOOF": {
      const s    = Math.round(15 * mult * stealthDistBonus(state.distance) * 0.9);
      const nextS = clamp(state.stealth + s, 0, 100);
      const need  = stealthThresholdAtDist(state.distance);
      return `${actionName(type)}: stealth +${s} → ${Math.round(nextS)}/${need}`;
    }
    case "OFFER_BRIBE":
    case "BROADCAST_PLEA":
    case "NEGOTIATE_DELAY":
    case "THREATEN_DETONATION":
    case "FAKE_MELTDOWN":
    case "SIGNAL_BLUFF":
      return previewSocialLine(state, type, mult);
    default:
      return `${actionName(type)}: (без модели)`;
  }
}

// ─────────────────────────────────────────────────────────────
// UI styles
// ─────────────────────────────────────────────────────────────

function injectSimStylesOnce() {
  if (document.getElementById("combat-sim-style")) return;
  const st = document.createElement("style");
  st.id = "combat-sim-style";
  st.textContent = `
    #modal-combat-sim .modal-box { max-height:92vh; overflow:auto; }
    .combat-sim-controls { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:10px; }
    .combat-sim-hud { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:10px; }
    .combat-sim-main { display:grid; grid-template-columns:1fr 1fr; gap:10px; }

    .combat-sim-card {
      border:1px solid rgba(255,255,255,0.10);
      background:rgba(255,255,255,0.04);
      border-radius:10px; padding:10px;
      pointer-events:auto; touch-action:manipulation;
      transition:border-color .15s;
    }
    .combat-sim-card.escape-hint {
      border-color:var(--green,#4caf50);
      box-shadow:0 0 8px rgba(76,175,80,0.25);
    }
    .combat-sim-card-title { font-weight:800; margin-bottom:6px; }
    .combat-sim-card-lore {
      font-size:12px; opacity:.92;
      white-space:pre-wrap; margin-bottom:8px;
    }
    .combat-sim-effect-lines { font-size:12px; line-height:1.35; margin:6px 0 8px; }
    .combat-sim-effect-lines > div { margin:4px 0; }

    /* chaos preview на карте — минималистичный */
    .combat-sim-chaos-preview {
      margin-top: 8px;
      padding: 5px 8px;
      border-radius: 6px;
      border: 1px dashed rgba(255,255,255,0.2);
      font-size: 11px;
      color: var(--muted, #888);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .combat-sim-chaos-preview .chaos-icon {
      font-size: 14px;
      flex-shrink: 0;
    }

    /* кнопки манёвра */
    .combat-sim-dir-btns { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:6px; }
    .combat-sim-dir-btn  { padding:8px 6px; font-weight:700; font-size:12px; touch-action:manipulation; }
    .combat-sim-dir-btn.toward { background:rgba(244,67,54,0.15); border-color:rgba(244,67,54,0.4); }
    .combat-sim-dir-btn.away   { background:rgba(76,175,80,0.15); border-color:rgba(76,175,80,0.4); }
    .combat-sim-dir-btn.escape { background:rgba(76,175,80,0.35); border-color:var(--green,#4caf50); }

    .combat-sim-play-btn { width:100%; padding:10px 12px; font-weight:800; touch-action:manipulation; margin-top:6px; }

    .combat-sim-log { max-height:46vh; overflow:auto; }
    .log-line { font-size:12px; line-height:1.3; padding:5px 0;
                border-bottom:1px dashed rgba(255,255,255,0.07); }
    .log-line.log-player { border-left:2px solid var(--accent,#7b61ff); padding-left:6px; }
    .log-line.log-enemy  { border-left:2px solid var(--red,#f44336); padding-left:6px; }
    .log-line.log-system { border-left:2px solid rgba(255,255,255,0.2); padding-left:6px; opacity:.75; }
    .log-line.log-result { border-left:2px solid var(--green,#4caf50); padding-left:6px; font-weight:700; }
    .log-line.log-chaos  { border-left:2px solid #ff9800; padding-left:6px; }

    @media (max-width:720px) {
      .combat-sim-controls { flex-direction:column; align-items:stretch; }
      .combat-sim-controls > * { width:100%; }
      .combat-sim-hud  { grid-template-columns:1fr; }
      .combat-sim-main { grid-template-columns:1fr; }
      .combat-sim-log  { max-height:34vh; }
      .combat-sim-dir-btns { grid-template-columns:1fr; }
    }
  `;
  document.head.appendChild(st);
}

// ─────────────────────────────────────────────────────────────
// Modal
// ─────────────────────────────────────────────────────────────

function ensureModal() {
  injectSimStylesOnce();
  injectChaosStyles();
  let modal = document.getElementById("modal-combat-sim");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id        = "modal-combat-sim";
  modal.className = "modal hidden";
  modal.innerHTML = `
    <div class="modal-box" style="max-width:980px;width:95%;">
      <div class="equip-modal-header">
        <h2>🧪 Симулятор боя (альфа)</h2>
        <button id="btn-combat-sim-close" class="btn-icon">✕</button>
      </div>

      <div class="combat-sim-controls">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;flex:1;">
          <label style="font-size:12px;color:var(--muted)">Враг:</label>
          <select id="combat-sim-enemy" style="padding:8px 10px;flex:1;min-width:180px;">
            ${ENEMIES.map(e => `<option value="${esc(e.key)}">${esc(e.label)}</option>`).join("")}
          </select>
          <label style="font-size:12px;color:var(--muted)">Tier:</label>
          <select id="combat-sim-tierscale" style="padding:8px 10px;min-width:140px;">
            <option value="1.0">×1.0 (tier 1–2)</option>
            <option value="1.5">×1.5 (tier 3)</option>
            <option value="2.0">×2.0 (tier 4)</option>
            <option value="2.5">×2.5 (tier 5)</option>
            <option value="3.5">×3.5 (tier 6)</option>
          </select>
        </div>
        <button id="btn-combat-sim-new"     class="btn-primary">♻️ Новый бой</button>
        <button id="btn-combat-sim-auto100" class="btn-secondary">📊 Автосим 100</button>
        <button id="btn-combat-sim-random"  class="btn-secondary">🎲 Авто-раунд</button>
        <div id="combat-sim-warn" style="font-size:12px;color:var(--muted);width:100%;"></div>
      </div>

      <div id="combat-sim-hud" class="combat-sim-hud"></div>

      <div class="combat-sim-main">
        <div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">
            🃏 Рука · нажми карту или выбери направление
            <span style="color:var(--green,#4caf50)"> · зелёная = побег</span>
            <span style="color:#ff9800"> · ⚡ = chaos после выбора</span>
          </div>
          <div id="combat-sim-hand" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;"></div>
        </div>
        <div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">📜 Лог</div>
          <div id="combat-sim-log" class="combat-sim-log"></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
  modal.querySelector("#btn-combat-sim-close")?.addEventListener("click", () => {
    clearChaosFlash();
    modal.classList.add("hidden");
  });

  return modal;
}

// ─────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────

let SIM_STATE = null;
let SIM_BUILD = null;

function renderWarn() {
  const el = document.getElementById("combat-sim-warn");
  if (el) el.textContent = SIM_BUILD?.warn || "";
}

function renderHud() {
  const el = document.getElementById("combat-sim-hud");
  if (!el) return;
  if (!SIM_STATE) { el.innerHTML = `<div class="combat-sim-card">Нет активного боя</div>`; return; }

  const s = SIM_STATE;

  const stealthHint = s.distance >= LIMITS.ESCAPE_DIST
    ? `<span style="color:var(--green,#4caf50)">(dist-побег доступен)</span>`
    : `<span style="color:var(--muted)">(нужно stealth≥${stealthThresholdAtDist(s.distance)}, lock ${s.stealthLock??0}/${LIMITS.STEALTH_LOCK_REQUIRED})</span>`;

  const plea     = Number(s.social?.plea   ?? 0);
  const threat   = Number(s.social?.threat ?? 0);
  const detColor = s.detonationRisk >= 50 ? "var(--red,#f44336)" : "var(--accent,#7b61ff)";
  const fatigue  = Math.round(s.engineFatigue ?? 0);
  const fatColor = fatigue >= 60 ? "var(--red,#f44336)" : fatigue >= 30 ? "#ff9800" : "var(--muted)";
  const eDown    = enemyModulesDown(s);
  const eTotal   = (s.enemy.modules || []).length;
  const cr       = Math.round(s.economy?.credits    ?? 0);
  const cargoU   = Math.round(s.economy?.cargoUnits ?? 0);

  el.innerHTML = `
    <div class="combat-sim-card">
      <div class="combat-sim-card-title">🚀 Игрок</div>
      <div>🛡 щит: <b>${s.player.shield}</b>/${s.player.maxShield}</div>
      ${bar(s.player.shield, s.player.maxShield, "var(--accent,#7b61ff)")}
      <div>🧱 обшивка: <b>${s.player.hull}</b>/${s.player.maxHull}</div>
      ${bar(s.player.hull, s.player.maxHull, "#8d6e63")}
      <div>📏 dist: <b>${Math.round(s.distance)}</b>
        <span style="color:var(--muted)">(побег≥${LIMITS.ESCAPE_DIST})</span></div>
      <div>🎯 попадание: вы <b>${pct01(previewPlayerHitChance(s,"ATTACK_KINETIC"))}</b>
           · враг <b>${pct01(previewEnemyHitChance(s))}</b></div>
      <div style="margin-top:6px;">
        <div>🕵 stealth: <b>${s.stealth.toFixed(0)}</b>/100 ${stealthHint}</div>
        ${bar(s.stealth, 100, "var(--green,#4caf50)")}
        <div style="color:${fatColor}">⚙️ уст.двиг.: <b>${fatigue}%</b></div>
        ${bar(fatigue, 90, fatColor)}
        <div>🤲 plea: <b>${plea.toFixed(1)}</b>/${LIMITS.SOCIAL_PLEA_WIN}</div>
        ${bar(plea, LIMITS.SOCIAL_PLEA_WIN, "#26a69a")}
        <div>☢️ threat: <b>${threat.toFixed(1)}</b>/${LIMITS.SOCIAL_THREAT_WIN}</div>
        ${bar(threat, LIMITS.SOCIAL_THREAT_WIN, "#ef5350")}
        <div style="color:${detColor}">💥 detonation: <b>${s.detonationRisk.toFixed(0)}%</b></div>
        ${bar(s.detonationRisk, 100, detColor)}
        <div style="font-size:11px;color:var(--muted);margin-top:2px;">
          💸 <b>${cr}</b> cr · 🗃 трюм <b>${cargoU}</b>
        </div>
      </div>
      <div style="margin-top:6px;font-size:11px;color:var(--muted);">
        ${s.player.modules.map(m => `${m.destroyed?"💀":"✅"} ${esc(m.name)} ${m.hp}/${m.maxHp}`).join(" &nbsp; ")}
      </div>
    </div>

    <div class="combat-sim-card">
      <div class="combat-sim-card-title">☠️ ${esc(s.enemy.label)}</div>
      <div>🛡 щит: <b>${s.enemy.shield}</b>/${s.enemy.maxShield}</div>
      ${bar(s.enemy.shield, s.enemy.maxShield, "#7986cb")}
      <div>🧱 корпус: <b>${s.enemy.hull}</b>/${s.enemy.maxHull}</div>
      ${bar(s.enemy.hull, s.enemy.maxHull, "#a1887f")}
      <div>🔧 системы: <b>${eTotal-eDown}</b>/${eTotal}
        <span style="color:var(--muted)">(сломано: ${eDown})</span></div>
      <div>🌡 burn: <b>${Number(s.enemy.burn).toFixed(0)}</b></div>
      <div>💢 агрессия: <b>${((s.enemy.aggression??0.7)*100).toFixed(0)}%</b></div>
      <div>🔍 scanPower: <b>${Math.round((s.enemy.scanPower??0)*100)}%</b></div>
      <div>🎯 урон/ход: <b>${s.enemy.baseDamage}</b></div>
      <div>⚙️ раунд: <b>${s.round}</b>/${LIMITS.MAX_ROUNDS}</div>
      <div style="margin-top:8px;font-size:12px;color:var(--muted);">
        ${s.over ? `<b>RESULT: ${esc(s.result)}</b>` : "Бой продолжается…"}
      </div>
    </div>
  `;
}

function renderHand() {
  const el = document.getElementById("combat-sim-hand");
  if (!el) return;

  el.style.gridTemplateColumns = window.innerWidth <= 720 ? "1fr" : "1fr 1fr";

  if (!SIM_STATE) { el.innerHTML = `<div class="combat-sim-card">Нет руки</div>`; return; }

  const s = SIM_STATE;
  el.innerHTML = "";

  const cards = (s.hand || []).slice(0, 2);
  for (let idx = 0; idx < 2; idx++) {
    const c      = cards[idx];
    const cardEl = document.createElement("div");
    cardEl.className = "combat-sim-card";

    if (!c) {
      cardEl.innerHTML = `<div class="combat-sim-card-title" style="opacity:.6">Нет карты</div>`;
      el.appendChild(cardEl);
      continue;
    }

    const normalActions = (c.actions || []).filter(a => a.role !== "chaos");
    const chaosAction   = (c.actions || []).find(a => a.role === "chaos");

    const hasDirectional = !s.over && normalActions.some(a => DIRECTIONAL_ACTIONS.has(String(a?.type || "")));
    const givesEscape    = !s.over && normalActions.some(a => actionGivesEscapeNow(s, a));

    if (givesEscape) cardEl.classList.add("escape-hint");

    // preview нормальных действий
    const normalLinesHtml = normalActions.slice(0, 2).map(a => {
      const line     = previewActionLine(s, a, "away");
      const isEscape = line.includes("🚀") || line.includes("👻");
      return `<div style="${isEscape ? "color:var(--green,#4caf50);font-weight:600;" : ""}">${esc(line)}</div>`;
    }).join("");

    // chaos — только иконка + type + mult, без результата
    const chaosMult   = chaosAction ? Number(chaosAction.mult) : 1;
    const chaosIsHigh = chaosMult >= 1.8;
    const chaosIsBad  = chaosMult <= 0.4;
    const chaosIcon   = chaosIsHigh ? "⚡🔥" : chaosIsBad ? "⚡💀" : "⚡";
    const chaosColor  = chaosIsHigh ? "#ff9800" : chaosIsBad ? "#ef5350" : "var(--muted)";

    const chaosPreviewHtml = chaosAction ? `
      <div class="combat-sim-chaos-preview">
        <span class="chaos-icon">${chaosIcon}</span>
        <span style="color:${chaosColor};">
          CHAOS: <b>${esc(chaosAction.type)}</b> ×${chaosMult.toFixed(2)}
        </span>
        <span style="color:var(--muted);font-size:10px;">— сработает при розыгрыше</span>
      </div>
    ` : "";

    cardEl.innerHTML = `
      <div class="combat-sim-card-title">${esc(c.card_name || c.origin_key)}</div>
      <div class="combat-sim-card-lore">${esc(c.lore_description || "")}</div>
      <div class="combat-sim-effect-lines">${normalLinesHtml}</div>
      ${chaosPreviewHtml}
    `;

    // функция розыгрыша с chaos-флэшем
    const playWithChaosFlash = (direction) => {
      if (s.over) return;
      runRound(s, idx, direction);

      // сначала рендерим нормальное состояние
      renderAll();

      // затем показываем chaos-флэш если был chaos
      if (s._lastChaos) {
        setTimeout(() => {
          showChaosFlash(s._lastChaos);
        }, 300);
      }
    };

    if (hasDirectional) {
      const escAway   = normalActions.some(a => maneuverGivesEscape(s, a, "away"));
      const escToward = normalActions.some(a => maneuverGivesEscape(s, a, "toward"));

      const btnDiv = document.createElement("div");
      btnDiv.className = "combat-sim-dir-btns";
      btnDiv.innerHTML = `
        <button type="button"
          class="btn-secondary combat-sim-dir-btn toward ${escToward ? "escape" : ""}"
          ${s.over ? "disabled" : ""}>
          ⬅ К врагу${escToward ? " 🚀" : ""}
        </button>
        <button type="button"
          class="btn-primary combat-sim-dir-btn away ${escAway ? "escape" : ""}"
          ${s.over ? "disabled" : ""}>
          От врага ➡${escAway ? " 🚀" : ""}
        </button>
      `;

      const [btnT, btnA] = btnDiv.querySelectorAll("button");
      btnT.addEventListener("click", (e) => { e.stopPropagation(); playWithChaosFlash("toward"); });
      btnA.addEventListener("click", (e) => { e.stopPropagation(); playWithChaosFlash("away"); });
      cardEl.appendChild(btnDiv);

    } else {
      const btn       = document.createElement("button");
      btn.type        = "button";
      btn.className   = `btn-primary combat-sim-play-btn${givesEscape ? " escape" : ""}`;
      btn.disabled    = s.over;
      btn.textContent = givesEscape ? "🚀 Сыграть (побег!)" : "▶ Сыграть эту карту";

      btn.addEventListener("click", (e) => { e.stopPropagation(); playWithChaosFlash(null); });
      cardEl.addEventListener("click", () => playWithChaosFlash(null));
      cardEl.appendChild(btn);
    }

    el.appendChild(cardEl);
  }
}

const RESULT_ICON = {
  win_kill:          "🏆",
  win_flee:          "🚀",
  win_stealth:       "👻",
  win_social_plea:   "🤲",
  win_social_threat: "☢️",
  lose_board:        "⚓",
  lose_modules:      "💀",
  lose_detonation:   "💥",
};

function renderLog() {
  const el = document.getElementById("combat-sim-log");
  if (!el) return;
  if (!SIM_STATE) { el.innerHTML = ""; return; }

  el.innerHTML = "";

  for (const entry of SIM_STATE.log.slice(-240)) {
    const line     = document.createElement("div");
    line.className = "log-line";

    const isResult = entry.title === "RESULT";
    if (isResult)                    line.classList.add("log-result");
    else if (entry.who === "player" && entry._hasChaos) line.classList.add("log-player");
    else if (entry.who === "player") line.classList.add("log-player");
    else if (entry.who === "enemy")  line.classList.add("log-enemy");
    else                             line.classList.add("log-system");

    const icon = isResult ? (RESULT_ICON[SIM_STATE.result] || "❓") : "";

    // в логе chaos-строка выделяется цветом
    const msgs = (entry.messages || []).map(m => {
      const s = String(m);
      if (s.startsWith("⚡ CHAOS")) {
        return `<span style="color:#ff9800;font-weight:600;">${esc(s)}</span>`;
      }
      return esc(s);
    }).join("<br>");

    line.innerHTML =
      `<b>[${entry.round}] ${icon}${esc(entry.who)}: ${esc(entry.title)}</b><br>${msgs}`;

    el.appendChild(line);
  }
  el.scrollTop = el.scrollHeight;
}

function renderAll() {
  renderWarn();
  renderHud();
  renderHand();
  renderLog();
}

// ─────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────

function newFight() {
  clearChaosFlash();

  const enemyKey      = document.getElementById("combat-sim-enemy")?.value || "minor_pirate";
  const tierScale     = getTierScale();
  const equippedItems = resolveEquippedItemsFromState();

  if (equippedItems.length !== 4) {
    showToast(`Нужно 4 модуля. Сейчас: ${equippedItems.length}/4`, "warning");
    SIM_BUILD = { warn: "Нужно экипировать 4 модуля." };
    SIM_STATE = null;
    renderAll();
    return;
  }

  const deck = loadDeckFromCache(equippedItems);
  const warn = deck.length < 10
    ? `Карт в кэше: ${deck.length}/10. Открой «🃏 Боевая колода» и сгенерируй недостающие.`
    : "";

  SIM_BUILD = { warn, equippedItems, deck };
  SIM_STATE = buildCombatState({
    equippedItems,
    deckCards:        deck,
    enemyKey,
    playerCredits:    (typeof getCredits === "function") ? getCredits() : 0,
    playerCargoUnits: cargoUnitsFromPlayerState(),
    tierScale,
  });

  SIM_STATE.log.push({
    round: 0, who: "system", title: "INIT",
    messages: [
      `Модули: 4 · Карты: ${deck.length}/10 · Враг: ${enemyKey} · Tier ×${tierScale}`,
      `HP врага: щит ${SIM_STATE.enemy.maxShield} / корпус ${SIM_STATE.enemy.maxHull} · урон: ${SIM_STATE.enemy.baseDamage}/ход`,
      `Социалка: plea(${LIMITS.SOCIAL_PLEA_WIN}) · threat(${LIMITS.SOCIAL_THREAT_WIN})`,
      `Усталость двиг.: +30%/применение, −10%/ход`,
      `Скан: при stealth≥40 шанс 33% вместо атаки`,
      `Ракеты: оптимум dist≥65`,
      `Манёвры: выбирай направление`,
      `Chaos: срабатывает после выбора карты`,
    ],
  });

  renderAll();
}

function autoSim(runs = 100) {
  const enemyKey      = document.getElementById("combat-sim-enemy")?.value || "minor_pirate";
  const tierScale     = getTierScale();
  const equippedItems = resolveEquippedItemsFromState();
  const deck          = loadDeckFromCache(equippedItems);

  if (equippedItems.length !== 4) { showToast("Нужно 4 модуля.", "warning"); return; }
  if (deck.length < 2)            { showToast("Нет карт в кэше.", "warning"); return; }

  const DIRS   = ["away", "toward"];
  const stats  = {};
  let totalRounds = 0;

  for (let i = 0; i < runs; i++) {
    const s = buildCombatState({
      equippedItems, deckCards: deck, enemyKey,
      playerCredits: 200_000, playerCargoUnits: 200,
      tierScale,
    });
    while (!s.over) {
      const cardIdx = Math.random() < 0.5 ? 0 : 1;
      const dir     = DIRS[Math.floor(Math.random() * 2)];
      runRound(s, cardIdx, dir);
    }
    stats[s.result] = (stats[s.result] ?? 0) + 1;
    totalRounds += s.round;
  }

  showToast(`Автосим ${runs} (×${tierScale}): см. консоль`, "info");
  console.log(`[CombatSim] enemy=${enemyKey} tier=×${tierScale} runs=${runs}`);
  console.table(Object.entries(stats).map(([result, count]) => ({
    result,
    icon:  RESULT_ICON[result] || "?",
    count,
    pct:   `${Math.round(count / runs * 100)}%`,
  })));
  console.log("avg rounds:", (totalRounds / runs).toFixed(2));
}

// ─────────────────────────────────────────────────────────────
// Button injection
// ─────────────────────────────────────────────────────────────

function tryInjectButtonNearDeck() {
  const deckBtn = document.getElementById("btn-open-deck");
  if (!deckBtn) return false;
  if (document.getElementById("btn-open-combat-sim")) return true;

  const b = document.createElement("button");
  b.id        = "btn-open-combat-sim";
  b.className = "btn-secondary";
  b.style.marginLeft = "10px";
  b.textContent = "🧪 Симулятор";
  deckBtn.parentElement?.appendChild(b);

  b.addEventListener("click", () => {
    const modal = ensureModal();
    modal.classList.remove("hidden");
    newFight();
  });
  return true;
}

function injectButtonNearDeckWithRetry() {
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    const ok = tryInjectButtonNearDeck();
    if (ok || tries >= 25) clearInterval(t);
  }, 800);
}

// ─────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  ensureModal();
  injectButtonNearDeckWithRetry();

  document.getElementById("btn-combat-sim-new")
    ?.addEventListener("click", () => newFight());

  document.getElementById("btn-combat-sim-auto100")
    ?.addEventListener("click", () => autoSim(100));

  document.getElementById("btn-combat-sim-random")
    ?.addEventListener("click", () => {
      if (!SIM_STATE || SIM_STATE.over) return;
      const dir = Math.random() < 0.5 ? "away" : "toward";
      runRound(SIM_STATE, Math.random() < 0.5 ? 0 : 1, dir);
      // chaos-флэш и для авто-раунда
      if (SIM_STATE._lastChaos) {
        setTimeout(() => showChaosFlash(SIM_STATE._lastChaos), 300);
      }
      renderAll();
    });

  window.addEventListener("resize", () => {
    const m = document.getElementById("modal-combat-sim");
    if (m && !m.classList.contains("hidden")) renderHand();
  });
});

// ─────────────────────────────────────────────────────────────
// Debug
// ─────────────────────────────────────────────────────────────

window.CombatSim = {
  open()   { const m = ensureModal(); m.classList.remove("hidden"); newFight(); },
  newFight,
  autoSim,
  get state() { return SIM_STATE; },
};