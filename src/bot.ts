import { pool } from './db/client.js';
import { config, allowedPhones } from './config.js';
import { addInventory, claimMessage, createOffer, createOfferSale, createProduct, dailySummary, ensureUser, listOffers, listProducts, updateProductPrice, type PaymentMethod } from './db/ledger.js';
import { sendList, sendMenu, sendText } from './whapi.js';

const menuButtons = [
  { type: 'quick_reply' as const, title: 'Nueva venta', id: 'sale' },
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
  { type: 'quick_reply' as const, title: 'Ofertas', id: 'offers' },
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
  return String(value ?? '').replace(/^(?:ButtonsV3|ListV3):\s*/i, '').trim().replace(/\s+/g, ' ');
}

function buttonReply(message: any) {
  const nested = message.reply?.buttons_reply ?? message.reply?.list_reply ?? message.button_reply ?? message.list_reply ?? message.interactive?.button_reply;
  return {
    id: normalizeReplyId(nested?.id ?? message.reply?.id ?? message.interactive?.id),
    title: String(nested?.title ?? message.reply?.title ?? message.interactive?.title ?? '').trim(),
  };
}
function parseQuantity(value: string) {
  const quantity = Number(value.replace(',', '.').replace(/\s*(g|gramos?|units?|unidades?)\s*$/i, ''));
  return Number.isFinite(quantity) && quantity > 0 ? quantity : undefined;
}
function parseNonNegative(value: string) {
  const quantity = Number(value.replace(',', '.').replace(/\s*(g|gramos?|units?|unidades?)\s*$/i, ''));
  return Number.isFinite(quantity) && quantity >= 0 ? quantity : undefined;
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
  if (reply === 'offers') {
    return sendMenu(chatId, 'Ofertas activas:', [
      { type: 'quick_reply', title: 'Nueva oferta', id: 'offer_new' },
      { type: 'quick_reply', title: 'Volver', id: 'more' },
    ]);
  }
  if (reply === 'offer_new') {
    const products = await listProducts();
    if (!products.length) return sendText(chatId, 'Crea primero productos de inventario.');
    await setSession(from, 'offer_new');
    return sendText(chatId, `Nueva oferta. Usa este formato:\nNombre | precio € | producto:gramos:unidades,producto:gramos:unidades\n\nProductos:\n${products.map((p) => `${p.id}: ${p.name}`).join('\n')}\n\nEjemplo: Dry 5 g / 20 € | 20 | 1:5:0,3:0:1`);
  }
  if (session?.state === 'offer_new' && text) {
    const [name, priceText, componentsText] = text.split('|').map((value) => value.trim());
    const price = Number(priceText?.replace(',', '.'));
    const components = (componentsText ?? '').split(',').map((part) => {
      const [productId, grams = '0', units = '0'] = part.split(':').map((value) => value.trim());
      return { productId: Number(productId), grams: Number(grams.replace(',', '.')), units: Number(units.replace(',', '.')) };
    });
    if (!name || !Number.isFinite(price) || price < 0 || !components.length || components.some((component) => !Number.isInteger(component.productId) || !Number.isFinite(component.grams) || component.grams < 0 || !Number.isFinite(component.units) || component.units < 0 || (component.grams === 0 && component.units === 0))) {
      return sendText(chatId, 'Formato inválido. Usa: Nombre | precio € | producto:gramos:unidades');
    }
    const offer = await createOffer({ name, priceCents: Math.round(price * 100), components });
    await pool.query('DELETE FROM bot_sessions WHERE phone=$1', [from]);
    return sendText(chatId, `✅ Oferta creada: ${offer.name}`);
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
    const offers = await listOffers();
    if (!offers.length) return sendText(chatId, 'No hay ofertas activas. Añade una oferta en la base de datos.');
    return sendList(chatId, 'Elige formato de venta:', offers.map((offer) => ({
      title: offer.name.slice(0, 24),
      id: `offer_${offer.id}`,
      description: `${(Number(offer.price_cents) / 100).toFixed(2)} €`,
    })));
  }
  if (/^offer_\d+$/.test(reply)) {
    const offerId = Number(reply.replace('offer_', ''));
    const offer = (await listOffers()).find((item) => Number(item.id) === offerId);
    if (!offer) return showMenu(chatId);
    await setSession(from, 'offer_payment', { offerId, offerName: offer.name, amountCents: offer.price_cents });
    return sendMenu(chatId, `${offer.name}\n${(Number(offer.price_cents) / 100).toFixed(2)} €\n\nForma de pago:`, paymentButtons);
  }
  if (session?.state === 'offer_payment') {
    const selectedPayment = payment(reply);
    if (!selectedPayment) return sendMenu(chatId, 'Forma de pago:', paymentButtons);
    try {
      const result = await createOfferSale({ phone: from, offerId: Number(session.payload.offerId), payment: selectedPayment });
      await pool.query('DELETE FROM bot_sessions WHERE phone=$1', [from]);
      return sendText(chatId, `✅ Venta registrada: ${result.offerName} · ${(result.amount / 100).toFixed(2)} €`);
    } catch (error) {
      if (error instanceof Error && error.message === 'STOCK_INSUFFICIENT') return sendText(chatId, 'No hay stock suficiente para esa oferta. Añade inventario y vuelve a intentarlo.');
      throw error;
    }
  }
  if (reply === 'inventory') {
    const products = await listProducts();
    if (!products.length) return sendText(chatId, 'No hay productos activos. Añade productos en la base de datos.');
    await setSession(from, 'inventory_product');
    return sendMenu(chatId, 'Elige producto:', products.slice(0, 3).map((p) => ({ type: 'quick_reply' as const, title: p.name.slice(0, 25), id: `inventory_product_${p.id}` })));
  }
  if (session?.state === 'inventory_product' && reply.startsWith('inventory_product_')) {
    const productId = Number(reply.replace('inventory_product_', ''));
    const product = (await listProducts()).find((item) => Number(item.id) === productId);
    if (!product) return showMenu(chatId);
    await setSession(from, 'inventory_quantity', { productId, unit: product.unit });
    return sendText(chatId, product.unit === 'units'
      ? '¿Cuántas unidades entran en inventario? Escribe un número, por ejemplo: 10'
      : '¿Cuántos gramos entran en inventario? Escribe un número, por ejemplo: 10');
  }
  if (session?.state === 'inventory_quantity' && text) {
    const productId = Number(session.payload.productId);
    const quantity = parseNonNegative(text);
    if (quantity === undefined || quantity <= 0) return sendText(chatId, 'Cantidad inválida. Escribe solo un número, por ejemplo: 10');
    const grams = session.payload.unit === 'units' ? 0 : quantity;
    const units = session.payload.unit === 'units' ? quantity : 0;
    try {
      const result = await addInventory({ phone: from, productId, grams, units });
      await pool.query('DELETE FROM bot_sessions WHERE phone=$1', [from]);
      return sendText(chatId, session.payload.unit === 'units'
        ? `✅ Inventario actualizado: +${result.units} unidades.`
        : `✅ Inventario actualizado: +${result.grams} g.`);
    } catch (error) {
      if (error instanceof Error && error.message === 'PRODUCT_NOT_FOUND') return sendText(chatId, 'Producto no encontrado. Usa un ID activo.');
      throw error;
    }
  }
  if (reply === 'dashboard' || reply === 'daily_summary' || text.toLowerCase() === 'caja' || text.toLowerCase() === 'resumen') {
    const summary = await dailySummary();
    return sendText(chatId, `📈 Resumen del día\n\nVentas: ${summary.sale_count} · ${(summary.sales / 100).toFixed(2)} €\nEfectivo: ${(summary.cash_sales / 100).toFixed(2)} €\nBizum: ${(summary.bizum_sales / 100).toFixed(2)} €\nOtro: ${(summary.other_sales / 100).toFixed(2)} €\n\nCoste estimado: ${(summary.estimated_cost / 100).toFixed(2)} €\nMargen estimado: ${(summary.estimated_margin / 100).toFixed(2)} €`);
  }
  return showMenu(chatId);
}

export function sendDailyCloseRequest() {
  return sendText(config.WHATSAPP_GROUP_ID, '🌙 Cierre diario\nIntroduce el efectivo contado para calcular el descuadre.');
}
