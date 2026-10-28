// Pure matching logic, no DOM. Works in the browser (window.TI) and Node (require).
(function (root) {
  const R = 6371000;

  // Local flat projection in meters; fine at Bay Area scale.
  function xy(lat, lon, lat0) {
    const k = Math.cos((lat0 * Math.PI) / 180);
    return [lon * 111320 * k, lat * 110540];
  }

  function dist(a, b) {
    const toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR;
    const dLon = (b.lon - a.lon) * toR;
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // Project point p onto segment a-b. Returns {t (0..1), d (meters), len}.
  function project(p, a, b) {
    const lat0 = p.lat;
    const [px, py] = xy(p.lat, p.lon, lat0);
    const [ax, ay] = xy(a.lat, a.lon, lat0);
    const [bx, by] = xy(b.lat, b.lon, lat0);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    return { t, d: Math.hypot(px - qx, py - qy), len: Math.sqrt(len2) };
  }

  // Compass bearing a -> b in degrees.
  function bearing(a, b) {
    const toR = Math.PI / 180;
    const y = Math.sin((b.lon - a.lon) * toR) * Math.cos(b.lat * toR);
    const x =
      Math.cos(a.lat * toR) * Math.sin(b.lat * toR) -
      Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos((b.lon - a.lon) * toR);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  // ---------- BART ----------

  // Where along a route is point p? Returns best {i, t, d, along} or null.
  function locateOnRoute(p, route, stations) {
    const cfg = route.stations;
    let best = null, acc = 0;
    for (let i = 0; i < cfg.length - 1; i++) {
      const a = stations[cfg[i]], b = stations[cfg[i + 1]];
      if (!a || !b) continue;
      const pr = project(p, a, b);
      if (!best || pr.d < best.d) best = { i, t: pr.t, d: pr.d, len: pr.len, along: acc + pr.t * pr.len };
      acc += pr.len;
    }
    return best;
  }

  function estMatchesRoute(destAbbr, est, route) {
    const destOk = !!destAbbr && destAbbr.toUpperCase() === route.destination.toUpperCase();
    // Several lines can share a terminus (e.g. Orange and Red both end at Richmond), so line color decides.
    if (est.hexcolor && route.hexcolor) {
      if (est.hexcolor.toUpperCase() !== route.hexcolor.toUpperCase()) return false;
      const dirOk = !!est.direction && !!route.direction && est.direction.toLowerCase() === route.direction.toLowerCase();
      return destOk || dirOk;
    }
    return destOk;
  }

  // All ETD minutes (departures) at station `abbr` for trains running `route`.
  function etdFor(etd, abbr, route) {
    const st = etd[abbr];
    if (!st) return [];
    const out = [];
    for (const dest of st.etd || []) {
      for (const e of dest.estimate || []) {
        if (!estMatchesRoute(dest.abbreviation, e, route)) continue;
        const m = e.minutes === "Leaving" ? 0 : parseInt(e.minutes, 10);
        if (!Number.isNaN(m)) out.push({ minutes: m, cars: +e.length || null, destName: dest.destination, destAbbr: dest.abbreviation });
      }
    }
    return out.sort((a, b) => a.minutes - b.minutes);
  }

  // Figure out candidate BART trains for fix `p`, previous fix `prev` (or null).
  // data: {stations: {ABBR:{lat,lon,name}}, routes: [...], etd: {ABBR: station}, etdAt: ms}
  function bartCandidates(p, prev, data, opts = {}) {
    const maxD = opts.maxD ?? 1200;
    const locs = [];
    for (const r of data.routes) {
      if (opts.routeId && r.routeID !== opts.routeId) continue;
      const loc = locateOnRoute(p, r, data.stations);
      if (loc && loc.d <= maxD) locs.push({ route: r, loc });
    }
    if (!locs.length) return { candidates: [], nearestD: null, direction: "none" };
    const dmin = Math.min(...locs.map((x) => x.loc.d));
    let near = locs.filter((x) => x.loc.d <= dmin + (opts.spread ?? 200));

    // Direction: along-track progress since previous fix, else GPS heading.
    let direction = "unknown";
    const moving = [];
    for (const x of near) {
      let sign = 0;
      if (prev) {
        const pl = locateOnRoute(prev, x.route, data.stations);
        if (pl) {
          const delta = x.loc.along - pl.along;
          if (Math.abs(delta) > 80) sign = Math.sign(delta);
        }
      }
      if (!sign && p.heading != null && (p.speed ?? 0) > 3) {
        const cfg = x.route.stations;
        const segB = bearing(data.stations[cfg[x.loc.i]], data.stations[cfg[x.loc.i + 1]]);
        const diff = Math.cos(((p.heading - segB) * Math.PI) / 180);
        if (Math.abs(diff) > 0.4) sign = Math.sign(diff);
      }
      x.sign = sign;
      if (sign > 0) moving.push(x);
    }
    if (moving.length) direction = "known";

    // One candidate per (route, rank): rank 0 is the first train due at the next
    // station, rank 1 the one behind it. Opposite-direction routes are kept but ranked low.
    const cands = [];
    for (const x of near) {
      const cfg = x.route.stations;
      const seg = x.loc;
      const atStation = seg.t > 0.97 && seg.len * (1 - seg.t) < 250;
      const nextIdx = seg.i + 1;
      const ests = etdFor(data.etd, cfg[nextIdx], x.route);
      const remain = seg.len * (1 - seg.t);
      const expectMin = remain / 15 / 60; // ~54 km/h average
      const dirScore = x.sign > 0 ? 2 : x.sign === 0 ? 1 : 0;
      ests.slice(0, opts.ranks ?? 2).forEach((e, rank) => {
        cands.push({
          route: x.route, nextIdx, atStation, offTrack: seg.d, rank, dirScore,
          minutesToNext: e.minutes, cars: e.cars,
          plausible: e.minutes <= expectMin + 6,
        });
      });
    }
    // The train we're on reaches the next station soonest among trains on our track, going our way.
    cands.sort((a, b) =>
      (b.dirScore - a.dirScore) || (a.rank - b.rank) || (b.plausible - a.plausible) || (a.minutesToNext - b.minutesToNext));
    return { candidates: cands, nearestD: dmin, direction };
  }

  // Arrival chain for a chosen BART candidate. Returns [{abbr, name, minutes, estimated}]
  function bartStops(cand, data) {
    const cfg = cand.route.stations;
    const out = [];
    let prev = cand.minutesToNext;
    out.push({ abbr: cfg[cand.nextIdx], name: data.stations[cfg[cand.nextIdx]]?.name, minutes: prev, estimated: false });
    for (let j = cand.nextIdx + 1; j < cfg.length; j++) {
      const abbr = cfg[j];
      const ests = etdFor(data.etd, abbr, cand.route).filter((e) => e.minutes >= prev);
      const a = data.stations[cfg[j - 1]], b = data.stations[abbr];
      const runMin = a && b ? dist(a, b) / 15 / 60 + 0.5 : 2;
      let m, estimated = false;
      // Accept a live estimate only if it's consistent with the run time from the previous stop.
      if (ests.length && ests[0].minutes <= prev + runMin * 2 + 3) m = ests[0].minutes;
      else { m = prev + runMin; estimated = true; }
      out.push({ abbr, name: b?.name || abbr, minutes: Math.round(m * 10) / 10, estimated });
      prev = m;
    }
    return out;
  }

  // ---------- Caltrain (511 SIRI) ----------

  function arr(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; }

  function parse511(text) {
    return JSON.parse(text.replace(/^﻿/, ""));
  }

  function vehiclesFrom511(j) {
    const del = arr(j?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery);
    const out = [];
    for (const d of del) {
      for (const act of arr(d.VehicleActivity)) {
        const v = act.MonitoredVehicleJourney || {};
        const loc = v.VehicleLocation || {};
        const lat = parseFloat(loc.Latitude), lon = parseFloat(loc.Longitude);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        out.push({
          lat, lon,
          train: v.FramedVehicleJourneyRef?.DatedVehicleJourneyRef || v.VehicleRef || "?",
          line: v.PublishedLineName || v.LineRef || "",
          dir: (v.DirectionRef || "").toString().toUpperCase().startsWith("N") ? "N" : (v.DirectionRef ? "S" : ""),
          dest: v.DestinationName || "",
          recordedAt: act.RecordedAtTime ? Date.parse(act.RecordedAtTime) : null,
          calls: [v.MonitoredCall, ...arr(v.OnwardCalls?.OnwardCall)]
            .filter(Boolean)
            .map((c) => ({ name: cleanStop(c.StopPointName), time: Date.parse(c.ExpectedArrivalTime || c.AimedArrivalTime || c.ExpectedDepartureTime || c.AimedDepartureTime) }))
            .filter((c) => isFinite(c.time)),
        });
      }
    }
    return out;
  }

  function stopVisitsFrom511(j) {
    const del = arr(j?.ServiceDelivery?.StopMonitoringDelivery ?? j?.Siri?.ServiceDelivery?.StopMonitoringDelivery);
    const byTrain = {};
    for (const d of del) {
      for (const v of arr(d.MonitoredStopVisit)) {
        const mvj = v.MonitoredVehicleJourney || {};
        const ref = mvj.FramedVehicleJourneyRef?.DatedVehicleJourneyRef || mvj.VehicleRef;
        const c = mvj.MonitoredCall || {};
        const time = Date.parse(c.ExpectedArrivalTime || c.AimedArrivalTime || c.ExpectedDepartureTime || c.AimedDepartureTime);
        if (!ref || !isFinite(time)) continue;
        (byTrain[ref] ||= []).push({ name: cleanStop(c.StopPointName), time });
      }
    }
    for (const k in byTrain) {
      const seen = new Set();
      byTrain[k] = byTrain[k].sort((a, b) => a.time - b.time).filter((s) => !seen.has(s.name) && seen.add(s.name));
    }
    return byTrain;
  }

  function cleanStop(n) {
    return (n || "")
      .replace(/\s*Caltrain( Station)?/i, "")
      .replace(/\s*Station/i, "")
      .replace(/\s*(North|South)bound$/i, "")
      .replace(/\s*Platform \w+$/i, "")
      .trim();
  }

  // Pick the Caltrain vehicle nearest to p, respecting travel direction when known.
  function caltrainCandidates(p, prev, vehicles, opts = {}) {
    const maxD = opts.maxD ?? 1500;
    let dirWanted = null;
    if (prev && Math.abs(p.lat - prev.lat) > 0.0006) dirWanted = p.lat > prev.lat ? "N" : "S";
    else if (p.heading != null && (p.speed ?? 0) > 3) {
      const c = Math.cos((p.heading * Math.PI) / 180);
      if (Math.abs(c) > 0.3) dirWanted = c > 0 ? "N" : "S";
    }
    let list = vehicles
      .map((v) => ({ ...v, d: dist(p, v) }))
      .filter((v) => v.d <= maxD && (!opts.train || v.train === opts.train));
    for (const v of list) v.dirOk = !dirWanted || !v.dir || v.dir === dirWanted;
    list.sort((a, b) => (b.dirOk - a.dirOk) || (a.d - b.d));
    return { candidates: list, nearestD: list[0]?.d ?? null, direction: dirWanted ? "known" : "unknown" };
  }

  const api = { dist, project, bearing, locateOnRoute, etdFor, bartCandidates, bartStops, parse511, vehiclesFrom511, stopVisitsFrom511, cleanStop, caltrainCandidates };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TI = api;
})(typeof window !== "undefined" ? window : globalThis);
