-- Soldi — database schema. Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#6c8cff',
  kind       TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'income')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name, kind)
);

-- Conti (contanti, conto corrente, carta…) a cui associare i movimenti.
CREATE TABLE IF NOT EXISTS accounts (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'bank' CHECK (kind IN ('bank', 'cash', 'card', 'savings', 'other')),
  color      TEXT NOT NULL DEFAULT '#6c8cff',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

-- Spese/entrate fisse ricorrenti (mutui, finanziamenti, addebiti…): generano
-- automaticamente un movimento al mese finché active = true.
CREATE TABLE IF NOT EXISTS recurring_rules (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'expense' CHECK (type IN ('expense', 'income')),
  amount_cents   BIGINT NOT NULL CHECK (amount_cents > 0),
  category_id    BIGINT REFERENCES categories(id) ON DELETE SET NULL,
  account_id     BIGINT REFERENCES accounts(id) ON DELETE SET NULL,
  scope          TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'home')),
  day_of_month   INT NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 28),
  note           TEXT NOT NULL DEFAULT '',
  active         BOOLEAN NOT NULL DEFAULT true,
  start_month    DATE NOT NULL DEFAULT date_trunc('month', CURRENT_DATE),
  last_run_month DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Spese previste: voci di budget per la previsione annuale.
-- 'monthly' = ogni mese; 'yearly' = una volta l'anno nel mese indicato.
CREATE TABLE IF NOT EXISTS planned_expenses (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  category_id  BIGINT REFERENCES categories(id) ON DELETE SET NULL,
  scope        TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'home')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  cadence      TEXT NOT NULL DEFAULT 'monthly' CHECK (cadence IN ('monthly', 'yearly')),
  month        INT CHECK (month BETWEEN 1 AND 12),
  active       BOOLEAN NOT NULL DEFAULT true,
  note         TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('expense', 'income')),
  amount_cents      BIGINT NOT NULL CHECK (amount_cents > 0),
  category_id       BIGINT REFERENCES categories(id) ON DELETE SET NULL,
  account_id        BIGINT REFERENCES accounts(id) ON DELETE SET NULL,
  recurring_rule_id BIGINT REFERENCES recurring_rules(id) ON DELETE SET NULL,
  scope             TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'home')),
  note              TEXT NOT NULL DEFAULT '',
  occurred_on       DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Additive migrations for databases created before these columns existed.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recurring_rule_id BIGINT REFERENCES recurring_rules(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'personal';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_scope_check') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_scope_check CHECK (scope IN ('personal', 'home'));
  END IF;
END $$;

-- One generated movimento per rule per month. The ::timestamp cast forces the
-- IMMUTABLE date_trunc overload (the date/timestamptz one is only STABLE).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tx_rule_month
  ON transactions (recurring_rule_id, (date_trunc('month', occurred_on::timestamp)))
  WHERE recurring_rule_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions (user_id, occurred_on);
CREATE INDEX IF NOT EXISTS idx_tx_user_category ON transactions (user_id, category_id);
CREATE INDEX IF NOT EXISTS idx_tx_user_account ON transactions (user_id, account_id);
CREATE INDEX IF NOT EXISTS idx_tx_user_scope ON transactions (user_id, scope);
CREATE INDEX IF NOT EXISTS idx_cat_user ON categories (user_id);
CREATE INDEX IF NOT EXISTS idx_acc_user ON accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_rec_user ON recurring_rules (user_id);
CREATE INDEX IF NOT EXISTS idx_planned_user ON planned_expenses (user_id);
