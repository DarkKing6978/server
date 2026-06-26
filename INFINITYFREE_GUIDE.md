# WebSocket Server на Платному Хостингу

## 🎯 Для чого це?

WebSocket сервер дозволяє реалтайм-оновлення для тестування з затримкою ≤ 500 мс замість 3-5 сек polling-а.

---

## 🚀 Як запустити на платному хостингу

### Вибір хостингу

**Підходять:** Heroku, AWS, DigitalOcean, AWS Elastic Beanstalk, Render, Railway, VPS з Node.js

**Не підходять:** InfinityFree (shared hosting з обмеженнями)

---

## 📋 Загальний процес

### 1. Встановлення Node.js (на хостингу)

```bash
# На Linux/Unix хостингу
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Перевірка версії
node --version  # 18.x+
npm --version   # 9.x+
```

### 2. Налаштування проєкту

```bash
cd /path/to/your/project
npm install
```

### 3. Запуск WebSocket сервера

#### Для development:
```bash
node websocket.js
```

#### Для production:
```bash
NODE_ENV=production node websocket.js
```

---

## 🌐 Специфічні хостинги

### Heroku

```bash
# 1. Встанови Heroku CLI
# 2. Логін
heroku login

# 3. Створи новий додаток
heroku create slidemath-ws

# 4. Встанови будівельник
heroku buildpacks:set https://github.com/heroku/heroku-buildpack-nodejs

# 5. Зміни порт для розділення
# В websocket.js додай:
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`WebSocket Server running on ws://localhost:${PORT}`);
});

# 6. Запуш проєкт
git add .
git commit -m "Add WebSocket server"
git push heroku main

# 7. Перевір статус
heroku ps:scale worker=1
heroku logs --tail
```

#### Ключі конфігурації (heroku.yml):
```yaml
build:
  docker:
    web: Dockerfile

run:
  worker: node websocket.js
```

---

### AWS Elastic Beanstalk

```bash
# 1. Встанови AWS CLI
pip install awscli

# 2. Налаштуй AWS
aws configure

# 3. Створи змінні середовища
EB_ENVIRONMENT="production"
WS_PORT="8080"

# 4. Деплой
eb deploy
```

---

### DigitalOcean

```bash
# 1. Створи Droplet з Ubuntu 22.04 + Node.js

# 2. Підключись:
ssh root@your_ip

# 3. Встанови Node.js (як у загальному процесі)

# 4. Скопію проєкт через rsync
rsync -avz --exclude node_modules /local/path/ user@your_ip:/path/to/project/

# 5. Запусти
cd /path/to/project
npm install
pm2 start websocket.js --name "slidemath-ws"
pm2 save
pm2 startup
```

---

### Render

```bash
# 1. Відкрий https://dashboard.render.com

# 2. Створи новий Web Service

# 3. Налаштування:
- Name: slidemath-ws
- Region: Frankfurt (там найкращий ping для України)
- Runtime: Node
- Build Command: npm install
- Start Command: node websocket.js

# 4. Налаштуй порт:
# У websocket.js:
const PORT = process.env.PORT || 8080;

# 5. Deploy
```

---

### Railway

```bash
# 1. Відкрий railway.app
# 2. Новий проєкт
# 3. Repository: з'єднай з GitHub

# 4. Налаштування:
- Build Command: npm install
- Start Command: node websocket.js
- Environment Variables:
  - PORT: 8080
  - NODE_ENV: production

# 5. Deploy
```

---

## 🔧 Ключові налаштування для всіх хостингів

### 1. Порт

У `websocket.js`:
```javascript
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`WebSocket Server running on ws://localhost:${PORT}`);
});
```

### 2. Налаштування Nginx (як є reverse proxy)

```nginx
location /websocket {
    proxy_pass http://localhost:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Таймаути
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 300s;
}
```

### 3. SSL/TLS (WSS)

Для HTTPS потрібно додати SSL:
- **Let's Encrypt** (вільно)
- **Cloudflare SSL** (вільно)
- **AWS Certificate Manager** (вільно)

### 4. Firewall

Увімкни порт 8080 у firewall:
```bash
# UFW
sudo ufw allow 8080/tcp

# FirewallD
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --reload
```

---

## 📊 Моніторинг

### PM2 (для VPS)
```bash
pm2 list
pm2 logs slidemath-ws
pm2 monit
pm2 restart slidemath-ws
```

### New Relic / Datadog
Для production-моніторингу.

---

## 🔐 Безпека

1. **Authentication**
   - Додати JWT токени
   - Відправляти з кодом сесії

2. **Rate Limiting**
   - Встанови обмеження на з'єднання
   - Blocking bad actors

3. **HTTPS/WSS**
   - Завжди використовувати HTTPS
   - Не використовувати WebSocket на 80 порту

---

## 🐛 Troubleshooting

### Проблема: "EADDRINUSE: address already in use"

```bash
# Знайти процес на порті 8080
lsof -i :8080
netstat -tulpn | grep 8080

# Закрити процес
kill -9 PID
```

### Проблема: "Cannot connect to WebSocket"

```bash
# Перевір logs
tail -f logs/slidemath-ws.log

# Перевір firewall
telnet localhost 8080

# Перевір порт у .env
echo $PORT
```

### Проблема: CORS errors

Переконайся, що сервер обробляє CORS правильно.

---

## ✅ Перевірка роботи

### 1. Тестування клієнтом

```bash
node server/test-client.js SESSION_ID PARTICIPANT_ID PARTICIPANT_NAME
```

### 2. Тестування швидкості

```bash
ab -n 1000 -c 10 ws://your-domain.com/websocket?id=test
```

### 3. Моніторинг latency

```bash
# В браузері:
const ws = new WebSocket('ws://your-domain.com/websocket?id=test');
ws.onopen = () => console.log('Connected');
ws.onmessage = (e) => console.log(Date.now() - startTime);
```

---

## 📈 Продуктивність

### Оптимізації:

1. **CDN для статичних файлів**
   - Cloudflare Pages
   - AWS CloudFront

2. **负载均衡** (Load Balancing)
   - Nginx
   - HAProxy

3. **Кешування**
   - Redis
   - Memcached

---

## 🎯 Схема архітектури (Production)

```
┌─────────────────┐
│   Browser       │
│ (Student)       │
└────────┬────────┘
         │ WebSocket (WSS)
         │ SSL
         ↓
┌─────────────────┐
│  Nginx          │ ← Reverse Proxy
│  (Load Balancer)│
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│  WebSocket      │ ← Node.js
│  Server         │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│  Redis          │
│  (Cache)        │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│  PHP Backend    │
│  (Slidemath)    │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│  PostgreSQL     │
│  Database       │
└─────────────────┘
```

---

## 📞 Підтримка

Якщо виникли проблеми:
1. Перевір logs сервера
2. Перевір конфігурацію Nginx
3. Перевір SSL certificates
4. Перевір firewall

---

**Статус:** ✅ Готовий до production deployment

**Версія:** 1.0
**Останнє оновлення:** 2026-06-25
