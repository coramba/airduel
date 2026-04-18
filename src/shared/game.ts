import type { PlayerSlot, InputState, PlaneState, PlayerState } from '../types/game.js';

// Shared runtime constants and factory/validation functions.
// Type definitions live in src/types/game.ts.
// Both the browser client and the Node server import this file.
export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 648;
export const GROUND_HEIGHT = 72;
export const RUNWAY_HEIGHT = 0;
export const RUNWAY_PLANE_Y = GAME_HEIGHT - GROUND_HEIGHT - RUNWAY_HEIGHT / 2;
export const PLANE_WRAP_MARGIN = 24;
export const BULLET_WRAP_MARGIN = 80;

export const PLAYER_SLOTS = ['left', 'right'] as const;

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
