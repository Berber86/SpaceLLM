const RESOURCE_LABELS = {
  isotopes: "Изотопы",
  minerals: "Минералы",
  metals: "Металлы",
  data: "Данные"
};

export const els = {};

export function cacheElements() {
  Object.assign(els, {
    status: document.getElementById("status"),
    uid: document.getElementById("uid"),
    displayName: document.getElementById("displayName"),
    openrouterKey: document.getElementById("openrouterKey"),
    savePlayer: document.getElementById("savePlayer"),
    reloadPlayer: document.getElementById("reloadPlayer"),
    saveKey: document.getElementById("saveKey"),
    isotopes: document.getElementById("r-isotopes"),
    minerals: document.getElementById("r-minerals"),
    metals: document.getElementById("r-metals"),
    data: document.getElementById("r-data"),
    mineResource: document.getElementById("mineResource"),
    mineButtons: Array.from(document.querySelectorAll(".mine-btn")),
    miningState: document.getElementById("miningState"),
    miningRemaining: document.getElementById("miningRemaining"),
    miningReward: document.getElementById("miningReward"),
    cancelMining: document.getElementById("cancelMining")
  });
  
  const missing = Object.entries(els)
    .filter(([, value]) => value == null)
    .map(([key]) => key);
  
  if (missing.length) {
    throw new Error(`Не найдены элементы в DOM: ${missing.join(", ")}`);
  }
}

function formatRemaining(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  
  if (minutes > 0) {
    return `${minutes}м ${String(seconds).padStart(2, "0")}с`;
  }
  
  return `${seconds}с`;
}

export function setStatus(text) {
  els.status.textContent = text;
}

export function fillForm(state) {
  if (!state?.player) return;
  
  els.displayName.value = state.player.displayName || "";
  els.openrouterKey.value = state.openrouterKey || "";
}

export function renderPlayer(state) {
  if (!state?.player) return;
  
  els.uid.textContent = state.uid || "—";
  els.isotopes.textContent = state.player.resources?.isotopes ?? 0;
  els.minerals.textContent = state.player.resources?.minerals ?? 0;
  els.metals.textContent = state.player.resources?.metals ?? 0;
  els.data.textContent = state.player.resources?.data ?? 0;
}

export function renderMining(state) {
  const job = state?.player?.activeJobs?.mining || null;
  
  if (!job) {
    els.miningState.textContent = "Нет активной добычи";
    els.miningRemaining.textContent = "—";
    els.miningReward.textContent = "—";
    els.cancelMining.disabled = true;
    els.mineResource.disabled = false;
    els.mineButtons.forEach((button) => {
      button.disabled = false;
    });
    return;
  }
  
  const remainingMs = job.endsAt - Date.now();
  const resourceName = RESOURCE_LABELS[job.resourceType] || job.resourceType;
  
  els.miningState.textContent = `Добывается: ${resourceName}`;
  els.miningRemaining.textContent = remainingMs > 0 ? formatRemaining(remainingMs) : "завершение...";
  els.miningReward.textContent = `+${job.rewardAmount} ${resourceName}`;
  els.cancelMining.disabled = false;
  els.mineResource.disabled = true;
  els.mineButtons.forEach((button) => {
    button.disabled = true;
  });
}