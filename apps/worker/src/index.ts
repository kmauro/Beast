import { createDatabase } from '@beast/database';
import 'dotenv/config';
import qrcode from 'qrcode-terminal';
import whatsapp from 'whatsapp-web.js';
import { loadConfig } from './config.js';
import { writeHeartbeat, type WorkerStatus } from './heartbeat.js';

const { Client, LocalAuth } = whatsapp;
const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);

let currentStatus: WorkerStatus = 'DEGRADED';
let currentDetail: string | null = 'Inicializando WhatsApp';
let shuttingDown = false;

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: config.WHATSAPP_CLIENT_ID,
    dataPath: config.WHATSAPP_AUTH_PATH,
  }),
  puppeteer: {
    headless: config.WHATSAPP_HEADLESS,
    args: [
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  },
});

async function updateStatus(
  status: WorkerStatus,
  detail: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  currentStatus = status;
  currentDetail = detail;
  await writeHeartbeat(db, status, detail, {
    replyEnabled: config.BOT_REPLY_ENABLED,
    ...metadata,
  });
}

client.on('qr', (qr) => {
  console.log('Escaneá el siguiente QR con la cuenta de WhatsApp Business:');
  qrcode.generate(qr, { small: true });
  void updateStatus('DEGRADED', 'Esperando que se escanee el código QR');
});

client.on('authenticated', () => {
  console.log('Sesión de WhatsApp autenticada');
  void updateStatus('DEGRADED', 'Autenticado; esperando sincronización');
});

client.on('ready', () => {
  console.log('Cliente de WhatsApp listo');
  void updateStatus('UP', config.BOT_REPLY_ENABLED ? null : 'Respuestas automáticas desactivadas');
});

client.on('auth_failure', (message) => {
  console.error('Falló la autenticación de WhatsApp:', message);
  void updateStatus('DOWN', `Falló la autenticación: ${message}`);
});

client.on('disconnected', (reason) => {
  console.error('WhatsApp se desconectó:', reason);
  void updateStatus('DOWN', `Desconectado: ${reason}`);
});

client.on('message', (message) => {
  // El motor conversacional se activará cuando existan vendedores, formularios
  // publicados, cifrado y pruebas de aceptación. Nunca responder desde este
  // listener mientras BOT_REPLY_ENABLED sea false.
  console.log('Mensaje entrante recibido', {
    messageId: message.id._serialized,
    chatId: message.from,
    replyEnabled: config.BOT_REPLY_ENABLED,
  });
});

const heartbeatTimer = setInterval(() => {
  void writeHeartbeat(db, currentStatus, currentDetail, {
    replyEnabled: config.BOT_REPLY_ENABLED,
  }).catch((error: unknown) => console.error('No se pudo registrar el heartbeat:', error));
}, 30_000);

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeatTimer);
  console.log(`Deteniendo worker por ${signal}`);

  try {
    await updateStatus('DOWN', `Worker detenido por ${signal}`);
    await client.destroy();
  } finally {
    await db.destroy();
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await updateStatus('DEGRADED', 'Inicializando WhatsApp');
await client.initialize();

