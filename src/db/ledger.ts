import { pool } from './client.js';

export type PaymentMethod = 'cash' | 'bizum' | 'other';

export async function ensureUser(phone: string) {
  await pool.query('INSERT INTO users(phone) VALUES ($1) ON CONFLICT (phone) DO UPDATE SET active=true', [phone]);
}

export async function claimMessage(messageId: string) {
  const result = await pool.query(
    'INSERT INTO processed_messages(message_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [messageId],
  );
  return result.rowCount === 1;
}

export async function listProducts() {
  const { rows } = await pool.query(`SELECT id, name, unit, inventory_type, sale_price_cents, purchase_cost_cents, stock,
      COALESCE(stock_grams, stock) AS stock_grams,
      COALESCE(stock_units, stock) AS stock_units,
      COALESCE(minimum_stock_grams, minimum_stock) AS minimum_stock_grams,
      COALESCE(minimum_stock_units, 0) AS minimum_stock_units
    FROM products WHERE active=true ORDER BY name`);
  return rows as { id: number; name: string; unit: string; inventory_type: string; sale_price_cents: number; purchase_cost_cents: number; stock: string; stock_grams: string; stock_units: string; minimum_stock: string; minimum_stock_grams: string; minimum_stock_units: string }[];
}

export async function listOffers() {
  const { rows } = await pool.query(`SELECT o.id, o.name, o.price_cents,
      COALESCE(json_agg(json_build_object('product_id', c.product_id, 'product_name', p.name,
        'grams', c.quantity_grams, 'units', c.quantity_units) ORDER BY c.id) FILTER (WHERE c.id IS NOT NULL), '[]') AS components
    FROM sale_offers o LEFT JOIN offer_components c ON c.offer_id=o.id LEFT JOIN products p ON p.id=c.product_id
    WHERE o.active=true GROUP BY o.id ORDER BY o.id`);
  return rows as { id: number; name: string; price_cents: number; components: { product_id: number; product_name: string; grams: string; units: string }[] }[];
}

export async function createOffer(input: { name: string; priceCents: number; components: { productId: number; grams: number; units: number }[] }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const offer = await client.query('INSERT INTO sale_offers(name, price_cents) VALUES ($1,$2) RETURNING id, name', [input.name, input.priceCents]);
    for (const component of input.components) {
      await client.query(`INSERT INTO offer_components(offer_id, product_id, quantity_grams, quantity_units)
        VALUES ($1,$2,$3,$4)`, [offer.rows[0].id, component.productId, component.grams, component.units]);
    }
    await client.query('COMMIT');
    return offer.rows[0] as { id: number; name: string };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function createProduct(input: { name: string; unit: 'grams' | 'units'; salePriceCents: number; purchaseCostCents: number; minimumStock: number }) {
  const { rows } = await pool.query(
    `INSERT INTO products(name, unit, sale_price_cents, purchase_cost_cents, minimum_stock, minimum_stock_grams, minimum_stock_units, stock_grams, stock_units)
     VALUES ($1,$2,$3,$4,$5,$5,$5,0,0) RETURNING id, name`,
    [input.name, input.unit, input.salePriceCents, input.purchaseCostCents, input.minimumStock],
  );
  return rows[0] as { id: number; name: string };
}

export async function updateProductPrice(id: number, salePriceCents: number) {
  const result = await pool.query('UPDATE products SET sale_price_cents=$1 WHERE id=$2 AND active=true', [salePriceCents, id]);
  return result.rowCount === 1;
}

export async function createSale(input: { phone: string; productId: number; quantity: number; payment: PaymentMethod; unitPriceCents?: number; clientName?: string; clientContact?: string }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const product = await client.query(`SELECT id, name, sale_price_cents, purchase_cost_cents,
      COALESCE(stock_grams, stock) AS stock_grams, COALESCE(stock_units, stock) AS stock_units
      FROM products WHERE id=$1 AND active=true FOR UPDATE`, [input.productId]);
    if (!product.rowCount || Number(product.rows[0].stock_grams) < input.quantity || Number(product.rows[0].stock_units) < input.quantity) throw new Error('STOCK_INSUFFICIENT');
    const unitPriceCents = input.unitPriceCents ?? Number(product.rows[0].sale_price_cents);
    const amount = Math.round(unitPriceCents * input.quantity);
    const entry = await client.query(`INSERT INTO ledger_entries
      (kind,user_phone,amount_cents,payment_method,client_name,client_contact,receipt_status)
      VALUES ('sale',$1,$2,$3,$4,$5,'not_applicable') RETURNING id`,
      [input.phone, amount, input.payment, input.clientName ?? null, input.clientContact ?? null]);
    await client.query(`INSERT INTO ledger_lines(ledger_entry_id,product_id,quantity,unit_price_cents)
      VALUES ($1,$2,$3,$4)`, [entry.rows[0].id, input.productId, input.quantity, unitPriceCents]);
    await client.query(`UPDATE products SET stock=stock-$1, stock_grams=COALESCE(stock_grams, stock)-$1,
      stock_units=COALESCE(stock_units, stock)-$1 WHERE id=$2`, [input.quantity, input.productId]);
    await client.query(`INSERT INTO inventory_movements(product_id, user_phone, grams, units, reason) VALUES ($1,$2,$3,$3,'sale')`, [input.productId, input.phone, input.quantity]);
    await client.query('COMMIT');
    return { id: entry.rows[0].id, amount };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function createOfferSale(input: { phone: string; offerId: number; payment: PaymentMethod }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const offer = await client.query(`SELECT id, name, price_cents FROM sale_offers WHERE id=$1 AND active=true FOR UPDATE`, [input.offerId]);
    if (!offer.rowCount) throw new Error('OFFER_NOT_FOUND');
    const components = await client.query(`SELECT c.product_id, c.quantity_grams, c.quantity_units, p.name, p.purchase_cost_cents,
        COALESCE(p.stock_grams, p.stock) AS stock_grams, COALESCE(p.stock_units, p.stock) AS stock_units
      FROM offer_components c JOIN products p ON p.id=c.product_id
      WHERE c.offer_id=$1 AND p.active=true FOR UPDATE`, [input.offerId]);
    if (!components.rowCount) throw new Error('OFFER_EMPTY');
    for (const component of components.rows) {
      if ((Number(component.quantity_grams) > 0 && Number(component.quantity_grams) > Number(component.stock_grams)) ||
        (Number(component.quantity_units) > 0 && Number(component.quantity_units) > Number(component.stock_units))) throw new Error('STOCK_INSUFFICIENT');
    }
    const entry = await client.query(`INSERT INTO ledger_entries(kind,user_phone,amount_cents,payment_method,receipt_status,offer_id,offer_name)
      VALUES ('sale',$1,$2,$3,'not_applicable',$4,$5) RETURNING id`, [input.phone, offer.rows[0].price_cents, input.payment, offer.rows[0].id, offer.rows[0].name]);
    for (const component of components.rows) {
      await client.query(`INSERT INTO ledger_lines(ledger_entry_id,product_id,quantity,unit_price_cents,quantity_grams,quantity_units,unit_cost_cents)
        VALUES ($1,$2,COALESCE(NULLIF($3,0),$4),0,$3,$4,$5)`, [entry.rows[0].id, component.product_id, component.quantity_grams, component.quantity_units, component.purchase_cost_cents]);
      await client.query(`UPDATE products SET stock=stock-GREATEST($1,$2), stock_grams=COALESCE(stock_grams, stock)-$1,
        stock_units=COALESCE(stock_units, stock)-$2 WHERE id=$3`, [component.quantity_grams, component.quantity_units, component.product_id]);
      await client.query(`INSERT INTO inventory_movements(product_id,user_phone,grams,units,reason) VALUES ($1,$2,$3,$4,'sale')`, [component.product_id, input.phone, component.quantity_grams, component.quantity_units]);
    }
    await client.query('COMMIT');
    return { id: entry.rows[0].id, amount: Number(offer.rows[0].price_cents), offerName: offer.rows[0].name };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function addInventory(input: { phone: string; productId: number; grams: number; units: number; unitCostCents?: number }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const product = await client.query(
      `SELECT id, purchase_cost_cents FROM products WHERE id=$1 AND active=true FOR UPDATE`,
      [input.productId],
    );
    if (!product.rowCount) throw new Error('PRODUCT_NOT_FOUND');
    const unitCost = input.unitCostCents ?? Number(product.rows[0].purchase_cost_cents);
    const amount = Math.round(unitCost * input.grams);
    const entry = await client.query(
      `INSERT INTO ledger_entries(kind,user_phone,amount_cents,payment_method,receipt_status,notes)
       VALUES ('purchase',$1,$2,'other','missing','Entrada de inventario') RETURNING id`,
      [input.phone, amount],
    );
    await client.query(
      `INSERT INTO ledger_lines(ledger_entry_id,product_id,quantity,unit_price_cents)
       VALUES ($1,$2,$3,$4)`,
      [entry.rows[0].id, input.productId, input.grams, unitCost],
    );
    await client.query(`UPDATE products SET stock=stock+$1, stock_grams=COALESCE(stock_grams, stock)+$1,
      stock_units=COALESCE(stock_units, stock)+$2 WHERE id=$3`, [input.grams, input.units, input.productId]);
    await client.query(`INSERT INTO inventory_movements(product_id, user_phone, grams, units, reason) VALUES ($1,$2,$3,$4,'purchase')`, [input.productId, input.phone, input.grams, input.units]);
    await client.query('COMMIT');
    return { id: entry.rows[0].id, amount, grams: input.grams, units: input.units };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function dailySummary(date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  const { rows } = await pool.query(`SELECT
    COUNT(*) FILTER (WHERE kind='sale')::int AS sale_count,
    COALESCE(SUM(amount_cents) FILTER (WHERE kind='sale'),0)::int AS sales,
    COALESCE(SUM(amount_cents) FILTER (WHERE kind='expense'),0)::int AS expenses,
    COALESCE(SUM(amount_cents) FILTER (WHERE kind='sale' AND payment_method='cash'),0)::int AS cash_sales,
    COALESCE(SUM(amount_cents) FILTER (WHERE kind='sale' AND payment_method='bizum'),0)::int AS bizum_sales,
    COALESCE(SUM(amount_cents) FILTER (WHERE kind='sale' AND payment_method='other'),0)::int AS other_sales,
    COUNT(*) FILTER (WHERE receipt_status='missing')::int AS missing_receipts,
    COALESCE(SUM(ll.quantity * p.purchase_cost_cents) FILTER (WHERE le.kind='sale'),0)::int AS estimated_cost,
    COALESCE(SUM(le.amount_cents - (ll.quantity * p.purchase_cost_cents)) FILTER (WHERE le.kind='sale'),0)::int AS estimated_margin
    FROM ledger_entries le LEFT JOIN ledger_lines ll ON ll.ledger_entry_id=le.id LEFT JOIN products p ON p.id=ll.product_id
    WHERE le.daily_close_date=$1 AND le.status='confirmed'`, [day]);
  return rows[0];
}
