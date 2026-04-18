import type { CloudConfig, PlaneStats } from './config.js';

export type PlayerSlot = 'left' | 'right';
export type RoomStatus = 'waiting' | 'active' | 'round_over';
export type PlanePhase = 'parked' | 'runway' | 'airborne' | 'stall' | 'landing' | 'destroyed';
export type RoundOutcome = 'left_win' | 'right_win' | 'draw';
export type ServerErrorCode =
  | 'room_not_found'
  | 'room_full'
  | 'room_expired'
  | 'invalid_room'
  | 'invalid_message';

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

export interface RoundSettings {
  clouds: CloudConfig;
}

export interface RoomState {
  id: string;
  status: RoomStatus;
  round: number;
  roundSettings: RoundSettings;
  message: string | null;
  players: PlayerState[];
  bullets: BulletState[];
  rematchVotes: PlayerSlot[];
  winner: RoundOutcome | null;
  explosionRemainingMs: number;
}

export interface CreateRoomResponse {
  roomId: string;
  joinUrl: string;
}

export type ClientMessage =
  | { type: 'input'; payload: InputState }
  | { type: 'rematch_requested' }
  | { type: 'plane_stats_update'; payload: { slot: PlayerSlot; stats: PlaneStats } }
  | { type: 'spawn_x_update'; payload: { slot: PlayerSlot; spawnX: number } };

export type ServerMessage =
  | { type: 'room_state'; payload: RoomState }
  | { type: 'player_assignment'; payload: { roomId: string; reconnectToken: string; slot: PlayerSlot } }
  | { type: 'error'; payload: { code: ServerErrorCode; message: string } };
