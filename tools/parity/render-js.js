// Эталон для сверки C# ↔ JS: сырые float32 всех трёх каналов
const fs = require('fs');
const Core = require('../../engine.js')();
const P = require('../../presets.js');
const [id, out] = process.argv.slice(2);
const k = new Core(48000);
k.setConfig(P.find((x) => x.id === id), true, false);
const B = 128, ex = new Float32Array(B), bl = new Float32Array(B), tu = new Float32Array(B);
const res = [];
const run = (sec) => { for (let i = 0; i < Math.round(sec * 48000 / B); i++) { k.render(ex, bl, tu, B); for (let s = 0; s < B; s++) res.push(ex[s], bl[s], tu[s]); } };
k.start(); run(3);
k.throttle = 0.55; k.load = 0.4; run(3);
fs.writeFileSync(out, Buffer.from(new Float32Array(res).buffer));
