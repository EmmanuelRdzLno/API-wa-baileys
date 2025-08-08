const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const P = require('pino'); // Usa pino como logger
const { enviarAlerta } = require('./mailer');

let desconectadoDesde = null;
let reconexionIntentos = 0;
const MAX_REINTENTOS = 5;
const ALERTA_ENVIADA = { estado: false };
const RETRY_DELAY_MS = 5000; // Delay en ms para reconexión
const delay = ms => new Promise(res => setTimeout(res, ms));
const conversaciones = new Map(); // Seguimiento de conversaciones activas


async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('auth');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: P({ level: 'silent' }), // <- Usa logger compatible con .child() y .trace()
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const reasonCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = reasonCode === DisconnectReason.loggedOut;

            desconectadoDesde = Date.now();
            reconexionIntentos++;

            if (isLoggedOut) {
                console.log('🔁 Usuario deslogueado. Borrando credenciales...');
                fs.rmSync('auth', { recursive: true, force: true });
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
            console.log('✅ Conectado a WhatsApp');
            desconectadoDesde = null;
            reconexionIntentos = 0;
            ALERTA_ENVIADA.estado = false;
        }
    });


    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages[0];
        const sender = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;

        if (msg.message?.conversation) {
            const text = msg.message.conversation;
            if (fromMe) {
                console.log(`💬 Envíado: ${sender}: ${text}`);
            }
            else {
                console.log(`💬 Recibido: ${sender}: ${text}`);
                const yaConversado = conversaciones.get(sender);

                if (!yaConversado) {
                    // Primer mensaje: delay de 5-10 segundos
                    const delayInicio = Math.floor(Math.random() * 5000) + 5000;
                    await delay(delayInicio);
                    conversaciones.set(sender, true);
                } else {
                    // Delay corto de 2 segundos
                    await delay(2000);
                }

                // Delay proporcional a caracteres (50ms por caracter)
                const textoRespuesta = 'Hola 👋, este es un bot automático.';
                const delayPorCaracter = textoRespuesta.length * 50;
                await delay(delayPorCaracter);

                await sock.sendMessage(sender, { text: textoRespuesta });
            }
        }
    });
}

startSock();