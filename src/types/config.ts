export interface RunwayConfig {
  startX: number;
  startY: number;
  length: number;
  spawnX: number;
  buildingImage: string;
  buildingOffsetX: number;
  buildingOffsetY: number;
}

export interface RunwayConfigField {
  key: keyof RunwayConfig;
  label: string;
  step: number;
}

export interface PlaneStats {
  planeImage: string;
  airSpeed: number;
  acceleration: number;
  turnRate: number;
  stallThreshold: number;
  diveExitDistance: number;
  allowedLandingSpeed: number;
  brakingDeceleration: number;
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
