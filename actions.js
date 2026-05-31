// actions.js — библиотека типов действий для боевой колоды (v4)
// CHANGES v4:
// - CHAOS_MULT_MIN / CHAOS_MULT_MAX — диапазон для третьего действия
// - isChaosAction() — проверка
// - CHAOS_FLAVOR_HINTS — подсказки для LLM по типу действия

export const ACTION_TYPES = [
  // OFFENSE
  'ATTACK_KINETIC',
  'ATTACK_THERMAL',
  'ATTACK_SHRAPNEL',
  'ATTACK_EMP',
  'PIERCE',
  'FOCUS_FIRE',
  'DISRUPT_SENSORS',
  'FUEL_IGNITE',
  'ROCKET_SALVO',
  
  // DEFENSE / CONTROL
  'SHIELD_REGEN',
  'SHIELD_SPIKE',
  'HULL_BRACE',
  'EMERGENCY_REPAIR',
  'DAMAGE_CONTROL',
  
  // MANEUVER
  'DISTANCE_PUSH',
  'DISTANCE_PULL',
  'FULL_BURN',
  'DRIFT_SILENT',
  'EVADE_SPIKE',
  
  // TRICKS
  'SENSOR_JAM',
  'SIGNAL_BLUFF',
  'DATA_SPOOF',
  'FAKE_MELTDOWN',
  'EMP_STUN',
  'DECOY_DUMP',
  
  // DESPERATION / ECON
  'FUEL_BURN',
  'CARGO_JETTISON',
  'OFFER_BRIBE',
  'BROADCAST_PLEA',
  'CALL_REINFORCEMENTS',
  'NEGOTIATE_DELAY',
  'THREATEN_DETONATION',
];

export const CARD_ACTIONS = {
  ATTACK_KINETIC: "Кинетический удар (лучше вблизи)",
  ATTACK_THERMAL: "Термический прожиг (пик на средней дистанции)",
  ATTACK_SHRAPNEL: "Шрапнель (пик на средней дистанции)",
  ATTACK_EMP: "ЭМИ-удар (не зависит от дистанции)",
  PIERCE: "Бронебойный прокол (только вблизи)",
  FOCUS_FIRE: "Фокус-огонь (лучше вблизи)",
  DISRUPT_SENSORS: "Срыв сенсоров (не зависит от дистанции)",
  FUEL_IGNITE: "Поджог топлива (только вблизи)",
  ROCKET_SALVO: "Ракетный залп (лучше на дальней дистанции)",
  SHIELD_REGEN: "Реген щита",
  SHIELD_SPIKE: "Пик щита (временно)",
  HULL_BRACE: "Укрепление корпуса",
  EMERGENCY_REPAIR: "Аварийный ремонт",
  DAMAGE_CONTROL: "Контроль повреждений",
  DISTANCE_PUSH: "Манёвр (выбор направления)",
  DISTANCE_PULL: "Сближение",
  FULL_BURN: "Полный форсаж (выбор направления)",
  DRIFT_SILENT: "Тихий дрейф (выбор направления)",
  EVADE_SPIKE: "Резкий уклон",
  SENSOR_JAM: "Глушилка сенсоров",
  SIGNAL_BLUFF: "Блеф сигналом",
  DATA_SPOOF: "Спуфинг меток",
  FAKE_MELTDOWN: "Ложная авария",
  EMP_STUN: "ЭМИ-стан",
  DECOY_DUMP: "Ложные цели",
  FUEL_BURN: "Сжечь топливо",
  CARGO_JETTISON: "Сбросить груз",
  OFFER_BRIBE: "Взятка",
  BROADCAST_PLEA: "Мольба в эфир",
  CALL_REINFORCEMENTS: "Вызов подкрепления",
  NEGOTIATE_DELAY: "Тянуть время",
  THREATEN_DETONATION: "Угроза подрыва",
};

export const LEGACY_CARD_ACTIONS = {
  SYSTEM_OVERLOAD: "Перегрузка систем (legacy)",
  REPAIR_DRONES: "Ремонт дронами (legacy)",
  SCAVENGE: "Разбор на запчасти (legacy)",
};

// ─────────────────────────────────────────────────────────────
// Chaos action
// ─────────────────────────────────────────────────────────────

// Диапазон mult для chaos-действия
// Генерируется случайно из двух зон: [0.2..0.4] или [1.8..2.5]
export const CHAOS_MULT_ZONES = [
  { min: 0.2, max: 0.4 }, // слабый/негативный хаос
  { min: 1.8, max: 2.5 }, // мощный хаос
];

// Подсказки LLM: что может происходить при chaos-версии действия
// Используется в промпте чтобы LLM не придумывал совсем уж нереальное
export const CHAOS_FLAVOR_HINTS = {
  ATTACK_KINETIC: "болванка застряла в стволе и вылетела боком",
  ATTACK_THERMAL: "термальный контур замкнулся на обшивку изнутри",
  ATTACK_SHRAPNEL: "шрапнель выстрелила назад через дренажный клапан",
  ATTACK_EMP: "ЭМИ разрядился в собственную антенну",
  PIERCE: "бронебойный сердечник завис в направляющей и сполз",
  FOCUS_FIRE: "система наведения переключилась на собственный маяк",
  DISRUPT_SENSORS: "помеха вернулась эхом через ионосферу астероида",
  FUEL_IGNITE: "поджог активировал аварийный клапан с противоположной стороны",
  ROCKET_SALVO: "ракеты взяли курс правильно, но взрыватель сработал при выходе из трубы",
  SHIELD_REGEN: "регенератор щита высосал питание из маршевых двигателей",
  SHIELD_SPIKE: "пиковый импульс щита поджарил навигационный блок",
  HULL_BRACE: "стяжки корпуса заклинили рулевые плоскости",
  EMERGENCY_REPAIR: "ремонтный бот перепутал повреждённую секцию и заварил люк изнутри",
  DAMAGE_CONTROL: "система пожаротушения сработала в рубке",
  DISTANCE_PUSH: "двигатель толкнул не в ту сторону из-за перевёрнутого гироскопа",
  DISTANCE_PULL: "тормозные дюзы включились вместо маршевых",
  FULL_BURN: "форсаж включился на 0.3 секунды потом заглох с хлопком",
  DRIFT_SILENT: "режим тишины вырубил также системы жизнеобеспечения на 4 секунды",
  EVADE_SPIKE: "манёвр уклонения бросил корабль прямо в обломки",
  SENSOR_JAM: "глушилка заглушила собственный транспондер",
  SIGNAL_BLUFF: "блеф сработал — но не для того кому предназначался",
  DATA_SPOOF: "спуфинг вернул данные на собственный экран",
  FAKE_MELTDOWN: "ложная авария активировала настоящий аварийный клапан",
  EMP_STUN: "ЭМИ-стан срикошетил от металлического астероида",
  DECOY_DUMP: "приманки выстрелили внутрь трюма",
  FUEL_BURN: "топливо сгорело быстрее чем рассчитал компьютер",
  CARGO_JETTISON: "грузовой люк открылся не с той стороны",
  OFFER_BRIBE: "автоплатёж списал деньги со своего счёта вместо вражеского",
  BROADCAST_PLEA: "мольба вышла в эфир одновременно с боевым кличем",
  CALL_REINFORCEMENTS: "сигнал подкрепления ушёл на частоту врага",
  NEGOTIATE_DELAY: "переговоры затянулись настолько что система жизнеобеспечения ушла в спящий режим",
  THREATEN_DETONATION: "угроза подрыва сработала убедительно — в том числе для бортового ИИ",
};

// ─────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────

export function isActionType(type) {
  return ACTION_TYPES.includes(String(type || '').trim());
}

export function getActionLabel(type) {
  const t = String(type || '').trim();
  return CARD_ACTIONS[t] || LEGACY_CARD_ACTIONS[t] || t || "UNKNOWN_ACTION";
}

export function getChaosFlavorHint(type) {
  return CHAOS_FLAVOR_HINTS[String(type || '').trim()] || "что-то пошло не так по необъяснимым причинам";
}

// Генерирует случайный mult для chaos-действия из одной из двух зон
export function rollChaosMult() {
  const zone = CHAOS_MULT_ZONES[Math.floor(Math.random() * CHAOS_MULT_ZONES.length)];
  return Math.round((zone.min + Math.random()  *(zone.max - zone.min))*  100) / 100;
}

// Типы действий с выбором направления
export const DIRECTIONAL_ACTIONS = new Set([
  'DISTANCE_PUSH',
  'FULL_BURN',
  'DRIFT_SILENT',
]);

// Типы действий с дистанционной кривой урона
export const RANGED_ACTIONS = new Set([
  'ATTACK_KINETIC',
  'ATTACK_THERMAL',
  'ATTACK_SHRAPNEL',
  'PIERCE',
  'FOCUS_FIRE',
  'FUEL_IGNITE',
  'ROCKET_SALVO',
]);