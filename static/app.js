/* Beach Club — the shore report for your cluster.
 *
 * Three data planes, kept visibly separate:
 *   1. kontract · spec       — zones & apps as Konstruct declares them (kontract.js)
 *   2. groundcover · zones   — measured signals inside kontract-* namespaces (/api/gc/zone-workloads)
 *   3. groundcover · control — the control plane cluster itself (/api/gc/*)
 * The theme user cares about plane 1 first, plane 3 second; plane 2 correlates
 * the two by namespace (kontract-<org…>-<zone>) and says so honestly when the
 * zone clusters have no agent yet.
 *
 * No credential ever reaches the browser. Every API-derived string is rendered
 * with textContent.
 */

(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const state = {
    range: "1h",
    mode: { live: false, cluster: "", uiBaseUrl: "https://groundcover.civo.io" },
    lastPhases: new Map(), // app name -> phase, for the ship moment
    shipMomentShown: false,
  };

  const PHASE_WORDS = {
    Building: ["Shaping", "busy"],
    Pushing: ["Waxing", "busy"],
    Deploying: ["Paddling out", "busy"],
    Live: ["Riding", "live"],
    Failed: ["Wiped out", "failed"],
  };

  // ---------- fetch helpers ----------

  async function gc(path) {
    const res = await fetch("/api/gc/" + path);
    if (!res.ok) throw new Error("gc " + path + " " + res.status);
    return res.json();
  }

  // ---------- formatting ----------

  const fmtCores = (v) => (v >= 10 ? v.toFixed(1) : v.toFixed(2));
  const fmtMs = (v) => (v >= 1000 ? (v / 1000).toFixed(2) + "s" : Math.round(v) + "ms");
  const fmtPct = (v) => (v < 0.05 && v > 0 ? "<0.1" : v.toFixed(1));
  function fmtBytes(v) {
    const u = ["B", "KiB", "MiB", "GiB", "TiB"];
    let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 10 ? 0 : 1) + " " + u[i];
  }
  function fmtBps(v) {
    const u = ["B/s", "KiB/s", "MiB/s", "GiB/s"];
    let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 10 ? 0 : 1) + " " + u[i];
  }
  function timeAgo(ts) {
    const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 90) return Math.round(s) + "s";
    if (s < 5400) return Math.round(s / 60) + "m";
    if (s < 172800) return Math.round(s / 3600) + "h";
    return Math.round(s / 86400) + "d";
  }

  // ---------- deeplinks into the groundcover UI ----------

  function wireDeeplinks() {
    const base = state.mode.uiBaseUrl || "https://groundcover.civo.io";
    document.querySelectorAll("[data-gc-path]").forEach((a) => {
      a.href = base + a.getAttribute("data-gc-path");
    });
    $("#gc-open").href = base;
    $("#gc-foot").href = base;
  }

  // ---------- shoreline hero ----------

  // A periodic wave path (period 600px over an 1800px band) so the CSS drift
  // animation loops seamlessly. Amplitude is set from control-plane CPU load
  // (ambient weather); conditions text is set from the user's boards.
  function wavePath(baseY, amp, phase) {
    const period = 600, width = 1800, half = period / 2;
    let d = `M0,300 L0,${baseY.toFixed(1)} `;
    for (let x = 0; x < width; x += period) {
      const up = (baseY - amp).toFixed(1), dn = (baseY + amp * 0.6).toFixed(1);
      const q1 = phase ? dn : up, q2 = phase ? up : dn;
      d += `Q${(x + half / 2).toFixed(1)},${q1} ${(x + half).toFixed(1)},${baseY.toFixed(1)} `;
      d += `Q${(x + half + half / 2).toFixed(1)},${q2} ${(x + period).toFixed(1)},${baseY.toFixed(1)} `;
    }
    return d + `L${width},300 Z`;
  }

  function drawTide(cpuUtil) {
    const amp = 4 + Math.min(1, Math.max(0, cpuUtil)) * 26;
    $("#wave-back").setAttribute("d", wavePath(196, amp * 0.7, 0));
    $("#wave-mid").setAttribute("d", wavePath(214, amp, 1));
    $("#wave-front").setAttribute("d", wavePath(238, amp * 0.8, 0));
  }

  function plantGrass() {
    const g = $("#dune-grass");
    const duneY = (x) => {
      if (x < 420) return 258 + (252 - 258) * (x / 420) - 18 * Math.sin((x / 420) * Math.PI);
      if (x < 640) return 252 + 10 * Math.sin(((x - 420) / 220) * Math.PI * 0.5);
      return 262 - 16 * ((x - 640) / 560);
    };
    let svg = "";
    const tufts = 26;
    for (let i = 0; i < tufts; i++) {
      const x = 30 + (1140 / tufts) * i + ((i * 37) % 23) - 11;
      const y = duneY(x) + 4;
      const h = 14 + ((i * 13) % 12);
      const cls = "grass g" + ((i % 3) + 1);
      for (let b = -1; b <= 1; b++) {
        const dx = b * (3 + (i % 3));
        svg += `<path class="${cls}" d="M${x},${y} q${dx * 0.4},${-h * 0.55} ${dx},${-h}" opacity="${0.5 + (i % 4) * 0.12}"/>`;
      }
    }
    g.innerHTML = svg; // generated numbers only — no external strings
  }

  // Conditions read from the user's boards — their apps come first.
  function setBoardConditions(apps) {
    const wiped = apps.filter((a) => a.phase === "Failed").length;
    const busy = apps.filter((a) => a.phase && a.phase !== "Live" && a.phase !== "Failed").length;
    const riding = apps.filter((a) => a.phase === "Live").length;
    const cond = $("#cond");
    cond.classList.remove("choppy", "blownout");
    let label, sub;
    if (wiped > 1) {
      label = "blown out";
      cond.classList.add("blownout");
      sub = "Multiple boards wiped out — check the boards table before paddling anything new out.";
    } else if (wiped === 1) {
      label = "choppy";
      cond.classList.add("choppy");
      sub = "One board wiped out; the rest of the lineup is riding. Worth a look.";
    } else if (riding === 0 && busy > 0) {
      label = "paddling out";
      sub = "Boards are shaping and paddling out — nothing riding yet.";
    } else {
      label = "clean";
      sub = "Every board that paddled out is riding. Go get a coffee.";
    }
    cond.textContent = label;
    $("#report-sub").textContent = sub;

    const el = $("#shore-stats");
    el.textContent = "";
    const chips = [
      { t: [String(riding), " boards riding"] },
      { t: [String(busy), " paddling out"], warn: busy > 0 },
      { t: [String(wiped), " wiped out"], bad: wiped > 0 },
    ];
    for (const c of chips) {
      const chip = document.createElement("span");
      chip.className = "chip" + (c.bad ? " bad" : c.warn ? " warn" : "");
      const b = document.createElement("b");
      b.textContent = c.t[0];
      chip.appendChild(b);
      chip.appendChild(document.createTextNode(c.t[1]));
      el.appendChild(chip);
    }
  }

  // ---------- charts ----------

  let chartSeq = 0;
  function renderChart(el, series, opts) {
    const W = 340, H = 88, PAD = 4;
    const colors = opts.colors || ["#0b8f4d"];
    let min = Infinity, max = -Infinity;
    for (const s of series) for (const [, v] of s.points) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!isFinite(min)) { el.textContent = ""; return; }
    if (max === min) max = min + 1;
    const span = max - min;
    min = Math.max(0, min - span * 0.15);
    max = max + span * 0.1;

    const id = "cg" + chartSeq++;
    let defs = "", body = "";
    series.forEach((s, si) => {
      const pts = s.points;
      if (!pts.length) return;
      const x0 = pts[0][0], x1 = pts[pts.length - 1][0] || x0 + 1;
      const X = (t) => PAD + ((t - x0) / (x1 - x0 || 1)) * (W - PAD * 2);
      const Y = (v) => H - PAD - ((v - min) / (max - min)) * (H - PAD * 2);
      let d = `M${X(pts[0][0]).toFixed(1)},${Y(pts[0][1]).toFixed(1)}`;
      for (let i = 1; i < pts.length; i++) {
        const [t, v] = pts[i];
        const [pt, pv] = pts[i - 1];
        const mx = ((X(pt) + X(t)) / 2).toFixed(1);
        d += ` C${mx},${Y(pv).toFixed(1)} ${mx},${Y(v).toFixed(1)} ${X(t).toFixed(1)},${Y(v).toFixed(1)}`;
      }
      const c = colors[si % colors.length];
      if (series.length === 1) {
        defs += `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
          `<stop offset="0%" stop-color="${c}" stop-opacity="0.34"/>` +
          `<stop offset="100%" stop-color="${c}" stop-opacity="0.02"/></linearGradient>`;
        body += `<path d="${d} L${X(x1).toFixed(1)},${H - PAD} L${X(x0).toFixed(1)},${H - PAD} Z" fill="url(#${id})"/>`;
      }
      body += `<path d="${d}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>`;
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${opts.label || "chart"}"><defs>${defs}</defs>` +
      `<line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="#ecdeb8" stroke-width="1"/>` +
      body + `</svg>`;
  }

  const last = (s) => (s && s.points.length ? s.points[s.points.length - 1][1] : 0);

  async function loadSeries() {
    const [cpu, mem, net] = await Promise.all([
      gc("series?metric=cpu&range=" + state.range),
      gc("series?metric=memory&range=" + state.range),
      gc("series?metric=network&range=" + state.range),
    ]);
    renderChart($("#chart-cpu"), cpu.series, { colors: ["#0b8f4d"], label: "CPU cores over time" });
    renderChart($("#chart-memory"), mem.series, { colors: ["#f5841f"], label: "Memory over time" });
    renderChart($("#chart-network"), net.series, { colors: ["#2a9d8f", "#ffb020"], label: "Network throughput" });

    const cs = cpu.series[0];
    $("#cpu-big").textContent = "";
    $("#cpu-big").append(fmtCores(last(cs)), smallEl(" cores"));
    $("#mem-big").textContent = fmtBytes(last(mem.series[0]));
    const rx = net.series.find((s) => s.name === "rx"), tx = net.series.find((s) => s.name === "tx");
    $("#net-big").textContent = "";
    $("#net-big").append(fmtBps(last(rx)), smallEl(" in"));
    $("#net-sub").textContent = "out " + fmtBps(last(tx)) + " · rx teal, tx gold";
  }

  function smallEl(t) {
    const s = document.createElement("small");
    s.textContent = t;
    return s;
  }

  // ---------- plane 3: control plane summary ----------

  async function loadSummary() {
    const [summary, issuesRes] = await Promise.all([gc("summary"), gc("issues")]);
    const issues = issuesRes.issues || [];
    $("#report-cluster").textContent = summary.cluster;
    $("#cp-cluster").textContent = summary.cluster;

    // control plane stat chips live in the control plane band, not the hero
    const el = $("#cp-stats");
    el.textContent = "";
    const chips = [
      { t: [summary.nodes.ready + "/" + summary.nodes.count, " nodes"], warn: summary.nodes.ready < summary.nodes.count },
      { t: [String(summary.pods.running), " pods"] },
      { t: [String(summary.pods.failed), " failed"], bad: summary.pods.failed > 0 },
      { t: [String(summary.restartsLastHour), " restarts · 1h"], warn: summary.restartsLastHour > 5 },
      { t: [String(issues.length), " issues"], bad: issues.length > 0 },
    ];
    for (const c of chips) {
      const chip = document.createElement("span");
      chip.className = "chip" + (c.bad ? " bad" : c.warn ? " warn" : "");
      const b = document.createElement("b");
      b.textContent = c.t[0];
      chip.appendChild(b);
      chip.appendChild(document.createTextNode(c.t[1]));
      el.appendChild(chip);
    }

    const util = summary.cpu.requestedCores > 0 ? summary.cpu.usedCores / summary.cpu.requestedCores : 0.15;
    drawTide(util);
    $("#cpu-sub").textContent = "of " + fmtCores(summary.cpu.requestedCores) + " requested · " + Math.round(util * 100) + "%";
    $("#mem-sub").textContent = "of " + fmtBytes(summary.memory.requestedBytes) + " requested";
    return { summary, issues };
  }

  // ---------- plane 3: control plane lineup ----------

  async function loadLineup() {
    const { workloads = [] } = await gc("workloads");
    const tb = $("#lineup tbody");
    tb.textContent = "";
    if (!workloads.length) {
      const tr = tb.insertRow();
      const td = tr.insertCell();
      td.colSpan = 7;
      td.className = "dim";
      td.textContent = "No traffic in the lineup yet — groundcover will see it the moment a request moves.";
      return;
    }
    for (const w of workloads) {
      const tr = tb.insertRow();
      const name = tr.insertCell();
      name.className = "wl-name";
      name.textContent = w.name;
      const ns = tr.insertCell();
      ns.className = "dim";
      ns.textContent = w.namespace;
      cell(tr, w.rps.toFixed(w.rps >= 10 ? 0 : 1), "num");
      const errClass = w.errorRatePct > 5 ? "bad" : w.errorRatePct > 1 ? "warn" : "ok";
      cell(tr, fmtPct(w.errorRatePct) + "%", "num " + errClass);
      cell(tr, fmtMs(w.p50Ms), "num");
      cell(tr, fmtMs(w.p95Ms), "num " + (w.p95Ms > 1000 ? "warn" : ""));
      cell(tr, String(w.restarts), "num " + (w.restarts > 0 ? "warn" : "dim"));
    }
  }

  function cell(tr, text, cls) {
    const td = tr.insertCell();
    if (cls) td.className = cls;
    td.textContent = text;
    return td;
  }

  // ---------- feeds ----------

  function feedItem(ts, sevClass, sevText, srcText, msgText) {
    const item = document.createElement("div");
    item.className = "feed-item";
    const t = document.createElement("span");
    t.className = "ts";
    t.textContent = timeAgo(ts);
    const sev = document.createElement("span");
    sev.className = "sev " + sevClass;
    sev.textContent = sevText;
    const body = document.createElement("span");
    body.className = "body";
    const src = document.createElement("span");
    src.className = "src";
    src.textContent = srcText;
    const msg = document.createElement("span");
    msg.className = "msg";
    msg.textContent = msgText;
    msg.title = msgText;
    body.append(src, msg);
    item.append(t, sev, body);
    return item;
  }

  function calm(el, text) {
    el.textContent = "";
    const d = document.createElement("div");
    d.className = "empty-calm";
    const b = document.createElement("b");
    b.textContent = "All clear. ";
    d.append(b, document.createTextNode(text));
    el.appendChild(d);
  }

  async function loadWipeouts(issues) {
    const { events = [] } = await gc("events?range=1h");
    const el = $("#wipeouts");
    el.textContent = "";
    let n = 0;
    for (const i of issues) {
      const sevClass = /crit|high|error/i.test(i.severity) ? "bad" : "warn";
      el.appendChild(feedItem(i.since || new Date().toISOString(), sevClass, i.severity || "issue",
        (i.namespace ? i.namespace + " · " : "") + i.entity, i.title));
      n++;
    }
    for (const e of events) {
      const sevClass = /error|fail/i.test(e.reason) ? "bad" : e.type === "Warning" ? "warn" : "info";
      el.appendChild(feedItem(e.ts, sevClass, e.reason, (e.namespace ? e.namespace + " · " : "") + e.entity, e.message));
      if (++n >= 40) break;
    }
    if (!n) calm(el, "No wipeouts on the books for the last hour.");
  }

  async function loadPatrol() {
    const { logs = [] } = await gc("logs?range=1h");
    const el = $("#patrol");
    el.textContent = "";
    if (!logs.length) {
      calm(el, "Nothing washing up in the error logs.");
      return;
    }
    for (const l of logs.slice(0, 40)) {
      const sevClass = /err|fatal/i.test(l.level) ? "bad" : "warn";
      el.appendChild(feedItem(l.ts, sevClass, l.level, (l.namespace ? l.namespace + " · " : "") + l.workload, l.body));
    }
  }

  // ---------- plane 1: kontract beaches & boards ----------

  const SAMPLE_ZONES = [
    { name: "north-point", display_name: "North Point", band: "large", status: { capacity_cpu: "30", capacity_memory: "60Gi", used_cpu: "11.2", used_memory: "22Gi" } },
    { name: "tide-pool", display_name: "Tide Pool", band: "small", status: { capacity_cpu: "8", capacity_memory: "16Gi", used_cpu: "2.1", used_memory: "5Gi" } },
  ];
  const SAMPLE_APPS = [
    { app_name: "reef-api", phase: "Live", zone_ref: "north-point", size: "m", status: { url: "https://reef-api.example.dev" } },
    { app_name: "swell-tracker", phase: "Live", zone_ref: "north-point", size: "s", status: { url: "https://swell.example.dev" } },
    { app_name: "board-rentals", phase: "Building", zone_ref: "tide-pool", size: "s", status: {} },
    { app_name: "surf-cam", phase: "Live", zone_ref: "tide-pool", size: "m", status: { url: "https://cam.example.dev" } },
    { app_name: "shark-alerts", phase: "Failed", zone_ref: "north-point", size: "s", status: { message: "image pull backoff: manifest unknown" } },
  ];
  // What Zone Waters looks like once agents reach the zone clusters — shown in
  // the standalone demo only, and labeled as demo.
  const SAMPLE_ZONE_WATERS = [
    { name: "reef-api", namespace: "kontract-demo-north-point", zone: "north-point", cluster: "k-demo", cpuCores: 0.31, memBytes: 402653184, rps: 42.7, errorRatePct: 0.2, p50Ms: 4, p95Ms: 38, restarts: 0 },
    { name: "swell-tracker", namespace: "kontract-demo-north-point", zone: "north-point", cluster: "k-demo", cpuCores: 0.12, memBytes: 197132288, rps: 8.1, errorRatePct: 0, p50Ms: 2, p95Ms: 12, restarts: 0 },
    { name: "surf-cam", namespace: "kontract-demo-tide-pool", zone: "tide-pool", cluster: "k-demo", cpuCores: 0.55, memBytes: 645922816, rps: 17.3, errorRatePct: 1.4, p50Ms: 11, p95Ms: 140, restarts: 1 },
  ];

  function parseQty(q) {
    if (q == null) return NaN;
    const s = String(q);
    const m = s.match(/^([\d.]+)\s*(Ki|Mi|Gi|Ti|m)?/);
    if (!m) return NaN;
    let v = parseFloat(m[1]);
    const mult = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, m: 0.001 };
    if (m[2]) v *= mult[m[2]];
    return v;
  }

  function renderZones(zones) {
    const el = $("#beaches");
    el.textContent = "";
    for (const z of zones) {
      const card = document.createElement("div");
      card.className = "panel beach";
      const h = document.createElement("h3");
      h.textContent = z.display_name || z.name;
      const band = document.createElement("span");
      band.className = "band";
      band.textContent = z.band || "zone";
      h.appendChild(band);
      card.appendChild(h);
      const st = z.status || {};
      card.appendChild(capBar("cpu", parseQty(st.used_cpu), parseQty(st.capacity_cpu), fmtCores));
      card.appendChild(capBar("memory", parseQty(st.used_memory), parseQty(st.capacity_memory), fmtBytes));
      el.appendChild(card);
    }
  }

  function capBar(label, used, cap, fmt) {
    const wrapEl = document.createElement("div");
    wrapEl.className = "cap";
    const lbl = document.createElement("div");
    lbl.className = "lbl";
    const l = document.createElement("span");
    l.textContent = label;
    const r = document.createElement("span");
    const pct = cap > 0 && isFinite(used) ? Math.min(100, (used / cap) * 100) : 0;
    r.textContent = isFinite(used) && isFinite(cap) ? fmt(used) + " / " + fmt(cap) + " · " + Math.round(pct) + "%" : "–";
    lbl.append(l, r);
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("i");
    fill.style.width = pct + "%";
    bar.appendChild(fill);
    wrapEl.append(lbl, bar);
    return wrapEl;
  }

  // matchZoneWorkload finds the measured zone workload for a kontract app:
  // namespace must end in -<zone_ref> and workload/app names must overlap.
  function matchZoneWorkload(app, zoneWorkloads) {
    return zoneWorkloads.find((zw) =>
      app.zone_ref && zw.namespace.endsWith("-" + app.zone_ref) &&
      (zw.name.includes(app.app_name) || app.app_name.includes(zw.name)));
  }

  function renderApps(apps, zoneWorkloads) {
    const tb = $("#boards tbody");
    tb.textContent = "";
    for (const a of apps) {
      const [word, cls] = PHASE_WORDS[a.phase] || [a.phase || "–", "busy"];
      const tr = tb.insertRow();
      const st = tr.insertCell();
      const span = document.createElement("span");
      span.className = "phase " + cls;
      span.textContent = word;
      st.appendChild(span);
      cell(tr, a.app_name, "wl-name");
      cell(tr, a.zone_ref || "–", "dim");
      cell(tr, (a.size || "–") + (a.replicas ? " · " + a.replicas + "×" : ""), "num dim");
      const brk = tr.insertCell();
      const url = a.status && a.status.url;
      if (url && /^https?:\/\//.test(url)) {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = url.replace(/^https?:\/\//, "");
        brk.appendChild(link);
      } else if (a.phase === "Failed" && a.status && a.status.message) {
        // a wiped-out board must say why, right here (spec rule 6)
        brk.className = "bad";
        brk.style.whiteSpace = "normal";
        brk.textContent = a.status.message;
        brk.title = a.status.message;
      } else {
        brk.className = "dim";
        brk.textContent = "–";
      }

      // measured columns — groundcover, joined by zone namespace + name
      const zw = matchZoneWorkload(a, zoneWorkloads);
      if (zw) {
        cell(tr, fmtCores(zw.cpuCores), "num");
        cell(tr, zw.rps.toFixed(zw.rps >= 10 ? 0 : 1), "num");
        const errClass = zw.errorRatePct > 5 ? "bad" : zw.errorRatePct > 1 ? "warn" : "ok";
        cell(tr, fmtPct(zw.errorRatePct) + "%", "num " + errClass);
      } else {
        cell(tr, "–", "num dim");
        cell(tr, "–", "num dim");
        cell(tr, "–", "num dim");
      }

      // ship moment: a board that was paddling out is now riding
      const prev = state.lastPhases.get(a.app_name);
      if (prev && prev !== "Live" && a.phase === "Live" && !state.shipMomentShown) {
        shipMoment(a.app_name);
      }
      state.lastPhases.set(a.app_name, a.phase);
    }
  }

  function shipMoment(name) {
    state.shipMomentShown = true;
    $("#ship-title").textContent = name + " is riding!";
    const el = $("#ship-moment");
    el.hidden = false;
    const close = () => { el.hidden = true; clearTimeout(t); };
    const t = setTimeout(close, 5000);
    el.addEventListener("click", close, { once: true });
    setTimeout(() => { state.shipMomentShown = false; }, 30000);
  }

  async function loadKontract() {
    const modeEl = $("#kontract-mode");
    if (!kontract.isLaunched()) {
      modeEl.textContent = "demo tide pool — launch from Konstruct for your org";
      renderZones(SAMPLE_ZONES);
      return { apps: SAMPLE_APPS, demo: true };
    }
    const org = new URLSearchParams(location.search).get("org") || "";
    try {
      // discover first — render only what the platform declares (spec rule 5)
      const disco = await kontract.discover(org);
      const caps = (disco && disco.capabilities) || [];
      const wantZones = !caps.length || caps.includes("zones");
      const [zones, apps] = await Promise.all([
        wantZones ? kontract.zones(org) : Promise.resolve([]),
        kontract.apps(org),
      ]);
      modeEl.textContent = "org · " + org;
      renderZones(Array.isArray(zones) ? zones : []);
      return { apps: Array.isArray(apps) ? apps : [], demo: false };
    } catch (err) {
      modeEl.textContent = "kontract unavailable — showing demo tide pool";
      renderZones(SAMPLE_ZONES);
      return { apps: SAMPLE_APPS, demo: true };
    }
  }

  // ---------- plane 2: zone waters ----------

  async function loadZoneWaters(demo) {
    const el = $("#zone-waters");
    let data = { agentCoverage: false, workloads: [] };
    try {
      data = await gc("zone-workloads");
    } catch (err) {
      // fall through to the no-coverage state
    }

    // Standalone demo: show what this panel becomes once agents reach the
    // zone clusters, clearly labeled.
    if (demo && !data.agentCoverage) {
      renderZoneWatersTable(el, SAMPLE_ZONE_WATERS, true);
      return SAMPLE_ZONE_WATERS;
    }

    if (!data.agentCoverage) {
      el.textContent = "";
      const d = document.createElement("div");
      d.className = "empty-calm";
      const b = document.createElement("b");
      b.textContent = "No groundcover agent in these waters yet. ";
      d.append(b, document.createTextNode(
        "Your boards run on shared-pool zone clusters that don't report to groundcover so far — " +
        "once an agent is installed there, this panel fills in on its own. Spec-side status above stays accurate either way."));
      el.appendChild(d);
      return [];
    }

    renderZoneWatersTable(el, data.workloads, false);
    return data.workloads;
  }

  function renderZoneWatersTable(el, workloads, demo) {
    el.textContent = "";
    if (demo) {
      const note = document.createElement("p");
      note.className = "tbl-note";
      note.textContent = "demo data — this is what zone waters look like once your zone clusters report to groundcover";
      el.appendChild(note);
    }
    const table = document.createElement("table");
    table.className = "tbl";
    const thead = table.createTHead();
    const hr = thead.insertRow();
    for (const h of ["zone", "workload", "cpu", "memory", "req/s", "errors", "p95", "restarts"]) {
      const th = document.createElement("th");
      th.textContent = h;
      if (h !== "zone" && h !== "workload") th.className = "num";
      hr.appendChild(th);
    }
    const tb = table.createTBody();
    let lastZone = null;
    for (const w of workloads) {
      const tr = tb.insertRow();
      const zoneCell = tr.insertCell();
      if (w.zone !== lastZone) {
        zoneCell.textContent = w.zone || "?";
        zoneCell.className = "wl-name";
        lastZone = w.zone;
      } else {
        zoneCell.textContent = "";
      }
      cell(tr, w.name, "wl-name");
      cell(tr, fmtCores(w.cpuCores), "num");
      cell(tr, fmtBytes(w.memBytes), "num");
      cell(tr, w.rps.toFixed(w.rps >= 10 ? 0 : 1), "num");
      const errClass = w.errorRatePct > 5 ? "bad" : w.errorRatePct > 1 ? "warn" : "ok";
      cell(tr, fmtPct(w.errorRatePct) + "%", "num " + errClass);
      cell(tr, fmtMs(w.p95Ms), "num " + (w.p95Ms > 1000 ? "warn" : ""));
      cell(tr, String(w.restarts), "num " + (w.restarts > 0 ? "warn" : "dim"));
    }
    el.appendChild(table);
  }

  // ---------- orchestration ----------

  async function refresh() {
    // Plane 1 first — the user's boards lead the page.
    const k = await loadKontract();
    const zoneWorkloads = await loadZoneWaters(k.demo);
    renderApps(k.apps, zoneWorkloads);
    setBoardConditions(k.apps);

    // Plane 3 — control plane telemetry.
    try {
      const { issues } = await loadSummary();
      await Promise.all([loadSeries(), loadLineup(), loadWipeouts(issues), loadPatrol()]);
    } catch (err) {
      $("#report-sub").textContent = "Lost sight of the control plane: " + err.message;
    }
  }

  async function init() {
    plantGrass();
    drawTide(0.15);
    try {
      state.mode = await gc("mode");
      const badge = $("#mode-badge");
      if (state.mode.live) {
        badge.textContent = "● live · " + state.mode.cluster;
        badge.classList.add("live");
      } else {
        badge.textContent = "○ sample tide · demo data";
        badge.classList.add("sample");
      }
    } catch {
      $("#mode-badge").textContent = "backend unreachable";
    }
    wireDeeplinks();

    $("#range-picker").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-range]");
      if (!btn) return;
      state.range = btn.dataset.range;
      document.querySelectorAll("#range-picker button").forEach((b) => b.classList.toggle("on", b === btn));
      loadSeries().catch(() => {});
    });

    await refresh();
    setInterval(refresh, 30000);
  }

  init();
})();
