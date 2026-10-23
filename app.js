(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const PRESETS = window.DIESEL_PRESETS;

  const LISTENERS = {
    exhaust: { label: 'У выхлопа', ex: 1, block: 0.35, turbo: 0.3, lp: 18000, low: 0, wet: 0.6 },
    engine: { label: 'У двигателя', ex: 0.4, block: 1, turbo: 1, lp: 18000, low: 0, wet: 1 },
    cabin: { label: 'В кабине / ЦПУ', ex: 0.6, block: 0.55, turbo: 0.25, lp: 650, low: 6, wet: 0.25 },
  };

  const MIXER = [
    { k: 'ex', label: 'Выпуск' },
    { k: 'block', label: 'Блок и стук' },
    { k: 'turbo', label: 'Турбина' },
    { k: 'room', label: 'Помещение' },
    { k: 'master', label: 'Громкость' },
  ];

  // Ручки конструктора. log — логарифмическая шкала слайдера.
  const SCHEMA = [
    { k: 'cyl', label: 'Цилиндры', min: 1, max: 20, step: 1, fmt: (v) => v },
    { k: 'stroke', label: 'Тактность', seg: [[4, '4-тактный'], [2, '2-тактный']] },
    { k: 'bore', label: 'Диаметр цилиндра', min: 50, max: 1000, log: true, fmt: (v) => `${v.toFixed(0)} мм` },
    { k: 'idle', label: 'Холостой ход', min: 10, max: 1500, log: true, fmt: rpmFmt },
    { k: 'max', label: 'Макс. обороты', min: 60, max: 6000, log: true, fmt: rpmFmt },
    { k: 'crank', label: 'Прокрутка стартером', min: 5, max: 400, log: true, fmt: rpmFmt },
    { k: 'inertia', label: 'Инерция (разгон)', min: 0.2, max: 30, log: true, fmt: (v) => `${v.toFixed(1)} с` },
    { k: 'turbo', label: 'Турбонаддув', min: 0, max: 1, fmt: pct },
    { k: 'turboHz', label: 'Свист турбины', min: 800, max: 12000, log: true, fmt: hzFmt },
    { k: 'turboLag', label: 'Турбояма', min: 0.1, max: 10, log: true, fmt: (v) => `${v.toFixed(1)} с` },
    { k: 'pipe', label: 'Длина выпуска', min: 0.5, max: 40, log: true, fmt: (v) => `${v.toFixed(1)} м` },
    { k: 'muffler', label: 'Глушитель (срез)', min: 150, max: 8000, log: true, fmt: hzFmt },
    { k: 'knock', label: 'Дизельный стук', min: 0, max: 2, fmt: (v) => v.toFixed(2) },
    { k: 'mech', label: 'Механика (клапаны, форсунки)', min: 0, max: 2, fmt: (v) => v.toFixed(2) },
    { k: 'uneven', label: 'Разброс цилиндров', min: 0, max: 0.2, fmt: (v) => v.toFixed(2) },
    { k: 'gov', label: 'Управление', seg: [['pedal', 'Педаль'], ['speed', 'Регулятор']] },
    { k: 'starter', label: 'Стартер', seg: [['electric', 'Электро'], ['air', 'Воздух']] },
  ];

  function rpmFmt(v) { return `${v < 1000 ? v.toFixed(0) : Math.round(v / 10) * 10} об/мин`; }
  function hzFmt(v) { return v >= 1000 ? `${(v / 1000).toFixed(1)} кГц` : `${v.toFixed(0)} Гц`; }
  function pct(v) { return `${Math.round(v * 100)}%`; }

  const S = {
    ctx: null, node: null, a: null,
    preset: PRESETS[0], cfg: null, modified: false,
    tele: { rpm: 0, fuel: 0, boost: 0, warm: 0, firing: false, starter: false, fireHz: 0 },
    shownRpm: 0,
    listener: 'exhaust',
    model: 'v2',
    mix: { ex: 1, block: 1, turbo: 1, room: 1, master: 0.8 },
    throttle: 0, load: 0,
  };

  // ---------------------------------------------------------------- аудио

  async function ensureAudio() {
    if (S.ctx) {
      if (S.ctx.state !== 'running') await S.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    // v1 — объявление функции в том же модуле, процессор v2 подхватывает её для A/B
    const src = DIESEL_WORKLET_SOURCE_V1.toString() + ';\n(' + DIESEL_WORKLET_SOURCE.toString() + ')();';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const node = new AudioWorkletNode(ctx, 'diesel-engine', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [3],
    });
    const split = ctx.createChannelSplitter(3);
    node.connect(split);
    const strip = (ch, pan) => {
      const g = ctx.createGain(), p = ctx.createStereoPanner();
      p.pan.value = pan;
      split.connect(g, ch); g.connect(p);
      return { g, p };
    };
    const ex = strip(0, 0.25), block = strip(1, 0), turbo = strip(2, -0.3);

    const bus = ctx.createGain();
    [ex, block, turbo].forEach((s) => s.p.connect(bus));
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 16; hp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 18000; lp.Q.value = 0.6;
    const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 160; low.gain.value = 0;
    bus.connect(hp); hp.connect(lp); lp.connect(low);

    const dry = ctx.createGain(), wet = ctx.createGain(), conv = ctx.createConvolver();
    low.connect(dry); low.connect(conv); conv.connect(wet);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 4;
    comp.attack.value = 0.004; comp.release.value = 0.25;
    const makeup = ctx.createGain(); makeup.gain.value = 3;
    const clip = ctx.createWaveShaper(); // мягкий потолок поверх компрессора
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh((i / (curve.length - 1) * 2 - 1) * 1.5) / Math.tanh(1.5);
    clip.curve = curve; clip.oversample = '2x';
    const master = ctx.createGain();
    dry.connect(makeup); wet.connect(makeup); makeup.connect(comp); comp.connect(clip); clip.connect(master);
    const an = ctx.createAnalyser(); an.fftSize = 4096; an.smoothingTimeConstant = 0.7;
    master.connect(an); master.connect(ctx.destination);

    node.port.onmessage = (e) => { if (e.data.type === 'tele') S.tele = e.data; };
    S.ctx = ctx; S.node = node;
    S.a = { ex, block, turbo, lp, low, dry, wet, conv, master, an };
    S.freq = new Float32Array(an.frequencyBinCount);
    S.time = new Float32Array(an.fftSize);

    sendConfig(true);
    sendCtrl();
    post({ type: 'model', model: S.model });
    applyMix();
    buildRoom();
    $('#audioState').textContent = `звук: ${ctx.sampleRate} Гц`;
    $('#audioState').classList.add('on');
  }

  function post(m) { if (S.node) S.node.port.postMessage(m); }

  function sendConfig(reset) {
    post({ type: 'config', cfg: S.cfg, reset, cold: $('#coldStart').checked });
  }

  function sendCtrl() { post({ type: 'ctrl', throttle: S.throttle, load: S.load }); }

  function applyMix() {
    if (!S.a) return;
    const L = LISTENERS[S.listener], pm = S.preset.mix, t = S.ctx.currentTime;
    const set = (param, v) => param.setTargetAtTime(v, t, 0.05);
    set(S.a.ex.g.gain, L.ex * S.mix.ex * pm.ex);
    set(S.a.block.g.gain, L.block * S.mix.block * pm.block);
    set(S.a.turbo.g.gain, L.turbo * S.mix.turbo * pm.turbo);
    set(S.a.lp.frequency, L.lp);
    set(S.a.low.gain, L.low);
    set(S.a.wet.gain, S.preset.room.wet * L.wet * S.mix.room * 2.5);
    set(S.a.master.gain, S.mix.master * (S.listener === 'cabin' ? 1.6 : 1));
  }

  // Синтетический импульсный отклик: шум с экспоненциальным спадом и темнеющим тембром
  function buildRoom() {
    if (!S.a) return;
    const sr = S.ctx.sampleRate, size = S.preset.room.size;
    const len = Math.max(1, Math.round(sr * size));
    const ir = S.ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const a = 0.5 - 0.45 * t; // к хвосту — темнее
        lp += a * (Math.random() * 2 - 1 - lp);
        d[i] = lp * Math.exp(-6.9 * t) * (i < sr * 0.004 ? i / (sr * 0.004) : 1);
      }
    }
    S.a.conv.buffer = ir;
  }

  // ---------------------------------------------------------------- двигатели

  function selectPreset(p) {
    const wasRunning = S.tele.rpm > 1;
    S.preset = p;
    S.cfg = JSON.parse(JSON.stringify(p));
    S.modified = false;
    setThrottle(0);
    renderEngines();
    renderBuilder();
    updateDerived();
    $('#thrLabel').textContent = p.gov === 'pedal' ? 'Педаль газа' : 'Рычаг оборотов (регулятор)';
    S.tele = { ...S.tele, rpm: 0, fuel: 0, boost: 0, firing: false, starter: false, fireHz: 0 };
    document.dispatchEvent(new Event('diesel:preset'));
    if (S.node) {
      sendConfig(true);
      applyMix();
      buildRoom();
      if (wasRunning) post({ type: 'start' }); // сразу слышно пуск нового мотора
    }
  }

  function renderEngines() {
    const box = $('#engineList');
    box.innerHTML = '';
    let group = '';
    for (const p of PRESETS) {
      if (p.group !== group) {
        group = p.group;
        const g = document.createElement('div');
        g.className = 'group'; g.textContent = group;
        box.appendChild(g);
      }
      const b = document.createElement('button');
      b.className = 'eng' + (p === S.preset ? ' active' : '');
      b.innerHTML = `<b></b><span></span>`;
      b.querySelector('b').textContent = p.name;
      b.querySelector('span').textContent = `${p.tag} · Ø${p.bore} мм · ${p.idle}–${p.max} об/мин`;
      b.onclick = () => selectPreset(p);
      box.appendChild(b);
    }
  }

  // ---------------------------------------------------------------- конструктор

  const toSlider = (d, v) => d.log ? Math.log(v / d.min) / Math.log(d.max / d.min) : (v - d.min) / (d.max - d.min);
  const fromSlider = (d, x) => {
    let v = d.log ? d.min * Math.pow(d.max / d.min, x) : d.min + x * (d.max - d.min);
    if (d.step) v = Math.round(v / d.step) * d.step;
    return v;
  };

  let cfgTimer = 0;
  function cfgChanged() {
    S.modified = true;
    $('#modified').textContent = '· изменён';
    updateDerived();
    clearTimeout(cfgTimer);
    cfgTimer = setTimeout(() => sendConfig(false), 30);
  }

  function renderBuilder() {
    const box = $('#builder');
    box.innerHTML = '';
    $('#modified').textContent = '';
    for (const d of SCHEMA) {
      const w = document.createElement('div');
      w.className = 'param';
      const lab = document.createElement('label');
      lab.textContent = d.label;
      w.appendChild(lab);
      if (d.seg) {
        const seg = document.createElement('div');
        seg.className = 'seg';
        for (const [val, text] of d.seg) {
          const b = document.createElement('button');
          b.textContent = text;
          b.className = S.cfg[d.k] === val ? 'on' : '';
          b.onclick = () => {
            S.cfg[d.k] = val;
            seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
            if (d.k === 'gov') $('#thrLabel').textContent = val === 'pedal' ? 'Педаль газа' : 'Рычаг оборотов (регулятор)';
            cfgChanged();
          };
          seg.appendChild(b);
        }
        w.appendChild(seg);
      } else {
        const out = document.createElement('output');
        out.textContent = d.fmt(S.cfg[d.k]);
        lab.appendChild(out);
        const r = document.createElement('input');
        r.type = 'range'; r.min = 0; r.max = 1000;
        r.value = Math.round(toSlider(d, S.cfg[d.k]) * 1000);
        r.oninput = () => {
          S.cfg[d.k] = fromSlider(d, r.value / 1000);
          out.textContent = d.fmt(S.cfg[d.k]);
          cfgChanged();
        };
        w.appendChild(r);
      }
      box.appendChild(w);
    }
  }

  function updateDerived() {
    const c = S.cfg;
    const perRev = c.cyl / (c.stroke === 2 ? 1 : 2);
    const fIdle = c.idle / 60 * perRev, fMax = c.max / 60 * perRev;
    const chamber = 1000 / (Math.PI * c.bore / 1000) * 1.841;
    const pipeHz = 550 / (4 * c.pipe);
    const items = [
      ['Вспышек за оборот', perRev % 1 ? perRev.toFixed(1) : perRev],
      ['Частота вспышек', `${fIdle.toFixed(fIdle < 10 ? 1 : 0)}–${fMax.toFixed(fMax < 10 ? 1 : 0)} Гц`],
      ['Резонанс камеры сгорания', hzFmt(chamber)],
      ['Резонанс выпуска', `${pipeHz.toFixed(pipeHz < 20 ? 1 : 0)} Гц`],
      ['Цикл', `${c.stroke === 2 ? 360 : 720}° коленвала`],
    ];
    $('#derived').innerHTML = items.map(([k, v]) => `<span>${k}: <b>${v}</b></span>`).join('');
    $('#vChamber').textContent = hzFmt(chamber);
  }

  // ---------------------------------------------------------------- управление

  function unmuteUi() { $('#btnMute').classList.remove('muted'); $('#btnMute').textContent = '🔇 Звук выкл'; }

  // Глушит весь вывод сразу (двигатель в ворклете при этом стоит на паузе)
  async function toggleMute() {
    if (!S.ctx) return;
    const b = $('#btnMute');
    if (S.ctx.state === 'running') {
      await S.ctx.suspend();
      document.dispatchEvent(new Event('diesel:mute'));
      b.classList.add('muted'); b.textContent = '🔇 Звук заглушен';
    } else {
      await S.ctx.resume();
      b.classList.remove('muted'); b.textContent = '🔇 Звук выкл';
    }
  }

  // A/B: модель меняется на ходу, мотор продолжает крутиться
  function setModel(m) {
    S.model = m;
    $('#modelSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.model === m));
    post({ type: 'model', model: m });
  }

  function setThrottle(v) {
    S.throttle = Math.min(1, Math.max(0, v));
    $('#throttle').value = Math.round(S.throttle * 1000);
    $('#thrVal').textContent = pct(S.throttle);
    sendCtrl();
  }

  function bindControls() {
    $('#throttle').oninput = (e) => setThrottle(e.target.value / 1000);
    $('#load').oninput = (e) => {
      S.load = e.target.value / 1000;
      $('#loadVal').textContent = pct(S.load);
      sendCtrl();
    };
    $('#btnStart').onclick = async () => { await ensureAudio(); unmuteUi(); post({ type: 'start' }); };
    $('#btnStop').onclick = () => post({ type: 'stop' });
    $('#btnMute').onclick = toggleMute;
    $('#modelSeg').querySelectorAll('button').forEach((b) => { b.onclick = () => setModel(b.dataset.model); });
    $('#coldStart').onchange = (e) => post({ type: 'warm', value: e.target.checked && S.tele.rpm < 1 ? 0 : 1 });

    let pedalHeld = false;
    window.addEventListener('keydown', async (e) => {
      if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!pedalHeld) { pedalHeld = true; post({ type: 'ctrl', pedal: 1 }); }
      } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        e.preventDefault();
        setThrottle(S.throttle + (e.code === 'ArrowUp' ? 0.05 : -0.05));
      } else if (e.code === 'Enter') {
        e.preventDefault();
        await ensureAudio(); unmuteUi(); post({ type: 'start' });
      } else if (e.code === 'KeyV') {
        setModel(S.model === 'v2' ? 'v1' : 'v2');
      } else if (e.code === 'Escape') {
        post({ type: 'stop' });
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { pedalHeld = false; post({ type: 'ctrl', pedal: -1 }); }
    });

    const seg = $('#listener');
    for (const [k, L] of Object.entries(LISTENERS)) {
      const b = document.createElement('button');
      b.textContent = L.label;
      b.className = k === S.listener ? 'on' : '';
      b.onclick = () => {
        S.listener = k;
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        applyMix();
      };
      seg.appendChild(b);
    }

    const mixer = $('#mixer');
    for (const m of MIXER) {
      const row = document.createElement('div');
      row.className = 'mix-row';
      row.innerHTML = `<span>${m.label}</span><input type="range" min="0" max="200"><output></output>`;
      const r = row.querySelector('input'), o = row.querySelector('output');
      r.value = Math.round(S.mix[m.k] * 100);
      o.textContent = pct(S.mix[m.k]);
      r.oninput = () => { S.mix[m.k] = r.value / 100; o.textContent = pct(S.mix[m.k]); applyMix(); };
      mixer.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- рисование

  function fitCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [g, cv.clientWidth, cv.clientHeight];
  }

  function niceScale(max) {
    const top = max * 1.12;
    const raw = top / 8, p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
    return { step, top: Math.ceil(top / step) * step };
  }

  function drawTach() {
    const [g, w, h] = fitCanvas($('#tach'));
    const c = S.cfg, { step, top } = niceScale(c.max);
    const cx = w / 2, cy = h * 0.56, R = Math.min(w / 2, h * 0.56) - 8;
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    const ang = (v) => a0 + (a1 - a0) * Math.min(1.02, v / top);
    g.clearRect(0, 0, w, h);

    g.lineWidth = 6; g.strokeStyle = '#232a32';
    g.beginPath(); g.arc(cx, cy, R, a0, a1); g.stroke();
    g.strokeStyle = '#ff4a3d';
    g.beginPath(); g.arc(cx, cy, R, ang(c.max), a1); g.stroke();
    g.strokeStyle = '#7a5600';
    g.beginPath(); g.arc(cx, cy, R, ang(c.idle * 0.98), ang(c.idle * 1.02)); g.stroke();

    const k = top >= 2000 ? 1000 : 1;
    g.fillStyle = '#7f8a96'; g.strokeStyle = '#7f8a96';
    g.font = `${Math.max(10, R * 0.09)}px ui-monospace, Consolas, monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let v = 0; v <= top + 1e-6; v += step / 2) {
      const a = ang(v), major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
      g.lineWidth = major ? 2 : 1;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (R - (major ? 14 : 8)), cy + Math.sin(a) * (R - (major ? 14 : 8)));
      g.lineTo(cx + Math.cos(a) * (R - 3), cy + Math.sin(a) * (R - 3));
      g.stroke();
      if (major) {
        const t = k > 1 ? +(v / k).toFixed(1) : v;
        g.fillText(String(t), cx + Math.cos(a) * (R - 30), cy + Math.sin(a) * (R - 30));
      }
    }
    if (k > 1) { g.fillText('×1000', cx, cy - R * 0.35); }

    const a = ang(S.shownRpm);
    g.strokeStyle = '#ffb000'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * (R - 10), cy + Math.sin(a) * (R - 10)); g.stroke();
    g.fillStyle = '#ffb000'; g.beginPath(); g.arc(cx, cy, 6, 0, Math.PI * 2); g.fill();

    g.fillStyle = '#d7dde3';
    g.font = `700 ${Math.max(18, R * 0.24)}px ui-monospace, Consolas, monospace`;
    g.fillText(Math.round(S.shownRpm).toString(), cx, cy + R * 0.42);
    g.fillStyle = '#7f8a96';
    g.font = `${Math.max(10, R * 0.08)}px system-ui, sans-serif`;
    g.fillText('об/мин', cx, cy + R * 0.62);
  }

  function drawWave() {
    const [g, w, h] = fitCanvas($('#wave'));
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#232a32'; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    if (!S.a) return;
    S.a.an.getFloatTimeDomainData(S.time);
    const n = S.time.length;
    g.strokeStyle = '#ffb000'; g.lineWidth = 1.2; g.beginPath();
    for (let x = 0; x < w; x++) {
      const v = S.time[Math.floor(x / w * n)];
      const y = h / 2 - v * h * 0.45;
      x ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }

  function drawSpectrum() {
    const [g, w, h] = fitCanvas($('#spectrum'));
    g.clearRect(0, 0, w, h);
    const fMin = 10, fMax = 20000;
    const xOf = (f) => Math.log(f / fMin) / Math.log(fMax / fMin) * w;
    g.font = '10px ui-monospace, Consolas, monospace'; g.fillStyle = '#4b5561'; g.textBaseline = 'top';
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = xOf(f);
      g.strokeStyle = '#1b2026'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, 2);
    }
    // гармоники частоты вспышек и резонанс камеры
    const ff = S.tele.fireHz;
    if (ff > 0.5) {
      g.strokeStyle = 'rgba(73,169,255,0.35)';
      for (let k = 1; k <= 4; k++) { const x = xOf(ff * k); g.beginPath(); g.moveTo(x, 12); g.lineTo(x, h); g.stroke(); }
    }
    const ch = 1000 / (Math.PI * S.cfg.bore / 1000) * 1.841;
    g.strokeStyle = 'rgba(255,74,61,0.5)'; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(xOf(ch), 12); g.lineTo(xOf(ch), h); g.stroke(); g.setLineDash([]);
    if (!S.a) return;
    S.a.an.getFloatFrequencyData(S.freq);
    const sr = S.ctx.sampleRate, bins = S.freq.length;
    g.fillStyle = 'rgba(255,176,0,0.18)'; g.strokeStyle = '#ffb000'; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(0, h);
    for (let x = 0; x <= w; x += 2) {
      const f = fMin * Math.pow(fMax / fMin, x / w);
      const i = Math.min(bins - 1, Math.max(1, Math.round(f / (sr / 2) * bins)));
      const db = Math.max(-110, S.freq[i]);
      g.lineTo(x, h - (db + 110) / 100 * h);
    }
    g.lineTo(w, h); g.closePath(); g.fill(); g.stroke();
  }

  // Индикаторная диаграмма: давление первого цилиндра по углу коленвала
  function drawPv() {
    const [g, w, h] = fitCanvas($('#pv'));
    g.clearRect(0, 0, w, h);
    const pv = S.tele.pv;
    const pTop = Math.max(80, Math.ceil((S.tele.pMax || 0) / 40) * 40);
    g.font = '10px ui-monospace, Consolas, monospace'; g.fillStyle = '#4b5561'; g.textBaseline = 'top';
    for (const a of [-180, -90, 0, 90, 180]) {
      const x = (a + 180) / 360 * w;
      g.strokeStyle = a === 0 ? '#3a2a00' : '#1b2026'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      g.fillText(`${a}°`, Math.min(x + 2, w - 28), h - 12);
    }
    for (let p = 40; p < pTop; p += 40) {
      const y = h - p / pTop * h;
      g.strokeStyle = '#1b2026'; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      g.fillText(`${p}`, 2, y + 1);
    }
    if (!pv) return;
    g.strokeStyle = '#ff7a1a'; g.lineWidth = 1.5; g.beginPath();
    for (let i = 0; i < pv.length; i++) {
      const x = (i + 0.5) / pv.length * w, y = h - Math.min(1, pv[i] / pTop) * h;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }

  function drawReadouts() {
    const t = S.tele, c = S.cfg;
    const maxBar = 0.5 + 2.5 * (c.turbo || 0);
    $('#vFuel').textContent = pct(t.fuel); $('#bFuel').style.width = pct(Math.min(1, t.fuel));
    $('#boostRow').style.opacity = c.turbo > 0 ? 1 : 0.35;
    const bar = c.turbo > 0 ? t.boost * maxBar : 0;
    $('#vBoost').textContent = `${bar.toFixed(2)} бар`; $('#bBoost').style.width = pct(c.turbo > 0 ? t.boost : 0);
    const temp = 20 + 65 * t.warm;
    $('#vTemp').textContent = `${Math.round(temp)} °C`; $('#bTemp').style.width = pct(t.warm);
    $('#vPmax').textContent = `${Math.round(t.pMax || 0)} бар`;
    $('#vFire').textContent = `${t.fireHz.toFixed(t.fireHz < 10 ? 1 : 0)} Гц`;
    $('#lampStarter').classList.toggle('lit', !!t.starter);
    $('#lampFuel').classList.toggle('lit', !!t.firing);
    $('#lampCold').classList.toggle('lit', t.warm < 0.6 && t.rpm > 1);
  }

  function frame() {
    S.shownRpm += (S.tele.rpm - S.shownRpm) * 0.35;
    drawTach(); drawPv(); drawWave(); drawSpectrum(); drawReadouts();
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- старт

  window.dieselLab = S; // для отладки из консоли
  S.cfg = JSON.parse(JSON.stringify(S.preset));
  renderEngines();
  renderBuilder();
  updateDerived();
  bindControls();
  requestAnimationFrame(frame);
})();
