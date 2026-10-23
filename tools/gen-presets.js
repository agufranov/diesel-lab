#!/usr/bin/env node
// presets.js → JSON для мода (и для теста паритета C#)
//   node tools/gen-presets.js [путь]   (по умолчанию mod/DieselLab/presets.json)
const fs = require('fs');
const path = require('path');
const out = process.argv[2] || path.join(__dirname, '..', 'mod', 'DieselLab', 'presets.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(require('../presets.js'), null, 2) + '\n');
console.log('presets →', out);
