/* Shift planner core: demand model, MILP builder, solution reader, risk simulation.
   Runs in the browser and in Node. The solver (HiGHS, WebAssembly) is called from outside. */
(function (root, factory) { if (typeof module === "object" && module.exports) module.exports = factory(); else root.Planner = factory(); })(typeof self !== "undefined" ? self : this, function () {
  const DAYS = ["Mon", "Tue", "Thu", "Fri", "Sat"];
  const hm = s => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  const clock = m => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");

  function defaults() {
    const staff = [];
    for (let i = 1; i <= 18; i++) { const ft = i <= 7;
      staff.push({ name: "Staff " + String(i).padStart(2, "0"), type: ft ? "FT" : "PT", minHours: ft ? 20 : 4, maxHours: ft ? 27.5 : 12, maxDays: ft ? 5 : 3,
        qualified: true, recentSat: 0, avail: { Mon: true, Tue: true, Thu: true, Fri: true, Sat: true } }); }
    return { slotMin: 30, pickStart: "16:30", pickEnd: "22:00", inStart: "16:30", inEnd: "22:00",
      orders: { Mon: 550, Tue: 0, Thu: 0, Fri: 550, Sat: 550 }, inbound: { Mon: 0, Tue: 6, Thu: 6, Fri: 0, Sat: 6 },
      itemsPerOrder: 20, secMin: 12, secMax: 14, overheadSec: 0, utilization: 85, service: 95, release: "start", orderSd: 8,
      minStaff: 2, minQualified: 1, ptShift: 4, ftMin: 4, ftMax: 5.5, timeLimit: 20, staff };
  }

  const meanHours = (c, d) => (+c.orders[d] || 0) * (c.itemsPerOrder * (c.secMin + c.secMax) / 2 + c.overheadSec) / 3600 / (c.utilization / 100);

  function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function normal(r) { return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()); }
  /* One simulated picking day: random order count, order sizes (1 to 170 items, mean as entered) and picking speed. Returns labour hours. */
  function simDay(c, orders, r) {
    const sg = 1, mu = Math.log(c.itemsPerOrder) - sg * sg / 2, n = Math.max(0, Math.round(orders * (1 + c.orderSd / 100 * normal(r)))), sec = c.secMin + (c.secMax - c.secMin) * r();
    let items = 0; for (let k = 0; k < n; k++) items += Math.min(170, Math.max(1, Math.round(Math.exp(mu + sg * normal(r)))));
    return (items * sec + n * c.overheadSec) / 3600 / (c.utilization / 100);
  }
  const cache = {};
  /* Hours to plan for: the workload that is not exceeded on `service` percent of days. */
  function pickHours(c, d) {
    const o = +c.orders[d] || 0; if (o <= 0) return 0;
    const key = [o, c.itemsPerOrder, c.secMin, c.secMax, c.overheadSec, c.utilization, c.service, c.orderSd].join("|");
    if (!cache[key]) { const r = rng(11), a = []; for (let i = 0; i < 1500; i++) a.push(simDay(c, o, r)); a.sort((x, y) => x - y); cache[key] = a[Math.min(a.length - 1, Math.floor(a.length * c.service / 100))]; }
    return cache[key];
  }

  function dayModel(c, d) {
    const sm = c.slotMin, ph = pickHours(c, d), ih = +c.inbound[d] || 0;
    if (ph <= 0 && ih <= 0) return null;
    const pw = [hm(c.pickStart), hm(c.pickEnd)], iw = [hm(c.inStart), hm(c.inEnd)], wins = [];
    if (ph > 0) wins.push(pw); if (ih > 0) wins.push(iw);
    const start = Math.min(...wins.map(w => w[0])), end = Math.max(...wins.map(w => w[1])), n = Math.floor((end - start) / sm);
    const spread = (hours, w) => { const a = Math.round((w[0] - start) / sm), b = Math.round((w[1] - start) / sm), k = b - a, arr = new Array(n).fill(0);
      if (hours <= 0 || k <= 0) return arr; const first = c.release === "start" ? 1 : c.release === "half" ? 0.5 : 0;
      arr[a] += hours * first; for (let t = a; t < b; t++) arr[t] += hours * (1 - first) / k; return arr; };
    const pickRel = ph > 0 ? spread(ph, pw) : new Array(n).fill(0), inbRel = ih > 0 ? spread(ih, iw) : new Array(n).fill(0);
    return { d, start, n, slotH: sm / 60, pickH: ph, inbH: ih, pickRel, inbRel, rel: pickRel.map((v, i) => v + inbRel[i]),
      inbSlots: ih > 0 ? [Math.round((iw[0] - start) / sm), Math.round((iw[1] - start) / sm)] : null };
  }
  const suffix = a => { const o = new Array(a.length).fill(0); let s = 0; for (let i = a.length - 1; i >= 0; i--) { s += a[i]; o[i] = s; } return o; };

  function patterns(c, st, n) {
    const per = 60 / c.slotMin, lens = [];
    if (st.type === "PT") lens.push(Math.round(c.ptShift * per)); else for (let h = c.ftMin; h <= c.ftMax + 1e-9; h += 0.5) lens.push(Math.round(h * per));
    const out = []; lens.forEach(L => { for (let a = 0; a + L <= n; a++) out.push([a, L]); }); return out;
  }

  function build(c) {
    const models = DAYS.map(d => dayModel(c, d)), V = [], obj = [], rows = [], bnds = [], gen = [];
    const x = (s, di, p) => `x${s}_${di}_${p}`;
    const terms = t => { let out = "", k = 0; t.forEach(([co, nm]) => { if (!co) return; out += (co < 0 ? " - " : " + ") + Math.abs(co) + " " + nm; if (++k % 6 === 0) out += "\n   "; }); return out || " + 0 zero"; };
    const row = (name, t, op, rhs) => rows.push(` ${name}: ${terms(t)} ${op} ${rhs}`);
    const meta = [];
    c.staff.forEach((st, s) => {
      const perDay = [], all = [];
      DAYS.forEach((d, di) => { const m = models[di]; const ok = m && st.avail[d];
        const ps = ok ? patterns(c, st, m.n) : []; perDay.push(ps);
        ps.forEach(([a, L], p) => { const nm = x(s, di, p); V.push(nm); all.push({ nm, di, a, L, d });
          obj.push([L * c.slotMin / 60 + 0.0005 * ((s * 7 + di * 3 + p) % 13) + (d === "Sat" ? 0.8 * (st.recentSat || 0) : 0), nm]); });
        if (ps.length) row(`one_${s}_${di}`, ps.map((_, p) => [1, x(s, di, p)]), "<=", 1); });
      meta.push({ perDay, all });
      const hrs = all.map(v => [v.L * c.slotMin / 60, v.nm]);
      if (all.length) { row(`maxd_${s}`, all.map(v => [1, v.nm]), "<=", st.maxDays); row(`maxh_${s}`, hrs, "<=", st.maxHours);
        row(`minh_${s}`, [...hrs, [1, `dm_${s}`]], ">=", st.minHours); bnds.push(` 0 <= dm_${s}`); obj.push([5, `dm_${s}`]); }
    });
    const qualified = c.staff.some(st => st.qualified);
    models.forEach((m, di) => { if (!m) return; const D = suffix(m.rel);
      const cover = (t, onlyQ) => { const tl = []; c.staff.forEach((st, s) => { if (onlyQ && !st.qualified) return; meta[s].all.forEach(v => { if (v.di === di && v.a <= t && t < v.a + v.L) tl.push([1, v.nm]); }); }); return tl; };
      for (let t = 0; t < m.n; t++) {
        if (D[t] > 1e-9) { const tl = []; c.staff.forEach((st, s) => meta[s].all.forEach(v => { if (v.di === di) { const ov = Math.max(0, v.a + v.L - Math.max(v.a, t)); if (ov > 0) tl.push([ov * m.slotH, v.nm]); } }));
          row(`cap_${di}_${t}`, [...tl, [1, `sh_${di}_${t}`]], ">=", +D[t].toFixed(6)); bnds.push(` 0 <= sh_${di}_${t}`); obj.push([1000, `sh_${di}_${t}`]); }
        if (c.minStaff > 0) { row(`flr_${di}_${t}`, [...cover(t, false), [1, `fl_${di}_${t}`]], ">=", c.minStaff); bnds.push(` 0 <= fl_${di}_${t}`); obj.push([500, `fl_${di}_${t}`]); }
        if (m.inbSlots && qualified && c.minQualified > 0 && t >= m.inbSlots[0] && t < m.inbSlots[1]) {
          row(`qal_${di}_${t}`, [...cover(t, true), [1, `qs_${di}_${t}`]], ">=", c.minQualified); bnds.push(` 0 <= qs_${di}_${t}`); obj.push([500, `qs_${di}_${t}`]); } }
    });
    const lp = "Minimize\n obj:" + terms(obj) + "\nSubject To\n" + rows.join("\n") + "\nBounds\n" + bnds.join("\n") + "\nBinary\n " + V.join("\n ") + "\nEnd\n";
    return { lp, models, meta, nVars: V.length };
  }

  function read(c, b, primal) {
    const roster = c.staff.map(() => DAYS.map(() => null));
    c.staff.forEach((st, s) => b.meta[s].all.forEach(v => { if ((primal[v.nm] || 0) > 0.5) roster[s][v.di] = { a: v.a, L: v.L }; }));
    const days = b.models.map((m, di) => { if (!m) return null; const head = new Array(m.n).fill(0), headQ = new Array(m.n).fill(0);
      roster.forEach((r, s) => { const sh = r[di]; if (sh) for (let t = sh.a; t < sh.a + sh.L; t++) { head[t]++; if (c.staff[s].qualified) headQ[t]++; } });
      const cap = head.map(h => h * m.slotH), capS = suffix(cap), D = suffix(m.rel), pS = suffix(m.pickRel), iS = suffix(m.inbRel);
      let short = 0, fmax = Infinity; for (let t = 0; t < m.n; t++) { short = Math.max(short, D[t] - capS[t]); if (pS[t] > 1e-9) fmax = Math.min(fmax, (capS[t] - iS[t]) / pS[t]); }
      return { d: m.d, start: m.start, n: m.n, head, headQ, capacity: capS[0], pickH: m.pickH, inbH: m.inbH, short, fmax, minHead: Math.min(...head) }; });
    const stats = c.staff.map((st, s) => ({ name: st.name, type: st.type, hours: roster[s].reduce((a, r) => a + (r ? r.L * c.slotMin / 60 : 0), 0), days: roster[s].filter(Boolean).length }));
    return { roster, days, stats, paid: stats.reduce((a, s) => a + s.hours, 0), short: days.reduce((a, d) => a + (d ? d.short : 0), 0) };
  }

  /* Independent check of a finished plan: how often would the picking finish on time? */
  function simulate(c, res, runs = 2000, seed = 7) {
    const r = rng(seed), out = {};
    res.days.forEach(day => { if (!day || day.pickH <= 0) return; let good = 0; const need = [];
      for (let i = 0; i < runs; i++) { const h = simDay(c, +c.orders[day.d], r); need.push(h); if (h / day.pickH <= day.fmax + 1e-9) good++; }
      need.sort((x, y) => x - y); out[day.d] = { p: good / runs, median: need[Math.floor(runs * .5)], p95: need[Math.floor(runs * .95)] }; });
    return out;
  }

  return { DAYS, defaults, build, read, simulate, dayModel, pickHours, meanHours, clock, hm };
});
