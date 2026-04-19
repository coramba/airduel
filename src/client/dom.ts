import { GROUND_CONTACT_Y, PLAYER_SLOTS, ROOM_ID_LENGTH, normalizeRoomId } from '../shared/game.js';
import {
  DEFAULT_PLANE_CONFIG,
  EXPLOSION_CONFIG,
  PLANE_STATS_FIELDS,
  RUNWAY_CONFIG_FIELDS,
  SPAWN_X_STEP,
  getEffectiveTurnRate,
} from '../shared/game-config.js';
import type { PlaneStatsField, RunwayConfigField } from '../types/config.js';
import type { PlaneStats, RunwayConfig } from '../types/config.js';
import type { AppState } from '../types/client.js';
import type { CreateRoomResponse } from '../types/game.js';
import type { PlanePhase, PlayerSlot, PlayerState, RoomState } from '../types/game.js';

type StatsInputMap = Record<PlaneStatsField['key'], HTMLInputElement>;
type RunwayInputMap = Record<RunwayConfigField['key'], HTMLInputElement>;

type NumericEditorField<Key extends string> = {
  key: Key;
  label: string;
  step: number;
};

type PlayerCardRefs = {
  item: HTMLLIElement;
  side: HTMLSpanElement;
  name: HTMLSpanElement;
  detail: HTMLSpanElement;
  score: HTMLSpanElement;
  statusDot: HTMLSpanElement;
  resourceGroup: HTMLDivElement;
  ammoValue: HTMLSpanElement;
  fuelValue: HTMLSpanElement;
  hullValue: HTMLSpanElement;
  ammoFill: HTMLSpanElement;
  fuelFill: HTMLSpanElement;
  hullFill: HTMLSpanElement;
};

type TelemetryKey = (typeof TELEMETRY_ROWS)[number]['key'];
type ConnectionPhase = 'idle' | 'creating' | 'connecting' | 'connected' | 'error';
type SetupPanelMode = 'hidden' | 'share' | 'join';

type UiState = {
  feedback: string;
  phase: ConnectionPhase;
  roomLink: string | null;
  setupPanelMode: SetupPanelMode;
};

export interface ClientDomOptions {
  initialRoomId: string | null;
  connectToRoom: (roomId: string) => void;
  onPlaneGeometryInput: (value: string) => void;
  onPlaneStatsChange: (slot: PlayerSlot, key: PlaneStatsField['key'], value: number) => void;
  onSpawnXChange: (slot: PlayerSlot, value: number) => void;
  onRunwayConfigChange: (slot: PlayerSlot, key: RunwayConfigField['key'], value: number) => void;
  onRematch: () => void;
}

export interface ClientDomRenderState {
  appState: AppState;
  canRequestRematch: boolean;
  editablePlaneStats: Record<PlayerSlot, PlaneStats>;
  editableRunwayConfig: Record<PlayerSlot, RunwayConfig>;
  editableSpawnX: Record<PlayerSlot, number>;
  hasRequestedRematch: boolean;
  planeGeometryDraft: string;
  planeGeometryFeedback: string;
  showPlaneGrid: boolean;
}

type ClientDomApi = ReturnType<typeof createClientDom>;

const TELEMETRY_ROWS = [
  { key: 'speed', label: 'Speed' },
  { key: 'turnRate', label: 'Turn rate' },
  { key: 'vx', label: 'Velocity X' },
  { key: 'vy', label: 'Velocity Y' },
  { key: 'accel', label: 'Acceleration' },
] as const;

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }

  return element;
}

export function createClientDom(options: ClientDomOptions) {
  let latestRenderState: ClientDomRenderState | null = null;
  const uiState: UiState = {
    feedback: options.initialRoomId
      ? `Joining room ${options.initialRoomId} from the current URL.`
      : 'Create a room or join with a code to start.',
    phase: options.initialRoomId ? 'connecting' : 'idle',
    roomLink: options.initialRoomId ? buildRoomLink(options.initialRoomId) : null,
    setupPanelMode: 'hidden',
  };
  const canvasRoot = requireElement<HTMLDivElement>('#canvas-root');
  const createRoomButton = requireElement<HTMLButtonElement>('#create-room-button');
  const secondaryActionButton = requireElement<HTMLButtonElement>('#secondary-action-button');
  const roomStrip = requireElement<HTMLDivElement>('#room-strip');
  const roomCodeDisplay = requireElement<HTMLSpanElement>('#room-code-display');
  const copyLinkButton = requireElement<HTMLButtonElement>('#copy-link-button');
  const controlsMenu = requireElement<HTMLDetailsElement>('.controls-menu');
  const rematchButton = requireElement<HTMLButtonElement>('#rematch-button');
  const setupModal = requireElement<HTMLDivElement>('#setup-modal');
  const setupModalTitle = requireElement<HTMLHeadingElement>('#setup-modal-title');
  const setupModalCopy = requireElement<HTMLParagraphElement>('#setup-modal-copy');
  const setupFeedbackElement = requireElement<HTMLParagraphElement>('#setup-feedback');
  const setupModalCloseButton = requireElement<HTMLButtonElement>('#setup-modal-close');
  const setupForm = requireElement<HTMLFormElement>('#setup-form');
  const sharePanel = requireElement<HTMLDivElement>('#share-panel');
  const shareRoomCode = requireElement<HTMLDivElement>('#share-room-code');
  const shareLinkText = requireElement<HTMLParagraphElement>('#share-link-text');
  const shareCopyLinkButton = requireElement<HTMLButtonElement>('#share-copy-link-button');
  const shareCopyCodeButton = requireElement<HTMLButtonElement>('#share-copy-code-button');
  const setupFieldLabel = requireElement<HTMLLabelElement>('#setup-field-label');
  const joinRoomInput = requireElement<HTMLInputElement>('#join-room-input');
  const setupSubmitButton = requireElement<HTMLButtonElement>('#setup-submit-button');
  const setupErrorElement = requireElement<HTMLParagraphElement>('#setup-error');
  const connectionDotElement = requireElement<HTMLSpanElement>('#connection-dot');
  const connectionLabelElement = requireElement<HTMLSpanElement>('#connection-label');
  const playerListElement = requireElement<HTMLUListElement>('#player-list');
  const matchRoundElement = requireElement<HTMLParagraphElement>('#match-round');
  const matchStatusElement = requireElement<HTMLParagraphElement>('#match-status');
  const planeDebugPanel = requireElement<HTMLDivElement>('#plane-debug-panel');
  const planeTelemetryContainer = requireElement<HTMLDivElement>('#plane-telemetry');
  const planeGeometryEditor = requireElement<HTMLTextAreaElement>('#plane-geometry-editor');
  const planeGeometryFeedbackElement = requireElement<HTMLParagraphElement>('#plane-geometry-feedback');
  const planeStatsContainer = requireElement<HTMLDivElement>('#plane-stats-container');
  const runwayConfigContainer = requireElement<HTMLDivElement>('#runway-config-container');
  const roundResultPanel = requireElement<HTMLElement>('#round-result-panel');
  const roundResultTitle = requireElement<HTMLHeadingElement>('#round-result-title');
  const roundResultCopy = requireElement<HTMLParagraphElement>('#round-result-copy');

  const telemetrySpans = {} as Record<TelemetryKey, HTMLSpanElement>;
  const playerCardRefs = new Map<PlayerSlot, PlayerCardRefs>(
    PLAYER_SLOTS.map((slot) => [slot, createPlayerCard(slot)])
  );
  const spawnInputs: Partial<Record<PlayerSlot, HTMLInputElement>> = {};
  const statsInputs: Partial<Record<PlayerSlot, StatsInputMap>> = {};
  const runwayInputs: Partial<Record<PlayerSlot, RunwayInputMap>> = {};

  if (options.initialRoomId) {
    joinRoomInput.value = buildRoomLink(options.initialRoomId);
  }

  playerListElement.replaceChildren(...PLAYER_SLOTS.map((slot) => playerCardRefs.get(slot)!.item));
  buildTelemetry(planeTelemetryContainer, telemetrySpans);
  buildNumericEditor(
    planeStatsContainer,
    'Plane',
    PLANE_STATS_FIELDS,
    statsInputs,
    (slot, key, value) => options.onPlaneStatsChange(slot, key, value)
  );
  buildSpawnEditor(runwayConfigContainer, spawnInputs, (slot, value) => options.onSpawnXChange(slot, value));
  buildNumericEditor(
    runwayConfigContainer,
    'Runway',
    RUNWAY_CONFIG_FIELDS,
    runwayInputs,
    (slot, key, value) => options.onRunwayConfigChange(slot, key, value)
  );

  createRoomButton.addEventListener('click', () => {
    void handleCreateRoomAction(api, options, uiState);
  });

  secondaryActionButton.addEventListener('click', () => {
    joinRoomInput.value = '';
    uiState.setupPanelMode = 'join';
    uiState.feedback = 'Paste a room code or join link.';
    renderLatest(api);
    window.requestAnimationFrame(() => {
      joinRoomInput.focus();
    });
  });

  copyLinkButton.addEventListener('click', () => {
    void handleCopyRoomLinkAction(api, uiState);
  });

  rematchButton.addEventListener('click', () => {
    options.onRematch();
  });

  setupModalCloseButton.addEventListener('click', () => {
    uiState.setupPanelMode = 'hidden';
    renderLatest(api);
  });

  setupModal.addEventListener('click', (event) => {
    if (
      event.target === setupModal ||
      event.target instanceof HTMLElement && event.target.classList.contains('setup-modal__backdrop')
    ) {
      uiState.setupPanelMode = 'hidden';
      renderLatest(api);
    }
  });

  document.addEventListener('click', (event) => {
    if (!controlsMenu.open) {
      return;
    }

    if (event.target instanceof Node && !controlsMenu.contains(event.target)) {
      controlsMenu.open = false;
    }
  });

  shareCopyLinkButton.addEventListener('click', () => {
    void handleCopyRoomLinkAction(api, uiState);
  });

  shareCopyCodeButton.addEventListener('click', () => {
    void handleCopyRoomCodeAction(api, uiState);
  });

  setupForm.addEventListener('submit', (event) => {
    event.preventDefault();
    handleJoinSubmit(joinRoomInput.value, uiState, options, api);
  });

  planeGeometryEditor.addEventListener('input', () => {
    options.onPlaneGeometryInput(planeGeometryEditor.value);
  });

  const api = {
    canvasRoot,

    copyText: async (value: string): Promise<boolean> => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
        } else {
          const copyInput = document.createElement('textarea');
          copyInput.value = value;
          copyInput.setAttribute('readonly', '');
          copyInput.style.position = 'absolute';
          copyInput.style.left = '-9999px';
          document.body.append(copyInput);
          copyInput.select();
          const copied = document.execCommand('copy');
          copyInput.remove();
          if (!copied) {
            throw new Error('copy_failed');
          }
        }

        return true;
      } catch {
        return false;
      }
    },

    createExplosionSprite: (): HTMLImageElement => {
      const img = new Image();
      img.src = `/images/${EXPLOSION_CONFIG.image}`;
      img.className = 'explosion-sprite';
      canvasRoot.appendChild(img);
      return img;
    },

    mountCanvas: (canvas: HTMLCanvasElement): void => {
      canvasRoot.replaceChildren(canvas);
    },

    render: (renderState: ClientDomRenderState): void => {
      latestRenderState = renderState;
      const { appState } = renderState;
      const isBusy = uiState.phase === 'creating' || uiState.phase === 'connecting';
      const setupVisible = shouldShowSetupPanel(appState, uiState);
      const shareMode = uiState.setupPanelMode === 'share';
      const roundResultMode = appState.roomState?.status === 'round_over';
      const shouldShowSetupError = uiState.phase === 'error' && uiState.feedback !== '';
      const roomLink = getRoomLink(appState.roomId, uiState.roomLink);

      createRoomButton.disabled = isBusy;
      secondaryActionButton.disabled = isBusy;
      rematchButton.textContent = renderState.hasRequestedRematch ? 'Rematch Requested' : 'Rematch';
      rematchButton.disabled = !renderState.canRequestRematch;
      roomStrip.hidden = !appState.roomId;
      roomCodeDisplay.textContent = appState.roomId ?? '------';
      copyLinkButton.disabled = !roomLink;

      setupModal.hidden = !setupVisible;
      if (setupVisible) {
        setupForm.dataset.mode = roundResultMode ? 'round-result' : shareMode ? 'share' : 'join';
        setupForm.hidden = shareMode || roundResultMode;
        sharePanel.hidden = !shareMode;
        roundResultPanel.hidden = !roundResultMode;
        setupModalCloseButton.hidden = roundResultMode;
        setupModalTitle.hidden = roundResultMode;
        setupModalCopy.hidden = roundResultMode;

        if (roundResultMode && appState.roomState) {
          roundResultTitle.textContent = getRoundResultText(appState.roomState, appState.slot);
          roundResultCopy.textContent = getRoundResultStatusMessage(appState);
        } else if (shareMode) {
          setupModalTitle.textContent = 'Match Ready';
          setupModalCopy.textContent = 'Room created. Share the link below with another pilot.';
          renderShareCode(shareRoomCode, appState.roomId);
          shareLinkText.textContent = roomLink ?? '';
          shareCopyLinkButton.disabled = !roomLink;
          shareCopyCodeButton.disabled = !appState.roomId;
          setupFeedbackElement.hidden = uiState.feedback === '';
          setupFeedbackElement.textContent = uiState.feedback;
        } else {
          setupModalTitle.textContent = 'Join Match';
          setupModalCopy.textContent = 'Got a code from another pilot? Enter it below to take the open seat.';
          setupFieldLabel.textContent = 'Paste code or join link';
          joinRoomInput.readOnly = false;
          joinRoomInput.placeholder = 'Paste code or join link';
          setupSubmitButton.textContent = 'Join';
          setupSubmitButton.disabled = isBusy;
          setupErrorElement.hidden = !shouldShowSetupError;
          setupErrorElement.textContent = shouldShowSetupError ? uiState.feedback : '';
          setupFeedbackElement.hidden = true;
          setupFeedbackElement.textContent = '';
        }
      } else {
        setupErrorElement.hidden = true;
        setupErrorElement.textContent = '';
        setupFeedbackElement.hidden = true;
        setupFeedbackElement.textContent = '';
        roundResultPanel.hidden = true;
        setupModalCloseButton.hidden = false;
        setupModalTitle.hidden = false;
        setupModalCopy.hidden = false;
      }

      connectionDotElement.className = `connection-dot ${getConnectionTone(appState, uiState.phase)}`;
      connectionLabelElement.textContent = getConnectionLabel(appState, uiState.phase);
      matchRoundElement.textContent = appState.roomState ? `Round ${appState.roomState.round}` : 'Round 1';
      matchStatusElement.textContent = getMatchStatusLabel(appState, uiState.phase);
      matchStatusElement.className = `vs-state ${getMatchStatusTone(appState)}`;
      planeDebugPanel.hidden = !renderState.showPlaneGrid;

      if (
        document.activeElement !== planeGeometryEditor &&
        planeGeometryEditor.value !== renderState.planeGeometryDraft
      ) {
        planeGeometryEditor.value = renderState.planeGeometryDraft;
      }

      planeGeometryFeedbackElement.textContent = renderState.planeGeometryFeedback;
      planeGeometryFeedbackElement.hidden = renderState.planeGeometryFeedback === '';

      syncNumericInputs(PLANE_STATS_FIELDS, renderState.editablePlaneStats, statsInputs);
      syncSpawnInputs(renderState.editableSpawnX, spawnInputs);
      syncNumericInputs(RUNWAY_CONFIG_FIELDS, renderState.editableRunwayConfig, runwayInputs);
      renderPlayerList(playerCardRefs, appState);
    },

    getCurrentRoomId: (): string | null => latestRenderState?.appState.roomId ?? null,

    setAssignedSlot: (slot: PlayerSlot): void => {
      uiState.feedback = `You are flying on the ${formatSlot(slot).toLowerCase()} side.`;
    },

    setConnectionClosed: (roomId: string | null): void => {
      uiState.phase = 'error';
      uiState.feedback = roomId
        ? `The connection for room ${roomId} closed.`
        : 'The room connection closed.';
    },

    setConnected: (): void => {
      uiState.phase = 'connected';
      uiState.feedback = 'Connected. Waiting for the round state.';
    },

    setConnecting: (roomId: string): void => {
      uiState.phase = 'connecting';
      uiState.feedback = 'Opening match…';
      uiState.roomLink = buildRoomLink(roomId);
    },

    setConnectionError: (message: string): void => {
      uiState.phase = 'error';
      uiState.feedback = message;
      uiState.roomLink = null;
      uiState.setupPanelMode = 'join';
    },

    syncRoomStateFeedback: (roomState: RoomState): void => {
      uiState.phase = 'connected';
      if (roomState.status === 'waiting') {
        uiState.feedback = '';
      } else if (roomState.message) {
        uiState.feedback = roomState.message;
      } else if (roomState.status === 'round_over') {
        uiState.feedback = 'Round complete.';
      } else {
        uiState.feedback = 'Live round synchronized from the server.';
      }
    },

    updateTelemetry: (renderState: ClientDomRenderState): void => {
      updateTelemetry(telemetrySpans, renderState);
    },

    renderLatest: (): void => {
      renderLatest(api);
    },
  };

  return api;

  function renderLatest(api: ClientDomApi): void {
    if (latestRenderState) {
      api.render(latestRenderState);
    }
  }
}

async function handleCreateRoomAction(
  api: ClientDomApi,
  options: Pick<ClientDomOptions, 'connectToRoom'>,
  uiState: UiState
): Promise<void> {
  uiState.phase = 'creating';
  uiState.feedback = 'Creating a new room…';
  uiState.setupPanelMode = 'hidden';
  api.renderLatest?.();

  try {
    const response = await fetch('/api/rooms', {
      method: 'POST'
    });

    if (!response.ok) {
      throw new Error(`Create room failed with status ${response.status}.`);
    }

    const payload = await response.json() as CreateRoomResponse;
    uiState.roomLink = payload.joinUrl;
    uiState.setupPanelMode = 'share';
    uiState.phase = 'connecting';
    uiState.feedback = 'Opening match…';
    options.connectToRoom(payload.roomId);
    api.renderLatest?.();
  } catch {
    uiState.phase = 'error';
    uiState.feedback = 'Room creation failed. Check the server and try again.';
    uiState.setupPanelMode = 'join';
    api.renderLatest?.();
  }
}

async function handleCopyRoomCodeAction(api: ClientDomApi, uiState: UiState): Promise<void> {
  const roomId = api.getCurrentRoomId?.();
  if (!roomId) {
    return;
  }

  uiState.feedback = await api.copyText(roomId)
    ? 'Room code copied to clipboard.'
    : 'Copy failed. Copy the room code manually.';
  api.renderLatest?.();
}

async function handleCopyRoomLinkAction(api: ClientDomApi, uiState: UiState): Promise<void> {
  const roomLink = getRoomLink(api.getCurrentRoomId?.() ?? null, uiState.roomLink);
  if (!roomLink) {
    return;
  }

  uiState.feedback = await api.copyText(roomLink)
    ? 'Join link copied to clipboard.'
    : 'Copy failed. Copy the link manually.';
  api.renderLatest?.();
}

function handleJoinSubmit(
  value: string,
  uiState: UiState,
  options: ClientDomOptions,
  api: ClientDomApi
): void {
  const roomId = extractRoomId(value);
  if (!roomId) {
    uiState.phase = 'error';
    uiState.feedback = `Enter a ${ROOM_ID_LENGTH}-character room id or a link containing ?room=.`;
    uiState.setupPanelMode = 'join';
    api.renderLatest?.();
    return;
  }

  uiState.setupPanelMode = 'hidden';
  uiState.phase = 'connecting';
  uiState.feedback = 'Opening match…';
  uiState.roomLink = buildRoomLink(roomId);
  options.connectToRoom(roomId);
  api.renderLatest?.();
}

function buildRoomLink(roomId: string): string {
  return `${window.location.origin}/?room=${roomId}`;
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

function getRoomLink(roomId: string | null, roomLink: string | null): string | null {
  if (roomLink) {
    return roomLink;
  }

  return roomId ? buildRoomLink(roomId) : null;
}

function buildTelemetry(
  container: HTMLElement,
  telemetrySpans: Record<TelemetryKey, HTMLSpanElement>
): void {
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

function updateTelemetry(
  telemetrySpans: Record<TelemetryKey, HTMLSpanElement>,
  renderState: ClientDomRenderState
): void {
  if (!renderState.showPlaneGrid) {
    return;
  }

  const { appState } = renderState;

  if (!appState.slot || !appState.roomState || appState.roomState.status !== 'active') {
    for (const row of TELEMETRY_ROWS) {
      telemetrySpans[row.key].textContent = '—';
    }
    return;
  }

  const player = appState.roomState.players.find((item) => item.slot === appState.slot);
  if (!player) {
    return;
  }

  const { plane } = player;
  const stats = renderState.editablePlaneStats[appState.slot];
  const speed = Math.hypot(plane.velocity.x, plane.velocity.y);
  const effectiveTurnRate = getEffectiveTurnRate(speed, stats);

  telemetrySpans.speed.textContent = `${speed.toFixed(1)} px/s`;
  telemetrySpans.turnRate.textContent = `${effectiveTurnRate.toFixed(2)} rad/s`;
  telemetrySpans.vx.textContent = `${plane.velocity.x.toFixed(1)} px/s`;
  telemetrySpans.vy.textContent = `${plane.velocity.y.toFixed(1)} px/s`;
  telemetrySpans.accel.textContent = `${stats.acceleration} px/s²`;
}

function buildNumericEditor<Key extends string>(
  container: HTMLElement,
  titleSuffix: string,
  fields: readonly NumericEditorField<Key>[],
  inputsBySlot: Partial<Record<PlayerSlot, Record<Key, HTMLInputElement>>>,
  onCommit: (slot: PlayerSlot, key: Key, value: number) => void
): void {
  const grid = document.createElement('div');
  grid.className = 'stats-editor-grid';

  for (const slot of PLAYER_SLOTS) {
    const column = document.createElement('div');
    column.className = 'stats-column';

    const heading = document.createElement('div');
    heading.className = `stats-slot-heading stats-slot-${slot}`;
    heading.textContent = `${formatSlot(slot)} ${titleSuffix}`;
    column.append(heading);

    const inputs = {} as Record<Key, HTMLInputElement>;

    for (const field of fields) {
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

      input.addEventListener('change', () => {
        const parsed = parseFloat(input.value);
        if (Number.isFinite(parsed) && parsed > 0) {
          onCommit(slot, field.key, parsed);
        }
      });

      label.append(input);
      fieldDiv.append(label);
      column.append(fieldDiv);
      inputs[field.key] = input;
    }

    inputsBySlot[slot] = inputs;
    grid.append(column);
  }

  container.append(grid);
}

function syncNumericInputs<Key extends string>(
  fields: readonly NumericEditorField<Key>[],
  values: Record<PlayerSlot, Record<Key, number>>,
  inputsBySlot: Partial<Record<PlayerSlot, Record<Key, HTMLInputElement>>>
): void {
  for (const slot of PLAYER_SLOTS) {
    const inputMap = inputsBySlot[slot];
    if (!inputMap) {
      continue;
    }

    for (const { key } of fields) {
      const input = inputMap[key];
      if (document.activeElement !== input) {
        input.value = String(values[slot][key]);
      }
    }
  }
}

function buildSpawnEditor(
  container: HTMLElement,
  spawnInputs: Partial<Record<PlayerSlot, HTMLInputElement>>,
  onCommit: (slot: PlayerSlot, value: number) => void
): void {
  const grid = document.createElement('div');
  grid.className = 'stats-editor-grid';

  for (const slot of PLAYER_SLOTS) {
    const column = document.createElement('div');
    column.className = 'stats-column';

    const heading = document.createElement('div');
    heading.className = `stats-slot-heading stats-slot-${slot}`;
    heading.textContent = `${formatSlot(slot)} Spawn`;
    column.append(heading);

    const fieldDiv = document.createElement('div');
    fieldDiv.className = 'stats-field';

    const label = document.createElement('label');
    label.className = 'stats-field-label';
    label.textContent = 'Spawn X (px)';

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'stats-input';
    input.step = String(SPAWN_X_STEP);
    input.min = String(SPAWN_X_STEP);

    input.addEventListener('change', () => {
      const parsed = parseFloat(input.value);
      if (Number.isFinite(parsed) && parsed > 0) {
        onCommit(slot, parsed);
      }
    });

    label.append(input);
    fieldDiv.append(label);
    column.append(fieldDiv);
    grid.append(column);
    spawnInputs[slot] = input;
  }

  container.append(grid);
}

function syncSpawnInputs(
  editableSpawnX: Record<PlayerSlot, number>,
  spawnInputs: Partial<Record<PlayerSlot, HTMLInputElement>>
): void {
  for (const slot of PLAYER_SLOTS) {
    const input = spawnInputs[slot];
    if (input && document.activeElement !== input) {
      input.value = String(editableSpawnX[slot]);
    }
  }
}

function renderPlayerList(playerCardRefs: Map<PlayerSlot, PlayerCardRefs>, appState: AppState): void {
  const players = appState.roomState?.players ?? PLAYER_SLOTS.map((slot) => ({
    slot,
    connected: false,
    wins: 0,
    plane: {
      phase: 'parked' as PlanePhase,
    },
  }));

  for (const player of players) {
    const refs = playerCardRefs.get(player.slot);
    if (!refs) {
      continue;
    }

    refs.item.classList.toggle('is-current', player.slot === appState.slot);
    refs.side.textContent = player.slot === 'left' ? '◀ Left Pilot' : 'Right Pilot ▶';
    refs.name.textContent = getPilotName(player, appState.slot);
    refs.detail.textContent = getPlayerCardDetail(player);
    refs.statusDot.className = `connection-dot ${player.connected ? 'connection-dot--ok' : 'connection-dot--bad'}`;
    refs.score.textContent = String(player.wins).padStart(2, '0');
    refs.resourceGroup.hidden = !(player.slot === appState.slot && appState.roomState?.status === 'active');
    refs.ammoValue.textContent = '78%';
    refs.fuelValue.textContent = '10%';
    refs.hullValue.textContent = '84%';
    refs.ammoFill.style.width = '78%';
    refs.fuelFill.style.width = '10%';
    refs.hullFill.style.width = '84%';
  }
}

function createPlayerCard(slot: PlayerSlot): PlayerCardRefs {
  const item = document.createElement('li');
  item.className = `player-card player-card--${slot}`;

  const avatarWrap = document.createElement('div');
  avatarWrap.className = 'player-avatar';

  const avatar = document.createElement('img');
  avatar.src = `/images/${DEFAULT_PLANE_CONFIG[slot].planeImage}`;
  avatar.alt = `${formatSlot(slot)} pilot`;
  avatarWrap.append(avatar);

  const main = document.createElement('div');
  main.className = 'player-main';

  const side = document.createElement('span');
  side.className = 'player-side';
  side.textContent = slot === 'left' ? '◀ Left Pilot' : 'Right Pilot ▶';

  const name = document.createElement('span');
  name.className = 'player-name';
  name.textContent = slot === 'left' ? 'Pilot Alpha' : 'Pilot Bravo';

  const detailRow = document.createElement('div');
  detailRow.className = 'player-status-row';

  const statusDot = document.createElement('span');
  statusDot.className = 'connection-dot connection-dot--bad';

  const detail = document.createElement('span');
  detail.className = 'player-detail';
  detail.textContent = 'Seat open for another pilot';

  detailRow.append(statusDot, detail);
  main.append(side, name, detailRow);

  const score = document.createElement('span');
  score.className = 'player-score';
  score.textContent = '00';

  const resourceGroup = document.createElement('div');
  resourceGroup.className = 'player-resources';
  resourceGroup.hidden = true;

  const ammo = createResourceBlock('Ammo', 'resource-fill--ammo');
  const fuel = createResourceBlock('Fuel', 'resource-fill--fuel');
  const hull = createResourceBlock('Hull', 'resource-fill--hull');
  resourceGroup.append(ammo.block, fuel.block, hull.block);

  item.append(avatarWrap, main, score, resourceGroup);

  return {
    item,
    side,
    name,
    detail,
    score,
    statusDot,
    resourceGroup,
    ammoValue: ammo.value,
    fuelValue: fuel.value,
    hullValue: hull.value,
    ammoFill: ammo.fill,
    fuelFill: fuel.fill,
    hullFill: hull.fill,
  };
}

function createResourceBlock(label: string, fillClassName: string): {
  block: HTMLDivElement;
  value: HTMLSpanElement;
  fill: HTMLSpanElement;
} {
  const block = document.createElement('div');
  block.className = 'resource-block';

  const labelRow = document.createElement('div');
  labelRow.className = 'resource-label-row';

  const name = document.createElement('span');
  name.className = 'resource-name';
  name.textContent = label;

  const value = document.createElement('span');
  value.className = 'resource-value';
  value.textContent = '0%';

  const track = document.createElement('div');
  track.className = 'resource-track';

  const fill = document.createElement('span');
  fill.className = `resource-fill ${fillClassName}`;
  fill.style.width = '0%';

  labelRow.append(name, value);
  track.append(fill);
  block.append(labelRow, track);

  return { block, value, fill };
}

function renderShareCode(container: HTMLDivElement, roomId: string | null): void {
  container.replaceChildren();

  if (!roomId) {
    return;
  }

  for (const character of roomId) {
    const digit = document.createElement('span');
    digit.className = 'share-code-display__digit';
    digit.textContent = character;
    container.append(digit);
  }
}

function shouldShowSetupPanel(appState: AppState, uiState: UiState): boolean {
  if (appState.roomState?.status === 'round_over') {
    return true;
  }

  if (uiState.setupPanelMode === 'share') {
    return Boolean(getRoomLink(appState.roomId, uiState.roomLink)) && !isMatchStarted(appState);
  }

  return uiState.setupPanelMode === 'join';
}

function isMatchStarted(appState: AppState): boolean {
  return Boolean(appState.roomState && appState.roomState.status !== 'waiting');
}

function getConnectionTone(appState: AppState, connectionPhase: ConnectionPhase): string {
  if (connectionPhase === 'connected' && appState.roomState?.status === 'waiting') {
    return 'connection-dot--warn';
  }

  switch (connectionPhase) {
    case 'connected':
      return 'connection-dot--ok';
    case 'creating':
    case 'connecting':
      return 'connection-dot--warn';
    case 'idle':
    case 'error':
      return 'connection-dot--bad';
  }
}

function getConnectionLabel(appState: AppState, connectionPhase: ConnectionPhase): string {
  if (connectionPhase === 'connected' && appState.roomState?.message) {
    return appState.roomState.message.replace(/\.$/, '');
  }

  switch (connectionPhase) {
    case 'connected':
      return 'Online';
    case 'creating':
      return 'Creating';
    case 'connecting':
      return 'Connecting';
    case 'idle':
    case 'error':
      return 'Offline';
  }
}

function getMatchStatusLabel(appState: AppState, connectionPhase: ConnectionPhase): string {
  if (!appState.roomState) {
    return connectionPhase === 'connecting' ? 'Connecting' : 'Lobby';
  }

  switch (appState.roomState.status) {
    case 'waiting':
      return 'Lobby';
    case 'active':
      return 'In Flight';
    case 'round_over':
      return 'Round Over';
  }
}

function getMatchStatusTone(appState: AppState): string {
  if (!appState.roomState || appState.roomState.status === 'waiting') {
    return 'vs-state--waiting';
  }

  return appState.roomState.status === 'round_over' ? 'vs-state--over' : 'vs-state--live';
}

function getPilotName(
  player: Pick<PlayerState, 'slot' | 'connected'>,
  currentSlot: PlayerSlot | null
): string {
  if (!player.connected && player.slot !== currentSlot) {
    return 'Awaiting Pilot';
  }

  return player.slot === 'left' ? 'Pilot Alpha' : 'Pilot Bravo';
}

function getPlayerCardDetail(player: {
  connected: boolean;
  plane: {
    phase: PlanePhase;
    position?: { y: number };
  };
}): string {
  if (!player.connected) {
    return 'Seat open for another pilot';
  }

  switch (player.plane.phase) {
    case 'parked':
      return 'On runway';
    case 'runway':
      return 'Runway roll';
    case 'airborne':
      return `Airborne · alt ${Math.max(0, Math.round(GROUND_CONTACT_Y - (player.plane.position?.y ?? GROUND_CONTACT_Y)))}`;
    case 'stall':
      return 'Stall recovery';
    case 'landing':
      return 'Landing run';
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

function getRoundResultStatusMessage(appState: AppState): string {
  if (!appState.roomState) {
    return 'Both pilots must request rematch.';
  }

  if (hasRequestedRematchFor(appState)) {
    return appState.roomState.rematchVotes.length === PLAYER_SLOTS.length
      ? 'Both pilots confirmed the rematch.'
      : 'Waiting for the second player to confirm the rematch.';
  }

  return appState.roomState.message ?? 'Both pilots must request rematch.';
}

function hasRequestedRematchFor(appState: Pick<AppState, 'slot' | 'roomState'>): boolean {
  return Boolean(appState.slot && appState.roomState?.rematchVotes.includes(appState.slot));
}

function formatSlot(slot: PlayerSlot): string {
  return slot === 'left' ? 'Left' : 'Right';
}
