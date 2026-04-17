import { randomBytes } from 'node:crypto';
import type WebSocket from 'ws';

import {
  PLAYER_SLOTS,
  createDefaultInputState,
  createDefaultPlaneState,
  createDefaultPlayerState,
  type CreateRoomResponse,
  type InputState,
  type PlayerSlot,
  type RoomState,
  type ServerErrorCode
} from '../shared/game.js';
import { DEFAULT_PLANE_STATS, type PlaneStats } from '../shared/game-config.js';

// RoomRegistry owns all long-lived multiplayer state that is not part of the
// frame-by-frame flight simulation:
// - room creation and expiry
// - slot assignment
// - reconnect reservation for active rounds
// - rematch voting and round resets
const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_ID_LENGTH = 6;
const ROOM_ID_PATTERN = new RegExp(`^[${ROOM_ID_ALPHABET}]{${ROOM_ID_LENGTH}}$`);
const DEFAULT_ROOM_TTL_MS = 15 * 60 * 1000;
const ACTIVE_RECONNECT_GRACE_MS = 3_000;

type JoinFailureCode = Extract<
  ServerErrorCode,
  'room_not_found' | 'room_full' | 'room_expired' | 'invalid_room'
>;

export interface RoomRecord {
  state: RoomState;
  sockets: Partial<Record<PlayerSlot, WebSocket>>;
  // Active-round disconnects do not immediately forfeit the round.
  // A short grace timer gives refresh/reconnect a chance to reclaim the slot.
  disconnectTimers: Partial<Record<PlayerSlot, ReturnType<typeof setTimeout>>>;
  // Each slot gets a private reconnect token. A reconnecting browser must
  // present the matching token to reclaim a live slot during the grace window.
  reconnectTokens: Record<PlayerSlot, string>;
  // Per-slot simulation parameters. Starts from defaults; debug clients can
  // update them live via the plane_stats_update websocket message.
  planeStats: Record<PlayerSlot, PlaneStats>;
}

export type JoinRoomResult =
  | {
      ok: true;
      reconnectToken: string;
      room: RoomRecord;
      slot: PlayerSlot;
    }
  | {
      ok: false;
      code: JoinFailureCode;
    };

export class RoomRegistry {
  private readonly rooms = new Map<string, RoomRecord>();

  constructor(
    private readonly roomTtlMs = DEFAULT_ROOM_TTL_MS,
    private readonly onRoomChanged?: (roomId: string) => void
  ) {}

  createRoom(origin: string): CreateRoomResponse {
    // Expired empty rooms are cleaned opportunistically before allocating a new id.
    this.cleanupExpiredRooms();

    let roomId = createRoomId();
    while (this.rooms.has(roomId)) {
      roomId = createRoomId();
    }

    const now = Date.now();
    const room: RoomRecord = {
      state: {
        id: roomId,
        status: 'waiting',
        round: 1,
        message: 'Waiting for the second pilot to join.',
        players: PLAYER_SLOTS.map((slot) => createDefaultPlayerState(slot)),
        bullets: [],
        rematchVotes: [],
        winner: null,
        createdAt: now,
        lastActivityAt: now
      },
      sockets: {},
      disconnectTimers: {},
      reconnectTokens: {
        left: createReconnectToken(),
        right: createReconnectToken()
      },
      planeStats: {
        left:  { ...DEFAULT_PLANE_STATS.left  },
        right: { ...DEFAULT_PLANE_STATS.right }
      }
    };

    this.rooms.set(roomId, room);

    return {
      roomId,
      joinUrl: `${origin}/?room=${roomId}`
    };
  }

  getRoom(roomId: string): RoomRecord | null {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!normalizedRoomId) {
      return null;
    }

    const room = this.rooms.get(normalizedRoomId);
    if (!room) {
      return null;
    }

    if (this.isExpired(room)) {
      this.rooms.delete(normalizedRoomId);
      return null;
    }

    return room;
  }

  getRooms(): RoomRecord[] {
    return Array.from(this.rooms.values());
  }

  // Join logic has two modes:
  // 1. normal join into the next empty slot while the room is waiting
  // 2. authenticated reclaim of an active-round slot during reconnect grace
  joinRoom(roomId: string, socket: WebSocket, reconnectToken?: string | null): JoinRoomResult {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!normalizedRoomId) {
      return { ok: false, code: 'invalid_room' };
    }

    const room = this.rooms.get(normalizedRoomId);
    if (!room) {
      return { ok: false, code: 'room_not_found' };
    }

    if (this.isExpired(room)) {
      this.rooms.delete(normalizedRoomId);
      return { ok: false, code: 'room_expired' };
    }

    const requestedReconnectSlot = PLAYER_SLOTS.find(
      (candidate) =>
        room.reconnectTokens[candidate] === reconnectToken && room.sockets[candidate] === undefined
    );

    // Active rounds never accept anonymous "new" occupants into an empty socket.
    // Only the browser holding the original slot token can reclaim that slot.
    const slot =
      requestedReconnectSlot ??
      (room.state.status === 'active'
        ? undefined
        : PLAYER_SLOTS.find((candidate) => room.sockets[candidate] === undefined));

    if (!slot) {
      return { ok: false, code: 'room_full' };
    }

    room.sockets[slot] = socket;
    this.clearDisconnectTimer(room, slot);
    this.setPlayerConnected(room, slot, true);

    if (room.state.status === 'active') {
      // Reconnecting into a live round should resume the current round in place,
      // not reset planes or increment the round counter.
      room.state.message = `Round ${room.state.round} live.`;
      room.state.lastActivityAt = Date.now();
    } else {
      const shouldIncrementRound = room.state.status === 'round_over';
      if (this.connectedPlayerCount(room) === PLAYER_SLOTS.length) {
        this.startRound(room, shouldIncrementRound);
      } else {
        this.resetWaitingState(room, 'Waiting for the second pilot to join.');
      }
    }

    return {
      ok: true,
      reconnectToken: room.reconnectTokens[slot],
      room,
      slot
    };
  }

  leaveRoom(roomId: string, slot: PlayerSlot, socket: WebSocket): RoomRecord | null {
    const room = this.getRoom(roomId);
    if (!room) {
      return null;
    }

    if (room.sockets[slot] === socket) {
      delete room.sockets[slot];
      this.clearDisconnectTimer(room, slot);
      this.setPlayerConnected(room, slot, false);

      if (room.state.status === 'active') {
        // Active rounds pause on disconnect first and only convert to a forfeit
        // if the reconnect grace expires without the same slot coming back.
        this.scheduleDisconnectResolution(room, slot);
      } else if (this.connectedPlayerCount(room) === 0) {
        this.resetWaitingState(room, 'Waiting for pilots.');
      } else {
        this.resetWaitingState(room, 'Pilot disconnected. Waiting for another pilot to join.');
      }
    }

    return room;
  }

  updateInput(roomId: string, slot: PlayerSlot, input: InputState): RoomRecord | null {
    const room = this.getRoom(roomId);
    if (!room) {
      return null;
    }

    const player = room.state.players.find((candidate) => candidate.slot === slot);
    if (!player) {
      return null;
    }

    player.input = { ...input };
    room.state.lastActivityAt = Date.now();
    return room;
  }

  requestRematch(roomId: string, slot: PlayerSlot): RoomRecord | null {
    const room = this.getRoom(roomId);
    if (!room || room.state.status !== 'round_over') {
      return room;
    }

    const player = room.state.players.find((candidate) => candidate.slot === slot);
    if (!player || !player.connected) {
      return room;
    }

    if (!room.state.rematchVotes.includes(slot)) {
      room.state.rematchVotes.push(slot);
    }

    room.state.lastActivityAt = Date.now();

    if (
      this.connectedPlayerCount(room) === PLAYER_SLOTS.length &&
      room.state.rematchVotes.length === PLAYER_SLOTS.length
    ) {
      this.startRound(room, true);
    } else if (this.connectedPlayerCount(room) === PLAYER_SLOTS.length) {
      room.state.message = 'Waiting for both pilots to request rematch.';
    } else {
      room.state.message = 'Waiting for another pilot to join before rematch.';
    }

    return room;
  }

  updatePlaneStats(roomId: string, slot: PlayerSlot, stats: PlaneStats): void {
    const room = this.getRoom(roomId);
    if (room) {
      room.planeStats[slot] = { ...stats };
    }
  }

  cleanupExpiredRooms(): void {
    for (const [roomId, room] of this.rooms.entries()) {
      if (this.isExpired(room)) {
        this.rooms.delete(roomId);
      }
    }
  }

  private connectedPlayerCount(room: RoomRecord): number {
    return PLAYER_SLOTS.filter((slot) => room.sockets[slot] !== undefined).length;
  }

  private isExpired(room: RoomRecord): boolean {
    const hasConnectedPlayers = PLAYER_SLOTS.some((slot) => room.sockets[slot] !== undefined);
    if (hasConnectedPlayers) {
      return false;
    }

    return Date.now() - room.state.lastActivityAt > this.roomTtlMs;
  }

  private setPlayerConnected(room: RoomRecord, slot: PlayerSlot, connected: boolean): void {
    for (const player of room.state.players) {
      if (player.slot === slot) {
        player.connected = connected;
      }
    }
  }

  private startRound(room: RoomRecord, incrementRound: boolean): void {
    // Starting a round wipes only round-scoped state.
    // Persistent values such as room id and player win counters are preserved.
    this.clearAllDisconnectTimers(room);

    if (incrementRound) {
      room.state.round += 1;
    }

    room.state.status = 'active';
    room.state.message = `Round ${room.state.round} live.`;
    room.state.bullets = [];
    room.state.rematchVotes = [];
    room.state.winner = null;
    room.state.lastActivityAt = Date.now();

    for (const player of room.state.players) {
      player.input = createDefaultInputState();
      player.plane = createDefaultPlaneState(player.slot);
    }
  }

  private resetWaitingState(room: RoomRecord, message: string): void {
    // Waiting state is used for room setup and for partial-room recovery after
    // disconnects outside an active round.
    this.clearAllDisconnectTimers(room);

    room.state.status = 'waiting';
    room.state.message = message;
    room.state.bullets = [];
    room.state.rematchVotes = [];
    room.state.winner = null;
    room.state.lastActivityAt = Date.now();

    for (const player of room.state.players) {
      player.input = createDefaultInputState();
      player.plane = createDefaultPlaneState(player.slot);
    }
  }

  private finishRoundFromDisconnect(room: RoomRecord, departedSlot: PlayerSlot): void {
    const remainingPlayer = room.state.players.find(
      (player) => player.slot !== departedSlot && player.connected
    );

    if (!remainingPlayer) {
      this.resetWaitingState(room, 'Waiting for pilots.');
      return;
    }

    room.state.status = 'round_over';
    room.state.message = 'Other pilot disconnected. Round awarded to the remaining pilot.';
    room.state.bullets = [];
    room.state.rematchVotes = [];
    room.state.winner = remainingPlayer.slot === 'left' ? 'left_win' : 'right_win';
    remainingPlayer.wins += 1;
    room.state.lastActivityAt = Date.now();

    for (const player of room.state.players) {
      player.input = createDefaultInputState();

      if (player.slot === departedSlot) {
        player.plane.phase = 'destroyed';
        player.plane.velocity.x = 0;
        player.plane.velocity.y = 0;
      }
    }
  }

  private scheduleDisconnectResolution(room: RoomRecord, departedSlot: PlayerSlot): void {
    // The room stays active during the grace window so simulation state is
    // preserved exactly as it was at disconnect time.
    room.state.message = 'Pilot disconnected. Waiting briefly for reconnect.';
    room.state.lastActivityAt = Date.now();

    const timer = setTimeout(() => {
      const latestRoom = this.rooms.get(room.state.id);
      if (!latestRoom || latestRoom.sockets[departedSlot] !== undefined || latestRoom.state.status !== 'active') {
        return;
      }

      delete latestRoom.disconnectTimers[departedSlot];
      this.finishRoundFromDisconnect(latestRoom, departedSlot);
      this.onRoomChanged?.(latestRoom.state.id);
    }, ACTIVE_RECONNECT_GRACE_MS);

    room.disconnectTimers[departedSlot] = timer;
  }

  private clearDisconnectTimer(room: RoomRecord, slot: PlayerSlot): void {
    const timer = room.disconnectTimers[slot];
    if (timer) {
      clearTimeout(timer);
      delete room.disconnectTimers[slot];
    }
  }

  private clearAllDisconnectTimers(room: RoomRecord): void {
    for (const slot of PLAYER_SLOTS) {
      this.clearDisconnectTimer(room, slot);
    }
  }
}

// Room ids are user-facing, so normalization is centralized here and reused by
// HTTP and websocket entry points.
export function normalizeRoomId(roomId: string | null | undefined): string | null {
  if (!roomId) {
    return null;
  }

  const normalizedRoomId = roomId.trim().toUpperCase();
  if (!ROOM_ID_PATTERN.test(normalizedRoomId)) {
    return null;
  }

  return normalizedRoomId;
}

// Human-shareable room ids intentionally avoid ambiguous characters.
function createRoomId(): string {
  const bytes = randomBytes(ROOM_ID_LENGTH);
  let roomId = '';

  for (let index = 0; index < ROOM_ID_LENGTH; index += 1) {
    roomId += ROOM_ID_ALPHABET[bytes[index] % ROOM_ID_ALPHABET.length];
  }

  return roomId;
}

// Reconnect tokens are not user-facing. They only need to be unguessable.
function createReconnectToken(): string {
  return randomBytes(16).toString('hex');
}
