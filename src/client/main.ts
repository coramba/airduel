import {
  BULLET_WRAP_MARGIN,
  GAME_HEIGHT,
  GAME_WIDTH,
  GROUND_HEIGHT,
  PLAYER_SLOTS,
  PLANE_WRAP_MARGIN,
  RUNWAY_HEIGHT,
  createDefaultInputState,
  type BulletState,
  type CreateRoomResponse,
  type InputState,
  type PlanePhase,
  type PlaneState,
  type PlayerSlot,
  type PlayerState,
  type RoomState,
  type ServerErrorCode,
  type ServerMessage
} from '../shared/game.js';
import {
  PLANE_GEOMETRY,
  getPlaneShapeOrigin,
  type PlaneGeometry,
  type PlanePoint
} from '../shared/plane-shape.js';
import {
  DEFAULT_PLANE_STATS,
  DEFAULT_RUNWAY_CONFIG,
  EXPLOSION_DURATION_MS,
  PLANE_STATS_FIELDS,
  RUNWAY_CONFIG_FIELDS,
  type PlaneStats,
  type RunwayConfig
} from '../shared/game-config.js';

// Browser runtime for the game client.
// This file owns:
// - canvas rendering
// - lightweight UI state for room setup
// - websocket lifecycle
// - keyboard input capture
// The server remains authoritative for room state and simulation.
type ConnectionPhase = 'idle' | 'creating' | 'connecting' | 'connected' | 'error';
type SetupPanelMode = 'hidden' | 'share' | 'join';

interface AppState {
  roomId: string | null;
  roomLink: string | null;
  slot: PlayerSlot | null;
  roomState: RoomState | null;
  phase: ConnectionPhase;
  feedback: string;
  setupPanelMode: SetupPanelMode;
}

interface RoomSnapshot {
  receivedAtMs: number;
  state: RoomState;
}

interface PlayerCardRefs {
  item: HTMLLIElement;
  scoreCluster: HTMLDivElement;
  scoreCircle: HTMLSpanElement;
  crown: HTMLSpanElement;
  badge: HTMLSpanElement;
  marker: HTMLSpanElement;
  detail: HTMLSpanElement;
}

const PLAYER_GLOW: Record<PlayerSlot, string> = {
  left:  'rgba(212, 85, 45, 0.32)',
  right: 'rgba(42, 93, 148, 0.3)'
};

function loadImage(src: string): HTMLImageElement {
  const img = new Image();
  img.src = src;
  return img;
}

const PLANE_IMAGES: Record<PlayerSlot, HTMLImageElement> = {
  left: loadImage('/images/plane2.png'),
  right: loadImage('/images/plane1.png')
};

const horizonImage = loadImage('/images/horizon2.png');
const EXPLOSION_GROW_MS = 300;
const EXPLOSION_SHRINK_MS = 400;

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

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }

  return element;
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
    drawHeadline(context, 'Create or join a room', 'Room setup happens first, then the duel runs here.');
    return;
  }

  drawRunways(context);

  for (const bullet of roomState.bullets) {
    drawBullet(context, bullet);
  }

  for (const player of roomState.players) {
    drawPlane(context, player, appState.slot === player.slot);
  }

  if (shouldShowHud(roomState)) {
    drawHud(context, appState, roomState);
  }

  if (roomState.status === 'round_over') {
    drawRoundResult(context, appState, roomState);
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

  if (horizonImage.complete && horizonImage.naturalWidth > 0) {
    const imgH = horizonImage.naturalHeight;
    const y = GAME_HEIGHT - GROUND_HEIGHT - imgH + 7;
    context.globalAlpha = 0.6;
    for (let x = 0; x < GAME_WIDTH; x += horizonImage.naturalWidth) {
      context.drawImage(horizonImage, x, y);
    }
    context.globalAlpha = 1;
  }

  context.fillStyle = '#477f34';
  context.fillRect(0, GAME_HEIGHT - GROUND_HEIGHT, GAME_WIDTH, 10);

  context.fillStyle = 'rgba(255, 255, 255, 0.85)';
  context.beginPath();
  context.arc(156, 98, 34, 0, Math.PI * 2);
  context.arc(185, 98, 24, 0, Math.PI * 2);
  context.arc(132, 110, 24, 0, Math.PI * 2);
  context.fill();

  context.beginPath();
  context.arc(760, 72, 30, 0, Math.PI * 2);
  context.arc(790, 72, 22, 0, Math.PI * 2);
  context.arc(735, 84, 20, 0, Math.PI * 2);
  context.fill();
}

// Runways are drawn separately from the simulation so the shared geometry stays
// visually obvious during waiting and active phases.
function drawRunways(context: CanvasRenderingContext2D): void {
  const runwayY = GAME_HEIGHT - GROUND_HEIGHT - RUNWAY_HEIGHT;

  for (const slot of PLAYER_SLOTS) {
    const { startX, length } = editableRunwayConfig[slot];
    const x = slot === 'left' ? startX : startX - length;

    context.fillStyle = '#6d5a4d';
    context.fillRect(x, runwayY, length, 14);

    context.fillStyle = 'rgba(255, 255, 255, 0.6)';
    for (let mark = x + 12; mark + 10 <= x + length; mark += 22) {
      context.fillRect(mark, runwayY + 5, 10, 4);
    }
  }
}

function drawHeadline(context: CanvasRenderingContext2D, title: string, subtitle: string): void {
  context.fillStyle = 'rgba(255, 248, 234, 0.92)';
  context.fillRect(26, 26, 510, 92);
  context.fillStyle = '#15314b';
  context.font = '700 29px "Trebuchet MS", sans-serif';
  context.fillText(title, 46, 62);
  context.font = '16px "Trebuchet MS", sans-serif';
  context.fillText(subtitle, 46, 92);
}

function drawHud(context: CanvasRenderingContext2D, appState: AppState, roomState: RoomState): void {
  // The HUD is shown only during the waiting phase, so the status text can stay
  // focused on room setup instead of active-flight instructions.
  const statusLine = getWaitingHudStatusText(appState);
  const detailLine = appState.feedback;

  context.fillStyle = 'rgba(255, 248, 234, 0.9)';
  context.fillRect(24, 22, 540, 112);
  context.fillStyle = '#15314b';
  context.font = '700 28px "Trebuchet MS", sans-serif';
  const statusLineCount = drawWrappedText(context, statusLine, 42, 58, 500, 28);
  context.font = '16px "Trebuchet MS", sans-serif';
  drawWrappedText(context, detailLine, 42, 58 + statusLineCount * 28 + 10, 500, 20);

  const ownPlayer = appState.slot
    ? roomState.players.find((player) => player.slot === appState.slot) ?? null
    : null;

  context.fillStyle = 'rgba(21, 49, 75, 0.82)';
  context.fillRect(GAME_WIDTH - 270, 24, 230, 78);
  context.fillStyle = '#f8fbff';
  context.font = '700 17px "Trebuchet MS", sans-serif';
  context.fillText(`Room ${roomState.id}`, GAME_WIDTH - 250, 50);
  context.font = '15px "Trebuchet MS", sans-serif';
  context.fillText(
    ownPlayer ? `${formatSlot(ownPlayer.slot)} pilot: ${formatPhase(ownPlayer.plane.phase)}` : 'Awaiting assignment',
    GAME_WIDTH - 250,
    76
  );
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
  const GROW_MS = 300;
  const SHRINK_MS = 400;
  if (elapsedMs < GROW_MS) {
    return 0.25 + 0.75 * (elapsedMs / GROW_MS);
  }
  const shrinkStart = EXPLOSION_DURATION_MS - SHRINK_MS;
  if (elapsedMs < shrinkStart) {
    return 1.0;
  }
  if (elapsedMs < EXPLOSION_DURATION_MS) {
    return 1.0 - 0.75 * ((elapsedMs - shrinkStart) / SHRINK_MS);
  }
  return 0;
}

function showExplosionSprite(slot: PlayerSlot, gameX: number, gameY: number): void {
  const sprite = explosionSprites[slot];
  sprite.style.left = `${(gameX / GAME_WIDTH) * 100}%`;
  sprite.style.top = `${(gameY / GAME_HEIGHT) * 100}%`;
  sprite.style.display = 'block';
  // Force the GIF to restart from frame 0 by re-assigning src.
  sprite.src = '/images/airexplosion1.gif';
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

function drawRoundResult(context: CanvasRenderingContext2D, appState: AppState, roomState: RoomState): void {
  const resultLine = getRoundResultText(roomState, appState.slot);
  const subLine = getRoundOverlayMessage(appState);

  context.fillStyle = 'rgba(14, 26, 38, 0.74)';
  context.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  context.fillStyle = '#fff9ef';
  context.fillRect(200, 185, 560, 148);
  context.fillStyle = '#15314b';
  context.font = '700 36px "Trebuchet MS", sans-serif';
  context.fillText(resultLine, 236, 244);
  context.font = '18px "Trebuchet MS", sans-serif';
  drawWrappedText(context, subLine, 236, 282, 488, 24);
}

// Simple canvas word-wrapping helper reused by the waiting HUD and the
// round-over overlay so message changes do not require hand-tuned coordinates.
function drawWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number
): number {
  const words = text.split(/\s+/);
  let currentLine = '';
  let currentY = y;
  let lineCount = 0;

  for (const word of words) {
    const nextLine = currentLine ? `${currentLine} ${word}` : word;
    if (currentLine && context.measureText(nextLine).width > maxWidth) {
      context.fillText(currentLine, x, currentY);
      lineCount += 1;
      currentLine = word;
      currentY += lineHeight;
      continue;
    }

    currentLine = nextLine;
  }

  if (currentLine) {
    context.fillText(currentLine, x, currentY);
    lineCount += 1;
  }

  return lineCount;
}

// DOM bootstrap section.
// Elements are grabbed once at startup and updated through the centralized
// `render()` function below.
const canvasRoot = requireElement<HTMLDivElement>('#canvas-root');
const createRoomButton = requireElement<HTMLButtonElement>('#create-room-button');
const secondaryActionButton = requireElement<HTMLButtonElement>('#secondary-action-button');
const rematchRow = requireElement<HTMLDivElement>('#rematch-row');
const rematchButton = requireElement<HTMLButtonElement>('#rematch-button');
const setupForm = requireElement<HTMLFormElement>('#setup-form');
const setupFieldLabel = requireElement<HTMLLabelElement>('#setup-field-label');
const joinRoomInput = requireElement<HTMLInputElement>('#join-room-input');
const setupSubmitButton = requireElement<HTMLButtonElement>('#setup-submit-button');
const feedbackElement = requireElement<HTMLParagraphElement>('#session-feedback');
const playerListElement = requireElement<HTMLUListElement>('#player-list');
const rematchStatusElement = requireElement<HTMLParagraphElement>('#rematch-status');
const planeDebugPanel = requireElement<HTMLDivElement>('#plane-debug-panel');
const planeTelemetryContainer = requireElement<HTMLDivElement>('#plane-telemetry');
const planeGeometryEditor = requireElement<HTMLTextAreaElement>('#plane-geometry-editor');
const planeGeometryFeedbackElement = requireElement<HTMLParagraphElement>('#plane-geometry-feedback');
const planeStatsContainer = requireElement<HTMLDivElement>('#plane-stats-container');
const runwayConfigContainer = requireElement<HTMLDivElement>('#runway-config-container');
const canvas = createCanvas();
const canvasContext = canvas.getContext('2d');

if (!canvasContext) {
  throw new Error('Canvas 2D context is unavailable.');
}

const context = canvasContext;
canvasRoot.replaceChildren(canvas);

function createExplosionSprite(): HTMLImageElement {
  const img = new Image();
  img.src = '/images/airexplosion1.gif';
  img.className = 'explosion-sprite';
  canvasRoot.appendChild(img);
  return img;
}

const explosionSprites: Record<PlayerSlot, HTMLImageElement> = {
  left: createExplosionSprite(),
  right: createExplosionSprite()
};

const playerCardRefs = new Map<PlayerSlot, PlayerCardRefs>(
  PLAYER_SLOTS.map((slot) => [slot, createPlayerCard(slot)])
);
playerListElement.replaceChildren(...PLAYER_SLOTS.map((slot) => playerCardRefs.get(slot)!.item));

const initialRoomId = extractRoomId(window.location.href);

const state: AppState = {
  roomId: initialRoomId,
  roomLink: initialRoomId ? `${window.location.origin}/?room=${initialRoomId}` : null,
  slot: null,
  roomState: null,
  phase: initialRoomId ? 'connecting' : 'idle',
  feedback: initialRoomId
    ? `Joining room ${initialRoomId} from the current URL.`
    : 'Create a room or join with a code to start.',
  setupPanelMode: 'hidden'
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
  left:  { ...DEFAULT_PLANE_STATS.left  },
  right: { ...DEFAULT_PLANE_STATS.right }
};

const editableRunwayConfig: Record<PlayerSlot, RunwayConfig> = {
  left:  { ...DEFAULT_RUNWAY_CONFIG.left  },
  right: { ...DEFAULT_RUNWAY_CONFIG.right }
};

type StatsInputMap = Record<keyof PlaneStats, HTMLInputElement>;
const statsInputs: Partial<Record<PlayerSlot, StatsInputMap>> = {};

type RunwayInputMap = Record<keyof RunwayConfig, HTMLInputElement>;
const runwayInputs: Partial<Record<PlayerSlot, RunwayInputMap>> = {};

const TELEMETRY_ROWS = [
  { key: 'speed',    label: 'Speed'        },
  { key: 'turnRate', label: 'Turn rate'    },
  { key: 'vx',       label: 'Velocity X'  },
  { key: 'vy',       label: 'Velocity Y'  },
  { key: 'accel',    label: 'Acceleration' },
] as const;

type TelemetryKey = (typeof TELEMETRY_ROWS)[number]['key'];
const telemetrySpans = {} as Record<TelemetryKey, HTMLSpanElement>;

function buildTelemetry(container: HTMLElement): void {
  for (const row of TELEMETRY_ROWS) {
    const label = document.createElement('span');
    label.className = 'tel-label';
    label.textContent = row.label;

    const value = document.createElement('span');
    value.className = 'tel-value';
    value.textContent = '—';

    telemetrySpans[row.key] = value;
    container.append(label, value);
  }
}

function updateTelemetry(): void {
  if (!showPlaneGrid) {
    return;
  }

  const { slot, roomState } = state;

  if (!slot || !roomState || roomState.status !== 'active') {
    for (const row of TELEMETRY_ROWS) {
      telemetrySpans[row.key].textContent = '—';
    }
    return;
  }

  const player = roomState.players.find((p) => p.slot === slot);
  if (!player) {
    return;
  }

  const { plane } = player;
  const stats = editablePlaneStats[slot];
  const speed = Math.hypot(plane.velocity.x, plane.velocity.y);
  const effectiveTurnRate = speed >= stats.airSpeed
    ? stats.turnRate
    : stats.turnRate * Math.max(0, (speed - stats.airSpeed / 2) / (stats.airSpeed / 2));

  telemetrySpans.speed.textContent    = `${speed.toFixed(1)} px/s`;
  telemetrySpans.turnRate.textContent = `${effectiveTurnRate.toFixed(2)} rad/s`;
  telemetrySpans.vx.textContent       = `${plane.velocity.x.toFixed(1)} px/s`;
  telemetrySpans.vy.textContent       = `${plane.velocity.y.toFixed(1)} px/s`;
  telemetrySpans.accel.textContent    = `${stats.acceleration} px/s²`;
}

function sendPlaneStats(slot: PlayerSlot): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify({
    type: 'plane_stats_update',
    payload: { slot, stats: editablePlaneStats[slot] }
  }));
}

function sendRunwayConfig(slot: PlayerSlot): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify({
    type: 'runway_config_update',
    payload: { slot, config: editableRunwayConfig[slot] }
  }));
}

function buildStatsEditor(container: HTMLElement): void {
  const grid = document.createElement('div');
  grid.className = 'stats-editor-grid';

  for (const slot of PLAYER_SLOTS) {
    const column = document.createElement('div');
    column.className = 'stats-column';

    const heading = document.createElement('div');
    heading.className = `stats-slot-heading stats-slot-${slot}`;
    heading.textContent = `${slot === 'left' ? 'Left' : 'Right'} Plane`;
    column.append(heading);

    const inputs: Partial<StatsInputMap> = {};

    for (const field of PLANE_STATS_FIELDS) {
      const fieldDiv = document.createElement('div');
      fieldDiv.className = 'stats-field';

      const label = document.createElement('label');
      label.className = 'stats-field-label';
      label.textContent = field.label;

      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'stats-input';
      input.step = String(field.step);
      input.min = String(field.step);
      input.value = String(DEFAULT_PLANE_STATS[slot][field.key]);

      input.addEventListener('change', () => {
        const parsed = parseFloat(input.value);
        if (Number.isFinite(parsed) && parsed > 0) {
          editablePlaneStats[slot] = { ...editablePlaneStats[slot], [field.key]: parsed };
          sendPlaneStats(slot);
        } else {
          input.value = String(editablePlaneStats[slot][field.key]);
        }
      });

      label.append(input);
      fieldDiv.append(label);
      column.append(fieldDiv);
      inputs[field.key] = input;
    }

    statsInputs[slot] = inputs as StatsInputMap;
    grid.append(column);
  }

  container.append(grid);
}

function buildRunwayEditor(container: HTMLElement): void {
  const grid = document.createElement('div');
  grid.className = 'stats-editor-grid';

  for (const slot of PLAYER_SLOTS) {
    const column = document.createElement('div');
    column.className = 'stats-column';

    const heading = document.createElement('div');
    heading.className = `stats-slot-heading stats-slot-${slot}`;
    heading.textContent = `${slot === 'left' ? 'Left' : 'Right'} Runway`;
    column.append(heading);

    const inputs: Partial<RunwayInputMap> = {};

    for (const field of RUNWAY_CONFIG_FIELDS) {
      const fieldDiv = document.createElement('div');
      fieldDiv.className = 'stats-field';

      const label = document.createElement('label');
      label.className = 'stats-field-label';
      label.textContent = field.label;

      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'stats-input';
      input.step = String(field.step);
      input.min = String(field.step);
      input.value = String(DEFAULT_RUNWAY_CONFIG[slot][field.key]);

      input.addEventListener('change', () => {
        const parsed = parseFloat(input.value);
        if (Number.isFinite(parsed) && parsed > 0) {
          editableRunwayConfig[slot] = { ...editableRunwayConfig[slot], [field.key]: parsed };
          sendRunwayConfig(slot);
        } else {
          input.value = String(editableRunwayConfig[slot][field.key]);
        }
      });

      label.append(input);
      fieldDiv.append(label);
      column.append(fieldDiv);
      inputs[field.key] = input;
    }

    runwayInputs[slot] = inputs as RunwayInputMap;
    grid.append(column);
  }

  container.append(grid);
}

// `render()` is the single place that synchronizes DOM controls from app state.
// Gameplay visuals are rendered continuously by `requestAnimationFrame`, while
// this UI sync only updates the DOM controls and side panel.
function render(): void {
  const isBusy = state.phase === 'creating' || state.phase === 'connecting';
  createRoomButton.disabled = isBusy;

  secondaryActionButton.disabled = isBusy;

  const rematchVisible = isMatchStarted();
  rematchRow.hidden = !rematchVisible;
  rematchButton.textContent = hasRequestedRematch() ? 'Rematch Requested' : 'Rematch';
  rematchButton.disabled = !canRequestRematch();

  const setupVisible = shouldShowSetupPanel();
  setupForm.hidden = !setupVisible;

  if (setupVisible) {
    const shareMode = state.setupPanelMode === 'share';
    setupFieldLabel.textContent = shareMode ? 'Share this link' : 'Paste code or join link';
    joinRoomInput.readOnly = shareMode;
    joinRoomInput.placeholder = 'Paste code or join link';
    joinRoomInput.value = shareMode ? state.roomLink ?? '' : joinRoomInput.value;
    setupSubmitButton.textContent = shareMode ? 'Copy to Clipboard' : 'Join';
    setupSubmitButton.disabled = isBusy || (shareMode ? !state.roomLink : false);
  }

  feedbackElement.textContent = getVisibleFeedback();
  feedbackElement.hidden = feedbackElement.textContent === '';
  rematchStatusElement.textContent = getRematchStatusText();
  planeDebugPanel.hidden = !showPlaneGrid;
  if (document.activeElement !== planeGeometryEditor && planeGeometryEditor.value !== planeGeometryDraft) {
    planeGeometryEditor.value = planeGeometryDraft;
  }
  planeGeometryFeedbackElement.textContent = planeGeometryFeedback;
  planeGeometryFeedbackElement.hidden = planeGeometryFeedback === '';

  for (const slot of PLAYER_SLOTS) {
    const inputMap = statsInputs[slot];
    if (inputMap) {
      for (const { key } of PLANE_STATS_FIELDS) {
        const input = inputMap[key];
        if (document.activeElement !== input) {
          input.value = String(editablePlaneStats[slot][key]);
        }
      }
    }

    const runwayMap = runwayInputs[slot];
    if (runwayMap) {
      for (const { key } of RUNWAY_CONFIG_FIELDS) {
        const input = runwayMap[key];
        if (document.activeElement !== input) {
          input.value = String(editableRunwayConfig[slot][key]);
        }
      }
    }
  }

  renderPlayerList();
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
  updateTelemetry();
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

function shouldShowHud(roomState: RoomState): boolean {
  return roomState.status === 'waiting';
}

// Waiting HUD copy is intentionally small and specific to the only phase that
// still uses the in-canvas HUD after the UI cleanup passes.
function getWaitingHudStatusText(appState: AppState): string {
  if (!appState.roomState) {
    return 'Create or join a room';
  }

  const ownPlayer = appState.slot
    ? appState.roomState.players.find((player) => player.slot === appState.slot) ?? null
    : null;

  if (!ownPlayer) {
    return 'Share the link and wait for the second pilot.';
  }

  return ownPlayer.connected
    ? 'Share the link and wait for the second pilot.'
    : 'Connected. Waiting for player assignment.';
}

function isMatchStarted(): boolean {
  return Boolean(state.roomState && state.roomState.status !== 'waiting');
}

function shouldShowSetupPanel(): boolean {
  if (state.setupPanelMode === 'share') {
    return Boolean(state.roomLink) && !isMatchStarted();
  }

  return state.setupPanelMode === 'join';
}

// The side-panel feedback intentionally hides low-value waiting messages because
// that same information is already visible in the room setup UI and waiting HUD.
function getVisibleFeedback(): string {
  if (state.roomState?.status === 'round_over' && hasRequestedRematch()) {
    return state.roomState.rematchVotes.length === PLAYER_SLOTS.length
      ? 'Both rematch votes received.'
      : 'Waiting for the second player to confirm the rematch.';
  }

  return state.feedback === 'Waiting for the second pilot to join.' ? '' : state.feedback;
}

// Room cards are mounted once and then updated in place to avoid unnecessary DOM
// churn during active-round state syncs.
function renderPlayerList(): void {
  const players = state.roomState?.players ?? PLAYER_SLOTS.map((slot) => ({
    slot,
    connected: false,
    wins: 0,
    plane: {
      phase: 'parked' as PlanePhase
    }
  }));

  const shouldShowScores = players.some((player) => player.wins > 0);
  const highestWins = Math.max(...players.map((player) => player.wins));
  const tiedForLead = shouldShowScores && players.filter((player) => player.wins === highestWins).length > 1;

  for (const player of players) {
    const refs = playerCardRefs.get(player.slot);
    if (!refs) {
      continue;
    }

    refs.item.classList.toggle('is-current', player.slot === state.slot);
    refs.scoreCluster.hidden = !shouldShowScores;
    refs.scoreCircle.className = `score-circle ${getScoreTone(player.wins, highestWins, tiedForLead)}`;
    refs.scoreCircle.textContent = String(player.wins);
    refs.crown.hidden = !(shouldShowScores && player.wins === highestWins && !tiedForLead);
    refs.badge.textContent = player.connected ? 'Connected' : 'Open';
    refs.badge.classList.toggle('is-connected', player.connected);
    refs.marker.textContent = player.slot === state.slot ? 'You' : '';
    refs.detail.textContent = player.connected
      ? player.slot === state.slot
        ? formatPhase(player.plane.phase)
        : `Pilot present. ${formatPhase(player.plane.phase)}.`
      : 'Available for another browser to join.';
  }
}

function createPlayerCard(slot: PlayerSlot): PlayerCardRefs {
  const item = document.createElement('li');
  item.className = 'player-card';

  const scoreCluster = document.createElement('div');
  scoreCluster.className = 'score-cluster';

  const crown = document.createElement('span');
  crown.className = 'score-crown';
  crown.hidden = true;
  crown.setAttribute('aria-hidden', 'true');

  const scoreCircle = document.createElement('span');
  scoreCircle.className = 'score-circle is-trailing';
  scoreCircle.textContent = '0';

  scoreCluster.append(crown, scoreCircle);
  scoreCluster.hidden = true;

  const headerRow = document.createElement('div');
  headerRow.className = 'player-row';

  const name = document.createElement('span');
  name.className = 'player-name';
  name.textContent = `${formatSlot(slot)} pilot`;

  const statusStack = document.createElement('div');
  statusStack.className = 'player-status-stack';

  const badge = document.createElement('span');
  badge.className = 'player-state';
  badge.textContent = 'Open';

  const marker = document.createElement('span');
  marker.className = 'player-marker';

  const detail = document.createElement('span');
  detail.className = 'player-detail';
  detail.textContent = 'Available for another browser to join.';

  statusStack.append(badge, marker);
  headerRow.append(name, statusStack);
  item.append(scoreCluster, headerRow, detail);

  return {
    item,
    scoreCluster,
    scoreCircle,
    crown,
    badge,
    marker,
    detail
  };
}

// URL state is kept in sync with the current room id so refresh and share-link
// flows continue to work without extra routing infrastructure.
function setRoom(roomId: string | null): void {
  state.roomId = roomId;
  state.roomLink = roomId ? `${window.location.origin}/?room=${roomId}` : null;

  const url = new URL(window.location.href);
  if (roomId) {
    url.searchParams.set('room', roomId);
  } else {
    url.searchParams.delete('room');
  }

  window.history.replaceState(null, '', url);
}

function resetRoomView(feedback: string): void {
  state.slot = null;
  state.roomState = null;
  state.phase = 'error';
  state.feedback = feedback;
  state.setupPanelMode = 'join';
  setRoom(null);
  clearRoomSnapshots();
}

function extractRoomId(value: string): string | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  if (/^[A-Z2-9]{6}$/i.test(trimmedValue)) {
    return trimmedValue.toUpperCase();
  }

  try {
    const url = new URL(trimmedValue, window.location.origin);
    const queryRoomId = url.searchParams.get('room');
    return queryRoomId && /^[A-Z2-9]{6}$/i.test(queryRoomId) ? queryRoomId.toUpperCase() : null;
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
// Connection state is explicit so the setup panel can react cleanly during
// create, join, reconnect, and disconnect flows.
function connectToRoom(roomId: string): void {
  closeCurrentSocket();
  setRoom(roomId);

  state.slot = null;
  state.roomState = null;
  state.phase = 'connecting';
  state.feedback = 'Opening match…';
  localInput = createDefaultInputState();
  clearRoomSnapshots();
  render();

  const nextSocket = new WebSocket(buildWebSocketUrl(roomId));
  socket = nextSocket;

  nextSocket.addEventListener('open', () => {
    if (socket !== nextSocket) {
      return;
    }

    state.phase = 'connected';
    state.feedback = 'Connected. Waiting for the round state.';
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

    if (state.phase !== 'error') {
      state.phase = 'error';
      state.feedback = state.roomId
        ? `The connection for room ${state.roomId} closed.`
        : 'The room connection closed.';
    }

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
      state.feedback = `You are flying on the ${formatSlot(message.payload.slot).toLowerCase()} side.`;
      resetLocalInput();
      render();
      return;

    case 'room_state':
      setCurrentRoomState(message.payload);
      state.phase = 'connected';
      if (message.payload.status === 'waiting') {
        state.feedback = '';
      } else if (message.payload.message) {
        state.feedback = message.payload.message;
      } else if (message.payload.status === 'round_over') {
        state.feedback = 'Round complete.';
        resetLocalInput();
      } else {
        state.feedback = 'Live round synchronized from the server.';
      }

      if (message.payload.status === 'round_over' || message.payload.status === 'waiting') {
        resetLocalInput();
      }

      render();
      return;

    case 'error':
      closeCurrentSocket();
      resetRoomView(mapErrorMessage(message.payload.code, message.payload.message));
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

function formatSlot(slot: PlayerSlot): string {
  return slot === 'left' ? 'Left' : 'Right';
}

function formatPhase(phase: PlanePhase): string {
  switch (phase) {
    case 'parked':
      return 'On runway';
    case 'runway':
      return 'Rolling';
    case 'airborne':
      return 'Airborne';
    case 'stall':
      return 'Stall';
    case 'landing':
      return 'Landing';
    case 'destroyed':
      return 'Destroyed';
  }
}

function getRoundResultText(roomState: RoomState, slot: PlayerSlot | null): string {
  if (roomState.winner === 'draw') {
    return 'Draw';
  }

  if (roomState.winner === 'left_win') {
    return slot === 'left' ? 'You win' : 'Left pilot wins';
  }

  if (roomState.winner === 'right_win') {
    return slot === 'right' ? 'You win' : 'Right pilot wins';
  }

  return 'Round complete';
}

// Round-over copy depends on the local viewer's rematch vote, so it is derived
// from the full app state rather than only from the room payload.
function getRoundOverlayMessage(appState: AppState): string {
  if (!appState.roomState) {
    return 'Both pilots must request rematch.';
  }

  if (hasRequestedRematchFor(appState)) {
    return appState.roomState.rematchVotes.length === PLAYER_SLOTS.length
      ? 'Both pilots confirmed the rematch.'
      : 'Waiting for the second player to confirm the rematch.';
  }

  return getRematchPromptMessage(
    appState.roomState.message ?? 'Both pilots must request rematch.'
  );
}

function getScoreTone(wins: number, highestWins: number, tiedForLead: boolean): string {
  if (tiedForLead) {
    return 'is-tied';
  }

  return wins === highestWins ? 'is-leading' : 'is-trailing';
}

function hasRequestedRematch(): boolean {
  return hasRequestedRematchFor(state);
}

// Stateless helper used when overlay/feedback logic needs the same rematch-vote
// answer without hard-wiring itself to the module-global state object.
function hasRequestedRematchFor(appState: Pick<AppState, 'slot' | 'roomState'>): boolean {
  return Boolean(appState.slot && appState.roomState?.rematchVotes.includes(appState.slot));
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

function getRematchStatusText(): string {
  if (!state.roomState) {
    return '';
  }

  if (state.roomState.status !== 'round_over') {
    return '';
  }

  if (!state.slot) {
    return state.roomState.message ?? 'Waiting for slot assignment.';
  }

  const votes = state.roomState.rematchVotes.length;
  if (hasRequestedRematch()) {
    return votes === PLAYER_SLOTS.length
      ? 'Both rematch votes received.'
      : 'Waiting for the second player to confirm the rematch.';
  }

  return getRematchPromptMessage(
    state.roomState.message ?? 'Request rematch to start the next round.'
  );
}

function getRematchPromptMessage(baseMessage: string): string {
  return `${baseMessage} Press Y or use Rematch.`;
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

// Room setup section.
// Create, join, and copy-link flows all reuse the same small UI state machine.
async function createRoom(): Promise<void> {
  closeCurrentSocket();
  state.phase = 'creating';
  state.feedback = 'Creating a new room…';
  state.setupPanelMode = 'share';
  localInput = createDefaultInputState();
  render();

  try {
    const response = await fetch('/api/rooms', {
      method: 'POST'
    });

    if (!response.ok) {
      throw new Error(`Create room failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as CreateRoomResponse;
    state.roomLink = payload.joinUrl;
    connectToRoom(payload.roomId);
  } catch {
    resetRoomView('Room creation failed. Check the server and try again.');
    render();
  }
}

async function copyRoomLink(): Promise<void> {
  if (!state.roomLink) {
    return;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(state.roomLink);
    } else {
      joinRoomInput.focus();
      joinRoomInput.select();
      const copied = document.execCommand('copy');
      joinRoomInput.setSelectionRange(joinRoomInput.value.length, joinRoomInput.value.length);
      if (!copied) {
        throw new Error('copy_failed');
      }
    }

    state.feedback = 'Join link copied to clipboard.';
    render();
  } catch {
    state.feedback = 'Copy failed. Copy the link manually.';
    render();
  }
}

function showJoinSetup(): void {
  if (state.phase === 'creating' || state.phase === 'connecting') {
    return;
  }

  state.setupPanelMode = 'join';
  joinRoomInput.value = '';
  state.feedback = 'Paste a room code or join link.';
  render();
  joinRoomInput.focus();
}

// Global event wiring is kept at the bottom so the file reads top-down:
// helpers first, then lifecycle bootstrap.
createRoomButton.addEventListener('click', () => {
  void createRoom();
});

secondaryActionButton.addEventListener('click', () => {
  showJoinSetup();
});

rematchButton.addEventListener('click', () => {
  sendRematchRequest();
});

setupForm.addEventListener('submit', (event) => {
  event.preventDefault();

  if (state.setupPanelMode === 'share') {
    void copyRoomLink();
    return;
  }

  const roomId = extractRoomId(joinRoomInput.value);
  if (!roomId) {
    resetRoomView('Enter a six-character room id or a link containing ?room=.');
    state.setupPanelMode = 'join';
    render();
    return;
  }

  connectToRoom(roomId);
});

planeGeometryEditor.addEventListener('input', () => {
  applyPlaneGeometryDraft(planeGeometryEditor.value);
});

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

buildTelemetry(planeTelemetryContainer);
buildStatsEditor(planeStatsContainer);
buildRunwayEditor(runwayConfigContainer);
render();
window.requestAnimationFrame(drawFrame);

if (initialRoomId) {
  state.setupPanelMode = 'join';
  joinRoomInput.value = `${window.location.origin}/?room=${initialRoomId}`;
  connectToRoom(initialRoomId);
}
