-- Sornix Express WiFi - D1 schema (apply with: npx wrangler d1 execute sornix-wifi --file=schema.sql --remote)

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS plans (
  plan_id            TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  price              INTEGER NOT NULL DEFAULT 0,
  validity           TEXT NOT NULL DEFAULT '1d',     -- RouterOS time: 12h, 1d, 7d, 30d ...
  rate_limit         TEXT NOT NULL DEFAULT '2M/5M',  -- upload/download as RouterOS rate-limit
  shared_users       INTEGER NOT NULL DEFAULT 1,
  is_featured_on_login INTEGER NOT NULL DEFAULT 1,
  active             INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS accounts (
  username   TEXT PRIMARY KEY,
  pass_enc   TEXT NOT NULL,        -- AES-GCM ciphertext (key derived from OTP_SALT); plaintext needed to provision router
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  order_id     TEXT PRIMARY KEY,   -- SX-1A2B3C4D
  plan_id      TEXT NOT NULL,
  id_type      TEXT NOT NULL,      -- mac | device | account
  identifier   TEXT NOT NULL,      -- MAC AA:BB:.. or username
  phone        TEXT DEFAULT '',
  status       TEXT NOT NULL,      -- requested | approved | activated | rejected | revoking | revoked
  paid_via     TEXT,               -- bank | paystack | flutterwave
  reference    TEXT,               -- gateway reference (unique when set)
  amount_paid  INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  paid_at      TEXT,
  activated_at TEXT,
  expires_at   TEXT,               -- when the router user must be removed
  sms_notify   INTEGER NOT NULL DEFAULT 0,   -- customer opted into SMS updates (+sms_fee)
  sms_phone    TEXT NOT NULL DEFAULT '',      -- normalized 234... number for SMS updates
  sms_sent     INTEGER NOT NULL DEFAULT 0     -- receipt/activation SMS already sent
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_ident  ON orders(identifier);

CREATE TABLE IF NOT EXISTS vouchers (
  code       TEXT PRIMARY KEY,     -- XXXX-XXXX-XXXX
  plan_id    TEXT NOT NULL,
  status     TEXT NOT NULL,        -- new | used | deleted
  used_by    TEXT,                 -- MAC of first session
  batch      TEXT,
  created_at TEXT NOT NULL,
  used_at    TEXT,
  expires_at TEXT,
  phone      TEXT                  -- customer phone captured at voucher login (follow-up)
);
CREATE INDEX IF NOT EXISTS idx_vouch_status ON vouchers(status);

CREATE TABLE IF NOT EXISTS voucher_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  code   TEXT NOT NULL,
  at     TEXT NOT NULL,
  event  TEXT NOT NULL,          -- created | first_login | expired | deleted
  detail TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ve_code ON voucher_events(code);

CREATE TABLE IF NOT EXISTS voucher_sessions (
  code       TEXT NOT NULL,
  mac        TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  PRIMARY KEY (code, mac)
);

CREATE TABLE IF NOT EXISTS whitelist (
  mac        TEXT PRIMARY KEY,
  note       TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS banners (
  id        TEXT PRIMARY KEY,
  image_url TEXT NOT NULL,
  link_url  TEXT DEFAULT '',
  sort      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS gateways (
  gateway    TEXT PRIMARY KEY,     -- paystack | flutterwave | monnify
  enabled    INTEGER NOT NULL DEFAULT 0,
  public_key TEXT DEFAULT '',
  secret_key TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  who    TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS otp (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sends      INTEGER NOT NULL DEFAULT 0,
  sent_at    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tokens (
  tok_hash   TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS router_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
