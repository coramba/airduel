import {
  GAME_HEIGHT,
  GAME_WIDTH,
  GROUND_HEIGHT,
  PLAYER_SLOTS,
  RUNWAY_HEIGHT,
  RUNWAY_PLANE_Y,
  createDefaultInputState,
  type BulletState,
  type PlaneState,
  type PlayerSlot,
  type RoundOutcome
} from '../shared/game.js';
import type { RoomRecord } from './room-registry.js';

// Authoritative round simulation.
// The server advances every active room at a fixed tick rate and is the only
// place where movement, firing, collisions, and score-awarding decisions happen.
export const SIMULATION_TICK_MS = 1000 / 30;

// Gameplay tuning constants live together here so future balance changes do not
// require scanning the movement code below.
const DT_SECONDS = SIMULATION_TICK_MS / 1000;
const AIR_SPEED = 240;
const RUNWAY_SPEED = 160;
const TURN_RATE = 2.6;
const TAKEOFF_ANGLE = 0.42;
const MIN_RUNWAY_TIME_MS = 650;
const BULLET_SPEED = 440;
const DEFAULT_BULLET_MAX_DISTANCE = GAME_WIDTH / 2;
const FIRE_COOLDOWN_MS = readPositiveNumber(process.env.FIRE_COOLDOWN_MS, 240);
const BULLET_MAX_DISTANCE = readPositiveNumber(
  process.env.BULLET_MAX_DISTANCE,
  DEFAULT_BULLET_MAX_DISTANCE
);
const BULLET_TTL_MS = (BULLET_MAX_DISTANCE / BULLET_SPEED) * 1000;
const SKY_MARGIN = 28;
const WRAP_MARGIN = 24;
const BULLET_MARGIN = 80;
const PLANE_RADIUS = 18;
const BULLET_RADIUS = 5;
const PLANE_NOSE_OFFSET = 22;

const runwayImpactY = GAME_HEIGHT - GROUND_HEIGHT - RUNWAY_HEIGHT / 2;

let nextBulletId = 1;

// Called once per tick for each room.
// Returns `true` only when room state changed and should be broadcast.
export function stepRoom(room: RoomRecord): boolean {
  if (room.state.status !== 'active') {
    return false;
  }

  const allPlayersConnected = room.state.players.every((player) => player.connected);
  if (!allPlayersConnected) {
    return false;
  }

  let changed = false;
  const destroyedSlots = new Set<PlayerSlot>();
  const spawnedBullets: BulletState[] = [];

  for (const player of room.state.players) {
    const plane = player.plane;
    plane.shotCooldownMs = Math.max(0, plane.shotCooldownMs - SIMULATION_TICK_MS);

    switch (plane.phase) {
      case 'parked':
        changed = updateParkedPlane(player.slot, plane, player.input) || changed;
        break;
      case 'runway':
        changed = updateRunwayPlane(player.slot, plane, player.input) || changed;
        break;
      case 'airborne':
        changed = updateAirbornePlane(player.slot, plane, player.input) || changed;
        if (plane.position.y >= runwayImpactY) {
          destroyedSlots.add(player.slot);
        }
        break;
      case 'destroyed':
        plane.velocity.x = 0;
        plane.velocity.y = 0;
        break;
    }

    const bullet = maybeCreateBullet(player.slot, plane, player.input);
    if (bullet) {
      spawnedBullets.push(bullet);
      changed = true;
    }
  }

  // Newly spawned bullets are merged into the same pass so they inherit the
  // same authoritative update ordering as all other bullets this tick.
  const bullets = room.state.bullets.concat(spawnedBullets);
  const nextBullets: BulletState[] = [];

  for (const bullet of bullets) {
    bullet.position.x += bullet.velocity.x * DT_SECONDS;
    bullet.position.y += bullet.velocity.y * DT_SECONDS;
    bullet.ttlMs -= SIMULATION_TICK_MS;
    wrapBulletHorizontally(bullet);
    changed = true;

    if (isBulletExpired(bullet)) {
      continue;
    }

    let hit = false;

    for (const player of room.state.players) {
      if (player.slot === bullet.ownerSlot || player.plane.phase === 'destroyed') {
        continue;
      }

      if (distanceSquared(bullet.position.x, bullet.position.y, player.plane.position.x, player.plane.position.y) <= (PLANE_RADIUS + BULLET_RADIUS) ** 2) {
        destroyedSlots.add(player.slot);
        hit = true;
      }
    }

    if (!hit) {
      nextBullets.push(bullet);
    }
  }

  room.state.bullets = nextBullets;

  if (destroyedSlots.size > 0) {
    const outcome = resolveOutcome(destroyedSlots);

    for (const player of room.state.players) {
      if (destroyedSlots.has(player.slot)) {
        player.plane.phase = 'destroyed';
        player.plane.velocity.x = 0;
        player.plane.velocity.y = 0;
      }

      player.input = createDefaultInputState();
    }

    room.state.bullets = [];
    room.state.status = 'round_over';
    room.state.message = 'Round complete. Both pilots must request rematch.';
    room.state.winner = outcome;
    awardRoundWin(room, outcome);
    room.state.lastActivityAt = Date.now();
    return true;
  }

  if (changed) {
    room.state.lastActivityAt = Date.now();
  }

  return changed;
}

function updateParkedPlane(slot: PlayerSlot, plane: PlaneState, input: { launchPressed: boolean }): boolean {
  // Parked state is not simulated continuously. It is simply synchronized back
  // to the default spawn until the launch input starts the runway roll.
  const defaultPlane = defaultFlightState(slot);
  let changed = syncPlane(plane, defaultPlane);

  if (input.launchPressed) {
    plane.phase = 'runway';
    changed = true;
  }

  return changed;
}

function updateRunwayPlane(
  slot: PlayerSlot,
  plane: PlaneState,
  input: { pitchUpPressed: boolean }
): boolean {
  // Runway phase is intentionally simple: fixed speed, fixed heading, no lift
  // until the minimum runway time has elapsed and the player pitches up.
  const direction = slotDirection(slot);
  plane.runwayTimeMs += SIMULATION_TICK_MS;
  plane.angle = baseAngle(slot);
  plane.velocity.x = direction * RUNWAY_SPEED;
  plane.velocity.y = 0;
  plane.position.x += plane.velocity.x * DT_SECONDS;
  plane.position.y = RUNWAY_PLANE_Y;
  wrapPlaneHorizontally(plane);

  if (plane.runwayTimeMs >= MIN_RUNWAY_TIME_MS && input.pitchUpPressed) {
    plane.phase = 'airborne';
    plane.angle = baseAngle(slot) + noseUpAngleDirection(slot) * TAKEOFF_ANGLE;
    applyVelocityFromAngle(plane, AIR_SPEED);
  }

  return true;
}

function updateAirbornePlane(
  slot: PlayerSlot,
  plane: PlaneState,
  input: { pitchUpPressed: boolean; pitchDownPressed: boolean }
): boolean {
  // Airborne control is continuous pitch-only flight with fixed forward speed.
  // The design stays intentionally simple and does not model thrust or drag.
  const pitchIntent = (input.pitchUpPressed ? 1 : 0) - (input.pitchDownPressed ? 1 : 0);

  plane.angle = normalizeAngle(
    plane.angle + pitchIntent * noseUpAngleDirection(slot) * TURN_RATE * DT_SECONDS
  );
  applyVelocityFromAngle(plane, AIR_SPEED);
  plane.position.x += plane.velocity.x * DT_SECONDS;
  plane.position.y += plane.velocity.y * DT_SECONDS;
  wrapPlaneHorizontally(plane);

  if (plane.position.y < SKY_MARGIN) {
    plane.position.y = SKY_MARGIN;
  }

  return true;
}

function maybeCreateBullet(
  slot: PlayerSlot,
  plane: PlaneState,
  input: { firePressed: boolean }
): BulletState | null {
  // Runway and airborne phases are both allowed to fire. Parked planes and
  // destroyed planes never spawn bullets.
  if ((plane.phase !== 'runway' && plane.phase !== 'airborne') || !input.firePressed) {
    return null;
  }

  if (plane.shotCooldownMs > 0) {
    return null;
  }

  plane.shotCooldownMs = FIRE_COOLDOWN_MS;

  return {
    id: `${slot}-${nextBulletId++}`,
    ownerSlot: slot,
    position: {
      x: plane.position.x + Math.cos(plane.angle) * PLANE_NOSE_OFFSET,
      y: plane.position.y + Math.sin(plane.angle) * PLANE_NOSE_OFFSET
    },
    velocity: {
      x: Math.cos(plane.angle) * BULLET_SPEED,
      y: Math.sin(plane.angle) * BULLET_SPEED
    },
    ttlMs: BULLET_TTL_MS
  };
}

function isBulletExpired(bullet: BulletState): boolean {
  return (
    bullet.ttlMs <= 0 ||
    bullet.position.y < -BULLET_MARGIN ||
    bullet.position.y > GAME_HEIGHT + BULLET_MARGIN
  );
}

// Round outcome is derived only from which slots were destroyed this tick.
function resolveOutcome(destroyedSlots: Set<PlayerSlot>): RoundOutcome {
  if (destroyedSlots.size > 1) {
    return 'draw';
  }

  return destroyedSlots.has('left') ? 'right_win' : 'left_win';
}

// Wins persist across rematches inside the same room.
function awardRoundWin(room: RoomRecord, outcome: RoundOutcome): void {
  const winningSlot =
    outcome === 'left_win' ? 'left' : outcome === 'right_win' ? 'right' : null;

  if (!winningSlot) {
    return;
  }

  const winner = room.state.players.find((player) => player.slot === winningSlot);
  if (winner) {
    winner.wins += 1;
  }
}

// These helpers keep per-slot default flight state in one place so rematches,
// reconnect resets, and parked updates all produce the same spawn data.
function defaultFlightState(slot: PlayerSlot): PlaneState {
  return {
    ...{
      position: { ...createPosition(slot) },
      velocity: { x: 0, y: 0 },
      angle: baseAngle(slot),
      phase: 'parked',
      runwayTimeMs: 0,
      shotCooldownMs: 0
    }
  };
}

function syncPlane(target: PlaneState, source: PlaneState): boolean {
  const changed =
    target.position.x !== source.position.x ||
    target.position.y !== source.position.y ||
    target.velocity.x !== source.velocity.x ||
    target.velocity.y !== source.velocity.y ||
    target.angle !== source.angle ||
    target.phase !== source.phase ||
    target.runwayTimeMs !== source.runwayTimeMs ||
    target.shotCooldownMs !== source.shotCooldownMs;

  target.position.x = source.position.x;
  target.position.y = source.position.y;
  target.velocity.x = source.velocity.x;
  target.velocity.y = source.velocity.y;
  target.angle = source.angle;
  target.phase = source.phase;
  target.runwayTimeMs = source.runwayTimeMs;
  target.shotCooldownMs = source.shotCooldownMs;

  return changed;
}

// Velocity is always derived from angle and speed instead of being controlled
// independently. That keeps the flight model easy to reason about.
function applyVelocityFromAngle(plane: PlaneState, speed: number): void {
  plane.velocity.x = Math.cos(plane.angle) * speed;
  plane.velocity.y = Math.sin(plane.angle) * speed;
}

function createPosition(slot: PlayerSlot): { x: number; y: number } {
  return {
    x: slot === 'left' ? 96 : GAME_WIDTH - 96,
    y: RUNWAY_PLANE_Y
  };
}

function baseAngle(slot: PlayerSlot): number {
  return slot === 'left' ? 0 : Math.PI;
}

function slotDirection(slot: PlayerSlot): number {
  return slot === 'left' ? 1 : -1;
}

function noseUpAngleDirection(slot: PlayerSlot): number {
  return slot === 'left' ? -1 : 1;
}

// Planes and bullets wrap horizontally so combat can continue seamlessly across
// the screen edge. Vertical escape still counts as leaving the combat area.
function wrapPlaneHorizontally(plane: PlaneState): void {
  if (plane.position.x < -WRAP_MARGIN) {
    plane.position.x = GAME_WIDTH + WRAP_MARGIN;
  } else if (plane.position.x > GAME_WIDTH + WRAP_MARGIN) {
    plane.position.x = -WRAP_MARGIN;
  }
}

function wrapBulletHorizontally(bullet: BulletState): void {
  if (bullet.position.x < -BULLET_MARGIN) {
    bullet.position.x = GAME_WIDTH + BULLET_MARGIN;
  } else if (bullet.position.x > GAME_WIDTH + BULLET_MARGIN) {
    bullet.position.x = -BULLET_MARGIN;
  }
}

function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

// Environment-configurable tuning values deliberately fall back to safe defaults
// so invalid env input does not crash the game server.
function readPositiveNumber(rawValue: string | undefined, fallback: number): number {
  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

// Collision checks stay cheap because the game only has two planes and a small
// number of bullets, so squared distance is enough.
function distanceSquared(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}
