// app.js — точка входа, инициализация, навигация, настройки

import { initFirebase }  from "./firebase.js";
import {
  initPlayer, renderResources, renderInventory,
  setPlayerName, getState, showToast,
  checkNewPlayerHint, renderFuel, renderCredits,
  getUid, addToInventory, ITEM_SCHEMA_VERSION,
} from "./player.js";
import { initMining }    from "./mining.js";
import { initForge }     from "./forge.js";
import { initWorkshop }  from "./workshop.js";
import { initMarket }    from "./market.js";
import { initCombat, renderEquipmentSlots } from "./combat.js";

// ─────────────────────────────────────────────────────────────────────────────
// СТАРТОВЫЙ МОДУЛЬ
// ─────────────────────────────────────────────────────────────────────────────

const STARTER_AUTOPILOT = {
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

  name: "УП-3 «Черепаха»",

  description:
    "Учебный автопилот третьего поколения, списанный с флота ещё до твоего рождения. " +
    "Корпус исцарапан, разъёмы окислены, прошивка обновлялась последний раз когда ты ещё пешком под стол ходил. " +
    "Тем не менее — запускается, держит курс, выполняет циклы. " +
    "Пять циклов подряд без твоих рук на штурвале. Негусто, но для начала сойдёт.",

  flavor:
    "Достал из ящика с надписью «УТИЛЬ». Подключил.\n" +
    "Оно пикнуло. Я чуть не выронил кофе.\n" +
    "Запустил тест — прошёл. Медленно, с хрипами, но прошёл.\n" +
    "На корпусе чья-то гравировка: «Не трогай реле №4».\n" +
    "Реле №4 я, конечно, потрогал. Всё нормально, кажется.\n" +
    "Буду использовать пока не сломается. Или пока не найду что-то лучше.",

  effects: {
    autopilot_cycles_add: 5,
  },

  stats: {
    "Автоциклы добычи": "+5 циклов",
  },
};

async function giveStarterModule() {
  if (localStorage.getItem("starter_module_given")) return;

  const module = {
    ...STARTER_AUTOPILOT,
    ownerId:   getUid(),
    ownerName: getState().name,
    createdAt: Date.now(),
  };

  await addToInventory(module);
  renderInventory();
  localStorage.setItem("starter_module_given", "1");

  showToast("🎁 В ящике нашёлся старый автопилот УП-3 «Черепаха». Проверь инвентарь.", "info");
}

// ─────────────────────────────────────────────────────────────────────────────
// ТОЧКА ВХОДА
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const hasFirebase   = !!localStorage.getItem("firebase_api_key");
  const hasOpenRouter = !!localStorage.getItem("openrouter_api_key");

  if (!hasFirebase || !hasOpenRouter) {
    showSetup();
    return;
  }

  await startGame();
}

// ─────────────────────────────────────────────────────────────────────────────
// ЗАПУСК ИГРЫ
// ─────────────────────────────────────────────────────────────────────────────

async function startGame() {
  const ok = initFirebase();
  if (!ok) {
    showSetup("Не удалось подключиться к Firebase. Проверьте API-ключ.");
    return;
  }

  try {
    await initPlayer();
  } catch (e) {
    showSetup(`Ошибка Firebase: ${e.message}`);
    return;
  }

  renderResources();
  renderFuel();
  renderCredits();
  checkNewPlayerHint();

  // initCombat до initMining — mining читает экипировку
  initCombat();
  initMining();
  initForge();
  initWorkshop();
  initMarket();

  setupNavigation();
  setupSettingsModal();

  document.getElementById("screen-setup").classList.add("hidden");
  document.getElementById("screen-setup").classList.remove("active");

  const gameScreen = document.getElementById("screen-game");
  gameScreen.classList.remove("hidden");
  gameScreen.classList.add("active");

  // Стартовый модуль — после всех init чтобы player точно готов
  await giveStarterModule();
}

// ─────────────────────────────────────────────────────────────────────────────
// ЭКРАН ПЕРВИЧНОЙ НАСТРОЙКИ
// ─────────────────────────────────────────────────────────────────────────────

function showSetup(errorMsg) {
  const setupScreen = document.getElementById("screen-setup");
  const gameScreen  = document.getElementById("screen-game");

  setupScreen.classList.remove("hidden");
  setupScreen.classList.add("active");
  gameScreen.classList.add("hidden");
  gameScreen.classList.remove("active");

  document.getElementById("input-firebase-key").value =
    localStorage.getItem("firebase_api_key") ?? "";
  document.getElementById("input-openrouter-key").value =
    localStorage.getItem("openrouter_api_key") ?? "";

  if (errorMsg) {
    const el = document.getElementById("setup-error");
    el.textContent = errorMsg;
    el.classList.remove("hidden");
  }

  document.getElementById("btn-save-keys").addEventListener("click", async () => {
    const fbKey = document.getElementById("input-firebase-key").value.trim();
    const orKey = document.getElementById("input-openrouter-key").value.trim();
    const errEl = document.getElementById("setup-error");

    if (!fbKey || !orKey) {
      errEl.textContent = "Заполните оба поля.";
      errEl.classList.remove("hidden");
      return;
    }

    errEl.classList.add("hidden");
    localStorage.setItem("firebase_api_key",   fbKey);
    localStorage.setItem("openrouter_api_key", orKey);

    await startGame();
  }, { once: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// НАВИГАЦИЯ
// ─────────────────────────────────────────────────────────────────────────────

function setupNavigation() {
  const tabBtns     = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");

  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;

      tabBtns.forEach(b     => b.classList.remove("active"));
      tabContents.forEach(c => c.classList.add("hidden"));

      btn.classList.add("active");
      document.getElementById(`tab-${target}`)?.classList.remove("hidden");

      if (target === "inventory") {
        renderInventory();
        renderEquipmentSlots();
      }

      if (target === "forge") {
        try {
          if (typeof window._renderForge === "function") window._renderForge();
        } catch {}
      }

      if (target === "workshop") {
        try {
          if (typeof window._renderWorkshop === "function") window._renderWorkshop();
        } catch {}
      }

      if (target === "mining") {
        try {
          if (typeof window._renderAsteroids === "function") window._renderAsteroids();
        } catch {}
      }

      if (target === "market") {
        import("./market.js").then(({ initMarket: _i, ...m }) => {
          if (typeof m.renderFuelMarket === "function") m.renderFuelMarket();
          if (typeof m.renderResourceMarket === "function") m.renderResourceMarket();
        });
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// МОДАЛКА НАСТРОЕК
// ─────────────────────────────────────────────────────────────────────────────

function setupSettingsModal() {
  const modal    = document.getElementById("modal-settings");
  const btnOpen  = document.getElementById("btn-open-settings");
  const btnClose = document.getElementById("btn-settings-close");
  const btnSave  = document.getElementById("btn-settings-save");
  const btnReset = document.getElementById("btn-reset-player");

  btnOpen.addEventListener("click", () => {
    document.getElementById("settings-firebase-key").value =
      localStorage.getItem("firebase_api_key") ?? "";
    document.getElementById("settings-openrouter-key").value =
      localStorage.getItem("openrouter_api_key") ?? "";
    document.getElementById("settings-pilot-name").value =
      getState()?.name ?? "";

    const savedScale = localStorage.getItem("time_scale") ?? "1";
    const scaleEl = document.getElementById("settings-time-scale");
    if (scaleEl) scaleEl.value = ["1","3","10","100"].includes(savedScale) ? savedScale : "1";

    const confirmZone = document.getElementById("reset-confirm-zone");
    if (confirmZone) confirmZone.classList.add("hidden");

    modal.classList.remove("hidden");
  });

  btnClose.addEventListener("click", () => modal.classList.add("hidden"));

  modal.addEventListener("click", e => {
    if (e.target === modal) modal.classList.add("hidden");
  });

  btnSave.addEventListener("click", async () => {
    const fbKey = document.getElementById("settings-firebase-key").value.trim();
    const orKey = document.getElementById("settings-openrouter-key").value.trim();
    const name  = document.getElementById("settings-pilot-name").value.trim();
    const scale = document.getElementById("settings-time-scale")?.value ?? "1";

    if (fbKey) localStorage.setItem("firebase_api_key",   fbKey);
    if (orKey) localStorage.setItem("openrouter_api_key", orKey);
    if (name)  await setPlayerName(name);

    localStorage.setItem("time_scale", ["1","3","10","100"].includes(scale) ? scale : "1");

    modal.classList.add("hidden");
    showToast("✅ Настройки сохранены.", "success");

    try {
      if (typeof window._renderAsteroids === "function") window._renderAsteroids();
      if (typeof window._renderForge === "function") window._renderForge();
    } catch {}
  });

  if (btnReset) {
    btnReset.addEventListener("click", () => {
      const confirmZone = document.getElementById("reset-confirm-zone");
      if (confirmZone) confirmZone.classList.remove("hidden");
    });
  }

  const btnResetConfirm = document.getElementById("btn-reset-confirm");
  const btnResetCancel  = document.getElementById("btn-reset-cancel");

  if (btnResetConfirm) {
    btnResetConfirm.addEventListener("click", async () => {
      await resetPlayer();
      modal.classList.add("hidden");
    });
  }

  if (btnResetCancel) {
    btnResetCancel.addEventListener("click", () => {
      const confirmZone = document.getElementById("reset-confirm-zone");
      if (confirmZone) confirmZone.classList.add("hidden");
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// СБРОС ИГРОКА
// ─────────────────────────────────────────────────────────────────────────────

async function resetPlayer() {
  const { getDb } = await import("./firebase.js");

  const uid = localStorage.getItem("player_uid");
  if (uid) {
    try {
      await getDb().ref(`/players/${uid}`).remove();
    } catch (e) {
      console.warn("Не удалось удалить данные из Firebase:", e);
    }
  }

  const keysToRemove = [
    "player_uid",
    "pilot_name",
    "forge_level",
    "equipped_slots",
    "cleared_asteroids",
    "searched_asteroids",
    "starter_module_given",  // ← сбрасываем чтобы новый игрок получил модуль
  ];
  keysToRemove.forEach(k => localStorage.removeItem(k));

  showToast("🗑️ Игрок удалён. Создаём нового пилота...", "info");
  await delay(1200);
  window.location.reload();
}

// ─────────────────────────────────────────────────────────────────────────────
// УТИЛИТЫ
// ─────────────────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
// СТАРТ
// ─────────────────────────────────────────────────────────────────────────────

main();