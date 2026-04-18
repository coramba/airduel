import type WebSocket from 'ws';

import type { PlayerSlot, RoomState, ServerErrorCode } from './game.js';
import type { PlaneStats, RunwayConfig } from './config.js';

export type JoinFailureCode = Extract<
  ServerErrorCode,
  'room_not_found' | 'room_full' | 'room_expired' | 'invalid_room'
>;

export interface RoomRecord {
  state: RoomState;
  sockets: Partial<Record<PlayerSlot, WebSocket>>;
  disconnectTimers: Partial<Record<PlayerSlot, ReturnType<typeof setTimeout>>>;
  reconnectTokens: Record<PlayerSlot, string>;
  planeStats: Record<PlayerSlot, PlaneStats>;
  runwayConfig: Record<PlayerSlot, RunwayConfig>;
}

export type JoinRoomResult =
  | { ok: true; reconnectToken: string; room: RoomRecord; slot: PlayerSlot }
  | { ok: false; code: JoinFailureCode };

export interface RequestLike {
  headers: {
    host?: string;
    'x-forwarded-proto'?: string | string[];
  };
}
