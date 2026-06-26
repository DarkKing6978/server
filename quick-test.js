/**
 * Швидке тестування WebSocket сервера
 */

const WebSocket = require('ws');
const http = require('http');

console.log('🧪 Starting quick WebSocket test...\n');

// 1. Перевірити, чи запущено сервер
const httpServer = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
});

httpServer.listen(8080, () => {
  console.log('✓ HTTP server is running on port 8080');

  // 2. Спробувати підключитися до WebSocket
  const ws = new WebSocket('ws://localhost:8080/websocket?id=test_session');

  ws.on('open', () => {
    console.log('✓ WebSocket connection established!');

    // Реєстрація учасника
    ws.send(JSON.stringify({
      type: 'registerParticipant',
      participantId: 'test_user',
      participantName: 'Test User'
    }));

    // Відправити повідомлення
    ws.send(JSON.stringify({
      sessionId: 'test_session',
      type: 'answer.submitted',
      data: {
        participantId: 'test_user',
        questionId: 'q_1',
        answer: { value: 'Option A' },
        isTeacher: false,
        timestamp: Date.now()
      }
    }));

    // Закрити через 3 секунди
    setTimeout(() => {
      console.log('⏱️  Test completed, closing connection...');
      ws.close();
    }, 3000);
  });

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    console.log(`📩 Message received: ${message.type}`);

    if (message.type === 'pong') {
      console.log(`💓 Heartbeat received: ${message.data?.timestamp}`);
    }
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
    httpServer.close();
    process.exit(1);
  });

  ws.on('close', (code, reason) => {
    console.log(`👋 Connection closed (${code}): ${reason}`);
    console.log('\n✅ All tests completed successfully!');
    httpServer.close();
    process.exit(0);
  });
});

httpServer.on('error', (error) => {
  console.error('❌ HTTP server error:', error.message);
  console.log('\n💡 Make sure WebSocket server is running: node websocket.js');
  process.exit(1);
});
