# Створення окремого WebSocket хостингу

Цей гайд пояснює, як запустити WebSocket сервер на окремому хостингу.

---

## 🎯 Чому це круто?

✅ **Залежності від основного сайту:**
- Ні!

✅ **Масштабування:**
- Можна масштабувати WebSocket незалежно від PHP

✅ **Безпека:**
- WebSocket на окремому домені

✅ **Моніторинг:**
- Окремі логи для WebSocket

✅ **Deploys:**
- Окремий деплой без ризику для основного сайту

---

## 📋 Загальний процес

### 1. Вибір хостингу для WebSocket

**Найкращі варіанти:**

| Хостинг | Ціна | Ping до України | Простота |
|---------|------|-----------------|----------|
| **Heroku** | $5-7/міс | 20-40 мс | ⭐⭐⭐⭐⭐ |
| **Render** | $5/міс | 40-60 мс | ⭐⭐⭐⭐⭐ |
| **Railway** | $5/міс | 30-50 мс | ⭐⭐⭐⭐ |
| **DigitalOcean** | $5/міс | 5-10 мс | ⭐⭐⭐⭐ |
| **AWS** | $5-10/міс | 5-10 мс | ⭐⭐⭐ |
| **VPS (Own)** | Безкоштовно (VPS) | 5-10 мс | ⭐⭐ |

---

## 🚀 Приклад: Запуск на Heroku (найпростіший)

### Крок 1: Створи проєкт для WebSocket

```bash
cd /path/to/slidemath
mkdir slidemath-ws
cd slidemath-ws

# Скопіюємо тільки WebSocket файли
cp ../websocket.js .
cp ../package.json .
cp ../start-websocket.js .
```

### Крок 2: Зміни порт у `websocket.js`

```javascript
// websocket.js
const http = require('http');

// Розділений порт для WebSocket
const WS_PORT = process.env.WS_PORT || 8080;
const HTTP_PORT = process.env.HTTP_PORT || 5000;

// HTTP server для health check
const httpServer = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
});

// WebSocket server
const wss = new WebSocket.Server({
  server: httpServer,
  path: '/websocket'
});

// Запуск обох серверів
httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP server running on port ${HTTP_PORT}`);
  console.log(`WebSocket server running on ws://localhost:${WS_PORT}/websocket`);
});

wss.on('connection', (ws, req) => {
  // ... ваша логіка WebSocket ...
});
```

### Крок 3: Зміни `package.json`

```json
{
  "name": "slidemath-ws",
  "version": "1.0.0",
  "main": "websocket.js",
  "scripts": {
    "start": "node websocket.js",
    "dev": "node websocket.js"
  },
  "dependencies": {
    "ws": "^8.16.0",
    "dotenv": "^16.3.1"
  }
}
```

### Крок 4: Деплой на Heroku

```bash
# 1. Ініціалізуй Git
git init
git add .
git commit -m "WebSocket server"

# 2. Створи Heroku app
heroku create slidemath-ws

# 3. Налаштуй будівельник
heroku buildpacks:set https://github.com/heroku/heroku-buildpack-nodejs

# 4. Встанови змінні середовища
heroku config:set WS_PORT=8080
heroku config:set HTTP_PORT=5000
heroku config:set NODE_ENV=production

# 5. Масштабуй робітника
heroku ps:scale worker=1

# 6. Перевір статус
heroku ps
heroku logs --tail
```

### Крок 5: Додай до основного сайту

У `assets/js/store.js`:
```javascript
const wsUrl = `wss://${location.host}/websocket`;
```

---

## 🌐 Приклад: Запуск на DigitalOcean (кращий ping)

### Крок 1: Створи Droplet

1. Login до https://cloud.digitalocean.com
2. Create → Droplet
3. Select OS: Ubuntu 22.04
4. Select Region: Amsterdam (Amsterdam, Netherlands) - найкращий ping до України
5. Size: 1GB RAM
6. Select Authentication: SSH key

### Крок 2: Підключись до сервера

```bash
ssh root@your_droplet_ip
```

### Крок 3: Встанови Node.js

```bash
# Онови системи
apt update && apt upgrade -y

# Встанови Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs

# Перевір
node --version  # 18.x
npm --version   # 9.x
```

### Крок 4: Налаштуй проєкт

```bash
# Створи папку
mkdir /var/www/slidemath-ws
cd /var/www/slidemath-ws

# Скопію файли (через rsync або scp)
# ...

# Встанови залежності
npm install

# Створи systemd service
nano /etc/systemd/system/slidemath-ws.service
```

### Крок 5: Створи systemd service

```ini
[Unit]
Description=Slidemath WebSocket Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/slidemath-ws
ExecStart=/usr/bin/node websocket.js
Restart=always
Environment=NODE_ENV=production
Environment=WS_PORT=8080
Environment=HTTP_PORT=5000

[Install]
WantedBy=multi-user.target
```

### Крок 6: Запусти сервер

```bash
# Перезавантаж systemd
systemctl daemon-reload

# Запусти
systemctl start slidemath-ws

# Додай до автозавантаження
systemctl enable slidemath-ws

# Перевір статус
systemctl status slidemath-ws

# Дивись логи
journalctl -u slidemath-ws -f
```

---

## 🚀 Приклад: Запуск на Render (найпростіший)

### Крок 1: Відкрий https://dashboard.render.com

### Крок 2: Створи новий Web Service

### Крок 3: Налаштування:

```
Name: slidemath-ws
Region: Frankfurt (там найкращий ping до України)
Runtime: Node
Build Command: npm install
Start Command: node websocket.js

Environment Variables:
- NODE_ENV: production
- WS_PORT: 8080
- HTTP_PORT: 5000
```

### Крок 4: Deploy

1. Repository → GitHub (з'єднай з проєктом)
2. Connect GitHub Repository
3. Click "Create Web Service"

### Крок 5: Налаштуй SSL

Render надає SSL безкоштовно на вашому домені.

### Крок 6: Отримай URL

WebSocket URL: `https://slidemath-ws.onrender.com/websocket`

---

## 🔧 Архітектура розділеного деплою

### Випадок 1: Окремі домени

```
Основний сайт:          https://slidemath.com
WebSocket сервер:       https://slidemath-ws.com

Віддалений доступ через CDN або CNAME
```

### Випадок 2: Один хостинг, різні порти

```
Основний сайт:          https://slidemath.com (80/443)
WebSocket сервер:       https://slidemath.com:8080
```

### Випадок 3: Один хостинг, окремий процес

```
Основний сайт (PHP):    Process ID 1234
WebSocket сервер (Node): Process ID 5678
```

---

## 🌐 Налаштування DNS для окремого домену

### Приклад: slidemath-ws.com

```bash
# В DigitalOcean DNS:
A    @        your_droplet_ip

# В Heroku / Render DNS:
CNAME    @    hidzhemath-ws.herokudns.com

# В Cloudflare:
A    ws        your_server_ip
```

---

## 📊 Розділені конфігурації

### .env (на WebSocket хостингу)

```env
NODE_ENV=production
WS_PORT=8080
HTTP_PORT=5000
JWT_SECRET=your_secret_key
DATABASE_URL=postgresql://user:pass@db-host:5432/slidemath
REDIS_URL=redis://redis-host:6379
```

### config.php (на основному сайті)

```php
<?php
$websocketConfig = [
    'enabled' => true,
    'url' => 'https://slidemath-ws.yourdomain.com/websocket',
    'api_key' => 'your_api_key_here'
];
?>
```

---

## 🔐 Безпека для окремого хостингу

### 1. Віддалений API access

```javascript
// В WebSocket сервері
const apiKeys = new Set(['your_secret_api_key_1', 'your_secret_api_key_2']);

function authenticateAPIKey(apiKey) {
  return apiKeys.has(apiKey);
}

// У PHP API
$apiKey = $_SERVER['HTTP_X_API_KEY'] ?? '';
if (!authenticateAPIKey($apiKey)) {
  http_response_code(403);
  echo json_encode(['error' => 'Invalid API key']);
  exit;
}
```

### 2. Rate limiting

```javascript
// У WebSocket сервері
const rateLimits = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const lastRequest = rateLimits.get(ip) || 0;

  if (now - lastRequest < 1000) {  // 1 запит на секунду
    return false;
  }

  rateLimits.set(ip, now);
  return true;
}
```

### 3. WebSocket authentication

```javascript
// При підключенні
ws.on('open', () => {
  // Приймаємо токен від клієнта
  const token = ws.token; // передається при підключенні

  if (!validateToken(token)) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  // Реєстрація учасника
  registerParticipant(sessionId, participantId, token);
});
```

---

## 📈 Моніторинг окремого хостингу

### Heroku:

```bash
# Статус
heroku ps

# Логи
heroku logs --tail --app slidemath-ws

# Моніторинг
heroku addons:info
```

### DigitalOcean:

```bash
# Логи
journalctl -u slidemath-ws -f

# Моніторинг
htop
netstat -tulpn | grep 8080
```

### Render:

```bash
# Логи (в Dashboard)
https://dashboard.render.com/logs

# Monitor
https://dashboard.render.com/monitor
```

---

## 🔄 Синхронізація подій

### Приклад: Як основний сайт надсилає подію

**У PHP API (`api/answers.php`):**

```php
<?php
// Після збереження відповіді
$result = rel_upsert_answer($participantId, $questionId, $value, $meta);

if ($result['ok']) {
    // Надсилаємо подію через HTTP POST до WebSocket сервера
    $wsHost = getenv('WEBSOCKET_HOST') ?: 'https://slidemath-ws.yourdomain.com';
    $wsPath = '/broadcast';

    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $wsHost . $wsPath);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
        'session_id' => $sessionId,
        'event_type' => 'answer.submitted',
        'data' => [
            'participantId' => $participantId,
            'questionId' => $questionId,
            'answer' => $value,
            'isTeacher' => false,
            'timestamp' => time()
        ]
    ]));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Content-Type: application/json',
        'X-API-Key: your_api_key'  // БЕЗПЕКА!
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);

    curl_close($ch);

    if ($error || $httpCode !== 200) {
        error_log("[WebSocket] Failed to broadcast: $error (HTTP $httpCode)");
    }

    echo json_encode(['ok' => true, 'ws_response' => $response]);
} else {
    sendAnsError($result['error'], 500);
}
?>
```

---

## ✅ Перевірка роботи

### 1. Тестування клієнтом

```bash
cd /var/www/slidemath-ws

# Запусти клієнт
node test-client.js YOUR_SESSION_ID YOUR_PARTICIPANT_ID "Your Name"
```

### 2. Тестування віддаленого доступу

```bash
# З твоїх ліпшів:
curl http://your-heroku-app.com/
# Очікується: "OK"

# Тестування WebSocket:
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('wss://slidemath-ws.yourdomain.com/websocket?id=test');
ws.on('open', () => {
  console.log('✅ Connected!');
  ws.send(JSON.stringify({type: 'registerParticipant', participantId: 'test', participantName: 'Test'}));
});
ws.on('message', (d) => console.log('📩', JSON.parse(d)));
"
```

### 3. Перевірка ping

```bash
# Заміни на реальний URL
ping slidemath-ws.yourdomain.com

# Очікується: ~20-60 мс для Heroku/Render
# Очікується: ~5-15 мс для DigitalOcean/EU
```

---

## 🎯 Рекомендовані конфігурації

### Для малого проєкту (до 50 учнів):

| Хостинг | Розмір | Ціна | Ping |
|---------|--------|------|------|
| Render | Free | $0 | 40-60 мс |
| Railway | Free | $0 | 30-50 мс |

### Для середнього проєкту (50-500 учнів):

| Хостинг | Розмір | Ціна | Ping |
|---------|--------|------|------|
| Heroku | Hobby | $5 | 20-40 мс |
| DigitalOcean | 1GB RAM | $5 | 5-10 мс |
| Render | Standard | $7 | 40-60 мс |

### Для великого проєкту (500+ учнів):

| Хостинг | Розмір | Ціна | Ping |
|---------|--------|------|------|
| DigitalOcean | 2GB RAM | $10 | 5-10 мс |
| AWS t3.medium | 2GB RAM | $20 | 5-10 мс |

---

## 📞 Підтримка

Якщо виникли проблеми:
1. Перевір логи WebSocket сервера
2. Перевір firewall та ports
3. Перевір DNS налаштування
4. Перевір SSL certificates

---

**Статус:** ✅ Готово для окремого хостингу

**Версія:** 1.0
**Останнє оновлення:** 2026-06-25
