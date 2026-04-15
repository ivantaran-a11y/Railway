/**
 * Discord Gateway Client
 * Minimal production-ready implementation using raw WebSocket (ws library).
 * No discord.js or other high-level libraries.
 *
 * Usage:
 *   export BOT_TOKEN=your_token_here
 *   node gateway.js
 */

import WebSocket from 'ws';
import https from 'https';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GATEWAY_URL      = 'wss://gateway.discord.gg/?v=10&encoding=json';
const COREZOID_URL     = 'https://www.corezoid.com/api/2/json/public/1813688/c9e9b5c8eb30b2cd43b5d869eed5e38df6e04152';
const COREZOID_CONV_ID = 1813688; // process id from the URL above

// Discord Gateway intents:
//   GUILDS (1) + GUILD_MESSAGES (512) + MESSAGE_CONTENT (32768) = 33281
const INTENTS = 33281;

// Opcodes
const OP = {
  DISPATCH:        0,
  HEARTBEAT:       1,
  IDENTIFY:        2,
  RECONNECT:       7,
  INVALID_SESSION: 9,
  HELLO:          10,
  HEARTBEAT_ACK:  11,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ws              = null;   // active WebSocket connection
let heartbeatTimer  = null;   // setInterval handle
let sequence        = null;   // last sequence number received
let sessionId       = null;   // session id (for future resume support)
let isShuttingDown  = false;  // graceful shutdown flag

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------

function log(tag, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${tag}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Corezoid forwarding
// ---------------------------------------------------------------------------

/**
 * Forward a Discord event to Corezoid via its public API.
 *
 * Corezoid public process format: [ { reference, data } ]
 * All Discord fields are spread flat into `data` so each field
 * is accessible as a separate Corezoid task parameter.
 * Nested objects (author, member, etc.) are JSON-stringified
 * to avoid silent drops on Corezoid's side.
 *
 * Uses native fetch (Node 18+) — no manual Content-Length needed.
 *
 * @param {string} eventName  e.g. "MESSAGE_CREATE", "READY"
 * @param {object} eventData  raw Discord event payload
 */
async function sendToCorezoid(eventName, eventData) {
  // Send the full Discord payload as-is, with event name added.
  // conv_id is REQUIRED inside each op — without it the API silently rejects.
  const body = JSON.stringify({
    ops: [
      {
        type:    'create',
        obj:     'task',
        ref:     `${eventName}_${randomUUID()}`,
        conv_id: COREZOID_CONV_ID,
        data:    { event: eventName, ...eventData },
      },
    ],
  });

  try {
    const res  = await fetch(COREZOID_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const text = await res.text();
    log('COREZOID', `${eventName} → HTTP ${res.status} | ${text.slice(0, 200)}`);
  } catch (err) {
    log('COREZOID_ERROR', `${eventName}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// REST: send a message to a channel
// ---------------------------------------------------------------------------

/**
 * Send a message to a Discord channel via REST API.
 * Uses Node.js built-in `https` — no external HTTP library needed.
 *
 * @param {string} channelId
 * @param {string} content
 * @returns {Promise<object>} parsed JSON response
 */
export function sendMessage(channelId, content) {
  return new Promise((resolve, reject) => {
    const token = process.env.BOT_TOKEN;
    const body  = JSON.stringify({ content });

    const options = {
      method:   'POST',
      hostname: 'discord.com',
      path:     `/api/v10/channels/${channelId}/messages`,
      headers: {
        'Authorization':  `Bot ${token}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'DiscordBot (gateway.js, 1.0.0)',
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve(raw); }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/** Start sending heartbeats every `interval` ms. */
function startHeartbeat(interval) {
  stopHeartbeat(); // clear any existing timer

  log('HEARTBEAT', `Starting heartbeat every ${interval}ms`);

  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: sequence }));
      log('HEARTBEAT', `Sent (seq=${sequence})`);
    }
  }, interval);
}

/** Stop the heartbeat loop. */
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Gateway message handlers
// ---------------------------------------------------------------------------

/** Handle HELLO (op 10): start heartbeat and send IDENTIFY. */
function handleHello(data) {
  const interval = data.heartbeat_interval;
  log('HELLO', `Received. heartbeat_interval=${interval}ms`);

  startHeartbeat(interval);
  sendIdentify();
}

/** Send IDENTIFY payload (op 2). */
function sendIdentify() {
  const token = process.env.BOT_TOKEN;

  // Gateway v10 uses os/browser/device WITHOUT the '$' prefix
  const payload = {
    op: OP.IDENTIFY,
    d: {
      token,
      intents: INTENTS,
      properties: {
        os:      process.platform,
        browser: 'gateway.js',
        device:  'gateway.js',
      },
    },
  };

  ws.send(JSON.stringify(payload));
  log('IDENTIFY', `Sent (intents=${INTENTS})`);
}

/** Handle DISPATCH (op 0) events. */
function handleDispatch(eventName, data) {
  // Log every event so we can see what Discord is actually sending
  log('DISPATCH', `→ ${eventName} (seq=${sequence})`);

  // Forward every Discord event to Corezoid
  sendToCorezoid(eventName, data);

  switch (eventName) {
    case 'READY':
      sessionId = data.session_id;
      log('READY', `Logged in as ${data.user.username}#${data.user.discriminator} (session=${sessionId})`);
      log('READY', `Bot is in ${data.guilds.length} guild(s)`);
      break;

    case 'MESSAGE_CREATE':
      if (data.author?.bot) {
        log('MESSAGE_CREATE', `[SKIP bot] ${data.author.username}: ${data.content}`);
        return;
      }
      log('MESSAGE_CREATE', `[#${data.channel_id}] ${data.author.username}: ${data.content}`);
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

/** Connect (or reconnect) to the Discord Gateway. */
function connect() {
  if (isShuttingDown) return;

  log('GATEWAY', `Connecting to ${GATEWAY_URL}`);

  ws = new WebSocket(GATEWAY_URL);

  // Socket open
  ws.on('open', () => {
    log('GATEWAY', 'Connected');
  });

  // Incoming message
  ws.on('message', (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      log('ERROR', `Failed to parse message: ${err.message}`);
      return;
    }

    const { op, d, s, t } = payload;

    // Track sequence number for heartbeat
    if (s != null) sequence = s;

    switch (op) {
      case OP.HELLO:
        handleHello(d);
        break;

      case OP.DISPATCH:
        handleDispatch(t, d);
        break;

      case OP.HEARTBEAT_ACK:
        log('HEARTBEAT', `ACK received (connection alive, seq=${sequence})`);
        break;

      case OP.HEARTBEAT:
        // Server requested an immediate heartbeat
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: sequence }));
          log('HEARTBEAT', `Sent immediately (server request, seq=${sequence})`);
        }
        break;

      case OP.RECONNECT:
        log('RECONNECT', 'Server requested reconnect');
        reconnect();
        break;

      case OP.INVALID_SESSION:
        log('INVALID_SESSION', `Received (resumable=${d}). Reconnecting in 5s...`);
        closeSocket();
        setTimeout(connect, 5000);
        break;

      default:
        log('GATEWAY', `Unhandled op: ${op}`);
        break;
    }
  });

  // Socket error
  ws.on('error', (err) => {
    log('ERROR', `WebSocket error: ${err.message}`);
  });

  // Socket close
  ws.on('close', (code, reason) => {
    stopHeartbeat();

    if (isShuttingDown) {
      log('GATEWAY', 'Socket closed (shutdown)');
      return;
    }

    log('RECONNECT', `Socket closed (code=${code}, reason=${reason}). Reconnecting in 5s...`);
    setTimeout(connect, 5000);
  });
}

/** Close the current socket cleanly (without triggering auto-reconnect). */
function closeSocket() {
  stopHeartbeat();
  if (ws) {
    ws.removeAllListeners('close'); // prevent the 'close' handler from scheduling a reconnect
    ws.close();
    ws = null;
  }
}

/** Close current socket and open a fresh connection after 5s. */
function reconnect() {
  log('RECONNECT', 'Reconnecting...');
  closeSocket();
  setTimeout(connect, 5000);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal) {
  log('SHUTDOWN', `Received ${signal}. Shutting down gracefully...`);
  isShuttingDown = true;
  stopHeartbeat();
  if (ws) ws.close();
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (!process.env.BOT_TOKEN) {
  console.error('[ERROR] BOT_TOKEN is not set.');
  console.error('  Set it with:  export BOT_TOKEN=your_token_here');
  process.exit(1);
}

connect();
