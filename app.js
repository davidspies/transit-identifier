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
    debug: store.get("ti.debug", false),
    key511: store.get("ti.key511", ""),
    fixes: [],
    bart: null,          // {stations, routes}
    etd: null, etdAt: 0, etdErr: null,
    vehicles: null, vehAt: 0, ctErr: null,
    visits: null, visitsAt: 0,
    ctHistory: {},       // {train: {stop: last predicted time}}
    lock: null,          // {sys:'bart', routeId, eta} | {sys:'ct', train}
    plan: [],            // planned transfers: [{at: stationKey, sys, routeId|train, eta}]
    picker: null,        // {seg, key, tArr, all} while choosing a transfer
    allAlts: false,      // show every candidate train, not just the top 3
    manualOpen: null,    // {step:'list'} | {step:'bart', routeId} while picking a train by hand
    manualDismissed: false,
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
    const r = await fetch(u, { signal: AbortSignal.timeout?.(15e3) });
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

  async function get511(endpoint, param = "agency") {
    if (!S.key511) throw new Error("no key");
    if (!budgetOk()) throw new Error("511 hourly limit reached, waiting");
    const u = `${API511}${endpoint}?api_key=${encodeURIComponent(S.key511)}&${param}=CT&format=json`;
    spend();
    const r = await fetch(u, { signal: AbortSignal.timeout?.(15e3) });
    if (r.status === 401 || r.status === 403) throw new Error("511 rejected the key");
    if (r.status === 429) throw new Error("511 hourly limit reached, waiting");
    if (!r.ok) throw new Error("511 returned " + r.status);
    return TI.parse511(await r.text());
  }

  async function refreshVehicles(force) {
    const locked = S.lock?.sys === "ct";
    const every = locked ? 6e5 : 240e3; // stop predictions do most of the work; positions are a cross-check
    if (!force && Date.now() - S.vehAt < every) return;
    try {
      S.vehicles = TI.vehiclesFrom511(await get511("VehicleMonitoring"));
      S.vehAt = Date.now(); S.ctErr = null;
    } catch (e) { S.ctErr = e.message === "Failed to fetch" ? "Couldn't reach 511.org" : e.name === "TimeoutError" ? "511.org timed out" : e.message; }
  }

  async function refreshVisits(force) {
    if (!force && Date.now() - S.visitsAt < 120e3) return;
    try {
      S.visits = TI.stopVisitsFrom511(await get511("StopMonitoring"));
      S.visitsAt = Date.now();
      // Remember each train's latest predicted time at every stop, so once it has left a
      // station we still know roughly when (used to interpolate where it is now).
      const H = S.ctHistory;
      for (const [train, list] of Object.entries(S.visits)) {
        const h = (H[train] ||= {});
        for (const c of list) h[c.name] = c.time;
      }
      for (const t of Object.keys(H)) if (Math.max(...Object.values(H[t])) < Date.now() - 3 * 36e5) delete H[t];
    } catch (e) { S.ctErr = e.message === "Failed to fetch" ? "Couldn't reach 511.org" : e.name === "TimeoutError" ? "511.org timed out" : e.message; }
  }

  // Caltrain station locations; they rarely change, so keep them for a week.
  async function loadCtStops() {
    if (S.ctStops) return;
    const cached = store.get("ti.ctStops", null);
    if (cached && Date.now() - cached.at < 7 * DAY && Object.keys(cached.data).length) { S.ctStops = cached.data; return; }
    try {
      const data = TI.stopCoordsFrom511(await get511("stops", "operator_id"));
      if (Object.keys(data).length) { S.ctStops = data; store.set("ti.ctStops", { at: Date.now(), data }); }
    } catch (e) { /* matching falls back to train positions */ }
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
      const wantCt = (S.mode !== "bart" || S.manualOpen || S.lock?.manual) && S.key511;
      // Show each system as soon as its data lands, rather than waiting for the slower one.
      const update = () => { S.lastResult = decide(cur, cur ? prevFix(cur) : null); render(); };
      const jobs = [];
      if (wantBart && S.bart) jobs.push(refreshEtd(force).then(update));
      if (wantCt && (cur || S.manualOpen || S.lock?.manual)) {
        jobs.push(refreshVehicles(force).then(update));
        jobs.push(loadCtStops().then(() => refreshVisits(force)).then(update));
      }
      await Promise.all(jobs);
      update();
      const needVisits = S.plan.some((l) => l.sys === "ct") || !!S.manualOpen ||
        (S.lastResult?.sys === "ct" && S.lastResult.vehicle && S.lastResult.vehicle.calls.length < 2);
      if (needVisits && S.key511) {
        await refreshVisits(force);
        S.lastResult = decide(cur, cur ? prevFix(cur) : null);
      }
    } finally { ticking = false; render(); }
  }

  // ---------- Decide which train ----------
  function decide(cur, prev) {
    if (S.lock?.manual) return S.lock.sys === "bart" ? manualBart(cur) : manualCaltrain(cur);
    if (!cur) return null;
    let bart = null, ct = null;
    if (S.mode !== "ct" && S.bart && S.etd) {
      const opts = S.lock?.sys === "bart" ? { routeId: S.lock.routeId, maxD: 3000, ranks: 3 }
        : S.allAlts ? { maxD: 2500, ranks: 4, spread: 1500 } : {};
      bart = TI.bartCandidates(cur, prev, { ...S.bart, etd: S.etd }, opts);
    }
    if (S.mode !== "bart" && (S.vehicles || S.visits)) {
      const opts = S.lock?.sys === "ct" ? { train: S.lock.train, maxD: 5000 } : S.allAlts ? { maxD: 6000 } : {};
      ct = TI.caltrainCandidates(cur, prev, S.vehicles, { ...opts, visits: S.visits || {}, stops: S.ctStops || {}, history: S.ctHistory });
    }
    // A BART match with no train plausibly due counts for less.
    const bd = bart?.candidates.length ? bart.candidates[0].offTrack * (bart.candidates[0].plausible ? 1 : 3) : Infinity;
    const cd = ct?.candidates.length ? ct.candidates[0].d : Infinity;

    // A system still loading might be the better match, so only commit early when we're clearly on the other one.
    const bartPending = S.mode !== "ct" && !S.etd && !S.etdErr;
    const ctPending = S.mode !== "bart" && !!S.key511 && !(S.vehicles && S.visits) && !S.ctErr;
    if (!S.lock && S.mode === "auto") {
      if (ctPending && !(bd <= 300)) return { sys: null, fix: cur, waiting: "Caltrain" };
      if (bartPending && !(cd <= 500)) return { sys: null, fix: cur, waiting: "BART" };
    }

    S.dbg = { bart, ct, bd, cd };

    let sys = null;
    if (S.lock) sys = S.lock.sys;
    else if (S.mode === "bart") sys = "bart";
    else if (S.mode === "ct") sys = "ct";
    else if (bd === Infinity && cd === Infinity) sys = null;
    // Caltrain vehicle positions lag, so give them extra slack versus the static BART track.
    else sys = cd < 500 || bd === Infinity || cd < bd * 1.5 ? "ct" : "bart";

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
      const stops = TI.bartStops(top, { ...S.bart, etd: S.etd }).map((s) => ({ key: s.abbr, name: s.name, time: S.etdAt + s.minutes * 60e3, estimated: s.estimated }));
      return {
        sys: "bart", ident: { sys: "bart", routeId: top.route.routeID }, fix: cur, direction: bart.direction, stops,
        title: `${titleCase(top.route.color)} line to ${S.bart.stations[top.route.destination]?.name || top.route.destination}`,
        sub: [top.cars ? `${top.cars}-car train` : null, top.atStation ? "Stopped at station" : null].filter(Boolean).join(" · "),
        color: top.route.hexcolor, plausible: top.plausible,
        lockKey: { sys: "bart", routeId: top.route.routeID, eta: etaOf(top) },
        moreAlts: bart.candidates.length - 1 > 3,
        alts: bart.candidates.filter((c) => c !== top).slice(0, S.allAlts ? 99 : 3).map((c) => ({
          label: name(c), why: why(c),
          detail: `${nextName(c)} in ${c.minutesToNext} min`, color: c.route.hexcolor,
          lock: { sys: "bart", routeId: c.route.routeID, eta: etaOf(c) },
        })),
      };
    }
    if (sys === "ct" && ct?.candidates.length) {
      const v = ct.candidates[0];
      let calls = v.calls || [];
      if (calls.length < 2 && S.visits?.[v.train]) calls = S.visits[v.train];
      const stops = calls.filter((c) => c.time > Date.now() - 60e3).map((c) => ({ key: "ct:" + c.name, name: c.name, time: c.time, estimated: false }));
      const dirWord = v.dir === "N" ? "Northbound" : v.dir === "S" ? "Southbound" : "";
      return {
        sys: "ct", ident: { sys: "ct", train: v.train }, fix: cur, direction: ct.direction, stops, vehicle: v,
        title: `Caltrain ${v.train}`,
        sub: [dirWord, v.line, v.dest ? `to ${TI.cleanStop(v.dest)}` : null].filter(Boolean).join(" · "),
        color: "#c8102e", plausible: v.d < 1000,
        posAge: v.recordedAt && v.posScore <= v.etaScore ? Math.round((Date.now() - v.recordedAt) / 1000) : null,
        lockKey: { sys: "ct", train: v.train },
        moreAlts: true,
        alts: ct.candidates.slice(1, S.allAlts ? 99 : 4).map((c) => ({
          label: `Caltrain ${c.train}`, why: c.dirOk ? "Nearby train" : "Opposite direction",
          detail: [c.dir === "N" ? "Northbound" : c.dir === "S" ? "Southbound" : "", c.next ? `next: ${c.next.name} ${clock(c.next.time)}` : ""].filter(Boolean).join(" · "),
          color: "#c8102e", lock: { sys: "ct", train: c.train },
        })),
      };
    }
    // Nothing matched: report what's nearest, for context.
    let nearest = null, nearestCt = null;
    if (S.bart) for (const st of Object.values(S.bart.stations)) {
      const d = TI.dist(cur, st);
      if (!nearest || d < nearest.d) nearest = { name: st.name, d };
    }
    for (const v of S.vehicles || []) {
      const d = TI.dist(cur, v);
      if (!nearestCt || d < nearestCt.d) nearestCt = { train: v.train, d, age: v.recordedAt ? Math.round((Date.now() - v.recordedAt) / 1000) : null };
    }
    return { sys: null, fix: cur, nearest, nearestCt, ctCount: S.vehicles?.length ?? null };
  }

  // ---------- Picked by hand (no location needed) ----------
  function manualBart(cur) {
    const r = S.bart?.routes.find((x) => x.routeID === S.lock.routeId);
    if (!r || !S.etd) return { sys: null, fix: cur, waiting: "BART" };
    const L = S.lock;
    let idx = r.stations.indexOf(L.nextAbbr);
    // Move along the line as the train leaves each station.
    while (idx < r.stations.length - 1 && Date.now() > L.eta + 45e3) {
      const a = S.bart.stations[r.stations[idx]], b = S.bart.stations[r.stations[idx + 1]];
      idx++; L.nextAbbr = r.stations[idx];
      const e = TI.etdFor(S.etd, L.nextAbbr, r).find((e) => S.etdAt + e.minutes * 60e3 >= L.eta - 60e3);
      L.eta = e ? S.etdAt + e.minutes * 60e3 : L.eta + (a && b ? TI.dist(a, b) / 15 + 30 : 120) * 1e3;
    }
    const ests = TI.etdFor(S.etd, L.nextAbbr, r);
    const best = ests.length ? ests.reduce((x, y) => (Math.abs(S.etdAt + y.minutes * 60e3 - L.eta) < Math.abs(S.etdAt + x.minutes * 60e3 - L.eta) ? y : x)) : null;
    const minutes = best ? best.minutes : Math.max(0, (L.eta - S.etdAt) / 60e3);
    L.eta = S.etdAt + minutes * 60e3;
    const cand = { route: r, nextIdx: idx, minutesToNext: minutes };
    const stops = TI.bartStops(cand, { ...S.bart, etd: S.etd }).map((s) => ({ key: s.abbr, name: s.name, time: S.etdAt + s.minutes * 60e3, estimated: s.estimated || !best }));
    return {
      sys: "bart", ident: { sys: "bart", routeId: r.routeID }, fix: cur, direction: "known", manual: true, stops,
      title: `${titleCase(r.color)} line to ${bartDestName(r.destination)}`,
      sub: [best?.cars ? `${best.cars}-car train` : null, "Picked by hand"].filter(Boolean).join(" · "),
      color: r.hexcolor, plausible: true, alts: [],
    };
  }

  function caltrainStops(train, v) {
    let calls = v?.calls?.length >= 2 ? v.calls : S.visits?.[train] || v?.calls || [];
    return calls.filter((c) => c.time > Date.now() - 60e3).map((c) => ({ key: "ct:" + c.name, name: c.name, time: c.time, estimated: false }));
  }

  function manualCaltrain(cur) {
    const train = S.lock.train;
    const v = (S.vehicles || []).find((x) => x.train === train);
    const dirWord = v?.dir === "N" ? "Northbound" : v?.dir === "S" ? "Southbound" : "";
    return {
      sys: "ct", ident: { sys: "ct", train }, fix: cur, direction: "known", manual: true, vehicle: v || { calls: [] },
      stops: caltrainStops(train, v),
      title: `Caltrain ${train}`,
      sub: [dirWord, v?.line, v?.dest ? `to ${TI.cleanStop(v.dest)}` : null, "Picked by hand"].filter(Boolean).join(" · "),
      color: "#c8102e", plausible: true, alts: [],
    };
  }

  function manualHtml() {
    const m = S.manualOpen;
    const head = `<div class="manual-head"><h2>Pick your train</h2><button class="btn" id="mclose" type="button">Cancel</button></div>`;
    if (m.step === "bart") {
      const r = S.bart?.routes.find((x) => x.routeID === m.routeId);
      if (!r) return head;
      return `${head}<p class="eyebrow">${esc(titleCase(r.color))} line to ${esc(bartDestName(r.destination))} · what's your next stop?</p>
        <div class="alts">${r.stations.slice(1).map((a) => `<button class="alt mstation" data-abbr="${esc(a)}" style="--line:${esc(r.hexcolor)}"><span class="swatch"></span><span>${esc(bartDestName(a))}</span><span class="pick">Next stop</span></button>`).join("")}</div>
        <button class="linkbtn" id="mback" type="button">← All trains</button>`;
    }
    let ct = "";
    if (S.mode !== "bart") {
      if (!S.key511) ct = `<p class="muted small">Add a 511 key in Settings to list Caltrain trains.</p>`;
      else if (!S.vehicles) ct = `<p class="muted small">${S.ctErr ? esc(S.ctErr) : "Loading Caltrain trains…"}</p>`;
      else {
        const list = S.vehicles.slice().sort((a, b) => (a.dir + a.train).localeCompare(b.dir + b.train, undefined, { numeric: true }));
        ct = list.length ? `<div class="alts">${list.map((v) => {
          const next = caltrainStops(v.train, v)[0];
          return `<button class="alt mct" data-train="${esc(v.train)}" style="--line:#c8102e"><span class="swatch"></span><span>Caltrain ${esc(v.train)}<small>${v.dir === "N" ? "Northbound" : v.dir === "S" ? "Southbound" : ""}${v.line ? " · " + esc(v.line) : ""}${next ? ` · next: ${esc(next.name)} ${clock(next.time)}` : ""}</small></span><span class="pick">This one</span></button>`;
        }).join("")}</div>` : `<p class="muted small">511 reports no Caltrain trains running right now.</p>`;
      }
      ct = `<p class="eyebrow">Caltrain · running now</p>${ct}`;
    }
    let bart = "";
    if (S.mode !== "ct" && S.bart) {
      const seen = new Set();
      const routes = S.bart.routes.filter((r) => !seen.has(r.routeID) && seen.add(r.routeID));
      bart = `<p class="eyebrow">BART · pick your line</p><div class="alts">${routes.map((r) => `<button class="alt mline" data-route="${esc(r.routeID)}" style="--line:${esc(r.hexcolor)}"><span class="swatch"></span><span>${esc(titleCase(r.color))} to ${esc(bartDestName(r.destination))}</span><span class="pick">›</span></button>`).join("")}</div>`;
    }
    return `${head}${ct}${bart}`;
  }

  function wireManual(card) {
    const close = () => { S.manualOpen = null; S.manualDismissed = true; render(); };
    $("#mclose")?.addEventListener("click", close);
    $("#mback")?.addEventListener("click", () => { S.manualOpen = { step: "list" }; render(); });
    card.querySelectorAll(".mline").forEach((b) => b.addEventListener("click", () => { S.manualOpen = { step: "bart", routeId: b.dataset.route }; render(); }));
    card.querySelectorAll(".mstation").forEach((b) => b.addEventListener("click", () => {
      const r = S.bart.routes.find((x) => x.routeID === S.manualOpen.routeId);
      const first = S.etd ? TI.etdFor(S.etd, b.dataset.abbr, r)[0] : null;
      S.lock = { sys: "bart", manual: true, routeId: r.routeID, nextAbbr: b.dataset.abbr, eta: first ? S.etdAt + first.minutes * 60e3 : Date.now() + 120e3 };
      S.manualOpen = null; S.plan = []; tick();
    }));
    card.querySelectorAll(".mct").forEach((b) => b.addEventListener("click", () => {
      S.lock = { sys: "ct", manual: true, train: b.dataset.train };
      S.manualOpen = null; S.plan = []; tick();
    }));
  }

  function openManual() { S.manualOpen = { step: "list" }; render(); tick(); }

  // ---------- Transfers ----------
  // Station keys: BART abbreviation ("MCAR") or "ct:<name>" for Caltrain. Millbrae links the two.
  const bartAbbrOf = (key) => (key.startsWith("ct:") ? (key === "ct:Millbrae" ? "MLBR" : null) : key);
  const ctNameOf = (key) => (key.startsWith("ct:") ? key.slice(3) : key === "MLBR" ? "Millbrae" : null);
  const bartDestName = (abbr) => S.bart?.stations[abbr]?.name || abbr;

  // Is this a station where BART lines split or meet (so a transfer makes sense)?
  function isTransferStation(key, ident) {
    if (key === "MLBR" || key === "ct:Millbrae") return true;
    if (key.startsWith("ct:") || !S.bart) return false;
    const mine = S.bart.routes.find((r) => r.routeID === ident?.routeId);
    const nb = (r) => { const i = r.stations.indexOf(key); return i < 0 ? null : [r.stations[i - 1], r.stations[i + 1]].sort().join(); };
    const myNb = mine ? nb(mine) : null;
    return S.bart.routes.some((r) => r !== mine && r.stations.includes(key) && nb(r) !== myNb &&
      !(mine && r.hexcolor === mine.hexcolor && r.direction !== mine.direction));
  }

  function bartLegStops(route, abbr, minutes) {
    const idx = route.stations.indexOf(abbr);
    return TI.bartStops({ route, nextIdx: idx, minutesToNext: minutes }, { ...S.bart, etd: S.etd })
      .slice(1).map((s) => ({ key: s.abbr, name: s.name, time: S.etdAt + s.minutes * 60e3, estimated: s.estimated }));
  }

  // Trains leaving station `key` at or after `tArr`, excluding the train you're on (`ident`).
  function transferOptions(key, tArr, ident, all) {
    const out = [], seen = new Set();
    const abbr = bartAbbrOf(key), ctName = ctNameOf(key);
    if (abbr && S.bart && S.etd) {
      const mine = S.bart.routes.find((r) => r.routeID === ident?.routeId);
      for (const r of S.bart.routes) {
        const i = r.stations.indexOf(abbr);
        if (i < 0 || i === r.stations.length - 1) continue;
        if (ident?.sys === "bart" && r.routeID === ident.routeId) continue;
        let n = 0;
        for (const e of TI.etdFor(S.etd, abbr, r)) {
          const t = S.etdAt + e.minutes * 60e3;
          // BART holds connecting trains for timed transfers, and ETDs are whole-minute
          // departure estimates, so a connection can read the same minute or up to 2 earlier than yours.
          const slack = ident?.sys === "bart" ? 2.5 * 60e3 : 60e3;
          const early = t < tArr - slack;
          if (early && !all) continue;
          const dk = `${r.hexcolor}|${e.destAbbr}|${e.minutes}`;
          if (seen.has(dk)) continue;
          seen.add(dk);
          out.push({ sys: "bart", routeId: r.routeID, at: abbr, eta: t, time: t, color: r.hexcolor,
            label: `${titleCase(r.color)} to ${e.destName || bartDestName(r.destination)}`, cars: e.cars, early });
          if (++n >= 2 && !all) break;
        }
      }
    }
    if (ctName && S.visits) {
      for (const [train, list] of Object.entries(S.visits)) {
        if (ident?.sys === "ct" && train === ident.train) continue;
        const i = list.findIndex((s) => s.name === ctName);
        const early = list[i].time < tArr - 60e3;
        if (i < 0 || i === list.length - 1 || (early && !all)) continue;
        out.push({ sys: "ct", train, at: "ct:" + ctName, eta: list[i].time, time: list[i].time, color: "#c8102e",
          label: `Caltrain ${train} to ${list[list.length - 1].name}`, early });
      }
    }
    out.sort((a, b) => a.time - b.time);
    return all ? out : out.slice(0, 5);
  }

  // Re-find a planned connection in the latest data. Returns a segment or null.
  function resolveLeg(leg) {
    if (leg.sys === "bart") {
      const r = S.bart?.routes.find((x) => x.routeID === leg.routeId);
      if (!r || !S.etd) return null;
      const ests = TI.etdFor(S.etd, leg.at, r);
      if (!ests.length) return null;
      const best = ests.reduce((a, b) => (Math.abs(S.etdAt + b.minutes * 60e3 - leg.eta) < Math.abs(S.etdAt + a.minutes * 60e3 - leg.eta) ? b : a));
      leg.eta = S.etdAt + best.minutes * 60e3;
      return { ident: { sys: "bart", routeId: r.routeID }, color: r.hexcolor, title: `${titleCase(r.color)} to ${bartDestName(r.destination)}`,
        depart: leg.eta, stops: bartLegStops(r, leg.at, best.minutes) };
    }
    const list = S.visits?.[leg.train];
    const name = leg.at.slice(3);
    const i = list ? list.findIndex((s) => s.name === name) : -1;
    if (i < 0) return null;
    leg.eta = list[i].time;
    return { ident: { sys: "ct", train: leg.train }, color: "#c8102e", title: `Caltrain ${leg.train}`, depart: leg.eta,
      stops: list.slice(i + 1).map((s) => ({ key: "ct:" + s.name, name: s.name, time: s.time, estimated: false })) };
  }

  const sameTrain = (a, b) => a && b && a.sys === b.sys && (a.sys === "bart" ? a.routeId === b.routeId : a.train === b.train);

  // Current train plus any planned connections, as a list of segments.
  function itinerary(r) {
    // Once you've boarded a planned connection, it becomes the current train.
    while (S.plan.length && sameTrain(S.plan[0], r.ident)) S.plan.shift();
    const segs = [{ ident: r.ident, color: r.color, title: r.title, stops: r.stops }];
    for (const leg of S.plan) {
      const last = segs[segs.length - 1];
      const idx = last.stops.findIndex((s) => s.key === leg.at || (!!bartAbbrOf(s.key) && bartAbbrOf(s.key) === bartAbbrOf(leg.at)));
      if (idx < 0) break;
      const res = resolveLeg(leg);
      if (!res) { last.missing = last.stops[idx].name; break; }
      last.stops = last.stops.slice(0, idx + 1);
      last.change = { at: last.stops[idx].name, arrive: last.stops[idx].time, depart: res.depart };
      segs.push(res);
    }
    return segs;
  }

  async function openPicker(seg, key, tArr) {
    S.picker = { seg, key, tArr };
    render();
    // Caltrain connections need stop predictions for every train.
    if (ctNameOf(key) && S.key511 && Date.now() - S.visitsAt > 60e3) { await refreshVisits(true); render(); }
  }

  // ---------- Render ----------
  // Gap between your train and a connection, both as whole-minute estimates.
  function waitText(ms, bothBart) {
    const m = Math.round(ms / 60e3);
    if (bothBart && m <= 1) return "timed transfer";
    if (m <= 0) return "tight connection";
    return `${m} min wait`;
  }
  const titleCase = (s) => (s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const inMin = (t) => { const m = Math.round((t - Date.now()) / 60e3); return m <= 0 ? "now" : `${m} min`; };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ago = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`; };

  function render() {
    renderDebug();
    const main = $("#main");
    $("#start").hidden = S.started;
    main.hidden = !S.started;

    // Status chips
    const cur = S.fixes[S.fixes.length - 1];
    const chips = [];
    chips.push(cur ? `<span class="chip ok">GPS ±${Math.round(cur.acc || 0)} m · ${ago(cur.at)}</span>` : `<span class="chip wait">${esc(S.geoErr || "Finding you…")}</span>`);
    if (S.mode !== "ct") chips.push(S.etdErr ? `<span class="chip bad">BART: ${esc(S.etdErr)}</span>` : S.etdAt ? `<span class="chip ok">BART live · ${ago(S.etdAt)}</span>` : `<span class="chip wait">BART loading…</span>`);
    if (S.mode !== "bart") chips.push(!S.key511 ? `<span class="chip wait">Caltrain off · add a 511 key</span>` : S.ctErr ? `<span class="chip bad">Caltrain: ${esc(S.ctErr)}</span>` : S.vehAt ? `<span class="chip ok">Caltrain live · ${ago(S.vehAt)}</span>` : `<span class="chip wait">Caltrain loading…</span>`);
    $("#status").innerHTML = chips.join("");

    const r = S.lastResult;
    const card = $("#result");
    // Fuzzy location (e.g. a laptop on train Wi-Fi): offer hand-picking straight away.
    if (!S.manualOpen && !S.manualDismissed && !S.lock && cur && cur.acc > 2000) S.manualOpen = { step: "list" };
    if (S.manualOpen) {
      card.innerHTML = `${cur?.acc > 2000 ? `<p class="warn">Your location is only accurate to about ${Math.round(cur.acc / 1000)} km, too rough to tell which train you're on. Pick it below.</p>` : ""}${manualHtml()}`;
      wireManual(card);
      return;
    }
    const pickLink = `<button class="linkbtn" id="mopen" type="button">Pick my train by hand</button>`;
    if (!r) { card.innerHTML = `<p class="muted">Waiting for your location and live data…</p>${pickLink}`; $("#mopen").addEventListener("click", openManual); return; }
    if (!r.sys && r.waiting) {
      card.innerHTML = `<div class="empty"><h2>Checking ${esc(r.waiting)}…</h2><p class="muted">Waiting for live ${esc(r.waiting)} data before deciding which train you're on.</p>${pickLink}</div>`;
      $("#mopen").addEventListener("click", openManual);
      return;
    }
    if (!r.sys) {
      const km = (d) => (d / 1000).toFixed(1) + " km";
      const fuzzy = r.fix?.acc > 500 ? `<p class="warn">Your location is only accurate to about ${km(r.fix.acc)}. Laptops and tethered connections often can't place you precisely; a phone with GPS works best.</p>` : "";
      const ctLine = r.ctCount === 0 ? " 511 reports no Caltrain trains running right now." : r.nearestCt ? ` Nearest Caltrain: <strong>${esc(r.nearestCt.train)}</strong>, ${km(r.nearestCt.d)} away${r.nearestCt.age != null ? ` (position ${r.nearestCt.age < 90 ? r.nearestCt.age + " s" : Math.round(r.nearestCt.age / 60) + " min"} old)` : ""}.` : "";
      card.innerHTML = `<div class="empty">${fuzzy}<h2>Not on a train line</h2><p class="muted">You don't appear to be on BART${S.key511 ? " or Caltrain" : ""} right now.${r.nearest ? ` Nearest BART station: <strong>${esc(r.nearest.name)}</strong>, ${km(r.nearest.d)} away.` : ""}${ctLine}</p>${!S.key511 && S.mode !== "bart" ? `<p class="muted">Caltrain detection is off until you add a 511 key in Settings.</p>` : ""}${pickLink}</div>`;
      $("#mopen").addEventListener("click", openManual);
      return;
    }
    const sysName = r.sys === "bart" ? "BART" : "Caltrain";
    const warn = [];
    if (r.direction === "unknown") warn.push("Direction not certain yet. It firms up once the train has moved a bit.");
    if (!r.plausible) warn.push("Low confidence: no train is clearly next on your stretch of track.");
    if (r.posAge > 180) warn.push(`Train position is ${Math.round(r.posAge / 60)} min old.`);

    const segs = itinerary(r);
    const pk = S.picker;
    const pickerHtml = (si, s) => {
      const opts = transferOptions(s.key, s.time, segs[si].ident, pk.all);
      const more = !pk.all;
      const loadingCt = ctNameOf(s.key) && S.key511 && !S.visits;
      return `<li class="picker"><div>
        <p class="eyebrow">Connections at ${esc(s.name)} · you arrive ${clock(s.time)}</p>
        ${opts.length ? opts.map((o, i) => {
          return `<button class="alt opt" data-o="${i}" style="--line:${esc(o.color)}"><span class="swatch"></span><span>${esc(o.label)}<small>Leaves ${clock(o.time)} · ${o.early ? "before your estimated arrival" : waitText(o.time - s.time, o.sys === "bart" && segs[si].ident?.sys === "bart")}${o.cars ? ` · ${o.cars} cars` : ""}</small></span><span class="pick">Take</span></button>`;
        }).join("") : `<p class="muted small">${loadingCt ? "Loading Caltrain times…" : ctNameOf(s.key) && !S.key511 ? "Add a 511 key in Settings to see Caltrain connections." : "No connecting trains in the live data right now."}</p>`}
        <div class="actions">${more ? `<button class="btn" id="pickmore" type="button">More…</button>` : ""}<button class="btn" id="pickcancel" type="button">Cancel</button></div>
      </div></li>`;
    };
    let pickerOpts = null;
    const segHtml = segs.map((seg, si) => {
      const rows = seg.stops.map((s, i) => {
        const isNext = si === 0 && i === 0;
        const isChange = seg.change && i === seg.stops.length - 1;
        const xfer = !isChange && isTransferStation(s.key, seg.ident);
        const open = pk && pk.seg === si && pk.key === s.key;
        if (open) pickerOpts = transferOptions(s.key, s.time, seg.ident, pk.all);
        return `
        <li class="stop${isNext ? " next" : ""}${open ? " open" : ""}">
          <span class="dot" aria-hidden="true"></span>
          <button class="name stopbtn" type="button" data-seg="${si}" data-key="${esc(s.key)}" data-t="${s.time}" aria-expanded="${open}">
            <span>${esc(s.name)}${xfer ? ` <span class="tag">${s.key === "MLBR" ? "Caltrain" : s.key === "ct:Millbrae" ? "BART" : "Transfer"}</span>` : ""}</span>
            ${isNext ? `<small>Next stop</small>` : isChange ? `<small>Get off here</small>` : ""}
          </button>
          <span class="when"><b>${s.estimated ? "~" : ""}${clock(s.time)}</b><small>${s.estimated ? "est. " : ""}${inMin(s.time)}</small></span>
        </li>${open ? pickerHtml(si, s) : ""}`;
      }).join("");
      const change = seg.change ? `
        <div class="change" style="--line:${esc(segs[si + 1].color)}">
          <span>Change at <strong>${esc(seg.change.at)}</strong> · ${waitText(seg.change.depart - seg.change.arrive, seg.ident?.sys === "bart" && segs[si + 1].ident?.sys === "bart")}</span>
          <button class="linkbtn" data-unplan="${si}" type="button">Remove</button>
        </div>
        <div class="train leg" style="--line:${esc(segs[si + 1].color)}"><p class="eyebrow">Then</p><h3>${esc(segs[si + 1].title)}</h3><p class="sub">Leaves ${clock(seg.change.depart)}</p></div>` : "";
      const missing = seg.missing ? `<p class="warn">Your planned connection at ${esc(seg.missing)} isn't in the live data right now.</p>` : "";
      return `${seg.stops.length ? `<ol class="stops" style="--line:${esc(seg.color)}">${rows}</ol>` : ""}${missing}${change}`;
    }).join("");

    card.innerHTML = `
      <div class="train" style="--line:${esc(r.color)}">
        <p class="eyebrow">You're on ${sysName}</p>
        <h2>${esc(r.title)}</h2>
        ${r.sub ? `<p class="sub">${esc(r.sub)}</p>` : ""}
        <div class="actions">
          ${S.lock ? `<button id="unlock" class="btn">Not my train</button><span class="muted small">${S.lock.manual ? "Picked by hand" : "Locked to this train"}</span>` : `<button id="lock" class="btn primary">Yes, this is my train</button>`}
          ${pickLink}
        </div>
      </div>
      ${warn.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
      ${r.stops.length ? `<p class="hint muted small">Tap a station to plan a transfer there.</p>${segHtml}` : `<p class="muted">No upcoming stop times available for this train yet.</p>`}
      ${r.alts?.length ? `<div class="alts"><p class="eyebrow">Other possibilities</p>${r.alts.map((a, i) => `<button class="alt" data-i="${i}" style="--line:${esc(a.color)}"><span class="swatch"></span><span><span class="why">${esc(a.why)}</span>${esc(a.label)}<small>${esc(a.detail)}</small></span><span class="pick">Switch</span></button>`).join("")}${S.allAlts ? `<button class="btn" id="altsless" type="button">Fewer</button>` : `<button class="btn" id="altsmore" type="button">More…</button>`}</div>` : r.manual ? "" : `<div class="alts"><button class="btn" id="altsmore" type="button" ${S.allAlts ? "hidden" : ""}>Not right? Look wider…</button></div>`}
    `;
    $("#lock")?.addEventListener("click", () => { S.lock = r.lockKey; tick(); });
    $("#unlock")?.addEventListener("click", () => { S.lock = null; S.manualDismissed = false; tick(); });
    $("#mopen")?.addEventListener("click", openManual);
    card.querySelectorAll(".alt:not(.opt)").forEach((b) => b.addEventListener("click", () => { S.lock = r.alts[+b.dataset.i].lock; S.allAlts = false; tick(); }));
    card.querySelectorAll(".stopbtn").forEach((b) => b.addEventListener("click", () => {
      const seg = +b.dataset.seg, key = b.dataset.key;
      if (S.picker && S.picker.seg === seg && S.picker.key === key) { S.picker = null; render(); return; }
      openPicker(seg, key, +b.dataset.t);
    }));
    $("#pickcancel")?.addEventListener("click", () => { S.picker = null; render(); });
    $("#pickmore")?.addEventListener("click", () => { S.picker.all = true; render(); });
    $("#altsmore")?.addEventListener("click", () => { S.allAlts = true; tick(); });
    $("#altsless")?.addEventListener("click", () => { S.allAlts = false; tick(); });
    card.querySelectorAll(".opt").forEach((b) => b.addEventListener("click", () => {
      const o = pickerOpts[+b.dataset.o];
      const leg = o.sys === "bart" ? { sys: "bart", at: o.at, routeId: o.routeId, eta: o.eta } : { sys: "ct", at: o.at, train: o.train, eta: o.eta };
      S.plan = S.plan.slice(0, S.picker.seg).concat([leg]);
      S.picker = null;
      render();
    }));
    card.querySelectorAll("[data-unplan]").forEach((b) => b.addEventListener("click", () => { S.plan = S.plan.slice(0, +b.dataset.unplan); render(); }));
  }

  function renderDebug() {
    const el = $("#debug");
    el.hidden = !S.debug;
    if (!S.debug) return;
    const cur = S.fixes[S.fixes.length - 1];
    const m = (d) => (isFinite(d) ? Math.round(d) + "m" : "–");
    const lines = [];
    lines.push(`fix ${cur ? `${cur.lat.toFixed(5)},${cur.lon.toFixed(5)} ±${Math.round(cur.acc)}m hdg ${cur.heading ?? "–"} spd ${cur.speed?.toFixed?.(1) ?? "–"}` : "none"}`);
    lines.push(`mode ${S.mode} lock ${S.lock ? JSON.stringify(S.lock) : "none"}`);
    const d = S.dbg || {};
    lines.push(`BART score ${m(d.bd)} dir ${d.bart?.direction ?? "–"}`);
    for (const c of (d.bart?.candidates || []).slice(0, 4))
      lines.push(`  ${c.route.color} → ${c.route.destination} r${c.rank} next ${c.route.stations[c.nextIdx]} ${c.minutesToNext}min off ${m(c.offTrack)} dir ${c.dirScore}${c.plausible ? "" : " implausible"}`);
    lines.push(`Caltrain score ${m(d.cd)} dir ${d.ct?.direction ?? "–"} · ${S.vehicles?.length ?? "–"} positions, ${S.visits ? Object.keys(S.visits).length : "–"} trains w/ predictions, ${S.ctStops ? Object.keys(S.ctStops).length : "–"} stations`);
    for (const c of (d.ct?.candidates || []).slice(0, 4))
      lines.push(`  #${c.train} ${c.dir || "?"} live ${m(c.etaScore)}${c.est ? (c.est.method === "interp" ? ` (${Math.round(c.est.f * 100)}% from ${c.est.from})` : ` (@${c.est.speed.toFixed(0)}m/s)`) : ""} pos ${m(c.posScore)} (raw ${m(c.realD)})${c.next ? ` next ${c.next.name} ${clock(c.next.time)}` : ""}${c.dirOk ? "" : " wrong-dir"}`);
    let used = 0; try { used = store.get("ti.511log", []).filter((t) => Date.now() - t < 36e5).length; } catch {}
    lines.push(`511 requests this hour: ${used}/60`);
    el.textContent = lines.join("\n");
  }

  // ---------- Wire up ----------
  $("#go").addEventListener("click", start);
  $("#refresh").addEventListener("click", () => tick(true));
  $("#mode").addEventListener("change", (e) => { S.mode = e.target.value; S.lock = null; store.set("ti.mode", S.mode); tick(true); });
  // Fill settings once on load; redraws never touch them, so typing isn't overwritten.
  $("#mode").value = S.mode;
  $("#debugtoggle").checked = S.debug;
  $("#debugtoggle").addEventListener("change", (e) => { S.debug = e.target.checked; store.set("ti.debug", S.debug); render(); });
  $("#key511").value = S.key511;
  function saveKey(refresh) {
    const k = $("#key511").value.trim();
    if (k === S.key511) return;
    S.key511 = k; store.set("ti.key511", k);
    S.vehAt = 0; S.visitsAt = 0; S.ctErr = null; $("#keysaved").hidden = false;
    setTimeout(() => ($("#keysaved").hidden = true), 2000);
    if (refresh) tick(true);
  }
  $("#key511").addEventListener("input", () => saveKey(false));
  $("#key511").addEventListener("change", () => saveKey(true));
  $("#keyform").addEventListener("submit", (e) => { e.preventDefault(); saveKey(true); tick(true); });
  render();
  if (store.get("ti.started", false) || sim()) start();
})();
