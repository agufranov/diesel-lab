/*
 * Пресеты двигателей. Параметры близки к реальным машинам, остальное — на слух.
 *
 * cyl, stroke (2|4), bore (мм) — геометрия; bore задаёт резонанс камеры сгорания
 * idle, max, crank (об/мин) — холостой ход, максимум, прокрутка стартером
 * gov: 'pedal' — педаль = подача топлива (авто), 'speed' — рычаг задаёт обороты
 * starter: 'electric' | 'air'; startDelay (с) — сколько крутить до первой вспышки
 * inertia (с) — время свободного разгона; turbo 0..1, turboHz — свист на максимуме,
 * turboLag (с); pipe (м) — длина выпуска; muffler (Гц) — срез глушителя
 * knock, mech — дизельный стук и механика; uneven — разброс цилиндров
 * warmTau (с) — время прогрева; room — реверберация места; mix — баланс каналов
 */
(function (root) {
  const DIESEL_PRESETS = [
    {
      id: 'car', group: 'Дорожные', name: 'Легковой 1.9 TDI', tag: 'R4 · 4T · турбо',
      cyl: 4, stroke: 4, bore: 79.5, idle: 850, max: 4500, crank: 260,
      gov: 'pedal', starter: 'electric', startDelay: 0.45, inertia: 0.5,
      turbo: 0.55, turboHz: 8500, turboLag: 0.8, pipe: 3.2, muffler: 1500,
      knock: 1.0, mech: 0.5, uneven: 0.02, warmTau: 80,
      room: { size: 0.5, wet: 0.05 }, mix: { ex: 1, block: 1, turbo: 0.8 },
    },
    {
      id: 'tractor', group: 'Дорожные', name: 'Трактор МТЗ-80 (Д-240)', tag: 'R4 · 4T · атмо',
      cyl: 4, stroke: 4, bore: 110, idle: 700, max: 2250, crank: 180,
      gov: 'speed', starter: 'electric', startDelay: 0.6, inertia: 0.9,
      turbo: 0, turboHz: 0, turboLag: 1, pipe: 1.4, muffler: 3200,
      knock: 1.25, mech: 0.9, uneven: 0.05, warmTau: 120,
      room: { size: 0.4, wet: 0.04 }, mix: { ex: 1.1, block: 1, turbo: 0 },
    },
    {
      id: 'kamaz', group: 'Дорожные', name: 'КамАЗ-740', tag: 'V8 · 4T · турбо',
      cyl: 8, stroke: 4, bore: 120, idle: 600, max: 2600, crank: 170,
      gov: 'pedal', starter: 'electric', startDelay: 0.5, inertia: 0.8,
      turbo: 0.45, turboHz: 6500, turboLag: 1.0, pipe: 4.5, muffler: 1100,
      knock: 0.85, mech: 0.6, uneven: 0.04, warmTau: 120,
      room: { size: 0.5, wet: 0.05 }, mix: { ex: 1.1, block: 0.9, turbo: 0.8 },
    },
    {
      id: 'truck', group: 'Дорожные', name: 'Магистральный тягач 13 л', tag: 'R6 · 4T · турбо',
      cyl: 6, stroke: 4, bore: 130, idle: 550, max: 2000, crank: 150,
      gov: 'pedal', starter: 'electric', startDelay: 0.5, inertia: 1.0,
      turbo: 0.7, turboHz: 5500, turboLag: 1.2, pipe: 5, muffler: 900,
      knock: 0.6, mech: 0.5, uneven: 0.02, warmTau: 150,
      room: { size: 0.5, wet: 0.05 }, mix: { ex: 1, block: 0.9, turbo: 1 },
    },
    {
      id: 'genset', group: 'Промышленные', name: 'Дизель-генератор 1500', tag: 'V12 · 4T · 50 Гц',
      cyl: 12, stroke: 4, bore: 159, idle: 750, max: 1560, crank: 150,
      gov: 'speed', starter: 'electric', startDelay: 0.6, inertia: 1.5,
      turbo: 0.8, turboHz: 5000, turboLag: 1.5, pipe: 6, muffler: 800,
      knock: 0.55, mech: 0.6, uneven: 0.04, warmTau: 180,
      room: { size: 1.2, wet: 0.2 }, mix: { ex: 0.9, block: 1, turbo: 1 },
    },
    {
      id: 'emd', group: 'Промышленные', name: 'Тепловоз EMD 16-645', tag: 'V16 · 2T · турбо',
      cyl: 16, stroke: 2, bore: 230, idle: 315, max: 904, crank: 90,
      gov: 'speed', starter: 'electric', startDelay: 1.2, inertia: 3,
      turbo: 0.85, turboHz: 4200, turboLag: 2.5, pipe: 2.5, muffler: 2600,
      knock: 0.6, mech: 0.7, uneven: 0.04, warmTau: 200,
      room: { size: 1.0, wet: 0.08 }, mix: { ex: 1, block: 0.9, turbo: 1.1 },
    },
    {
      id: 'w32', group: 'Судовые и станционные', name: 'Wärtsilä 9L32', tag: 'R9 · 4T · 750 об/мин',
      cyl: 9, stroke: 4, bore: 320, idle: 400, max: 750, crank: 100,
      gov: 'speed', starter: 'air', startDelay: 1.5, inertia: 4,
      turbo: 0.9, turboHz: 3800, turboLag: 3, pipe: 8, muffler: 700,
      knock: 0.5, mech: 0.9, uneven: 0.02, warmTau: 300,
      room: { size: 2.0, wet: 0.35 }, mix: { ex: 0.8, block: 1, turbo: 1 },
    },
    {
      id: 'w46', group: 'Судовые и станционные', name: 'Wärtsilä 12V46', tag: 'V12 · 4T · 514 об/мин',
      cyl: 12, stroke: 4, bore: 460, idle: 300, max: 514, crank: 80,
      gov: 'speed', starter: 'air', startDelay: 1.8, inertia: 6,
      turbo: 0.95, turboHz: 3000, turboLag: 4, pipe: 10, muffler: 550,
      knock: 0.45, mech: 1.0, uneven: 0.02, warmTau: 350,
      room: { size: 2.6, wet: 0.4 }, mix: { ex: 0.8, block: 1, turbo: 1 },
    },
    {
      id: 'rtflex', group: 'Судовые и станционные', name: 'Wärtsilä RT-flex96C', tag: 'R14 · 2T · 102 об/мин',
      cyl: 14, stroke: 2, bore: 960, idle: 22, max: 102, crank: 12,
      gov: 'speed', starter: 'air', startDelay: 2.5, inertia: 14,
      turbo: 1, turboHz: 2200, turboLag: 6, pipe: 14, muffler: 300,
      knock: 0.35, mech: 1.2, uneven: 0.02, warmTau: 400,
      room: { size: 3.5, wet: 0.5 }, mix: { ex: 0.7, block: 1, turbo: 1 },
    },
  ];

  if (typeof module !== 'undefined' && module.exports) module.exports = DIESEL_PRESETS;
  else root.DIESEL_PRESETS = DIESEL_PRESETS;
})(typeof window !== 'undefined' ? window : globalThis);
