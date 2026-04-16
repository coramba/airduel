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
  type PlanePoint,
  type PlaneSegment
} from '../shared/plane-shape.js';

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

type PlanePalette = {
  fuselageLight: string;
  fuselageMid: string;
  fuselageDark: string;
  accent: string;
  accentSoft: string;
  canopy: string;
  metal: string;
  propeller: string;
  glow: string;
  tire: string;
};

const PLANE_GRID_EXTENT = 100;
const PLANE_GRID_STEP = 10;
const GRID_TOGGLE_DOUBLE_PRESS_MS = 360;

const PLAYER_COLORS: Record<PlayerSlot, PlanePalette> = {
  left: {
    fuselageLight: '#f27263',
    fuselageMid: '#d4552d',
    fuselageDark: '#8c2f1f',
    accent: '#702418',
    accentSoft: '#f5a18f',
    canopy: '#5e2a23',
    metal: '#4f2b22',
    propeller: '#c93429',
    glow: 'rgba(212, 85, 45, 0.32)',
    tire: '#2f2a2a'
  },
  right: {
    fuselageLight: '#74b3f2',
    fuselageMid: '#2a5d94',
    fuselageDark: '#173a60',
    accent: '#122e4c',
    accentSoft: '#a5d1f8',
    canopy: '#243d5a',
    metal: '#243645',
    propeller: '#cf4335',
    glow: 'rgba(42, 93, 148, 0.3)',
    tire: '#262224'
  }
};

// Reconnect tokens are stored in sessionStorage so a page reload can reclaim the
// same live slot without exposing that token in shared links.
function getReconnectTokenStorageKey(roomId: string): string {
  return `airduel:reconnect:${roomId}`;
}

function loadReconnectToken(roomId: string): string | null {
  return window.sessionStorage.getItem(getReconnectTokenStorageKey(roomId));
}

function saveReconnectToken(roomId: string, reconnectToken: string): void {
  window.sessionStorage.setItem(getReconnectTokenStorageKey(roomId), reconnectToken);
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
  const runwayWidth = 94;
  const leftX = 50;
  const rightX = GAME_WIDTH - leftX - runwayWidth;

  context.fillStyle = '#6d5a4d';
  context.fillRect(leftX, runwayY, runwayWidth, 14);
  context.fillRect(rightX, runwayY, runwayWidth, 14);

  context.fillStyle = 'rgba(255, 255, 255, 0.6)';
  for (const x of [leftX + 12, leftX + 34, leftX + 56, rightX + 12, rightX + 34, rightX + 56]) {
    context.fillRect(x, runwayY + 5, 10, 4);
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
  // Plane rendering stays purely cosmetic. The server still owns the movement,
  // hit logic, and exact state; the client just draws a readable biplane shell.
  const colors = PLAYER_COLORS[player.slot];
  const { plane } = player;
  const isMirrored = player.slot === 'right';
  const geometry = getActivePlaneGeometry();
  const horizontalExtent = getPlaneHorizontalRenderExtent(geometry);

  if (plane.phase === 'destroyed') {
    drawWrappedHorizontally(
      plane.position.x,
      horizontalExtent,
      GAME_WIDTH + PLANE_WRAP_MARGIN * 2,
      (xOffset) => {
        drawExplosion(context, plane.position.x + xOffset, plane.position.y, colors.glow);
      }
    );
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

      context.shadowBlur = isCurrentPlayer ? 22 : 0;
      context.shadowColor = colors.glow;

      context.fillStyle = colors.fuselageLight;
      fillPolygon(context, geometry.fuselageTop);

      context.fillStyle = colors.fuselageMid;
      fillPolygon(context, geometry.fuselageBottom);

      context.fillStyle = colors.accentSoft;
      fillPolygon(context, geometry.noseCap);

      context.fillStyle = colors.fuselageLight;
      fillPolygon(context, geometry.topWing);

      context.fillStyle = colors.accent;
      fillPolygon(context, geometry.accentStripe);

      context.fillStyle = colors.fuselageDark;
      fillPolygon(context, geometry.tailFin);

      context.fillStyle = colors.accentSoft;
      fillPolygon(context, geometry.tailWing);

      context.fillStyle = colors.fuselageMid;
      fillPolygon(context, geometry.bottomWing);

      context.fillStyle = colors.fuselageDark;
      context.strokeStyle = colors.fuselageDark;
      context.lineWidth = 2.5;
      context.lineCap = 'round';
      for (const strut of geometry.struts) {
        strokeSegment(context, strut);
      }

      context.strokeStyle = colors.metal;
      for (const gearSegment of geometry.landingGear) {
        strokeSegment(context, gearSegment);
      }

      context.fillStyle = colors.tire;
      fillCircle(context, geometry.wheel.center, geometry.wheel.radius);

      context.fillStyle = '#dad7db';
      fillCircle(context, geometry.wheelHub.center, geometry.wheelHub.radius);

      context.fillStyle = 'rgba(255, 247, 222, 0.95)';
      fillPolygon(context, geometry.cockpit);
      context.strokeStyle = colors.canopy;
      context.lineWidth = 2;
      strokePolygon(context, geometry.cockpit);

      context.fillStyle = colors.propeller;
      fillEllipse(
        context,
        geometry.propeller.center,
        geometry.propeller.radiusX,
        geometry.propeller.radiusY
      );

      context.fillStyle = '#b53b2f';
      fillCircle(context, geometry.spinner.center, geometry.spinner.radius);

      if (showPlaneGrid) {
        drawPlaneGridOverlay(context, isMirrored);
      }

      context.restore();
    }
  );
}

function fillPolygon(context: CanvasRenderingContext2D, points: readonly PlanePoint[]): void {
  if (points.length === 0) {
    return;
  }

  context.beginPath();
  context.moveTo(points[0].x, points[0].y);

  for (let index = 1; index < points.length; index += 1) {
    context.lineTo(points[index].x, points[index].y);
  }

  context.closePath();
  context.fill();
}

function strokePolygon(context: CanvasRenderingContext2D, points: readonly PlanePoint[]): void {
  if (points.length === 0) {
    return;
  }

  context.beginPath();
  context.moveTo(points[0].x, points[0].y);

  for (let index = 1; index < points.length; index += 1) {
    context.lineTo(points[index].x, points[index].y);
  }

  context.closePath();
  context.stroke();
}

function strokeSegment(context: CanvasRenderingContext2D, segment: PlaneSegment): void {
  context.beginPath();
  context.moveTo(segment.start.x, segment.start.y);
  context.lineTo(segment.end.x, segment.end.y);
  context.stroke();
}

function fillCircle(context: CanvasRenderingContext2D, center: PlanePoint, radius: number): void {
  context.beginPath();
  context.arc(center.x, center.y, radius, 0, Math.PI * 2);
  context.fill();
}

function fillEllipse(
  context: CanvasRenderingContext2D,
  center: PlanePoint,
  radiusX: number,
  radiusY: number
): void {
  context.beginPath();
  context.ellipse(center.x, center.y, radiusX, radiusY, 0, 0, Math.PI * 2);
  context.fill();
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

function drawExplosion(context: CanvasRenderingContext2D, x: number, y: number, glow: string): void {
  context.save();
  context.fillStyle = glow;
  context.beginPath();
  context.arc(x, y, 24, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#f7c15d';
  context.beginPath();
  context.arc(x, y, 14, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#f86b3a';
  context.beginPath();
  context.arc(x, y, 7, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawBullet(context: CanvasRenderingContext2D, bullet: BulletState): void {
  drawWrappedHorizontally(
    bullet.position.x,
    4,
    GAME_WIDTH + BULLET_WRAP_MARGIN * 2,
    (xOffset) => {
      context.fillStyle = '#d94133';
      context.beginPath();
      context.arc(bullet.position.x + xOffset, bullet.position.y, 4, 0, Math.PI * 2);
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
const setupForm = requireElement<HTMLFormElement>('#setup-form');
const setupFieldLabel = requireElement<HTMLLabelElement>('#setup-field-label');
const joinRoomInput = requireElement<HTMLInputElement>('#join-room-input');
const setupSubmitButton = requireElement<HTMLButtonElement>('#setup-submit-button');
const feedbackElement = requireElement<HTMLParagraphElement>('#session-feedback');
const playerListElement = requireElement<HTMLUListElement>('#player-list');
const rematchStatusElement = requireElement<HTMLParagraphElement>('#rematch-status');
const planeDebugPanel = requireElement<HTMLDivElement>('#plane-debug-panel');
const planeGeometryEditor = requireElement<HTMLTextAreaElement>('#plane-geometry-editor');
const planeGeometryFeedbackElement = requireElement<HTMLParagraphElement>('#plane-geometry-feedback');
const canvas = createCanvas();
const canvasContext = canvas.getContext('2d');

if (!canvasContext) {
  throw new Error('Canvas 2D context is unavailable.');
}

const context = canvasContext;
canvasRoot.replaceChildren(canvas);

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

// `render()` is the single place that synchronizes DOM controls from app state.
// Gameplay visuals are rendered continuously by `requestAnimationFrame`, while
// this UI sync only updates the DOM controls and side panel.
function render(): void {
  const isBusy = state.phase === 'creating' || state.phase === 'connecting';
  createRoomButton.disabled = isBusy;

  const rematchVisible = shouldShowRematchAction();
  secondaryActionButton.textContent = rematchVisible
    ? hasRequestedRematch()
      ? 'Rematch Requested'
      : 'Rematch'
    : 'Join by Code';
  secondaryActionButton.disabled = rematchVisible ? !canRequestRematch() : isBusy;

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

  renderPlayerList();
}

function clearRoomSnapshots(): void {
  previousRoomSnapshot = null;
  currentRoomSnapshot = null;
}

function setCurrentRoomState(nextRoomState: RoomState): void {
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

function getPlaneHorizontalRenderExtent(geometry: PlaneGeometry): number {
  const polygonGroups = [
    geometry.fuselageTop,
    geometry.fuselageBottom,
    geometry.noseCap,
    geometry.topWing,
    geometry.bottomWing,
    geometry.accentStripe,
    geometry.tailFin,
    geometry.tailWing,
    geometry.cockpit
  ];

  let maxX = 0;

  for (const polygon of polygonGroups) {
    for (const point of polygon) {
      maxX = Math.max(maxX, Math.abs(point.x));
    }
  }

  for (const segment of [...geometry.struts, ...geometry.landingGear]) {
    maxX = Math.max(maxX, Math.abs(segment.start.x), Math.abs(segment.end.x));
  }

  maxX = Math.max(
    maxX,
    Math.abs(geometry.propeller.center.x) + geometry.propeller.radiusX,
    Math.abs(geometry.spinner.center.x) + geometry.spinner.radius,
    Math.abs(geometry.wheel.center.x) + geometry.wheel.radius,
    Math.abs(geometry.wheelHub.center.x) + geometry.wheelHub.radius
  );

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

function shouldShowRematchAction(): boolean {
  return isMatchStarted();
}

function shouldShowSetupPanel(): boolean {
  if (isMatchStarted()) {
    return false;
  }

  if (state.setupPanelMode === 'share') {
    return Boolean(state.roomLink);
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

  const baseMessage = appState.roomState.message ?? 'Both pilots must request rematch.';
  return `${baseMessage} Press Y or use Rematch.`;
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

  return `${state.roomState.message ?? 'Request rematch to start the next round.'} Press Y or use Rematch.`;
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
    isPlanePoint(geometry.muzzlePoint) &&
    isPlanePointArray(geometry.fuselageTop) &&
    isPlanePointArray(geometry.fuselageBottom) &&
    isPlanePointArray(geometry.noseCap) &&
    isPlanePointArray(geometry.topWing) &&
    isPlanePointArray(geometry.bottomWing) &&
    isPlanePointArray(geometry.accentStripe) &&
    isPlanePointArray(geometry.tailFin) &&
    isPlanePointArray(geometry.tailWing) &&
    isPlanePointArray(geometry.cockpit) &&
    isPlaneSegmentArray(geometry.struts) &&
    isPlaneSegmentArray(geometry.landingGear) &&
    isPlaneEllipse(geometry.propeller) &&
    isPlaneCircle(geometry.spinner) &&
    isPlaneCircle(geometry.wheel) &&
    isPlaneCircle(geometry.wheelHub) &&
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

function isPlaneSegmentArray(value: unknown): value is PlaneSegment[] {
  return (
    Array.isArray(value) &&
    value.every((segment) => {
      if (!segment || typeof segment !== 'object') {
        return false;
      }

      const candidate = segment as Record<string, unknown>;
      return isPlanePoint(candidate.start) && isPlanePoint(candidate.end);
    })
  );
}

function isPlaneEllipse(value: unknown): value is PlaneGeometry['propeller'] {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const ellipse = value as Record<string, unknown>;
  return (
    isPlanePoint(ellipse.center) &&
    typeof ellipse.radiusX === 'number' &&
    typeof ellipse.radiusY === 'number'
  );
}

function isPlaneCircle(value: unknown): value is PlaneGeometry['spinner'] {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const circle = value as Record<string, unknown>;
  return isPlanePoint(circle.center) && typeof circle.radius === 'number';
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
  if (shouldShowRematchAction()) {
    sendRematchRequest();
    return;
  }

  showJoinSetup();
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

render();
window.requestAnimationFrame(drawFrame);

if (initialRoomId) {
  state.setupPanelMode = 'join';
  joinRoomInput.value = `${window.location.origin}/?room=${initialRoomId}`;
  connectToRoom(initialRoomId);
}
