// Shared gameplay configuration: asset names, defaults, field descriptors, and validators.
// Type definitions (PlaneStats, RunwayConfig, …) live in src/types/config.ts.
import { GAME_HEIGHT, GROUND_HEIGHT, RUNWAY_HEIGHT } from './game.js';
import type { PlayerSlot } from '../types/game.js';
import type { PlaneStats, PlaneStatsField, RunwayConfig, RunwayConfigField } from '../types/config.js';

export const FLAG_CONFIG = {
  imageNeutral: 'flag_n.png',
  imageLeft:    'flag_l.png',
  imageRight:   'flag_r.png',
  x:       430,
  offsetX:  46,
  offsetY:   13,
};

export const EXPLOSION_CONFIG = {
  image: 'airexplosion1.gif',
  durationMs: 1500,
  growMs: 300,
  shrinkMs: 400,
};

export const HORIZON_CONFIG = {
  image: 'horizon3.png',
  offsetY: 4,
  alpha: 0.75,
};

export const RUNWAY_CONFIG_FIELDS: readonly RunwayConfigField[] = [
  { key: 'startX',          label: 'Runway start X (px)',    step: 5 },
  { key: 'startY',          label: 'Runway start Y (px)',    step: 5 },
  { key: 'length',          label: 'Runway length (px)',     step: 5 },
  { key: 'spawnX',          label: 'Spawn X (px)',           step: 5 },
  { key: 'buildingOffsetX', label: 'Building offset X (px)', step: 1 },
  { key: 'buildingOffsetY', label: 'Building offset Y (px)', step: 1 },
];

const DEFAULT_RUNWAY_START_Y = GAME_HEIGHT - GROUND_HEIGHT - RUNWAY_HEIGHT + 12;

export const DEFAULT_RUNWAY_CONFIG: Record<PlayerSlot, RunwayConfig> = {
  left: {
    startX: 5,
    startY: DEFAULT_RUNWAY_START_Y,
    length: 240,
    spawnX: 60,
    buildingImage: 'buildings_l.png',
    buildingOffsetX: 80,
    buildingOffsetY: 0,
  },
  right: {
    startX: 955,
    startY: DEFAULT_RUNWAY_START_Y,
    length: 240,
    spawnX: 900,
    buildingImage: 'buildings_r.png',
    buildingOffsetX: -80,
    buildingOffsetY: 0,
  },
};

export function isRunwayConfig(value: unknown): value is RunwayConfig {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const c = value as Record<string, unknown>;
  return (
    typeof c.startX          === 'number' && c.startX > 0 &&
    typeof c.startY          === 'number' && c.startY > 0 &&
    typeof c.length          === 'number' && c.length > 0 &&
    typeof c.spawnX          === 'number' && c.spawnX > 0 &&
    typeof c.buildingImage   === 'string' && c.buildingImage.length > 0 &&
    typeof c.buildingOffsetX === 'number' &&
    typeof c.buildingOffsetY === 'number'
  );
}

export const PLANE_STATS_FIELDS: readonly PlaneStatsField[] = [
  { key: 'airSpeed',            label: 'Air speed (px/s)',     step: 10  },
  { key: 'acceleration',        label: 'Acceleration (px/s²)', step: 10  },
  { key: 'turnRate',            label: 'Turn rate (rad/s)',     step: 0.1 },
  { key: 'stallThreshold',      label: 'Stall threshold (%)',  step: 5   },
  { key: 'diveExitDistance',    label: 'Dive exit dist (px)',  step: 10  },
  { key: 'allowedLandingSpeed', label: 'Landing speed (px/s)', step: 5   },
  { key: 'brakingDeceleration', label: 'Braking (px/s²)',      step: 10  },
  { key: 'bulletSpeed',         label: 'Bullet speed (px/s)',  step: 10  },
  { key: 'bulletRange',         label: 'Bullet range (px)',    step: 10  },
  { key: 'bulletRadius',        label: 'Bullet radius (px)',   step: 1   },
  { key: 'fireCooldownMs',      label: 'Fire cooldown (ms)',   step: 10  },
];

export const DEFAULT_PLANE_CONFIG: Record<PlayerSlot, PlaneStats> = {
  left: {
    planeImage: 'plane2.png',
    airSpeed:             280,
    acceleration:         80,
    turnRate:             2.5,
    stallThreshold:       70,
    diveExitDistance:     300,
    allowedLandingSpeed:  120,
    brakingDeceleration:  140,
    bulletSpeed:          440,
    bulletRange:          480,
    bulletRadius:         2,
    fireCooldownMs:       250
  },
  right: {
    planeImage: 'plane1.png',
    airSpeed:             250,
    acceleration:         80,
    turnRate:             1.8,
    stallThreshold:       70,
    diveExitDistance:     300,
    allowedLandingSpeed:  120,
    brakingDeceleration:  125,
    bulletSpeed:          480,
    bulletRange:          550,
    bulletRadius:         2,
    fireCooldownMs:       160
  }
};

export function isPlaneStats(value: unknown): value is PlaneStats {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const s = value as Record<string, unknown>;
  return (
    typeof s.planeImage          === 'string' && s.planeImage.length   > 0 &&
    typeof s.airSpeed            === 'number' && s.airSpeed            > 0 &&
    typeof s.acceleration        === 'number' && s.acceleration        > 0 &&
    typeof s.turnRate            === 'number' && s.turnRate            > 0 &&
    typeof s.stallThreshold      === 'number' && s.stallThreshold      > 0 &&
    typeof s.diveExitDistance    === 'number' && s.diveExitDistance    > 0 &&
    typeof s.allowedLandingSpeed === 'number' && s.allowedLandingSpeed > 0 &&
    typeof s.brakingDeceleration === 'number' && s.brakingDeceleration > 0 &&
    typeof s.bulletSpeed         === 'number' && s.bulletSpeed         > 0 &&
    typeof s.bulletRange         === 'number' && s.bulletRange         > 0 &&
    typeof s.bulletRadius        === 'number' && s.bulletRadius        > 0 &&
    typeof s.fireCooldownMs      === 'number' && s.fireCooldownMs      > 0
  );
}

export function getEffectiveTurnRate(speed: number, stats: PlaneStats): number {
  if (speed >= stats.airSpeed) {
    return stats.turnRate;
  }

  return stats.turnRate * Math.max(0, (speed - stats.airSpeed / 2) / (stats.airSpeed / 2));
}
