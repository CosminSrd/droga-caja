import { pool } from './client.js';

export type PaymentMethod = 'cash' | 'bizum' | 'other';

export async function ensureUser(phone: string) {
  await pool.query('INSERT INTO users(phone) VALUES ($1) ON CONFLICT (phone) DO UPDATE SET active=true', [phone]);
}

export async function listProducts() {
  const { rows } = await pool.query(`SELECT id, name, unit, sale_price_cents, stock
    FROM products WHERE active=true ORDER BY name`);
  return rows as { id: number; name: string; unit: string; sale_price_cents: number; stock: string }[];
}

export async function createSale(input: { phone: string; productId: number; quantity: number; payment: PaymentMethod; unitPriceCents?: number; clientName?: string; clientContact?: string }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const product = await client.query(`SELECT id, sale_price_cents, stock FROM products WHERE id=$1 AND active=true FOR UPDATE`, [input.productId]);
    if (!product.rowCount || Number(product.rows[0].stock) < input.quantity) throw new Error('STOCK_INSUFFICIENT');
    const unitPriceCents = input.unitPriceCents ?? Number(product.rows[0].sale_price_cents);
    const amount = Math.round(unitPriceCents * input.quantity);
    const entry = await client.query(`INSERT INTO ledger_entries
      (kind,user_phone,amount_cents,payment_method,client_name,client_contact,receipt_status)
      VALUES ('sale',$1,$2,$3,$4,$5,'not_applicable') RETURNING id`,
      [input.phone, amount, input.payment, input.clientName ?? null, input.clientContact ?? null]);
    await client.query(`INSERT INTO ledger_lines(ledger_entry_id,product_id,quantity,unit_price_cents)
      VALUES ($1,$2,$3,$4)`, [entry.rows[0].id, input.productId, input.quantity, unitPriceCents]);
    await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2', [input.quantity, input.productId]);
    await client.query('COMMIT');
    return { id: entry.rows[0].id, amount };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function createExpense(phone: string, amountCents: number, payment: PaymentMethod, notes?: string) {
  await pool.query(`INSERT INTO ledger_entries(kind,user_phone,amount_cents,payment_method,notes,receipt_status)
    VALUES ('expense',$1,$2,$3,$4,'missing')`, [phone, amountCents, payment, notes ?? null]);
}

export async function addInventory(input: { phone: string; productId: number; quantity: number; unitCostCents?: number }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const product = await client.query(
      `SELECT id, purchase_cost_cents FROM products WHERE id=$1 AND active=true FOR UPDATE`,
      [input.productId],
    );
    if (!product.rowCount) throw new Error('PRODUCT_NOT_FOUND');
    const unitCost = input.unitCostCents ?? Number(product.rows[0].purchase_cost_cents);
    const amount = Math.round(unitCost * input.quantity);
    const entry = await client.query(
      `INSERT INTO ledger_entries(kind,user_phone,amount_cents,payment_method,receipt_status,notes)
       VALUES ('purchase',$1,$2,'other','missing','Entrada de inventario') RETURNING id`,
      [input.phone, amount],
    );
    await client.query(
      `INSERT INTO ledger_lines(ledger_entry_id,product_id,quantity,unit_price_cents)
       VALUES ($1,$2,$3,$4)`,
      [entry.rows[0].id, input.productId, input.quantity, unitCost],
    );
    await client.query('UPDATE products SET stock=stock+$1 WHERE id=$2', [input.quantity, input.productId]);
    await client.query('COMMIT');
    return { id: entry.rows[0].id, amount, quantity: input.quantity };
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
    COALESCE(SUM(amount_cents) FILTER (WHERE kind='sale'),0)::int AS sales,
    COALESCE(SUM(amount_cents) FILTER (WHERE kind='expense'),0)::int AS expenses,
    COALESCE(SUM(amount_cents) FILTER (WHERE kind='sale' AND payment_method='cash'),0)::int AS cash_sales,
    COALESCE(SUM(amount_cents) FILTER (WHERE kind='sale' AND payment_method='bizum'),0)::int AS bizum_sales,
    COUNT(*) FILTER (WHERE receipt_status='missing')::int AS missing_receipts
    FROM ledger_entries WHERE daily_close_date=$1 AND status='confirmed'`, [day]);
  return rows[0];
}
