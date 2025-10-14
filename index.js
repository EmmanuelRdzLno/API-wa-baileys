const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
const fs = require('fs');
const P = require('pino');
const { enviarAlerta } = require('./mailer');
const express = require('express');
const expressWs = require('express-ws');
const basicAuth = require('basic-auth');
const path = require('path');

let currentQR = null;
let desconectadoDesde = null;
let reconexionIntentos = 0;
const MAX_REINTENTOS = 5;
const RETRY_DELAY_MS = 5000;
const ALERTA_ENVIADA = { estado: false };
let isConnected = false;
const delay = ms => new Promise(res => setTimeout(res, ms));
const conversaciones = new Map();
const axios = require('axios');

const app = express();
const wsInstance = expressWs(app); // ← Aquí guardamos el servidor WS
const wss = wsInstance.getWss();   // ← Obtenemos el WebSocketServer

// Autenticación básica
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

// Web UI protegida
app.use('/web', auth, express.static(path.join(__dirname, 'web')));

// API REST
app.get('/api/status', auth, (req, res) => {
  res.json({ connected: isConnected });
});

let lastMessages = [];

app.get('/api/messages', auth, (req, res) => {
  res.json(lastMessages.slice(-20));
});

// WebSocket tiempo real
app.ws('/ws/status', function (ws, req) {
  ws.send(JSON.stringify({ connected: isConnected }));
});

// QR para escanear desde frontend
app.get('/api/qr', (req, res) => {
  if (currentQR) {
    res.json({ qr: currentQR });
  } else {
    res.status(404).send('No QR disponible');
  }
});

// ⬇️ agregar cerca de los otros endpoints
app.post('/api/botones', express.json({ limit: '1mb' }), async (req, res) => {
  const to = req.headers['x-to'];
  const { text, buttons } = req.body || {};

  if (!to || !text || !Array.isArray(buttons) || buttons.length === 0) {
    return res.status(400).json({ error: 'Faltan parámetros: to, text, buttons[]' });
  }

  try {
    // Mapeo a formato Baileys "buttons"
    const mapped = buttons.map(b => ({
      buttonId: b.id,                         // p.ej. "CONFIRMAR" ó "CANCELAR"
      buttonText: { displayText: b.text },    // p.ej. "ACEPTAR" ó "CANCELAR"
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

// Enviar respuesta procesada (texto, imagen, documento)
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

const port = process.env.WEB_PORT || 3000;
let sock; // declarado fuera para reusar entre reconexiones

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: P({ level: 'silent' }),
    auth: state
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      qrcodeTerminal.generate(qr, { small: true });
      currentQR = await qrcode.toDataURL(qr);
    }

    if (connection === 'close') {
      isConnected = false;
      broadcastStatus(); // enviar estado a los sockets web

      const reasonCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = reasonCode === DisconnectReason.loggedOut;

      desconectadoDesde = Date.now();
      reconexionIntentos++;

        if (isLoggedOut) {
            console.log('🔁 Usuario deslogueado. Cerrando socket y borrando credenciales...');

            try {
                await sock.logout(); // asegúrate de cerrar sesión correctamente
            } catch (e) {
                console.warn('⚠️ Error al cerrar sesión:', e.message);
            }

            // Esperar un poco para asegurarse que ya no esté en uso
            setTimeout(() => {
                try {
                fs.rmSync('auth', { recursive: true, force: true });
                console.log('🗑️ Carpeta de credenciales eliminada.');
                } catch (err) {
                console.error('❌ No se pudo eliminar la carpeta auth:', err.message);
                }
            }, 2000); // espera 2 segundos
        }

      if (reconexionIntentos >= MAX_REINTENTOS && !ALERTA_ENVIADA.estado) {
        await enviarAlerta(
          '🚨 Error de conexión WhatsApp Bot',
          'No se pudo reconectar después de varios intentos. Requiere atención manual.'
        );
        ALERTA_ENVIADA.estado = true;
      }

      console.log(`🔄 Reintentando conexión en ${RETRY_DELAY_MS / 1000} segundos...`);
      setTimeout(() => startSock(), RETRY_DELAY_MS);
    }

    if (connection === 'open') {
      isConnected = true;
      broadcastStatus(); // enviar estado a los sockets web

      console.log('✅ Conectado a WhatsApp');
      desconectadoDesde = null;
      reconexionIntentos = 0;
      ALERTA_ENVIADA.estado = false;
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const type = Object.keys(msg.message)[0];
      const content = msg.message[type];
      const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toLocaleString();

      let text = '';
      let fileBuffer = null;
      let filename = null;
      let mimetype = null;

      // Extraer texto/archivo
      if (type === 'conversation') {
        text = content || '[Texto vacío]';
      } else if (type === 'extendedTextMessage') {
        text = content.text || '[Texto vacío]';
      } if (type === 'buttonsResponseMessage') {
        // prioriza el id interno (CONFIRMAR/CANCELAR) para que el orquestador lo procese tal cual
        const id = content.selectedButtonId;
        const label = content.selectedDisplayText;
        text = id || label || '';

      // opcional: establece un fallback
        if (!text) text = 'CONFIRMAR';
      } else if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(type)) {
        const stream = await downloadMediaMessage(msg, 'buffer', {}, { logger: sock.logger });
        fileBuffer = stream;
        filename = content.fileName || `${type}-${Date.now()}`;
        mimetype = content.mimetype;
        text = `[${type}] recibido`;
      } else {
        text = `[${type}] no soportado`;
      }

      // Guardar últimos mensajes
      lastMessages.unshift({ from, text, timestamp });
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
                'X-From': from
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
                'X-From': from
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

// Función para emitir estado a todos los clientes WebSocket conectados
function broadcastStatus() {
  const msg = JSON.stringify({ connected: isConnected });
  wss.clients.forEach(client => {
    try {
      client.send(msg);
    } catch (e) {}
  });
}

app.listen(port, () => {
  console.log(`🌐 Web UI disponible en http://localhost:${port}/web`);
});

startSock();