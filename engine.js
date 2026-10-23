/*
 * Процедурный синтез звука дизеля: ядро DSP + AudioWorklet-процессор.
 *
 * Всё тело лежит внутри одной функции, чтобы:
 *  - страница могла превратить её в модуль ворклета через toString() + Blob;
 *  - Node мог вызвать её напрямую для офлайн-тестов (tools/render-test.js).
 *
 * Модель v2 — всё растёт из давления в цилиндре:
 *  - p(θ) каждого цилиндра = компрессия (политропа) + сгорание по двойной Вибе
 *    (быстрая премикс-фаза, длительность которой задана во времени, и
 *    диффузионная фаза, заданная в градусах), спад при открытии выпуска;
 *  - параметры сгорания защёлкиваются на каждый цикл с разбросом: подача,
 *    угол впрыска, задержка воспламенения, доля премикса;
 *  - блок: Σp → кривая структурного ослабления (ФВЧ 4-го порядка, по Austen–Priede)
 *    → прямое излучение + плотный банк мод корпуса; низ — Σp через ФНЧ;
 *  - выпуск: сила продувки ~ √p в момент открытия клапана, труба, глушитель;
 *  - вращение: мгновенная скорость из реального момента цилиндров
 *    (крутильная неравномерность: «спотыкание» на прокрутке, неровный ХХ);
 *  - регулятор «плавает» на холостом ходу.
 */
function DIESEL_WORKLET_SOURCE() {
  'use strict';

  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;
  const C_GAS = 1000;     // скорость звука в горячем газе в цилиндре, м/с
  const C_EXH = 550;      // скорость звука в выпускной трубе, м/с
  const PIPE_LEN = 32768; // длина линии задержки трубы (степень двойки)
  const PIPE_MASK = PIPE_LEN - 1;
  const MAX_CYL = 24;
  const N_MODES = 28;     // моды корпуса
  const K_COMB = 80;      // прирост давления от сгорания при полной подаче, бар
  const T_MIN = -180, T_MAX = 260, T_STEP = 0.5; // таблицы по углу, град
  const PV_BINS = 180;    // индикаторная диаграмма для UI: −180…+180° по 2°

  // Выходные множители каналов (откалиброваны tools/render-test.js)
  const G_EX = 0.5, G_THUMP = 0.003, G_STRUCT = 0.065, G_MODES = 0.05, G_CHAMBER = 0.03,
    G_TICK = 0.05, G_INTAKE = 0.25, G_START = 0.22, G_TURBO = 0.16;

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

  // Пересечение угла th при переходе prev → deg (с учётом перехода через 0)
  function crossed(prev, deg, th, wrapped) {
    return wrapped ? (th > prev || th <= deg) : (prev < th && th <= deg);
  }

  class Rng {
    constructor(seed) { this.s = (seed | 0) || 0x2545f491; }
    next() { // xorshift32 → [-1, 1)
      let x = this.s;
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      this.s = x;
      return (x >>> 0) / 2147483648 - 1;
    }
    gauss() { return (this.next() + this.next() + this.next()) * 0.577; }
  }

  // Двухполюсный резонатор: импульсная характеристика ≈ затухающий синус амплитуды 1
  class Reson {
    constructor() { this.y1 = 0; this.y2 = 0; this.a1 = 0; this.a2 = 0; this.g = 0; }
    set(f, q, sr) {
      if (!(f > 0) || f >= sr * 0.45) { this.g = 0; this.a1 = 0; this.a2 = 0; return; }
      const w = TAU * f / sr, r = Math.exp(-Math.PI * f / (q * sr));
      this.a1 = 2 * r * Math.cos(w); this.a2 = -r * r; this.g = Math.sin(w);
    }
    tick(x) {
      const y = x * this.g + this.a1 * this.y1 + this.a2 * this.y2;
      this.y2 = this.y1; this.y1 = y;
      return y;
    }
  }

  class Biquad { // RBJ
    constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
    _set(b0, b1, b2, a0, a1, a2) { this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; }
    lowpass(f, q, sr) {
      const w = TAU * Math.min(f, sr * 0.45) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
      this._set((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al);
    }
    highpass(f, q, sr) {
      const w = TAU * Math.min(f, sr * 0.45) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
      this._set((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al);
    }
    tick(x) {
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      return y;
    }
  }

  class OnePole {
    constructor() { this.y = 0; this.a = 1; }
    set(f, sr) { this.a = 1 - Math.exp(-TAU * Math.min(f, sr * 0.45) / sr); }
    tick(x) { return (this.y += this.a * (x - this.y)); }
  }

  class DieselCore {
    constructor(sr) {
      this.sr = sr;
      this.rng = new Rng(0x1234567);
      this.cfg = null;
      // управление
      this.throttle = 0; this.load = 0; this.pedal = -1;
      this.fuelOn = false; this.starter = false; this.crankTime = 0;
      // состояние двигателя (n — обороты, нормированные на максимальные)
      this.n = 0; this.fuel = 0; this.boost = 0; this.warm = 1;
      this.phi = 0; this.firing = false; this.stopped = true;
      this.hunt = 0; this.huntV = 0;           // «плавание» регулятора
      this.tq = 0; this.tqMean = 0; this.dw = 0; // крутильная неравномерность
      // огибающие возбуждения резонаторов
      this.knockEnv = 0; this.mechEnv = 0; this.tickEnv = 0; this.starterEnv = 0;
      // генераторы
      this.turboPh = 0; this.motorPh = 0; this.fmNoise = 0; this.exPrev = 0;
      // цилиндры: статический разброс
      this.cylDeg = new Float64Array(MAX_CYL);
      this.fireAt = new Float64Array(MAX_CYL);
      this.sQ = new Float32Array(MAX_CYL);    // подача форсунки
      this.sInj = new Float32Array(MAX_CYL);  // угол впрыска, град
      this.sEx = new Float32Array(MAX_CYL);   // «громкость» патрубка выпуска
      this.sExD = new Float32Array(MAX_CYL);  // запаздывание импульса по длине патрубка, град
      // цилиндры: параметры текущего цикла
      this.cQ = new Float32Array(MAX_CYL);    // подача (0 — пропуск)
      this.cQp = new Float32Array(MAX_CYL);   // доля премикса
      this.cSoc = new Float32Array(MAX_CYL);  // начало сгорания, град от ВМТ
      this.cDp = new Float32Array(MAX_CYL);   // длительность премикса, град
      this.cDd = new Float32Array(MAX_CYL);   // длительность диффузии, град
      this.cylP = new Float32Array(MAX_CYL);  // сила продувки выпуска
      // индикаторная диаграмма цилиндра №1 для UI
      this.pv = new Float32Array(PV_BINS); this.pMax = 0; this.pMaxHold = 0;
      // фильтры
      this.chamber = [new Reson(), new Reson(), new Reson()];
      this.modes = []; this.modeG = new Float32Array(N_MODES);
      for (let i = 0; i < N_MODES; i++) this.modes.push(new Reson());
      this.saHP1 = new Biquad(); this.saHP2 = new Biquad(); this.saLP = new Biquad();
      this.tickR = [new Reson(), new Reson()];
      this.thumpHP = new Biquad(); this.thumpLP = new Biquad();
      this.exDC = new OnePole(); this.turbLP = new OnePole();
      this.pipeBuf = new Float32Array(PIPE_LEN); this.pipeIdx = 0; this.pipeD = 1; this.pipeG = -0.5;
      this.pipeLP = new OnePole();
      this.muffler = new Biquad(); this.muffler2 = new OnePole();
      this.hissLP = new OnePole(); this.hissHP = new OnePole();
      this.intakeLP = new OnePole(); this.airLP = new OnePole(); this.airHP = new OnePole();
    }

    setConfig(cfg, reset, cold) {
      const sr = this.sr;
      const prevRpm = this.cfg ? this.n * this.cfg.max : 0;
      const c = Object.assign({}, cfg);
      c.N = clamp(Math.round(c.cyl), 1, MAX_CYL);
      c.four = c.stroke !== 2;
      c.cycleDeg = c.four ? 720 : 360;
      c.B = clamp(c.bore, 20, 1200) / 1000;
      c.max = Math.max(20, c.max);
      c.idle = clamp(c.idle, c.max * 0.05, c.max * 0.85);
      c.crank = clamp(c.crank, c.idle * 0.15, c.idle * 0.8);
      c.nIdle = c.idle / c.max;
      c.nCrank = c.crank / c.max;
      c.nFire = c.nCrank * 0.6;
      c.starterT = (0.04 + 0.2 * c.nCrank + 0.15 * c.nCrank * c.nCrank) / 0.15;
      c.exOpen = c.four ? 130 : 95;
      c.exDur = c.four ? 240 : 150;
      c.ivc = c.four ? 570 : -1;
      c.winA = c.four ? -150 : -100;     // окно, где в цилиндре есть давление
      c.winB = c.exOpen + 60;
      c.degPerSampleMax = c.max / 60 * 360 / sr;
      c.inertia = Math.max(0.05, c.inertia);
      c.turboLag = Math.max(0.05, c.turboLag || 1);
      c.turbo = clamp(c.turbo || 0, 0, 1);
      c.turboHz = c.turboHz || 4000;
      c.uneven = c.uneven || 0;
      c.cr = c.B < 0.15 ? 17 : 14;       // степень сжатия
      c.premixMs = 0.35 * Math.pow(c.B / 0.1, 0.6); // премикс горит за доли мс, крупнее — дольше
      c.qp0 = 0.1 * (c.knock ?? 1);      // сколько топлива успевает перемешаться за задержку

      // таблицы по углу: компрессия (бар изб.) и множитель расширения (V_ВМТ/V)^1.3, со спадом после открытия выпуска
      const nT = Math.round((T_MAX - T_MIN) / T_STEP) + 1;
      this.tPm = new Float32Array(nT); this.tEx = new Float32Array(nT);
      for (let k = 0; k < nT; k++) {
        const th = T_MIN + k * T_STEP;
        const v = 1 + (c.cr - 1) / 2 * (1 - Math.cos(th * DEG));
        const blow = th > c.exOpen ? Math.exp(-Math.pow((th - c.exOpen) / 18, 2)) : 1;
        this.tPm[k] = Math.max(0, Math.pow(c.cr / v, 1.35) - 1) * blow;
        this.tEx[k] = Math.pow(1 / v, 1.3) * blow;
      }

      // статический разброс цилиндров: детерминированный, чтобы живые правки не «прыгали»
      const r = new Rng(7919 * c.N + 13);
      for (let i = 0; i < c.N; i++) {
        this.sQ[i] = (0.03 + c.uneven * 1.2) * r.gauss();
        this.sInj[i] = (0.4 + c.uneven * 12) * r.gauss();
        this.sEx[i] = Math.max(0.4, 1 + (0.15 + c.uneven * 2) * r.gauss());
        this.sExD[i] = (2 + c.uneven * 60) * r.gauss();
        let f = (i + c.uneven * 0.3 * r.next()) / c.N;
        f -= Math.floor(f);
        this.fireAt[i] = f;
      }

      // камера сгорания: нули производной функции Бесселя (1,0), (2,0), (0,1)
      const f0 = C_GAS / (Math.PI * c.B);
      c.chamberHz = f0 * 1.841;
      [1.841, 3.054, 3.832].forEach((k, j) => this.chamber[j].set(f0 * k, 22, sr));

      // корпус: структурное ослабление + плотный набор мод, масштаб по размеру двигателя
      const bs = Math.sqrt(0.1 / c.B);
      const fSA = clamp(1000 * bs, 250, 1600);
      this.saHP1.highpass(fSA, 0.7, sr); this.saHP2.highpass(fSA, 0.7, sr);
      this.saLP.lowpass(clamp(7000 * bs, 2500, 12000), 0.7, sr);
      const mr = new Rng(424242 + Math.round(c.bore));
      const fLo = 280 * bs, fHi = 6500 * bs;
      for (let i = 0; i < N_MODES; i++) {
        const f = fLo * Math.pow(fHi / fLo, (i + 0.5 + 0.45 * mr.next()) / N_MODES);
        const q = (c.B > 0.2 ? 30 : 18) * (1 + 0.4 * mr.next());
        this.modes[i].set(f, q, sr);
        this.modeG[i] = (0.6 + 0.4 * mr.next()) / Math.sqrt(N_MODES);
      }
      const tf = 6500 * Math.pow(0.1 / c.B, 0.35);
      this.tickR[0].set(tf, 30, sr); this.tickR[1].set(tf * 1.53, 25, sr);
      this.knockDecay = Math.exp(-1 / (0.00025 * Math.pow(c.B / 0.08, 0.6) * sr));
      this.mechDecay = Math.exp(-1 / (0.0004 * Math.pow(c.B / 0.08, 0.5) * sr));
      this.tickDecay = Math.exp(-1 / (0.00012 * sr));
      this.thumpHP.highpass(18, 0.7, sr);
      this.thumpLP.lowpass(clamp(320 * bs, 90, 420), 0.7, sr);
      this.exDC.set(10, sr); this.turbLP.set(2500, sr);
      this.pipeD = clamp(Math.round(2 * c.pipe / C_EXH * sr), 8, PIPE_LEN - 2);
      this.pipeG = c.pipe > 10 ? -0.35 : -0.55;
      this.pipeLP.set(c.pipe > 10 ? 700 : 2200, sr);
      this.muffler.lowpass(c.muffler, 0.8, sr); this.muffler2.set(c.muffler * 1.5, sr);
      this.hissLP.set(c.turboHz * 0.7, sr); this.hissHP.set(900, sr);
      this.intakeLP.set(600, sr);
      this.airLP.set(3500, sr); this.airHP.set(1200, sr);
      this.cfg = c;

      if (reset) {
        this.n = 0; this.fuel = 0; this.boost = 0; this.phi = 0;
        this.fuelOn = false; this.starter = false; this.firing = false; this.stopped = true;
        this.warm = cold ? 0 : 1;
        this.dw = 0; this.tq = 0; this.tqMean = 0; this.hunt = 0; this.huntV = 0;
        this.cQ.fill(0); this.cQp.fill(0); this.cylP.fill(0); this.pipeBuf.fill(0); this.pv.fill(0);
        this.cSoc.fill(0); this.cDp.fill(1); this.cDd.fill(40);
      } else {
        this.n = clamp(prevRpm / c.max, 0, 1.2);
      }
      for (let i = 0; i < c.N; i++) {
        let d = this.phi - this.fireAt[i]; if (d < 0) d += 1;
        this.cylDeg[i] = d * c.cycleDeg;
      }
    }

    start() {
      if (!this.cfg) return;
      if (this.fuelOn && this.n > this.cfg.nIdle * 0.6) return;
      this.fuelOn = true; this.starter = true; this.crankTime = 0; this.stopped = false;
      this.mechEnv = Math.max(this.mechEnv, 1.6); // щелчок втягивающего реле / клапана пускового воздуха
    }

    stop() { this.fuelOn = false; this.starter = false; }

    // Медленная динамика: регулятор, крутящий момент, турбина. Раз на блок.
    dynamics(dt) {
      const c = this.cfg;
      let n = this.n;
      if (this.starter) {
        this.crankTime += dt;
        if ((this.firing && n > c.nCrank * 1.6) || this.crankTime > 12) {
          this.starter = false;
          this.mechEnv = Math.max(this.mechEnv, 0.9);
        }
      }
      const loss = (n > 1e-4 ? 0.04 : 0) + 0.2 * n + 0.15 * n * n;
      const loadT = this.load * (0.85 * n * n + 0.1 * n);
      const canFire = this.fuelOn && n > c.nFire && !(this.starter && this.crankTime < c.startDelay);
      this.firing = canFire;
      const th = this.pedal >= 0 ? this.pedal : this.throttle;

      // «плавание» регулятора: медленный шум ~0.5 Гц, заметен на ХХ без нагрузки
      this.huntV += (this.rng.next() * 3 - this.huntV) * Math.min(1, dt * 3);
      this.hunt += (this.huntV - this.hunt) * Math.min(1, dt * 3);

      let fuel = 0;
      if (canFire) {
        const fmax = 1 - c.turbo * 0.5 * (1 - this.boost); // ограничитель дымности до раскрутки турбины
        const nIdle = c.nIdle * (1 + 0.15 * (1 - this.warm)); // повышенный ХХ на холодную
        const ff = (loss + loadT) / 1.4;
        if (c.gov === 'pedal') {
          // педаль = подача топлива, регулятор держит только ХХ и максимум
          fuel = Math.max(ff + 8 * (nIdle - n), th * th * fmax);
          if (n > 1) fuel = Math.min(fuel, ff + 8 * (1 - n));
        } else {
          // всережимный регулятор: рычаг задаёт обороты
          fuel = ff + 8 * (nIdle + th * (1 - nIdle) - n);
        }
        fuel += ff * 0.25 * this.hunt * (1 - th) * Math.max(0, 1 - this.load);
        fuel = clamp(fuel, 0, fmax);
      }
      this.fuel += (fuel - this.fuel) * Math.min(1, dt / 0.025);

      let torque = 1.4 * this.fuel - loss - loadT;
      if (this.starter) torque += c.starterT * Math.max(0, 1 - n / c.nCrank);
      // без топлива компрессия тормозит быстрее: тяжёлые моторы не выбегают минутами
      const J = this.fuelOn ? c.inertia : Math.min(c.inertia, 2.5);
      n += torque / J * dt;
      if (n <= 0.002 && !this.starter && torque < 0) {
        if (!this.stopped) this.mechEnv = Math.max(this.mechEnv, 0.7); // коленвал «качнулся» и встал
        n = 0; this.stopped = true;
      }
      if (this.stopped && !this.starter) { n = 0; if (!this.fuelOn) this.fuel = 0; } // остаток топлива не должен «подталкивать» вал
      this.n = clamp(n, 0, 1.3);

      const bt = Math.min(1, this.fuel * (0.25 + 0.75 * this.n) * 1.3 + 0.06 * this.n);
      this.boost += (bt - this.boost) * Math.min(1, dt / (bt > this.boost ? c.turboLag : c.turboLag * 1.8));
      if (this.firing) this.warm = Math.min(1, this.warm + dt / c.warmTau);
      this.starterEnv += ((this.starter ? 1 : 0) - this.starterEnv) * Math.min(1, dt / 0.02);
    }

    // Параметры рабочего цикла цилиндра: защёлкиваются до начала сжатия
    latch(i) {
      const c = this.cfg, rng = this.rng, nn = Math.min(this.n, 1);
      let q = 0;
      if (this.firing) {
        const missP = this.n < c.nIdle * 0.85 ? 0.25 * (1 - this.warm) + (this.starter ? 0.05 : 0) : 0;
        if (rng.next() * 0.5 + 0.5 >= missP) {
          q = Math.max(0.02, this.fuel) * Math.max(0.2, 1 + this.sQ[i] + 0.05 * rng.gauss());
        }
      }
      const cold = 1 - this.warm;
      const degPerMs = this.n * c.max * 0.006;
      const inj = -(8 + 6 * nn) + this.sInj[i] + 0.4 * rng.gauss();               // опережение впрыска
      const delayMs = (0.55 + 0.6 * cold + 0.25 * (1 - this.boost)) * (1 + 0.1 * rng.gauss());
      const qp = Math.min(q, c.qp0 * (1 + 0.8 * cold) * (1 + 0.2 * rng.gauss()));
      this.cQ[i] = q;
      this.cQp[i] = Math.max(0, qp);
      this.cSoc[i] = inj + delayMs * degPerMs;
      this.cDp[i] = Math.max(1e-3, c.premixMs * (1 + 0.15 * rng.gauss()) * degPerMs);
      this.cDd[i] = (35 + 30 * q) * (1 + 0.1 * rng.gauss());
    }

    // Давление в цилиндре (бар изб.) при локальном угле th от ВМТ сгорания
    pressure(i, th, pBoost) {
      const k = (th - T_MIN) / T_STEP, k0 = k | 0, fr = k - k0;
      const pm = this.tPm[k0] + (this.tPm[k0 + 1] - this.tPm[k0]) * fr;
      let p = pm * pBoost;
      const q = this.cQ[i];
      if (q > 0) {
        const u = th - this.cSoc[i];
        if (u > 0) {
          const ex = this.tEx[k0] + (this.tEx[k0 + 1] - this.tEx[k0]) * fr;
          const a = u / this.cDp[i], b = u / this.cDd[i];
          const xp = a > 2.5 ? 1 : 1 - Math.exp(-6.9 * a * a * a);
          const xd = 1 - Math.exp(-6.9 * b * b);
          const qp = this.cQp[i];
          p += K_COMB * pBoost * (qp * xp + (q - qp) * xd) * ex;
        }
      }
      return p;
    }

    render(ex, bl, tu, len) {
      const c = this.cfg, sr = this.sr, N = c.N, cyc = c.cycleDeg, rng = this.rng;
      this.dynamics(len / sr);

      const n = this.n, fuel = this.fuel, nn = Math.min(n, 1);
      const cycPerSec = c.max / 60 / (c.four ? 2 : 1);
      const degPerSec = c.max / 60 * 360;
      const pBoost = 1 + 1.5 * c.turbo * this.boost;
      const injAmt = c.mech * 0.45;
      const valveAmt = c.mech * 0.35 * (0.4 + 0.6 * nn);
      const tS = c.turbo > 0 ? Math.min(1, 0.12 * Math.min(1, n / c.nIdle) + 0.88 * this.boost) : 0;
      const tHz = c.turboHz * (0.3 + 0.7 * tS);
      const tAmpW = c.turbo * tS * tS * Math.sqrt(tS) * 0.5;
      const tAmpH = c.turbo * tS * tS * 0.6;
      const intakeAmt = (c.turbo > 0 ? 0.3 : 1) * nn * (0.2 + fuel) * G_INTAKE;
      const exAtt = 1 - 0.45 * c.turbo * this.boost; // турбина гасит пульсации выпуска
      const stEnv = this.starterEnv, air = c.starter === 'air';
      const kd = this.knockDecay, md = this.mechDecay, td = this.tickDecay;
      // dQ/dt растёт с оборотами линейно; нормируем, чтобы громкость шла как √n
      const radNorm = 1 / (c.degPerSampleMax * Math.sqrt(Math.max(nn, 0.04)));
      // крутильная неравномерность: Δω/ω ~ ∫(M − M̄)dθ / (J·ω²); при подобии размеров от диаметра почти не зависит
      const torK = 0.0003 / (Math.max(n, 0.03) * Math.max(n, 0.03) * Math.sqrt(N));
      const winA = c.winA, winB = c.winB, latchDeg = cyc + winA - 15;
      let knockEnv = this.knockEnv, mechEnv = this.mechEnv, tickEnv = this.tickEnv;
      let phi = this.phi, dw = this.dw, tqMean = this.tqMean;
      let pMax = this.pMax;

      for (let s = 0; s < len; s++) {
        const nInst = n * (1 + dw);
        const dDeg = nInst * degPerSec / sr;          // шаг коленвала, град
        phi += nInst * cycPerSec / sr;
        if (phi >= 1) phi -= 1;

        let exFlow = 0, pSum = 0, tq = 0;
        for (let i = 0; i < N; i++) {
          let d = phi - this.fireAt[i]; if (d < 0) d += 1;
          const deg = d * cyc, prev = this.cylDeg[i];
          if (deg !== prev) {
            this.cylDeg[i] = deg;
            const wrapped = deg < prev;
            if (crossed(prev, deg, latchDeg, wrapped)) this.latch(i);
            if (this.firing && crossed(prev, deg, cyc - 14, wrapped)) {
              tickEnv = Math.max(tickEnv, injAmt * (0.8 + 0.2 * rng.next()));
            }
            const soc = this.cSoc[i] < 0 ? cyc + this.cSoc[i] : this.cSoc[i];
            if (this.cQp[i] > 0 && crossed(prev, deg, soc, wrapped)) {
              // газовые колебания в камере после резкого премикса
              knockEnv = Math.max(knockEnv, this.cQp[i] / c.qp0 * (c.knock ?? 1) * 0.8 * (0.85 + 0.25 * rng.next()));
            }
            if (crossed(prev, deg, c.exOpen, wrapped)) {
              const pe = this.pressure(i, c.exOpen, pBoost);
              this.cylP[i] = 0.55 * Math.sqrt(Math.max(0, pe)) * this.sEx[i] * (1 + 0.06 * rng.gauss()) *
                (0.6 + 0.4 * Math.min(1, n / c.nIdle));
            }
            if (crossed(prev, deg, c.exOpen + c.exDur, wrapped) || (c.ivc > 0 && crossed(prev, deg, c.ivc, wrapped))) {
              mechEnv = Math.max(mechEnv, valveAmt * (0.75 + 0.25 * rng.next()));
            }
          }
          // давление в цилиндре
          const th = deg > cyc + winA ? deg - cyc : deg;
          if (th >= winA && th <= winB) {
            const p = this.pressure(i, th, pBoost);
            pSum += p;
            tq += p * Math.sin(th * DEG);
            if (i === 0) {
              const b = ((th + 180) * 0.5) | 0;
              if (b >= 0 && b < PV_BINS) this.pv[b] = p;
              if (p > pMax) pMax = p;
            }
          } else if (i === 0 && th > winB && th < 180) {
            const b = ((th + 180) * 0.5) | 0;
            this.pv[b] = 0;
          }
          // выпуск: продувка после открытия клапана
          let x = (deg - c.exOpen - this.sExD[i]) / c.exDur;
          if (x < -0.5) x += cyc / c.exDur;
          if (x > 0 && x < 1) exFlow += this.cylP[i] * (1 - Math.exp(-30 * x)) * Math.exp(-4 * x) * (1 - x);
        }

        // крутильная неравномерность: интегрируем момент без среднего по углу, с утечкой
        if (n > 0) {
          tqMean += (tq - tqMean) * Math.min(1, dDeg / cyc);
          dw = clamp((dw + (tq - tqMean) * dDeg * DEG * torK) * (1 - dDeg / cyc), -0.3, 0.3);
        }

        const z1 = rng.next(), z2 = rng.next(), z3 = rng.next(), z4 = rng.next();

        // --- выпуск
        const exhp = exFlow - this.exDC.tick(exFlow);
        const rad = (exFlow - this.exPrev) * radNorm;
        this.exPrev = exFlow;
        const turb = this.turbLP.tick(z4) * exFlow * 0.8;
        const e = (0.6 * exhp + 5 * rad + turb) * exAtt;
        const y = e + this.pipeG * this.pipeLP.tick(this.pipeBuf[(this.pipeIdx - this.pipeD) & PIPE_MASK]);
        this.pipeBuf[this.pipeIdx] = y;
        this.pipeIdx = (this.pipeIdx + 1) & PIPE_MASK;
        ex[s] = this.muffler2.tick(this.muffler.tick(y)) * G_EX;

        // --- блок: давление через структуру, моды корпуса, механика, впуск, стартер
        const sa = this.saLP.tick(this.saHP2.tick(this.saHP1.tick(pSum)));
        const kIn = z1 * knockEnv; knockEnv *= kd;
        const mIn = z2 * mechEnv; mechEnv *= md;
        const tIn = z3 * tickEnv; tickEnv *= td;
        const ch = this.chamber[0].tick(kIn) + 0.6 * this.chamber[1].tick(kIn) + 0.4 * this.chamber[2].tick(kIn);
        const mx = sa * 0.15 + mIn * 0.5;
        let modes = 0;
        for (let k = 0; k < N_MODES; k++) modes += this.modes[k].tick(mx) * this.modeG[k];
        const tk = this.tickR[0].tick(tIn + 0.4 * mIn) + 0.5 * this.tickR[1].tick(tIn);
        const thump = this.thumpLP.tick(this.thumpHP.tick(pSum));
        const intake = this.intakeLP.tick(z4) * intakeAmt;

        let st = 0;
        if (stEnv > 1e-4) {
          const pulse = 1 + 6 * dw; // стартер «спотыкается» вместе с коленвалом
          if (air) {
            const a = this.airLP.tick(z2);
            st = stEnv * (a - this.airHP.tick(a)) * clamp(pulse, 0.3, 1.6) * 3;
          } else {
            this.motorPh += nInst * c.max / 60 * 11 / sr;
            this.motorPh -= Math.floor(this.motorPh);
            const mp = this.motorPh;
            st = stEnv * (0.35 * Math.sin(TAU * 9 * mp) + 0.18 * Math.sin(TAU * 18 * mp + 1) + 0.25 * Math.sin(TAU * mp) + 0.12 * z3);
          }
        }
        bl[s] = thump * G_THUMP + sa * G_STRUCT + modes * G_MODES + ch * G_CHAMBER + tk * G_TICK + intake + st * G_START;

        // --- турбина
        if (c.turbo > 0) {
          this.fmNoise += (z1 - this.fmNoise) * 0.0005;
          this.turboPh += tHz * (1 + 0.5 * this.fmNoise) / sr;
          this.turboPh -= Math.floor(this.turboPh);
          const p = this.turboPh;
          const w = (Math.sin(TAU * p) + 0.3 * Math.sin(TAU * 2 * p + 0.7)) * (1 + 0.25 * exFlow);
          const hl = this.hissLP.tick(z2);
          tu[s] = (tAmpW * w + tAmpH * 2 * (hl - this.hissHP.tick(hl))) * G_TURBO;
        } else {
          tu[s] = 0;
        }
      }

      this.phi = phi; this.dw = dw; this.tqMean = tqMean; this.pMax = pMax;
      this.knockEnv = knockEnv; this.mechEnv = mechEnv; this.tickEnv = tickEnv;
    }

    telemetry() {
      const c = this.cfg;
      this.pMaxHold = Math.max(this.pMax, this.pMaxHold * 0.985); // держим дольше цикла медленных моторов
      this.pMax = 0;
      return {
        type: 'tele',
        rpm: this.n * c.max,
        fuel: this.fuel,
        boost: this.boost,
        warm: this.warm,
        firing: this.firing,
        starter: this.starter,
        fireHz: this.n * c.max / 60 / (c.four ? 2 : 1) * c.N,
        dw: this.dw,
        pMax: this.pMaxHold,
        pv: this.pv.slice(),
      };
    }
  }

  if (typeof registerProcessor === 'function') {
    class DieselProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        // v1 — замороженная первая модель для A/B (engine-v1.js склеивается в тот же модуль)
        this.cores = { v2: new DieselCore(sampleRate) };
        if (typeof DIESEL_WORKLET_SOURCE_V1 === 'function') this.cores.v1 = new (DIESEL_WORKLET_SOURCE_V1())(sampleRate);
        this.core = this.cores.v2;
        this.fadeFrom = null; this.fade = 0;
        this.tmp = [new Float32Array(128), new Float32Array(128), new Float32Array(128)];
        this.scratch = new Float32Array(128);
        this.count = 0;
        this.port.onmessage = (e) => this.onMessage(e.data);
      }
      onMessage(m) {
        for (const k of Object.values(this.cores)) {
          switch (m.type) {
            case 'config': k.setConfig(m.cfg, m.reset, m.cold); break;
            case 'ctrl':
              if (m.throttle !== undefined) k.throttle = m.throttle;
              if (m.load !== undefined) k.load = m.load;
              if (m.pedal !== undefined) k.pedal = m.pedal;
              break;
            case 'start': if (k === this.core) k.start(); break;
            case 'stop': k.stop(); break;
            case 'warm': k.warm = m.value; break;
          }
        }
        if (m.type === 'model') this.switchTo(m.model);
      }
      // Переключение на ходу: переносим состояние мотора и 30 мс перекрёстно затухаем
      switchTo(name) {
        const to = this.cores[name], from = this.core;
        if (!to || to === from || !from.cfg) return;
        for (const f of ['n', 'fuel', 'boost', 'warm', 'phi', 'fuelOn', 'starter', 'crankTime', 'firing', 'stopped', 'starterEnv']) to[f] = from[f];
        const c = to.cfg;
        for (let i = 0; i < c.N; i++) {
          let d = to.phi - to.fireAt[i]; if (d < 0) d += 1;
          to.cylDeg[i] = d * c.cycleDeg;
        }
        this.fadeFrom = from; this.fade = 1;
        this.core = to;
      }
      process(inputs, outputs) {
        const o = outputs[0];
        if (!this.core.cfg || !o || !o[0]) return true;
        const len = o[0].length;
        if (this.scratch.length < len) this.scratch = new Float32Array(len);
        const out = [o[0], o[1] || this.scratch, o[2] || this.scratch];
        this.core.render(out[0], out[1], out[2], len);
        if (this.fadeFrom) {
          const t = this.tmp;
          if (t[0].length < len) for (let j = 0; j < 3; j++) t[j] = new Float32Array(len);
          this.fadeFrom.render(t[0], t[1], t[2], len);
          const step = 1 / (0.03 * sampleRate);
          for (let s = 0; s < len; s++) {
            const g = Math.max(0, this.fade - s * step);
            for (let j = 0; j < 3; j++) out[j][s] = out[j][s] * (1 - g) + t[j][s] * g;
          }
          this.fade -= len * step;
          if (this.fade <= 0) this.fadeFrom = null;
        }
        if (++this.count % 8 === 0) this.port.postMessage({ ...this.core.telemetry(), model: this.core === this.cores.v1 ? 'v1' : 'v2' });
        return true;
      }
    }
    registerProcessor('diesel-engine', DieselProcessor);
  }

  return DieselCore;
}

if (typeof module !== 'undefined' && module.exports) module.exports = DIESEL_WORKLET_SOURCE;
