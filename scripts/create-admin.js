#!/usr/bin/env node
// Pokrenuti: node scripts/create-admin.js
// Kreira admin nalog sa hashed lozinkom

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function createAdmin() {
  const email    = process.env.ADMIN_EMAIL    || 'admin@berzakatalizatora.com';
  const password = process.env.ADMIN_PASSWORD || 'PromijeniOvoOdmah123!';
  const name     = 'Admin';

  console.log(`\n📌 Kreiranje admina: ${email}`);
  const hash = await bcrypt.hash(password, 12);

  try {
    await pool.query(
      `INSERT INTO users (email, password_hash, name, role, status)
       VALUES ($1, $2, $3, 'admin', 'approved')
       ON CONFLICT (email) DO UPDATE SET password_hash = $2`,
      [email, hash, name]
    );
    console.log('✅ Admin nalog kreiran/ažuriran');
    console.log(`   Email: ${email}`);
    console.log(`   Lozinka: ${password}`);
    console.log('\n⚠️  ODMAH promijeni lozinku u produkciji!\n');
  } catch (err) {
    console.error('❌ Greška:', err.message);
  } finally {
    await pool.end();
  }
}

createAdmin();
