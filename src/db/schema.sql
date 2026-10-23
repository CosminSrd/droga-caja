CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  display_name TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('grams', 'units')),
  sale_price_cents INTEGER NOT NULL CHECK (sale_price_cents >= 0),
  purchase_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (purchase_cost_cents >= 0),
  stock NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (stock >= 0),
  minimum_stock NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_grams NUMERIC(12,3);
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_units NUMERIC(12,3);
ALTER TABLE products ADD COLUMN IF NOT EXISTS minimum_stock_grams NUMERIC(12,3) NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS minimum_stock_units NUMERIC(12,3) NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS inventory_type TEXT NOT NULL DEFAULT 'product';
UPDATE products SET stock_grams = COALESCE(stock_grams, stock), stock_units = COALESCE(stock_units, stock);

CREATE TABLE IF NOT EXISTS sale_offers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS offer_components (
  id BIGSERIAL PRIMARY KEY,
  offer_id BIGINT NOT NULL REFERENCES sale_offers(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity_grams NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (quantity_grams >= 0),
  quantity_units NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (quantity_units >= 0),
  CHECK (quantity_grams > 0 OR quantity_units > 0),
  UNIQUE (offer_id, product_id)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('sale','expense','purchase','cash_in','cash_out','adjustment')),
  user_phone TEXT NOT NULL REFERENCES users(phone),
  amount_cents INTEGER NOT NULL,
  payment_method TEXT CHECK (payment_method IN ('cash','bizum','other')),
  client_name TEXT,
  client_contact TEXT,
  receipt_status TEXT NOT NULL DEFAULT 'missing' CHECK (receipt_status IN ('attached','missing','not_applicable')),
  notes TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  daily_close_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','voided','corrected')),
  voided_at TIMESTAMPTZ
);

ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS offer_id BIGINT REFERENCES sale_offers(id);
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS offer_name TEXT;

CREATE TABLE IF NOT EXISTS ledger_lines (
  id BIGSERIAL PRIMARY KEY,
  ledger_entry_id BIGINT NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
);

ALTER TABLE ledger_lines ADD COLUMN IF NOT EXISTS quantity_grams NUMERIC(12,3);
ALTER TABLE ledger_lines ADD COLUMN IF NOT EXISTS quantity_units NUMERIC(12,3);
ALTER TABLE ledger_lines ADD COLUMN IF NOT EXISTS unit_cost_cents INTEGER;

CREATE TABLE IF NOT EXISTS inventory_movements (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id),
  user_phone TEXT NOT NULL REFERENCES users(phone),
  grams NUMERIC(12,3) NOT NULL DEFAULT 0,
  units NUMERIC(12,3) NOT NULL DEFAULT 0,
  reason TEXT NOT NULL CHECK (reason IN ('purchase','sale','adjustment')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bot_sessions (
  phone TEXT PRIMARY KEY REFERENCES users(phone) ON DELETE CASCADE,
  state TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS processed_messages (
  message_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cash_closes (
  close_date DATE PRIMARY KEY,
  expected_cash_cents INTEGER NOT NULL,
  counted_cash_cents INTEGER,
  expected_bizum_cents INTEGER NOT NULL DEFAULT 0,
  difference_cents INTEGER,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
