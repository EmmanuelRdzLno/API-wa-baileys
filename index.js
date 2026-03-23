// ==========================
// Forzar IPv4
// ==========================
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from '@whiskeysockets/baileys';

import qrcodeTerminal from 'qrcode-terminal';
import qrcode from 'qrcode';
import fs from 'fs';
import P from 'pino';

import express from 'express';
import expressWs from 'express-ws';
import basicAuth from 'basic-auth';
import path from 'path';
import axios from 'axios';

import { fileURLToPath } from 'url';

// Ajuste para __dirname en ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Si tu mailer.js es CommonJS, aquí lo importamos dinámico para no romper
let enviarAlerta = async () => {};
try {
  const mailer = await import('./mailer.js');
  enviarAlerta = mailer.enviarAlerta || enviarAlerta;
} catch {}

// ==========================
// Estado
// ==========================
let wasEverConnected = false;
let currentQR = null;
let reconexionIntentos = 0;
const MAX_REINTENTOS = 5;
const RETRY_DELAY_MS = 5000;
const ALERTA_ENVIADA = { estado: false };
let isConnected = false;

let lastMessages = [];
let sock;

const app = express();
const wsInstance = expressWs(app);
const wss = wsInstance.getWss();

const WEB_PORT = process.env.WEB_PORT || 3000;
const WEB_HOST = process.env.WEB_HOST || 'localhost';
const ORQUESTADOR_HTTP = process.env.ORQUESTADOR_HTTP || 'http://localhost:4000';

// ==========================
// Helpers
// ==========================
function resetAuthState(reason = 'loggedOut') {
  console.log(`🧹 Reseteando auth por: ${reason}`);
  try {
    fs.rmSync('auth', { recursive: true, force: true });
  } catch (e) {
    console.warn('⚠️ No se pudo borrar auth:', e?.message || e);
  }

  // resetea estado para que el Web UI muestre QR
  currentQR = null;
  wasEverConnected = false;
  isConnected = false;

  // si quieres que SIEMPRE reintente después de logout
  reconexionIntentos = 0;
}

function normalizeJid(jid) {
  if (!jid) return null;
  return jid.split(':')[0];
}

function extractPhone(jid) {
  if (!jid) return null;
  if (jid.endsWith('@s.whatsapp.net')) return jid.replace('@s.whatsapp.net', '');
  return null;
}

function unwrapMessage(message) {
  if (!message) return null;
  if (message.ephemeralMessage?.message) return message.ephemeralMessage.message;
  if (message.viewOnceMessage?.message) return message.viewOnceMessage.message;
  if (message.viewOnceMessageV2?.message) return message.viewOnceMessageV2.message;
  return message;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout (${ms}ms) en ${label}`)), ms)
    ),
  ]);
}

async function retry(fn, retries = 1, label = 'retry') {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.warn(`⚠️ ${label} intento ${i + 1}/${retries + 1} falló:`, e?.message || e);
    }
  }
  throw lastErr;
}

function oeHexToDate(oeHex) {
  const seconds = parseInt(oeHex, 16);
  if (Number.isNaN(seconds)) return null;
  return new Date(seconds * 1000);
}

function isUrlExpired(url) {
  try {
    const u = new URL(url);
    const oe = u.searchParams.get('oe');
    if (!oe) return false;
    const d = oeHexToDate(oe);
    if (!d) return false;
    return d.getTime() < Date.now();
  } catch {
    return false;
  }
}

// ==========================
// Basic Auth
// ==========================
const auth = (req, res, next) => {
  const user = basicAuth(req);
  const validUser = process.env.WEB_USER || 'admin';
  const validPass = process.env.WEB_PASS || 'admin123';

  if (!user || user.name !== validUser || user.pass !== validPass) {
    res.set('WWW-Authenticate', 'Basic realm="WhatsAppBot"');
    return res.status(401).send('Authentication required.');
  }
  next();
};

// ==========================
// Web UI
// ==========================
app.use('/web', auth, express.static(path.join(__dirname, 'web')));

app.get('/api/status', auth, (req, res) => {
  res.json({ connected: isConnected });
});

app.get('/api/messages', auth, (req, res) => {
  res.json(lastMessages.slice(-20));
});

app.ws('/ws/status', function (ws) {
  ws.send(JSON.stringify({ connected: isConnected }));
});

app.get('/api/qr', (req, res) => {
  if (currentQR) res.json({ qr: currentQR });
  else res.status(404).send('No QR disponible');
});

// ==========================
// Botones
// ==========================
app.post('/api/botones', express.json({ limit: '1mb' }), async (req, res) => {
  const to = req.headers['x-to'];
  const { text, buttons } = req.body || {};

  if (!to || !text || !Array.isArray(buttons) || buttons.length === 0) {
    return res.status(400).json({ error: 'Faltan parámetros: to, text, buttons[]' });
  }

  try {
    const mapped = buttons.map(b => ({
      buttonId: b.id,
      buttonText: { displayText: b.text },
      type: 1
    }));

    await sock.sendMessage(to, { text, buttons: mapped, headerType: 1 });
    res.sendStatus(200);
  } catch (e) {
    console.error('Error enviando botones:', e.message);
    res.sendStatus(500);
  }
});

// ==========================
// Orquestador -> WhatsApp
// ==========================
app.post('/api/respuesta', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const tipo = req.headers['content-type'];
  const to = req.headers['x-to'];
  const filename = req.headers['x-filename'] || 'archivo';

  try {
    if (tipo?.startsWith('text/')) {
      await sock.sendMessage(to, { text: req.body.toString() });
    } else if (tipo?.startsWith('image/')) {
      await sock.sendMessage(to, { image: req.body, mimetype: tipo, caption: 'Procesado' });
    } else {
      await sock.sendMessage(to, { document: req.body, mimetype: tipo || 'application/octet-stream', fileName: filename });
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('Error enviando respuesta:', e.message);
    res.sendStatus(500);
  }
});

function broadcastStatus() {
  const msg = JSON.stringify({ connected: isConnected });
  wss.clients.forEach(client => {
    try { client.send(msg); } catch {}
  });
}

// ==========================
// Baileys
// ==========================
async function startSock() {
  // Evita sockets duplicados
  try { sock?.end?.(); } catch {}
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: P({ level: 'silent' }),
    auth: state,
    printQRInTerminal: true
  });

  console.log('updateMediaMessage:', typeof sock.updateMediaMessage);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      currentQR = await qrcode.toDataURL(qr);
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'open') {
      isConnected = true;
      wasEverConnected = true;
      reconexionIntentos = 0;
      ALERTA_ENVIADA.estado = false;
      broadcastStatus();
      console.log('✅ Conectado a WhatsApp');
    }

    if (connection === 'close') {
      isConnected = false;
      broadcastStatus();

      const reasonCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = reasonCode === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        console.log('⚠️ Logout recibido (loggedOut). Se borrará auth para forzar nuevo QR.');
        resetAuthState('loggedOut');

        // Espera un poco y vuelve a iniciar para generar QR
        setTimeout(startSock, 1500);
        return; // 👈 IMPORTANTE: corta aquí para no seguir el flujo normal
      }

      // Para otros cierres (red, reinicio, timeout), reintenta con backoff normal
      reconexionIntentos++;
      if (reconexionIntentos > MAX_REINTENTOS) {
        console.log('🛑 Max reintentos alcanzado');
        return;
      }

      setTimeout(startSock, RETRY_DELAY_MS);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      // Hoisted para acceso en catch (fallback UX)
      let rawJid = null;
      let mediaType = null;
      try {
        if (!msg.message || msg.key.fromMe) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;
        if (msg.key.remoteJid.endsWith('@g.us')) continue;

        rawJid = normalizeJid(msg.key.remoteJid);
        const phone = extractPhone(rawJid);

        const realMessage = unwrapMessage(msg.message);
        if (!realMessage) continue;

        const type = Object.keys(realMessage)[0];
        mediaType = type;
        const content = realMessage[type];
        // ✅ Texto que el usuario escribió junto al archivo (caption)
        const captionRaw =
          (content?.caption && String(content.caption)) ||
          '';
        // límite por seguridad (headers tienen límite)
        const captionSafe = captionRaw.slice(0, 1500);

        const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toLocaleString();

        let text = '';
        let fileBuffer = null;
        let filename = null;
        let mimetype = null;

        if (type === 'conversation') {
          text = content;
        } else if (type === 'extendedTextMessage') {
          text = content.text;
        } else if (type === 'buttonsResponseMessage') {
          text = content.selectedButtonId || content.selectedDisplayText || 'CONFIRMAR';
        } else if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(type)) {
          const t0 = Date.now();
          const mediaUrl   = content?.url;
          const directPath = content?.directPath;
          const mediaKey   = content?.mediaKey;
          const expired    = mediaUrl ? isUrlExpired(mediaUrl) : false;
          const msgAgeMs   = Date.now() - Number(msg.messageTimestamp) * 1000;

          console.log(`📥 media type=${type} from=${rawJid}`, {
            url:        mediaUrl   ? 'present' : 'absent',
            directPath: directPath ? 'present' : 'absent',
            mediaKey:   mediaKey   ? 'present' : 'absent',
            mimetype:   content?.mimetype,
            expired,
            msgAgeMs,
          });

          let msgToDownload = { ...msg, message: realMessage };

          // imageMessage desde galería: siempre refrescar URL antes de descargar.
          // El CDN puede haber purgado el contenido antes de que expire el parámetro oe.
          // Para otros tipos: solo refrescar si expirado o sin URL.
          const shouldRefresh = typeof sock.updateMediaMessage === 'function'
            && (type === 'imageMessage' || expired || !mediaUrl);

          if (shouldRefresh) {
            console.log(`🔄 updateMediaMessage type=${type} t=${Date.now() - t0}ms`);
            const t1 = Date.now();
            try {
              const updated = await retry(
                () => withTimeout(sock.updateMediaMessage(msgToDownload), 15000, 'updateMediaMessage'),
                1,
                'updateMediaMessage'
              );
              if (updated?.message) msgToDownload = { ...msgToDownload, message: updated.message };
              console.log(`✅ updateMediaMessage ok dt=${Date.now() - t1}ms`);
            } catch (updateErr) {
              console.warn(`⚠️ updateMediaMessage falló dt=${Date.now() - t1}ms:`, updateErr?.message);
              if (expired || !mediaUrl) {
                // Sin URL válida y sin refresh → no hay forma de descargar
                throw updateErr;
              }
              // URL presente pero refresh falló → intentar con URL original
              console.warn('⚠️ Intentando descarga con URL original...');
            }
          } else if (expired) {
            throw new Error('Media expirado y updateMediaMessage no disponible');
          }

          console.log(`⬇️ downloadMediaMessage dt_pre=${Date.now() - t0}ms`);
          fileBuffer = await withTimeout(
            downloadMediaMessage(
              msgToDownload,
              'buffer',
              {},
              { logger: sock.logger, reuploadRequest: sock.updateMediaMessage }
            ),
            45000,
            'downloadMediaMessage'
          );

          console.log(`✅ download ok bytes=${fileBuffer?.length ?? 0} dt_total=${Date.now() - t0}ms`);

          filename = content.fileName || `${type}-${Date.now()}`;
          mimetype = content.mimetype || 'application/octet-stream';
          text = `[${type}] recibido`;
        } else {
          text = `[${type}] no soportado`;
        }

        lastMessages.unshift({ from: rawJid, text, timestamp });
        lastMessages = lastMessages.slice(0, 20);

        // enviar al orquestador
        if (fileBuffer) {
          console.log('🚀 Enviando archivo a orquestador...', { filename, mimetype });

          const resp = await axios.post(
            `${ORQUESTADOR_HTTP}/webhook/orquestador`,
            fileBuffer,
            {
              headers: {
                'Content-Type': mimetype,
                'X-Filename': filename,
                'X-From': rawJid,
                'X-Phone': phone || '',
                'X-Text': captionSafe
              },
              maxBodyLength: Infinity,
              maxContentLength: Infinity,
              timeout: 60000
            }
          );

          console.log('✅ Orquestador respondió:', resp.status);
        } else {
          const resp = await axios.post(
            `${ORQUESTADOR_HTTP}/webhook/orquestador`,
            text,
            {
              headers: {
                'Content-Type': 'text/plain',
                'X-From': rawJid,
                'X-Phone': phone || ''
              },
              timeout: 30000
            }
          );
          console.log('✅ Orquestador respondió:', resp.status);
        }

      } catch (err) {
        const status = err?.response?.status;
        const url    = err?.config?.url;
        const isMediaFail =
          (status && url && url.includes('mmg.whatsapp.net')) ||
          err?.message?.includes('Timeout') ||
          err?.message?.includes('fetch stream') ||
          err?.message?.includes('updateMediaMessage');

        if (isMediaFail) {
          console.error(`❌ Error descargando media type=${mediaType}:`, err?.message || err);
          // Fallback UX: pedir al usuario que reenvíe como documento
          if (rawJid && mediaType === 'imageMessage') {
            try {
              await sock.sendMessage(rawJid, {
                text: '⚠️ No pude descargar tu imagen. Por favor reenvíala como *documento* (toca 📎 → Documento al adjuntar).'
              });
            } catch {}
          }
        } else if (status && url && url.includes(ORQUESTADOR_HTTP)) {
          console.error('❌ Error ORQUESTADOR:', status, url);
          console.error('   Body:', err?.response?.data);
        } else {
          console.error('❌ Error procesando mensaje:', err?.message || err);
        }
      }
    }
  });
}

// ==========================
// Start server
// ==========================
app.listen(WEB_PORT, () => {
  console.log(`🌐 Web UI disponible en http://${WEB_HOST}:${WEB_PORT}/web`);
});

startSock();
