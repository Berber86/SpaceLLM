// combat_deck.js — Combat Deck (LLM Cards) (v4)
// CHANGES v4:
// - карты теперь содержат 3 действия: actions[0..1] — нормальные, actions[2] — chaos
// - chaos action: role="chaos", mult из CHAOS_MULT_ZONES, LLM объясняет абсурдную причину
// - промпт явно разделяет нормальные и chaos действия
// - normalizeCard валидирует все три действия
// - CHAOS_FLAVOR_HINTS из actions.js идут в промпт как подсказки

import * as PlayerAPI from "./player.js";
import {
  ACTION_TYPES,
  CARD_ACTIONS,
  CHAOS_MULT_ZONES,
  CHAOS_FLAVOR_HINTS,
  isActionType,
  rollChaosMult,
  getChaosFlavorHint,
} from "./actions.js";

const HYDRA_API_URL = "https://api.hydraai.ru/v1/chat/completions";
const HYDRA_MODEL   = "hydra-gemini";

const CACHE_KEY = "combat_cards_cache_v2";
const RATE_KEY  = "hydra_deck_calls_v1";

const RATE_LIMIT_MAX       = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
const DECK_SIZE_EXPECTED   = 10;

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────

function safeJsonParse(str, fallback) {
  try {
    const v = JSON.parse(str);
    return (v === null || v === undefined) ? fallback : v;
  } catch { return fallback; }
}

function extractJsonArray(raw) {
  let t = String(raw ?? "").trim();
  t = t.replace(/```json/gi, "").replace(/```/g, "").trim();
  const a = t.indexOf("[");
  const b = t.lastIndexOf("]");
  if (a !== -1 && b !== -1 && b > a) t = t.slice(a, b + 1);
  return t;
}

function clamp(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function comboKey(id1, id2) {
  return ["COMBO", ...[id1, id2].sort()].join("__+__");
}

function showToastMaybe(msg, type = "info") {
  const fn = PlayerAPI?.showToast || PlayerAPI?.default?.showToast || window.showToast;
  if (typeof fn === "function") fn(msg, type);
  else console.log("[toast]", msg);
}

function trimText(s, max = 1600) {
  s = String(s || "");
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function nowMs() { return Date.now(); }

// ─────────────────────────────────────────────────────────────
// cache
// ─────────────────────────────────────────────────────────────

function loadCache() {
  const v = safeJsonParse(localStorage.getItem(CACHE_KEY), {});
  return (v && typeof v === "object") ? v : {};
}

function saveCache(cache) {
  if (!cache || typeof cache !== "object") cache = {};
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

// ─────────────────────────────────────────────────────────────
// rate limit
// ─────────────────────────────────────────────────────────────

function rateLimitCheckAndMark() {
  const now      = nowMs();
  const arr      = safeJsonParse(localStorage.getItem(RATE_KEY), []);
  const filtered = Array.isArray(arr)
    ? arr.filter(ts => (now - ts) < RATE_LIMIT_WINDOW_MS)
    : [];

  if (filtered.length >= RATE_LIMIT_MAX) {
    const waitMs  = RATE_LIMIT_WINDOW_MS - (now - filtered[0]);
    const waitSec = Math.ceil(waitMs / 1000);
    throw new Error(`Лимит: ${RATE_LIMIT_MAX} вызовов/мин. Подожди ${waitSec}с.`);
  }

  filtered.push(now);
  localStorage.setItem(RATE_KEY, JSON.stringify(filtered));
}

// ─────────────────────────────────────────────────────────────
// hydra chat
// ─────────────────────────────────────────────────────────────

async function hydraChat({ apiKey, systemPrompt, userPrompt, temperature = 0.92, max_tokens = 2000 }) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 45_000);

  try {
    const resp = await fetch(HYDRA_API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: HYDRA_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
        temperature,
        max_tokens,
        top_p: 0.95,
        stream: false,
      }),
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Hydra API HTTP ${resp.status}: ${errText}`);
    }

    const data = await resp.json().catch(() => ({}));
    return String(data?.choices?.[0]?.message?.content ?? "").trim();
  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────────────────────────
// module normalization
// ─────────────────────────────────────────────────────────────

const WEAPON_RECIPES = new Set([
  "rocket_module", "thermal_module", "maneuvre_module",
  "kinetic_module", "stealth_module",
]);

const RECIPE_ACTION_HINTS = {
  fuel:             ["FUEL_BURN", "FUEL_IGNITE", "FULL_BURN"],
  cargo_module:     ["CARGO_JETTISON", "HULL_BRACE", "DAMAGE_CONTROL"],
  drill_module:     ["PIERCE", "ATTACK_KINETIC", "FOCUS_FIRE"],
  fuel_tank_module: ["FUEL_BURN", "FULL_BURN", "THREATEN_DETONATION"],
  engine_module:    ["FULL_BURN", "DISTANCE_PUSH", "EVADE_SPIKE"],
  plating_module:   ["HULL_BRACE", "SHIELD_SPIKE", "DAMAGE_CONTROL"],
  autopilot_module: ["DRIFT_SILENT", "SIGNAL_BLUFF", "NEGOTIATE_DELAY"],
  solar_module:     ["SHIELD_REGEN", "EMERGENCY_REPAIR", "FUEL_BURN"],
  eshield_module:   ["SHIELD_SPIKE", "EVADE_SPIKE", "SHIELD_REGEN"],
  ai_drill_module:  ["DATA_SPOOF", "DISRUPT_SENSORS", "FOCUS_FIRE"],
  rocket_module:    ["ROCKET_SALVO", "ATTACK_SHRAPNEL", "FOCUS_FIRE", "THREATEN_DETONATION"],
  thermal_module:   ["ATTACK_THERMAL", "FUEL_IGNITE", "DISRUPT_SENSORS", "ATTACK_EMP"],
  maneuvre_module:  ["EVADE_SPIKE", "DISTANCE_PUSH", "FULL_BURN", "DRIFT_SILENT"],
  kinetic_module:   ["PIERCE", "ATTACK_KINETIC", "FOCUS_FIRE", "HULL_BRACE"],
  stealth_module:   ["SENSOR_JAM", "DECOY_DUMP", "DRIFT_SILENT", "FAKE_MELTDOWN", "DATA_SPOOF"],
};

function extractHooks(statsObj) {
  let best = null, bestAbs = -1, worst = null, worstAbs = -1;
  for (const [label, val] of Object.entries(statsObj || {})) {
    const s   = String(val).trim();
    const num = parseFloat(s.replace(/[^0-9.]/g, ""));
    if (Number.isNaN(num)) continue;
    const isNeg = s.startsWith("−") || s.startsWith("-");
    const abs   = Math.abs(isNeg ? -num : num);
    if (!isNeg && abs > bestAbs)  { bestAbs = abs;  best  = `${s} — ${label}`; }
    if (isNeg  && abs > worstAbs) { worstAbs = abs; worst = `${s} — ${label}`; }
  }
  return { best, worst };
}

function normalizeModuleFull(itemLike) {
  if (!itemLike || typeof itemLike !== "object") return null;
  const id = itemLike.id || itemLike.itemId || itemLike.uid || itemLike.key;
  if (!id) return null;

  const description = String(itemLike.description || "").trim();
  const flavor      = String(itemLike.flavor || "").trim();
  const text_blob   = [description, flavor].filter(Boolean).join("\n\n").trim();
  const statsObj    = itemLike.stats || {};
  const stats_lines = Object.entries(statsObj).map(([label, v]) => `${v} — ${label}`);
  const hooks       = extractHooks(statsObj);
  const recipeType  = itemLike.recipeType || null;
  const recipeHints = (RECIPE_ACTION_HINTS[recipeType] || []).filter(isActionType);

  return {
    id: String(id),
    name: String(itemLike.name || `Модуль ${id}`),
    rarity: String(itemLike.rarity || "common"),
    recipeType,
    recipeHints,
    weight: Number(itemLike.weight || 0) || 0,
    description,
    flavor,
    text_blob,
    stats_lines,
    hooks,
    effects: itemLike.effects || {},
  };
}

function resolveEquippedModules() {
  const idsRaw = safeJsonParse(localStorage.getItem("equipped_slots"), []);
  const ids    = Array.isArray(idsRaw) ? idsRaw : [];
  const mods   = [];

  for (const id of ids) {
    if (!id) continue;
    const full = (typeof window.CF_GET_ITEM === "function") ? window.CF_GET_ITEM(id) : null;
    const m    = normalizeModuleFull(full || { id, name: id, description: "" });
    if (m) mods.push(m);
  }

  const seen = new Set();
  return mods.filter(m => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

// ─────────────────────────────────────────────────────────────
// ship tone
// ─────────────────────────────────────────────────────────────

function buildShipTone(modules) {
  const weapons = modules.filter(m => WEAPON_RECIPES.has(m.recipeType)).length;
  if (weapons >= 2) return {
    shipRole: "вооружённая баржа/корвет на коленке",
    tone: "Ты уже не шахтёр. Ты — жадный, вооружённый до зубов мудак на грузовике.",
    note: "НЕ называй корабль 'беззащитным' или 'чисто шахтёрским'.",
  };
  if (weapons === 1) return {
    shipRole: "шахтёр с одним опасным аргументом",
    tone: "Шахтёрская посудина, но с одним модулем который делает разговор коротким.",
    note: "Можно упоминать что ты 'ещё шахтёр', но уже с зубами.",
  };
  return {
    shipRole: "шахтёрский грузовик",
    tone: "Ржавый шахтёрский грузовик. Живёшь на таймерах и жадности.",
    note: "Держи стиль бедного злого добытчика без лишнего пафоса.",
  };
}

// ─────────────────────────────────────────────────────────────
// card normalization (v4: три действия)
// ─────────────────────────────────────────────────────────────

function normalizeCard(card) {
  const out = {
    origin_key:       String(card?.origin_key ?? "").trim(),
    card_name:        String(card?.card_name ?? "Без названия").trim(),
    lore_description: String(card?.lore_description ?? "").trim(),
    chaos_reason:     String(card?.chaos_reason ?? "").trim(),
    evidence: Array.isArray(card?.evidence)
      ? card.evidence.slice(0, 4).map(x => String(x).trim()).filter(Boolean)
      : [],
    actions: [],
  };

  const actions = Array.isArray(card?.actions) ? card.actions : [];

  // actions[0] и actions[1] — нормальные (mult 0.6..1.8)
  for (let i = 0; i < Math.min(2, actions.length); i++) {
    const a    = actions[i] || {};
    const type = String(a.type ?? "").trim();
    if (!isActionType(type)) continue;
    out.actions.push({
      type,
      mult:  clamp(a.mult, 0.6, 1.8),
      role:  "normal",
    });
  }

  // actions[2] — chaos (mult из CHAOS_MULT_ZONES, может быть 0.2..2.5)
  const chaos = actions[2] || {};
  const chaosType = String(chaos.type ?? "").trim();

  if (isActionType(chaosType)) {
    // принимаем mult от LLM только если он в chaos-диапазонах
    // иначе генерируем сами
    const rawMult = Number(chaos.mult ?? 0);
    const inLow   = rawMult >= 0.2 && rawMult <= 0.5;
    const inHigh  = rawMult >= 1.8 && rawMult <= 2.5;
    const chaosMult = (inLow || inHigh) ? rawMult : rollChaosMult();

    out.actions.push({
      type:  chaosType,
      mult:  chaosMult,
      role:  "chaos",
    });
  } else {
    // LLM не дал валидный тип — генерируем fallback chaos
    const fallbackType = ACTION_TYPES[Math.floor(Math.random() * ACTION_TYPES.length)];
    out.actions.push({
      type:  fallbackType,
      mult:  rollChaosMult(),
      role:  "chaos",
    });
  }

  // нормальные действия: fallback если мало
  while (out.actions.filter(a => a.role === "normal").length < 2) {
    const type = ACTION_TYPES[Math.floor(Math.random() * ACTION_TYPES.length)];
    out.actions.splice(out.actions.length - 1, 0, { type, mult: 1.0, role: "normal" });
  }

  // не одинаковые нормальные
  if (out.actions[0]?.type === out.actions[1]?.type) {
    const alt = ACTION_TYPES.find(t => t !== out.actions[0].type);
    if (alt) out.actions[1].type = alt;
  }

  // evidence минимум 2
  if (out.evidence.length < 2) {
    out.evidence = out.evidence.concat(["(evidence missing)"]).slice(0, 2);
  }

  if (!out.card_name) out.card_name = "Без названия";
  if (!out.lore_description) out.lore_description = "Модуль сработал как смог.";
  if (!out.chaos_reason) out.chaos_reason = "Никто не знает почему это произошло. Бортовой журнал сгорел.";

  return out;
}

// ─────────────────────────────────────────────────────────────
// deck object
// ─────────────────────────────────────────────────────────────

export const CombatDeck = {
  cache: loadCache(),
  _inFlight: null,

  __debugResolveEquipped() { return resolveEquippedModules(); },

  getMissing(modules) {
    const missingSolo  = modules.filter(m => !this.cache[m.id]);
    const missingCombo = [];
    for (let i = 0; i < modules.length; i++) {
      for (let j = i + 1; j < modules.length; j++) {
        const key = comboKey(modules[i].id, modules[j].id);
        if (!this.cache[key]) missingCombo.push({ key, a: modules[i], b: modules[j] });
      }
    }
    return { missingSolo, missingCombo };
  },

  buildDeck(modules) {
    const deck = [];
    for (const m of modules) {
      const c = this.cache[m.id];
      if (c) deck.push(c);
    }
    for (let i = 0; i < modules.length; i++) {
      for (let j = i + 1; j < modules.length; j++) {
        const k = comboKey(modules[i].id, modules[j].id);
        const c = this.cache[k];
        if (c) deck.push(c);
      }
    }
    return deck;
  },

  async openDeckModal() {
    const modal     = document.getElementById("modal-deck");
    const loading   = document.getElementById("deck-loading");
    const container = document.getElementById("deck-container");
    const btn       = document.getElementById("btn-open-deck");

    modal?.classList.remove("hidden");
    if (container) container.innerHTML = "";
    loading?.classList.remove("hidden");
    if (btn) btn.disabled = true;

    try {
      if (!this._inFlight) this._inFlight = this.ensureCardsForCurrentBuild();
      const { deck, modules } = await this._inFlight;
      loading?.classList.add("hidden");
      this.renderDeck(deck, modules);
      showToastMaybe(`🃏 Колода готова: ${deck.length}/${DECK_SIZE_EXPECTED}`, "success");
    } catch (e) {
      loading?.classList.add("hidden");
      if (container) container.innerHTML = `<div class="error-msg">Ошибка: ${escHtml(e?.message || e)}</div>`;
      console.error("[CombatDeck]", e);
    } finally {
      this._inFlight = null;
      if (btn) btn.disabled = false;
    }
  },

  async ensureCardsForCurrentBuild() {
    this.cache = loadCache();
    const apiKey = String(localStorage.getItem("openrouter_api_key") || "").trim();
    if (!apiKey) throw new Error("Нет API-ключа. Зайди в настройки.");

    const modules = resolveEquippedModules();
    if (modules.length !== 4) throw new Error(`Нужно 4 модуля. Сейчас: ${modules.length}/4`);

    const poor = modules.filter(m => (m.text_blob || "").length < 120);
    if (poor.length) {
      showToastMaybe("⚠️ У некоторых модулей мало текста — ИИ начнёт фантазировать.", "warning");
    }

    const { missingSolo, missingCombo } = this.getMissing(modules);
    const missingCount = missingSolo.length + missingCombo.length;

    if (missingCount > 0) {
      const ack = localStorage.getItem("deck_llm_cost_ack") === "1";
      if (!ack) {
        const ok = window.confirm(
          `Не хватает ${missingCount} карт → нужен вызов LLM.\n` +
          `Это стоит реальных денег разработчика.\n\nСгенерировать?`
        );
        if (!ok) throw new Error("Отменено игроком.");
        localStorage.setItem("deck_llm_cost_ack", "1");
      }
      rateLimitCheckAndMark();
      await this.generateMissingCards({ apiKey, modules, missingSolo, missingCombo });
    }

    return { modules, deck: this.buildDeck(modules) };
  },

  async generateMissingCards({ apiKey, modules, missingSolo, missingCombo }) {
    const shipTone = buildShipTone(modules);

    // строим список chaos-подсказок для всех action types
    const chaosHintsList = Object.entries(CHAOS_FLAVOR_HINTS)
      .map(([type, hint]) => `  ${type}: "${hint}"`)
      .join("\n");

    const systemPrompt = `
Ты — сверх циничный писатель лора в игре Cosmic Forge.
Сцена: перехват/бой с пиратом или охраной в астероидном поясе, прямо сейчас.

Тон:
- hard-sci-fi, технарская грязь, циничный язык, сложный мат. 
- минимум ДВА грубых слова или мата на карту
- юмор — чёрный, едкий, шахтёрский
- ${shipTone.tone}
- ${shipTone.note}

СТРУКТУРА КАРТЫ — ТРИ ДЕЙСТВИЯ:
Каждая карта содержит РОВНО 3 действия:
  actions[0] и actions[1] — нормальные не одинаковые действия (mult 0.6..1.8)
  actions[2]              — CHAOS-действие (см. ниже)

CHAOS-ДЕЙСТВИЕ (actions[2]):
- role: "chaos" — обязательное поле
- type: ЛЮБОЙ из ACTION_TYPES, но НЕОЖИДАННЫЙ для данного модуля 
  
- mult: ЛИБО в диапазоне 0.2..0.4 (слабый/негативный хаос)
        ЛИБО в диапазоне 1.8..2.5 (мощный хаос)
  НЕ используй диапазон 0.5..1.7 для chaos-действия
- chaos_reason: 1-2 предложения в духе "это произошло потому что..."
  Причина должна быть технически абсурдной но звучать правдоподобно
  как 
  последствие первых двух действий. Цинично. Смешно. Упорото.


ЖЁСТКИЕ ПРАВИЛА:
- НЕ выдумывай новых модулей/оружия/подсистем. Только то что есть в 4 модулях.
- На каждую запрошенную карту — ровно один объект в массиве.
- Верни ТОЛЬКО валидный JSON-массив. Никаких \`\`\`, никакого текста вокруг.
- Поля карты:
  - origin_key (строго как дано)
  - card_name (коротко хлёстко)
  - lore_description (3–5 предложений, момент боя, включая намёк на chaos)
  - chaos_reason (отдельное поле, 2-3 предложения объяснения chaos-действия, которое соучилось после lore_description)
  - actions: массив из РОВНО 3 объектов [{type,mult,role},...]

ACTION_TYPES (все допустимые):
${ACTION_TYPES.join(", ")}
`.trim();

    const payload = {
      scene: {
        situation: `Перехват. Твой корабль: ${shipTone.shipRole}.`,
        requirement: "3 действия на карту. actions[2] — chaos, неожиданный тип, экстремальный mult.",
      },
      equipped_modules: modules.map(m => ({
        id:           m.id,
        name:         m.name,
        rarity:       m.rarity,
        recipeType:   m.recipeType,
        recipeHints:  (m.recipeHints || []).filter(isActionType),
        text_blob:    trimText(m.text_blob, 1400),
        stats_lines:  (m.stats_lines || []).slice(0, 14),
        hooks:        { best: m.hooks?.best || null, worst: m.hooks?.worst || null },
        effects:      m.effects || {},
      })),
      chaos_instruction: {
        what_is_chaos: "actions[2] — третье действие карты. Всегда разыгрывается автоматически вместе с картой. Игрок не видит его заранее и не может отказаться.",
        mult_zones: CHAOS_MULT_ZONES,
        flavor: "абсурдная но логичная как последствие описанного и принятого в карте выбора причина. Цинизм. Упоротость. Грязный юмор.",
      },
      request: {
        solo: missingSolo.map(m => ({
          origin_key:   m.id,
          module_id:    m.id,
          hint_actions: (m.recipeHints || []).filter(isActionType).slice(0, 6),
          chaos_hint:   "выбери НЕОЖИДАННЫЙ для этого модуля тип действия",
        })),
        combo: missingCombo.map(c => ({
          origin_key:   c.key,
          moduleA_id:   c.a.id,
          moduleB_id:   c.b.id,
          hint_actions: [...(c.a.recipeHints || []), ...(c.b.recipeHints || [])]
            .filter(isActionType).filter((v, i, arr) => arr.indexOf(v) === i).slice(0, 6),
          chaos_hint:   "выбери действие которое НЕ ожидаешь от комбинации этих двух модулей",
        })),
      },
    };

    const raw = await hydraChat({
      apiKey,
      systemPrompt,
      userPrompt:  JSON.stringify(payload, null, 2),
      temperature: 0.85,
      max_tokens:  2000,
    });

    const jsonText = extractJsonArray(raw);
    let arr;
    try {
      arr = JSON.parse(jsonText);
    } catch (e) {
      console.warn("[CombatDeck] raw LLM:", raw);
      throw new Error("LLM вернул невалидный JSON.");
    }

    if (!Array.isArray(arr)) throw new Error("LLM вернул не массив карт.");

    for (const card of arr) {
      const norm = normalizeCard(card);
      if (!norm.origin_key) continue;
      this.cache[norm.origin_key] = norm;
    }

    saveCache(this.cache);
  },

  renderDeck(deck, modules) {
    const container = document.getElementById("deck-container");
    if (!container) return;

    const nameById = new Map(modules.map(m => [m.id, m.name]));

    const originLine = (origin_key) => {
      const key = String(origin_key);
      if (key.startsWith("COMBO__+__")) {
        const parts = key.split("__+__");
        const n1    = nameById.get(parts[1]) || parts[1];
        const n2    = nameById.get(parts[2]) || parts[2];
        return `COMBO: ${n1} + ${n2}`;
      }
      return `SOLO: ${nameById.get(key) || key}`;
    };

    container.innerHTML = "";

    for (const card of deck) {
      if (!card) continue;

      const el = document.createElement("div");
      el.className = "battle-card-item";

      const normal = (card.actions || []).filter(a => a.role !== "chaos");
      const chaos  = (card.actions || []).find(a => a.role === "chaos");

      const normalActionsHtml = normal.map(a => {
        const label = CARD_ACTIONS[a.type] || a.type;
        return `<span class="bc-tag" title="${escHtml(label)}">${escHtml(a.type)} ×${Number(a.mult).toFixed(2)}</span>`;
      }).join("");

      const chaosHtml = chaos
        ? `<div class="bc-chaos">
            <span class="bc-chaos-tag">⚡ CHAOS: ${escHtml(chaos.type)} ×${Number(chaos.mult).toFixed(2)}</span>
            ${card.chaos_reason
              ? `<div class="bc-chaos-reason">«${escHtml(card.chaos_reason)}»</div>`
              : ""}
           </div>`
        : "";

      const evidenceHtml = (card.evidence && card.evidence.length)
        ? `<div class="bc-evidence">якоря: ${
            card.evidence.map(x => `<span class="bc-ev">${escHtml(x)}</span>`).join(" ")
          }</div>`
        : "";

      el.innerHTML = `
        <div class="bc-origin">${escHtml(originLine(card.origin_key))}</div>
        <div class="bc-name">${escHtml(card.card_name)}</div>
        <div class="bc-lore">${escHtml(card.lore_description)}</div>
        ${evidenceHtml}
        <div class="bc-actions">${normalActionsHtml}</div>
        ${chaosHtml}
      `;

      container.appendChild(el);
    }

    const missing = DECK_SIZE_EXPECTED - deck.length;
    for (let i = 0; i < missing; i++) {
      const el = document.createElement("div");
      el.className = "battle-card-item bc-placeholder";
      el.innerHTML = `<div class="bc-name" style="color:var(--muted)">🃏 Карта не сгенерирована</div>`;
      container.appendChild(el);
    }
  },
};

// ─────────────────────────────────────────────────────────────
// UI hooks
// ─────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-open-deck")?.addEventListener("click",
    () => CombatDeck.openDeckModal()
  );
  document.getElementById("btn-deck-close")?.addEventListener("click",
    () => document.getElementById("modal-deck")?.classList.add("hidden")
  );
});

// ─────────────────────────────────────────────────────────────
// debug
// ─────────────────────────────────────────────────────────────

window.CombatDeck = CombatDeck;

window.dumpEquippedForDeck = () => {
  const mods = CombatDeck.__debugResolveEquipped();
  console.table(mods.map(m => ({
    id:         m.id,
    name:       m.name,
    rarity:     m.rarity,
    recipeType: m.recipeType,
    textLen:    (m.text_blob || "").length,
    hints:      (m.recipeHints || []).join(", "),
  })));
  return mods;
};

window.clearDeckCache = () => {
  localStorage.removeItem(CACHE_KEY);
  CombatDeck.cache = {};
  console.log("[CombatDeck] cache cleared");
};