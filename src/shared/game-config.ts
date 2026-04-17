import type { PlayerSlot } from './game.js';

export const EXPLOSION_DURATION_MS = 1500;

export interface PlaneStats {
  airSpeed: number;
  acceleration: number;
  turnRate: number;
  stallThreshold: number;
  diveExitDistance: number;
  allowedLandingSpeed: number;
  brakingDeceleration: number;
  runwayStartX: number;
  runwayLength: number;
  bulletSpeed: number;
  bulletRange: number;
  bulletRadius: number;
  fireCooldownMs: number;
}

export interface PlaneStatsField {
  key: keyof PlaneStats;
  label: string;
  step: number;
}

export const PLANE_STATS_FIELDS: readonly PlaneStatsField[] = [
  { key: 'airSpeed',       label: 'Air speed (px/s)',      step: 10  },
  { key: 'acceleration',   label: 'Acceleration (px/s²)',  step: 10  },
  { key: 'turnRate',       label: 'Turn rate (rad/s)',      step: 0.1 },
  { key: 'stallThreshold',   label: 'Stall threshold (%)',    step: 5   },
  { key: 'diveExitDistance',    label: 'Dive exit dist (px)',    step: 10  },
  { key: 'allowedLandingSpeed', label: 'Landing speed (px/s)',  step: 5   },
  { key: 'brakingDeceleration', label: 'Braking (px/s²)',       step: 10  },
  { key: 'runwayStartX',        label: 'Runway start X (px)',   step: 5   },
  { key: 'runwayLength',        label: 'Runway length (px)',    step: 5   },
  { key: 'bulletSpeed',         label: 'Bullet speed (px/s)',   step: 10  },
  { key: 'bulletRange',    label: 'Bullet range (px)',      step: 10  },
  { key: 'bulletRadius',   label: 'Bullet radius (px)',     step: 1   },
  { key: 'fireCooldownMs', label: 'Fire cooldown (ms)',     step: 10  },
];

export const DEFAULT_PLANE_STATS: Record<PlayerSlot, PlaneStats> = {
  left: {
    airSpeed:             240,
    acceleration:         70,
    turnRate:             2.5,
    stallThreshold:       70,
    diveExitDistance:     300,
    allowedLandingSpeed:  120,
    brakingDeceleration:  80,
    runwayStartX:         48,
    runwayLength:         94,
    bulletSpeed:          440,
    bulletRange:      480,
    bulletRadius:     2,
    fireCooldownMs:   250
  },
  right: {
    airSpeed:             210,
    acceleration:         70,
    turnRate:             1.8,
    stallThreshold:       70,
    diveExitDistance:     300,
    allowedLandingSpeed:  120,
    brakingDeceleration:  80,
    runwayStartX:         912,
    runwayLength:         94,
    bulletSpeed:          480,
    bulletRange:      500,
    bulletRadius:     2,
    fireCooldownMs:   200
  }
};

export function isPlaneStats(value: unknown): value is PlaneStats {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const s = value as Record<string, unknown>;
  return (
    typeof s.airSpeed       === 'number' && s.airSpeed       > 0 &&
    typeof s.acceleration   === 'number' && s.acceleration   > 0 &&
    typeof s.turnRate       === 'number' && s.turnRate       > 0 &&
    typeof s.stallThreshold   === 'number' && s.stallThreshold   > 0 &&
    typeof s.diveExitDistance    === 'number' && s.diveExitDistance    > 0 &&
    typeof s.allowedLandingSpeed === 'number' && s.allowedLandingSpeed > 0 &&
    typeof s.brakingDeceleration === 'number' && s.brakingDeceleration > 0 &&
    typeof s.runwayStartX        === 'number' && s.runwayStartX        > 0 &&
    typeof s.runwayLength        === 'number' && s.runwayLength        > 0 &&
    typeof s.bulletSpeed         === 'number' && s.bulletSpeed         > 0 &&
    typeof s.bulletRange    === 'number' && s.bulletRange    > 0 &&
    typeof s.bulletRadius   === 'number' && s.bulletRadius   > 0 &&
    typeof s.fireCooldownMs === 'number' && s.fireCooldownMs > 0
  );
}
