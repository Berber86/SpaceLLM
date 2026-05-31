// mining.js — экспедиции (v3.7)
// + руда tier-5: alloys (🔩 Боевые сплавы)
// + circuit-boneyard и black-arc теперь дропают alloys
// + ORE_UPGRADE_CHAIN: data → alloys → null

import {
  setExpedition, getExpedition,
  showToast,
  addToCargo,
  isCargoFull, unloadCargo, clearCargo, renderCargo,
  getFuel, addFuel, spendFuel,
  getFuelGenPerHour,
  getCargoMass, getTotalShipMass, getCargoCapacity,
  calcFuelForFlight, calcFuelPerCycle,
  getFlightSpeedMultiplier, getReturnSpeedMultiplier, getMiningSpeedMultiplier,
  getMiningSpeedBonus,
  getMiningYieldMultiplier,
  getGuardStealthMultiplier,
  getAutopilotGuardIgnoreChance,
  getOreQualityUpgradeChance,
  getOreUpgradeShare,
  getAutopilotCycles,
  calcFlightTime, renderFuel, RESOURCE_WEIGHT,
  checkNewPlayerHint,
  addToInventory, renderInventory, getUid, getState,
} from "./player.js";
import {
  pickEnemy, showCombatModal,
  getClearedAsteroids, markAsteroidCleared,
} from "./combat.js";
import { generateFoundModule } from "./forge.js";

// ─────────────────────────────────────────────────────────────────────────────
// DEV: ускорение времени
// ─────────────────────────────────────────────────────────────────────────────
function getTimeScale() {
  const raw = localStorage.getItem("time_scale") ?? "1";
  const n   = parseFloat(raw);
  if (n === 3 || n === 10 || n === 100) return n;
  return 1;
}
function applyTimeScaleSeconds(seconds) {
  const s = getTimeScale();
  return Math.max(1, Math.round(seconds / s));
}
function timerTickMs() {
  const s = getTimeScale();
  return Math.max(100, Math.round(1000 / Math.min(s, 10)));
}

// ─────────────────────────────────────────────────────────────────────────────
// ASTEROIDS
// ─────────────────────────────────────────────────────────────────────────────
export const ASTEROIDS = [
  {
    id:"belt-alpha", name:"Пояс Альфа", icon:"🪨", tier:1,
    distance:30, miningCycleBase:30, guardChance:0,
    desc:"Ближний пояс. Почти чистые изотопы и мелкая пыль.",
    unlockMsg:"Из ☢️ можно крафтить топливо.",
    dropPerCycle:{ isotopes:[13,30] },
  },
  {
    id:"ceres-deep", name:"Глубины Цереры", icon:"☄️", tier:2,
    distance:200, miningCycleBase:3*60, guardChance:0,
    desc:"Тяжёлая порода и палладиевые прожилки. Здесь уже не возят изотопы мешками.",
    unlockMsg:"Открывает: 🗃️ трюм, 🛢️ бак (через сочетания).",
    dropPerCycle:{ minerals:[10,24] },
  },
  {
    id:"iron-drift", name:"Железный Дрейф", icon:"🌑", tier:3,
    distance:700, miningCycleBase:6*60, guardChance:0.15,
    desc:"Тяговые сплавы. Жила жёсткая — бур работает на грани. Иногда появляется охрана.",
    unlockMsg:"Открывает: 🚀 двигатель, 🛡️ обшивка, ⛏️ бур.",
    dropPerCycle:{ metals:[8,20] },
  },
  {
    id:"shipyard-slag", name:"Шлаки Верфи", icon:"⚙️", tier:4,
    distance:1500, miningCycleBase:10*60, guardChance:0.25,
    desc:"Остывшие поля сплава и сломанные узлы. Охрана реагирует на бур.",
    unlockMsg:"Открывает доступ к 💾 микросхемам.",
    dropPerCycle:{ data:[8,18] },
  },
  {
    id:"circuit-boneyard", name:"Кладбище Плат", icon:"🧩", tier:5,
    distance:3000, miningCycleBase:20*60, guardChance:0.35,
    desc:"Обломки боевых кораблей и оружейных платформ. В шламе — боевые сплавы высокой чистоты. Охрана злая.",
    unlockMsg:"Открывает 🔩 боевые сплавы для оружейных модулей.",
    dropPerCycle:{ alloys:[8,18] },
  },
  {
    id:"black-arc", name:"Чёрная Дуга", icon:"🕳️", tier:6,
    distance:6000, miningCycleBase:35*60, guardChance:0.45,
    desc:"Дальняя зона. Поля помех. Сильная охрана. Сплавы тут высокой чистоты, но добывать — себе дороже.",
    unlockMsg:"Высокий шанс редких исходов через примесь.",
    dropPerCycle:{ alloys:[14,34] },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// DROP MASS CAP
// ─────────────────────────────────────────────────────────────────────────────
const DROP_MASS_CAP_FRACTION = 0.30;

function dropMass(drop) {
  return Object.entries(drop).reduce((sum, [res, amt]) => {
    return sum + (amt ?? 0) * (RESOURCE_WEIGHT[res] ?? 1);
  }, 0);
}

function capDropByMass(drop, maxMass) {
  const mass = dropMass(drop);
  if (mass <= maxMass || mass <= 0) return drop;
  const scale = maxMass / mass;
  const out = {};
  for (const [res, amt] of Object.entries(drop)) {
    if ((amt ?? 0) <= 0) continue;
    out[res] = Math.max(1, Math.floor(amt * scale));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORE UPGRADE CHAIN
// ─────────────────────────────────────────────────────────────────────────────
const ORE_UPGRADE_CHAIN = {
  isotopes: "minerals",
  minerals: "metals",
  metals:   "data",
  data:     "alloys",  // ← новое: data апгрейдится до alloys
  alloys:   null,      // ← потолок цепочки
};

function applyOreUpgrade(drop) {
  const chance = Number(getOreQualityUpgradeChance() ?? 10);
  const share  = Number(getOreUpgradeShare() ?? 0.10);

  const upgraded = { ...drop };
  const log = [];

  for (const [res, amt] of Object.entries(drop)) {
    if ((amt ?? 0) <= 0) continue;
    const nextRes = ORE_UPGRADE_CHAIN[res];
    if (!nextRes) continue;

    if (Math.random() * 100 < chance) {
      const up = Math.max(1, Math.floor(amt * share));
      upgraded[res]     = Math.max(0, (upgraded[res] ?? 0) - up);
      upgraded[nextRes] = (upgraded[nextRes] ?? 0) + up;
      log.push(`✨ ${up}×${resIcon(res)}→${resIcon(nextRes)}`);
    }
  }

  return { upgraded, log };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUEL HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function fuelForFlightTo(asteroid) {
  return calcFuelForFlight(asteroid.distance, 0);
}

function fuelForCycle() {
  return calcFuelPerCycle();
}

function fuelForReturnNow(asteroid) {
  return calcFuelForFlight(asteroid.distance, getCargoMass());
}

function fuelForReturnAfterCycle(asteroid) {
  const maxDropMass = Object.entries(asteroid.dropPerCycle).reduce((sum, [res, [, max]]) => {
    return sum + max * (RESOURCE_WEIGHT[res] ?? 1);
  }, 0);
  return calcFuelForFlight(asteroid.distance, getCargoMass() + maxDropMass);
}

function fuelMinForTrip(asteroid) {
  const fuelTo    = fuelForFlightTo(asteroid);
  const fuelCycle = fuelForCycle();
  const maxDropMass = Object.entries(asteroid.dropPerCycle).reduce((sum, [res, [, max]]) => {
    return sum + max * (RESOURCE_WEIGHT[res] ?? 1);
  }, 0);
  const fuelReturn = calcFuelForFlight(asteroid.distance, maxDropMass);
  return fuelTo + fuelCycle + fuelReturn;
}

export function canStartCycle(asteroid) {
  const fuelNow          = getFuel();
  const cycleConsume     = fuelForCycle();
  const returnAfterCycle = fuelForReturnAfterCycle(asteroid);
  return fuelNow >= cycleConsume + returnAfterCycle;
}

// ─────────────────────────────────────────────────────────────────────────────
// TIME
// ─────────────────────────────────────────────────────────────────────────────
function flightTimeToSec(asteroid) {
  const mult = getFlightSpeedMultiplier();
  const mass = getTotalShipMass();
  return applyTimeScaleSeconds(calcFlightTime(asteroid.distance, mult, mass));
}

function flightTimeBackSec(asteroid) {
  const mult = getReturnSpeedMultiplier();
  const mass = getTotalShipMass();
  return applyTimeScaleSeconds(calcFlightTime(asteroid.distance, mult, mass));
}

function miningCycleSec(asteroid) {
  const mult = getMiningSpeedMultiplier();
  const base = Math.max(Math.round(asteroid.miningCycleBase / Math.max(mult, 0.05)), 5);
  return applyTimeScaleSeconds(base);
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
let timerInterval = null;

export function initMining() {
  renderAsteroids();
  const exp = getExpedition();
  if (exp) resumeExpedition(exp);
  startFuelGeneration();
}

// ─────────────────────────────────────────────────────────────────────────────
// PASSIVE FUEL GEN
// ─────────────────────────────────────────────────────────────────────────────
let fuelGenInterval = null;

function startFuelGeneration() {
  if (fuelGenInterval) clearInterval(fuelGenInterval);

  fuelGenInterval = setInterval(async () => {
    const genPerHour = getFuelGenPerHour();
    if (genPerHour > 0) {
      const amount = (genPerHour / 60) * getTimeScale();
      await addFuel(amount);
    }
  }, 60 * 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTOPILOT
// ─────────────────────────────────────────────────────────────────────────────
let autopilotCyclesLeft = 0;
let autopilotRunning    = false;

function stopAutopilot() {
  autopilotCyclesLeft = 0;
  autopilotRunning    = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER ASTEROIDS
// ─────────────────────────────────────────────────────────────────────────────
export function renderAsteroids() {
  const tab = document.getElementById("tab-mining");
  const scrollPos = tab ? tab.scrollTop : 0; // Запоминаем позицию скролла

  const list = document.getElementById("asteroid-list");
  if (!list) return;

  const exp     = getExpedition();
  const cleared = getClearedAsteroids();
  const fuel    = getFuel();

  const miningBonusPct = getMiningSpeedBonus();
  const yieldMult      = getMiningYieldMultiplier();
  const stealthMult    = getGuardStealthMultiplier();
  const oreChance      = getOreQualityUpgradeChance();
  const oreShare       = getOreUpgradeShare();
  const bypass         = getAutopilotGuardIgnoreChance();
  const autoCycles     = getAutopilotCycles();

  const parts = [];
  if (miningBonusPct !== 0) parts.push(`⛏ Скорость: ${miningBonusPct > 0 ? "+" : ""}${miningBonusPct.toFixed(0)}%`);
  if (yieldMult !== 1)      parts.push(`🧲 Хват: ×${yieldMult.toFixed(2)}`);
  if (stealthMult !== 1)    parts.push(`📡 Скрытность: ×${stealthMult.toFixed(2)}`);
  if (oreChance > 0)        parts.push(`✨ Апгрейд: ${oreChance.toFixed(0)}% на ${(oreShare * 100).toFixed(0)}%`);
  if (bypass > 0)           parts.push(`🤖 Обход охраны: ${bypass.toFixed(0)}%`);
  if (autoCycles > 0)       parts.push(`🤖 Автопилот: ${autoCycles} цикл${pluralRu(autoCycles,"","а","ов")}`);

  const ts = getTimeScale();
  if (ts !== 1) parts.push(`⏩ Time ×${ts}`);

  const bonusBanner = parts.length
    ? `<div class="mining-bonus-banner">${parts.join("  ·  ")}</div>`
    : "";

  const asteroidsToShow = exp
    ? ASTEROIDS.filter(a => a.id === exp.asteroidId)
    : ASTEROIDS;

  list.innerHTML = bonusBanner + asteroidsToShow.map(a => {
    const isActive  = exp?.asteroidId === a.id;
    const isCleared = cleared.has(a.id);
    const timeTo    = flightTimeToSec(a);
    const timeBack  = flightTimeBackSec(a);
    const timeCycle = miningCycleSec(a);

    const fuelMin = fuelMinForTrip(a);
    const canFly  = fuel >= fuelMin;

    return `
      <div class="asteroid-card ${isActive ? "asteroid-active" : ""} ${!canFly && !isActive ? "asteroid-locked" : ""}">
        <div class="asteroid-icon">${a.icon}</div>
        <div class="asteroid-name">Tier ${a.tier} · ${a.name}</div>
        <div class="asteroid-meta">${escHtml(a.desc)}</div>

        <div class="asteroid-timing">
          <span title="Расстояние">📍 ${a.distance} у.е.</span>
          <span title="Полёт туда">✈️ ${formatDuration(timeTo)}</span>
          <span title="Цикл добычи">⛏ ${formatDuration(timeCycle)}</span>
          <span title="Обратно">🔙 ${formatDuration(timeBack)}</span>
        </div>

        <div class="asteroid-fuel-cost">
          ⛽ Мин. топливо: ${Math.ceil(fuelMin)}л
          ${!canFly && !isActive
            ? `<span class="fuel-warning"> — не хватает ${Math.ceil(fuelMin - fuel)}л</span>`
            : ""}
        </div>

        <div class="asteroid-drop">${dropSummary(a.dropPerCycle)}/цикл</div>

        ${a.guardChance > 0
          ? `<div class="asteroid-guard ${isCleared ? "cleared" : ""}">
               ${isCleared
                 ? "✅ Зачищен (охраны нет)"
                 : `⚠️ Охрана: ${Math.round(a.guardChance * 100)}% (база)`}
             </div>`
          : ""}

        ${a.unlockMsg
          ? `<div class="asteroid-unlock">${escHtml(a.unlockMsg)}</div>`
          : ""}

        <button class="btn-primary btn-mine"
          onclick="window._startExpedition('${a.id}')"
          ${isActive || (!canFly && !isActive) ? "disabled" : ""}
          style="margin-top:4px"
        >
          ${isActive
            ? phaseLabel(exp.phase)
            : (!canFly ? "⛽ Мало топлива" : "🚀 Отправиться")}
        </button>
      </div>
    `;
  }).join("");
  if (tab && !getExpedition()) {
     // Если экспедиции нет, восстанавливаем скролл (чтобы не прыгало при перерендере списка)
     requestAnimationFrame(() => tab.scrollTop = scrollPos);
  }
}

function phaseLabel(phase) {
  return {
    flight_to:   "✈️ Летим туда...",
    mining:      "⛏ На астероиде",
    flight_back: "🔙 Летим домой...",
  }[phase] ?? "...";
}

function dropSummary(drop) {
  return Object.entries(drop)
    .filter(([, [, max]]) => max > 0)
    .map(([res, [min, max]]) => `${resIcon(res)} ${min}–${max}`)
    .join("  ");
}

// ─────────────────────────────────────────────────────────────────────────────
// START EXPEDITION
// ─────────────────────────────────────────────────────────────────────────────
export async function startExpedition(asteroidId) {
  if (getExpedition()) return;

  const asteroid = ASTEROIDS.find(a => a.id === asteroidId);
  if (!asteroid) return;

  const fuelMin = fuelMinForTrip(asteroid);
  if (getFuel() < fuelMin) {
    showToast(`⛽ Нужно минимум ${Math.ceil(fuelMin)}л топлива. Есть: ${Math.floor(getFuel())}л`, "warning");
    return;
  }

  const fuelTo = fuelForFlightTo(asteroid);
  const ok = await spendFuel(fuelTo);
  if (!ok) {
    showToast("⛽ Недостаточно топлива.", "warning");
    return;
  }

  stopAutopilot();

  const timeTo = flightTimeToSec(asteroid);

  const exp = {
    phase:             "flight_to",
    asteroidId,
    startTime:         Date.now(),
    duration:          timeTo * 1000,
    cyclesDone:        0,
    foundModule:       false,
    currentCycleStart: null,
  };

  await setExpedition(exp);
  await clearCargo();

  renderAsteroids();
  showExpeditionStatus(exp);
  startPhaseTimer(exp);

  showToast(`🚀 Вылетели на ${asteroid.name}. Топлива потрачено: ${Math.ceil(fuelTo)}л`, "info");
}

// ─────────────────────────────────────────────────────────────────────────────
// RESUME
// ─────────────────────────────────────────────────────────────────────────────
function resumeExpedition(exp) {
  showExpeditionStatus(exp);
  const asteroid = ASTEROIDS.find(a => a.id === exp.asteroidId);
  if (!asteroid) return;

  const elapsed = Date.now() - exp.startTime;

  if (exp.phase === "flight_to" || exp.phase === "flight_back") {
    if (elapsed >= exp.duration) onPhaseComplete(exp);
    else startPhaseTimer(exp);

  } else if (exp.phase === "mining") {
    if (exp.currentCycleStart) {
      const cycleElapsed = Date.now() - exp.currentCycleStart;
      if (cycleElapsed >= exp.duration) completeMiningCycle(exp, asteroid);
      else startCycleTimer(exp, asteroid);
    }
    renderMiningPanel(exp, asteroid);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TIMERS
// ─────────────────────────────────────────────────────────────────────────────
function startPhaseTimer(exp) {
  clearInterval(timerInterval);
  const tick = timerTickMs();

  timerInterval = setInterval(() => {
    const elapsed  = Date.now() - exp.startTime;
    const progress = Math.min(elapsed / exp.duration, 1);
    const left     = Math.max(0, exp.duration - elapsed);

    updateProgressUI(progress, left);

    if (progress >= 1) {
      clearInterval(timerInterval);
      onPhaseComplete(exp);
    }
  }, tick);
}

function updateProgressUI(progress, leftMs) {
  const bar  = document.getElementById("mining-progress");
  const time = document.getElementById("mining-time-left");

  if (bar)  bar.style.width  = `${progress * 100}%`;
  if (time) time.textContent = progress < 1
    ? `Осталось: ${formatDuration(Math.ceil(leftMs / 1000))}`
    : "Готово!";
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE TRANSITIONS
// ─────────────────────────────────────────────────────────────────────────────
async function onPhaseComplete(exp) {
  const asteroid = ASTEROIDS.find(a => a.id === exp.asteroidId);
  if (!asteroid) return;

  if (exp.phase === "flight_to") {
    exp.phase = "mining";
    exp.currentCycleStart = null;
    await setExpedition(exp);

    renderAsteroids();
    renderMiningPanel(exp, asteroid);
    showToast(`🛬 Прибыли на ${asteroid.name}. Начинайте добычу!`, "success");

    if (autopilotRunning && autopilotCyclesLeft > 0) {
      await startMiningCycle(exp, asteroid);
    }

  } else if (exp.phase === "flight_back") {
    await unloadCargo();
    await setExpedition(null);
    clearInterval(timerInterval);

    const {
      autoProduceFuelFromIsotopes,
      autoRefuelFromStorage,
      normalizeFuelOnBase,
      renderResources,
      renderCargo,
    } = await import("./player.js");

    const refine = await autoProduceFuelFromIsotopes();
    if (refine && refine.fuelProduced > 0) {
      showToast(
        `⚗️ Авторефайн: ☢️ −${refine.isotopeUsed} → ⛽ +${refine.fuelProduced}л`,
        "info"
      );
    }

    await autoRefuelFromStorage();
    await normalizeFuelOnBase();

    renderResources();
    renderFuel();
    renderCargo();
    hideMiningStatus();
    renderAsteroids();
    showToast("🏠 Вернулись на базу! Трюм разгружен.", "success");
    checkNewPlayerHint();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MINING PANEL
// ─────────────────────────────────────────────────────────────────────────────
function renderMiningPanel(exp, asteroid) {
  const statusEl = document.getElementById("mining-status");
  if (!statusEl) return;

  statusEl.classList.remove("hidden");
  document.getElementById("mining-asteroid-name").textContent =
    `${asteroid.icon} ${asteroid.name} — Цикл ${exp.cyclesDone + 1}`;

  const full    = isCargoFull();
  const hasFuel = canStartCycle(asteroid);
  const inCycle = !!exp.currentCycleStart;

  const mineBtn = document.getElementById("btn-collect");
  if (mineBtn) {
    if (full) {
      mineBtn.textContent = "🔙 Трюм полон — Лететь домой";
      mineBtn.classList.remove("hidden");
      mineBtn.onclick = () => startReturnFlight(exp, asteroid);
    } else if (!inCycle && hasFuel) {
      mineBtn.textContent = "⛏ Начать цикл добычи";
      mineBtn.classList.remove("hidden");
      mineBtn.onclick = () => startMiningCycle(exp, asteroid);
    } else if (!inCycle && !hasFuel) {
      mineBtn.textContent = "⛽ Мало топлива — Лететь домой";
      mineBtn.classList.remove("hidden");
      mineBtn.onclick = () => startReturnFlight(exp, asteroid);
    } else {
      mineBtn.classList.add("hidden");
    }
  }

  const returnBtn = document.getElementById("btn-return-early");
  if (returnBtn && !inCycle) {
    returnBtn.classList.remove("hidden");
    returnBtn.onclick = () => startReturnFlight(exp, asteroid);
  } else if (returnBtn) {
    returnBtn.classList.add("hidden");
  }

  renderAutopilotButton(exp, asteroid, inCycle, full, hasFuel);

  const fuelInfoEl = document.getElementById("mining-fuel-info");
  if (fuelInfoEl) {
    const fuelNow         = getFuel();
    const fuelReturnNow   = fuelForReturnNow(asteroid);
    const fuelCycle       = fuelForCycle();
    const fuelReturnAfter = fuelForReturnAfterCycle(asteroid);

    const canMineMore     = fuelNow >= fuelCycle + fuelReturnAfter;

    let infoText = `⛽ ${Math.floor(fuelNow)}л  |  🏠 Домой сейчас: ~${Math.ceil(fuelReturnNow)}л`;

    if (!full && !inCycle) {
      if (canMineMore) {
        infoText +=   `|  ⛏ Цикл+возврат: ~${Math.ceil(fuelCycle + fuelReturnAfter)}л`;
      } else {
        infoText +=   `|  ⚠️ Цикл+возврат: ~${Math.ceil(fuelCycle + fuelReturnAfter)}л — не хватает`;
      }
    }

    fuelInfoEl.textContent = infoText;
    fuelInfoEl.className = fuelNow < fuelReturnNow * 1.05
      ? "mining-fuel-info fuel-low"
      : "mining-fuel-info";
  }

  renderCargo();
}

function renderAutopilotButton(exp, asteroid, inCycle, full, hasFuel) {
  const cap = getAutopilotCycles();
  let btn = document.getElementById("btn-autopilot");

  if (!btn) {
    btn = document.createElement("button");
    btn.id = "btn-autopilot";
    btn.className = "btn-secondary hidden";
    const mineBtn = document.getElementById("btn-collect");
    mineBtn?.parentNode?.insertBefore(btn, mineBtn.nextSibling);
  }

  if (cap <= 0 || full || inCycle || !hasFuel) {
    btn.classList.add("hidden");
    return;
  }

  btn.classList.remove("hidden");

  if (autopilotRunning) {
    btn.textContent = `🤖 Автопилот: осталось ${autopilotCyclesLeft} цикл${pluralRu(autopilotCyclesLeft,"","а","ов")} — Стоп`;
    btn.onclick = () => {
      stopAutopilot();
      showToast("🤖 Автопилот остановлен.", "info");
      renderMiningPanel(exp, asteroid);
    };
  } else {
    btn.textContent = `🤖 Автопилот (${cap} цикл${pluralRu(cap,"","а","ов")})`;
    btn.onclick = async () => {
      autopilotCyclesLeft = cap;
      autopilotRunning    = true;
      showToast(`🤖 Автопилот запущен на ${cap} цикл${pluralRu(cap,"","а","ов")}.`, "info");
      await startMiningCycle(exp, asteroid);
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEARCHED ASTEROIDS
// ─────────────────────────────────────────────────────────────────────────────
function getSearchedAsteroids() {
  try {
    const raw = localStorage.getItem("searched_asteroids");
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

function markAsteroidSearched(asteroidId) {
  const set = getSearchedAsteroids();
  set.add(asteroidId);
  localStorage.setItem("searched_asteroids", JSON.stringify([...set]));
}

// ─────────────────────────────────────────────────────────────────────────────
// MINING CYCLE
// ─────────────────────────────────────────────────────────────────────────────
async function startMiningCycle(exp, asteroid) {
  if (!canStartCycle(asteroid)) {
    showToast("⛽ Нет топлива на цикл + возврат. Летим домой.", "warning");
    stopAutopilot();
    await startReturnFlight(exp, asteroid);
    return;
  }

  const cleared = getClearedAsteroids();
  const stealth  = Math.max(0.05, getGuardStealthMultiplier());
  const baseGuard = asteroid.guardChance ?? 0;
  const guardP   = Math.min(0.95, baseGuard / stealth);

  if (baseGuard > 0 && !cleared.has(asteroid.id) && Math.random() < guardP) {
    if (autopilotRunning) {
      const bypass = Math.max(0, getAutopilotGuardIgnoreChance());
      if (Math.random() * 100 < bypass) {
        showToast("🤖 Автопилот обошёл патруль. Шум ушёл в помехи.", "info");
        await beginCycleTimer(exp, asteroid);
        return;
      }
      stopAutopilot();
      showToast("🤖 Автопилот остановлен: охрана в зоне.", "warning");
    }

    const enemy = pickEnemy(asteroid.tier);
    const enemyCfg = pickEnemy(asteroid.tier);
    if (!enemyCfg) {
       await beginCycleTimer(exp, asteroid);
       return;
    }

    showCombatModal(
      enemyCfg,
      async (resultState) => {
        const res = resultState.result;
        
        // --- ПРИМЕНЯЕМ ЗАТРАТЫ ИЗ БОЯ (Сброс груза, Топливо) ---
        const { spendFuel, getCargo, jettisonCargo } = await import("./player.js");
        if (resultState.economy?.spentFuel > 0) {
          await spendFuel(resultState.economy.spentFuel);
          showToast(`⛽ Сожжено в бою: ${resultState.economy.spentFuel}л`, "warning");
        }
        if (resultState.economy?.dropCargoPct > 0) {
          const cargoMap = getCargo();
          let dumpedTotal = 0;
          for (const [rKey, rAmt] of Object.entries(cargoMap)) {
             const dAmt = Math.ceil(rAmt * Math.min(1, resultState.economy.dropCargoPct));
             if (dAmt > 0) {
                 await jettisonCargo(rKey, dAmt);
                 dumpedTotal += dAmt;
             }
          }
          if (dumpedTotal > 0) showToast(`🛰 Сброшено ${dumpedTotal} ед. груза для ускорения`, "warning");
        }

        if (res === "win_kill" || res === "win_stealth" || res === "win_social_threat") {
          markAsteroidCleared(asteroid.id);
          renderAsteroids();
          if (res === "win_kill") {
             if (enemyCfg.reward) await addResources(enemyCfg.reward);
             showToast("Враг уничтожен. Зона чиста.", "success");
          } else {
             showToast("Охрана отступила. Можно продолжать добычу.", "success");
          }
          beginCycleTimer(exp, asteroid);
        } else if (res === "win_flee") {
          showToast("Вы ушли от погони. Возвращаемся на базу.", "info");
          startReturnFlight(exp, asteroid);
        } else if (res === "win_social_plea") {
          showToast("Вы откупились. Трюм пуст, кредиты списаны. Экстренный прыжок на базу.", "warning");
          const { getCredits, spendCredits, clearCargo, setExpedition } = await import("./player.js");
          await clearCargo();
          const creds = getCredits();
          if (creds > 500) await spendCredits(creds - 500);
          await setExpedition(null);
          renderAsteroids();
          hideMiningStatus();
        } else {
          showToast("Ваш корабль разбит. Аварийное восстановление на базе...", "error");
          const { getCredits, spendCredits, getResources, spendResources, clearCargo, setExpedition } = await import("./player.js");
          await clearCargo();
          const creds = getCredits();
          await spendCredits(Math.floor(creds / 2));
          const r = getResources();
          const cost = {};
          for (let k in r) cost[k] = Math.floor(r[k] / 2);
          await spendResources(cost);
          await setExpedition(null);
          renderAsteroids();
          hideMiningStatus();
        }
      }
    );
    return;
  }

  await beginCycleTimer(exp, asteroid);
}

async function beginCycleTimer(exp, asteroid) {
  const fuelCycle = fuelForCycle();
  const ok = await spendFuel(fuelCycle);
  if (!ok) {
    showToast("⛽ Нет топлива для добычи. Летим домой.", "warning");
    stopAutopilot();
    await startReturnFlight(exp, asteroid);
    return;
  }

  const cycleDurMs = miningCycleSec(asteroid) * 1000;

  exp.currentCycleStart = Date.now();
  exp.duration          = cycleDurMs;
  exp.startTime         = Date.now();
  await setExpedition(exp);

  renderMiningPanel(exp, asteroid);
  startCycleTimer(exp, asteroid);
}

function startCycleTimer(exp, asteroid) {
  clearInterval(timerInterval);
  const tick = timerTickMs();

  timerInterval = setInterval(() => {
    const elapsed  = Date.now() - exp.currentCycleStart;
    const total    = exp.duration;
    const progress = Math.min(elapsed / total, 1);
    const left     = Math.max(0, total - elapsed);

    updateProgressUI(progress, left);

    if (progress >= 1) {
      clearInterval(timerInterval);
      completeMiningCycle(exp, asteroid);
    }
  }, tick);
}

async function completeMiningCycle(exp, asteroid) {
  let drop = rollDrop(asteroid.dropPerCycle);
  const y = Math.max(0.05, getMiningYieldMultiplier());

  for (const k of Object.keys(drop)) {
    if (drop[k] > 0) drop[k] = Math.max(1, Math.floor(drop[k] * y));
  }

  const capMass = Math.max(5, getCargoCapacity() * DROP_MASS_CAP_FRACTION);
  drop = capDropByMass(drop, capMass);

  const { upgraded, log: upgradeLog } = applyOreUpgrade(drop);

  const results = {};
  for (const [res, amt] of Object.entries(upgraded)) {
    if (amt > 0) results[res] = await addToCargo(res, amt);
  }

  exp.cyclesDone++;
  exp.currentCycleStart = null;
  await setExpedition(exp);

  // ── Находка на первом цикле (один раз за игру на каждый астероид) ──
  if (exp.cyclesDone === 1 && !getSearchedAsteroids().has(asteroid.id)) {
    markAsteroidSearched(asteroid.id);
    _tryFindLostModule(asteroid);
  }

  const resStr = Object.entries(results)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${resIcon(k)} +${v}`)
    .join("  ");

  const extra = upgradeLog.length ? ` (${upgradeLog.join(" ")})` : "";
  showToast(`⛏ Цикл ${exp.cyclesDone}: ${resStr}${extra}`, "success");

  if (isCargoFull()) {
    showToast("🗃️ Трюм полон! Летим домой.", "info");
    stopAutopilot();
    renderMiningPanel(exp, asteroid);
    renderFuel();
    return;
  }

  if (autopilotRunning) {
    autopilotCyclesLeft--;
    if (autopilotCyclesLeft <= 0) {
      stopAutopilot();
      showToast("🤖 Автопилот завершил все циклы.", "info");
      renderMiningPanel(exp, asteroid);
      renderFuel();
      return;
    }

    renderMiningPanel(exp, asteroid);
    renderFuel();
    await sleep(200);
    await startMiningCycle(exp, asteroid);
    return;
  }

  renderMiningPanel(exp, asteroid);
  renderFuel();
}

// ─────────────────────────────────────────────────────────────────────────────
// FOUND MODULE
// ─────────────────────────────────────────────────────────────────────────────
async function _tryFindLostModule(asteroid) {
  const apiKey = (localStorage.getItem("openrouter_api_key") ?? "").trim();
  if (!apiKey) return;

  showToast("🔦 Бур зацепил что-то нехарактерное в породе...", "info");

  try {
    const artifact = await generateFoundModule(asteroid.tier, apiKey, asteroid.name);
    if (!artifact) return;

    const rarityWeight = {
      bad:1.0, common:1.4, improved:2.2,
      quality:3.4, elite:5.2, perfect:8.0,
    };

    const found = {
      ...artifact,
      original:  true,
      id:        "found_" + Math.random().toString(36).slice(2, 10),
      ownerId:   getUid(),
      ownerName: getState().name,
      createdAt: Date.now(),
      weight:    rarityWeight[artifact.rarity] ?? 1.0,
      foundOn:   asteroid.name,
    };

    await addToInventory(found);
    renderInventory();
    showToast(
      `💀 Находка: «${found.name}» [${found.rarity}] — добавлено в инвентарь`,
      "success"
    );

  } catch (e) {
    console.warn("[Mining] _tryFindLostModule error:", e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EMERGENCY JETTISON
// ─────────────────────────────────────────────────────────────────────────────
const JETTISON_ORDER = ["isotopes", "minerals", "metals", "data", "alloys"]; // от дешёвого к дорогому
const JETTISON_STEP  = 3;

async function emergencyJettison(asteroid) {
  const { getCargo, jettisonCargo } = await import("./player.js");
  const log = [];

  let maxIterations = 200;
  while (maxIterations-- > 0) {
    const fuelNeeded = calcFuelForFlight(asteroid.distance, getCargoMass());
    if (getFuel() >= fuelNeeded) break;

    const cargo = getCargo();
    let dropped = false;

    for (const res of JETTISON_ORDER) {
      const have = cargo[res] ?? 0;
      if (have <= 0) continue;

      const amount = Math.min(JETTISON_STEP, have);
      await jettisonCargo(res, amount);
      log.push(`${resIcon(res)} −${amount}`);
      dropped = true;
      break;
    }

    if (!dropped) {
      return { success: false, log };
    }
  }

  return { success: true, log };
}

// ─────────────────────────────────────────────────────────────────────────────
// RETURN
// ─────────────────────────────────────────────────────────────────────────────
async function startReturnFlight(exp, asteroid) {
  stopAutopilot();

  let fuelReturn = calcFuelForFlight(asteroid.distance, getCargoMass());

  if (getFuel() < fuelReturn) {
    showToast("⚠️ Топлива не хватает на возврат. Сбрасываем груз...", "warning");
    const { success, log } = await emergencyJettison(asteroid);

    if (log.length > 0) {
      showToast(`🛰 Выброшено за борт: ${log.join("  ")}`, "warning");
    }

    if (!success) {
      showToast("🆘 Трюм пуст, топлива всё равно мало. Аварийный дрейф домой.", "warning");
      const allFuel = getFuel();
      await spendFuel(allFuel);
    } else {
      fuelReturn = calcFuelForFlight(asteroid.distance, getCargoMass());
      const ok = await spendFuel(fuelReturn);
      if (!ok) {
        await spendFuel(getFuel());
      }
    }
  } else {
    await spendFuel(fuelReturn);
  }

  const timeBack = flightTimeBackSec(asteroid) * 1000;

  exp.phase             = "flight_back";
  exp.startTime         = Date.now();
  exp.duration          = timeBack;
  exp.currentCycleStart = null;

  await setExpedition(exp);

  renderAsteroids();
  showReturnStatus(asteroid);
  startPhaseTimer(exp);

  const btn = document.getElementById("btn-return-early");
  if (btn) btn.classList.add("hidden");

  const apBtn = document.getElementById("btn-autopilot");
  if (apBtn) apBtn.classList.add("hidden");

  showToast(`🔙 Летим домой. Расход: ${Math.ceil(fuelReturn)}л`, "info");
}

// ─────────────────────────────────────────────────────────────────────────────
// UI STATUS
// ─────────────────────────────────────────────────────────────────────────────
function showExpeditionStatus(exp) {
  const statusEl = document.getElementById("mining-status");
  if (!statusEl) return;

  statusEl.classList.remove("hidden");

  const asteroid = ASTEROIDS.find(a => a.id === exp.asteroidId);
  const name     = asteroid ? `${asteroid.icon} ${asteroid.name}` : "—";

  document.getElementById("mining-asteroid-name").textContent =
      exp.phase === "flight_to"   ? `✈️ Летим на ${name}`
    : exp.phase === "flight_back" ? `🔙 Летим домой с ${name}`
    : name;

  const elapsed  = Date.now() - exp.startTime;
  const progress = exp.duration > 0 ? Math.min(elapsed / exp.duration, 1) : 0;
  const bar = document.getElementById("mining-progress");
  if (bar) bar.style.width = `${progress * 100}%`;
}

function showReturnStatus(asteroid) {
  document.getElementById("mining-asteroid-name").textContent =
    `🔙 Летим домой с ${asteroid.icon} ${asteroid.name}`;

  const bar = document.getElementById("mining-progress");
  if (bar) bar.style.width = "0%";

  const btn = document.getElementById("btn-collect");
  if (btn) btn.classList.add("hidden");
}

function hideMiningStatus() {
  const statusEl = document.getElementById("mining-status");
  if (statusEl) statusEl.classList.add("hidden");

  const btn = document.getElementById("btn-collect");
  if (btn) btn.classList.add("hidden");

  const ret = document.getElementById("btn-return-early");
  if (ret) ret.classList.add("hidden");

  const ap  = document.getElementById("btn-autopilot");
  if (ap) ap.classList.add("hidden");
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────
function rollDrop(dropTable) {
  const result = {};
  for (const [res, [min, max]] of Object.entries(dropTable)) {
    result[res] = max === 0 ? 0 : Math.floor(Math.random() * (max - min + 1)) + min;
  }
  return result;
}

function resIcon(key) {
  return {
    isotopes: "☢️",
    minerals: "🪨",
    metals:   "⚙️",
    data:     "💾",
    alloys:   "🔩",  // ← новое
  }[key] ?? key;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function pluralRu(n, one, few, many) {
  const mod10  = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function formatDuration(seconds) {
  if (seconds < 60)   return `${seconds}с`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}м ${s}с` : `${m}м`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}ч ${m}м` : `${h}ч`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h > 0 ? `${d}д ${h}ч` : `${d}д`;
}

// ─────────────────────────────────────────────────────────────────────────────
// WINDOW EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
window._startExpedition = startExpedition;
window._renderAsteroids = renderAsteroids;