import Redis from 'ioredis';

let _client = null;

export function getRedis() {
  if (!_client) {
    const url = process.env.REDIS_URL || 'redis://marketing-agency-redis:6379';
    _client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });
    _client.on('error', (err) => {
      // Не ломаем процесс — Redis опционален пока нет Agent 2
      process.stderr.write(`[Redis] ${err.message}\n`);
    });
  }
  return _client;
}

export async function redisConnect() {
  try {
    await getRedis().connect();
    process.stdout.write('[Redis] Connected to marketing-agency-redis\n');
  } catch (err) {
    process.stderr.write(`[Redis] Connection failed (non-fatal): ${err.message}\n`);
  }
}
