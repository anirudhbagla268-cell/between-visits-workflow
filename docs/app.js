/* Between Visits · Clinic Reach-Out Agent · operator view.
   Reads the masked JSON snapshot in data/ (written by `python -m infra run`) and asks the public GitHub API
   whether a run is in progress right now. Everything from JSON goes in with textContent. */
(function () {
  "use strict";

  const REPO = "https://github.com/UmaSanskriti/between-visits-workflow";
  const API_RUNS = "https://api.github.com/repos/UmaSanskriti/between-visits-workflow/actions/workflows/pipeline.yml/runs?per_page=1";
  const FILES = ["run", "summary", "contacts", "call_attempts", "scripts", "transcripts", "interviews", "gate_decisions", "errors", "dlq", "alerts", "runs", "audit_log"];
  const ICON = { good: "✓", warning: "!", serious: "▲", critical: "✕", neutral: "·" };
  const TZ = "America/New_York";
  const LOCAL = "http://127.0.0.1:8787";
  const LIVE_VIEW = new URLSearchParams(location.search).get("source") === "live";
  const SRC = LIVE_VIEW ? LOCAL + "/data-live/" : "data/";
  // An https page may call the loopback service only when the fetch opts in (Chrome private network access).
  function localFetch(url, opts) {
    opts = Object.assign({ cache: "no-store", targetAddressSpace: "loopback" }, opts || {});
    if (!opts.signal) { const ctl = new AbortController(); setTimeout(() => ctl.abort(), 4000); opts.signal = ctl.signal; }
    return fetch(url, opts);
  }
  const LOCAL_CONSOLE = LOCAL + "/?source=live";

  // ---------- helpers ----------
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v; else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v); else node.setAttribute(k, v);
    }
    (children || []).forEach((c) => { if (c != null) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return node;
  }
  const $ = (id) => document.getElementById(id);
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function status(kind, label) { return el("span", { class: "status " + kind }, [el("span", { text: ICON[kind] || "" }), label]); }
  function pill(kind, label) { return el("span", { class: "pill " + kind, text: label }); }
  function table(headers, rows, opts) {
    opts = opts || {};
    if (!rows.length) return el("div", { class: "empty", text: opts.empty || "Nothing." });
    const thead = el("thead", null, [el("tr", null, headers.map((h, i) => el("th", { class: (opts.num || []).includes(i) ? "num" : "" }, [h])))]);
    const tbody = el("tbody", null, rows.map((r) => el("tr", null, r.map((cell, i) => {
      const td = el("td", { class: ((opts.num || []).includes(i) ? "num " : "") + ((opts.mono || []).includes(i) ? "mono " : "") + ((opts.nowrap || []).includes(i) ? "nowrap" : "") });
      if (cell instanceof Node) td.appendChild(cell); else td.textContent = cell == null ? "" : String(cell);
      return td;
    }))));
    return el("table", null, [thead, tbody]);
  }
  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso); if (isNaN(d)) return iso;
    return d.toLocaleString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";
  }
  function ago(iso) {
    if (!iso) return "";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 90) return Math.round(s) + "s ago";
    if (s < 5400) return Math.round(s / 60) + " min ago";
    if (s < 172800) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " days ago";
  }
  function dayKey(iso) { return iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ }) : ""; }
  function pct(x) { return x == null || isNaN(x) ? "–" : Math.round(x * 100) + "%"; }
  function nice(s) { return String(s || "").replace(/_/g, " ").toLowerCase(); }
  // The pipeline still records outcomes under call-era keys. The UI shows them in email terms.
  const OUTCOME_LABEL = { NO_ANSWER: "no reply yet", VOICEMAIL: "no reply yet", CALLBACK_REQUESTED: "asked to follow up later", GATEKEEPER_BLOCKED: "screened by front desk", WRONG_NUMBER: "wrong address", DECLINED_RECORDING: "declined being recorded", FAILED_TECHNICAL: "send failed" };
  const CATEGORY_LABEL = { "No answer / voicemail": "No reply", "Call back later": "Follow up later", "Hung up at AI disclosure": "Objected to AI disclosure", "Wrong number (list data)": "Wrong address (list data)" };
  const outcomeText = (o) => OUTCOME_LABEL[o] || nice(o);
  const categoryText = (c) => CATEGORY_LABEL[c] || c;
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

  const tip = $("tooltip");
  function showTip(evt, label, value) {
    clear(tip); tip.appendChild(el("div", null, [el("span", { class: "k" }), el("b", { text: String(value) }), " ", el("span", { class: "muted", text: label })]));
    tip.style.display = "block"; moveTip(evt);
  }
  function moveTip(evt) {
    const r = evt.target && evt.target.getBoundingClientRect ? evt.target.getBoundingClientRect() : { right: 0, top: 0 };
    const x = evt.clientX != null ? evt.clientX : r.right, y = evt.clientY != null ? evt.clientY : r.top;
    tip.style.left = Math.min(x + 12, window.innerWidth - tip.offsetWidth - 8) + "px"; tip.style.top = Math.max(8, y - tip.offsetHeight - 10) + "px";
  }
  function hideTip() { tip.style.display = "none"; }
  function bars(container, items, title) {
    clear(container);
    if (title) { container.appendChild(el("div", { class: "lbl", text: "" })); container.appendChild(el("div", { class: "small muted", text: title })); }
    const max = Math.max(1, ...items.map((i) => i.count));
    items.forEach((item) => {
      container.appendChild(el("div", { class: "lbl", text: item.label, title: item.label }));
      const bar = el("div", { class: "bar", tabindex: "0", role: "img", "aria-label": item.label + ": " + item.count });
      bar.style.width = Math.max(0.4, (item.count / max) * 100) + "%";
      const over = (e) => showTip(e, item.label, item.count);
      bar.addEventListener("pointerenter", over); bar.addEventListener("pointermove", moveTip); bar.addEventListener("pointerleave", hideTip);
      bar.addEventListener("focus", over); bar.addEventListener("blur", hideTip);
      container.appendChild(el("div", { class: "track" }, [bar, el("span", { class: "val", text: String(item.count) })]));
    });
    if (!items.length) container.appendChild(el("div", { class: "empty", text: "No data yet." }));
  }

  // ---------- theme ----------
  const themeBtn = $("theme"), THEMES = ["system", "light", "dark"];
  function applyTheme(t) {
    if (t === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t);
    themeBtn.textContent = "Theme: " + t;
    try { localStorage.setItem("bv-theme", t); } catch (e) { /* private mode */ }
  }
  let theme = "system";
  try { theme = localStorage.getItem("bv-theme") || "system"; } catch (e) { /* ignore */ }
  applyTheme(theme);
  themeBtn.addEventListener("click", () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; applyTheme(theme); });

  // ---------- load ----------
  async function loadAll() {
    const stamp = Date.now(), out = {};
    await Promise.all(FILES.map(async (name) => {
      try { const res = await (LIVE_VIEW ? localFetch : fetch)(SRC + name + ".json?t=" + stamp, { cache: "no-store" }); out[name] = res.ok ? await res.json() : null; }
      catch (e) { out[name] = null; }
    }));
    return out;
  }
  async function loadLiveRun() {
    try {
      const res = await fetch(API_RUNS, { headers: { Accept: "application/vnd.github+json" } });
      if (!res.ok) return null;
      const data = await res.json();
      return (data.workflow_runs || [])[0] || null;
    } catch (e) { return null; }
  }

  // ---------- per-contact helpers ----------
  function contactTone(c) {
    switch (c.status) {
      case "BOOKED": return ["good", "Booked"];
      case "IN_OUTREACH": return ["brand", "In outreach"];
      case "READY": return ["neutral", "Queued"];
      case "SUPPRESSED": return ["critical", "Do not contact"];
      case "UNREACHABLE": return ["warning", "Unreachable"];
      case "DECLINED": return ["neutral", c.last_outcome === "NOT_A_FIT" ? "Not a fit" : c.last_outcome === "DECLINED_RECORDING" ? "Declined being recorded" : "Declined"];
      default: return ["warning", "Needs review"];
    }
  }
  function nextStep(c, interview, gate) {
    if (c.status === "BOOKED" && interview) {
      const when = fmtTime(interview.scheduled_for);
      const lead = interview.scheduled_for ? when + ", " : "Agreed to talk; Anirudh reaches out" + (interview.contact_method && interview.contact_method !== "unknown" ? " via " + nice(interview.contact_method) : "") + ", ";
      return interview.status === "approved" ? ["good", lead + "approved by " + interview.approved_by] : ["warning", lead + "waiting for approval"];
    }
    if (c.status === "IN_OUTREACH") return ["brand", c.next_attempt_at ? "Follow up " + fmtTime(c.next_attempt_at) + (c.last_outcome === "CALLBACK_REQUESTED" ? " (asked to be contacted later)" : "") : "Email in progress"];
    if (c.status === "READY") return ["neutral", gate && !gate.allowed ? (gate.deferred ? "Waiting: " + gate.reasons.map(nice).join(", ") : "Blocked: " + gate.reasons.map(nice).join(", ")) : "Send when the window opens"];
    if (c.status === "SUPPRESSED") return ["critical", "Never contact again"];
    if (c.status === "UNREACHABLE") return ["warning", "No more attempts (cap reached)"];
    if (c.status === "DECLINED") return ["neutral", c.last_outcome === "NOT_A_FIT" ? "Closed: not a fit" : "Closed"];
    if (c.duplicate_of) return ["warning", "Possible duplicate, review and merge"];
    if (c.verification_reason) return ["warning", "Cannot email: " + nice(c.verification_reason)];
    return ["neutral", "Awaiting verification"];
  }

  // ---------- render ----------
  function render(d, live) {
    const run = d.run || {}, s = d.summary || {};
    const contacts = d.contacts || [], attempts = d.call_attempts || [], transcripts = d.transcripts || [];
    const interviews = d.interviews || [], errors = d.errors || [], alerts = d.alerts || [], dlq = d.dlq || [];
    const decisions = d.gate_decisions || [], scripts = d.scripts || [];
    const byId = Object.fromEntries(contacts.map((c) => [c.id, c]));
    const attemptById = Object.fromEntries(attempts.map((a) => [a.id, a]));
    const transcriptById = Object.fromEntries(transcripts.map((t) => [t.id, t]));
    const name = (cid) => { const c = byId[cid]; return c ? (c.full_name || "(no name)") + (c.external_id ? " · " + c.external_id : "") : cid; };
    const calls = s.calls || {}, tr = s.transcripts || {}, comp = s.compliance || {};
    const st = run.stages || {}, cl = st.calls || {}, wh = st.webhooks || {}, dv = st.delivery || {}, ing = st.ingest || {};
    const lastRun = run.run_id;
    const runAttempts = attempts.filter((a) => a.run_id === lastRun);
    const runBooked = runAttempts.filter((a) => a.outcome === "BOOKED").length;
    const runCategorised = runAttempts.filter((a) => a.failure_category).length;
    const queue = s.queue || [];
    const inProgress = attempts.filter((a) => !a.outcome).length;
    const pendingApproval = interviews.filter((i) => i.status === "draft_pending_approval").length;
    const retries = contacts.filter((c) => c.status === "IN_OUTREACH" && c.next_attempt_at).length;
    const pendingDelivery = transcripts.filter((t) => t.delivery_status === "pending").length;

    // header chips
    const chips = clear($("run-chips"));
    if (run.mode === "live") chips.appendChild(el("span", { class: "chip critical", title: "Real outreach to allowlisted team contacts only." }, [el("span", { class: "dot" }), el("b", { text: "LIVE" })]));
    else chips.appendChild(el("span", { class: "chip mode", title: "No real emails are sent; the email sender and the Brain are stand-ins and every practice is fictional." }, [el("b", { text: "DRY RUN" })]));
    chips.appendChild(el("a", { class: "chip", href: LIVE_VIEW ? "./" : "?source=live", text: LIVE_VIEW ? "← Dry-run data" : "Live demo data →" }));
    chips.appendChild(el("span", { class: "chip" }, ["Snapshot ", el("b", { text: run.finished_at ? fmtTime(run.finished_at) : "never" })]));
    if (run.simulated_time) chips.appendChild(el("span", { class: "chip warning" }, [el("span", { class: "dot" }), "simulated clock ", el("b", { text: fmtTime(run.now_used) })]));
    chips.appendChild(el("span", { class: "chip " + (run.kill_switch ? "critical" : "good") }, [el("span", { class: "dot" }), "Kill switch ", el("b", { text: run.kill_switch ? "ON" : "off" })]));
    if (run.paused) chips.appendChild(el("span", { class: "chip warning" }, [el("span", { class: "dot" }), "Sending paused"]));
    if (run.brain_down) chips.appendChild(el("span", { class: "chip serious" }, [el("span", { class: "dot" }), "Brain simulated down"]));
    if (run.callback_number_set === false) chips.appendChild(el("span", { class: "chip critical" }, [el("span", { class: "dot" }), "Reply contact not set"]));
    if (run.git_sha) chips.appendChild(el("span", { class: "chip" }, [el("a", { href: REPO + "/commit/" + run.git_sha, text: run.git_sha, target: "_blank", rel: "noopener" })]));

    // ---------- the loop ----------
    const stages = [
      { key: "list", title: "Approved list", now: contacts.length, nowLabel: "practices", last: "Loaded " + (ing.rows ?? contacts.length) + " practices, " + ((s.contacts || {}).verified ?? 0) + " verified" },
      { key: "gate", title: "Gate check", now: queue.length, nowLabel: "waiting", last: "Gate: " + (cl.allowed ?? 0) + " allowed, " + (cl.blocked ?? 0) + " blocked, " + (cl.deferred ?? 0) + " deferred" },
      { key: "call", title: "Draft + send", now: inProgress, nowLabel: "in progress", last: "Sent " + plural(cl.placed ?? 0, "email") + (cl.script_errors ? ", " + cl.script_errors + " blocked by draft checks" : "") },
      { key: "log", title: "Outcome logged", now: pendingDelivery, nowLabel: "to deliver", last: "Logged " + (wh.applied ?? 0) + " outcomes, delivered " + (dv.delivered ?? 0) + " replies" + (dv.held ? ", " + dv.held + " held" : "") + (dv.failed ? ", " + dv.failed + " failed" : "") },
      { key: "book", title: "Booked → invite", now: pendingApproval, nowLabel: "to approve", last: runBooked + " booked, invites drafted for approval", cls: "decision" },
      { key: "review", title: "Review → follow up", now: retries, nowLabel: "follow-ups set", last: runCategorised + " emails categorised, follow-ups scheduled" },
    ];
    const nodesHost = clear($("nodes")), listHost = clear($("nodes-list"));
    const nodeEls = [];
    // direction arrows between nodes, clockwise around the ring (r=190 around 260,260 in the 520 viewBox)
    const arcs = clear(document.getElementById("arcs"));
    for (let i = 0; i < stages.length; i++) {
      const a1 = (-90 + i * 60 + 24) * Math.PI / 180, a2 = (-90 + (i + 1) * 60 - 24) * Math.PI / 180;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M " + (260 + 190 * Math.cos(a1)).toFixed(1) + " " + (260 + 190 * Math.sin(a1)).toFixed(1) + " A 190 190 0 0 1 " + (260 + 190 * Math.cos(a2)).toFixed(1) + " " + (260 + 190 * Math.sin(a2)).toFixed(1));
      path.setAttribute("class", "arc"); path.setAttribute("marker-end", "url(#arrow)");
      arcs.appendChild(path);
    }
    stages.forEach((sg, i) => {
      const angle = (-90 + i * 60) * Math.PI / 180;
      const node = el("div", { class: "node " + (sg.cls || ""), "data-key": sg.key }, [
        el("div", { class: "t", text: sg.title }),
        el("div", { class: "c" }, [String(sg.now), el("small", { text: sg.nowLabel })]),
        el("div", { class: "d", text: "now" }),
      ]);
      node.style.left = (50 + 36.5 * Math.cos(angle)) + "%";
      node.style.top = (50 + 36.5 * Math.sin(angle)) + "%";
      nodesHost.appendChild(node); nodeEls.push(node);
      listHost.appendChild(el("div", { class: "node " + (sg.cls || "") }, [el("div", { class: "t", text: sg.title }), el("div", { class: "c" }, [String(sg.now), el("small", { text: sg.nowLabel + " now" })])]));
    });

    // live state
    const running = live && (live.status === "in_progress" || live.status === "queued");
    const ring = $("ring"), stateEl = $("state"), liveDot = $("live");
    ring.classList.toggle("running", !!running);
    clear(stateEl); stateEl.className = "state" + (running ? " running" : "");
    stateEl.appendChild(liveDot); liveDot.className = "live" + (running ? " on" : "");
    stateEl.appendChild(document.createTextNode(running ? "Running" : "Idle"));
    const newer = live && live.status === "completed" && run.finished_at && new Date(live.updated_at) - new Date(run.finished_at) > 90000;
    $("since").textContent = running ? "started " + ago(live.run_started_at || live.created_at) + " · " + nice(live.event) : (newer ? "a newer run finished " + ago(live.updated_at) + "; this snapshot is publishing" : "last run " + ago(run.finished_at));

    const nowEl = clear($("now"));
    if (running) {
      nowEl.appendChild(el("span", null, [el("b", { text: "Working through the loop now. " }), el("a", { href: live.html_url, text: "Watch the run", target: "_blank", rel: "noopener" })]));
    } else {
      const due = queue.filter((q) => q.next_attempt_at).sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at))[0];
      const windowWait = queue.filter((q) => !q.next_attempt_at).length;
      if (due) nowEl.appendChild(el("div", null, [el("b", { text: "Next email: " }), due.name + " " + fmtTime(due.next_attempt_at) + (new Date(due.next_attempt_at) < Date.now() ? " (due, waits for the next run)" : "")]));
      else if (windowWait) nowEl.appendChild(el("div", null, [el("b", { text: "Next: " }), plural(windowWait, "practice") + " waiting for the send window (Mon–Fri 9–5 ET)"]));
      else nowEl.appendChild(el("div", null, [el("b", { text: "Nothing queued. " }), "Approve a new batch to continue."]));
      if (pendingApproval) nowEl.appendChild(el("div", null, [el("b", { text: "Waiting on you: " }), plural(pendingApproval, "invite") + " to approve"]));
      if (dlq.length) nowEl.appendChild(el("div", null, [el("b", { text: "Needs a redrive: " }), plural(dlq.length, "reply", "replies") + " dead-lettered"]));
    }

    // last-run feed + replay
    const feed = clear($("feed"));
    const labels = ["load", "gate", "send", "log", "book", "review"];
    stages.forEach((sg, i) => feed.appendChild(el("li", { "data-i": String(i) }, [el("span", { class: "w", text: labels[i] }), el("span", { class: "x", text: sg.last })])));
    $("feed-note").textContent = "Last run " + fmtTime(run.started_at) + (run.trigger ? " · " + nice(run.trigger) : "");
    let timer = null;
    const restingIndex = running ? -1 : (pendingApproval ? 4 : queue.length ? 1 : 0);
    function settle() {
      nodeEls.forEach((n, i) => { n.classList.remove("active"); n.classList.toggle("pulse", !running && i === restingIndex); });
      feed.querySelectorAll("li").forEach((li) => li.classList.remove("now"));
    }
    function replay() {
      if (timer) clearInterval(timer);
      let i = 0; settle(); nodeEls.forEach((n) => n.classList.remove("pulse"));
      timer = setInterval(() => {
        nodeEls.forEach((n, k) => n.classList.toggle("active", k === i));
        feed.querySelectorAll("li").forEach((li, k) => li.classList.toggle("now", k === i));
        i += 1;
        if (i >= stages.length) { clearInterval(timer); timer = null; setTimeout(settle, 900); }
      }, 750);
    }
    $("replay").addEventListener("click", replay);
    if (running) {
      let k = 0;
      timer = setInterval(() => { nodeEls.forEach((n, i) => n.classList.toggle("active", i === k)); k = (k + 1) % stages.length; }, 900);
    } else { replay(); }

    // ---------- KPIs ----------
    const kp = clear($("kpis"));
    const tile = (label, value, kind, note) => kp.appendChild(el("div", { class: "tile" }, [el("div", { class: "label", text: label }), el("div", { class: "value", text: value }), el("div", { class: "note " + (kind || "") }, kind && kind !== "plain" ? [el("span", { text: ICON[kind] }), note] : [note || ""])]));
    const today = dayKey(run.now_used || run.finished_at);
    const todaySent = attempts.filter((a) => dayKey(a.started_at) === today).length;
    const cap = (run.limits && run.limits.max_calls_per_day) || 10;
    tile("Booked", contacts.filter((c) => c.status === "BOOKED").length, pendingApproval ? "warning" : "good", pendingApproval ? pendingApproval + " awaiting approval" : "all approved");
    tile("In queue", queue.length, "plain", retries + " follow-ups scheduled");
    tile("Emails " + (run.simulated_time ? "that day" : "today"), todaySent + " / " + cap, todaySent >= cap ? "warning" : "plain", todaySent >= cap ? "daily cap reached" : "daily cap");
    tile("Replies to Brain", tr.delivery_rate == null ? "–" : pct(tr.delivery_rate), tr.held_pii_review ? "warning" : "plain", (tr.delivered || 0) + "/" + ((tr.total || 0) - (tr.held_pii_review || 0)) + (tr.held_pii_review ? ", " + tr.held_pii_review + " held" : ""));
    tile("Gate escapes", comp.gate_escapes || 0, (comp.gate_escapes || 0) === 0 ? "good" : "critical", (comp.gate_escapes || 0) === 0 ? "none" : "sends past a failed gate");
    tile("Dead letters", dlq.length, dlq.length === 0 ? "good" : "serious", dlq.length === 0 ? "queue empty" : "run redrive");
    tile("Errors / alerts", (s.errors || 0) + " / " + (s.alerts || 0), (s.alerts || 0) ? "warning" : "plain", "see the cards");

    // ---------- practice cards ----------
    const latestGate = {};
    decisions.forEach((g) => { if (!latestGate[g.contact_id] || g.run_id >= latestGate[g.contact_id].run_id) latestGate[g.contact_id] = g; });
    const errorsFor = (c) => errors.filter((e) => e.contact_id === c.id || (e.call_id && attemptById[e.call_id] && attemptById[e.call_id].contact_id === c.id));
    const alertsFor = (c) => alerts.filter((a) => a.contact_id === c.id || (a.call_attempt_id && attemptById[a.call_attempt_id] && attemptById[a.call_attempt_id].contact_id === c.id) || (a.transcript_id && transcriptById[a.transcript_id] && transcriptById[a.transcript_id].contact_id === c.id));
    const dlqFor = (c) => dlq.filter((x) => transcriptById[x.transcript_id] && transcriptById[x.transcript_id].contact_id === c.id);
    const order = { BOOKED: 0, IN_OUTREACH: 1, READY: 2, VERIFIED: 3, SOURCED: 3, NEW: 3, UNREACHABLE: 4, DECLINED: 5, SUPPRESSED: 6 };
    const sorted = contacts.slice().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (a.full_name || "zz").localeCompare(b.full_name || "zz"));
    const views = sorted.map((c) => {
      const mine = attempts.filter((a) => a.contact_id === c.id).sort((a, b) => a.attempt_number - b.attempt_number);
      const interview = interviews.find((i) => i.contact_id === c.id);
      const errs = errorsFor(c), als = alertsFor(c), dl = dlqFor(c);
      const held = mine.some((a) => { const t = transcriptById[a.transcript_id]; return t && (t.delivery_status === "held_pii_review" || t.delivery_status === "failed"); });
      const attention = errs.length > 0 || als.length > 0 || dl.length > 0 || held || (interview && interview.status === "draft_pending_approval") || ["VERIFIED", "SOURCED", "NEW"].includes(c.status);
      return { c, mine, interview, errs, als, dl, attention, gate: latestGate[c.id] };
    });

    function cardFor(v) {
      const c = v.c, [tone, label] = contactTone(c);
      const card = el("article", { class: "pcard", "data-tone": tone });
      card.appendChild(el("div", { class: "ph" }, [
        el("div", null, [el("h3", { text: c.full_name || "(name missing)" }), el("div", { class: "practice", text: c.practice_name || "(practice missing)" }), el("div", { class: "ext", text: (c.external_id ? c.external_id + " · " : "") + c.id })]),
        pill(tone === "neutral" ? "" : tone, label)]));
      const [nk, ntext] = nextStep(c, v.interview, v.gate);
      card.appendChild(el("div", { class: "next " + (nk === "brand" || nk === "neutral" ? "" : nk) }, [el("b", { text: "Next: " }), ntext]));

      const sec = el("div", { class: "sec" }, [el("h4", null, ["Email attempts", el("span", { text: v.mine.length ? plural(v.mine.length, "attempt") : "none yet" })])]);
      if (!v.mine.length) sec.appendChild(el("div", { class: "muted small", text: v.gate && !v.gate.allowed ? "Gate: " + v.gate.reasons.map(nice).join("; ") : "No email sent yet." }));
      v.mine.forEach((a) => {
        const t = transcriptById[a.transcript_id];
        const tStatus = !t ? (a.outcome_reason && a.outcome_reason.includes("malformed") ? status("critical", "reply malformed") : status("neutral", "no reply logged")) : t.delivery_status === "delivered" ? status("good", "reply delivered") : t.delivery_status === "held_pii_review" ? status("warning", "reply held for review") : t.delivery_status === "failed" ? status("critical", "reply delivery failed") : status("neutral", "reply " + nice(t.delivery_status));
        const sc = scripts.find((x) => x.call_id === a.id);
        const line = el("div", { class: "line" }, [
          el("div", null, [el("b", { text: outcomeText(a.outcome) || "in progress" }), " ", el("span", { class: "when", text: fmtTime(a.started_at) + (a.duration_sec ? " · " + a.duration_sec + "s" : "") + " · script " + a.script_version })]),
          el("div", { class: "tags" }, [a.failure_category ? el("span", { class: "cat", text: categoryText(a.failure_category) }) : null, tStatus]),
        ]);
        if (a.outcome_reason) line.appendChild(el("div", { class: "muted small", text: a.outcome_reason }));
        if (a.callback_requested_at) line.appendChild(el("div", { class: "muted small", text: "Follow-up requested for " + fmtTime(a.callback_requested_at) }));
        if (a.provider === "vapi") line.appendChild(el("div", { class: "muted small" }, ["Vapi: " + (a.provider_ended_reason || "") + (a.cost_usd ? " · $" + a.cost_usd.toFixed(2) : ""), a.recording_ref && a.recording_ref.startsWith("http") ? [" · ", el("a", { href: a.recording_ref, text: "recording", target: "_blank", rel: "noopener" })] : null].flat().filter(Boolean)));
        if (t && t.utterances && t.utterances.length) line.appendChild(el("details", null, [el("summary", { text: "Thread, " + plural(t.utterances.length, "message") + (t.pii_flagged ? " · flagged: " + t.pii_reason : "") }), el("ul", { class: "utter" }, t.utterances.map((u) => el("li", { class: u.speaker }, [el("b", { text: u.speaker }), u.text])))]));
        if (sc) line.appendChild(el("details", null, [el("summary", { text: "Message used" }), el("pre", { class: "block", text: sc.first_message + "\n\nSystem prompt:\n" + sc.system_prompt })]));
        sec.appendChild(el("div", { class: "attempt" }, [el("div", { class: "num", text: String(a.attempt_number) }), line]));
      });
      card.appendChild(sec);

      if (v.interview) {
        const i = v.interview;
        card.appendChild(el("div", { class: "sec" }, [el("h4", null, ["Conversation", el("span", { text: i.status === "approved" ? "approved" : "awaiting approval" })]),
          el("div", { class: "small" }, [i.scheduled_for ? fmtTime(i.scheduled_for) + " · 30 min · " : "No time fixed yet · ", nice(i.confirmation_email) + " ", i.calendar_event_ref ? el("a", { href: REPO + "/blob/main/" + i.calendar_event_ref.replace(/^file:/, ""), text: "draft .ics", target: "_blank", rel: "noopener" }) : null]),
          (i.contact_email || i.contact_method || i.contact_number || i.availability || i.notes) ? el("div", { class: "handoff" }, [
            el("h4", { text: "Handoff to Anirudh" }),
            i.contact_email ? el("div", { class: "issue" }, [el("span", { class: "k", text: "email" }), el("span", { text: i.contact_email })]) : null,
            (i.contact_method && i.contact_method !== "unknown") ? el("div", { class: "issue" }, [el("span", { class: "k", text: "reach via" }), el("span", { text: nice(i.contact_method) + (i.contact_number ? " · " + i.contact_number : "") })]) : null,
            i.availability ? el("div", { class: "issue" }, [el("span", { class: "k", text: "available" }), el("span", { text: i.availability })]) : null,
            i.person_spoken_to ? el("div", { class: "issue" }, [el("span", { class: "k", text: "replied" }), el("span", { text: nice(i.person_spoken_to) })]) : null,
            i.notes ? el("div", { class: "issue" }, [el("span", { class: "k", text: "notes" }), el("span", { text: i.notes })]) : null,
          ]) : null]));
      }
      const n = v.errs.length + v.als.length + v.dl.length;
      const issues = el("div", { class: "sec" }, [el("h4", null, ["Errors and alerts", el("span", { text: n ? plural(v.errs.length, "error") + ", " + plural(v.als.length, "alert") + (v.dl.length ? ", " + v.dl.length + " dead-lettered" : "") : "none" })])]);
      if (!n) issues.appendChild(el("div", { class: "ok", text: "✓ Clean" }));
      v.errs.forEach((e) => issues.appendChild(el("div", { class: "issue error" }, [el("span", { class: "k", text: nice(e.error_type) }), el("span", { text: (e.field ? e.field + ": " : "") + e.detail })])));
      v.als.forEach((a) => issues.appendChild(el("div", { class: "issue alert" }, [el("span", { class: "k", text: nice(a.type) }), el("span", { text: a.detail })])));
      v.dl.forEach((x) => issues.appendChild(el("div", { class: "issue alert" }, [el("span", { class: "k", text: "dead letter" }), el("span", { text: x.last_error + " (" + x.attempts + " attempts)" })])));
      card.appendChild(issues);
      return card;
    }
    let filter = "all", query = "";
    function matches(v) {
      const c = v.c;
      if (query) { const q = query.toLowerCase(); if (!((c.full_name || "").toLowerCase().includes(q) || (c.practice_name || "").toLowerCase().includes(q) || c.external_id === q || c.id === q)) return false; }
      switch (filter) {
        case "booked": return c.status === "BOOKED";
        case "outreach": return c.status === "IN_OUTREACH";
        case "queued": return c.status === "READY";
        case "attention": return v.attention;
        case "closed": return ["DECLINED", "UNREACHABLE", "SUPPRESSED"].includes(c.status);
        default: return true;
      }
    }
    function drawCards() {
      const host = clear($("cards")); const shown = views.filter(matches);
      shown.forEach((v) => host.appendChild(cardFor(v)));
      if (!shown.length) host.appendChild(el("div", { class: "empty", text: "No practices match." }));
      $("cards-count").textContent = shown.length + " of " + plural(views.length, "practice") + " · " + views.filter((v) => v.attention).length + " need attention";
    }
    $("filters").querySelectorAll(".f").forEach((btn) => btn.addEventListener("click", () => { filter = btn.getAttribute("data-filter"); $("filters").querySelectorAll(".f").forEach((b) => b.setAttribute("aria-pressed", String(b === btn))); drawCards(); }));
    $("tracker-search").addEventListener("input", (e) => { query = e.target.value.trim(); drawCards(); });
    drawCards();

    // ---------- gate (blocked and deferred only) ----------
    const kind = (g) => g.allowed ? "allowed" : (g.deferred ? "deferred" : "blocked");
    const held = decisions.filter((g) => g.run_id === lastRun && !g.allowed).sort((a, b) => (a.deferred ? 1 : 0) - (b.deferred ? 1 : 0) || name(a.contact_id).localeCompare(name(b.contact_id)));
    const lr = comp.last_run || {};
    $("gate-count").textContent = (lr.allowed || 0) + " allowed · " + (lr.blocked || 0) + " blocked · " + (lr.deferred || 0) + " deferred";
    clear($("gate")).appendChild(table(["Practice", "Decision", "Why"], held.map((g) => { const k = kind(g); return [name(g.contact_id), status(k === "deferred" ? "warning" : "critical", k), el("div", { class: "reasons" }, (g.reasons || []).map((r) => el("span", { class: "reason", text: r })))]; }), { empty: "Nothing was held back in the last run.", nowrap: [1] }));

    // ---------- collapsed detail ----------
    const outcomeCounts = {};
    Object.entries(calls.by_outcome || {}).forEach(([k, v]) => { const l = outcomeText(k); outcomeCounts[l] = (outcomeCounts[l] || 0) + v; });
    const outcomes = Object.entries(outcomeCounts).sort((a, b) => b[1] - a[1]).map(([l, v]) => ({ label: l, count: v }));
    bars($("outcomes"), outcomes, "outcomes, all attempts");
    const cats = Object.entries(calls.by_failure_category || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: categoryText(k), count: v }));
    bars($("fail-bars"), cats, "failure categories");
    $("outcomes-count").textContent = plural(calls.attempts || 0, "email");
    $("queue-count").textContent = plural(queue.length, "practice");
    clear($("queue")).appendChild(table(["Practice", "Attempts", "Last outcome", "Next attempt"], queue.map((q) => [q.name + (q.external_id ? " · " + q.external_id : ""), q.attempts, outcomeText(q.last_outcome) || "–", q.next_attempt_at ? fmtTime(q.next_attempt_at) : "when the window opens"]), { num: [1], empty: "Queue is empty.", nowrap: [3] }));
    $("interviews-count").textContent = plural(interviews.length, "booking");
    clear($("interviews")).appendChild(table(["Practice", "Scheduled for", "Status", "Draft"], interviews.map((i) => [name(i.contact_id), fmtTime(i.scheduled_for), i.status === "approved" ? status("good", "approved by " + i.approved_by) : status("warning", "awaiting approval"), i.calendar_event_ref ? el("a", { href: REPO + "/blob/main/" + i.calendar_event_ref.replace(/^file:/, ""), text: ".ics", target: "_blank", rel: "noopener" }) : "–"]), { nowrap: [1] }));
    const dStatus = (t) => t.delivery_status === "delivered" ? status("good", "delivered") : t.delivery_status === "held_pii_review" ? status("warning", "held (PII)") : t.delivery_status === "failed" ? status("critical", "failed") : status("neutral", t.delivery_status);
    $("transcripts-count").textContent = (tr.delivered || 0) + " delivered · " + (tr.held_pii_review || 0) + " held · " + (tr.failed || 0) + " failed";
    clear($("transcripts")).appendChild(table(["Practice", "Outcome", "Delivery", "Tries"], transcripts.map((t) => { const a = attemptById[t.call_attempt_id] || {}; return [name(t.contact_id), outcomeText(a.outcome), dStatus(t), t.delivery_attempts]; }), { num: [3] }));
    const errRows = errors.slice().reverse().map((e) => [fmtTime(e.timestamp), status("warning", nice(e.error_type)), e.contact_id ? name(e.contact_id) : e.call_id, (e.field ? e.field + ": " : "") + e.detail]);
    const alertRows = alerts.slice().reverse().map((a) => [fmtTime(a.timestamp), status(a.type === "kill_switch_on" || a.type === "gate_escape" ? "critical" : (a.type.includes("failed") ? "serious" : "warning"), nice(a.type)), a.contact_id ? name(a.contact_id) : (a.transcript_id || a.run_id || ""), a.detail]);
    $("errors-count").textContent = plural(errors.length, "error") + " · " + plural(alerts.length, "alert") + " · " + dlq.length + " dead-lettered";
    clear($("errors")).appendChild(table(["Time", "Type", "Practice", "Detail"], alertRows.concat(errRows), { nowrap: [0, 1] }));
    const runs = (d.runs || []).slice().reverse();
    $("runs-count").textContent = plural(runs.length, "run");
    clear($("runs")).appendChild(table(["Run", "Trigger", "Sent", "Blocked", "Deferred", "Delivered", "Escapes"], runs.map((r) => { const rs = r.stages || {}, rc = rs.calls || {}, rd = rs.delivery || {}; return [fmtTime(r.started_at) + (r.simulated_time ? " (sim)" : ""), nice(r.trigger), rc.placed ?? 0, rc.blocked ?? 0, rc.deferred ?? 0, rd.delivered ?? 0, r.gate_escapes ?? 0]; }), { num: [2, 3, 4, 5, 6], nowrap: [0] }));
    const audit = (d.audit_log || []).slice().reverse().slice(0, 100);
    $("audit-count").textContent = "latest 100";
    clear($("audit")).appendChild(table(["Time", "Entity", "Action", "Actor", "Id"], audit.map((e) => [fmtTime(e.timestamp), e.entity, nice(e.action), e.actor, e.entity_id]), { mono: [4], nowrap: [0] }));

    const input = $("search"), hist = $("history");
    function renderHistory(q) {
      q = q.trim().toLowerCase(); clear(hist);
      if (!q) { hist.textContent = "Type to search."; return; }
      const hit = contacts.find((x) => x.id === q || x.external_id === q) || contacts.find((x) => (x.full_name || "").toLowerCase().includes(q) || (x.practice_name || "").toLowerCase().includes(q));
      if (!hit) { hist.textContent = "No practice matches."; return; }
      const kv = el("dl", { class: "kv" });
      [["Name", hit.full_name || "(missing)"], ["Practice", hit.practice_name], ["Specialty", hit.specialty || "(missing)"], ["Segment", nice(hit.segment)], ["Status", hit.status], ["Verification", hit.verification_status + (hit.verification_reason ? " (" + hit.verification_reason + ")" : "")], ["Attempts", hit.attempts], ["Next attempt", hit.next_attempt_at ? fmtTime(hit.next_attempt_at) : "–"], ["Time zone", hit.time_zone], ["Hook", hit.hook || "–"], ["Ids", hit.id + (hit.external_id ? " · " + hit.external_id : "")]]
        .forEach(([k, v]) => { kv.appendChild(el("dt", { text: k })); kv.appendChild(el("dd", { text: String(v ?? "") })); });
      hist.appendChild(kv);
      hist.appendChild(table(["Channel", "Value (masked)", "Type", "Verified", "Clearance"], (hit.channels || []).map((ch) => [ch.type, ch.value, ch.line_type, ch.verified ? "yes" : "no" + (ch.verification_reason ? " (" + ch.verification_reason + ")" : ""), nice(ch.call_clearance)])));
      hist.appendChild(el("h3", { class: "small", text: "Gate decisions" }));
      hist.appendChild(table(["Run", "Decision", "Reasons"], decisions.filter((g) => g.contact_id === hit.id).reverse().map((g) => [g.run_id, kind(g), (g.reasons || []).join("; ")])));
      hist.appendChild(el("h3", { class: "small", text: "Audit trail" }));
      hist.appendChild(table(["Time", "Entity", "Action", "Change"], (d.audit_log || []).filter((e) => e.entity_id === hit.id || e.contact_id === hit.id).reverse().map((e) => [fmtTime(e.timestamp), e.entity + " " + e.entity_id, nice(e.action), JSON.stringify(e.after || {})]), { nowrap: [0] }));
    }
    input.addEventListener("input", () => renderHistory(input.value));
    const params = new URLSearchParams(location.search);
    if (params.get("contact")) { input.value = params.get("contact"); renderHistory(input.value); input.closest("details").open = true; }

    $("footer").textContent = "Snapshot " + (s.generated_at ? fmtTime(s.generated_at) : "–") + " · run " + (run.run_id || "–") + (newer ? " · a newer run has finished, refresh shortly" : "");
  }

  // ---------- live call panel (talks to the local control service) ----------
  async function localState() {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500);
    try { const res = await localFetch(LOCAL + "/api/state", { signal: ctl.signal }); clearTimeout(t); return res.ok ? await res.json() : null; }
    catch (e) { clearTimeout(t); return null; }
  }
  function renderLive(st) {
    const panel = $("livecall"); panel.hidden = false;
    const dot = $("live-dot"), btn = $("call-btn"), note = $("live-note"), tr = $("live-transcript"), res = $("live-result");
    const labels = { idle: "Agent idle", preparing: "Preparing the call", dialing: "Dialing your phone", in_call: "On the call", ended: "Call ended", error: "Error" };
    $("live-status").textContent = labels[st.status] || st.status;
    dot.className = "live-dot" + (["preparing", "dialing", "in_call"].includes(st.status) ? " on" : st.status === "error" ? " err" : "");
    const busy = ["preparing", "dialing", "in_call"].includes(st.status);
    btn.disabled = busy;
    btn.textContent = busy ? "Call in progress…" : (st.status === "ended" || st.status === "error" ? "Call again" : "Call my phone");
    const c = st.call || {};
    $("live-meta").textContent = (st.live_events ? "live transcript on" : "transcript after the call") + (st.tunnel_url ? "" : " · no tunnel") + (st.updated_at ? " · " + fmtTime(st.updated_at) : "");
    const bits = [];
    if (c.to) bits.push("to " + c.to); if (c.from) bits.push("from " + c.from); if (c.vapi_status) bits.push("Vapi: " + c.vapi_status); if (c.ended_reason) bits.push(nice(c.ended_reason));
    note.textContent = st.status === "error" ? st.error : (bits.join(" · ") || (st.status === "idle" ? "Service connected on this machine. Pressing the button dials the allowlisted number through Vapi." : ""));
    clear(tr);
    (st.transcript || []).forEach((u) => tr.appendChild(el("div", { class: "bubble " + u.role }, [el("span", { class: "who", text: u.role === "agent" ? "agent" : "you" }), u.text])));
    if (st.partial) tr.appendChild(el("div", { class: "bubble partial " + st.partial.role }, [el("span", { class: "who", text: st.partial.role === "agent" ? "agent" : "you" }), st.partial.text]));
    tr.scrollTop = tr.scrollHeight;
    if (st.result) {
      res.hidden = false; clear(res);
      const r = st.result, h = r.handoff || {};
      res.appendChild(el("div", null, [el("b", { text: "Outcome: " }), nice(r.outcome) + (r.failure_category ? " · " + r.failure_category : "") + (r.duration_sec ? " · " + r.duration_sec + "s" : "") + (r.cost_usd ? " · $" + Number(r.cost_usd).toFixed(2) : "")]));
      if (h.contact_email || h.contact_method || h.availability || h.notes) res.appendChild(el("div", null, [el("b", { text: "Handoff: " }), [h.contact_email, h.contact_method && h.contact_method !== "unknown" ? nice(h.contact_method) + (h.contact_number ? " " + h.contact_number : "") : "", h.availability, h.notes].filter(Boolean).join(" · ")]));
      if (r.recording_ref && r.recording_ref.startsWith("http")) res.appendChild(el("a", { href: r.recording_ref, text: "Recording", target: "_blank", rel: "noopener" }));
      if (c.summary) res.appendChild(el("div", { class: "muted small", text: c.summary }));
    } else { res.hidden = true; }
    $("live-log").textContent = (st.log || []).slice(-25).join("\n");
    return busy;
  }
  function wireLive(initial) {
    if (!initial) return;
    let wasBusy = renderLive(initial), timer = null;
    const tick = async () => { const st = await localState(); if (!st) return; const busy = renderLive(st); if (wasBusy && !busy && LIVE_VIEW) setTimeout(() => location.reload(), 1500); wasBusy = busy; };
    timer = setInterval(tick, 2000);
    $("call-btn").addEventListener("click", async () => {
      $("call-btn").disabled = true;
      try { const res = await localFetch(LOCAL + "/api/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); const body = await res.json(); if (!res.ok) $("live-note").textContent = body.message || body.error || "could not start"; }
      catch (e) { $("live-note").textContent = "Could not reach the local service."; }
      tick();
    });
    return timer;
  }

  Promise.all([loadAll(), loadLiveRun(), localState()]).then(([d, live, local]) => {
    wireLive(local);
    if (!d.summary) {
      const err = clear($("error"));
      if (LIVE_VIEW) {
        err.appendChild(document.createTextNode(local ? "The local service answered but has no live data yet. Press Call my phone to start." : "This page cannot reach the local service at 127.0.0.1:8787. Start it with `python -m infra serve`, allow the browser's local-network prompt if one appears, or open the same dashboard served locally: "));
        if (!local) err.appendChild(el("a", { href: LOCAL_CONSOLE, text: LOCAL_CONSOLE }));
      } else { err.textContent = "No pipeline data yet. Run the agent (Actions → Dry-run pipeline) or `python -m infra run` locally."; }
      if (!local) return;
    }
    render(d, live);
    setInterval(async () => { const live2 = await loadLiveRun(); const running = live2 && (live2.status === "in_progress" || live2.status === "queued"); const was = $("ring").classList.contains("running"); if (running !== was) location.reload(); }, 60000);
  }).catch((e) => { $("error").textContent = "Failed to render: " + e.message; console.error(e); });
})();
