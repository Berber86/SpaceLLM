const UID_KEY = "cosmicForge.uid";
const OPENROUTER_KEY = "cosmicForge.openrouterKey";

function makeUid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `uid_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function getOrCreateUid() {
  let uid = localStorage.getItem(UID_KEY);
  if (!uid) {
    uid = makeUid();
    localStorage.setItem(UID_KEY, uid);
  }
  return uid;
}

export function getOpenRouterKey() {
  return localStorage.getItem(OPENROUTER_KEY) || "";
}

export function setOpenRouterKey(key) {
  localStorage.setItem(OPENROUTER_KEY, key.trim());
}