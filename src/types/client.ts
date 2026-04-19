import type { PlayerSlot, RoomState } from './game.js';

export interface AppState {
  roomId: string | null;
  slot: PlayerSlot | null;
  roomState: RoomState | null;
}

export interface RoomSnapshot {
  receivedAtMs: number;
  state: RoomState;
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
