/**
 * Тестовий клієнт для WebSocket сервера
 * Запуск: node server/test-client.js <sessionId> <participantId> <participantName>
 */

const WebSocket = require('ws');

// Отримуємо аргументи командного рядка
const sessionId = process.argv[2] || 'test_session';
const participantId = process.argv[3] || 'test_user';
const participantName = process.argv[4] || 'Test User';

const wsUrl = 'ws://localhost:8080/websocket';

console.log('='.repeat(60));
console.log('WebSocket Client Test');
console.log('='.repeat(60));
console.log(`📍 Session ID: ${sessionId}`);
console.log(`👤 Participant ID: ${participantId}`);
console.log(`📛 Participant Name: ${participantName}`);
console.log('='.repeat(60));

let messageCount = 0;
let lastHeartbeat = null;
let lastPong = null;

const ws = new WebSocket(`${wsUrl}?id=${sessionId}`);

// З'єднання відкрилося
ws.on('open', () => {
  console.log('✅ WebSocket connected successfully!');
  console.log('');

  // Реєстрація учасника
  ws.send(JSON.stringify({
    type: 'registerParticipant',
    participantId: participantId,
    participantName: participantName
  }));
});

// Отримання повідомлень від сервера
ws.on('message', (data) => {
  try {
    const message = JSON.parse(data.toString());
    messageCount++;

    console.log(`📩 [${message.type}] (${messageCount})`);

    if (message.data) {
      if (message.data.timestamp) {
        console.log(`   Timestamp: ${new Date(message.data.timestamp).toISOString()}`);
      }

      if (message.data.participant) {
        console.log(`   Participant: ${message.data.participant.name} (${message.data.participant.id})`);
      }

      if (message.data.answer) {
        console.log(`   Answer: ${JSON.stringify(message.data.answer)}`);
      }

      if (message.data.violation) {
        console.log(`   Violation: ${message.data.violation.type} (count: ${message.data.violation.count})`);
      }
    }

    console.log('');
  } catch (e) {
    console.error('❌ Error parsing message:', e);
    console.log('Raw data:', data.toString());
    console.log('');
  }
});

// Помилки
ws.on('error', (error) => {
  console.error('❌ WebSocket error:', error.message);
});

// Закриття з'єднання
ws.on('close', (code, reason) => {
  console.log('='.repeat(60));
  console.log(`👋 Connection closed: ${code} - ${reason}`);
  console.log(`📊 Total messages received: ${messageCount}`);
  console.log('='.repeat(60));

  // Вихід з процесу
  process.exit(0);
});

// Таймери
let heartbeatTimer = setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'heartbeat' }));

    if (lastPong) {
      const diff = Date.now() - lastPong;
      console.log(`💓 Heartbeat received: ${diff}ms`);
    }

    lastPong = null;
  } else {
    clearInterval(heartbeatTimer);
  }
}, 30000); // Кожні 30 секунд

// Отримання PONG від сервера
ws.on('message', (data) => {
  try {
    const message = JSON.parse(data.toString());

    if (message.type === 'pong') {
      lastPong = Date.now();
    }
  } catch (e) {
    // Ignore parse errors
  }
});

// Синхронізація з'єднання
let connectionTimer = setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    console.log(`💓 Heartbeat sent (total: ${messageCount})`);

    // Відправити повідомлення
    ws.send(JSON.stringify({
      sessionId: sessionId,
      type: 'answer.submitted',
      data: {
        participantId: participantId,
        questionId: 'q_test_1',
        answer: { value: 'Option A' },
        isTeacher: false,
        timestamp: Date.now()
      }
    }));

    console.log('📤 Message sent: answer.submitted');
    console.log('');
  } else {
    clearInterval(connectionTimer);
    console.log('❌ WebSocket is not open, stopping...');
  }
}, 10000); // Кожні 10 секунд (протягом 60 секунд)

// Перервати через 60 секунд для тесту
setTimeout(() => {
  console.log('⏱️  Test duration exceeded, closing connection...');
  ws.close();
}, 60000);

// Ctrl+C
process.on('SIGINT', () => {
  console.log('\n👋 User requested shutdown...');

  clearInterval(heartbeatTimer);
  clearInterval(connectionTimer);

  ws.close();
});
