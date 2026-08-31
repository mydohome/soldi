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

CREATE TABLE IF NOT EXISTS transactions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('expense', 'income')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  category_id  BIGINT REFERENCES categories(id) ON DELETE SET NULL,
  account_id   BIGINT REFERENCES accounts(id) ON DELETE SET NULL,
  scope        TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'home')),
  note         TEXT NOT NULL DEFAULT '',
  occurred_on  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Additive migrations for databases created before accounts/scope existed.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'personal';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_scope_check') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_scope_check CHECK (scope IN ('personal', 'home'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions (user_id, occurred_on);
CREATE INDEX IF NOT EXISTS idx_tx_user_category ON transactions (user_id, category_id);
CREATE INDEX IF NOT EXISTS idx_tx_user_account ON transactions (user_id, account_id);
CREATE INDEX IF NOT EXISTS idx_tx_user_scope ON transactions (user_id, scope);
CREATE INDEX IF NOT EXISTS idx_cat_user ON categories (user_id);
CREATE INDEX IF NOT EXISTS idx_acc_user ON accounts (user_id);
