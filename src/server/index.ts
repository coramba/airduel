import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import WebSocket, { WebSocketServer, type RawData } from 'ws';

import {
  isInputState,
  PLAYER_SLOTS,
  type ClientMessage,
  type ServerErrorCode,
  type ServerMessage
} from '../shared/game.js';
import { isPlaneStats } from '../shared/plane-stats.js';
import { normalizeRoomId, RoomRegistry } from './room-registry.js';
import { SIMULATION_TICK_MS, stepRoom } from './simulation.js';

// HTTP + WebSocket entry point.
// This file deliberately stays small:
// - HTTP serves static assets plus a tiny room-creation API
// - WebSocket upgrades join authoritative rooms and stream room state updates
const publicRoot = resolve(process.cwd(), 'public');
const buildRoot = resolve(process.cwd(), 'dist');
const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 5173);
const roomTtlMs = Number(process.env.ROOM_TTL_MS ?? 15 * 60 * 1000);

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8'
};

const webSocketServer = new WebSocketServer({ noServer: true });
const socketRooms = new Map<WebSocket, { roomId: string; slot: 'left' | 'right' }>();

function toSafePath(root: string, requestPath: string): string {
  const normalizedPath = normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, '');
  return join(root, normalizedPath);
}

// Assets can live either in `public/` or in compiled `dist/`.
// The lookup order matches how the project is built and served in Docker.
async function resolveAssetPath(urlPath: string): Promise<string | null> {
  if (urlPath === '/') {
    return join(publicRoot, 'index.html');
  }

  const publicPath = toSafePath(publicRoot, urlPath);

  try {
    const file = await stat(publicPath);
    if (file.isFile()) {
      return publicPath;
    }
  } catch {
    // Fall through to build assets.
  }

  const buildPath = toSafePath(buildRoot, urlPath);

  try {
    const file = await stat(buildPath);
    if (file.isFile()) {
      return buildPath;
    }
  } catch {
    return null;
  }

  return null;
}

function sendJson(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function sendError(socket: WebSocket, code: ServerErrorCode, message: string): void {
  sendJson(socket, {
    type: 'error',
    payload: {
      code,
      message
    }
  });
}

// Room state broadcast is the single fan-out path used by joins, disconnects,
// rematches, reconnect grace expiry, and simulation ticks.
function broadcastRoomState(roomId: string): void {
  const room = roomRegistry.getRoom(roomId);
  if (!room) {
    return;
  }

  for (const socket of Object.values(room.sockets)) {
    if (socket) {
      sendJson(socket, {
        type: 'room_state',
        payload: room.state
      });
    }
  }
}

const roomRegistry = new RoomRegistry(roomTtlMs, broadcastRoomState);

// Reverse proxy friendliness: if the app sits behind another server, forwarded
// proto is used when constructing share links.
function getOrigin(request: RequestLike): string {
  const protocolHeader = request.headers['x-forwarded-proto'];
  const protocol = Array.isArray(protocolHeader) ? protocolHeader[0] : protocolHeader ?? 'http';
  const hostHeader = request.headers.host ?? `localhost:${port}`;
  return `${protocol}://${hostHeader}`;
}

// WebSocket messages stay deliberately tiny:
// - `input` updates local control intent
// - `rematch_requested` records a rematch vote
function handleClientMessage(socket: WebSocket, rawMessage: RawData): void {
  const metadata = socketRooms.get(socket);
  if (!metadata) {
    sendError(socket, 'invalid_message', 'Socket is not assigned to a room.');
    return;
  }

  try {
    const parsedMessage = JSON.parse(rawMessage.toString()) as ClientMessage;

    if (!parsedMessage || typeof parsedMessage !== 'object' || typeof parsedMessage.type !== 'string') {
      throw new Error('Message is missing a valid type.');
    }

    if (parsedMessage.type === 'input') {
      if (!isInputState(parsedMessage.payload)) {
        throw new Error('Input payload is invalid.');
      }

      roomRegistry.updateInput(metadata.roomId, metadata.slot, parsedMessage.payload);
      return;
    }

    if (parsedMessage.type === 'rematch_requested') {
      roomRegistry.requestRematch(metadata.roomId, metadata.slot);
      broadcastRoomState(metadata.roomId);
      return;
    }

    if (parsedMessage.type === 'plane_stats_update') {
      const { payload } = parsedMessage;
      if (!PLAYER_SLOTS.includes(payload.slot) || !isPlaneStats(payload.stats)) {
        throw new Error('Invalid plane stats payload.');
      }
      roomRegistry.updatePlaneStats(metadata.roomId, payload.slot, payload.stats);
      return;
    }

    throw new Error('Unsupported message type.');
  } catch {
    sendError(socket, 'invalid_message', 'Message must be valid JSON with a supported payload.');
  }
}

// HTTP routes:
// - POST /api/rooms : create a room and return a share link
// - GET /health     : tiny health probe used by local checks
// - everything else : static asset delivery
const server = createServer(async (request, response) => {
  if (!request.url) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Missing URL');
    return;
  }

  const requestUrl = new URL(request.url, getOrigin(request));

  if (request.method === 'POST' && requestUrl.pathname === '/api/rooms') {
    const createRoomResponse = roomRegistry.createRoom(getOrigin(request));

    response.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(createRoomResponse));
    return;
  }

  if (requestUrl.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  const assetPath = await resolveAssetPath(requestUrl.pathname);

  if (!assetPath) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const extension = extname(assetPath);
  const contentType = mimeTypes[extension] ?? 'application/octet-stream';

  response.writeHead(200, { 'content-type': contentType });
  createReadStream(assetPath).pipe(response);
});

server.on('upgrade', (request, socket, head) => {
  if (!request.url) {
    socket.destroy();
    return;
  }

  const requestUrl = new URL(request.url, getOrigin(request));
  if (requestUrl.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  webSocketServer.handleUpgrade(request, socket, head, (webSocket: WebSocket) => {
    webSocketServer.emit('connection', webSocket, request);
  });
});

// WebSocket connection lifecycle:
// 1. validate the room id (and optional reconnect token)
// 2. join a slot through RoomRegistry
// 3. send assignment payload
// 4. broadcast room state to all occupants
webSocketServer.on('connection', (socket: WebSocket, request: IncomingMessage) => {
  const requestUrl = new URL(request.url ?? '/ws', getOrigin(request));
  const roomId = normalizeRoomId(requestUrl.searchParams.get('room'));
  const reconnectToken = requestUrl.searchParams.get('token');
  const joinResult = roomRegistry.joinRoom(roomId ?? '', socket, reconnectToken);

  if (!joinResult.ok) {
    sendError(socket, joinResult.code, getRoomErrorMessage(joinResult.code));
    socket.close(1008, joinResult.code);
    return;
  }

  socketRooms.set(socket, {
    roomId: joinResult.room.state.id,
    slot: joinResult.slot
  });

  sendJson(socket, {
    type: 'player_assignment',
    payload: {
      roomId: joinResult.room.state.id,
      reconnectToken: joinResult.reconnectToken,
      slot: joinResult.slot
    }
  });

  broadcastRoomState(joinResult.room.state.id);

  socket.on('message', (message: RawData) => {
    handleClientMessage(socket, message);
  });

  socket.on('close', () => {
    const metadata = socketRooms.get(socket);
    socketRooms.delete(socket);

    if (!metadata) {
      return;
    }

    roomRegistry.leaveRoom(metadata.roomId, metadata.slot, socket);
    broadcastRoomState(metadata.roomId);
  });
});

// Simulation ticks and room cleanup run independently of socket activity.
setInterval(() => {
  for (const room of roomRegistry.getRooms()) {
    if (stepRoom(room)) {
      broadcastRoomState(room.state.id);
    }
  }
}, SIMULATION_TICK_MS).unref();

setInterval(() => {
  roomRegistry.cleanupExpiredRooms();
}, 30_000).unref();

server.listen(port, host, () => {
  console.log(`Air Duel server listening on http://${host}:${port}`);
});

function getRoomErrorMessage(code: ServerErrorCode): string {
  switch (code) {
    case 'room_expired':
      return 'This room expired. Create a new match.';
    case 'room_full':
      return 'This room already has two pilots.';
    case 'room_not_found':
      return 'This room does not exist.';
    case 'invalid_room':
      return 'Room id is invalid.';
    case 'invalid_message':
      return 'Message must be valid JSON.';
  }
}

interface RequestLike {
  headers: {
    host?: string;
    'x-forwarded-proto'?: string | string[];
  };
}
