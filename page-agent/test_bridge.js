// Test Page Agent MCP dependencies from correct working directory
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebSocketServer } from 'ws';
import * as z from 'zod/v4';
console.log('All deps resolved OK');

// Quick port availability check
import http from 'node:http';
const port = 38401;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, port }));
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('Port', port, 'already in use — bridge may be running already');
    process.exit(0);
  }
  console.error('Error:', e.message);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  console.log('Port', port, 'available — bridge can start');
  server.close();
  process.exit(0);
});
