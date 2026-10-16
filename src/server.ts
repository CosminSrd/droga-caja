import express from 'express';
import cron from 'node-cron';
import { config } from './config.js';
import { handleIncoming, sendDailyCloseRequest } from './bot.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/webhook/whapi', async (req, res) => {
  res.status(200).json({ ok: true });
  try {
    for (const message of req.body.messages ?? []) await handleIncoming(message);
  } catch (error) {
    console.error('Webhook processing error:', error);
  }
});

cron.schedule('0 0 * * *', () => sendDailyCloseRequest().catch(console.error), { timezone: config.TZ });
app.listen(config.PORT, '0.0.0.0', () => console.log(`Bot listening on :${config.PORT}`));
