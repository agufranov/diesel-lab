#!/usr/bin/env node
/*
 * Офлайн-прогон ядра: пуск → ХХ → средний режим → полный → стоп для каждого пресета.
 * Печатает обороты и RMS/пик по каналам, ловит NaN.
 *   node tools/render-test.js            — таблица
 *   node tools/render-test.js --wav out  — плюс WAV-файлы (сумма каналов) в папку out
 *   --v1                                  — прогнать замороженную первую модель
 */
const fs = require('fs');
const path = require('path');
const V1 = process.argv.includes('--v1');
const Core = V1 ? require('../engine-v1.js')() : require('../engine.js')();
const PRESETS = require('../presets.js');

const SR = 48000, BLOCK = 128;
const wavDir = process.argv.includes('--wav') ? process.argv[process.argv.indexOf('--wav') + 1] || 'renders' : null;

function writeWav(file, data) {
  let pk = 1e-9, sq = 0;
  for (const v of data) { pk = Math.max(pk, Math.abs(v)); sq += v * v; }
  const rms = Math.sqrt(sq / data.length) || 1e-9;
  const norm = Math.min(0.89 / pk, 0.1 / rms); // одна громкость (RMS −20 дБ) для честного A/B, пик не выше −1 дБ
  const buf = Buffer.alloc(44 + data.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(data.length * 2, 40);
  for (let i = 0; i < data.length; i++) buf.writeInt16LE(Math.round(data[i] * norm * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

let bad = false;
for (const p of PRESETS) {
  const k = new Core(SR);
  k.setConfig(p, true, false);
  const ex = new Float32Array(BLOCK), bl = new Float32Array(BLOCK), tu = new Float32Array(BLOCK);
  const settle = Math.max(4, p.inertia * 2.5 + p.turboLag * 1.5);
  const phases = [
    { name: 'start', t: 1.5 + p.startDelay, act: () => k.start() },
    { name: 'idle', t: 3 + p.inertia },
    { name: 'mid', t: settle, act: () => { k.throttle = 0.55; k.load = 0.4; } },
    { name: 'full', t: settle, act: () => { k.throttle = 1; k.load = 1; } },
    { name: 'stop', t: 2 + p.inertia * 2, act: () => { k.throttle = 0; k.load = 0; k.stop(); } },
  ];
  const mix = wavDir ? [] : null;
  const rows = [];
  for (const ph of phases) {
    if (ph.act) ph.act();
    const blocks = Math.round(ph.t * SR / BLOCK);
    const meas = Math.min(blocks, Math.round(1.5 * SR / BLOCK)); // мерим последние 1.5 с
    const acc = [0, 0, 0], pk = [0, 0, 0];
    let dwMin = 0, dwMax = 0;
    for (let b = 0; b < blocks; b++) {
      k.render(ex, bl, tu, BLOCK);
      if (b >= blocks - meas) { dwMin = Math.min(dwMin, k.dw || 0); dwMax = Math.max(dwMax, k.dw || 0); }
      for (let s = 0; s < BLOCK; s++) {
        const v = [ex[s], bl[s], tu[s]];
        for (let c = 0; c < 3; c++) {
          if (!Number.isFinite(v[c])) { bad = true; }
          if (b >= blocks - meas) { acc[c] += v[c] * v[c]; pk[c] = Math.max(pk[c], Math.abs(v[c])); }
        }
        if (mix) mix.push(0.6 * (p.mix.ex * ex[s] + p.mix.block * bl[s] + p.mix.turbo * tu[s]));
      }
    }
    const nS = meas * BLOCK;
    const t = k.telemetry();
    rows.push(`${ph.name.padEnd(5)} rpm ${t.rpm.toFixed(0).padStart(5)} fuel ${t.fuel.toFixed(2)} boost ${t.boost.toFixed(2)} pmax ${(t.pMax || 0).toFixed(0).padStart(3)} dw ±${((dwMax - dwMin) * 50).toFixed(1)}% | ` +
      ['ex', 'bl', 'tu'].map((nm, c) => `${nm} ${Math.sqrt(acc[c] / nS).toFixed(3)}/${pk[c].toFixed(2)}`).join('  '));
  }
  console.log(`\n== ${p.name} (${p.tag})`);
  rows.forEach((r) => console.log('  ' + r));
  if (mix) {
    fs.mkdirSync(wavDir, { recursive: true });
    writeWav(path.join(wavDir, `${p.id}.wav`), mix);
  }
}
if (bad) { console.error('\nNaN/Infinity in output!'); process.exit(1); }
