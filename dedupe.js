// ==========================
// Deduplicación persistente de mensajes WhatsApp en Redis
// ==========================
import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const TTL = parseInt(process.env.BAILEYS_MESSAGE_DEDUPE_TTL_SECONDS || '2592000', 10); // 30 días

let _redis = null;

function getRedis() {
  if (!_redis) {
    _redis = new Redis(REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
    });
    _redis.on('error', (err) => {
      console.error('[BAILEYS] redis_error', err.message);
    });
    _redis.on('connect', () => {
      console.log(`[BAILEYS] redis_connected url=${REDIS_URL}`);
    });
  }
  return _redis;
}

/**
 * Construye la clave de deduplicación para un mensaje entrante de WhatsApp.
 *
 * Formato: wa:processed:{remoteJid}:{messageId}:{participant}
 *
 * - remoteJid: número/chat de origen
 * - messageId: ID único asignado por WhatsApp al mensaje
 * - participant: para grupos (vacío en DMs)
 */
export function buildMessageDedupeKey(msg) {
  const jid         = msg.key?.remoteJid  || 'unknown';
  const id          = msg.key?.id         || 'unknown';
  const participant = msg.key?.participant || '';
  return `wa:processed:${jid}:${id}:${participant}`;
}

/**
 * Verifica si un mensaje ya fue procesado.
 *
 * Fail-open: si Redis no está disponible, retorna false para no bloquear el flujo.
 */
export async function wasMessageProcessed(key) {
  try {
    const val = await getRedis().get(key);
    return val !== null;
  } catch (err) {
    console.warn(`[BAILEYS] dedupe_check_failed key=${key} err=${err.message}`);
    return false;
  }
}

/**
 * Marca un mensaje como procesado en Redis con TTL configurable.
 * BAILEYS_MESSAGE_DEDUPE_TTL_SECONDS (default 2592000 = 30 días).
 */
export async function markMessageProcessed(key) {
  try {
    await getRedis().set(key, '1', 'EX', TTL);
    console.log(`[BAILEYS] message_marked_processed key=${key} ttl=${TTL}s`);
  } catch (err) {
    console.warn(`[BAILEYS] dedupe_mark_failed key=${key} err=${err.message}`);
  }
}

export async function disconnectRedis() {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
