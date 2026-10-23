#!/usr/bin/env node
/*
 * Проверка экспорта для ZSounds: собирает наборы, проверяет стык петель и валидность zip.
 *   node tools/export-test.js [папка]   — zip-архивы кладутся в папку (по умолчанию renders/zsounds)
 */
const fs = require('fs');
const path = require('path');
const Core = require('../engine.js')();
const PRESETS = require('../presets.js');
const X = require('../export.js');

const outDir = process.argv[2] || 'renders/zsounds';
fs.mkdirSync(outDir, { recursive: true });
let bad = false;

// Скачок на стыке петли относительно типичного шага сигнала
function seamRatio(y) {
  let sum = 0;
  for (let i = 1; i < y.length; i++) sum += Math.abs(y[i] - y[i - 1]);
  return Math.abs(y[0] - y[y.length - 1]) / (sum / (y.length - 1));
}

for (const id of ['emd', 'genset', 'car']) {
  const p = PRESETS.find((x) => x.id === id);
  const t0 = Date.now();
  const pack = X.buildZSoundsPack(Core, p, {
    name: `DieselLab_${id}`, rpm: Math.round(Math.sqrt(p.idle * p.max)), seconds: 8, position: 'mixed', startStop: true, cold: false,
  });
  const zip = X.zipBytes(pack.files);
  fs.writeFileSync(path.join(outDir, `${pack.info.name}_ZSounds.zip`), zip);
  console.log(`\n== ${p.name}: ${((Date.now() - t0) / 1000).toFixed(1)} с, zip ${(zip.length / 1e6).toFixed(1)} МБ, gain ${pack.gain.toFixed(1)}`);
  console.log(`   петля ${pack.info.rpm} об/мин, ${pack.info.loopSeconds} с = ${pack.info.loopCycles} циклов, pitch ${pack.info.minPitch}…${pack.info.maxPitch}`);
  for (const t of pack.tracks) {
    let sq = 0, pk = 0;
    for (const v of t.data) { if (!Number.isFinite(v)) bad = true; sq += v * v; pk = Math.max(pk, Math.abs(v)); }
    const rms = 20 * Math.log10(Math.sqrt(sq / t.data.length) * pack.gain);
    const seam = t.type.endsWith('Loop') ? `  стык ×${seamRatio(t.data).toFixed(2)} шага` : '';
    console.log(`   ${t.type.padEnd(15)} ${(t.data.length / X.SR).toFixed(2).padStart(6)} с  RMS ${rms.toFixed(1)} дБ${seam}`);
    if (seam && seamRatio(t.data) > 4) { bad = true; console.log('   ^ щелчок на стыке!'); }
  }
}
if (bad) { console.error('\nПроблемы в экспорте'); process.exit(1); }
