// Runs the HiGHS solver off the main thread so the page stays responsive while it works.
importScripts("highs/highs.js");
let loading;
self.onmessage = async e => {
  try {
    loading = loading || Module({ locateFile: f => "highs/" + f });
    const highs = await loading, sol = highs.solve(e.data.lp, e.data.options), primal = {};
    for (const k in sol.Columns) primal[k] = sol.Columns[k].Primal;
    self.postMessage({ ok: true, status: sol.Status, primal });
  } catch (err) { self.postMessage({ ok: false, error: String((err && err.message) || err) }); }
};
