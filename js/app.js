import { cacheElements, els, fillForm, renderMining, renderPlayer, setStatus } from "./ui.js";
import { getOrCreateUid, getOpenRouterKey, setOpenRouterKey } from "./storage.js";
import { state, normalizePlayer } from "./state.js";
import { loadPlayer, savePlayer as savePlayerToDb } from "./firebase.js";

const RESOURCE_LABELS = {
  isotopes: "Изотопы",
  minerals: "Минералы",
  metals: "Металлы",
  data: "Данные"
};

let miningTickHandle = null;
let miningTickRunning = false;

async function loadOrCreatePlayer(uid) {
  const raw = await loadPlayer(uid);
  const player = normalizePlayer(uid, raw);
  
  if (!raw) {
    await savePlayerToDb(uid, player);
  }
  
  return player;
}

function syncPlayerFromUI() {
  state.player.displayName = els.displayName.value.trim() || "Пилот";
  state.player.updatedAt = Date.now();
}

function getMiningJob() {
  return state.player?.activeJobs?.mining || null;
}

async function saveProfile() {
  syncPlayerFromUI();
  await savePlayerToDb(state.uid, state.player);
  renderPlayer(state);
}

async function startMining(resourceType, baseDurationSec) {
  if (getMiningJob()) {
    setStatus("Сначала заверши или отмени текущую добычу");
    return;
  }
  
  const miningSpeed = Number(state.player.stats?.miningSpeed || 1);
  const durationSec = Math.max(10, Math.round(baseDurationSec / miningSpeed));
  const rewardAmount = Math.max(1, Math.round(baseDurationSec / 10));
  const now = Date.now();
  
  state.player.activeJobs.mining = {
    resourceType,
    startedAt: now,
    endsAt: now + durationSec * 1000,
    durationSec,
    rewardAmount,
    status: "running"
  };
  state.player.updatedAt = now;
  
  await savePlayerToDb(state.uid, state.player);
  renderPlayer(state);
  renderMining(state);
  setStatus(`Добыча началась: ${RESOURCE_LABELS[resourceType]} на ${durationSec}с`);
}

async function completeMiningJob() {
  const job = getMiningJob();
  if (!job) return;
  
  const resourceType = job.resourceType;
  const rewardAmount = Number(job.rewardAmount || 1);
  
  state.player.resources[resourceType] = (state.player.resources[resourceType] || 0) + rewardAmount;
  state.player.activeJobs.mining = null;
  state.player.updatedAt = Date.now();
  
  await savePlayerToDb(state.uid, state.player);
  renderPlayer(state);
  renderMining(state);
  setStatus(`Добыча завершена: +${rewardAmount} ${RESOURCE_LABELS[resourceType] || resourceType}`);
}

async function cancelMiningJob() {
  if (!getMiningJob()) {
    setStatus("Нет активной добычи");
    return;
  }
  
  state.player.activeJobs.mining = null;
  state.player.updatedAt = Date.now();
  
  await savePlayerToDb(state.uid, state.player);
  renderPlayer(state);
  renderMining(state);
  setStatus("Добыча отменена");
}

async function tickMining() {
  if (miningTickRunning || !state.player) return;
  
  miningTickRunning = true;
  
  try {
    const job = getMiningJob();
    
    if (!job) {
      renderMining(state);
      return;
    }
    
    renderMining(state);
    
    if (Date.now() >= job.endsAt) {
      await completeMiningJob();
    }
  } catch (error) {
    console.error(error);
    setStatus("Ошибка обновления майнинга");
  } finally {
    miningTickRunning = false;
  }
}

function startTicker() {
  if (miningTickHandle) clearInterval(miningTickHandle);
  
  miningTickHandle = setInterval(() => {
    tickMining();
  }, 1000);
}

function wireEvents() {
  els.savePlayer.addEventListener("click", async () => {
    try {
      setStatus("Сохраняю профиль...");
      await saveProfile();
      setStatus("Профиль сохранён");
    } catch (error) {
      console.error(error);
      setStatus("Ошибка сохранения профиля");
    }
  });
  
  els.reloadPlayer.addEventListener("click", async () => {
    try {
      setStatus("Загружаю игрока...");
      state.player = normalizePlayer(state.uid, await loadPlayer(state.uid));
      fillForm(state);
      renderPlayer(state);
      renderMining(state);
      setStatus("Данные загружены");
    } catch (error) {
      console.error(error);
      setStatus("Ошибка загрузки");
    }
  });
  
  els.saveKey.addEventListener("click", () => {
    state.openrouterKey = els.openrouterKey.value.trim();
    setOpenRouterKey(state.openrouterKey);
    setStatus("OpenRouter key сохранён локально");
  });
  
  els.mineButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const durationSec = Number(button.dataset.seconds || 0);
        const resourceType = els.mineResource.value;
        await startMining(resourceType, durationSec);
      } catch (error) {
        console.error(error);
        setStatus("Ошибка запуска добычи");
      }
    });
  });
  
  els.cancelMining.addEventListener("click", async () => {
    try {
      await cancelMiningJob();
    } catch (error) {
      console.error(error);
      setStatus("Ошибка отмены добычи");
    }
  });
}

async function boot() {
  try {
    cacheElements();
    
    state.uid = getOrCreateUid();
    state.openrouterKey = getOpenRouterKey();
    
    setStatus("Загрузка игрока...");
    state.player = await loadOrCreatePlayer(state.uid);
    
    fillForm(state);
    renderPlayer(state);
    renderMining(state);
    
    wireEvents();
    startTicker();
    
    setStatus("Готово");
    await tickMining();
  } catch (error) {
    console.error(error);
    setStatus(`Ошибка старта: ${error.message}`);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}