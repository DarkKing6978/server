# WebSocket Server для SlideMath

Цей сервер забезпечує реалтайм-оновлення для тестування через WebSocket протокол.

## 🚀 Швидкий старт

### Встановлення залежностей

```bash
npm install
```

### Запуск сервера

```bash
node websocket.js
```

**За замовчуванням сервер працює на порту 8080**

---

## 📁 Структура файлів

- **websocket.js** - Основний WebSocket сервер
- **start-websocket.js** - Скрипт запуску
- **package.json** - Залежності та скрипти
- **websocket-bridge.php** - HTTP endpoint для broadcast подій

---

## 🌐 WebSocket endpoint

### Підключення

```javascript
const ws = new WebSocket('ws://localhost:8080/websocket?id=SESSION_ID');
```

### URL параметри

| Параметр | Опис | Обов'язковий |
|----------|------|-------------|
| `id` | ID сесії | Так |

### Події від клієнта

| Event Type | Параметри | Опис |
|------------|-----------|------|
| `heartbeat` | - | Підтримка з'єднання (кожні 30 сек) |
| `registerParticipant` | participantId, participantName | Реєстрація учасника |

### Події від сервера

| Event Type | Параметри | Опис |
|------------|-----------|------|
| `connected` | sessionId | Підтвердження підключення |
| `pong` | timestamp | Відповідь на heartbeat |

---

## 🎯 Broadcast події

### У JavaScript (client-side)

```javascript
// Тут ви можете використовувати бібліотеку для broadcast
const message = JSON.stringify({
  sessionId: 'SESSION_ID',
  type: 'answer.submitted',
  data: {
    participantId: 'p_123',
    questionId: 'q_456',
    answer: { value: 'Option A' },
    isTeacher: false,
    timestamp: Date.now()
  }
});

ws.send(message);
```

### У PHP (backend)

Використовуйте `websocket-bridge.php`:
```php
$data = [
  'session_id' => 'SESSION_ID',
  'event_type' => 'answer.submitted',
  'data' => [...]
];
// Виклик websocket-bridge.php через HTTP
```

---

## 📊 Події сервера

### participant.joined
Відправляється новому учаснику після реєстрації

```json
{
  "sessionId": "SESSION_ID",
  "type": "participant.joined",
  "data": {
    "participant": {
      "id": "p_123",
      "name": "Іван Петренко",
      "joinedAt": 1719350000000
    }
  },
  "timestamp": 1719350000000
}
```

### answer.submitted
Надана відповідь від учня або вчителя

```json
{
  "sessionId": "SESSION_ID",
  "type": "answer.submitted",
  "data": {
    "participantId": "p_123",
    "questionId": "q_456",
    "answer": { "value": "Option A" },
    "isTeacher": false,
    "timestamp": 1719350000000
  },
  "timestamp": 1719350000000
}
```

### session.ended
Сесія завершена

```json
{
  "sessionId": "SESSION_ID",
  "type": "session.ended",
  "data": {
    "endedBy": "student",
    "endedAt": 1719350000000
  },
  "timestamp": 1719350000000
}
```

### integrity.violation
Порушення цілісності

```json
{
  "sessionId": "SESSION_ID",
  "type": "integrity.violation",
  "data": {
    "violation": {
      "type": "tabSwitch",
      "count": 3
    },
    "timestamp": 1719350000000
  },
  "timestamp": 1719350000000
}
```

### extraTimeSignal
Доданий час

```json
{
  "sessionId": "SESSION_ID",
  "type": "extraTimeSignal",
  "data": {
    "participantId": "p_123",
    "data": {
      "total": 300,
      "unlockAll": false
    },
    "timestamp": 1719350000000
  },
  "timestamp": 1719350000000
}
```

### questionUnlocked
Розблокування питання

```json
{
  "sessionId": "SESSION_ID",
  "type": "questionUnlocked",
  "data": {
    "participantId": "p_123",
    "questionId": "q_456",
    "data": {
      "timeAdded": 120
    },
    "timestamp": 1719350000000
  },
  "timestamp": 1719350000000
}
```

### dashboard.update
Оновлення live dashboard

```json
{
  "sessionId": "SESSION_ID",
  "type": "dashboard.update",
  "data": { ... },
  "timestamp": 1719350000000
}
```

---

## 🧪 Тестування

### Просте тестування клієнтом

```javascript
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:8080/websocket?id=test_session');

ws.on('open', () => {
  console.log('Connected!');

  // Реєстрація учасника
  ws.send(JSON.stringify({
    type: 'registerParticipant',
    participantId: 'test_user_1',
    participantName: 'Test User 1'
  }));

  // Симуляція отримання події
  setTimeout(() => {
    ws.send(JSON.stringify({
      sessionId: 'test_session',
      type: 'answer.submitted',
      data: {
        participantId: 'test_user_1',
        questionId: 'q_1',
        answer: { value: 'Option A' },
        isTeacher: false,
        timestamp: Date.now()
      }
    }));
  }, 2000);
});

ws.on('message', (data) => {
  console.log('Received:', data.toString());
});

ws.on('close', (code, reason) => {
  console.log(`Disconnected: ${code} - ${reason}`);
});
```

### Тестування сервера

```bash
# У одному терміналі - запуск сервера
node websocket.js

# У іншому - запуск клієнта
node -e "$(cat <<'EOF'
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8080/websocket?id=test');

ws.on('open', () => {
  console.log('✓ Connected!');
  ws.send(JSON.stringify({
    type: 'registerParticipant',
    participantId: 'test_user',
    participantName: 'Test User'
  }));
});

ws.on('message', (data) => {
  console.log('📩 Received:', data.toString());
});

ws.on('close', (code, reason) => {
  console.log('✗ Disconnected:', code, reason);
});
EOF
)"
```

### Тестування через Node.js скрипт

Створіть файл `server/test-client.js`:

```javascript
const WebSocket = require('ws');

const sessionId = process.argv[2] || 'test_session';
const participantId = process.argv[3] || 'test_user';
const participantName = process.argv[4] || 'Test User';

const ws = new WebSocket(`ws://localhost:8080/websocket?id=${sessionId}`);

ws.on('open', () => {
  console.log('✓ Connected!');
  console.log('📝 Registering participant:', participantId);

  ws.send(JSON.stringify({
    type: 'registerParticipant',
    participantId,
    participantName
  }));
});

ws.on('message', (data) => {
  const message = JSON.parse(data.toString());
  console.log(`📩 [${message.type}]`, JSON.stringify(message.data));
});

ws.on('close', (code, reason) => {
  console.log(`✗ Disconnected (${code}): ${reason}`);
});

process.on('SIGINT', () => {
  console.log('\n👋 Closing connection...');
  ws.close();
});
```

Запуск:
```bash
node server/test-client.js SESSION_ID PARTICIPANT_ID PARTICIPANT_NAME
```

---

## 🛠️ Розгортання

### Development

```bash
node websocket.js
```

### Production (PM2)

```bash
pm2 start websocket.js --name "slidemath-ws"
pm2 logs slidemath-ws
pm2 restart slidemath-ws
pm2 stop slidemath-ws
```

### Docker

Створіть файл `Dockerfile`:

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY websocket.js .

EXPOSE 8080

CMD ["node", "websocket.js"]
```

Запуск:
```bash
docker build -t slidemath-ws .
docker run -p 8080:8080 slidemath-ws
```

---

## 📊 Моніторинг

### Статистика

WebSocket сервер автоматично логує:
- Кількість активних сесій
- Загальну кількість з'єднань
- Кількість broadcast подій

### Різницевий лог

Якщо вам потрібно розблокувати HTTP proxy для WebSockets:

**Nginx:**
```nginx
location /websocket {
    proxy_pass http://localhost:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Host $host;
}
```

---

## 🐛 Debug

### Логування на сервері

```javascript
// У websocket.js
console.log('[WebSocket] New connection:', sessionId);
console.log('[WebSocket] Broadcast event:', eventType);
```

### Логування на клієнті

```javascript
// У store.js
console.log('[Store] Connecting to WebSocket:', wsUrl);
console.log('[Store] WebSocket message:', message);
```

### Проверка з'єднання

```javascript
// Перевірка стану з'єднання
if (ws.readyState === WebSocket.OPEN) {
  console.log('✓ WebSocket is open');
} else if (ws.readyState === WebSocket.CONNECTING) {
  console.log('⏳ WebSocket is connecting...');
} else {
  console.log('✗ WebSocket is closed');
}
```

---

## 📈 Важливі порти

- **WebSocket Server:** 8080 (змінюється через `WS_PORT`)
- **HTTP Server:** PHP default (80 або 443)

---

## 📞 Підтримка

- Документація: `docs/WEBSOCKET_INTEGRATION.md`
- GitHub Issues: [Створити issue](https://github.com/your-repo/issues)

---

**Статус:** Active Development
**Версія:** 1.0
**Автор:** SlideMath Team
