export function createDefaultPlayer(uid) {
  return {
    uid,
    displayName: "Пилот",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resources: {
      isotopes: 0,
      minerals: 0,
      metals: 0,
      data: 0
    },
    stats: {
      miningSpeed: 1,
      rareDropChance: 0.01,
      craftSpeed: 1,
      shieldPower: 1,
      penetration: 1,
      energyOutput: 1,
      computePower: 1
    },
    inventory: {
      artifacts: []
    },
    activeJobs: {
      mining: null
    },
    settings: {
      echoVisibility: true
    }
  };
}

export function normalizePlayer(uid, raw) {
  const base = createDefaultPlayer(uid);
  const player = raw || {};
  
  return {
    ...base,
    ...player,
    uid,
    resources: { ...base.resources, ...(player.resources || {}) },
    stats: { ...base.stats, ...(player.stats || {}) },
    inventory: {
      ...base.inventory,
      ...(player.inventory || {}),
      artifacts: Array.isArray(player.inventory?.artifacts) ? player.inventory.artifacts : []
    },
    activeJobs: { ...base.activeJobs, ...(player.activeJobs || {}) },
    settings: { ...base.settings, ...(player.settings || {}) }
  };
}

export const state = {
  uid: "",
  player: null,
  openrouterKey: ""
};