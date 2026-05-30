require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 3002;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production';

// ─── PostgreSQL ───────────────────────────────────────────
// Parsiramo DATABASE_URL ručno da izbjegnemo probleme sa specijalnim znakovima
function buildPoolConfig() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL nije postavljen u .env');
  const u = new URL(url);
  return {
    host:     u.hostname,
    port:     parseInt(u.port) || 5432,
    database: u.pathname.slice(1),
    user:     u.username,
    password: decodeURIComponent(u.password),
    ssl:      false
  };
}
const pool = new Pool(buildPoolConfig());

// ─── Middleware ───────────────────────────────────────────
app.use(compression());
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || 'https://berzakatalizatora.com',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files (frontend + uploads)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── Multer (upload slika) ────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Samo slike su dozvoljene'));
  }
});

// ─── JWT Auth Middleware ──────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Niste prijavljeni' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token nije validan' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Zabranjen pristup' });
  next();
}

// ─── Server-side cache ───────────────────────────────────────
const _serverCache = {};
function getCached(key) {
  const entry = _serverCache[key];
  if (entry && (Date.now() - entry.ts) < 30000) return entry.data;
  return null;
}
function setCache(key, data) { _serverCache[key] = { data, ts: Date.now() }; }
function invalidateCache(key) { delete _serverCache[key]; }

// ═══════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, role, city, addr, tel, country } = req.body;
    if (!email || !password || !name || !role) {
      return res.status(400).json({ error: 'Popunite sva obavezna polja' });
    }
    if (!['seller', 'buyer'].includes(role)) {
      return res.status(400).json({ error: 'Nevažeća uloga' });
    }
    const userCountry = ['BA','RS'].includes(country) ? country : 'BA';

    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'Email već postoji' });
    }

    const hash = await bcrypt.hash(password, 10);
    const status = role === 'buyer' ? 'pending' : 'approved';

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, role, status, city, addr, tel, country)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, email, name, role, status, city, addr, tel, premium, country, created_at`,
      [email.toLowerCase(), hash, name, role, status, city || '', addr || '', tel || '', userCountry]
    );

    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, role: user.role, email: user.email, country: user.country }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ user, token });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Greška pri registraciji' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query(
      `SELECT id, email, name, role, status, city, addr, tel, premium, premium_until, country, password_hash
       FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Pogrešan email ili lozinka' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Pogrešan email ili lozinka' });

    delete user.password_hash;
    const token = jwt.sign({ id: user.id, role: user.role, email: user.email, country: user.country }, JWT_SECRET, { expiresIn: '30d' });

    res.json({ user, token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Greška pri prijavi' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, name, role, status, city, addr, tel, premium, premium_until, default_dana, country
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Korisnik ne postoji' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// PUT /api/auth/profile
app.put('/api/auth/profile', auth, async (req, res) => {
  try {
    const { name, city, addr, tel, default_dana } = req.body;
    const result = await pool.query(
      `UPDATE users SET name=$1, city=$2, addr=$3, tel=$4, default_dana=$5
       WHERE id=$6
       RETURNING id, email, name, role, status, city, addr, tel, premium, default_dana`,
      [name, city, addr, tel, default_dana || 3, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Greška pri ažuriranju' });
  }
});

// ═══════════════════════════════════════════════════════════
// LISTINGS ROUTES
// ═══════════════════════════════════════════════════════════

// GET /api/listings  (buyers i admin vide sve aktivne; seller vidi svoje)
app.get('/api/listings', auth, async (req, res) => {
  try {
    // Cache key po roli i kontekstu
    const cacheKey = req.user.role === 'seller' ? `listings_seller_${req.user.id}`
                   : req.user.role === 'admin'  ? 'listings_admin'
                   : `listings_buyer_${req.user.country||'BA'}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    let query, params;

    if (req.user.role === 'seller') {
      query = `
        SELECT l.id, l.user_id, l.broj, l.marka, l.model, l.god, l.stanje, l.nap, 
               l.images, l.status, l.country, l.created_at,
               u.name as owner_name, u.city as owner_city, u.tel as owner_tel,
               COUNT(p.id) as ponuda_count
        FROM listings l
        JOIN users u ON u.id = l.user_id
        LEFT JOIN ponude p ON p.listing_id = l.id
        WHERE l.user_id = $1::integer
        GROUP BY l.id, l.user_id, l.broj, l.marka, l.model, l.god, l.stanje, l.nap,
                 l.images, l.status, l.country, l.created_at, u.name, u.city, u.tel
        ORDER BY l.created_at DESC`;
      params = [parseInt(req.user.id)];
      const debugResult = await pool.query(query, params);
      return res.json(debugResult.rows.map(l => ({ ...l, images: (() => { try { return Array.isArray(l.images) ? l.images : JSON.parse(l.images||'[]'); } catch(e) { return []; } })() })));
    } else if (req.user.role === 'admin') {
      // Admin vidi SVE oglase bez filtera
      query = `
        SELECT l.id, l.user_id, l.broj, l.marka, l.model, l.god, l.stanje, l.nap,
               l.images, l.status, l.country, l.created_at,
               u.name as owner_name, u.city as owner_city, u.tel as owner_tel,
               COUNT(p.id) as ponuda_count
        FROM listings l
        JOIN users u ON u.id = l.user_id
        LEFT JOIN ponude p ON p.listing_id = l.id
        GROUP BY l.id, l.user_id, l.broj, l.marka, l.model, l.god, l.stanje, l.nap,
                 l.images, l.status, l.country, l.created_at, u.name, u.city, u.tel
        ORDER BY l.created_at DESC`;
      params = [];
    } else {
      // Buyer vidi samo aktivne iz svoje zemlje
      query = `
        SELECT l.id, l.user_id, l.broj, l.marka, l.model, l.god, l.stanje, l.nap,
               l.images, l.status, l.country, l.created_at,
               u.name as owner_name, u.city as owner_city, u.tel as owner_tel,
               COUNT(p.id) as ponuda_count
        FROM listings l
        JOIN users u ON u.id = l.user_id
        LEFT JOIN ponude p ON p.listing_id = l.id
        WHERE l.status = 'active' AND l.country = $1
        GROUP BY l.id, l.user_id, l.broj, l.marka, l.model, l.god, l.stanje, l.nap,
                 l.images, l.status, l.country, l.created_at, u.name, u.city, u.tel
        ORDER BY l.created_at DESC`;
      params = [req.user.country || 'BA'];
    }

    const result = await pool.query(query, params);

    // Ako je buyer — dodaj info o vlastitim ponudama + fetchaj završene oglase
    if (req.user.role === 'buyer') {
      const myPonude = await pool.query(
        `SELECT * FROM ponude WHERE buyer_id = $1`, [req.user.id]
      );
      const ponudeMap = {};
      myPonude.rows.forEach(p => {
        if (!ponudeMap[p.listing_id]) ponudeMap[p.listing_id] = [];
        ponudeMap[p.listing_id].push(p);
      });
      result.rows.forEach(l => {
        l.my_ponude = ponudeMap[l.id] || [];
      });

      // Dodaj završene oglase gdje je buyer pobijedio (prihvaćena ponuda)
      const finishedIds = myPonude.rows
        .filter(p => p.status === 'accepted')
        .map(p => p.listing_id);
      if (finishedIds.length > 0) {
        const finishedRes = await pool.query(
          `SELECT l.*, u.name as owner_name, u.city as owner_city, u.tel as owner_tel
           FROM listings l JOIN users u ON u.id = l.user_id
           WHERE l.id = ANY($1)`,
          [finishedIds]
        );
        finishedRes.rows.forEach(l => {
          if (!result.rows.find(r => r.id === l.id)) {
            l.my_ponude = ponudeMap[l.id] || [];
            result.rows.push(l);
          }
        });
      }
    }

    const response = result.rows.map(l => ({
      ...l,
      images: (() => { try { return Array.isArray(l.images) ? l.images : JSON.parse(l.images||'[]'); } catch(e) { return []; } })()
    }));
    const cacheKey2 = req.user.role === 'seller' ? `listings_seller_${req.user.id}`
                    : req.user.role === 'admin'  ? 'listings_admin'
                    : `listings_buyer_${req.user.country||'BA'}`;
    setCache(cacheKey2, response);
    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška pri dohvatu oglasa' });
  }
});

// GET /api/listings/:id
app.get('/api/listings/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, u.name as owner_name, u.city as owner_city, u.tel as owner_tel, u.addr as owner_addr
       FROM listings l JOIN users u ON u.id = l.user_id
       WHERE l.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Oglas ne postoji' });

    const listing = result.rows[0];

    // Ponude — seller vidi sve, buyer samo svoje
    let ponudeQuery, ponudeParams;
    if (req.user.role === 'seller' && listing.user_id === req.user.id) {
      ponudeQuery = `
        SELECT p.*, u.name as buyer_name, u.city as buyer_city, u.tel as buyer_tel, u.addr as buyer_addr
        FROM ponude p JOIN users u ON u.id = p.buyer_id
        WHERE p.listing_id = $1 ORDER BY p.cijena DESC`;
      ponudeParams = [req.params.id];
    } else if (req.user.role === 'buyer') {
      ponudeQuery = `SELECT * FROM ponude WHERE listing_id = $1 AND buyer_id = $2`;
      ponudeParams = [req.params.id, req.user.id];
    } else if (req.user.role === 'admin') {
      ponudeQuery = `
        SELECT p.*, u.name as buyer_name, u.city as buyer_city
        FROM ponude p JOIN users u ON u.id = p.buyer_id
        WHERE p.listing_id = $1 ORDER BY p.cijena DESC`;
      ponudeParams = [req.params.id];
    }

    if (ponudeQuery) {
      const ponude = await pool.query(ponudeQuery, ponudeParams);
      listing.ponude = ponude.rows;
    }

    res.json(listing);
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// POST /api/listings  (samo seller)
app.post('/api/listings', auth, async (req, res) => {
  try {
    if (req.user.role !== 'seller') return res.status(403).json({ error: 'Samo prodavci mogu objavljivati' });

    const { broj, marka, model, god, stanje, nap, images } = req.body;
    if (!marka) {
      return res.status(400).json({ error: 'Marka vozila je obavezna' });
    }

    const result = await pool.query(
      `INSERT INTO listings (user_id, broj, marka, model, god, stanje, nap, images, status, country)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)
       RETURNING *`,
      [req.user.id, broj||'', marka, model||'', god||'', stanje||'Nepoznato', nap||'',
       JSON.stringify(images||[]), req.user.country || 'BA']
    );

        // Invalidate listings cache
    Object.keys(_serverCache).filter(k => k.startsWith('listings_')).forEach(k => invalidateCache(k));
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška pri objavi' });
  }
});

// DELETE /api/listings/:id  (seller briše svoje, admin briše sve)
app.delete('/api/listings/:id', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ne postoji' });

    const listing = result.rows[0];
    if (req.user.role !== 'admin' && listing.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Zabranjen pristup' });
    }

    if (req.user.role === 'admin') {
      // Admin: hard delete iz baze (ponude se brišu CASCADE ili ručno)
      await pool.query('DELETE FROM ponude WHERE listing_id = $1', [req.params.id]);
      await pool.query('DELETE FROM messages WHERE listing_id = $1', [req.params.id]);
      await pool.query('DELETE FROM listings WHERE id = $1', [req.params.id]);
    } else {
      // Seller: soft delete
      await pool.query('UPDATE listings SET status = $1 WHERE id = $2', ['deleted', req.params.id]);
    }
        // Invalidate listings cache
    Object.keys(_serverCache).filter(k => k.startsWith('listings_')).forEach(k => invalidateCache(k));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška pri brisanju' });
  }
});

// PUT /api/listings/:id/status  (seller označava kao završeno/poslato)
app.put('/api/listings/:id/status', auth, async (req, res) => {
  try {
    const { status } = req.body; // 'finished' | 'sent'
    const listing = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    if (!listing.rows[0]) return res.status(404).json({ error: 'Ne postoji' });
    if (listing.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Zabranjen pristup' });
    }

    await pool.query('UPDATE listings SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// ═══════════════════════════════════════════════════════════
// PONUDE ROUTES
// ═══════════════════════════════════════════════════════════

// POST /api/ponude  (buyer šalje ponudu)
app.post('/api/ponude', auth, async (req, res) => {
  try {
    if (req.user.role !== 'buyer') return res.status(403).json({ error: 'Samo kupci mogu slati ponude' });

    // Provjeri status usera
    const user = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (user.rows[0].status !== 'approved') {
      return res.status(403).json({ error: 'Vaš nalog nije odobren' });
    }

    // Daily limit za free korisnike
    if (!user.rows[0].premium) {
      const today = new Date().toISOString().split('T')[0];
      const count = await pool.query(
        `SELECT COUNT(*) FROM ponude WHERE buyer_id = $1 AND DATE(created_at) = $2`,
        [req.user.id, today]
      );
      if (parseInt(count.rows[0].count) >= 10) {
        return res.status(429).json({ error: 'Dostigli ste dnevni limit od 10 ponuda' });
      }
    }

    const { listing_id, cijena, dani } = req.body;
    if (!listing_id || !cijena || !dani) {
      return res.status(400).json({ error: 'Nedostaju podaci' });
    }

    // Provjeri da oglas postoji i aktivan je
    const listing = await pool.query(
      'SELECT * FROM listings WHERE id = $1 AND status = $2', [listing_id, 'active']
    );
    if (!listing.rows[0]) return res.status(404).json({ error: 'Oglas nije aktivan' });

    // Provjeri da buyer nije vlasnik
    if (listing.rows[0].user_id === req.user.id) {
      return res.status(400).json({ error: 'Ne možete slati ponudu na vlastiti oglas' });
    }

    const expires_at = new Date(Date.now() + dani * 86400000);

    const result = await pool.query(
      `INSERT INTO ponude (listing_id, buyer_id, cijena, dani, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [listing_id, req.user.id, cijena, dani, expires_at]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška pri slanju ponude' });
  }
});

// GET /api/ponude/my  (buyer vidi svoje ponude)
app.get('/api/ponude/my', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*,
              l.marka, l.model, l.god, l.broj, l.stanje, l.status as listing_status,
              l.images as listing_images,
              u.name as owner_name, u.city as owner_city, u.tel as owner_tel,
              buyer.name as buyer_name, buyer.city as buyer_city,
              buyer.tel as buyer_tel, buyer.addr as buyer_addr
       FROM ponude p
       JOIN listings l ON l.id = p.listing_id
       JOIN users u ON u.id = l.user_id
       JOIN users buyer ON buyer.id = p.buyer_id
       WHERE p.buyer_id = $1
       ORDER BY p.created_at DESC`,
      [req.user.id]
    );
    const rows = result.rows.map(r => ({
      ...r,
      listing_image: (() => { try { const imgs = JSON.parse(r.listing_images||'[]'); return imgs[0]||null; } catch(e){ return null; } })()
    }));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// PUT /api/ponude/:id/accept  (seller prihvata ponudu)
app.put('/api/ponude/:id/accept', auth, async (req, res) => {
  try {
    const ponuda = await pool.query(
      `SELECT p.*, l.user_id as seller_id FROM ponude p
       JOIN listings l ON l.id = p.listing_id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!ponuda.rows[0]) return res.status(404).json({ error: 'Ne postoji' });
    if (ponuda.rows[0].seller_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Zabranjen pristup' });
    }

    await pool.query(`UPDATE ponude SET status = 'accepted' WHERE id = $1`, [req.params.id]);
    // Ostale ponude za isti oglas — reject
    await pool.query(
      `UPDATE ponude SET status = 'rejected' WHERE listing_id = $1 AND id != $2`,
      [ponuda.rows[0].listing_id, req.params.id]
    );
    // Oglas označiti kao završen
    await pool.query(
      `UPDATE listings SET status = 'finished', accepted_ponuda_id = $1 WHERE id = $2`,
      [req.params.id, ponuda.rows[0].listing_id]
    );
        // Invalidate listings cache
    Object.keys(_serverCache).filter(k => k.startsWith('listings_')).forEach(k => invalidateCache(k));

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// PUT /api/ponude/:id/reject
app.put('/api/ponude/:id/reject', auth, async (req, res) => {
  try {
    const ponuda = await pool.query(
      `SELECT p.*, l.user_id as seller_id FROM ponude p
       JOIN listings l ON l.id = p.listing_id WHERE p.id = $1`,
      [req.params.id]
    );
    if (!ponuda.rows[0]) return res.status(404).json({ error: 'Ne postoji' });
    if (ponuda.rows[0].seller_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Zabranjen pristup' });
    }
    await pool.query(`UPDATE ponude SET status = 'rejected' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// ═══════════════════════════════════════════════════════════
// CHAT ROUTES
// ═══════════════════════════════════════════════════════════

// GET /api/chat/inbox  — sve konverzacije za trenutnog korisnika
app.get('/api/chat/inbox', auth, async (req, res) => {
  try {
    let query, params;
    if (req.user.role === 'seller') {
      query = `
        SELECT m.listing_id,
               m.sender_id as buyer_id,
               u.name as buyer_name,
               l.marka, l.model,
               MAX(m.created_at) as last_at,
               (SELECT text FROM messages m2 WHERE m2.listing_id=m.listing_id AND m2.sender_id=m.sender_id ORDER BY m2.created_at DESC LIMIT 1) as last_text,
               COUNT(CASE WHEN m.receiver_id=$1 AND m.read_at IS NULL THEN 1 END) as unread_count
        FROM messages m
        JOIN listings l ON l.id = m.listing_id
        JOIN users u ON u.id = m.sender_id
        WHERE l.user_id = $1 AND m.sender_id != $1
        GROUP BY m.listing_id, m.sender_id, u.name, l.marka, l.model
        ORDER BY last_at DESC`;
      params = [req.user.id];
    } else {
      query = `
        SELECT m.listing_id,
               l.user_id as seller_id,
               u.name as seller_name,
               l.marka, l.model,
               MAX(m.created_at) as last_at,
               (SELECT text FROM messages m2 WHERE m2.listing_id=m.listing_id AND (m2.sender_id=$1 OR m2.receiver_id=$1) ORDER BY m2.created_at DESC LIMIT 1) as last_text,
               COUNT(CASE WHEN m.receiver_id=$1 AND m.read_at IS NULL THEN 1 END) as unread_count
        FROM messages m
        JOIN listings l ON l.id = m.listing_id
        JOIN users u ON u.id = l.user_id
        WHERE m.sender_id = $1 OR m.receiver_id = $1
        GROUP BY m.listing_id, l.user_id, u.name, l.marka, l.model
        ORDER BY last_at DESC`;
      params = [req.user.id];
    }
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Greška' });
  }
});

// GET /api/chat/:listing_id  (dohvati poruke za oglas — između sellera i buyera)
app.get('/api/chat/:listing_id', auth, async (req, res) => {
  try {
    const listing = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.listing_id]);
    if (!listing.rows[0]) return res.status(404).json({ error: 'Ne postoji' });

    let query, params;
    if (req.user.role === 'admin') {
      // Admin vidi sve razgovore za oglas
      query = `SELECT m.*, u.name as sender_name FROM messages m
               JOIN users u ON u.id = m.sender_id
               WHERE m.listing_id = $1 ORDER BY m.created_at ASC`;
      params = [req.params.listing_id];
    } else if (req.user.role === 'seller' && listing.rows[0].user_id === req.user.id) {
      const { buyer_id } = req.query;
      query = `SELECT m.*, u.name as sender_name FROM messages m
               JOIN users u ON u.id = m.sender_id
               WHERE m.listing_id = $1 AND (m.sender_id = $2 OR m.receiver_id = $2)
               ORDER BY m.created_at ASC`;
      params = [req.params.listing_id, buyer_id];
    } else {
      // Buyer vidi razgovor sa sellerom
      query = `SELECT m.*, u.name as sender_name FROM messages m
               JOIN users u ON u.id = m.sender_id
               WHERE m.listing_id = $1 AND (m.sender_id = $2 OR m.receiver_id = $2)
               ORDER BY m.created_at ASC`;
      params = [req.params.listing_id, req.user.id];
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// POST /api/chat/:listing_id
app.post('/api/chat/:listing_id', auth, async (req, res) => {
  try {
    const { receiver_id, text, image_url } = req.body;
    if (!receiver_id || (!text && !image_url)) {
      return res.status(400).json({ error: 'Nedostaju podaci' });
    }

    const result = await pool.query(
      `INSERT INTO messages (listing_id, sender_id, receiver_id, text, image_url)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.listing_id, req.user.id, receiver_id, text || null, image_url || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// ═══════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════

// GET /api/admin/users
app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, name, role, status, city, tel, premium, premium_until, country, created_at
       FROM users ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// PUT /api/admin/users/:id/approve
app.put('/api/admin/users/:id/approve', auth, adminOnly, async (req, res) => {
  try {
    await pool.query(`UPDATE users SET status = 'approved' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// PUT /api/admin/users/:id/reject
app.put('/api/admin/users/:id/reject', auth, adminOnly, async (req, res) => {
  try {
    await pool.query(`UPDATE users SET status = 'rejected' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// PUT /api/admin/users/:id/premium
app.put('/api/admin/users/:id/premium', auth, adminOnly, async (req, res) => {
  try {
    const { months } = req.body;
    const until = new Date(Date.now() + (months || 1) * 30 * 86400000);
    await pool.query(`UPDATE users SET premium = true, premium_until = $1 WHERE id = $2`, [until, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// DELETE /api/admin/users/:id/premium
app.delete('/api/admin/users/:id/premium', auth, adminOnly, async (req, res) => {
  try {
    await pool.query(`UPDATE users SET premium = false, premium_until = NULL WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// DELETE /api/admin/users/:id
app.delete('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Ne možete obrisati vlastiti nalog' });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// GET /api/admin/ponude
app.get('/api/admin/ponude', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, l.marka, l.model FROM ponude p JOIN listings l ON l.id = p.listing_id ORDER BY p.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// GET /api/admin/stats
app.get('/api/admin/stats', auth, adminOnly, async (req, res) => {
  try {
    const [users, listings, ponude, pending] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users WHERE role != $1', ['admin']),
      pool.query(`SELECT COUNT(*) FROM listings WHERE status = 'active'`),
      pool.query(`SELECT COUNT(*) FROM ponude WHERE status = 'pending'`),
      pool.query(`SELECT COUNT(*) FROM users WHERE status = 'pending'`)
    ]);
    res.json({
      users: parseInt(users.rows[0].count),
      listings: parseInt(listings.rows[0].count),
      ponude: parseInt(ponude.rows[0].count),
      pending_users: parseInt(pending.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// ═══════════════════════════════════════════════════════════
// UPLOAD ROUTE
// ═══════════════════════════════════════════════════════════
app.post('/api/upload', auth, (req, res, next) => {
  upload.array('images', 10)(req, res, err => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Slika je prevelika (max 5MB po slici)' });
      }
      return res.status(400).json({ error: err.message || 'Upload greška' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Nije uploadovana nijedna slika' });
    }
    const urls = req.files.map(f => `/uploads/${f.filename}`);
    res.json({ urls });
  });
});

// ─── SPA fallback ─────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── DB migration ────────────────────────────────────────
(async () => {
  try {
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ`);
    console.log('✅ DB migration OK');
  } catch(e) { console.error('Migration error:', e.message); }
})();

// ─── PUT /api/chat/:listing_id/read  — označi poruke kao pročitane
app.put('/api/chat/:listing_id/read', auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE messages SET read_at = NOW() WHERE listing_id = $1 AND receiver_id = $2 AND read_at IS NULL`,
      [req.params.listing_id, req.user.id]
    );
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: 'Greška' }); }
});

// ─── Start ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Berza Katalizatora backend — port ${PORT}`);
});

module.exports = app;
