// firebase.js — инициализация и CRUD-обёртки для Realtime Database

const FIREBASE_CONFIG_BASE = {
  authDomain: "prototypeciva.firebaseapp.com",
  databaseURL: "https://prototypeciva-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "prototypeciva",
  storageBucket: "prototypeciva.firebasestorage.app",
  messagingSenderId: "191956270979",
  appId: "1:191956270979:web:dc850a748171a8304080b6",
};

let db = null;

// ─────────────────────────────────────────────────────────────────────────────
export function initFirebase() {
  const apiKey = localStorage.getItem("firebase_api_key");
  if (!apiKey) return false;

  if (db) return true;
  
  try {
    const config = { ...FIREBASE_CONFIG_BASE, apiKey };
    const app = firebase.initializeApp(config);
    db = firebase.database(app);
    return true;
  } catch (e) {
    try {
      db = firebase.database(firebase.app());
      return true;
    } catch {
      console.error("Firebase init error:", e);
      return false;
    }
  }
}

export function getDb() { return db; }

// ── Игрок ─────────────────────────────────────────────────────────────────
export async function loadPlayer(uid) {
  const snap = await db.ref(`/players/${uid}`).get();
  return snap.exists() ? snap.val() : null;
}

export async function savePlayer(uid, data) {
  await db.ref(`/players/${uid}`).set(data);
}

export async function updatePlayer(uid, partial) {
  await db.ref(`/players/${uid}`).update(partial);
}

// ── Рынок ─────────────────────────────────────────────────────────────────
export async function publishToMarket(item) {
  const ref = db.ref("/market").push();
  await ref.set({ ...item, id: ref.key, salesCount: 0 });
  return ref.key;
}

export function subscribeMarket(callback) {
  db.ref("/market")
    .orderByChild("createdAt")
    .limitToLast(60)
    .on("value", snap => {
      const items = [];
      snap.forEach(child => items.push(child.val()));
      callback(items.reverse());
    });
}

export function unsubscribeMarket() {
  db?.ref("/market").off();
}

// ── Счётчик продаж (идея 10) ───────────────────────────────────────────────
export async function incrementSaleCount(marketItemId) {
  const ref = db.ref(`/market/${marketItemId}/salesCount`);
  await ref.transaction(current => (current ?? 0) + 1);
}