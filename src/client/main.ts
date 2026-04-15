import {
  GAME_HEIGHT,
  GAME_WIDTH,
  GROUND_HEIGHT,
  PLAYER_SLOTS,
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

const PLAYER_COLORS: Record<PlayerSlot, { body: string; trim: string; glow: string }> = {
  left: {
    body: '#d4552d',
    trim: '#ffe9dc',
    glow: 'rgba(212, 85, 45, 0.32)'
  },
  right: {
    body: '#2a5d94',
    trim: '#ebf7ff',
    glow: 'rgba(42, 93, 148, 0.3)'
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

function drawScene(context: CanvasRenderingContext2D, state: AppState): void {
  drawBackground(context);

  if (!state.roomState) {
    drawHeadline(context, 'Create or join a room', 'Room setup happens first, then the duel runs here.');
    return;
  }

  drawRunways(context);

  for (const bullet of state.roomState.bullets) {
    drawBullet(context, bullet);
  }

  for (const player of state.roomState.players) {
    drawPlane(context, player, state.slot === player.slot);
  }

  if (shouldShowHud(state.roomState)) {
    drawHud(context, state);
  }

  if (state.roomState.status === 'round_over') {
    drawRoundResult(context, state);
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

function drawHud(context: CanvasRenderingContext2D, state: AppState): void {
  // The HUD is shown only during the waiting phase, so the status text can stay
  // focused on room setup instead of active-flight instructions.
  const statusLine = getWaitingHudStatusText(state);
  const detailLine = state.feedback;

  context.fillStyle = 'rgba(255, 248, 234, 0.9)';
  context.fillRect(24, 22, 540, 112);
  context.fillStyle = '#15314b';
  context.font = '700 28px "Trebuchet MS", sans-serif';
  const statusLineCount = drawWrappedText(context, statusLine, 42, 58, 500, 28);
  context.font = '16px "Trebuchet MS", sans-serif';
  drawWrappedText(context, detailLine, 42, 58 + statusLineCount * 28 + 10, 500, 20);

  if (!state.roomState) {
    return;
  }

  const ownPlayer = state.slot
    ? state.roomState.players.find((player) => player.slot === state.slot) ?? null
    : null;

  context.fillStyle = 'rgba(21, 49, 75, 0.82)';
  context.fillRect(GAME_WIDTH - 270, 24, 230, 78);
  context.fillStyle = '#f8fbff';
  context.font = '700 17px "Trebuchet MS", sans-serif';
  context.fillText(`Room ${state.roomState.id}`, GAME_WIDTH - 250, 50);
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
  // The plane shape is intentionally simple and stylized.
  // Simulation depth belongs on the server, not in client-side rendering.
  const colors = PLAYER_COLORS[player.slot];
  const { plane } = player;

  if (plane.phase === 'destroyed') {
    drawExplosion(context, plane.position.x, plane.position.y, colors.glow);
    return;
  }

  context.save();
  context.translate(plane.position.x, plane.position.y);
  context.rotate(plane.angle);

  context.shadowBlur = isCurrentPlayer ? 22 : 0;
  context.shadowColor = colors.glow;

  context.fillStyle = colors.body;
  context.beginPath();
  context.moveTo(24, 0);
  context.lineTo(-12, -9);
  context.lineTo(-18, 0);
  context.lineTo(-12, 9);
  context.closePath();
  context.fill();

  context.fillStyle = colors.trim;
  context.fillRect(-16, -2.5, 26, 5);
  context.fillRect(-4, -13, 7, 26);

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
  context.fillStyle = '#d94133';
  context.beginPath();
  context.arc(bullet.position.x, bullet.position.y, 4, 0, Math.PI * 2);
  context.fill();
}

function drawRoundResult(context: CanvasRenderingContext2D, state: AppState): void {
  if (!state.roomState) {
    return;
  }

  const resultLine = getRoundResultText(state.roomState, state.slot);
  const subLine = getRoundOverlayMessage(state);

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
const canvas = createCanvas();
const canvasContext = canvas.getContext('2d');

if (!canvasContext) {
  throw new Error('Canvas 2D context is unavailable.');
}

const context = canvasContext;
canvasRoot.replaceChildren(canvas);

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

// `render()` is the single place that synchronizes DOM controls from app state.
// Gameplay visuals are rendered to canvas; setup UI and room info are DOM-based.
function render(): void {
  drawScene(context, state);

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

  renderPlayerList();
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

// Room cards are rebuilt from room state on every render.
// With only two players this is simpler and clearer than diffing small DOM bits.
function renderPlayerList(): void {
  playerListElement.replaceChildren();

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
    const item = document.createElement('li');
    item.className = 'player-card';

    if (player.slot === state.slot) {
      item.classList.add('is-current');
    }

    const headerRow = document.createElement('div');
    headerRow.className = 'player-row';

    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = `${formatSlot(player.slot)} pilot`;

    if (shouldShowScores) {
      const scoreCluster = document.createElement('div');
      scoreCluster.className = 'score-cluster';

      const scoreCircle = document.createElement('span');
      scoreCircle.className = `score-circle ${getScoreTone(player.wins, highestWins, tiedForLead)}`;
      scoreCircle.textContent = String(player.wins);

      if (player.wins === highestWins && !tiedForLead) {
        const crown = document.createElement('span');
        crown.className = 'score-crown';
        crown.setAttribute('aria-hidden', 'true');
        scoreCluster.append(crown);
      }

      scoreCluster.append(scoreCircle);
      item.append(scoreCluster);
    }

    const statusStack = document.createElement('div');
    statusStack.className = 'player-status-stack';

    const badge = document.createElement('span');
    badge.className = 'player-state';
    badge.textContent = player.connected ? 'Connected' : 'Open';
    if (player.connected) {
      badge.classList.add('is-connected');
    }

    const marker = document.createElement('span');
    marker.className = 'player-marker';
    marker.textContent = player.slot === state.slot ? 'You' : '';

    const note = document.createElement('span');
    note.className = 'player-detail';
    note.textContent = player.connected
      ? player.slot === state.slot
        ? formatPhase(player.plane.phase)
        : `Pilot present. ${formatPhase(player.plane.phase)}.`
      : 'Available for another browser to join.';

    statusStack.append(badge, marker);
    headerRow.append(name, statusStack);
    item.append(headerRow, note);
    playerListElement.append(item);
  }
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
      state.roomState = message.payload;
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

if (initialRoomId) {
  state.setupPanelMode = 'join';
  joinRoomInput.value = `${window.location.origin}/?room=${initialRoomId}`;
  connectToRoom(initialRoomId);
}
