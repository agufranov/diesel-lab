/*
 * Экспорт звука для игр. Сейчас — набор для мода ZSounds (Derail Valley):
 *   Sounds/EngineLoop/<имя>.wav          — петля на опорных оборотах без нагрузки
 *   Sounds/EngineLoadLoop/<имя>_load.wav — та же петля под нагрузкой (игра подмешивает по газу)
 *   Sounds/EngineStartup/<имя>_start.wav, Sounds/EngineShutdown/<имя>_stop.wav
 *   Sounds/Configs/<Тип>/config_<файл>.json — minPitch/maxPitch: игра сдвигает петлю по оборотам
 *
 * Рендер идёт тем же ядром DieselCore, офлайн. Чистые функции работают и в Node
 * (tools/export-test.js), привязка к странице — только при наличии document.
 */
(function (root) {
  'use strict';

  const SR = 48000, BLOCK = 128;

  // Баланс каналов в моно-файле: игра сама позиционирует источник в 3D
  const POSITIONS = {
    mixed: { label: 'Смешанный', ex: 0.8, block: 0.7, turbo: 0.6 },
    exhaust: { label: 'Выхлоп', ex: 1, block: 0.35, turbo: 0.3 },
    engine: { label: 'Двигатель', ex: 0.4, block: 1, turbo: 1 },
  };

  // ------------------------------------------------------------ рендер

  function makeRenderer(Core, cfg, position) {
    const k = new Core(SR);
    const P = POSITIONS[position] || POSITIONS.mixed, m = cfg.mix || { ex: 1, block: 1, turbo: 1 };
    const w = [P.ex * m.ex, P.block * m.block, P.turbo * m.turbo];
    const ex = new Float32Array(BLOCK), bl = new Float32Array(BLOCK), tu = new Float32Array(BLOCK);
    let hpY = 0, hpX = 0;
    const hpA = Math.exp(-2 * Math.PI * 15 / SR); // ФВЧ 15 Гц против постоянки
    return {
      core: k,
      // Рендерит n сэмплов в out (или выбрасывает, если out == null)
      run(n, out, offset = 0) {
        for (let done = 0; done < n; done += BLOCK) {
          k.render(ex, bl, tu, BLOCK);
          if (!out) continue;
          for (let s = 0; s < BLOCK && done + s < n; s++) {
            const x = w[0] * ex[s] + w[1] * bl[s] + w[2] * tu[s];
            hpY = hpA * (hpY + x - hpX); hpX = x;
            out[offset + done + s] = hpY;
          }
        }
      },
    };
  }

  const lossAt = (n) => 0.04 + 0.2 * n + 0.15 * n * n;

  // Ставит мотор сразу в установившийся режим на оборотах rpm (без долгого пуска)
  function holdAt(r, cfg, rpm, loaded) {
    const k = r.core;
    const c = Object.assign({}, cfg, { gov: 'speed' });
    k.setConfig(c, true, false);
    const n = rpm / c.max, nIdle = c.idle / c.max;
    const load = loaded ? Math.max(0, Math.min(3, (1.4 * 0.92 - lossAt(n)) / (0.85 * n * n + 0.1 * n))) : 0;
    const fuel = (lossAt(n) + load * (0.85 * n * n + 0.1 * n)) / 1.4;
    k.throttle = Math.max(0, Math.min(1, (n - nIdle) / (1 - nIdle)));
    k.load = load;
    k.fuelOn = true; k.stopped = false; k.warm = 1;
    k.n = n; k.fuel = fuel;
    k.boost = Math.min(1, fuel * (0.25 + 0.75 * n) * 1.3 + 0.06 * n);
    r.run(Math.round(SR * (2 + 0.5 * (cfg.turboLag || 1))), null);
  }

  // Бесшовная петля: длина — целое число рабочих циклов, начало сшито кроссфейдом с продолжением
  function renderLoop(Core, cfg, { rpm, seconds = 8, loaded = false, position = 'mixed' }) {
    const r = makeRenderer(Core, cfg, position);
    holdAt(r, cfg, rpm, loaded);
    const cycleSec = 60 / rpm * (cfg.stroke === 2 ? 1 : 2);
    const L = Math.round(Math.max(1, Math.round(seconds / cycleSec)) * cycleSec * SR);
    const F = Math.min(Math.round(0.25 * SR), Math.floor(L / 4));
    const x = new Float32Array(F + L + F);
    r.run(x.length, x);
    const y = new Float32Array(L);
    for (let i = 0; i < L; i++) y[i] = x[F + i];
    for (let i = 0; i < F; i++) { // равномощный кроссфейд: шум у нас некоррелированный
      const t = i / F;
      y[i] = x[F + i] * Math.sin(t * Math.PI / 2) + x[F + L + i] * Math.cos(t * Math.PI / 2);
    }
    return { data: y, cycles: Math.round(L / SR / cycleSec) };
  }

  function renderStartup(Core, cfg, { cold = false, position = 'mixed' }) {
    const r = makeRenderer(Core, cfg, position), k = r.core;
    k.setConfig(cfg, true, cold);
    k.start();
    const maxSec = 4 + cfg.startDelay + 3 * cfg.inertia;
    const out = new Float32Array(Math.round(maxSec * SR));
    let pos = 0, stable = 0;
    const chunk = Math.round(0.05 * SR);
    while (pos + chunk <= out.length) {
      r.run(chunk, out, pos); pos += chunk;
      const idle = cfg.idle * (1 + 0.15 * (1 - k.warm));
      stable = !k.starter && Math.abs(k.n * cfg.max - idle) < idle * 0.03 ? stable + 0.05 : 0;
      if (stable >= 0.6) break;
    }
    return fadeEdges(out.subarray(0, pos), 0.003, 0.3);
  }

  function renderShutdown(Core, cfg, { position = 'mixed' }) {
    const r = makeRenderer(Core, cfg, position), k = r.core;
    holdAt(r, cfg, cfg.idle, false);
    k.stop();
    const out = new Float32Array(Math.round(15 * SR));
    let pos = 0, after = 0;
    const chunk = Math.round(0.05 * SR);
    while (pos + chunk <= out.length) {
      r.run(chunk, out, pos); pos += chunk;
      if (k.stopped) after += 0.05;
      if (after >= 0.8) break;
    }
    return fadeEdges(out.subarray(0, pos), 0.02, 0.2);
  }

  function fadeEdges(x, inSec, outSec) {
    const a = Math.min(x.length, Math.round(inSec * SR)), b = Math.min(x.length, Math.round(outSec * SR));
    for (let i = 0; i < a; i++) x[i] *= i / a;
    for (let i = 0; i < b; i++) x[x.length - 1 - i] *= i / b;
    return x;
  }

  // ------------------------------------------------------------ файлы

  function wavBytes(data, gain) {
    const n = data.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, data[i] * gain)) * 32767), true);
    return new Uint8Array(buf);
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32(d) {
    let c = 0xffffffff;
    for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ZIP без сжатия (store): WAV всё равно плохо жмётся deflate, а так нет зависимостей
  function zipBytes(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const f of files) {
      const name = enc.encode(f.path), data = f.data, crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint16(8, 0, true); h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true);
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true); c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(e.buffer)];
    const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
    let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }

  // ------------------------------------------------------------ набор ZSounds

  const safeName = (s) => s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'DieselLab';
  const round3 = (x) => Math.round(x * 1000) / 1000;

  // opts: { name, rpm, seconds, position, startStop, cold, pitchMin, pitchMax }
  function buildZSoundsPack(Core, cfg, opts) {
    const name = safeName(opts.name);
    const rpm = opts.rpm;
    const pitch = {
      minPitch: round3(opts.pitchMin ?? cfg.idle / rpm),
      maxPitch: round3(opts.pitchMax ?? cfg.max / rpm),
    };
    const tracks = [];
    const idle = renderLoop(Core, cfg, { rpm, seconds: opts.seconds, loaded: false, position: opts.position });
    const load = renderLoop(Core, cfg, { rpm, seconds: opts.seconds, loaded: true, position: opts.position });
    tracks.push({ type: 'EngineLoop', file: name, data: idle.data, config: { enabled: true, ...pitch } });
    tracks.push({ type: 'EngineLoadLoop', file: `${name}_load`, data: load.data, config: { enabled: true, ...pitch } });
    if (opts.startStop) {
      tracks.push({ type: 'EngineStartup', file: `${name}_start`, data: renderStartup(Core, cfg, { cold: opts.cold, position: opts.position }) });
      tracks.push({ type: 'EngineShutdown', file: `${name}_stop`, data: renderShutdown(Core, cfg, { position: opts.position }) });
    }
    // одна общая громкость на весь набор: соотношения между петлями и пуском сохраняются
    let pk = 1e-9;
    for (const t of tracks) for (let i = 0; i < t.data.length; i++) pk = Math.max(pk, Math.abs(t.data[i]));
    const gain = 0.89 / pk;

    const enc = new TextEncoder(), files = [];
    for (const t of tracks) {
      files.push({ path: `Sounds/${t.type}/${t.file}.wav`, data: wavBytes(t.data, gain) });
      if (t.config) files.push({ path: `Sounds/Configs/${t.type}/config_${t.file}.json`, data: enc.encode(JSON.stringify(t.config, null, 2) + '\n') });
    }
    const info = {
      name, rpm, ...pitch,
      loopSeconds: round3(idle.data.length / SR), loopCycles: idle.cycles,
      engine: `${cfg.name || 'Свой двигатель'} · ${cfg.cyl} цил. · ${cfg.stroke === 2 ? 2 : 4}T · ${cfg.idle}–${cfg.max} об/мин`,
    };
    files.push({ path: 'DieselLab_README.txt', data: enc.encode(readmeText(info, tracks)) });
    return { files, info, tracks, gain };
  }

  function readmeText(info, tracks) {
    const list = tracks.map((t) => `  Sounds/${t.type}/${t.file}.wav`).join('\r\n');
    return [
      `Diesel Lab → ZSounds: ${info.name}`,
      `Двигатель: ${info.engine}`,
      `Петли записаны на ${info.rpm} об/мин, ${info.loopSeconds} с (${info.loopCycles} рабочих циклов).`,
      `Высота тона: minPitch ${info.minPitch} (холостой ход), maxPitch ${info.maxPitch} (максимум).`,
      '',
      'Установка:',
      '  1. Нужны Unity Mod Manager и ZSounds (nexusmods.com/derailvalley/mods/249).',
      '  2. Распакуйте архив в папку Derail Valley/Mods/ZSounds/ (папка Sounds сольётся с существующей).',
      '  3. В игре: Alt → кнопка ZS → Update Soundlist.',
      '  4. Выберите локомотив и для каждого типа звука выберите файл из этого набора.',
      '',
      'Файлы:',
      list,
      '',
      'Если обороты «не попадают» (звук выше или ниже, чем должен):',
      '  откройте Config рядом со звуком в ZSounds и сравните minPitch/maxPitch со штатными значениями',
      '  этого локомотива; подгоните их или переэкспортируйте с другими опорными оборотами.',
      '',
    ].join('\r\n');
  }

  const api = { SR, POSITIONS, renderLoop, renderStartup, renderShutdown, wavBytes, zipBytes, crc32, buildZSoundsPack };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.DieselExport = api;

  // ------------------------------------------------------------ панель на странице

  if (typeof document === 'undefined') return;
  const $ = (s) => document.querySelector(s);
  let preview = null, lastPack = null;

  function current() {
    const S = root.dieselLab;
    return { S, cfg: S.cfg, preset: S.preset };
  }

  function defaults() {
    const { cfg, preset } = current();
    $('#exName').value = `DieselLab_${preset.id}${current().S.modified ? '_custom' : ''}`;
    $('#exRpm').value = Math.round(Math.sqrt(cfg.idle * cfg.max));
    updateInfo();
  }

  function opts() {
    const { cfg } = current();
    return {
      name: $('#exName').value,
      rpm: Math.max(cfg.idle * 0.5, Math.min(cfg.max, +$('#exRpm').value || cfg.idle)),
      seconds: +$('#exLen').value || 8,
      position: $('#exPos').value,
      startStop: $('#exStartStop').checked,
      cold: $('#coldStart').checked,
    };
  }

  function updateInfo() {
    const { cfg } = current(), o = opts();
    $('#exInfo').innerHTML = `Высота тона в игре: <b>${(cfg.idle / o.rpm).toFixed(2)}</b> на ХХ … <b>${(cfg.max / o.rpm).toFixed(2)}</b> на максимуме`;
  }

  async function build() {
    const st = $('#exStatus');
    st.textContent = 'Рендер…';
    await new Promise((r) => setTimeout(r, 30)); // даём странице отрисовать статус
    const t0 = performance.now();
    const pack = buildZSoundsPack(DIESEL_WORKLET_SOURCE(), { ...current().cfg, name: current().preset.name }, opts());
    lastPack = pack;
    st.textContent = `Готово за ${((performance.now() - t0) / 1000).toFixed(1)} с · петля ${pack.info.loopSeconds} с`;
    return pack;
  }

  async function download() {
    const pack = await build();
    const blob = new Blob([zipBytes(pack.files)], { type: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${pack.info.name}_ZSounds.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // Прослушка петли так, как её сыграет игра: один файл, сдвинутый по высоте
  async function togglePreview() {
    const b = $('#exPreview');
    if (preview) { stopPreview(); return; }
    const pack = lastPack && lastPack.info.name === opts().name ? lastPack : await build();
    const ctx = new AudioContext();
    const tr = pack.tracks[0];
    const buf = ctx.createBuffer(1, tr.data.length, SR);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = tr.data[i] * pack.gain * 0.6;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.connect(ctx.destination); src.start();
    preview = { ctx, src, rpm: pack.info.rpm };
    setPreviewRpm();
    b.textContent = '■ Остановить';
  }

  function setPreviewRpm() {
    const { cfg } = current();
    const r = $('#exGameRpm');
    const rpm = cfg.idle + (r.value / 1000) * (cfg.max - cfg.idle);
    $('#exGameRpmVal').textContent = `${Math.round(rpm)} об/мин`;
    if (preview) preview.src.playbackRate.value = rpm / preview.rpm;
  }

  function stopPreview() {
    if (!preview) return;
    preview.src.stop(); preview.ctx.close(); preview = null;
    $('#exPreview').textContent = '▶ Прослушать петлю (как в игре)';
  }

  root.addEventListener('DOMContentLoaded', () => {
    if (!$('#exportPanel')) return;
    $('#exDownload').onclick = download;
    $('#exPreview').onclick = togglePreview;
    $('#exGameRpm').oninput = setPreviewRpm;
    $('#exRpm').oninput = updateInfo;
    ['#exRpm', '#exLen', '#exPos', '#exStartStop', '#exName'].forEach((s) => $(s).addEventListener('change', () => { lastPack = null; }));
    $('#exReset').onclick = defaults;
    document.addEventListener('diesel:preset', () => { stopPreview(); lastPack = null; defaults(); setPreviewRpm(); });
    document.addEventListener('diesel:mute', stopPreview);
    setTimeout(() => { defaults(); setPreviewRpm(); }, 0);
  });
})(typeof window !== 'undefined' ? window : globalThis);
