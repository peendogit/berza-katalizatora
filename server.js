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
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');

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
const pool = new Pool({
  ...buildPoolConfig(),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000
});

// ─── Middleware ───────────────────────────────────────────
app.use(compression());
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || 'https://berzakatalizatora.com',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Rate Limiting ────────────────────────────────────────
const globalLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Previše zahtjeva. Pokušajte ponovo za 15 minuta.' }
});
const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Previše pokušaja prijave. Pokušajte ponovo za 15 minuta.' }
});
const uploadLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Previše upload zahtjeva.' }
});
app.use('/api/', globalLimit);
app.use('/api/auth/login', authLimit);
app.use('/api/auth/register', authLimit);
app.use('/api/upload', uploadLimit);

// ─── Email (nodemailer) ───────────────────────────────────
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
});

async function sendEmail(to, subject, html) {
  if (!process.env.SMTP_USER) return; // ne šalje ako nije konfigurisan
  try {
    await mailer.sendMail({
      from: `"Berza Katalizatora" <${process.env.SMTP_USER}>`,
      to, subject, html
    });
  } catch(e) {
    console.error('Email error:', e.message);
  }
}

async function notifyUser(userId, subject, html) {
  try {
    const res = await pool.query(
      'SELECT email, email_notify FROM users WHERE id = $1', [userId]
    );
    if (res.rows[0] && res.rows[0].email_notify !== false) {
      await sendEmail(res.rows[0].email, subject, html);
    }
  } catch(e) { console.error('notifyUser error:', e.message); }
}

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
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    // Ako token nema st (stari token), propusti bez provjere
    if (!decoded.st) return next();
    // Provjeri session token u DB
    pool.query('SELECT session_token FROM users WHERE id = $1', [decoded.id])
      .then(r => {
        if (!r.rows[0]) return res.status(401).json({ error: 'Korisnik ne postoji' });
        if (r.rows[0].session_token !== decoded.st) {
          return res.status(401).json({ error: 'Prijavljeni ste na drugom uređaju. Molimo prijavite se ponovo.' });
        }
        next();
      })
      .catch(() => next()); // DB greška — propusti da ne blokiramo
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
    const { email, password, name, fullname, role, city, addr, tel, country, entity } = req.body;
    if (!email || !password || !name || !role || !addr || !addr.trim()) {
      return res.status(400).json({ error: 'Popunite sva obavezna polja (uključujući adresu)' });
    }
    if (!['seller', 'buyer'].includes(role)) {
      return res.status(400).json({ error: 'Nevažeća uloga' });
    }
    const userCountry = ['BA','RS'].includes(String(country||'').toUpperCase()) ? String(country).toUpperCase() : 'BA';

    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'Email već postoji' });
    }

    const nameExists = await pool.query('SELECT id FROM users WHERE LOWER(name) = LOWER($1)', [name.trim()]);
    if (nameExists.rows.length > 0) {
      return res.status(409).json({ error: entity === 'firma' ? 'Naziv firme je već zauzet' : 'Korisničko ime je već zauzeto' });
    }

    const hash = await bcrypt.hash(password, 10);
    const status = 'pending'; // svi novi korisnici čekaju odobrenje

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, fullname, role, status, city, addr, tel, country, entity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, email, name, fullname, role, status, city, addr, tel, premium, country, entity, created_at`,
      [email.toLowerCase(), hash, name, fullname||'', role, status, city||'', addr||'', tel||'', userCountry, entity||'fizicko']
    );

    const user = result.rows[0];
    const sessionToken = require('crypto').randomBytes(32).toString('hex');
    await pool.query('UPDATE users SET session_token = $1 WHERE id = $2', [sessionToken, user.id]);

    // Email adminu o novom korisniku
    const roleLabel = role === 'seller' ? 'Prodavač' : 'Otkupljivač';
    sendEmail(
      process.env.SMTP_USER,
      `🆕 Novi ${roleLabel} čeka odobrenje — ${name}`,
      `<p>Novi korisnik se registrovao i čeka odobrenje:</p>
       <ul>
         <li><b>Ime:</b> ${name}</li>
         <li><b>Uloga:</b> ${roleLabel}</li>
         <li><b>Email:</b> ${email}</li>
         <li><b>Grad:</b> ${city || '—'}</li>
         <li><b>Telefon:</b> ${tel || '—'}</li>
       </ul>
       <p>Prijavite se u admin panel da odobrite nalog.</p>`
    ).catch(() => {});

    const token = jwt.sign({ id: user.id, role: user.role, email: user.email, country: user.country, st: sessionToken }, JWT_SECRET, { expiresIn: '30d' });
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

    // Provjera statusa naloga
    if (user.status === 'pending') {
      return res.status(403).json({
        error: 'Vaš nalog čeka odobrenje administratora. Bićete obaviješteni kada nalog bude aktivan.',
        code: 'PENDING'
      });
    }
    if (user.status === 'blocked') {
      return res.status(403).json({
        error: 'Vaš nalog je blokiran. Kontaktirajte nas na berzakatalizatora@gmail.com',
        code: 'BLOCKED'
      });
    }

    delete user.password_hash;

    // Novi session token — poništava sve prethodne sesije
    const sessionToken = require('crypto').randomBytes(32).toString('hex');
    await pool.query('UPDATE users SET session_token = $1 WHERE id = $2', [sessionToken, user.id]);
    // Ažuriraj in-memory cache odmah

    const token = jwt.sign(
      { id: user.id, role: user.role, email: user.email, country: user.country, st: sessionToken },
      JWT_SECRET, { expiresIn: '30d' }
    );

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
    // Za buyera, country čitamo iz baze (stari JWT tokeni nemaju country claim)
    let userCountry = req.user.country;
    if (req.user.role === 'buyer' && !userCountry) {
      const cu = await pool.query('SELECT country FROM users WHERE id = $1', [req.user.id]);
      userCountry = (cu.rows[0] && cu.rows[0].country) || 'BA';
    }

    // Cache key po roli i kontekstu
    const cacheKey = req.user.role === 'seller' ? `listings_seller_${req.user.id}`
                   : req.user.role === 'admin'  ? 'listings_admin'
                   : `listings_buyer_${userCountry||'BA'}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    let query, params;

    if (req.user.role === 'seller') {
      query = `
        SELECT l.id, l.user_id, l.broj, l.marka, l.model, l.god, l.stanje, l.nap, 
               l.images, l.status, l.country, l.created_at,
               l.listing_type, l.lot_items,
               u.name as owner_name, u.city as owner_city, u.tel as owner_tel,
               COUNT(p.id) as ponuda_count,
               COUNT(CASE WHEN p.status = 'pending' THEN 1 END) as pending_count
        FROM listings l
        JOIN users u ON u.id = l.user_id
        LEFT JOIN ponude p ON p.listing_id = l.id
        WHERE l.user_id = $1::integer
        GROUP BY l.id, l.user_id, l.broj, l.marka, l.model, l.god, l.stanje, l.nap,
                 l.images, l.status, l.country, l.created_at, l.listing_type, l.lot_items,
                 u.name, u.city, u.tel
        ORDER BY l.created_at DESC`;
      params = [parseInt(req.user.id)];
    } else if (req.user.role === 'admin') {
      // Admin vidi SVE oglase bez filtera
      query = `
        SELECT l.id, l.user_id, l.broj, l.marka, l.model, l.god, l.stanje, l.nap,
               l.images, l.status, l.country, l.created_at,
               u.name as owner_name, u.city as owner_city, u.tel as owner_tel,
               COUNT(p.id) as ponuda_count,
               buyer.name as accepted_buyer_name, buyer.city as accepted_buyer_city,
               l.sold_at
        FROM listings l
        JOIN users u ON u.id = l.user_id
        LEFT JOIN ponude p ON p.listing_id = l.id
        LEFT JOIN ponude ap ON ap.listing_id = l.id AND ap.status = 'accepted'
        LEFT JOIN users buyer ON buyer.id = ap.buyer_id
        GROUP BY l.id, l.user_id, l.broj, l.marka, l.model, l.god, l.stanje, l.nap,
                 l.images, l.status, l.country, l.created_at, u.name, u.city, u.tel,
                 buyer.name, buyer.city
        ORDER BY l.created_at DESC`;
      params = [];
    } else {
      // Buyer vidi samo aktivne iz svoje zemlje
      query = `
        SELECT l.id, l.user_id, l.broj, l.marka, l.model, l.god, l.stanje, l.nap,
               l.images, l.status, l.country, l.created_at,
               l.listing_type, l.lot_items,
               u.name as owner_name, u.city as owner_city, u.tel as owner_tel,
               COUNT(p.id) as ponuda_count,
               (SELECT COUNT(*) FROM listings ls WHERE ls.user_id = l.user_id AND ls.status IN ('finished','sent')) as sales_count,
               ROUND((SELECT AVG(stars)::numeric FROM ratings r WHERE r.to_user_id = l.user_id), 1) as avg_rating,
               (SELECT COUNT(*) FROM ratings r WHERE r.to_user_id = l.user_id) as rating_count
        FROM listings l
        JOIN users u ON u.id = l.user_id
        LEFT JOIN ponude p ON p.listing_id = l.id
        WHERE l.status = 'active' AND l.country = $1
        GROUP BY l.id, l.user_id, l.broj, l.marka, l.model, l.god, l.stanje, l.nap,
                 l.images, l.status, l.country, l.created_at, l.listing_type, l.lot_items,
                 u.name, u.city, u.tel
        ORDER BY l.created_at DESC`;
      params = [userCountry || 'BA'];
    }

    const result = await pool.query(query, params);

    // Ako je buyer — dodaj info o vlastitim ponudama + fetchaj završene oglase
    if (req.user.role === 'buyer') {
      console.log(`📍 Buyer ${req.user.id} (country=${userCountry}): vraćeno ${result.rows.length} oglasa, countries: ${[...new Set(result.rows.map(r=>r.country))].join(',') || 'nijedan'}`);
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

      // Dodaj sve oglase gdje buyer ima bilo kakvu ponudu (rejected/accepted) a nisu u result
      const allPonudaListingIds = [...new Set(myPonude.rows.map(p => p.listing_id))];
      const missingIds = allPonudaListingIds.filter(id => !result.rows.find(r => r.id === id));
      if (missingIds.length > 0) {
        const missingRes = await pool.query(
          `SELECT l.*, u.name as owner_name, u.city as owner_city, u.tel as owner_tel
           FROM listings l JOIN users u ON u.id = l.user_id
           WHERE l.id = ANY($1)`,
          [missingIds]
        );
        missingRes.rows.forEach(l => {
          l.my_ponude = ponudeMap[l.id] || [];
          l.images = (() => { try { return Array.isArray(l.images) ? l.images : JSON.parse(l.images||'[]'); } catch(e) { return []; } })();
          result.rows.push(l);
        });
      }

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
                    : `listings_buyer_${userCountry||'BA'}`;
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
        SELECT p.*, u.name as buyer_name, u.city as buyer_city, u.tel as buyer_tel, u.addr as buyer_addr,
               (SELECT COUNT(*) FROM ponude pp WHERE pp.buyer_id = p.buyer_id AND pp.status = 'accepted') as buyer_transactions
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

    const { broj, marka, model, god, stanje, nap, images, listing_type, lot_items } = req.body;
    const isLot = listing_type === 'lot';

    if (!isLot && !marka) {
      return res.status(400).json({ error: 'Marka vozila je obavezna' });
    }
    if (isLot) {
      const items = lot_items || [];
      if (!items.length) return res.status(400).json({ error: 'Dodajte barem jedan katalizator u lot' });
      if (items.length > 50) return res.status(400).json({ error: 'Maksimalno 50 komada po lotu' });
    }

    // Country iz baze (stari JWT tokeni nemaju country claim)
    let sellerCountry = req.user.country;
    if (!sellerCountry) {
      const su = await pool.query('SELECT country FROM users WHERE id = $1', [req.user.id]);
      sellerCountry = (su.rows[0] && su.rows[0].country) || 'BA';
    }

    const result = await pool.query(
      `INSERT INTO listings (user_id, broj, marka, model, god, stanje, nap, images, status, country, listing_type, lot_items)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, $11)
       RETURNING *`,
      [
        req.user.id,
        isLot ? '' : (broj||''),
        isLot ? 'Lot' : marka,
        isLot ? '' : (model||''),
        isLot ? '' : (god||''),
        isLot ? '' : (stanje||'Nepoznato'),
        nap||'',
        JSON.stringify(images||[]),
        sellerCountry,
        isLot ? 'lot' : 'single',
        JSON.stringify(isLot ? (lot_items||[]) : [])
      ]
    );

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
    const { status } = req.body; // 'finished' | 'sent' | 'active'
    if (!['finished', 'sent', 'active'].includes(status)) {
      return res.status(400).json({ error: 'Nevažeći status' });
    }
    const listing = await pool.query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    if (!listing.rows[0]) return res.status(404).json({ error: 'Ne postoji' });
    if (listing.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Zabranjen pristup' });
    }

    const updateQuery = status === 'active'
      ? 'UPDATE listings SET status = $1, created_at = NOW() WHERE id = $2'
      : 'UPDATE listings SET status = $1 WHERE id = $2';
    await pool.query(updateQuery, [status, req.params.id]);

    // Pri reaktivaciji obriši stare expired/rejected ponude — oglas kreće od nule
    if (status === 'active') {
      await pool.query(
        `DELETE FROM ponude WHERE listing_id = $1 AND status IN ('expired', 'rejected')`,
        [req.params.id]
      );
    }
    Object.keys(_serverCache).filter(k => k.startsWith('listings_')).forEach(k => invalidateCache(k));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// ═══════════════════════════════════════════════════════════
// PONUDE ROUTES
// ═══════════════════════════════════════════════════════════

// GET /api/ponude/count-today — koliko ponuda je buyer poslao danas
app.get('/api/ponude/count-today', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await pool.query(
      `SELECT COUNT(*) FROM ponude WHERE buyer_id = $1 AND DATE(created_at) = $2 AND status != 'expired'`,
      [req.user.id, today]
    );
    res.json({ count: parseInt(result.rows[0].count) || 0 });
  } catch(err) { res.status(500).json({ error: 'Greška' }); }
});

// POST /api/ponude  (buyer šalje ponudu)
app.post('/api/ponude', auth, async (req, res) => {
  try {
    if (req.user.role !== 'buyer') return res.status(403).json({ error: 'Samo kupci mogu slati ponude' });

    // Provjeri status usera
    const user = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (user.rows[0].status !== 'approved') {
      return res.status(403).json({ error: 'Vaš nalog nije odobren' });
    }

    // Daily limit za free korisnike - broji samo today's ponude bez expired
    if (!user.rows[0].premium) {
      const today = new Date().toISOString().split('T')[0];
      const count = await pool.query(
        `SELECT COUNT(*) FROM ponude WHERE buyer_id = $1 AND DATE(created_at) = $2 AND status != 'expired'`,
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

    // Provjeri postojeću ponudu i broj pokušaja
    const existing = await pool.query(
      `SELECT * FROM ponude WHERE listing_id = $1 AND buyer_id = $2`,
      [listing_id, req.user.id]
    );

    if (existing.rows[0]) {
      const ex = existing.rows[0];
      if (ex.status === 'pending' || ex.status === 'accepted') {
        return res.status(400).json({ error: 'Već imate aktivnu ponudu za ovaj oglas' });
      }
      if (ex.status === 'rejected') {
        return res.status(400).json({ error: 'Vaša ponuda je odbijena. Ne možete ponovo ponuditi za ovaj oglas.' });
      }
      if (ex.status === 'expired') {
        return res.status(400).json({ error: 'Vaša ponuda je istekla. Ne možete ponovo ponuditi za ovaj oglas.' });
      }
    }

    const expires_at = new Date(Date.now() + dani * 86400000);

    const result = await pool.query(
      `INSERT INTO ponude (listing_id, buyer_id, cijena, dani, expires_at, status, attempt_count)
       VALUES ($1, $2, $3, $4, $5, 'pending', 1)
       ON CONFLICT (listing_id, buyer_id) DO UPDATE
         SET cijena = $3, dani = $4, expires_at = $5, status = 'pending', created_at = NOW(),
             attempt_count = COALESCE(ponude.attempt_count, 1) + 1
       WHERE ponude.status IN ('rejected', 'expired')
       RETURNING *`,
      [listing_id, req.user.id, cijena, dani, expires_at]
    );

    if (!result.rows[0]) {
      return res.status(400).json({ error: 'Već imate aktivnu ponudu za ovaj oglas' });
    }

    // Invalidate cache da buyer odmah vidi ažurirane podatke
    Object.keys(_serverCache).filter(k => k.startsWith('listings_')).forEach(k => invalidateCache(k));
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
      `SELECT p.*, l.user_id as seller_id, l.country FROM ponude p
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
      `UPDATE listings SET status = 'finished', accepted_ponuda_id = $1, sold_at = NOW() WHERE id = $2`,
      [req.params.id, ponuda.rows[0].listing_id]
    );
    await pool.query(
      `UPDATE ponude SET responded_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
        // Invalidate listings cache
    Object.keys(_serverCache).filter(k => k.startsWith('listings_')).forEach(k => invalidateCache(k));

    // Email notifikacija kupcu
    notifyUser(ponuda.rows[0].buyer_id,
      '✅ Vaša ponuda je prihvaćena — Berza Katalizatora',
      `<p>Dobra vijest! Vaša ponuda od <b>${ponuda.rows[0].cijena} ${(ponuda.rows[0].country||'BA')==='RS'?'EUR':'KM'}</b> za oglas je prihvaćena.</p>
       <p>Prodavač će vas kontaktirati ili pogledajte detalje na <a href="https://berzakatalizatora.com">berzakatalizatora.com</a>.</p>`
    ).catch(()=>{});

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// PUT /api/ponude/:id/reject
app.put('/api/ponude/:id/reject', auth, async (req, res) => {
  try {
    const ponuda = await pool.query(
      `SELECT p.*, l.user_id as seller_id, l.country FROM ponude p
       JOIN listings l ON l.id = p.listing_id WHERE p.id = $1`,
      [req.params.id]
    );
    if (!ponuda.rows[0]) return res.status(404).json({ error: 'Ne postoji' });
    if (ponuda.rows[0].seller_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Zabranjen pristup' });
    }
    await pool.query(`UPDATE ponude SET status = 'rejected', responded_at = NOW() WHERE id = $1`, [req.params.id]);

    // Email notifikacija kupcu
    notifyUser(ponuda.rows[0].buyer_id,
      'Vaša ponuda nije prihvaćena — Berza Katalizatora',
      `<p>Žao nam je, vaša ponuda od <b>${ponuda.rows[0].cijena} ${(ponuda.rows[0].country||'BA')==='RS'?'EUR':'KM'}</b> nije prihvaćena.</p>
       <p>Možete pogledati nove oglase na <a href="https://berzakatalizatora.com">berzakatalizatora.com</a>.</p>`
    ).catch(()=>{});

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// ═══════════════════════════════════════════════════════════
// CHAT ROUTES
// ═══════════════════════════════════════════════════════════

// GET /api/admin/chat/inbox/:uid  — konverzacije za bilo kojeg korisnika (admin)
app.get('/api/admin/chat/inbox/:uid', auth, adminOnly, async (req, res) => {
  try {
    const uid = parseInt(req.params.uid);
    const result = await pool.query(`
      SELECT m.listing_id,
             MAX(m.created_at) as last_at,
             (SELECT text FROM messages m2 WHERE m2.listing_id=m.listing_id AND (m2.sender_id=$1 OR m2.receiver_id=$1) ORDER BY m2.created_at DESC LIMIT 1) as last_text,
             l.marka, l.model,
             COUNT(m.id) as msg_count
      FROM messages m
      JOIN listings l ON l.id = m.listing_id
      WHERE m.sender_id = $1 OR m.receiver_id = $1
      GROUP BY m.listing_id, l.marka, l.model
      ORDER BY last_at DESC`, [uid]);
    res.json(result.rows);
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Greška' });
  }
});

// GET /api/admin/chat/:listing_id/:uid  — čitaj chat između sellera i buyera
app.get('/api/admin/chat/:listing_id/:uid', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, u.name as sender_name
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.listing_id = $1 AND (m.sender_id = $2 OR m.receiver_id = $2)
      ORDER BY m.created_at ASC`, [req.params.listing_id, req.params.uid]);
    res.json(result.rows);
  } catch(err) {
    res.status(500).json({ error: 'Greška' });
  }
});

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

    // Email notifikacija primaocu
    notifyUser(receiver_id,
      '💬 Nova poruka — Berza Katalizatora',
      `<p>Imate novu poruku na Berza Katalizatora.</p>
       <p>${text ? `"${text.slice(0,200)}"` : '(Slika)'}</p>
       <p><a href="https://berzakatalizatora.com">Otvorite aplikaciju →</a></p>`
    ).catch(()=>{});

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
    // Email korisniku
    notifyUser(req.params.id,
      '✅ Vaš nalog je odobren — Berza Katalizatora',
      `<p>Dobra vijest! Vaš nalog na Berza Katalizatora je odobren.</p>
       <p>Možete se odmah prijaviti na <a href="https://berzakatalizatora.com">berzakatalizatora.com</a>.</p>`
    ).catch(() => {});
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
    const { months, days } = req.body;
    const until = new Date(Date.now() + (days || (months||12) * 30) * 86400000);
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
      `SELECT p.*, l.marka, l.model, l.god, u.name as buyer_name
       FROM ponude p 
       JOIN listings l ON l.id = p.listing_id
       JOIN users u ON u.id = p.buyer_id
       ORDER BY p.created_at DESC`
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

// GET /api/admin/top-users — najbolji prodavači i otkupljivači
app.get('/api/admin/top-users', auth, adminOnly, async (req, res) => {
  try {
    const [topSellers, topBuyers] = await Promise.all([
      // Prodavači: broj oglasa, broj prodaja (finished/sent), ukupna vrijednost prodaja, prosječna ocjena
      pool.query(`
        SELECT u.id, u.name, u.city, u.country,
          COUNT(DISTINCT l.id) AS total_listings,
          COUNT(DISTINCT CASE WHEN l.status IN ('finished','sent') THEN l.id END) AS sales,
          COALESCE(SUM(CASE WHEN l.status IN ('finished','sent') THEN p.cijena END), 0) AS revenue,
          ROUND(AVG(r.stars)::numeric, 1) AS avg_rating,
          COUNT(DISTINCT r.id) AS rating_count
        FROM users u
        LEFT JOIN listings l ON l.user_id = u.id
        LEFT JOIN ponude p ON p.listing_id = l.id AND p.status = 'accepted'
        LEFT JOIN ratings r ON r.to_user_id = u.id
        WHERE u.role = 'seller'
        GROUP BY u.id, u.name, u.city, u.country
        HAVING COUNT(DISTINCT l.id) > 0
        ORDER BY sales DESC, revenue DESC
        LIMIT 10
      `),
      // Otkupljivači: broj ponuda, prihvaćene ponude, ukupna vrijednost otkupa, prosječna ocjena
      pool.query(`
        SELECT u.id, u.name, u.city, u.country,
          COUNT(DISTINCT p.id) AS total_ponude,
          COUNT(DISTINCT CASE WHEN p.status = 'accepted' THEN p.id END) AS accepted,
          COALESCE(SUM(CASE WHEN p.status = 'accepted' THEN p.cijena END), 0) AS spent,
          ROUND(AVG(r.stars)::numeric, 1) AS avg_rating,
          COUNT(DISTINCT r.id) AS rating_count
        FROM users u
        LEFT JOIN ponude p ON p.buyer_id = u.id
        LEFT JOIN ratings r ON r.to_user_id = u.id
        WHERE u.role = 'buyer'
        GROUP BY u.id, u.name, u.city, u.country
        HAVING COUNT(DISTINCT p.id) > 0
        ORDER BY accepted DESC, spent DESC
        LIMIT 10
      `)
    ]);
    res.json({ sellers: topSellers.rows, buyers: topBuyers.rows });
  } catch (err) {
    console.error('Top users error:', err.message);
    res.status(500).json({ error: 'Greška' });
  }
});

// ═══════════════════════════════════════════════════════════
// UPLOAD ROUTE
// ═══════════════════════════════════════════════════════════
app.post('/api/upload', auth, (req, res, next) => {
  upload.array('images', 50)(req, res, err => {
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

// ═══════════════════════════════════════════════════════════
// RATINGS ROUTES
// ═══════════════════════════════════════════════════════════

// POST /api/ratings  — ostavi rejting
app.post('/api/ratings', auth, async (req, res) => {
  try {
    const { to_user_id, listing_id, stars } = req.body;
    if (!to_user_id || !listing_id || !stars || stars < 1 || stars > 5) {
      return res.status(400).json({ error: 'Nevažeći podaci (zvjezdice 1-5)' });
    }

    // Provjeri da transakcija postoji i da korisnik ima pravo ocjenjivanja
    const check = await pool.query(`
      SELECT p.id, p.buyer_id, l.user_id as seller_id
      FROM ponude p
      JOIN listings l ON l.id = p.listing_id
      WHERE p.listing_id = $1 AND p.status = 'accepted'
    `, [listing_id]);

    if (!check.rows[0]) {
      return res.status(403).json({ error: 'Možete ocjeniti samo završene transakcije' });
    }

    const { buyer_id, seller_id } = check.rows[0];
    const uid = req.user.id;

    // Buyer ocjenjuje sellera, seller ocjenjuje buyera
    if (String(uid) !== String(buyer_id) && String(uid) !== String(seller_id)) {
      return res.status(403).json({ error: 'Nemate pravo ocjeniti ovu transakciju' });
    }
    if (String(uid) === String(to_user_id)) {
      return res.status(400).json({ error: 'Ne možete ocjeniti sami sebe' });
    }

    // Spremi ili ažuriraj rejting
    const result = await pool.query(`
      INSERT INTO ratings (from_user_id, to_user_id, listing_id, stars)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (from_user_id, listing_id) DO UPDATE SET stars = $4, updated_at = NOW()
      RETURNING *
    `, [uid, to_user_id, listing_id, Math.round(stars)]);

    res.status(201).json(result.rows[0]);
  } catch(err) {
    console.error('Rating error:', err);
    res.status(500).json({ error: 'Greška pri ocjenjivanju' });
  }
});

// GET /api/ratings/:user_id  — dohvati prosjecan rejting korisnika
app.get('/api/ratings/:user_id', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        ROUND(AVG(stars)::numeric, 1) as avg_stars,
        COUNT(*) as total
      FROM ratings WHERE to_user_id = $1
    `, [req.params.user_id]);
    const sales = await pool.query(`
      SELECT COUNT(*) as count FROM listings
      WHERE user_id = $1 AND status IN ('finished','sent')
    `, [req.params.user_id]);
    const buyerTx = await pool.query(`
      SELECT COUNT(*) as count FROM ponude
      WHERE buyer_id = $1 AND status = 'accepted'
    `, [req.params.user_id]);
    const userRes = await pool.query(`SELECT role FROM users WHERE id = $1`, [req.params.user_id]);
    const role = userRes.rows[0] ? userRes.rows[0].role : null;
    res.json({
      avg_stars: parseFloat(result.rows[0].avg_stars) || 0,
      total: parseInt(result.rows[0].total) || 0,
      sales_count: parseInt(sales.rows[0].count) || 0,
      buyer_transactions: parseInt(buyerTx.rows[0].count) || 0,
      role
    });
  } catch(err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// GET /api/ratings/check/:listing_id  — da li CU već ima rejting za ovaj oglas
app.get('/api/ratings/check/:listing_id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM ratings WHERE from_user_id = $1 AND listing_id = $2',
      [req.user.id, req.params.listing_id]
    );
    res.json({ rated: result.rows.length > 0, rating: result.rows[0] || null });
  } catch(err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// ═══════════════════════════════════════════════════════════
// BROADCAST ROUTES
// ═══════════════════════════════════════════════════════════

// POST /api/admin/broadcast  — admin šalje broadcast
app.post('/api/admin/broadcast', auth, adminOnly, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Poruka je obavezna' });
    }
    const result = await pool.query(
      'INSERT INTO broadcasts (admin_id, message) VALUES ($1, $2) RETURNING *',
      [req.user.id, message.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch(err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// GET /api/broadcasts/unread  — nepročitani broadcastovi za CU
app.get('/api/broadcasts/unread', auth, async (req, res) => {
  try {
    // Fetchaj datum registracije korisnika
    const userRes = await pool.query('SELECT created_at FROM users WHERE id = $1', [req.user.id]);
    const userCreatedAt = userRes.rows[0] ? userRes.rows[0].created_at : new Date();
    const result = await pool.query(`
      SELECT b.* FROM broadcasts b
      LEFT JOIN broadcast_reads br ON br.broadcast_id = b.id AND br.user_id = $1
      WHERE br.id IS NULL
        AND b.created_at > $2
      ORDER BY b.created_at DESC
      LIMIT 10
    `, [req.user.id, userCreatedAt]);
    res.json(result.rows);
  } catch(err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// POST /api/broadcasts/:id/read  — označi broadcast kao pročitan
app.post('/api/broadcasts/:id/read', auth, async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO broadcast_reads (broadcast_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// GET /api/admin/broadcasts  — lista svih broadcastova za admin
app.get('/api/admin/broadcasts', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT b.*, u.name as admin_name FROM broadcasts b JOIN users u ON u.id = b.admin_id ORDER BY b.created_at DESC LIMIT 50'
    );
    res.json(result.rows);
  } catch(err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// ═══════════════════════════════════════════════════════════
// EMAIL NOTIFY TOGGLE
// ═══════════════════════════════════════════════════════════

// PUT /api/auth/email-notify
app.put('/api/auth/email-notify', auth, async (req, res) => {
  try {
    const { email_notify } = req.body;
    await pool.query(
      'UPDATE users SET email_notify = $1 WHERE id = $2',
      [email_notify !== false, req.user.id]
    );
    res.json({ ok: true, email_notify: email_notify !== false });
  } catch(err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// GET /api/admin/listings/:id/ponude — sve ponude za oglas (admin)
app.get('/api/admin/listings/:id/ponude', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, u.name as buyer_name, u.city as buyer_city, u.tel as buyer_tel
      FROM ponude p
      JOIN users u ON u.id = p.buyer_id
      WHERE p.listing_id = $1
      ORDER BY p.cijena DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch(err) {
    res.status(500).json({ error: 'Greška' });
  }
});

// GET /api/metal-prices
app.get('/api/metal-prices', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM metal_prices_cache WHERE id = 1');
    const row = result.rows[0];
    if (!row || !row.updated_at) {
      return res.json({ available: false });
    }
    function trend(curr, prev) {
      if (prev === null || curr === null) return 'flat';
      const diff = ((curr - prev) / prev) * 100;
      if (diff > 1) return 'up';
      if (diff < -1) return 'down';
      return 'flat';
    }
    res.json({
      available: true,
      platinum: row.platinum,
      palladium: row.palladium,
      rhodium: row.rhodium,
      trends: {
        platinum: trend(row.platinum, row.prev_platinum),
        palladium: trend(row.palladium, row.prev_palladium),
        rhodium: trend(row.rhodium, row.prev_rhodium)
      },
      updated: row.updated_at
    });
  } catch(e) {
    res.json({ available: false });
  }
});

// ─── DB migration ────────────────────────────────────────
(async () => {
  try {
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE ponude ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 1`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notify BOOLEAN DEFAULT true`);

    // Ratings tabela
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ratings (
        id SERIAL PRIMARY KEY,
        from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        stars SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(from_user_id, listing_id)
      )
    `);

    // Broadcasts tabela
    await pool.query(`
      CREATE TABLE IF NOT EXISTS broadcasts (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Broadcast reads (ko je pročitao koji broadcast)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS broadcast_reads (
        id SERIAL PRIMARY KEY,
        broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        read_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(broadcast_id, user_id)
      )
    `);

    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fullname VARCHAR(200) DEFAULT ''`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_token VARCHAR(64)`);
    await pool.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS listing_type VARCHAR(10) DEFAULT 'single'`);
    await pool.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS lot_items JSONB DEFAULT '[]'`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS metal_prices_cache (
        id INTEGER PRIMARY KEY DEFAULT 1,
        platinum INTEGER, palladium INTEGER, rhodium INTEGER,
        prev_platinum INTEGER, prev_palladium INTEGER, prev_rhodium INTEGER,
        updated_at TIMESTAMPTZ
      )
    `);

    // Unikatnost korisničkog imena/naziva firme (case-insensitive)
    // Napomena: ako postoje duplikati iz prošlosti, ovo će tiho failati - normalno je
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name_lower ON users (LOWER(name))
    `).catch(e => console.log('ℹ️ Unique index na name preskočen (možda postoje duplikati):', e.message));

    console.log('✅ DB migration OK');
  } catch(e) { console.error('Migration error:', e.message); }
})();

// DELETE /api/chat/:listing_id  — obriši razgovor za ovog korisnika
app.delete('/api/chat/:listing_id', auth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM messages WHERE listing_id = $1 AND (sender_id = $2 OR receiver_id = $2)`,
      [req.params.listing_id, req.user.id]
    );
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: 'Greška' });
  }
});

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

// ─── Cijene plemenitih metala (cache, dnevno) ────────────
let _metalPrices = {
  platinum: null, palladium: null, rhodium: null,
  prev: { platinum: null, palladium: null, rhodium: null },
  updated: null
};

// Scraping rodijuma sa kitco.com (USD/oz, konvertujemo u EUR preko Pt cijene kao referentni kurs)
async function fetchRhodiumPrice() {
  try {
    const res = await fetch('https://www.kitco.com/price/precious-metals', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' }
    });
    if (!res.ok) {
      console.error('Rhodium scrape: HTTP', res.status);
      return null;
    }
    const html = await res.text();
    // Traži rodijum cijenu u USD - format se mijenja, probamo nekoliko pattern-a
    let match = html.match(/Rhodium[\s\S]{0,500}?(\d{1,2}[,.]?\d{3}\.\d{2})/i);
    if (!match) {
      match = html.match(/rhodium["'\s:]+(\d{1,2}[,.]?\d{3}(?:\.\d+)?)/i);
    }
    if (!match) {
      console.error('Rhodium scrape: pattern not found, html length =', html.length);
      return null;
    }
    const usdPrice = parseFloat(match[1].replace(',', ''));
    if (!usdPrice || usdPrice < 100 || usdPrice > 50000) {
      console.error('Rhodium scrape: sanity check failed, value =', usdPrice);
      return null;
    }
    console.log('✅ Rhodium scraped:', usdPrice, 'USD');
    return usdPrice;
  } catch(e) {
    console.error('Rhodium scrape error:', e.message);
    return null;
  }
}

async function fetchMetalPrices() {
  if (!process.env.GOLDAPI_KEY) {
    console.log('ℹ️  GOLDAPI_KEY nije podešen — metal prices isključeni');
    return;
  }
  try {
    // Provjeri DB cache prvo
    const cached = await pool.query('SELECT * FROM metal_prices_cache WHERE id = 1');
    const row = cached.rows[0];
    if (row && row.updated_at) {
      const ageMs = Date.now() - new Date(row.updated_at).getTime();
      if (ageMs < 20 * 60 * 60 * 1000) {
        // Cache je svjež (< 20h) — učitaj u memoriju i preskoči API poziv
        _metalPrices.platinum = row.platinum;
        _metalPrices.palladium = row.palladium;
        _metalPrices.rhodium = row.rhodium;
        _metalPrices.prev = { platinum: row.prev_platinum, palladium: row.prev_palladium, rhodium: row.prev_rhodium };
        _metalPrices.updated = row.updated_at;
        return;
      }
    }

    const headers = { 'x-access-token': process.env.GOLDAPI_KEY };
    const [ptRes, pdRes, ptUsdRes] = await Promise.all([
      fetch('https://www.goldapi.io/api/XPT/EUR', { headers }),
      fetch('https://www.goldapi.io/api/XPD/EUR', { headers }),
      fetch('https://www.goldapi.io/api/XPT/USD', { headers })
    ]);
    const pt = await ptRes.json();
    const pd = await pdRes.json();
    const ptUsd = await ptUsdRes.json();

    if (pt.error || pd.error) {
      console.error('Metal prices API error:', pt.error || pd.error);
      return;
    }

    // Rodijum - scrape sa kitco.com (USD), konvertuj u EUR preko Pt EUR/USD kursa
    let rhodiumEur = null;
    if (ptUsd.price && pt.price) {
      const usdToEurRate = pt.price / ptUsd.price; // npr. 0.92
      const rhodiumUsd = await fetchRhodiumPrice();
      if (rhodiumUsd) rhodiumEur = Math.round(rhodiumUsd * usdToEurRate);
    }

    const newPrices = {
      platinum: pt.price ? Math.round(pt.price) : null,
      palladium: pd.price ? Math.round(pd.price) : null,
      rhodium: rhodiumEur
    };

    const prevPlatinum = row ? row.platinum : null;
    const prevPalladium = row ? row.palladium : null;
    const prevRhodium = row ? row.rhodium : null;

    _metalPrices.platinum = newPrices.platinum;
    _metalPrices.palladium = newPrices.palladium;
    _metalPrices.rhodium = newPrices.rhodium;
    _metalPrices.prev = { platinum: prevPlatinum, palladium: prevPalladium, rhodium: prevRhodium };
    _metalPrices.updated = new Date().toISOString();

    // Sačuvaj u DB
    await pool.query(`
      INSERT INTO metal_prices_cache (id, platinum, palladium, rhodium, prev_platinum, prev_palladium, prev_rhodium, updated_at)
      VALUES (1, $1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (id) DO UPDATE SET
        platinum=$1, palladium=$2, rhodium=$3, prev_platinum=$4, prev_palladium=$5, prev_rhodium=$6, updated_at=NOW()
    `, [newPrices.platinum, newPrices.palladium, newPrices.rhodium, prevPlatinum, prevPalladium, prevRhodium]);

    console.log('✅ Metal prices ažurirane (API poziv):', newPrices);
  } catch(e) {
    console.error('Metal prices fetch error:', e.message);
  }
}

fetchMetalPrices();

// ─── Cron: automatsko istjecanje ponuda ──────────────────
async function expireOldPonude() {
  try {
    const result = await pool.query(`
      UPDATE ponude SET status = 'expired'
      WHERE status = 'pending'
        AND expires_at < NOW()
      RETURNING id, listing_id, buyer_id
    `);
    if (result.rows.length > 0) {
      console.log(`⏰ Isteklo ${result.rows.length} ponuda`);
    }
  } catch(e) {
    console.error('Cron ponude expire error:', e.message);
  }
}

expireOldPonude();
setInterval(expireOldPonude, 10 * 60 * 1000); // svakih 10 minuta

// ─── Cron: automatsko istjecanje oglasa ──────────────────
// Pokreće se svaki sat, istječe oglase starije od 7 dana bez ponuda
async function expireOldListings() {
  try {
    const result = await pool.query(`
      UPDATE listings
      SET status = 'expired'
      WHERE status = 'active'
        AND created_at < NOW() - INTERVAL '7 days'
      RETURNING id, user_id, marka, model
    `);
    if (result.rows.length > 0) {
      console.log(`⏰ Isteklo ${result.rows.length} oglasa:`, result.rows.map(r => `#${r.id} ${r.marka} ${r.model}`).join(', '));
      // Email notifikacija prodavačima
      for (const l of result.rows) {
        notifyUser(l.user_id,
          '⏰ Vaš oglas je istekao — Berza Katalizatora',
          `<p>Vaš oglas za <b>${l.marka} ${l.model}</b> nije dobio ponude u roku od 7 dana i automatski je istekao.</p>
           <p>Možete ga ponovo aktivirati prijavom na <a href="https://berzakatalizatora.com">berzakatalizatora.com</a>.</p>`
        ).catch(() => {});
      }
    }
  } catch(e) {
    console.error('Cron expire error:', e.message);
  }
}

// Pokreni odmah pri startu, pa svakih sat vremena
expireOldListings();
setInterval(expireOldListings, 60 * 60 * 1000);

// ─── SPA fallback (mora biti POSLIJE svih /api ruta) ─────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`✅ Berza Katalizatora backend — port ${PORT}`);
});
server.keepAliveTimeout = 65000;
server.headersTimeout   = 66000;

module.exports = app;
