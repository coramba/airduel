import {
  BULLET_WRAP_MARGIN,
  GAME_HEIGHT,
  GAME_WIDTH,
  GROUND_CONTACT_Y,
  GROUND_HEIGHT,
  PLAYER_SLOTS,
  PLANE_WRAP_MARGIN,
  RUNWAY_HEIGHT,
  createDefaultInputState,
  normalizeRoomId,
} from '../shared/game.js';
import {
  PLANE_GEOMETRY,
  getPlaneShapeOrigin,
} from '../shared/plane-shape.js';
import { createClientDom } from './dom.js';
import {
  CLOUD_CONFIG,
  DEFAULT_PLANE_CONFIG,
  DEFAULT_RUNWAY_CONFIG,
  DEFAULT_SPAWN_X,
  EXPLOSION_CONFIG,
  FLAG_CONFIG,
  HORIZON_CONFIG,
} from '../shared/game-config.js';
import type { BulletState, InputState, PlanePhase, PlaneState, PlayerSlot, PlayerState, RoomState, ServerErrorCode, ServerMessage } from '../types/game.js';
import type { CloudConfig, PlaneStats, RunwayConfig } from '../types/config.js';
import type { PlaneGeometry, PlanePoint } from '../types/geometry.js';
import type { AppState, Cloud, CloudPuff, RoomSnapshot } from '../types/client.js';

// Browser runtime for the game client.
// This file owns:
// - canvas rendering
// - runtime state and interpolation
// - websocket lifecycle
// - battlefield input capture
// The server remains authoritative for room state and simulation.
// Type definitions (AppState, Cloud, RoomSnapshot, …) live in src/types/client.ts.

const PLAYER_GLOW: Record<PlayerSlot, string> = {
  left:  'rgba(212, 85, 45, 0.32)',
  right: 'rgba(42, 93, 148, 0.3)'
};

function loadImage(src: string): HTMLImageElement {
  const img = new Image();
  img.src = src;
  return img;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const PLANE_IMAGES: Record<PlayerSlot, HTMLImageElement> = {
  left:  loadImage(`/images/${DEFAULT_PLANE_CONFIG.left.planeImage}`),
  right: loadImage(`/images/${DEFAULT_PLANE_CONFIG.right.planeImage}`),
};

const BUILDING_IMAGES: Record<PlayerSlot, HTMLImageElement> = {
  left:  loadImage(`/images/${DEFAULT_RUNWAY_CONFIG.left.buildingImage}`),
  right: loadImage(`/images/${DEFAULT_RUNWAY_CONFIG.right.buildingImage}`),
};

const horizonImages = HORIZON_CONFIG.map((layer) => ({
  ...layer,
  image: loadImage(`/images/${layer.image}`)
}));

const FLAG_IMAGES = {
  neutral: loadImage(`/images/${FLAG_CONFIG.imageNeutral}`),
  left:    loadImage(`/images/${FLAG_CONFIG.imageLeft}`),
  right:   loadImage(`/images/${FLAG_CONFIG.imageRight}`),
};


function generateClouds(cloudConfig: CloudConfig): Cloud[] {
  const random = createSeededRandom(cloudConfig.seed);
  const countRange = Math.max(0, cloudConfig.maxCount - cloudConfig.minCount);
  const baseCount = cloudConfig.minCount + Math.floor(random() * (countRange + 1));
  const upperThird = (GAME_HEIGHT - GROUND_HEIGHT) / 3;
  const clouds: Cloud[] = [];

  function makeCloud(y: number): Cloud {
    const puffCount = 3 + Math.floor(random() * 3); // 3–5 puffs
    const puffs: CloudPuff[] = [];
    let curX = 0;
    for (let p = 0; p < puffCount; p++) {
      const r = 13 + random() * 35;
      puffs.push({ dx: curX, dy: (random() - 0.5) * 12, r });
      curX += r * (0.45 + random() * 0.35);
    }
    const span = curX;
    for (const puff of puffs) puff.dx -= span / 2;
    return { x: 60 + random() * (GAME_WIDTH - 120), y, puffs, foreground: random() < 2 / 3 };
  }

  for (let i = 0; i < baseCount; i++) {
    clouds.push(makeCloud(50 + random() * 140));
  }

  const upperCount = Math.round(baseCount * cloudConfig.upperSkyDensity);
  for (let i = 0; i < upperCount; i++) {
    clouds.push(makeCloud(20 + random() * (upperThird - 20)));
  }

  return clouds;
}

function areCloudConfigsEqual(left: CloudConfig, right: CloudConfig): boolean {
  return (
    left.seed === right.seed &&
    left.minCount === right.minCount &&
    left.maxCount === right.maxCount &&
    left.upperSkyDensity === right.upperSkyDensity
  );
}

let displayedClouds = generateClouds({
  seed: 1,
  ...CLOUD_CONFIG
});


const PLANE_GRID_EXTENT = 100;
const PLANE_GRID_STEP = 10;
const GRID_TOGGLE_DOUBLE_PRESS_MS = 360;


// Reconnect tokens are stored in sessionStorage so a page reload can reclaim the
// same live slot without exposing that token in shared links.
function loadReconnectToken(roomId: string): string | null {
  return window.sessionStorage.getItem(`airduel:reconnect:${roomId}`);
}

function saveReconnectToken(roomId: string, reconnectToken: string): void {
  window.sessionStorage.setItem(`airduel:reconnect:${roomId}`, reconnectToken);
}

// Canvas rendering section.
// The draw helpers are intentionally stateless: they render the current app
// snapshot without mutating gameplay state.
function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'game-canvas';
  canvas.width = GAME_WIDTH;
  canvas.height = GAME_HEIGHT;
  canvas.setAttribute('aria-label', 'Air Duel battlefield');
  return canvas;
}

function drawScene(
  context: CanvasRenderingContext2D,
  appState: AppState,
  roomState: RoomState | null = appState.roomState
): void {
  drawBackground(context);

  if (!roomState) {
    return;
  }

  drawRunways(context);
  drawFlag(context, roomState);

  for (const bullet of roomState.bullets) {
    drawBullet(context, bullet);
  }

  for (const player of roomState.players) {
    drawPlane(context, player, appState.slot === player.slot);
  }

  drawClouds(context, true);
  if (showPlaneGrid) {
    context.save();
    context.strokeStyle = 'rgba(255, 0, 0, 0.8)';
    context.lineWidth = 1;
    context.setLineDash([6, 4]);
    context.beginPath();
    context.moveTo(0, GROUND_CONTACT_Y);
    context.lineTo(GAME_WIDTH, GROUND_CONTACT_Y);
    context.stroke();
    context.restore();
  }
}

function drawBackground(context: CanvasRenderingContext2D): void {
  context.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

  const skyGradient = context.createLinearGradient(0, 0, 0, GAME_HEIGHT - GROUND_HEIGHT);
  skyGradient.addColorStop(0, '#7dc2ff');
  skyGradient.addColorStop(1, '#d7f1ff');
  context.fillStyle = skyGradient;
  context.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT - GROUND_HEIGHT);

  const groundGradient = context.createLinearGradient(0, GAME_HEIGHT - GROUND_HEIGHT, 0, GAME_HEIGHT);
  groundGradient.addColorStop(0, '#be9257');
  groundGradient.addColorStop(1, '#d9bf79');
  context.fillStyle = groundGradient;
  context.fillRect(0, GAME_HEIGHT - GROUND_HEIGHT, GAME_WIDTH, GROUND_HEIGHT);

  for (const layer of horizonImages) {
    if (!layer.image.complete || layer.image.naturalWidth <= 0) {
      continue;
    }

    const imgH = layer.image.naturalHeight;
    const y = GAME_HEIGHT - GROUND_HEIGHT - imgH + layer.offsetY;
    context.globalAlpha = layer.alpha;
    for (let x = 0; x < GAME_WIDTH; x += layer.image.naturalWidth) {
      context.drawImage(layer.image, x, y);
    }
  }
  context.globalAlpha = 1;

  context.fillStyle = '#477f34';
  context.fillRect(0, GAME_HEIGHT - GROUND_HEIGHT, GAME_WIDTH, 10);

  drawClouds(context, false);
}

function drawClouds(context: CanvasRenderingContext2D, foreground: boolean): void {
  context.fillStyle = 'rgba(255, 255, 255, 0.85)';
  for (const cloud of displayedClouds) {
    if (cloud.foreground !== foreground) continue;
    for (const puff of cloud.puffs) {
      context.beginPath();
      context.arc(cloud.x + puff.dx, cloud.y + puff.dy, puff.r, 0, Math.PI * 2);
      context.fill();
    }
  }
}

// Runways are drawn separately from the simulation so the shared geometry stays
// visually obvious during waiting and active phases.
function drawRunways(context: CanvasRenderingContext2D): void {
  for (const slot of PLAYER_SLOTS) {
    const { startX, startY, length, buildingOffsetX, buildingOffsetY } = editableRunwayConfig[slot];
    const x = slot === 'left' ? startX : startX - length;

    context.fillStyle = '#6d5a4d';
    context.fillRect(x, startY, length, RUNWAY_HEIGHT);

    context.fillStyle = 'rgba(255, 255, 255, 0.6)';
    for (let mark = x + 12; mark + 10 <= x + length; mark += 22) {
      context.fillRect(mark, startY + 5, 10, 4);
    }

    const img = BUILDING_IMAGES[slot];
    if (img.complete && img.naturalWidth > 0) {
      const bx = slot === 'left'
        ? startX + buildingOffsetX
        : startX - img.naturalWidth + buildingOffsetX;
      const by = startY - img.naturalHeight + buildingOffsetY;
      context.drawImage(img, bx, by);
    }
  }
}

function drawFlag(context: CanvasRenderingContext2D, roomState: RoomState | null): void {
  let leftWins = 0;
  let rightWins = 0;
  if (roomState) {
    for (const p of roomState.players) {
      if (p.slot === 'left') leftWins = p.wins;
      else rightWins = p.wins;
    }
  }

  const key = leftWins > rightWins ? 'left' : rightWins > leftWins ? 'right' : 'neutral';
  const img = FLAG_IMAGES[key];

  if (!img.complete || img.naturalWidth === 0) {
    return;
  }

  const groundY = GAME_HEIGHT - GROUND_HEIGHT;
  const imgX = FLAG_CONFIG.x + FLAG_CONFIG.offsetX - img.naturalWidth / 2;
  const imgY = groundY - img.naturalHeight + FLAG_CONFIG.offsetY;
  context.drawImage(img, imgX, imgY);
}

function drawPlane(
  context: CanvasRenderingContext2D,
  player: PlayerState,
  isCurrentPlayer: boolean
): void {
  const glow = PLAYER_GLOW[player.slot];
  const { plane } = player;
  const isMirrored = player.slot === 'right';
  const geometry = getActivePlaneGeometry();
  const img = PLANE_IMAGES[player.slot];
  const horizontalExtent = getPlaneHorizontalRenderExtent(geometry, img);

  if (plane.phase === 'destroyed') {
    return;
  }

  drawWrappedHorizontally(
    plane.position.x,
    horizontalExtent,
    GAME_WIDTH + PLANE_WRAP_MARGIN * 2,
    (xOffset) => {
      context.save();
      const shapeOrigin = getPlaneShapeOrigin(
        {
          x: plane.position.x + xOffset,
          y: plane.position.y
        },
        geometry
      );
      context.translate(shapeOrigin.x, shapeOrigin.y);
      if (isMirrored) {
        // The right pilot's simulation heading is centered around `Math.PI`.
        // Rendering that heading with a literal 180-degree rotation flips the
        // asymmetrical biplane upside down, so we mirror the shape horizontally
        // and only apply the pitch offset away from the left-facing baseline.
        context.scale(-1, 1);
        context.rotate(Math.PI - plane.angle);
      } else {
        context.rotate(plane.angle);
      }

      if (img.complete && img.naturalWidth > 0) {
        const pivot = geometry.imagePivot ?? { x: img.naturalWidth / 2, y: img.naturalHeight / 2 };
        context.shadowBlur = isCurrentPlayer ? 22 : 0;
        context.shadowColor = glow;
        context.drawImage(img, -pivot.x, -pivot.y);
        context.shadowBlur = 0;
      }

      if (showPlaneGrid) {
        drawPlaneGridOverlay(context, isMirrored);
        drawCollisionOverlay(context);
      }

      context.restore();
    }
  );
}

function buildPolygonPath(context: CanvasRenderingContext2D, points: readonly PlanePoint[]): boolean {
  if (points.length === 0) {
    return false;
  }

  context.beginPath();
  context.moveTo(points[0].x, points[0].y);

  for (let index = 1; index < points.length; index += 1) {
    context.lineTo(points[index].x, points[index].y);
  }

  context.closePath();
  return true;
}

function drawPlaneGridOverlay(context: CanvasRenderingContext2D, isMirrored: boolean): void {
  context.save();
  context.globalAlpha = 0.75;

  for (
    let coordinate = -PLANE_GRID_EXTENT;
    coordinate <= PLANE_GRID_EXTENT;
    coordinate += PLANE_GRID_STEP
  ) {
    const isAxis = coordinate === 0;

    context.strokeStyle = isAxis ? 'rgba(0, 0, 0, 0.86)' : 'rgba(0, 0, 0, 0.5)';
    context.lineWidth = isAxis ? 1.8 : 0.75;

    context.beginPath();
    context.moveTo(coordinate, -PLANE_GRID_EXTENT);
    context.lineTo(coordinate, PLANE_GRID_EXTENT);
    context.stroke();

    context.beginPath();
    context.moveTo(-PLANE_GRID_EXTENT, coordinate);
    context.lineTo(PLANE_GRID_EXTENT, coordinate);
    context.stroke();
  }

  context.fillStyle = 'rgba(0, 0, 0, 0.95)';
  context.font = '700 12px "Trebuchet MS", sans-serif';
  context.textBaseline = 'middle';

  context.textAlign = 'center';
  drawPlaneGridLabel(context, `${-PLANE_GRID_EXTENT}`, -PLANE_GRID_EXTENT, -8, isMirrored);
  drawPlaneGridLabel(context, `${PLANE_GRID_EXTENT}`, PLANE_GRID_EXTENT, -8, isMirrored);

  context.textAlign = 'left';
  drawPlaneGridLabel(context, `${-PLANE_GRID_EXTENT}`, 6, -PLANE_GRID_EXTENT, isMirrored);
  drawPlaneGridLabel(context, `${PLANE_GRID_EXTENT}`, 6, PLANE_GRID_EXTENT, isMirrored);

  context.restore();
}

function drawPlaneGridLabel(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  isMirrored: boolean
): void {
  context.save();

  if (isMirrored) {
    context.scale(-1, 1);
    context.fillText(text, -x, y);
  } else {
    context.fillText(text, x, y);
  }

  context.restore();
}

function drawCollisionOverlay(context: CanvasRenderingContext2D): void {
  const geometry = getActivePlaneGeometry();
  context.save();
  context.strokeStyle = 'rgba(255, 40, 40, 0.9)';
  context.lineWidth = 1.5;
  context.setLineDash([4, 3]);
  for (const polygon of geometry.collisionPolygons) {
    if (buildPolygonPath(context, polygon as PlanePoint[])) {
      context.stroke();
    }
  }
  context.setLineDash([]);
  context.restore();
}

function getExplosionScale(elapsedMs: number): number {
  if (elapsedMs < EXPLOSION_CONFIG.growMs) {
    return 0.25 + 0.75 * (elapsedMs / EXPLOSION_CONFIG.growMs);
  }
  const shrinkStart = EXPLOSION_CONFIG.durationMs - EXPLOSION_CONFIG.shrinkMs;
  if (elapsedMs < shrinkStart) {
    return 1.0;
  }
  if (elapsedMs < EXPLOSION_CONFIG.durationMs) {
    return 1.0 - 0.75 * ((elapsedMs - shrinkStart) / EXPLOSION_CONFIG.shrinkMs);
  }
  return 0;
}

function showExplosionSprite(slot: PlayerSlot, gameX: number, gameY: number): void {
  const sprite = explosionSprites[slot];
  sprite.style.left = `${(gameX / GAME_WIDTH) * 100}%`;
  sprite.style.top = `${(gameY / GAME_HEIGHT) * 100}%`;
  sprite.style.display = 'block';
  // Force the GIF to restart from frame 0 by re-assigning src.
  sprite.src = `/images/${EXPLOSION_CONFIG.image}`;
}

function hideExplosionSprite(slot: PlayerSlot): void {
  explosionSprites[slot].style.display = 'none';
}

function updateExplosionSprites(): void {
  for (const slot of PLAYER_SLOTS) {
    const startMs = explosionStartTimes.get(slot);
    if (startMs === undefined) {
      continue;
    }
    const elapsed = performance.now() - startMs;
    const scale = getExplosionScale(elapsed);
    explosionSprites[slot].style.transform = `translate(-50%, -50%) scale(${scale})`;
  }
}

function drawBullet(context: CanvasRenderingContext2D, bullet: BulletState): void {
  drawWrappedHorizontally(
    bullet.position.x,
    bullet.radius,
    GAME_WIDTH + BULLET_WRAP_MARGIN * 2,
    (xOffset) => {
      context.fillStyle = '#d94133';
      context.beginPath();
      context.arc(bullet.position.x + xOffset, bullet.position.y, bullet.radius, 0, Math.PI * 2);
      context.fill();
    }
  );
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fillStyle: string | CanvasGradient
): void {
  context.save();
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fillStyle = fillStyle;
  context.fill();
  context.restore();
}

function strokeRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  context.save();
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.stroke();
  context.restore();
}


const canvas = createCanvas();
const canvasContext = canvas.getContext('2d');
const initialRoomId = extractRoomId(window.location.href);

if (!canvasContext) {
  throw new Error('Canvas 2D context is unavailable.');
}

const context = canvasContext;
const ui = createClientDom({
  initialRoomId,
  connectToRoom: (roomId) => {
    connectToRoom(roomId);
  },
  onRematch: () => {
    sendRematchRequest();
  },
  onPlaneGeometryInput: (value) => {
    applyPlaneGeometryDraft(value);
  },
  onPlaneStatsChange: (slot, key, value) => {
    editablePlaneStats[slot] = { ...editablePlaneStats[slot], [key]: value };
    sendPlaneStats(slot);
  },
  onSpawnXChange: (slot, value) => {
    editableSpawnX[slot] = value;
    sendSpawnX(slot);
  },
  onRunwayConfigChange: (slot, key, value) => {
    editableRunwayConfig[slot] = { ...editableRunwayConfig[slot], [key]: value };
  }
});
ui.mountCanvas(canvas);

const explosionSprites: Record<PlayerSlot, HTMLImageElement> = {
  left: ui.createExplosionSprite(),
  right: ui.createExplosionSprite()
};

const state: AppState = {
  roomId: initialRoomId,
  slot: null,
  roomState: null
};

let socket: WebSocket | null = null;
let localInput = createDefaultInputState();
let showPlaneGrid = false;
let lastGridToggleKeyAt = 0;
let planeGeometryDraft = serializePlaneGeometry(PLANE_GEOMETRY);
let planeGeometryFeedback = '';
let editablePlaneGeometry: PlaneGeometry | null = null;
let previousRoomSnapshot: RoomSnapshot | null = null;
let currentRoomSnapshot: RoomSnapshot | null = null;
const explosionStartTimes = new Map<PlayerSlot, number>();

const editablePlaneStats: Record<PlayerSlot, PlaneStats> = {
  left:  { ...DEFAULT_PLANE_CONFIG.left  },
  right: { ...DEFAULT_PLANE_CONFIG.right }
};

const editableSpawnX: Record<PlayerSlot, number> = { ...DEFAULT_SPAWN_X };

// Runway layout is decorative only, so edits stay local to the current browser.
const editableRunwayConfig: Record<PlayerSlot, RunwayConfig> = {
  left:  { ...DEFAULT_RUNWAY_CONFIG.left  },
  right: { ...DEFAULT_RUNWAY_CONFIG.right }
};

function sendPlaneStats(slot: PlayerSlot): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify({
    type: 'plane_stats_update',
    payload: { slot, stats: editablePlaneStats[slot] }
  }));
}

function sendSpawnX(slot: PlayerSlot): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify({
    type: 'spawn_x_update',
    payload: { slot, spawnX: editableSpawnX[slot] }
  }));
}

function render(): void {
  ui.render({
    appState: state,
    canRequestRematch: canRequestRematch(),
    editablePlaneStats,
    editableRunwayConfig,
    editableSpawnX,
    hasRequestedRematch: hasRequestedRematch(),
    planeGeometryDraft,
    planeGeometryFeedback,
    showPlaneGrid
  });
}

function clearRoomSnapshots(): void {
  previousRoomSnapshot = null;
  currentRoomSnapshot = null;
  explosionStartTimes.clear();
  for (const slot of PLAYER_SLOTS) {
    hideExplosionSprite(slot);
  }
}

function setCurrentRoomState(nextRoomState: RoomState): void {
  const prevState = currentRoomSnapshot?.state;

  if (!prevState || !areCloudConfigsEqual(prevState.roundSettings.clouds, nextRoomState.roundSettings.clouds)) {
    displayedClouds = generateClouds(nextRoomState.roundSettings.clouds);
  }

  if (prevState) {
    for (const player of nextRoomState.players) {
      if (player.plane.phase === 'destroyed') {
        const prevPlayer = prevState.players.find((p) => p.slot === player.slot);
        if (prevPlayer?.plane.phase !== 'destroyed' && !explosionStartTimes.has(player.slot)) {
          explosionStartTimes.set(player.slot, performance.now());
          showExplosionSprite(player.slot, player.plane.position.x, player.plane.position.y);
        }
      } else {
        explosionStartTimes.delete(player.slot);
        hideExplosionSprite(player.slot);
      }
    }
  }

  state.roomState = nextRoomState;
  previousRoomSnapshot = currentRoomSnapshot;
  currentRoomSnapshot = {
    state: nextRoomState,
    receivedAtMs: performance.now()
  };
}

function drawFrame(frameTimeMs: number): void {
  const displayedRoomState = getDisplayedRoomState(frameTimeMs);
  drawScene(context, state, displayedRoomState);
  updateExplosionSprites();
  ui.updateTelemetry({
    appState: state,
    canRequestRematch: canRequestRematch(),
    editablePlaneStats,
    editableRunwayConfig,
    editableSpawnX,
    hasRequestedRematch: hasRequestedRematch(),
    planeGeometryDraft,
    planeGeometryFeedback,
    showPlaneGrid
  });
  window.requestAnimationFrame(drawFrame);
}

function getDisplayedRoomState(frameTimeMs: number): RoomState | null {
  if (!currentRoomSnapshot) {
    return state.roomState;
  }

  if (!previousRoomSnapshot) {
    return currentRoomSnapshot.state;
  }

  if (
    previousRoomSnapshot.state.status !== 'active' ||
    currentRoomSnapshot.state.status !== 'active' ||
    previousRoomSnapshot.state.id !== currentRoomSnapshot.state.id ||
    previousRoomSnapshot.state.round !== currentRoomSnapshot.state.round
  ) {
    return currentRoomSnapshot.state;
  }

  const snapshotSpanMs = currentRoomSnapshot.receivedAtMs - previousRoomSnapshot.receivedAtMs;
  if (snapshotSpanMs <= 0) {
    return currentRoomSnapshot.state;
  }

  const interpolationAlpha = clamp(
    (frameTimeMs - currentRoomSnapshot.receivedAtMs) / snapshotSpanMs,
    0,
    1
  );

  return interpolateRoomState(previousRoomSnapshot.state, currentRoomSnapshot.state, interpolationAlpha);
}

function interpolateRoomState(previousState: RoomState, nextState: RoomState, alpha: number): RoomState {
  const previousPlayersBySlot = new Map(previousState.players.map((player) => [player.slot, player]));
  const previousBulletsById = new Map(previousState.bullets.map((bullet) => [bullet.id, bullet]));

  return {
    ...nextState,
    players: nextState.players.map((player) => {
      const previousPlayer = previousPlayersBySlot.get(player.slot);
      return {
        ...player,
        plane: previousPlayer
          ? interpolatePlaneState(previousPlayer.plane, player.plane, alpha)
          : player.plane
      };
    }),
    bullets: nextState.bullets.map((bullet) => {
      const previousBullet = previousBulletsById.get(bullet.id);
      return previousBullet ? interpolateBulletState(previousBullet, bullet, alpha) : bullet;
    })
  };
}

function interpolatePlaneState(previousPlane: PlaneState, nextPlane: PlaneState, alpha: number): PlaneState {
  return {
    ...nextPlane,
    position: {
      x: interpolateWrappedCoordinate(
        previousPlane.position.x,
        nextPlane.position.x,
        alpha,
        GAME_WIDTH + PLANE_WRAP_MARGIN * 2
      ),
      y: interpolateNumber(previousPlane.position.y, nextPlane.position.y, alpha)
    },
    velocity: {
      x: interpolateNumber(previousPlane.velocity.x, nextPlane.velocity.x, alpha),
      y: interpolateNumber(previousPlane.velocity.y, nextPlane.velocity.y, alpha)
    },
    angle: interpolateAngle(previousPlane.angle, nextPlane.angle, alpha)
  };
}

function interpolateBulletState(previousBullet: BulletState, nextBullet: BulletState, alpha: number): BulletState {
  return {
    ...nextBullet,
    position: {
      x: interpolateWrappedCoordinate(
        previousBullet.position.x,
        nextBullet.position.x,
        alpha,
        GAME_WIDTH + BULLET_WRAP_MARGIN * 2
      ),
      y: interpolateNumber(previousBullet.position.y, nextBullet.position.y, alpha)
    },
    velocity: {
      x: interpolateNumber(previousBullet.velocity.x, nextBullet.velocity.x, alpha),
      y: interpolateNumber(previousBullet.velocity.y, nextBullet.velocity.y, alpha)
    },
    ttlMs: interpolateNumber(previousBullet.ttlMs, nextBullet.ttlMs, alpha)
  };
}

function interpolateNumber(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

function interpolateAngle(from: number, to: number, alpha: number): number {
  return from + normalizeAngleDelta(to - from) * alpha;
}

function normalizeAngleDelta(delta: number): number {
  let normalizedDelta = delta;

  while (normalizedDelta > Math.PI) {
    normalizedDelta -= Math.PI * 2;
  }

  while (normalizedDelta < -Math.PI) {
    normalizedDelta += Math.PI * 2;
  }

  return normalizedDelta;
}

function interpolateWrappedCoordinate(from: number, to: number, alpha: number, wrapSize: number): number {
  let delta = to - from;

  if (Math.abs(delta) > wrapSize / 2) {
    delta -= Math.sign(delta) * wrapSize;
  }

  // Keep interpolation in the same extended wrap domain the server uses.
  // The renderer is responsible for drawing overlap copies at the visible edges.
  return from + delta * alpha;
}

function drawWrappedHorizontally(
  x: number,
  horizontalExtent: number,
  wrapSize: number,
  drawAtOffset: (xOffset: number) => void
): void {
  if (doesHorizontalSpanIntersectScreen(x, horizontalExtent)) {
    drawAtOffset(0);
  }

  if (doesHorizontalSpanIntersectScreen(x - wrapSize, horizontalExtent)) {
    drawAtOffset(-wrapSize);
  }

  if (doesHorizontalSpanIntersectScreen(x + wrapSize, horizontalExtent)) {
    drawAtOffset(wrapSize);
  }
}

function doesHorizontalSpanIntersectScreen(x: number, horizontalExtent: number): boolean {
  return x + horizontalExtent > 0 && x - horizontalExtent < GAME_WIDTH;
}

function getPlaneHorizontalRenderExtent(geometry: PlaneGeometry, img?: HTMLImageElement): number {
  if (img && img.complete && img.naturalWidth > 0) {
    const pivot = geometry.imagePivot ?? { x: img.naturalWidth / 2, y: img.naturalHeight / 2 };
    return Math.max(pivot.x, img.naturalWidth - pivot.x) + 8;
  }

  // Fallback: derive extent from collision polygons when the image is not ready.
  let maxX = 0;
  for (const polygon of geometry.collisionPolygons) {
    for (const point of polygon) {
      maxX = Math.max(maxX, Math.abs(point.x));
    }
  }
  return maxX + 8;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getActivePlaneGeometry(): PlaneGeometry {
  return editablePlaneGeometry ?? PLANE_GEOMETRY;
}

function serializePlaneGeometry(geometry: PlaneGeometry): string {
  return JSON.stringify(geometry, null, 2);
}

// URL state stays in sync with the active room id so refresh and room reconnect
// flows work without extra routing infrastructure.
function setRoom(roomId: string | null): void {
  state.roomId = roomId;

  const url = new URL(window.location.href);
  if (roomId) {
    url.searchParams.set('room', roomId);
  } else {
    url.searchParams.delete('room');
  }

  window.history.replaceState(null, '', url);
}

function resetRoomRuntime(): void {
  state.slot = null;
  state.roomState = null;
  setRoom(null);
  clearRoomSnapshots();
}

function extractRoomId(value: string): string | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  const directRoomId = normalizeRoomId(trimmedValue);
  if (directRoomId) {
    return directRoomId;
  }

  try {
    const url = new URL(trimmedValue, window.location.origin);
    return normalizeRoomId(url.searchParams.get('room'));
  } catch {
    return null;
  }
}

// Every socket connection includes the room id and, when available, the
// reconnect token for reclaiming an active slot after refresh.
function buildWebSocketUrl(roomId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const requestUrl = new URL(`${protocol}//${window.location.host}/ws`);
  requestUrl.searchParams.set('room', roomId);

  const reconnectToken = loadReconnectToken(roomId);
  if (reconnectToken) {
    requestUrl.searchParams.set('token', reconnectToken);
  }

  return requestUrl.toString();
}

function closeCurrentSocket(): void {
  if (!socket) {
    return;
  }

  const currentSocket = socket;
  socket = null;
  currentSocket.close();
}

function resetLocalInput(): void {
  localInput = createDefaultInputState();
  sendInput();
}

// WebSocket lifecycle section.
// Runtime connection state stays explicit so reconnect and disconnect handling
// remain predictable.
function connectToRoom(roomId: string): void {
  closeCurrentSocket();
  setRoom(roomId);

  state.slot = null;
  state.roomState = null;
  localInput = createDefaultInputState();
  clearRoomSnapshots();
  ui.setConnecting(roomId);
  render();

  const nextSocket = new WebSocket(buildWebSocketUrl(roomId));
  socket = nextSocket;

  nextSocket.addEventListener('open', () => {
    if (socket !== nextSocket) {
      return;
    }

    ui.setConnected();
    render();
  });

  nextSocket.addEventListener('message', (event) => {
    if (socket !== nextSocket || typeof event.data !== 'string') {
      return;
    }

    const message = JSON.parse(event.data) as ServerMessage;
    handleServerMessage(message);
  });

  nextSocket.addEventListener('close', () => {
    if (socket !== nextSocket) {
      return;
    }

    socket = null;
    localInput = createDefaultInputState();
    ui.setConnectionClosed(state.roomId);
    render();
  });
}

// Server messages are already authoritative state snapshots, so the client
// mostly stores the latest payload and derives UI from it.
function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'player_assignment':
      setRoom(message.payload.roomId);
      saveReconnectToken(message.payload.roomId, message.payload.reconnectToken);
      state.slot = message.payload.slot;
      ui.setAssignedSlot(message.payload.slot);
      resetLocalInput();
      render();
      return;

    case 'room_state':
      setCurrentRoomState(message.payload);
      ui.syncRoomStateFeedback(message.payload);

      if (message.payload.status === 'round_over' || message.payload.status === 'waiting') {
        resetLocalInput();
      }

      render();
      return;

    case 'error':
      closeCurrentSocket();
      resetRoomRuntime();
      ui.setConnectionError(mapErrorMessage(message.payload.code, message.payload.message));
      render();
  }
}

function mapErrorMessage(code: ServerErrorCode, fallbackMessage: string): string {
  switch (code) {
    case 'room_expired':
      return 'That room expired. Create a fresh match.';
    case 'room_full':
      return 'That room already has two pilots.';
    case 'room_not_found':
      return 'That room does not exist.';
    case 'invalid_room':
      return 'The room link or room id is invalid.';
    case 'invalid_message':
      return fallbackMessage;
  }
}

function hasRequestedRematch(): boolean {
  return Boolean(state.slot && state.roomState?.rematchVotes.includes(state.slot));
}

function canRequestRematch(): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN || !state.roomState || !state.slot) {
    return false;
  }

  if (state.roomState.status !== 'round_over') {
    return false;
  }

  const ownPlayer = state.roomState.players.find((player) => player.slot === state.slot);
  return Boolean(ownPlayer?.connected && !state.roomState.rematchVotes.includes(state.slot));
}

// Input section.
// The browser only sends intent flags; the server decides how those flags affect
// the plane based on the current room status and simulation phase.
function sendInput(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN || state.roomState?.status !== 'active') {
    return;
  }

  socket.send(
    JSON.stringify({
      type: 'input',
      payload: localInput
    })
  );
}

function sendRematchRequest(): void {
  if (!canRequestRematch() || !socket) {
    return;
  }

  socket.send(
    JSON.stringify({
      type: 'rematch_requested'
    })
  );
}

function updateInputField(field: keyof InputState, pressed: boolean): void {
  if (!state.slot) {
    return;
  }

  if (localInput[field] === pressed) {
    return;
  }

  localInput = {
    ...localInput,
    [field]: pressed
  };
  sendInput();
}

// Keyboard mapping is intentionally explicit so the controls stay discoverable
// and easy to tweak without extra abstraction.
function handleGameplayKey(event: KeyboardEvent, pressed: boolean): void {
  if (
    pressed &&
    !event.repeat &&
    (event.code === 'KeyX' || event.key === 'x' || event.key === 'X') &&
    !isEditableTarget(event.target)
  ) {
    const now = Date.now();

    if (now - lastGridToggleKeyAt <= GRID_TOGGLE_DOUBLE_PRESS_MS) {
      showPlaneGrid = !showPlaneGrid;
      lastGridToggleKeyAt = 0;
      if (showPlaneGrid) {
        planeGeometryDraft = serializePlaneGeometry(getActivePlaneGeometry());
        planeGeometryFeedback = 'Plane debug mode enabled.';
      } else {
        planeGeometryFeedback = '';
      }
      event.preventDefault();
      render();
      return;
    }

    lastGridToggleKeyAt = now;
  }

  if (
    pressed &&
    (event.code === 'KeyY' || event.key === 'y' || event.key === 'Y') &&
    canRequestRematch()
  ) {
    event.preventDefault();
    sendRematchRequest();
    return;
  }

  let field: keyof InputState | null = null;

  if (event.code === 'Space' || event.code === 'Enter') {
    field = 'launchPressed';
  } else if (event.code === 'ArrowUp') {
    field = 'pitchUpPressed';
  } else if (event.code === 'ArrowDown') {
    field = 'pitchDownPressed';
  } else if (
    event.code === 'ControlLeft' ||
    event.code === 'ControlRight' ||
    event.key === 'Control'
  ) {
    field = 'firePressed';
  }

  if (!field) {
    return;
  }

  event.preventDefault();

  if (!state.roomState || state.roomState.status !== 'active' || !state.slot) {
    return;
  }

  updateInputField(field, pressed);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

function applyPlaneGeometryDraft(rawDraft: string): void {
  planeGeometryDraft = rawDraft;

  try {
    const parsedValue = JSON.parse(rawDraft) as unknown;

    if (!isPlaneGeometry(parsedValue)) {
      throw new Error('The JSON does not match the expected plane geometry shape.');
    }

    editablePlaneGeometry = parsedValue;
    planeGeometryFeedback = 'Plane geometry updated locally.';
    render();
  } catch (error) {
    editablePlaneGeometry = null;
    planeGeometryFeedback =
      error instanceof Error ? error.message : 'Plane geometry JSON is invalid.';
    render();
  }
}

function isPlaneGeometry(value: unknown): value is PlaneGeometry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const geometry = value as Record<string, unknown>;
  return (
    typeof geometry.renderOffsetY === 'number' &&
    (!geometry.imagePivot || isPlanePoint(geometry.imagePivot)) &&
    isPlanePoint(geometry.muzzlePoint) &&
    isCollisionPolygonArray(geometry.collisionPolygons)
  );
}

function isPlanePoint(value: unknown): value is PlanePoint {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const point = value as Record<string, unknown>;
  return typeof point.x === 'number' && typeof point.y === 'number';
}

function isPlanePointArray(value: unknown): value is PlanePoint[] {
  return Array.isArray(value) && value.every((point) => isPlanePoint(point));
}

function isCollisionPolygonArray(value: unknown): value is PlanePoint[][] {
  return Array.isArray(value) && value.every((polygon) => isPlanePointArray(polygon));
}

window.addEventListener('keydown', (event) => {
  handleGameplayKey(event, true);
});

window.addEventListener('keyup', (event) => {
  handleGameplayKey(event, false);
});

window.addEventListener('blur', () => {
  localInput = createDefaultInputState();
  sendInput();
});

window.addEventListener('beforeunload', () => {
  localInput = createDefaultInputState();
  sendInput();
  closeCurrentSocket();
});

render();
window.requestAnimationFrame(drawFrame);

if (initialRoomId) {
  connectToRoom(initialRoomId);
}
