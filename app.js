/* Transit Identifier — UI, data fetching, GPS. Matching logic lives in logic.js (window.TI). */
(() => {
  const BART_KEY = "MW9S-E7SL-26DU-VV8V"; // BART's published public key
  const BART = "https://api.bart.gov/api/";
  const API511 = "https://api.511.org/transit/";
  const DAY = 864e5;

  const $ = (s) => document.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  const S = {
    mode: store.get("ti.mode", "auto"),
    key511: store.get("ti.key511", ""),
    fixes: [],
    bart: null,          // {stations, routes}
    etd: null, etdAt: 0, etdErr: null,
    vehicles: null, vehAt: 0, ctErr: null,
    visits: null, visitsAt: 0,
    lock: null,          // {sys:'bart', routeId} | {sys:'ct', train}
    lastResult: null,
    geoErr: null,
    started: false,
  };

  // ---------- 511 request budget (60/hour per key) ----------
  function budgetOk() {
    const now = Date.now();
    const log = store.get("ti.511log", []).filter((t) => now - t < 36e5);
    store.set("ti.511log", log);
    return log.length < 55;
  }
  function spend() { const log = store.get("ti.511log", []); log.push(Date.now()); store.set("ti.511log", log); }

  // ---------- Fetching ----------
  async function bartGet(path, params) {
    const u = new URL(BART + path);
    for (const [k, v] of Object.entries({ ...params, key: BART_KEY, json: "y" })) u.searchParams.set(k, v);
    const r = await fetch(u);
    if (!r.ok) throw new Error("BART returned " + r.status);
    return (await r.json()).root;
  }

  async function loadBartStatic() {
    const cached = store.get("ti.bartStatic", null);
    if (cached && Date.now() - cached.at < DAY) return cached.data;
    const [stn, rt] = await Promise.all([
      bartGet("stn.aspx", { cmd: "stns" }),
      bartGet("route.aspx", { cmd: "routeinfo", route: "all" }),
    ]);
    const stations = {};
    for (const s of [].concat(stn.stations.station)) {
      stations[s.abbr] = { name: s.name, lat: +s.gtfs_latitude, lon: +s.gtfs_longitude };
    }
    const routes = [].concat(rt.routes.route).map((r) => ({
      routeID: r.routeID, name: r.name, abbr: r.abbr, color: (r.color || "").toLowerCase(),
      hexcolor: r.hexcolor, origin: r.origin, destination: r.destination,
      direction: r.direction, stations: [].concat(r.config.station),
    }));
    const data = { stations, routes };
    store.set("ti.bartStatic", { at: Date.now(), data });
    return data;
  }

  async function refreshEtd(force) {
    if (!force && Date.now() - S.etdAt < 30e3) return;
    try {
      const root = await bartGet("etd.aspx", { cmd: "etd", orig: "ALL" });
      const etd = {};
      for (const st of [].concat(root.station || [])) etd[st.abbr] = st;
      S.etd = etd; S.etdAt = Date.now(); S.etdErr = null;
    } catch (e) { S.etdErr = e.message || String(e); }
  }

  async function get511(endpoint) {
    if (!S.key511) throw new Error("no key");
    if (!budgetOk()) throw new Error("511 hourly limit reached, waiting");
    const u = `${API511}${endpoint}?api_key=${encodeURIComponent(S.key511)}&agency=CT&format=json`;
    spend();
    const r = await fetch(u);
    if (r.status === 401 || r.status === 403) throw new Error("511 rejected the key");
    if (r.status === 429) throw new Error("511 hourly limit reached, waiting");
    if (!r.ok) throw new Error("511 returned " + r.status);
    return TI.parse511(await r.text());
  }

  async function refreshVehicles(force) {
    const locked = S.lock?.sys === "ct";
    const every = locked ? 6e5 : 120e3; // once locked, positions matter less
    if (!force && Date.now() - S.vehAt < every) return;
    try {
      S.vehicles = TI.vehiclesFrom511(await get511("VehicleMonitoring"));
      S.vehAt = Date.now(); S.ctErr = null;
    } catch (e) { S.ctErr = e.message === "Failed to fetch" ? "Couldn't reach 511.org" : e.message; }
  }

  async function refreshVisits(force) {
    if (!force && Date.now() - S.visitsAt < 120e3) return;
    try {
      S.visits = TI.stopVisitsFrom511(await get511("StopMonitoring"));
      S.visitsAt = Date.now();
    } catch (e) { S.ctErr = e.message; }
  }

  // ---------- Location ----------
  function sim() {
    const q = new URLSearchParams(location.search).get("sim");
    if (!q) return null;
    const [lat, lon, heading, speed] = q.split(",").map(Number);
    return { lat, lon, heading: isFinite(heading) ? heading : null, speed: isFinite(speed) ? speed : (isFinite(heading) ? 15 : 0), acc: 10, at: Date.now() };
  }

  function onFix(pos) {
    const c = pos.coords;
    const f = { lat: c.latitude, lon: c.longitude, heading: isFinite(c.heading) ? c.heading : null, speed: c.speed, acc: c.accuracy, at: pos.timestamp || Date.now() };
    S.geoErr = null;
    S.fixes.push(f);
    S.fixes = S.fixes.filter((x) => f.at - x.at < 5 * 60e3);
    tick();
  }

  function prevFix(cur) {
    // Use the most recent fix at least 15 s older and 60 m away, for direction.
    for (let i = S.fixes.length - 2; i >= 0; i--) {
      const p = S.fixes[i];
      if (cur.at - p.at >= 15e3 && TI.dist(cur, p) > 60) return p;
    }
    return null;
  }

  async function start() {
    S.started = true;
    store.set("ti.started", true);
    render();
    try { S.bart = await loadBartStatic(); } catch (e) { S.etdErr = "Couldn't load BART stations: " + (e.message || e); }
    const s = sim();
    if (s) { S.fixes = [s]; }
    else if (!("geolocation" in navigator)) S.geoErr = "This browser has no location support.";
    else navigator.geolocation.watchPosition(onFix, (e) => {
      S.geoErr = e.code === 1 ? "Location is off for this site. Allow it in your browser settings, then reload." : "Waiting for a GPS fix…";
      render();
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
    try { await navigator.wakeLock?.request("screen"); } catch {}
    tick(true);
    setInterval(() => tick(), 15e3);
  }

  let ticking = false;
  async function tick(force) {
    if (ticking) return;
    ticking = true;
    try {
      const cur = S.fixes[S.fixes.length - 1];
      const wantBart = S.mode !== "ct";
      const wantCt = S.mode !== "bart" && S.key511;
      const jobs = [];
      if (wantBart && S.bart) jobs.push(refreshEtd(force));
      if (wantCt && cur) jobs.push(refreshVehicles(force));
      await Promise.all(jobs);
      if (cur) S.lastResult = decide(cur, prevFix(cur));
      if (S.lastResult?.sys === "ct" && S.lastResult.vehicle && S.lastResult.vehicle.calls.length < 2) {
        await refreshVisits(force);
        S.lastResult = decide(cur, prevFix(cur));
      }
    } finally { ticking = false; render(); }
  }

  // ---------- Decide which train ----------
  function decide(cur, prev) {
    let bart = null, ct = null;
    if (S.mode !== "ct" && S.bart && S.etd) {
      const opts = S.lock?.sys === "bart" ? { routeId: S.lock.routeId, maxD: 3000, ranks: 3 } : {};
      bart = TI.bartCandidates(cur, prev, { ...S.bart, etd: S.etd }, opts);
    }
    if (S.mode !== "bart" && S.vehicles) {
      const opts = S.lock?.sys === "ct" ? { train: S.lock.train, maxD: 5000 } : {};
      ct = TI.caltrainCandidates(cur, prev, S.vehicles, opts);
    }
    const bd = bart?.candidates.length ? bart.candidates[0].offTrack : Infinity;
    const cd = ct?.candidates.length ? ct.candidates[0].d : Infinity;

    let sys = null;
    if (S.lock) sys = S.lock.sys;
    else if (S.mode === "bart") sys = "bart";
    else if (S.mode === "ct") sys = "ct";
    else if (bd === Infinity && cd === Infinity) sys = null;
    // Caltrain vehicle positions lag, so give them extra slack versus the static BART track.
    else sys = cd < 500 || cd < bd * 1.5 ? "ct" : "bart";

    if (sys === "bart" && bart?.candidates.length) {
      const etaOf = (c) => S.etdAt + c.minutesToNext * 60e3;
      let top = bart.candidates[0];
      if (S.lock?.sys === "bart" && S.lock.eta) {
        // Follow the locked train: the estimate on its line closest to where we last saw it.
        top = bart.candidates.reduce((a, b) => (Math.abs(etaOf(b) - S.lock.eta) < Math.abs(etaOf(a) - S.lock.eta) ? b : a));
        S.lock.eta = etaOf(top);
      }
      const name = (c) => `${titleCase(c.route.color)} to ${S.bart.stations[c.route.destination]?.name || c.route.destination}`;
      const nextName = (c) => S.bart.stations[c.route.stations[c.nextIdx]]?.name || "next stop";
      const why = (c) => {
        if (c.dirScore < top.dirScore) return "Opposite direction";
        if (c.route.routeID === top.route.routeID) return c.minutesToNext > top.minutesToNext ? "Train behind this one" : "Train ahead of this one";
        if (c.rank > 0) return "Second train on this line";
        return "Another line on this track";
      };
      const stops = TI.bartStops(top, { ...S.bart, etd: S.etd }).map((s) => ({ name: s.name, time: S.etdAt + s.minutes * 60e3, estimated: s.estimated }));
      return {
        sys: "bart", fix: cur, direction: bart.direction, stops,
        title: `${titleCase(top.route.color)} line to ${S.bart.stations[top.route.destination]?.name || top.route.destination}`,
        sub: [top.cars ? `${top.cars}-car train` : null, top.atStation ? "Stopped at station" : null].filter(Boolean).join(" · "),
        color: top.route.hexcolor, plausible: top.plausible,
        lockKey: { sys: "bart", routeId: top.route.routeID, eta: etaOf(top) },
        alts: bart.candidates.filter((c) => c !== top).slice(0, 3).map((c) => ({
          label: name(c), why: why(c),
          detail: `${nextName(c)} in ${c.minutesToNext} min`, color: c.route.hexcolor,
          lock: { sys: "bart", routeId: c.route.routeID, eta: etaOf(c) },
        })),
      };
    }
    if (sys === "ct" && ct?.candidates.length) {
      const v = ct.candidates[0];
      let calls = v.calls;
      if (calls.length < 2 && S.visits?.[v.train]) calls = S.visits[v.train];
      const stops = calls.filter((c) => c.time > Date.now() - 60e3).map((c) => ({ name: c.name, time: c.time, estimated: false }));
      const dirWord = v.dir === "N" ? "Northbound" : v.dir === "S" ? "Southbound" : "";
      return {
        sys: "ct", fix: cur, direction: ct.direction, stops, vehicle: v,
        title: `Caltrain ${v.train}`,
        sub: [dirWord, v.line, v.dest ? `to ${TI.cleanStop(v.dest)}` : null].filter(Boolean).join(" · "),
        color: "#c8102e", plausible: v.d < 800,
        posAge: v.recordedAt ? Math.round((Date.now() - v.recordedAt) / 1000) : null,
        lockKey: { sys: "ct", train: v.train },
        alts: ct.candidates.slice(1, 4).map((c) => ({
          label: `Caltrain ${c.train}`, why: c.dirOk ? "Nearby train" : "Opposite direction",
          detail: `${c.dir === "N" ? "Northbound" : "Southbound"} · ${c.d < 1000 ? Math.round(c.d) + " m" : (c.d / 1000).toFixed(1) + " km"} away`,
          color: "#c8102e", lock: { sys: "ct", train: c.train },
        })),
      };
    }
    // Nothing matched: report nearest BART station for context.
    let nearest = null;
    if (S.bart) for (const [abbr, st] of Object.entries(S.bart.stations)) {
      const d = TI.dist(cur, st);
      if (!nearest || d < nearest.d) nearest = { name: st.name, d };
    }
    return { sys: null, fix: cur, nearest };
  }

  // ---------- Render ----------
  const titleCase = (s) => (s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const inMin = (t) => { const m = Math.round((t - Date.now()) / 60e3); return m <= 0 ? "now" : `${m} min`; };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ago = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`; };

  function render() {
    const main = $("#main");
    $("#start").hidden = S.started;
    main.hidden = !S.started;
    $("#mode").value = S.mode;
    $("#key511").value = S.key511;

    // Status chips
    const cur = S.fixes[S.fixes.length - 1];
    const chips = [];
    chips.push(cur ? `<span class="chip ok">GPS ±${Math.round(cur.acc || 0)} m · ${ago(cur.at)}</span>` : `<span class="chip wait">${esc(S.geoErr || "Finding you…")}</span>`);
    if (S.mode !== "ct") chips.push(S.etdErr ? `<span class="chip bad">BART: ${esc(S.etdErr)}</span>` : S.etdAt ? `<span class="chip ok">BART live · ${ago(S.etdAt)}</span>` : `<span class="chip wait">BART loading…</span>`);
    if (S.mode !== "bart") chips.push(!S.key511 ? `<span class="chip wait">Caltrain off · add a 511 key</span>` : S.ctErr ? `<span class="chip bad">Caltrain: ${esc(S.ctErr)}</span>` : S.vehAt ? `<span class="chip ok">Caltrain live · ${ago(S.vehAt)}</span>` : `<span class="chip wait">Caltrain loading…</span>`);
    $("#status").innerHTML = chips.join("");

    const r = S.lastResult;
    const card = $("#result");
    if (!r) { card.innerHTML = `<p class="muted">Waiting for your location and live data…</p>`; return; }
    if (!r.sys) {
      card.innerHTML = `<div class="empty"><h2>Not on a train line</h2><p class="muted">You don't appear to be on BART${S.key511 ? " or Caltrain" : ""} right now.${r.nearest ? ` Nearest BART station: <strong>${esc(r.nearest.name)}</strong>, ${(r.nearest.d / 1000).toFixed(1)} km away.` : ""}</p>${!S.key511 && S.mode !== "bart" ? `<p class="muted">Caltrain detection is off until you add a 511 key in Settings.</p>` : ""}</div>`;
      return;
    }
    const sysName = r.sys === "bart" ? "BART" : "Caltrain";
    const warn = [];
    if (r.direction === "unknown") warn.push("Direction not certain yet. It firms up once the train has moved a bit.");
    if (!r.plausible) warn.push("Low confidence: no train is clearly next on your stretch of track.");
    if (r.posAge > 180) warn.push(`Train position is ${Math.round(r.posAge / 60)} min old.`);

    const rows = r.stops.map((s, i) => `
      <li class="stop${i === 0 ? " next" : ""}">
        <span class="dot" aria-hidden="true"></span>
        <span class="name">${esc(s.name)}${i === 0 ? `<small>Next stop</small>` : ""}</span>
        <span class="when"><b>${s.estimated ? "~" : ""}${clock(s.time)}</b><small>${s.estimated ? "est. " : ""}${inMin(s.time)}</small></span>
      </li>`).join("");

    card.innerHTML = `
      <div class="train" style="--line:${esc(r.color)}">
        <p class="eyebrow">You're on ${sysName}</p>
        <h2>${esc(r.title)}</h2>
        ${r.sub ? `<p class="sub">${esc(r.sub)}</p>` : ""}
        <div class="actions">
          ${S.lock ? `<button id="unlock" class="btn">Not my train</button><span class="muted small">Locked to this train</span>` : `<button id="lock" class="btn primary">Yes, this is my train</button>`}
        </div>
      </div>
      ${warn.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
      ${r.stops.length ? `<ol class="stops" style="--line:${esc(r.color)}">${rows}</ol>` : `<p class="muted">No upcoming stop times available for this train yet.</p>`}
      ${r.alts?.length ? `<div class="alts"><p class="eyebrow">Other possibilities</p>${r.alts.map((a, i) => `<button class="alt" data-i="${i}" style="--line:${esc(a.color)}"><span class="swatch"></span><span><span class="why">${esc(a.why)}</span>${esc(a.label)}<small>${esc(a.detail)}</small></span><span class="pick">Switch</span></button>`).join("")}</div>` : ""}
    `;
    $("#lock")?.addEventListener("click", () => { S.lock = r.lockKey; tick(); });
    $("#unlock")?.addEventListener("click", () => { S.lock = null; tick(); });
    card.querySelectorAll(".alt").forEach((b) => b.addEventListener("click", () => { S.lock = r.alts[+b.dataset.i].lock; tick(); }));
  }

  // ---------- Wire up ----------
  $("#go").addEventListener("click", start);
  $("#refresh").addEventListener("click", () => tick(true));
  $("#mode").addEventListener("change", (e) => { S.mode = e.target.value; S.lock = null; store.set("ti.mode", S.mode); tick(true); });
  $("#keyform").addEventListener("submit", (e) => {
    e.preventDefault();
    S.key511 = $("#key511").value.trim(); store.set("ti.key511", S.key511);
    S.vehAt = 0; S.ctErr = null; $("#keysaved").hidden = false;
    setTimeout(() => ($("#keysaved").hidden = true), 2000);
    tick(true);
  });
  render();
  if (store.get("ti.started", false) || sim()) start();
})();
