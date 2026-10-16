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

CREATE TABLE IF NOT EXISTS ledger_lines (
  id BIGSERIAL PRIMARY KEY,
  ledger_entry_id BIGINT NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
);

CREATE TABLE IF NOT EXISTS bot_sessions (
  phone TEXT PRIMARY KEY REFERENCES users(phone) ON DELETE CASCADE,
  state TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
