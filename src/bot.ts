import { pool } from './db/client.js';
import { adminName, config, allowedPhones } from './config.js';
import { addInventory, claimMessage, createExpense, createProduct, createSale, dailySummary, ensureUser, listProducts, updateProductPrice, type PaymentMethod } from './db/ledger.js';
import { sendMenu, sendText } from './whapi.js';

const menuButtons = [
  { type: 'quick_reply' as const, title: 'Nueva venta', id: 'sale' },
  { type: 'quick_reply' as const, title: 'Nuevo gasto', id: 'expense' },
  { type: 'quick_reply' as const, title: 'Más opciones', id: 'more' },
];
const moreButtons = [
  { type: 'quick_reply' as const, title: 'Añadir inventario', id: 'inventory' },
  { type: 'quick_reply' as const, title: 'Ver resumen', id: 'daily_summary' },
  { type: 'quick_reply' as const, title: 'Productos', id: 'products' },
];
const productButtons = [
  { type: 'quick_reply' as const, title: 'Ver stock', id: 'product_stock' },
  { type: 'quick_reply' as const, title: 'Nuevo producto', id: 'product_new' },
  { type: 'quick_reply' as const, title: 'Cambiar precio', id: 'product_price' },
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
  return String(value ?? '').replace(/^ButtonsV3:\s*/i, '').trim().replace(/\s+/g, ' ');
}

function buttonReply(message: any) {
  const nested = message.reply?.buttons_reply ?? message.button_reply ?? message.list_reply ?? message.interactive?.button_reply;
  return {
    id: normalizeReplyId(nested?.id ?? message.reply?.id ?? message.interactive?.id),
    title: String(nested?.title ?? message.reply?.title ?? message.interactive?.title ?? '').trim(),
  };
}
function parseQuantity(value: string) {
  const quantity = Number(value.replace(',', '.').replace(/\s*(g|gramos?|units?|unidades?)\s*$/i, ''));
  return Number.isFinite(quantity) && quantity > 0 ? quantity : undefined;
}

function productStockText(products: Awaited<ReturnType<typeof listProducts>>) {
  if (!products.length) return 'No hay productos activos.';
  return `📦 Stock\n${products.map((p) => `${p.name}: ${p.stock_grams} g · ${p.stock_units} chivatos · ${((Number(p.sale_price_cents) || 0) / 100).toFixed(2)} €/ud`).join('\n')}`;
}

export async function handleIncoming(message: any) {
  const from = String(message.from ?? '').replace(/\D/g, '');
  const chatId = String(message.chat_id ?? message.from ?? '');
  if (message.from_me || chatId === config.WHATSAPP_GROUP_ID || !allowedPhones.has(from)) return;
  const messageId = String(message.id ?? '');
  if (messageId && !(await claimMessage(messageId))) return;
  await ensureUser(from);
  const { id: reply, title: replyTitle } = buttonReply(message);
  const text = String(message.text?.body ?? '').trim();
  if (!reply && !text) return showMenu(chatId);
  if (reply === 'menu' || text.toLowerCase() === 'menu' || text.toLowerCase() === 'cancelar') {
    await pool.query('DELETE FROM bot_sessions WHERE phone=$1', [from]);
    return showMenu(chatId);
  }

  const session = await getSession(from);
  if (session && (await pool.query("DELETE FROM bot_sessions WHERE phone=$1 AND updated_at < now() - interval '30 minutes'", [from])).rowCount) {
    return sendText(chatId, 'La operación anterior caducó por inactividad. He vuelto al menú principal.');
  }
  if (reply === 'more') return sendMenu(chatId, 'Más opciones:', moreButtons);
  if (reply === 'products') return sendMenu(chatId, 'Gestión de productos:', productButtons);
  if (reply === 'product_stock' || text.toLowerCase() === 'stock') return sendText(chatId, productStockText(await listProducts()));
  if (reply === 'product_new') {
    await setSession(from, 'product_new');
    return sendText(chatId, 'Nuevo producto. Responde así:\nNombre | gramos o unidades | precio venta € | coste € | stock mínimo\nEjemplo: Dry | gramos | 5 | 0 | 10');
  }
  if (reply === 'product_price') {
    await setSession(from, 'product_price');
    return sendText(chatId, 'Cambio de precio. Responde así:\nID | nuevo precio €\nEjemplo: 2 | 5');
  }
  if (session?.state === 'product_new' && text) {
    const [name, unit, price, cost = '0', minimum = '0'] = text.split('|').map((value) => value.trim());
    const salePriceCents = Math.round(Number(price.replace(',', '.')) * 100);
    const purchaseCostCents = Math.round(Number(cost.replace(',', '.')) * 100);
    const minimumStock = Number(minimum.replace(',', '.'));
    if (!name || !['gramos', 'unidades'].includes(unit) || !Number.isFinite(salePriceCents) || salePriceCents < 0 || !Number.isFinite(purchaseCostCents) || purchaseCostCents < 0 || !Number.isFinite(minimumStock) || minimumStock < 0) {
      return sendText(chatId, 'Formato inválido. Usa: Nombre | gramos o unidades | precio venta € | coste € | stock mínimo');
    }
    const product = await createProduct({ name, unit: unit === 'gramos' ? 'grams' : 'units', salePriceCents, purchaseCostCents, minimumStock });
    await pool.query('DELETE FROM bot_sessions WHERE phone=$1', [from]);
    return sendText(chatId, `✅ Producto creado: ${product.name} (ID ${product.id})`);
  }
  if (session?.state === 'product_price' && text) {
    const [idText, priceText] = text.split('|').map((value) => value.trim());
    const id = Number(idText);
    const price = Number(priceText?.replace(',', '.'));
    if (!Number.isInteger(id) || !Number.isFinite(price) || price < 0 || !(await updateProductPrice(id, Math.round(price * 100)))) return sendText(chatId, 'No pude cambiar el precio. Revisa el ID y el importe.');
    await pool.query('DELETE FROM bot_sessions WHERE phone=$1', [from]);
    return sendText(chatId, `✅ Precio del producto ${id} actualizado a ${price.toFixed(2)} €.`);
  }
  if (reply === 'sale' || replyTitle.toLowerCase() === 'nueva venta') {
    const products = await listProducts();
    if (!products.length) return sendText(chatId, 'No hay productos activos. Añade productos en la base de datos.');
    const buttons = products.slice(0, 3).flatMap((p) => p.name.toLowerCase() === 'dry'
      ? [
          { type: 'quick_reply' as const, title: 'Dry 5 €/g', id: `sale_product_${p.id}_price_500` },
          { type: 'quick_reply' as const, title: 'Dry 10 €/g', id: `sale_product_${p.id}_price_1000` },
        ]
      : [{ type: 'quick_reply' as const, title: p.name.slice(0, 25), id: `sale_product_${p.id}` }]);
    return sendMenu(chatId, 'Elige producto y precio:', buttons.slice(0, 3));
  }
  let saleReply = reply;
  if (!saleReply.startsWith('sale_product_') && /^dry\s*5\s*€/i.test(replyTitle)) {
    const dry = (await listProducts()).find((item) => item.name.toLowerCase() === 'dry');
    if (dry) saleReply = `sale_product_${dry.id}_price_500`;
  }
  if (!saleReply.startsWith('sale_product_') && /^dry\s*10\s*€/i.test(replyTitle)) {
    const dry = (await listProducts()).find((item) => item.name.toLowerCase() === 'dry');
    if (dry) saleReply = `sale_product_${dry.id}_price_1000`;
  }
  if (saleReply.startsWith('sale_product_')) {
    const match = saleReply.match(/^sale_product_(\d+)(?:_price_(\d+))?$/);
    const productId = Number(match?.[1]);
    const selectedPrice = match?.[2] ? Number(match[2]) : undefined;
    const product = (await listProducts()).find((item) => Number(item.id) === productId);
    if (!product) return showMenu(chatId);
    if (product.name.toLowerCase() === 'dry' && selectedPrice === undefined) {
      await setSession(from, 'sale_price', { productId });
      return sendMenu(chatId, 'Elige precio por gramo:', [
        { type: 'quick_reply', title: '5 €/g', id: 'sale_price_500' },
        { type: 'quick_reply', title: '10 €/g', id: 'sale_price_1000' },
      ]);
    }
    await setSession(from, 'sale_quantity', { productId, unitPriceCents: selectedPrice ?? product.sale_price_cents });
    return sendText(chatId, `¿Cuántos gramos de ${product.name} vendiste? Escribe una cantidad, por ejemplo: 2`);
  }
  if (session?.state === 'sale_price' && reply.startsWith('sale_price_')) {
    await setSession(from, 'sale_quantity', { productId: Number(session.payload.productId), unitPriceCents: Number(reply.replace('sale_price_', '')) });
    return sendText(chatId, '¿Cuántos gramos de Dry vendiste? Escribe una cantidad, por ejemplo: 2');
  }
  if (session?.state === 'sale_quantity' && text) {
    const quantity = parseQuantity(text);
    if (!quantity) return sendText(chatId, 'Cantidad inválida. Escribe solo un número, por ejemplo: 2');
    await setSession(from, 'sale_payment', { ...session.payload, quantity });
    return sendMenu(chatId, 'Forma de pago:', paymentButtons);
  }
  const selectedPayment = payment(reply);
  if (session?.state === 'sale_payment' && selectedPayment) {
    const productId = Number(session.payload.productId);
    const quantity = Number(session.payload.quantity);
    const product = (await listProducts()).find((item) => Number(item.id) === productId);
    try {
      const result = await createSale({ phone: from, productId, quantity, unitPriceCents: Number(session.payload.unitPriceCents), payment: selectedPayment });
      await pool.query('DELETE FROM bot_sessions WHERE phone=$1', [from]);
      const privateMessage = `✅ Venta registrada: ${(result.amount / 100).toFixed(2)} €`;
      const groupMessage = `💰 Venta registrada\nSocio: ${adminName(from)}\nProducto: ${product?.name ?? `#${productId}`}\nCantidad: ${quantity}\nImporte: ${(result.amount / 100).toFixed(2)} €\nPago: ${selectedPayment === 'cash' ? 'Efectivo' : selectedPayment === 'bizum' ? 'Bizum' : 'Otro'}`;
      await sendText(chatId, privateMessage);
      sendText(config.WHATSAPP_GROUP_ID, groupMessage).catch((error) => console.error('Group sale notification error:', error));
      return;
    } catch (error) {
      if (error instanceof Error && error.message === 'STOCK_INSUFFICIENT') {
        sendText(config.WHATSAPP_GROUP_ID, `⚠️ Venta no registrada\nSocio: ${adminName(from)}\nMotivo: stock insuficiente.`).catch(console.error);
        return sendText(chatId, 'No hay stock suficiente para registrar esa venta. Añade inventario y vuelve a intentarlo.');
      }
      throw error;
    }
  }
  if (reply === 'expense') {
    await setSession(from, 'expense_amount');
    return sendMenu(chatId, 'Elige importe:', [5, 10, 20].map((amount) => ({ type: 'quick_reply' as const, title: `${amount} €`, id: `expense_amount_${amount}` })));
  }
  if (reply === 'inventory') {
    const products = await listProducts();
    if (!products.length) return sendText(chatId, 'No hay productos activos. Añade productos en la base de datos.');
    await setSession(from, 'inventory_product');
    return sendMenu(chatId, 'Elige producto:', products.slice(0, 3).map((p) => ({ type: 'quick_reply' as const, title: p.name.slice(0, 25), id: `inventory_product_${p.id}` })));
  }
  if (session?.state === 'inventory_product' && reply.startsWith('inventory_product_')) {
    await setSession(from, 'inventory_quantity', { productId: Number(reply.replace('inventory_product_', '')) });
    return sendText(chatId, 'Indica gramos y chivatos separados por |.\nEjemplo: 20 | 18\nSi son iguales, escribe solo 20.');
  }
  if (session?.state === 'inventory_quantity' && text) {
    const productId = Number(session.payload.productId);
    const values = text.split('|').map((value) => parseQuantity(value.trim()));
    const grams = values[0];
    const units = values.length > 1 ? values[1] : grams;
    if (!grams || !units) return sendText(chatId, 'Cantidad inválida. Usa: gramos | chivatos. Ejemplo: 20 | 18');
    try {
      const result = await addInventory({ phone: from, productId, grams, units });
      await pool.query('DELETE FROM bot_sessions WHERE phone=$1', [from]);
      return sendText(chatId, `✅ Inventario actualizado: +${result.grams} g y +${result.units} chivatos.`);
    } catch (error) {
      if (error instanceof Error && error.message === 'PRODUCT_NOT_FOUND') return sendText(chatId, 'Producto no encontrado. Usa un ID activo.');
      throw error;
    }
  }
  if (session?.state === 'expense_amount' && reply.startsWith('expense_amount_')) {
    const amount = Number(reply.replace('expense_amount_', ''));
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
    return sendText(chatId, `📈 Resumen del día\n\nVentas: ${summary.sale_count} · ${(summary.sales / 100).toFixed(2)} €\nEfectivo: ${(summary.cash_sales / 100).toFixed(2)} €\nBizum: ${(summary.bizum_sales / 100).toFixed(2)} €\nOtro: ${(summary.other_sales / 100).toFixed(2)} €\n\nGastos: ${(summary.expenses / 100).toFixed(2)} €\nCoste estimado: ${(summary.estimated_cost / 100).toFixed(2)} €\nMargen estimado: ${(summary.estimated_margin / 100).toFixed(2)} €\nBalance: ${((summary.sales - summary.expenses) / 100).toFixed(2)} €\nSin justificante: ${summary.missing_receipts}`);
  }
  return showMenu(chatId);
}

export function sendDailyCloseRequest() {
  return sendText(config.WHATSAPP_GROUP_ID, '🌙 Cierre diario\nIntroduce el efectivo contado para calcular el descuadre.');
}
