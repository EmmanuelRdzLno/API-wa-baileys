const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  jidDecode
} = require('@whiskeysockets/baileys');

const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
const fs = require('fs');
const P = require('pino');
const { enviarAlerta } = require('./mailer');
const express = require('express');
const expressWs = require('express-ws');
const basicAuth = require('basic-auth');
const path = require('path');
const axios = require('axios');

let wasEverConnected = false;
let currentQR = null;
let desconectadoDesde = null;
let reconexionIntentos = 0;
const MAX_REINTENTOS = 5;
const RETRY_DELAY_MS = 5000;
const ALERTA_ENVIADA = { estado: false };
let isConnected = false;
const delay = ms => new Promise(res => setTimeout(res, ms));
const conversaciones = new Map();

const app = express();
const wsInstance = expressWs(app);
const wss = wsInstance.getWss();

let lastMessages = [];
let sock;

// ==========================
// 🔹 NUEVAS FUNCIONES (LID)
// ==========================
function normalizeJid(jid) {
  if (!jid) return null;
  return jid.split(':')[0]; // elimina device-id
}

function extractPhone(jid) {
  if (!jid) return null;
  if (jid.endsWith('@s.whatsapp.net')) {
    return jid.replace('@s.whatsapp.net', '');
  }
  return null; // LID no tiene teléfono
}

// ==========================
// Autenticación básica
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

app.ws('/ws/status', function (ws, req) {
  ws.send(JSON.stringify({ connected: isConnected }));
});

app.get('/api/qr', (req, res) => {
  if (currentQR) {
    res.json({ qr: currentQR });
  } else {
    res.status(404).send('No QR disponible');
  }
});

// ==========================
// Envío de botones
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

    await sock.sendMessage(to, {
      text,
      buttons: mapped,
      headerType: 1
    });

    res.sendStatus(200);
  } catch (e) {
    console.error('Error enviando botones:', e.message);
    res.sendStatus(500);
  }
});

// ==========================
// Respuesta del orquestador
// ==========================
app.post('/api/respuesta', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const tipo = req.headers['content-type'];
  const to = req.headers['x-to'];
  const filename = req.headers['x-filename'] || 'archivo';

  try {
    if (tipo.startsWith('text/')) {
      await sock.sendMessage(to, { text: req.body.toString() });
    } else if (tipo.startsWith('image/')) {
      await sock.sendMessage(to, { image: req.body, mimetype: tipo, caption: 'Procesado' });
    } else if (tipo.startsWith('application/')) {
      await sock.sendMessage(to, { document: req.body, mimetype: tipo, fileName: filename });
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('Error enviando respuesta:', e.message);
    res.sendStatus(500);
  }
});

// ==========================
// WhatsApp Socket
// ==========================
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: P({ level: 'silent' }),
    auth: state,
    printQRInTerminal: true
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      currentQR = await qrcode.toDataURL(qr);
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'open') {
      isConnected = true;
      wasEverConnected = true; // 🔥 CLAVE
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
        console.log('⚠️ Logout recibido');

        // 🔥 SOLO limpiar auth si ya hubo una conexión estable previa
        if (wasEverConnected) {
          console.log('🗑️ Logout real, limpiando auth...');
          fs.rmSync('auth', { recursive: true, force: true });
          wasEverConnected = false;
        } else {
          console.log('⏳ Logout durante login inicial, NO se borra auth');
        }
      }

      reconexionIntentos++;
      setTimeout(startSock, RETRY_DELAY_MS);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;
      if (msg.key.remoteJid.endsWith('@g.us')) continue;

      const rawJid = normalizeJid(msg.key.remoteJid);
      const phone = extractPhone(rawJid);

      const type = Object.keys(msg.message)[0];
      const content = msg.message[type];
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
        fileBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: sock.logger });
        filename = content.fileName || `${type}-${Date.now()}`;
        mimetype = content.mimetype;
        text = `[${type}] recibido`;
      } else {
        text = `[${type}] no soportado`;
      }

      lastMessages.unshift({ from: rawJid, text, timestamp });
      lastMessages = lastMessages.slice(0, 20);

      try {
        if (fileBuffer) {
          await axios.post(
            'http://localhost:4000/webhook/orquestador',
            fileBuffer,
            {
              headers: {
                'Content-Type': mimetype,
                'X-Filename': filename,
                'X-From': rawJid,
                'X-Phone': phone || ''
              }
            }
          );
        } else {
          await axios.post(
            'http://localhost:4000/webhook/orquestador',
            text,
            {
              headers: {
                'Content-Type': 'text/plain',
                'X-From': rawJid,
                'X-Phone': phone || ''
              }
            }
          );
        }
      } catch (err) {
        console.error('Error enviando al orquestador:', err.message);
      }
    }
  });
}

// ==========================
function broadcastStatus() {
  const msg = JSON.stringify({ connected: isConnected });
  wss.clients.forEach(client => {
    try { client.send(msg); } catch (e) {}
  });
}

const port = process.env.WEB_PORT || 3000;

app.listen(port, () => {
  console.log(`🌐 Web UI disponible en http://localhost:${port}/web`);
});

startSock();
