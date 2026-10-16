import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  WHAPI_TOKEN: z.string().min(1),
  WHAPI_WEBHOOK_SECRET: z.string().optional(),
  ADMIN_PHONE_1: z.string().regex(/^\d+$/),
  ADMIN_PHONE_2: z.string().regex(/^\d+$/),
  WHATSAPP_GROUP_ID: z.string().min(1).endsWith('@g.us'),
  TZ: z.string().default('Europe/Madrid'),
});

export const config = schema.parse(process.env);
export const allowedPhones = new Set([config.ADMIN_PHONE_1, config.ADMIN_PHONE_2]);
