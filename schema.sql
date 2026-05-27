-- ═══════════════════════════════════════════════════════════
-- Berza Katalizatora — PostgreSQL Schema
-- Pokrenuti: psql -U berza -d berza_db -f schema.sql
-- ═══════════════════════════════════════════════════════════

-- Korisnici
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(255) NOT NULL,
  role          VARCHAR(20)  NOT NULL CHECK (role IN ('seller','buyer','admin')),
  status        VARCHAR(20)  NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  city          VARCHAR(100) DEFAULT '',
  addr          VARCHAR(255) DEFAULT '',
  tel           VARCHAR(50)  DEFAULT '',
  premium       BOOLEAN      DEFAULT FALSE,
  premium_until TIMESTAMPTZ,
  default_dana  INTEGER      DEFAULT 3,
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

-- Oglasi
CREATE TABLE IF NOT EXISTS listings (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broj                VARCHAR(100) NOT NULL,          -- OEM broj katalizatora
  marka               VARCHAR(100) NOT NULL,
  model               VARCHAR(100) NOT NULL,
  god                 VARCHAR(10)  NOT NULL,           -- godina
  stanje              VARCHAR(100) NOT NULL,
  nap                 TEXT         DEFAULT '',         -- napomena
  images              JSONB        DEFAULT '[]',       -- array URL-ova slika
  status              VARCHAR(20)  NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','finished','sent','deleted')),
  accepted_ponuda_id  INTEGER,
  created_at          TIMESTAMPTZ  DEFAULT NOW()
);

-- Ponude (kupovne ponude)
CREATE TABLE IF NOT EXISTS ponude (
  id          SERIAL PRIMARY KEY,
  listing_id  INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  buyer_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cijena      NUMERIC(10,2) NOT NULL,
  dani        INTEGER NOT NULL DEFAULT 3,
  expires_at  TIMESTAMPTZ NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','rejected','expired')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(listing_id, buyer_id)   -- jedan buyer — jedna ponuda po oglasu
);

-- Poruke (chat)
CREATE TABLE IF NOT EXISTS messages (
  id          SERIAL PRIMARY KEY,
  listing_id  INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT,
  image_url   VARCHAR(500),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indeksi
CREATE INDEX IF NOT EXISTS idx_listings_user    ON listings(user_id);
CREATE INDEX IF NOT EXISTS idx_listings_status  ON listings(status);
CREATE INDEX IF NOT EXISTS idx_ponude_listing   ON ponude(listing_id);
CREATE INDEX IF NOT EXISTS idx_ponude_buyer     ON ponude(buyer_id);
CREATE INDEX IF NOT EXISTS idx_messages_listing ON messages(listing_id);
CREATE INDEX IF NOT EXISTS idx_messages_parties ON messages(sender_id, receiver_id);

-- Admin korisnik (promijeniti lozinku!)
INSERT INTO users (email, password_hash, name, role, status)
VALUES (
  'admin@berzakatalizatora.com',
  '$2a$10$placeholderHashMorasPokrenutiScriptZaHash',
  'Admin',
  'admin',
  'approved'
) ON CONFLICT (email) DO NOTHING;
