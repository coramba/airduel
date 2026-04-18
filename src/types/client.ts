import type { PlayerSlot, RoomState } from './game.js';
import type { PlaneStatsField, RunwayConfigField } from './config.js';

export type ConnectionPhase = 'idle' | 'creating' | 'connecting' | 'connected' | 'error';
export type SetupPanelMode = 'hidden' | 'share' | 'join';

export interface AppState {
  roomId: string | null;
  roomLink: string | null;
  slot: PlayerSlot | null;
  roomState: RoomState | null;
  phase: ConnectionPhase;
  feedback: string;
  setupPanelMode: SetupPanelMode;
}

export interface RoomSnapshot {
  receivedAtMs: number;
  state: RoomState;
}

export interface PlayerCardRefs {
  item: HTMLLIElement;
  scoreCluster: HTMLDivElement;
  scoreCircle: HTMLSpanElement;
  crown: HTMLSpanElement;
  badge: HTMLSpanElement;
  marker: HTMLSpanElement;
  detail: HTMLSpanElement;
}

export interface CloudPuff {
  dx: number;
  dy: number;
  r: number;
}

export interface Cloud {
  x: number;
  y: number;
  puffs: CloudPuff[];
  foreground: boolean;
}

export type StatsInputMap = Record<PlaneStatsField['key'], HTMLInputElement>;
export type RunwayInputMap = Record<RunwayConfigField['key'], HTMLInputElement>;
