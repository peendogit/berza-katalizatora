// Jednokratna skripta — resize-uje SVE postojeće slike u uploads/ folderu
// koje su prevelike (full-res fotke sa telefona), bez gubitka URL-a (isto ime fajla).
//
// POKRETANJE NA VPS-u (iz /var/www/berza-katalizatora):
//   npm install sharp --save   (ako već nije instaliran)
//   node resize_existing.js
//
// Sigurno je pokrenuti više puta — slike koje su već male (<1600px) se preskaču.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MAX_DIM = 1600;
const QUALITY = 82;

async function run() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    console.error('Folder ne postoji:', UPLOADS_DIR);
    process.exit(1);
  }

  const files = fs.readdirSync(UPLOADS_DIR).filter(f =>
    /\.(jpe?g|png|webp)$/i.test(f)
  );

  console.log(`Pronađeno ${files.length} slika. Počinjem obradu...`);

  let resized = 0, skipped = 0, failed = 0;

  for (const file of files) {
    const fullPath = path.join(UPLOADS_DIR, file);
    try {
      const meta = await sharp(fullPath).metadata();
      if (meta.width <= MAX_DIM && meta.height <= MAX_DIM) {
        skipped++;
        continue;
      }
      const tmpPath = fullPath + '.tmp';
      await sharp(fullPath)
        .rotate()
        .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: QUALITY, mozjpeg: true })
        .toFile(tmpPath);
      fs.renameSync(tmpPath, fullPath);
      resized++;
      console.log(`✓ ${file} (${meta.width}x${meta.height} → resized)`);
    } catch (e) {
      failed++;
      console.error(`✗ ${file}: ${e.message}`);
    }
  }

  console.log(`\nGotovo. Resized: ${resized}, Skipped (već male): ${skipped}, Failed: ${failed}`);
}

run();
