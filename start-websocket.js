/**
 * Запуск WebSocket сервера для SlideMath
 * Використовує: node server/start-websocket.js
 */

require('dotenv').config();
const WebSocketServer = require('./websocket');

const PORT = process.env.WS_PORT || 8080;

console.log('='.repeat(60));
console.log('SlideMath WebSocket Server');
console.log('='.repeat(60));
console.log(`WebSocket Server running on port ${PORT}`);
console.log(`WebSocket path: /websocket`);
console.log('='.repeat(60));

// WebSocket server буде запущено в окремому процесі
// Для production використовуйте: pm2 start server/websocket.js --name "slidemath-ws"
// Для розробки: node server/websocket.js
