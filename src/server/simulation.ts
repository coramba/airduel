import {
  BULLET_WRAP_MARGIN,
  GAME_HEIGHT,
  GAME_WIDTH,
  GROUND_CONTACT_Y,
  GROUNDED_PLANE_Y,
  PLANE_WRAP_MARGIN,
  createDefaultInputState,
  createDefaultPlaneState,
} from '../shared/game.js';
import {
  PLANE_GEOMETRY,
  getPlaneShapeOrigin,
  transformPlanePoint,
  transformPlanePolygon,
} from '../shared/plane-shape.js';
import { EXPLOSION_CONFIG, getEffectiveTurnRate } from '../shared/game-config.js';
import type { BulletState, InputState, PlaneState, PlayerSlot, RoundOutcome } from '../types/game.js';
import type { PlaneStats } from '../types/config.js';
import type { PlanePoint } from '../types/geometry.js';
import type { RoomRecord } from '../types/server.js';

// Authoritative round simulation.
// The server advances every active room at a fixed tick rate and is the only
// place where movement, firing, collisions, and score-awarding decisions happen.
// Types used here are imported from src/types/.
export const SIMULATION_TICK_MS = 1000 / 30;

// Fixed simulation constants that are not exposed for per-plane tuning.
const DT_SECONDS = SIMULATION_TICK_MS / 1000;
const SKY_MARGIN = 28;

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

  if (room.state.explosionRemainingMs > 0) {
    room.state.explosionRemainingMs = Math.max(0, room.state.explosionRemainingMs - SIMULATION_TICK_MS);
    for (const player of room.state.players) {
      if (player.plane.phase === 'destroyed') continue;
      const stats = room.planeStats[player.slot];
      player.plane.shotCooldownMs = Math.max(0, player.plane.shotCooldownMs - SIMULATION_TICK_MS);
      updateAlivePlane(player.slot, player.plane, player.input, stats);
      // Apply ground collisions so the winner can't fly through the ground.
      // Use a local set — crashes here must not alter the already-locked outcome.
      const phase = player.plane.phase;
      if ((phase === 'airborne' || phase === 'stall') &&
          player.plane.velocity.y >= 0 &&
          lowestCollisionY(player.slot, player.plane) >= GROUND_CONTACT_Y) {
        const localDestroyed = new Set<PlayerSlot>();
        resolveGroundContact(player.slot, player.plane, stats, localDestroyed);
        if (localDestroyed.has(player.slot)) {
          player.plane.phase = 'destroyed';
          player.plane.velocity.x = 0;
          player.plane.velocity.y = 0;
        }
      }
    }
    if (room.state.explosionRemainingMs === 0) {
      finalizeRound(room);
    }
    room.lastActivityAt = Date.now();
    return true;
  }

  let changed = false;
  const destroyedSlots = new Set<PlayerSlot>();
  const spawnedBullets: BulletState[] = [];

  for (const player of room.state.players) {
    const plane = player.plane;
    const stats = room.planeStats[player.slot];
    plane.shotCooldownMs = Math.max(0, plane.shotCooldownMs - SIMULATION_TICK_MS);

    switch (plane.phase) {
      case 'parked':
        changed = updateParkedPlane(player.slot, plane, player.input) || changed;
        break;
      case 'runway':
        changed = updateRunwayPlane(player.slot, plane, player.input, stats) || changed;
        break;
      case 'airborne':
        changed = updateAirbornePlane(player.slot, plane, player.input, stats) || changed;
        if (plane.velocity.y >= 0 && lowestCollisionY(player.slot, plane) >= GROUND_CONTACT_Y) {
          resolveGroundContact(player.slot, plane, stats, destroyedSlots);
        }
        break;
      case 'stall':
        changed = updateStalledPlane(player.slot, plane, stats) || changed;
        if (plane.velocity.y >= 0 && lowestCollisionY(player.slot, plane) >= GROUND_CONTACT_Y) {
          resolveGroundContact(player.slot, plane, stats, destroyedSlots);
        }
        break;
      case 'landing':
        changed = updateLandingPlane(player.slot, plane, stats, player.input) || changed;
        break;
      case 'destroyed':
        plane.velocity.x = 0;
        plane.velocity.y = 0;
        break;
    }

    const bullet = maybeCreateBullet(player.slot, plane, player.input, stats);
    if (bullet) {
      spawnedBullets.push(bullet);
      changed = true;
    }
  }

  // Plane-on-plane crashes are resolved before bullet travel so direct contact
  // still ends the round even when neither pilot is hit by a projectile.
  if (didPlanesCollide(room.state.players)) {
    destroyedSlots.add('left');
    destroyedSlots.add('right');
  }

  // Newly spawned bullets are merged into the same pass so they inherit the
  // same authoritative update ordering as all other bullets this tick.
  const bullets = room.state.bullets.concat(spawnedBullets);
  const nextBullets: BulletState[] = [];

  for (const bullet of bullets) {
    bullet.position.x += bullet.velocity.x * DT_SECONDS;
    bullet.position.y += bullet.velocity.y * DT_SECONDS;
    bullet.ttlMs -= SIMULATION_TICK_MS;
    bullet.position.x = wrapX(bullet.position.x, BULLET_WRAP_MARGIN);
    changed = true;

    if (isBulletExpired(bullet)) {
      continue;
    }

    let hit = false;

    for (const player of room.state.players) {
      if (player.slot === bullet.ownerSlot || player.plane.phase === 'destroyed') {
        continue;
      }

      if (doesBulletHitPlane(bullet, player.slot, player.plane)) {
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
    for (const player of room.state.players) {
      if (destroyedSlots.has(player.slot)) {
        player.plane.phase = 'destroyed';
        player.plane.velocity.x = 0;
        player.plane.velocity.y = 0;
        player.input = createDefaultInputState();
      }
    }
    room.state.bullets = [];
    room.state.explosionRemainingMs = EXPLOSION_CONFIG.durationMs;
    room.pendingOutcome = resolveOutcome(destroyedSlots);
    room.lastActivityAt = Date.now();
    return true;
  }

  if (changed) {
    room.lastActivityAt = Date.now();
  }

  return changed;
}

function updateAlivePlane(slot: PlayerSlot, plane: PlaneState, input: InputState, stats: PlaneStats): void {
  switch (plane.phase) {
    case 'airborne':
      updateAirbornePlane(slot, plane, input, stats);
      break;
    case 'stall':
      updateStalledPlane(slot, plane, stats);
      break;
    case 'runway':
      updateRunwayPlane(slot, plane, input, stats);
      break;
    case 'landing':
      updateLandingPlane(slot, plane, stats, input);
      break;
  }
}

function updateParkedPlane(slot: PlayerSlot, plane: PlaneState, input: { launchPressed: boolean }): boolean {
  const defaultPlane = createDefaultPlaneState(slot);
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
  input: { pitchUpPressed: boolean },
  stats: PlaneStats
): boolean {
  const direction = slotDirection(slot);
  plane.angle = baseAngle(slot);

  // Speed ramps smoothly from 0 to airSpeed at the configured acceleration.
  const currentSpeed = Math.abs(plane.velocity.x);
  const newSpeed = Math.min(currentSpeed + stats.acceleration * DT_SECONDS, stats.airSpeed);
  plane.velocity.x = direction * newSpeed;
  plane.velocity.y = 0;
  plane.position.x += plane.velocity.x * DT_SECONDS;
  plane.position.y = GROUNDED_PLANE_Y;
  plane.position.x = wrapX(plane.position.x, PLANE_WRAP_MARGIN);

  // Lift-off becomes available once the plane has reached at least half airSpeed,
  // giving control surfaces enough authority to rotate the nose.
  if (newSpeed >= stats.airSpeed / 2 && input.pitchUpPressed) {
    plane.phase = 'airborne';
    applyVelocityFromAngle(plane, newSpeed);
  }

  return true;
}

function updateStalledPlane(
  slot: PlayerSlot,
  plane: PlaneState,
  stats: PlaneStats
): boolean {
  const targetAngle = Math.PI / 2;
  plane.angle = normalizeAngle(plane.angle + Math.sign(normalizeAngle(targetAngle - plane.angle)) * stats.turnRate * 2 * DT_SECONDS);
  applyVelocityFromAngle(plane, stats.airSpeed);
  plane.position.x += plane.velocity.x * DT_SECONDS;
  plane.position.y += plane.velocity.y * DT_SECONDS;
  plane.position.x = wrapX(plane.position.x, PLANE_WRAP_MARGIN);

  plane.stallRemainingPx = Math.max(0, plane.stallRemainingPx - Math.abs(plane.velocity.y) * DT_SECONDS);
  if (plane.stallRemainingPx === 0) {
    plane.phase = 'airborne';
  }

  return true;
}

function lowestCollisionY(slot: PlayerSlot, plane: PlaneState): number {
  let maxY = -Infinity;
  for (const polygon of getPlaneCollisionPolygons(slot, plane)) {
    for (const point of polygon) {
      if (point.y > maxY) maxY = point.y;
    }
  }
  return maxY;
}

function resolveGroundContact(
  slot: PlayerSlot,
  plane: PlaneState,
  stats: PlaneStats,
  destroyedSlots: Set<PlayerSlot>
): void {
  const angleDiff = Math.abs(normalizeAngle(plane.angle - baseAngle(slot)));
  const rightSideUp = angleDiff <= Math.PI / 2;

  if (rightSideUp && plane.velocity.y < stats.allowedLandingSpeed) {
    plane.phase = 'landing';
    plane.position.y = GROUNDED_PLANE_Y;
    plane.velocity.y = 0;
    plane.angle = baseAngle(slot);
    plane.stallRemainingPx = 0;
  } else {
    destroyedSlots.add(slot);
  }
}

function updateLandingPlane(
  slot: PlayerSlot,
  plane: PlaneState,
  stats: PlaneStats,
  input: { launchPressed: boolean }
): boolean {
  plane.position.y = GROUNDED_PLANE_Y;
  plane.velocity.y = 0;
  plane.angle = baseAngle(slot);

  const currentSpeed = Math.abs(plane.velocity.x);
  if (currentSpeed > 0) {
    const newSpeed = Math.max(0, currentSpeed - stats.brakingDeceleration * DT_SECONDS);
    plane.velocity.x = Math.sign(plane.velocity.x) * newSpeed;
    plane.position.x += plane.velocity.x * DT_SECONDS;
    plane.position.x = wrapX(plane.position.x, PLANE_WRAP_MARGIN);
  } else if (input.launchPressed) {
    plane.phase = 'runway';
  }

  return true;
}

function updateAirbornePlane(
  slot: PlayerSlot,
  plane: PlaneState,
  input: { pitchUpPressed: boolean; pitchDownPressed: boolean },
  stats: PlaneStats
): boolean {
  // Continue accelerating until airSpeed is reached, carrying over whatever
  // speed the plane had at the moment of lift-off.
  const currentSpeed = Math.hypot(plane.velocity.x, plane.velocity.y);
  const newSpeed = Math.min(currentSpeed + stats.acceleration * DT_SECONDS, stats.airSpeed);

  // Stall triggers only at the sky ceiling: the plane is pinned upward and
  // horizontal speed has bled off to near zero (the "candle" scenario).
  if (plane.position.y <= SKY_MARGIN && Math.abs(plane.velocity.x) < stats.airSpeed * (stats.stallThreshold / 100)) {
    plane.phase = 'stall';
    plane.stallRemainingPx = stats.diveExitDistance;
    return true;
  }

  // Turn authority scales from 0 (at airSpeed/2) to full turnRate (at airSpeed).
  // The exact value is locked in once newSpeed clamps to airSpeed to avoid drift.
  const effectiveTurnRate = getEffectiveTurnRate(newSpeed, stats);

  const pitchIntent = (input.pitchUpPressed ? 1 : 0) - (input.pitchDownPressed ? 1 : 0);
  plane.angle = normalizeAngle(
    plane.angle + pitchIntent * noseUpAngleDirection(slot) * effectiveTurnRate * DT_SECONDS
  );
  applyVelocityFromAngle(plane, newSpeed);
  plane.position.x += plane.velocity.x * DT_SECONDS;
  plane.position.y += plane.velocity.y * DT_SECONDS;
  plane.position.x = wrapX(plane.position.x, PLANE_WRAP_MARGIN);

  if (plane.position.y < SKY_MARGIN) {
    plane.position.y = SKY_MARGIN;
  }

  return true;
}

function maybeCreateBullet(
  slot: PlayerSlot,
  plane: PlaneState,
  input: { firePressed: boolean },
  stats: PlaneStats
): BulletState | null {
  // Runway and airborne phases are both allowed to fire. Parked planes and
  // destroyed planes never spawn bullets.
  if ((plane.phase !== 'runway' && plane.phase !== 'airborne') || !input.firePressed) {
    return null;
  }

  if (plane.shotCooldownMs > 0) {
    return null;
  }

  plane.shotCooldownMs = stats.fireCooldownMs;
  const planeOrigin = getPlaneShapeOrigin(plane.position);
  // The right plane is rendered with scale(-1,1) + rotate(π - angle). Use the
  // same mirrored-space transform here so the bullet origin matches the visual nose.
  const muzzleLocal = slot === 'right'
    ? { x: -PLANE_GEOMETRY.muzzlePoint.x, y: PLANE_GEOMETRY.muzzlePoint.y }
    : PLANE_GEOMETRY.muzzlePoint;
  const muzzleAngle = slot === 'right' ? plane.angle - Math.PI : plane.angle;
  const muzzlePosition = transformPlanePoint(muzzleLocal, planeOrigin, muzzleAngle);

  return {
    id: `${slot}-${nextBulletId++}`,
    ownerSlot: slot,
    position: muzzlePosition,
    velocity: {
      x: Math.cos(plane.angle) * stats.bulletSpeed,
      y: Math.sin(plane.angle) * stats.bulletSpeed
    },
    ttlMs: (stats.bulletRange / stats.bulletSpeed) * 1000,
    radius: stats.bulletRadius
  };
}

function isBulletExpired(bullet: BulletState): boolean {
  return (
    bullet.ttlMs <= 0 ||
    bullet.position.y < -BULLET_WRAP_MARGIN ||
    bullet.position.y > GAME_HEIGHT + BULLET_WRAP_MARGIN
  );
}

function finalizeRound(room: RoomRecord): void {
  const outcome = room.pendingOutcome ?? resolveOutcome(
    new Set(room.state.players.filter((p) => p.plane.phase === 'destroyed').map((p) => p.slot))
  );
  delete room.pendingOutcome;
  room.state.status = 'round_over';
  room.state.winner = outcome;
  room.state.message =
    outcome === 'draw'
      ? 'Draw! Both pilots destroyed.'
      : `${outcome === 'left_win' ? 'Left' : 'Right'} pilot wins the round!`;
  awardRoundWin(room, outcome);
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

function syncPlane(target: PlaneState, source: PlaneState): boolean {
  const changed =
    target.position.x !== source.position.x ||
    target.position.y !== source.position.y ||
    target.velocity.x !== source.velocity.x ||
    target.velocity.y !== source.velocity.y ||
    target.angle !== source.angle ||
    target.phase !== source.phase ||
    target.shotCooldownMs !== source.shotCooldownMs;

  target.position.x = source.position.x;
  target.position.y = source.position.y;
  target.velocity.x = source.velocity.x;
  target.velocity.y = source.velocity.y;
  target.angle = source.angle;
  target.phase = source.phase;
  target.shotCooldownMs = source.shotCooldownMs;

  return changed;
}

// Velocity is always derived from angle and speed instead of being controlled
// independently. That keeps the flight model easy to reason about.
function applyVelocityFromAngle(plane: PlaneState, speed: number): void {
  plane.velocity.x = Math.cos(plane.angle) * speed;
  plane.velocity.y = Math.sin(plane.angle) * speed;
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
function wrapX(x: number, margin: number): number {
  if (x < -margin) return GAME_WIDTH + margin;
  if (x > GAME_WIDTH + margin) return -margin;
  return x;
}

function didPlanesCollide(players: RoomRecord['state']['players']): boolean {
  const [leftPlayer, rightPlayer] = players;

  if (!leftPlayer || !rightPlayer) {
    return false;
  }

  if (!canPlaneCollide(leftPlayer.plane) || !canPlaneCollide(rightPlayer.plane)) {
    return false;
  }

  const leftPolygons = getPlaneCollisionPolygons('left', leftPlayer.plane);
  const loopWidth = GAME_WIDTH + PLANE_WRAP_MARGIN * 2;

  for (const xOffset of [0, -loopWidth, loopWidth]) {
    const rightPolygons = getPlaneCollisionPolygons('right', rightPlayer.plane, xOffset);
    if (doCollisionPolygonSetsIntersect(leftPolygons, rightPolygons)) {
      return true;
    }
  }

  return false;
}

function canPlaneCollide(plane: PlaneState): boolean {
  return plane.phase !== 'destroyed';
}

function getPlaneCollisionPolygons(
  slot: PlayerSlot,
  plane: PlaneState,
  xOffset = 0
): PlanePoint[][] {
  const origin = getPlaneShapeOrigin({
    x: plane.position.x + xOffset,
    y: plane.position.y
  });

  if (slot === 'right') {
    const angle = plane.angle - Math.PI;
    return PLANE_GEOMETRY.collisionPolygons.map((polygon) =>
      transformPlanePolygon(
        polygon.map((p) => ({ x: -p.x, y: p.y })),
        origin,
        angle
      )
    );
  }

  return PLANE_GEOMETRY.collisionPolygons.map((polygon) =>
    transformPlanePolygon(polygon, origin, plane.angle)
  );
}

function doCollisionPolygonSetsIntersect(
  leftPolygons: readonly PlanePoint[][],
  rightPolygons: readonly PlanePoint[][]
): boolean {
  for (const leftPolygon of leftPolygons) {
    for (const rightPolygon of rightPolygons) {
      if (doPolygonsIntersect(leftPolygon, rightPolygon)) {
        return true;
      }
    }
  }

  return false;
}

function doesBulletHitPlane(bullet: BulletState, slot: PlayerSlot, plane: PlaneState): boolean {
  const collisionPolygons = getPlaneCollisionPolygons(slot, plane);
  return collisionPolygons.some((polygon) =>
    doesCircleIntersectPolygon(bullet.position, bullet.radius, polygon)
  );
}

function doesCircleIntersectPolygon(
  center: PlanePoint,
  radius: number,
  polygon: readonly PlanePoint[]
): boolean {
  if (isPointInPolygon(center, polygon)) {
    return true;
  }

  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];

    if (distancePointToSegmentSquared(center, start, end) <= radius * radius) {
      return true;
    }
  }

  return false;
}

function doPolygonsIntersect(
  leftPolygon: readonly PlanePoint[],
  rightPolygon: readonly PlanePoint[]
): boolean {
  for (let leftIndex = 0; leftIndex < leftPolygon.length; leftIndex += 1) {
    const leftStart = leftPolygon[leftIndex];
    const leftEnd = leftPolygon[(leftIndex + 1) % leftPolygon.length];

    for (let rightIndex = 0; rightIndex < rightPolygon.length; rightIndex += 1) {
      const rightStart = rightPolygon[rightIndex];
      const rightEnd = rightPolygon[(rightIndex + 1) % rightPolygon.length];

      if (doSegmentsIntersect(leftStart, leftEnd, rightStart, rightEnd)) {
        return true;
      }
    }
  }

  return isPointInPolygon(leftPolygon[0], rightPolygon) || isPointInPolygon(rightPolygon[0], leftPolygon);
}

function doSegmentsIntersect(
  firstStart: PlanePoint,
  firstEnd: PlanePoint,
  secondStart: PlanePoint,
  secondEnd: PlanePoint
): boolean {
  const orientationA = orientation(firstStart, firstEnd, secondStart);
  const orientationB = orientation(firstStart, firstEnd, secondEnd);
  const orientationC = orientation(secondStart, secondEnd, firstStart);
  const orientationD = orientation(secondStart, secondEnd, firstEnd);

  if (orientationA !== orientationB && orientationC !== orientationD) {
    return true;
  }

  if (orientationA === 0 && isPointOnSegment(secondStart, firstStart, firstEnd)) {
    return true;
  }

  if (orientationB === 0 && isPointOnSegment(secondEnd, firstStart, firstEnd)) {
    return true;
  }

  if (orientationC === 0 && isPointOnSegment(firstStart, secondStart, secondEnd)) {
    return true;
  }

  return orientationD === 0 && isPointOnSegment(firstEnd, secondStart, secondEnd);
}

function orientation(origin: PlanePoint, target: PlanePoint, point: PlanePoint): number {
  const crossProduct =
    (target.y - origin.y) * (point.x - target.x) -
    (target.x - origin.x) * (point.y - target.y);

  if (Math.abs(crossProduct) < 0.0001) {
    return 0;
  }

  return crossProduct > 0 ? 1 : 2;
}

function isPointOnSegment(point: PlanePoint, segmentStart: PlanePoint, segmentEnd: PlanePoint): boolean {
  return (
    point.x <= Math.max(segmentStart.x, segmentEnd.x) &&
    point.x >= Math.min(segmentStart.x, segmentEnd.x) &&
    point.y <= Math.max(segmentStart.y, segmentEnd.y) &&
    point.y >= Math.min(segmentStart.y, segmentEnd.y)
  );
}

function isPointInPolygon(point: PlanePoint, polygon: readonly PlanePoint[]): boolean {
  let inside = false;

  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
    const current = polygon[index];
    const previous = polygon[previousIndex];

    const intersects =
      current.y > point.y !== previous.y > point.y &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function distancePointToSegmentSquared(
  point: PlanePoint,
  segmentStart: PlanePoint,
  segmentEnd: PlanePoint
): number {
  const segmentX = segmentEnd.x - segmentStart.x;
  const segmentY = segmentEnd.y - segmentStart.y;
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;

  if (segmentLengthSquared === 0) {
    return distanceSquaredPoints(point, segmentStart);
  }

  const projection =
    ((point.x - segmentStart.x) * segmentX + (point.y - segmentStart.y) * segmentY) /
    segmentLengthSquared;
  const clampedProjection = Math.max(0, Math.min(1, projection));

  return distanceSquaredPoints(point, {
    x: segmentStart.x + segmentX * clampedProjection,
    y: segmentStart.y + segmentY * clampedProjection
  });
}

function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function distanceSquaredPoints(first: PlanePoint, second: PlanePoint): number {
  const dx = first.x - second.x;
  const dy = first.y - second.y;
  return dx * dx + dy * dy;
}
