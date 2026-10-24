import express from 'express';
import cron from 'node-cron';
import { config } from './config.js';
import { handleIncoming, sendDailyCloseRequest } from './bot.js';
import { createHash, timingSafeEqual } from 'node:crypto';

const app = express();
const messageQueues = new Map<string, Promise<void>>();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/webhook/whapi', async (req, res) => {
  if (config.WHAPI_WEBHOOK_SECRET) {
    const supplied = String(req.get('x-webhook-secret') ?? req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '');
    const expected = Buffer.from(config.WHAPI_WEBHOOK_SECRET);
    const actual = Buffer.from(supplied);
    if (expected.length !== actual.length || !timingSafeEqual(createHash('sha256').update(expected).digest(), createHash('sha256').update(actual).digest())) {
      return res.status(401).json({ ok: false });
    }
  }
  res.status(200).json({ ok: true });
  try {
    console.log('Webhook messages:', JSON.stringify((req.body.messages ?? []).map((message: any) => ({
      type: message.type,
      from: message.from,
      chatId: message.chat_id,
      id: message.id,
    }))));
    await Promise.all((req.body.messages ?? []).map((message: any) => {
      const key = String(message.from ?? message.chat_id ?? 'unknown');
      const previous = messageQueues.get(key) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(() => handleIncoming(message)).catch(async () => {
        const chatId = String(message.chat_id ?? message.from ?? '');
        if (chatId && !chatId.endsWith('@g.us')) {
          await import('./whapi.js').then(({ sendText }) => sendText(chatId, '⚠️ No pude procesar esta operación. Inténtalo de nuevo o escribe menu.'));
        }
      });
      messageQueues.set(key, current);
      void current.finally(() => { if (messageQueues.get(key) === current) messageQueues.delete(key); });
      return current;
    }));
  } catch (error) {
    console.error('Webhook processing error:', error);
  }
});

cron.schedule('0 0 * * *', () => sendDailyCloseRequest().catch(console.error), { timezone: config.TZ });
app.listen(config.PORT, '0.0.0.0', () => console.log(`Bot listening on :${config.PORT}`));
