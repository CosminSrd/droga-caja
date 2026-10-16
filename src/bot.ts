import { pool } from './db/client.js';
import { config, allowedPhones } from './config.js';
import { addInventory, createExpense, createSale, dailySummary, ensureUser, listProducts, type PaymentMethod } from './db/ledger.js';
import { sendMenu, sendText } from './whapi.js';

const menuButtons = [
  { type: 'quick_reply' as const, title: 'Nueva venta', id: 'sale' },
  { type: 'quick_reply' as const, title: 'Nuevo gasto', id: 'expense' },
  { type: 'quick_reply' as const, title: 'Añadir inventario', id: 'inventory' },
];
const paymentButtons = [
  { type: 'quick_reply' as const, title: 'Efectivo', id: 'pay_cash' },
  { type: 'quick_reply' as const, title: 'Bizum', id: 'pay_bizum' },
  { type: 'quick_reply' as const, title: 'Otro', id: 'pay_other' },
];

export function showMenu(to: string) { return sendMenu(to, '📊 Caja CBD\nElige una opción:', menuButtons); }

async function setSession(phone: string, state: string, payload: Record<string, unknown> = {}) {
  await pool.query(`INSERT INTO bot_sessions(phone, state, payload) VALUES ($1,$2,$3)
    ON CONFLICT (phone) DO UPDATE SET state=$2, payload=$3, updated_at=now()`, [phone, state, payload]);
}
async function getSession(phone: string) {
  const { rows } = await pool.query('SELECT state, payload FROM bot_sessions WHERE phone=$1', [phone]);
  return rows[0] as { state: string; payload: Record<string, unknown> } | undefined;
}
function payment(id: string): PaymentMethod | undefined { return ({ pay_cash: 'cash', pay_bizum: 'bizum', pay_other: 'other' } as const)[id as 'pay_cash' | 'pay_bizum' | 'pay_other']; }

function normalizeReplyId(value: unknown) {
  return String(value ?? '').replace(/^ButtonsV3:\s*/i, '').trim();
}

export async function handleIncoming(message: any) {
  const from = String(message.from ?? '').replace(/\D/g, '');
  const chatId = String(message.chat_id ?? message.from ?? '');
  if (message.from_me || !allowedPhones.has(from)) return;
  await ensureUser(from);
  const reply = normalizeReplyId(message.reply?.buttons_reply?.id ?? message.button_reply?.id ?? message.list_reply?.id);
  const text = String(message.text?.body ?? '').trim();
  if (!reply && !text) return showMenu(chatId);
  if (reply === 'menu' || text.toLowerCase() === 'menu') return showMenu(chatId);

  const session = await getSession(from);
  if (reply === 'sale') {
    const products = await listProducts();
    if (!products.length) return sendText(chatId, 'No hay productos activos. Añade productos en la base de datos.');
    await setSession(from, 'sale_quantity', { productId: products[0].id });
    return sendText(chatId, products.map((p) => `${p.id}: ${p.name} — ${p.sale_price_cents / 100} €/${p.unit} — stock ${p.stock}`).join('\n') + '\n\nResponde con ID y cantidad, por ejemplo: 1 2');
  }
  if (session?.state === 'sale_quantity' && text) {
    const [productId, quantity] = text.split(/\s+/).map(Number);
    if (!Number.isInteger(productId) || !Number.isFinite(quantity) || quantity <= 0) return sendText(chatId, 'Formato inválido. Usa: ID cantidad');
    await setSession(from, 'sale_payment', { productId, quantity });
    return sendMenu(chatId, 'Forma de pago:', paymentButtons);
  }
  const selectedPayment = payment(reply);
  if (session?.state === 'sale_payment' && selectedPayment) {
    const result = await createSale({ phone: from, productId: Number(session.payload.productId), quantity: Number(session.payload.quantity), payment: selectedPayment });
    await pool.query('DELETE FROM bot_sessions WHERE phone=$1', [from]);
    return sendText(chatId, `✅ Venta registrada: ${(result.amount / 100).toFixed(2)} €`);
  }
  if (reply === 'expense') {
    await setSession(from, 'expense_amount');
    return sendText(chatId, '🧾 Indica el importe en euros, por ejemplo: 12,50');
  }
  if (reply === 'inventory') {
    const products = await listProducts();
    if (!products.length) return sendText(chatId, 'No hay productos activos. Añade productos en la base de datos.');
    await setSession(from, 'inventory_quantity');
    return sendText(chatId, products.map((p) => `${p.id}: ${p.name} — stock ${p.stock}`).join('\n') + '\n\nResponde con ID y cantidad, por ejemplo: 1 10');
  }
  if (session?.state === 'inventory_quantity' && text) {
    const [productId, quantity] = text.split(/\s+/).map(Number);
    if (!Number.isInteger(productId) || !Number.isFinite(quantity) || quantity <= 0) return sendText(chatId, 'Formato inválido. Usa: ID cantidad');
    try {
      const result = await addInventory({ phone: from, productId, quantity });
      await pool.query('DELETE FROM bot_sessions WHERE phone=$1', [from]);
      return sendText(chatId, `✅ Inventario actualizado: +${result.quantity} unidades.`);
    } catch (error) {
      if (error instanceof Error && error.message === 'PRODUCT_NOT_FOUND') return sendText(chatId, 'Producto no encontrado. Usa un ID activo.');
      throw error;
    }
  }
  if (session?.state === 'expense_amount' && text) {
    const amount = Number(text.replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) return sendText(chatId, 'Importe inválido.');
    await setSession(from, 'expense_payment', { amountCents: Math.round(amount * 100) });
    return sendMenu(chatId, 'Forma de pago:', paymentButtons);
  }
  if (session?.state === 'expense_payment' && selectedPayment) {
    await createExpense(from, Number(session.payload.amountCents), selectedPayment);
    await pool.query('DELETE FROM bot_sessions WHERE phone=$1', [from]);
    return sendText(chatId, '✅ Gasto registrado como pendiente de justificante.');
  }
  if (reply === 'dashboard' || reply === 'daily_summary' || text.toLowerCase() === 'caja' || text.toLowerCase() === 'resumen') {
    const summary = await dailySummary();
    return sendText(chatId, `📈 Resumen\nVentas: ${(summary.sales / 100).toFixed(2)} €\nGastos: ${(summary.expenses / 100).toFixed(2)} €\nEfectivo: ${(summary.cash_sales / 100).toFixed(2)} €\nBizum: ${(summary.bizum_sales / 100).toFixed(2)} €\nSin justificante: ${summary.missing_receipts}`);
  }
  return showMenu(chatId);
}

export function sendDailyCloseRequest() {
  return sendMenu(config.WHATSAPP_GROUP_ID, '🌙 Cierre diario\nIntroduce el efectivo contado para calcular el descuadre.', [
    { type: 'quick_reply', title: 'Introducir efectivo', id: 'cash_count' },
    { type: 'quick_reply', title: 'Ver resumen', id: 'daily_summary' },
  ]);
}
