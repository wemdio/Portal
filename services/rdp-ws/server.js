const GuacamoleLite = require('guacamole-lite');
const jwt = require('jsonwebtoken');
const http = require('http');

const PORT = Number(process.env.RDP_WS_PORT || 8080);
const JWT_SECRET = process.env.RDP_WS_SECRET;
const GUACD_HOST = process.env.GUACD_HOST || 'guacd';
const GUACD_PORT = Number(process.env.GUACD_PORT || 4822);

const RDP_HOST = process.env.RDP_HOST;
const RDP_PORT = process.env.RDP_PORT || '3389';
const RDP_USERNAME = process.env.RDP_USERNAME;
const RDP_PASSWORD = process.env.RDP_PASSWORD;

if (!JWT_SECRET) {
  console.error('[rdp-ws] RDP_WS_SECRET is not set');
  process.exit(1);
}
if (!RDP_HOST) {
  console.error('[rdp-ws] RDP_HOST is not set');
  process.exit(1);
}

const httpServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
});

const guacServer = new GuacamoleLite(
  { server: httpServer },
  {
    host: GUACD_HOST,
    port: GUACD_PORT,
  },
  {
    // Disable inactivity timeout — default 10s kills the connection before Windows
    // finishes loading the desktop (black screen on new session startup).
    maxInactivityTime: 0,

    crypt: {
      cypher: 'AES-256-CBC',
      // JWT_SECRET is a base64-encoded 32-byte value; decode it so createDecipheriv
      // receives exactly 32 bytes (AES-256 requirement).
      key: Buffer.from(JWT_SECRET, 'base64'),
    },
    log: {
      level: 'NORMAL',
    },
    connectionDefaultSettings: {
        rdp: {
        hostname: RDP_HOST,
        port: RDP_PORT,
        username: RDP_USERNAME,
        password: RDP_PASSWORD,
        security: 'nla',
        'ignore-cert': 'true',
        // Resolution is driven by the client viewport passed in client.connect()
        'color-depth': '16',
        'enable-wallpaper': 'false',
        'enable-font-smoothing': 'false',
        'enable-desktop-composition': 'false',
        'enable-full-window-drag': 'false',
        'disable-bitmap-caching': 'true',
        'disable-offscreen-caching': 'true',
        'disable-glyph-caching': 'true',
        'resize-method': 'reconnect',
        'enable-drive': 'false',
        'create-drive-path': 'false',
        'disable-audio': 'true',
      },
    },
  },
);

guacServer.on('open', (clientConnection) => {
  console.log(`[rdp-ws] Connection opened: ${clientConnection.connectionId}`);
});

guacServer.on('close', (clientConnection) => {
  console.log(`[rdp-ws] Connection closed: ${clientConnection.connectionId}`);
});

guacServer.on('error', (clientConnection, error) => {
  console.error(`[rdp-ws] Error on ${clientConnection?.connectionId}:`, error);
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[rdp-ws] WebSocket proxy listening on port ${PORT}`);
  console.log(`[rdp-ws] guacd target: ${GUACD_HOST}:${GUACD_PORT}`);
  console.log(`[rdp-ws] RDP target: ${RDP_HOST}:${RDP_PORT}`);
});
