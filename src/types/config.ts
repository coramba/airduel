export interface RunwayConfig {
  startX: number;
  startY: number;
  length: number;
  spawnX: number;
  buildingImage: string;
  buildingOffsetX: number;
  buildingOffsetY: number;
}

export type NumericFieldKey<T> = {
  [K in keyof T]-?: T[K] extends number ? K : never;
}[keyof T];

export interface RunwayConfigField {
  key: NumericFieldKey<RunwayConfig>;
  label: string;
  step: number;
}

export interface CloudConfig {
  seed: number;
  minCount: number;
  maxCount: number;
  upperSkyDensity: number;
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
  key: NumericFieldKey<PlaneStats>;
  label: string;
  step: number;
}
