import type WebSocket from 'ws';

import type { PlayerSlot, RoomState, RoundOutcome, ServerErrorCode } from './game.js';
import type { PlaneStats } from './config.js';

export type JoinFailureCode = Extract<
  ServerErrorCode,
  'room_not_found' | 'room_full' | 'room_expired' | 'invalid_room'
>;

export interface RoomRecord {
  state: RoomState;
  lastActivityAt: number;
  sockets: Partial<Record<PlayerSlot, WebSocket>>;
  disconnectTimers: Partial<Record<PlayerSlot, ReturnType<typeof setTimeout>>>;
  reconnectTokens: Record<PlayerSlot, string>;
  planeStats: Record<PlayerSlot, PlaneStats>;
  spawnX: Record<PlayerSlot, number>;
  // Locked in when the explosion countdown begins so a winner crashing during
  // the animation does not corrupt the round outcome in finalizeRound.
  pendingOutcome?: RoundOutcome;
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
