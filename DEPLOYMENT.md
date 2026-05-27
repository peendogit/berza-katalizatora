# 🚀 Berza Katalizatora — Deployment Guide
## VPS: 158.220.96.229 | Ubuntu + Nginx 1.24 + Node.js 20

---

## KORAK 1 — PostgreSQL instalacija i setup

```bash
# Na VPS-u (SSH kao root):
apt update && apt install -y postgresql postgresql-contrib

# Pokreni i omogući autostart
systemctl start postgresql
systemctl enable postgresql

# Kreiraj bazu i korisnika
sudo -u postgres psql <<EOF
CREATE USER berza WITH PASSWORD 'JAKA_LOZINKA_OVDJE';
CREATE DATABASE berza_db OWNER berza;
GRANT ALL PRIVILEGES ON DATABASE berza_db TO berza;
EOF

# Inicijaliziraj shemu
sudo -u postgres psql -d berza_db -f /var/www/berza-katalizatora/schema.sql
```

---

## KORAK 2 — Deploy backend fajlova

```bash
# Kreiranje direktorija
mkdir -p /var/www/berza-katalizatora
mkdir -p /var/www/berza-katalizatora/public    # <-- tu ide HTML/CSS/JS frontend
mkdir -p /var/www/berza-katalizatora/uploads   # <-- slike katalizatora
mkdir -p /var/log/berza

# Kopiranje backend fajlova
# (Opcija A — direktno sa lokalnog računara putem scp)
scp -r ./berza-backend/* root@158.220.96.229:/var/www/berza-katalizatora/

# Kopiranje frontend HTML-a
scp berza-katalizatora.html root@158.220.96.229:/var/www/berza-katalizatora/public/index.html

# Opcija B — git clone (ako je na GitHubu peendogit)
# cd /var/www && git clone https://github.com/peendogit/berza-katalizatora.git

# Permissions za uploads folder
chown -R www-data:www-data /var/www/berza-katalizatora/uploads
chmod 755 /var/www/berza-katalizatora/uploads
```

---

## KORAK 3 — Konfiguracija .env

```bash
cd /var/www/berza-katalizatora
cp .env.example .env
nano .env
```

Popuni ove vrijednosti:
```
DATABASE_URL=postgresql://berza:JAKA_LOZINKA_OVDJE@localhost:5432/berza_db
JWT_SECRET=<generiraj: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
ALLOWED_ORIGIN=https://berzakatalizatora.com
```

---

## KORAK 4 — Instalacija npm paketa i admin korisnika

```bash
cd /var/www/berza-katalizatora
npm install --production

# Kreiraj admin nalog
ADMIN_EMAIL=admin@berzakatalizatora.com ADMIN_PASSWORD=OdaberiJakuLozinku node scripts/create-admin.js
```

---

## KORAK 5 — PM2 process manager

```bash
# Instaliraj PM2 globalno (ako nije)
npm install -g pm2

# Pokreni aplikaciju
cd /var/www/berza-katalizatora
pm2 start ecosystem.config.js

# Autostart na reboot
pm2 startup systemd
pm2 save

# Provjeri da radi
pm2 status
pm2 logs berza --lines 20
curl http://localhost:3000/api/admin/stats   # trebalo bi vratiti grešku "Niste prijavljeni"
```

---

## KORAK 6 — Nginx konfiguracija

```bash
# Kopiraj Nginx config
cp /var/www/berza-katalizatora/nginx-berzakatalizatora.conf \
   /etc/nginx/sites-available/berzakatalizatora.com

# Aktiviraj site
ln -s /etc/nginx/sites-available/berzakatalizatora.com \
      /etc/nginx/sites-enabled/

# Ukloni default site (opcionalno)
rm -f /etc/nginx/sites-enabled/default

# Test i reload
nginx -t && systemctl reload nginx
```

---

## KORAK 7 — SSL certifikat (Let's Encrypt)

```bash
# Instaliraj certbot (ako nije)
apt install -y certbot python3-certbot-nginx

# Dobij certifikat (DNS mora biti propagiran!)
certbot --nginx -d berzakatalizatora.com -d www.berzakatalizatora.com

# Certbot će automatski:
# 1. Dobiti certifikat
# 2. Ažurirati nginx config sa SSL linijama
# 3. Postaviti auto-renewal

# Provjeri auto-renewal
systemctl status certbot.timer
certbot renew --dry-run
```

---

## KORAK 8 — Firewall (UFW)

```bash
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS
ufw deny 3000       # Node port — SAMO lokalno, ne izvana!
ufw enable
ufw status
```

---

## KORAK 9 — Provjera da sve radi

```bash
# 1. API health check
curl https://berzakatalizatora.com/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"admin@berzakatalizatora.com","password":"TvojaLozinka"}'
# Treba da vrati: {"user":{...},"token":"..."}

# 2. Frontend
curl -I https://berzakatalizatora.com
# Treba da vrati: HTTP/2 200

# 3. PM2 status
pm2 status

# 4. Nginx logovi
tail -f /var/log/nginx/error.log
```

---

## 🔧 Česti problemi

| Problem | Rješenje |
|---------|----------|
| `502 Bad Gateway` | PM2 nije pokrenout — `pm2 restart berza` |
| `connection refused` na pg | PostgreSQL nije pokrenout — `systemctl start postgresql` |
| SSL greška | DNS još nije propagiran — provjeri sa `dig berzakatalizatora.com` |
| `permission denied` na uploads | `chown -R www-data:www-data uploads/` |
| Port 3000 dostupan izvana | `ufw deny 3000 && ufw reload` |

---

## 📁 Struktura fajlova na serveru

```
/var/www/berza-katalizatora/
├── server.js              ← Express backend
├── schema.sql             ← PostgreSQL shema
├── package.json
├── ecosystem.config.js    ← PM2 config
├── .env                   ← Tajne varijable (ne commitaj!)
├── scripts/
│   └── create-admin.js
├── public/
│   └── index.html         ← Frontend (tvoj berza-katalizatora.html)
└── uploads/               ← Slike katalizatora
```

---

## ⏭️ Sljedeći korak — API integracija u frontendu

Nakon što backend radi, HTML fajl treba prilagoditi da koristi `/api/` endpointe
umjesto lokalnih JS varijabli (USERS, LISTINGS, itd.).

Prioritetni redosljed integracije:
1. `POST /api/auth/login` i `POST /api/auth/register`
2. `GET /api/listings` za prikaz oglasa
3. `POST /api/listings` za objavu
4. `POST /api/ponude` za slanje ponuda
5. Chat API
