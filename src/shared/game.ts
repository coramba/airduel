import type { PlayerSlot, InputState, PlaneState, PlayerState } from '../types/game.js';
import { PLANE_GEOMETRY } from './plane-shape.js';

// Shared runtime constants and factory/validation functions.
// Type definitions live in src/types/game.ts.
// Both the browser client and the Node server import this file.
export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 648;
export const GROUND_HEIGHT = 72;
export const RUNWAY_HEIGHT = 14;
export const GROUND_Y = GAME_HEIGHT - GROUND_HEIGHT;
export const GROUND_CONTACT_Y = GROUND_Y;
export const GROUNDED_PLANE_Y = GROUND_Y - getGroundedPlaneOffset();
export const PLANE_WRAP_MARGIN = 24;
export const BULLET_WRAP_MARGIN = 80;
export const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_ID_LENGTH = 6;
const ROOM_ID_PATTERN = new RegExp(`^[${ROOM_ID_ALPHABET}]{${ROOM_ID_LENGTH}}$`);

export const PLAYER_SLOTS = ['left', 'right'] as const;

export function createDefaultInputState(): InputState {
  return {
    launchPressed: false,
    pitchUpPressed: false,
    pitchDownPressed: false,
    firePressed: false
  };
}

// Planes always reset to a known grounded spawn position.
// The server reuses this for new rooms, rematches, and disconnect resets.
export function createDefaultPlaneState(slot: PlayerSlot): PlaneState {
  const x = slot === 'left' ? 48 : GAME_WIDTH - 48;

  return {
    position: { x, y: GROUNDED_PLANE_Y },
    velocity: { x: 0, y: 0 },
    angle: slot === 'left' ? 0 : Math.PI,
    phase: 'parked',
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

export function normalizeRoomId(roomId: string | null | undefined): string | null {
  if (!roomId) {
    return null;
  }

  const normalizedRoomId = roomId.trim().toUpperCase();
  return ROOM_ID_PATTERN.test(normalizedRoomId) ? normalizedRoomId : null;
}

function getGroundedPlaneOffset(): number {
  let maxCollisionY = 0;

  for (const polygon of PLANE_GEOMETRY.collisionPolygons) {
    for (const point of polygon) {
      maxCollisionY = Math.max(maxCollisionY, point.y);
    }
  }

  return maxCollisionY + PLANE_GEOMETRY.renderOffsetY;
}
