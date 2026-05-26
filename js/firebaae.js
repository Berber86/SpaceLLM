import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDatabase,
  ref,
  get,
  set
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyDU4YCIWRFLjMz2eDqmKgoGEYKbQUb5s4U",
  authDomain: "prototypeciva.firebaseapp.com",
  databaseURL: "https://prototypeciva-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "prototypeciva",
  storageBucket: "prototypeciva.firebasestorage.app",
  messagingSenderId: "191956270979",
  appId: "1:191956270979:web:dc850a748171a8304080b6"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

export async function loadPlayer(uid) {
  const snap = await get(ref(db, `players/${uid}`));
  return snap.exists() ? snap.val() : null;
}

export async function savePlayer(uid, player) {
  await set(ref(db, `players/${uid}`), player);
}