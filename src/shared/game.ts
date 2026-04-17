import type { PlaneStats } from './game-config.js';

// Shared constants, state shapes, and message contracts.
// Both the browser client and the Node server import this file so that
// simulation state, room lifecycle state, and websocket payloads stay aligned.
export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 648;
export const GROUND_HEIGHT = 72;
export const RUNWAY_HEIGHT = 0;
export const RUNWAY_PLANE_Y = GAME_HEIGHT - GROUND_HEIGHT - RUNWAY_HEIGHT / 2;
export const PLANE_WRAP_MARGIN = 24;
export const BULLET_WRAP_MARGIN = 80;

export const PLAYER_SLOTS = ['left', 'right'] as const;

export type PlayerSlot = (typeof PLAYER_SLOTS)[number];
export type RoomStatus = 'waiting' | 'active' | 'round_over';
export type PlanePhase = 'parked' | 'runway' | 'airborne' | 'stall' | 'landing' | 'destroyed';
export type RoundOutcome = 'left_win' | 'right_win' | 'draw';
export type ServerErrorCode =
  | 'room_not_found'
  | 'room_full'
  | 'room_expired'
  | 'invalid_room'
  | 'invalid_message';

// The world state intentionally stays small and explicit.
// There is one room, two player slots, one authoritative room state payload,
// and a minimal input snapshot sent from client to server.
export interface Vector2 {
  x: number;
  y: number;
}

export interface InputState {
  launchPressed: boolean;
  pitchUpPressed: boolean;
  pitchDownPressed: boolean;
  firePressed: boolean;
}

export interface PlaneState {
  position: Vector2;
  velocity: Vector2;
  angle: number;
  phase: PlanePhase;
  runwayTimeMs: number;
  shotCooldownMs: number;
  stallRemainingPx: number;
}

export interface BulletState {
  id: string;
  ownerSlot: PlayerSlot;
  position: Vector2;
  velocity: Vector2;
  ttlMs: number;
  radius: number;
}

export interface PlayerState {
  slot: PlayerSlot;
  connected: boolean;
  wins: number;
  input: InputState;
  plane: PlaneState;
}

export interface RoomState {
  id: string;
  status: RoomStatus;
  round: number;
  message: string | null;
  players: PlayerState[];
  bullets: BulletState[];
  rematchVotes: PlayerSlot[];
  winner: RoundOutcome | null;
  explosionRemainingMs: number;
  createdAt: number;
  lastActivityAt: number;
}

export interface CreateRoomResponse {
  roomId: string;
  joinUrl: string;
}

export type ClientMessage =
  | {
      type: 'input';
      payload: InputState;
    }
  | {
      type: 'rematch_requested';
    }
  | {
      type: 'plane_stats_update';
      payload: { slot: PlayerSlot; stats: PlaneStats };
    };

export type ServerMessage =
  | {
      type: 'room_state';
      payload: RoomState;
    }
  | {
      type: 'player_assignment';
      payload: {
        roomId: string;
        reconnectToken: string;
        slot: PlayerSlot;
      };
    }
  | {
      type: 'error';
      payload: {
        code: ServerErrorCode;
        message: string;
      };
    };

export function createDefaultInputState(): InputState {
  return {
    launchPressed: false,
    pitchUpPressed: false,
    pitchDownPressed: false,
    firePressed: false
  };
}

// Planes always reset to a known runway spawn position.
// The server reuses this for new rooms, rematches, and disconnect resets.
export function createDefaultPlaneState(slot: PlayerSlot, runwayStartX?: number): PlaneState {
  const defaultX = slot === 'left' ? 48 : GAME_WIDTH - 48;
  const x = runwayStartX ?? defaultX;

  return {
    position: { x, y: RUNWAY_PLANE_Y },
    velocity: { x: 0, y: 0 },
    angle: slot === 'left' ? 0 : Math.PI,
    phase: 'parked',
    runwayTimeMs: 0,
    shotCooldownMs: 0,
    stallRemainingPx: 0
  };
}

// Player state includes both transient round state (`plane`, `input`) and
// persistent room-scoped state (`wins`, `connected`) that survives rematches.
export function createDefaultPlayerState(slot: PlayerSlot): PlayerState {
  return {
    slot,
    connected: false,
    wins: 0,
    input: createDefaultInputState(),
    plane: createDefaultPlaneState(slot)
  };
}

// Runtime validation for client input messages.
// The websocket server rejects anything outside this exact shape.
export function isInputState(value: unknown): value is InputState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.launchPressed === 'boolean' &&
    typeof candidate.pitchUpPressed === 'boolean' &&
    typeof candidate.pitchDownPressed === 'boolean' &&
    typeof candidate.firePressed === 'boolean'
  );
}
