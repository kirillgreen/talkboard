// Filters, sorted layout ("Collect"), saved views, the inspector, board settings and presentation mode.
// The sorted layout never touches the manual x,y of a card: it lives in B.layout.
(() => {
  const left = $("#left"), body = $("#left-body"), insp = $("#insp"), bar = $("#showbar");
  const heads = document.createElement("div"); heads.id = "l-heads"; world.append(heads);
  left.hidden = false; $("#show").hidden = false;
  const { AXES, nodes, els, H } = B;
  const emptyF = () => Object.fromEntries(AXES.map((k) => [k, new Set()]));
  const fromLists = (o) => Object.fromEntries(AXES.map((k) => [k, new Set((o && o[k]) || [])]));
  const toLists = (f) => Object.fromEntries(AXES.map((k) => [k, [...f[k]]]));
  let F = emptyF(), mode = "place", sort = "zone", views = [], camBefore = null, show = null, activeView = null, camRestore = null, settingsOpen = false;
  // filters, mode and sort survive a tab reload, like the camera and undo: a new version of the code arrives unnoticed
  try { const u = JSON.parse(sessionStorage.getItem("board-ui") || "null"); if (u) { F = fromLists(u.F); mode = u.mode; sort = u.sort; activeView = u.activeView; camRestore = u.mode === "collect" ? u.camBefore : null; } } catch (e) {}
  addEventListener("pagehide", () => { try { const s = show || { F, mode, sort, activeView, camBefore }; sessionStorage.setItem("board-ui", JSON.stringify({ F: toLists(s.F), mode: s.mode, sort: s.sort, activeView: s.activeView, camBefore: s.camBefore || null })); } catch (e) {} });
  const valLabel = (k, id) => (B.axisVal(k, id) || {}).label || id;
  const filterable = (n) => n.kind === "text" || n.kind === "image" || n.kind === "file";
  // "Ignore filters" (n.fixed, e.g. the board's main title): never dimmed, not counted, sits above the columns in Collect.
  const sortable = (n) => filterable(n) && !n.fixed;
  const passes = (n) => n.fixed || matches(n);
  const nActive = () => AXES.reduce((s, k) => s + F[k].size, 0);
  const isActive = () => nActive() > 0;
  // not visible right now: dimmed by a filter or hidden by the Collect layout (frames, arrows, everything that failed the filter)
  B.hiddenNow = (n) => !!n && (B.layout ? n.kind === "frame" || n.kind === "arrow" || (filterable(n) && !passes(n)) : filterable(n) && !!isActive() && !passes(n));
  // The filter panel collapses with the "Filters" button in the top bar; on a narrow screen it slides over the canvas.
  let leftOn = B.lsGet("board-left", true);
  const fb = document.createElement("button"); fb.className = "b f-btn"; fb.title = "Show or hide filters";
  const leftApply = () => { left.classList.toggle("shut", !leftOn); fb.setAttribute("aria-pressed", String(innerWidth <= 720 ? left.classList.contains("open") : leftOn)); };
  fb.addEventListener("click", () => {
    if (innerWidth <= 720) left.classList.toggle("open"); else { leftOn = !leftOn; B.lsSet("board-left", leftOn); }
    leftApply(); fb.blur();
  });
  $("#topr").prepend(fb); leftApply();
  // ov swaps one axis: that is how chip counts take the other filters into account
  function matches(n, ov) {
    const f = ov ? { ...F, ...ov } : F;
    for (const k of AXES) if (f[k].size && !f[k].has(n[k] || "__none")) return false;
    return true;
  }
  const plainTitle = (n) => (n.kind === "image" || n.kind === "file" ? n.title || "" : (n.text || "").replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, "$1").replace(/^(?:[\s#>*_-]|\d+\.\s)+/, "").replace(/[`*_\[\]]/g, "").trim());   // markdown stripped: sorting by text
  function probeHeight(n, w) {
    const src = els.get(n.id); if (!src) return H.get(n.id) || 60;   // not rendered yet: don't break the whole layout
    const p = src.cloneNode(true);
    p.classList.remove("out", "dim");               // a card hidden by the previous filter would measure as display:none = 0
    p.style.cssText = `width:${w}px;visibility:hidden;transform:none;left:0;top:0;transition:none`;
    world.append(p); const h = p.offsetHeight; p.remove(); return h;
  }
  function computeLayout() {
    const W = 340, GAP = 20, COLGAP = 56, HEAD = 74, MAXH = 2400;
    const list = [...nodes.values()].filter((n) => sortable(n) && matches(n) && !(B.isShow() && n.noshow));
    const groups = new Map(), byAxis = AXES.includes(sort);
    const order = byAxis ? [...B.axes[sort].values.map((v) => v.id), "__none"] : ["__all"];
    order.forEach((k) => groups.set(k, []));
    list.forEach((n) => { const k = byAxis ? n[sort] || "__none" : "__all"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); });
    const cmp = (a, b) => plainTitle(a).localeCompare(plainTitle(b));
    const map = new Map(), hs = []; let x = 0;
    for (const [k, items] of groups) {
      if (!items.length) continue;
      if (sort === "title") items.sort(cmp); else items.sort((a, b) => (a.z || 0) - (b.z || 0));
      const label = k === "__all" ? "By title" : k === "__none" ? "No " + B.axes[sort].label.toLowerCase() : valLabel(sort, k);
      hs.push({ x, label, n: items.length });
      let y = HEAD;
      const maxH = sort === "title" ? 1500 : MAXH;
      for (const n of items) {
        const h = n.kind === "image" || n.kind === "file" ? (n.w > 0 && n.h > 0 ? Math.min(560, Math.round(W * n.h / n.w)) : 200) : probeHeight(n, W);   // no size: avoid NaN
        if (y > HEAD && y + h > maxH) { x += W + GAP; y = HEAD; }
        map.set(n.id, { x, y, w: W, h }); if (n.kind === "text") H.set(n.id, h);
        y += h + GAP;
      }
      x += W + COLGAP;
    }
    // items that ignore filters sit above the columns, at their own size and in their top-to-bottom order
    const fixed = [...nodes.values()].filter((n) => filterable(n) && n.fixed && !(B.isShow() && n.noshow)).sort((a, b) => a.y - b.y);
    const fh = fixed.map((n) => (n.kind === "text" ? probeHeight(n, n.w) : n.h || 200));
    let fy = -60 - fh.reduce((s, h) => s + h + GAP, 0);
    fixed.forEach((n, i) => { map.set(n.id, { x: 0, y: fy, w: n.w || W, h: fh[i] }); if (n.kind === "text") H.set(n.id, fh[i]); fy += fh[i] + GAP; });
    return { map, hs };
  }
  function drawHeads(hs) { heads.innerHTML = hs.map((h) => `<div class="col-head" style="transform:translate(${h.x}px,0)"><b>${B.esc(h.label)}</b><i>${h.n}</i></div>`).join(""); }
  let animT = 0;
  function applyFilters(opts = {}) {
    const on = isActive(), collect = mode === "collect", was = !!B.layout;
    if (!reduced && collect !== was) { document.body.classList.add("anim"); clearTimeout(animT); animT = setTimeout(() => { document.body.classList.remove("anim"); B.measure(nodes.keys()); if (!B.layout) B.renderArrows(); B.updateOverlay(); }, 450); }
    let bbox = null;
    if (collect) {
      if (!was) camBefore = camRestore || { ...B.cam() };
      camRestore = null;
      const r = computeLayout(); B.layout = r.map; drawHeads(r.hs); bbox = B.union([...r.map.values()].map((o) => ({ ...o }))); if (bbox) { bbox.y -= 20; bbox.h += 20; }
      if (opts.fit && ![...r.map.keys()].some((id) => sortable(nodes.get(id)))) B.toast("No card matches these filters");
    }
    else { B.layout = null; heads.innerHTML = ""; }
    for (const n of nodes.values()) {
      const el = els.get(n.id); if (!el) continue;
      if (n.kind === "frame") { el.classList.toggle("out", collect); continue; }
      if (n.kind === "arrow") {
        const keep = !on || ((!n.from || (nodes.get(n.from) && passes(nodes.get(n.from)))) && (!n.to || (nodes.get(n.to) && passes(nodes.get(n.to)))) && (n.from || n.to));
        el.classList.toggle("dim", !collect && !keep); el.classList.toggle("out", collect); continue;
      }
      if (!filterable(n)) continue;
      const m = !on || passes(n);
      el.classList.toggle("dim", on && !collect && !m);
      el.classList.toggle("out", collect && !m && !n.fixed);
      B.place(n.id);
    }
    if (was && !collect) B.measure(nodes.keys());
    if (!collect) B.renderArrows();
    // drop hidden items from the selection: otherwise the inspector and Delete act on something invisible
    const kids = B.childrenMap(), cur = [...B.selection()], vis = (l) => { const el = els.get(l); return !el || !(el.classList.contains("out") || el.classList.contains("dim")); };
    const keep = cur.filter((id) => B.leaves(id, kids).some(vis));
    if (keep.length !== cur.length) B.select(keep);
    B.updateOverlay();
    if (opts.cam !== false) {
      if (collect && bbox && (!was || opts.fit)) B.setCam(B.camFor(bbox, !B.isShow()), 450);
      else if (was && !collect && camBefore && !opts.keepCam) { B.setCam(camBefore, 450); camBefore = null; }
    }
    renderLeft();
    if (collect !== was) renderInsp();                 // inspector buttons depend on the layout
    for (const f of B.hooks) f();                      // search, minimap: .out/.dim classes changed
  }
  let rafT = 0; const reschedule = () => { cancelAnimationFrame(rafT); rafT = requestAnimationFrame(() => applyFilters({ cam: false })); };
  B.afterRender = () => { if (isActive() || B.layout || mode === "collect") reschedule(); else renderLeftSoon(); };
  B.onData = () => { if (mode === "collect" && !B.layout) applyFilters({ cam: false }); else renderLeftSoon(); };   // Collect restored after a reload: right away, without waiting a frame
  // Fits a new item to the active filter so it doesn't vanish right after creation: values that already match stay, otherwise the first selected value wins.
  B.fitFilter = (n) => {
    for (const k of AXES) if (F[k].size && !F[k].has(n[k] || "__none")) { const v = [...F[k]][0]; n[k] = v === "__none" ? null : v; }
    return n;
  };
  let leftT = 0; const renderLeftSoon = () => { clearTimeout(leftT); leftT = setTimeout(renderLeft, 60); };

  // ---------- left panel ----------
  function toggle(set, v, add) {
    activeView = null;
    if (add) { if (set.has(v)) set.delete(v); else set.add(v); }
    else { const only = set.size === 1 && set.has(v); set.clear(); if (!only) set.add(v); }
    applyFilters({ fit: true });
  }
  const chip = (set, v, label, count, color) => `<button class="chip${count ? "" : " zero"}" data-set="${set}" data-v="${B.esc(v)}" aria-pressed="${F[set].has(v)}">${color ? `<em style="background:var(--t${color})"></em>` : ""}<span>${B.esc(label)}</span><i>${count}</i></button>`;
  // while the mouse button is held over the panel it isn't redrawn: the button under the cursor would be swapped and the click lost
  let pressing = 0, pendLeft = false;   // press time; we don't wait longer than 1.5 s so the panel can't freeze if the release was lost
  body.addEventListener("pointerdown", () => { pressing = performance.now(); });
  addEventListener("pointerup", () => { if (!pressing) return; pressing = 0; if (pendLeft) { pendLeft = false; setTimeout(renderLeft, 0); } }, true);
  addEventListener("pointercancel", () => { pressing = 0; }, true);
  body.addEventListener("focusout", () => { if (pendLeft && !pressing) { pendLeft = false; setTimeout(renderLeft, 0); } });
  function renderLeft() {
    if (pressing && performance.now() - pressing < 1500) { pendLeft = true; return; }
    if (document.activeElement && body.contains(document.activeElement) && document.activeElement.tagName === "INPUT") { pendLeft = true; return; }   // redraw once the field loses focus
    const nOn = nActive();
    fb.textContent = nOn ? `Filters · ${nOn}` : "Filters"; fb.classList.toggle("on", !!nOn);
    const h = settingsOpen ? settingsHtml() : filtersHtml();
    if (body._h !== h) { const top = body.scrollTop; body.innerHTML = h; body._h = h; body.scrollTop = top; }
  }
  function filtersHtml() {
    const all = [...nodes.values()].filter(sortable);
    // the number on a chip is how many cards stay visible if you pick it with the other filters on
    const fc = (set, v) => all.filter((n) => matches(n, { [set]: new Set([v]) })).length;
    let h = `<section class="sec"><h3>Arrange</h3><div class="seg"><button data-mode="place" aria-pressed="${mode === "place"}">In place</button><button data-mode="collect" aria-pressed="${mode === "collect"}">Collect</button></div>`;
    if (mode === "collect") h += `<div class="seg" style="margin-top:4px">${AXES.map((k) => `<button data-sort="${k}" aria-pressed="${sort === k}">${B.esc(B.axes[k].label.toLowerCase())}</button>`).join("")}<button data-sort="title" aria-pressed="${sort === "title"}">title</button></div>`;
    if (isActive()) h += `<button class="b reset" id="f-reset">Clear filters</button>`;
    h += `</section>`;
    h += `<section class="sec"><h3>Views</h3>`;
    h += views.map((v) => `<div class="view" data-id="${v.id}"><button class="v-go" aria-pressed="${activeView === v.id}">${B.esc(v.name)}</button><button class="v-play" title="Present from this view" aria-label="Present">▶</button><button class="v-del" title="Delete view" aria-label="Delete">×</button></div>`).join("");
    h += `<form id="v-new" class="v-new"><input class="inp" placeholder="Save current view" maxlength="60" aria-label="View name"></form></section>`;
    AXES.forEach((k, i) => {
      const ax = B.axes[k];
      h += `<section class="sec"><h3>${B.esc(ax.label)}${i === 0 ? " <small>⇧ adds</small>" : ""}</h3>` + ax.values.map((v) => chip(k, v.id, v.label, fc(k, v.id), v.c)).join("") + chip(k, "__none", "no " + ax.label.toLowerCase(), fc(k, "__none")) + `</section>`;
    });
    h += `<section class="sec"><button class="b" id="s-open">Board settings</button></section>`;
    return h;
  }
  // Board settings: people name the three axes and define their values and colours. One doc, meta/axes.
  let clearArmed = false;
  function settingsHtml() {
    let h = `<section class="sec"><h3>Board settings</h3><p class="hint">Name the three axes and their values. A frame passes its ${B.esc(B.axes.zone.label.toLowerCase())} to everything placed inside it.</p></section>`;
    for (const k of AXES) {
      const ax = B.axes[k];
      h += `<section class="sec ax" data-ax="${k}"><input class="inp ax-name" data-ax-label="${k}" value="${B.esc(ax.label)}" aria-label="Axis name" maxlength="30">`;
      h += ax.values.map((v) => `<div class="ax-row" data-ax="${k}" data-id="${B.esc(v.id)}"><button class="sw" data-sw style="background:var(--t${v.c || 6})" title="Change colour" aria-label="Change colour"></button><input class="inp" data-val-label value="${B.esc(v.label)}" aria-label="Value name" maxlength="40"><button class="v-del" data-val-del title="Delete value" aria-label="Delete value">×</button></div>`).join("");
      h += `<form class="ax-add" data-ax="${k}"><input class="inp" placeholder="Add a value, press Enter" maxlength="40" aria-label="New value"></form></section>`;
    }
    const total = [...nodes.values()].filter((n) => n.kind !== "group").length;
    h += `<section class="sec"><h3>Board</h3><p class="hint">Removes every card, frame, arrow and file from the board. Views and the settings above stay; ⌘Z brings it all back.</p><button class="b danger" id="s-clear"${total ? "" : " disabled"}>${clearArmed ? `Click again to delete ${total} items` : "Clear the board"}</button></section>`;
    h += `<section class="sec"><button class="b go" id="s-done">Done</button></section>`;
    return h;
  }
  const saveAxes = () => { B.db.collection("meta").doc("axes").set(B.clone(B.axes)).catch(() => B.toast("Settings were not saved, try again")); B.renderAll(); renderLeft(); renderInsp(); };
  function addValue(k, label) {
    label = label.trim(); if (!label) return null;
    const vals = B.axes[k].values, hit = vals.find((v) => v.label.toLowerCase() === label.toLowerCase()); if (hit) return hit.id;
    const v = { id: B.uid(k.slice(0, 2)), label, c: (vals.length % 10) + 1 }; vals.push(v); saveAxes();
    return v.id;
  }
  function deleteValue(k, id) {
    const vals = B.axes[k].values, i = vals.findIndex((v) => v.id === id); if (i < 0) return;
    const [gone] = vals.splice(i, 1), users = [...nodes.values()].filter((n) => n[k] === id);
    if (users.length) B.tx(() => users.forEach((n) => B.patch(n.id, { [k]: null })));
    saveAxes();
    B.toast(`Removed “${gone.label}”` + (users.length ? ` from ${users.length} item${users.length > 1 ? "s" : ""}` : ""), { label: "Undo", fn: () => { vals.splice(i, 0, gone); if (users.length) B.undo(); saveAxes(); } });
  }
  // a failure in the layout must not look like "the button doesn't work": show it and log it
  body.addEventListener("click", (e) => { try { panelClick(e); } catch (err) { console.error(err); B.toast("Something went wrong: " + (err && err.message || err)); } });
  function panelClick(e) {
    if (e.target.id === "s-open") { settingsOpen = true; renderLeft(); return; }
    if (e.target.id === "s-done") { settingsOpen = false; clearArmed = false; renderLeft(); return; }
    if (e.target.id === "s-clear") {
      if (!clearArmed) { clearArmed = true; renderLeft(); setTimeout(() => { if (clearArmed) { clearArmed = false; renderLeft(); } }, 4000); return; }
      clearArmed = false; B.removeSelection([...nodes.values()].filter((n) => !n.parent).map((n) => n.id)); renderLeft(); return;
    }
    const row = e.target.closest(".ax-row");
    if (row && e.target.closest("[data-sw]")) { const v = B.axisVal(row.dataset.ax, row.dataset.id); if (v) { v.c = ((v.c || 0) % 10) + 1; saveAxes(); } return; }
    if (row && e.target.closest("[data-val-del]")) { deleteValue(row.dataset.ax, row.dataset.id); return; }
    const c = e.target.closest(".chip"); if (c) { toggle(F[c.dataset.set], c.dataset.v, e.shiftKey); return; }
    const m = e.target.closest("[data-mode]"); if (m) { mode = m.dataset.mode; activeView = null; applyFilters({ fit: true }); return; }
    const s = e.target.closest("[data-sort]"); if (s) { sort = s.dataset.sort; activeView = null; applyFilters({ fit: true }); return; }
    // Clear only drops the filters; "In place" leaves Collect
    if (e.target.id === "f-reset") { F = emptyF(); activeView = null; applyFilters({ fit: true }); return; }
    const v = e.target.closest(".view"); if (!v) return;
    const view = views.find((x) => x.id === v.dataset.id);
    if (e.target.closest(".v-del")) {
      const { id, ...doc } = view, ref = B.db.collection("views").doc(id);
      if (activeView === id) activeView = null;
      ref.delete().then(() => B.toast(`View “${view.name}” deleted`, { label: "Undo", fn: () => ref.set(doc).catch(() => B.toast("The view did not come back, try again")) })).catch(() => B.toast("The view was not deleted, try again"));
      return;
    }
    if (e.target.closest(".v-play")) { startShow(view.id); return; }
    useView(view);
  }
  body.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.axLabel) { const v = t.value.trim(); if (v && v !== B.axes[t.dataset.axLabel].label) { B.axes[t.dataset.axLabel].label = v; saveAxes(); } return; }
    const row = t.closest(".ax-row");
    if (row && t.hasAttribute("data-val-label")) { const v = B.axisVal(row.dataset.ax, row.dataset.id), l = t.value.trim(); if (v && l && l !== v.label) { v.label = l; saveAxes(); } }
  });
  body.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("[data-ax-label], [data-val-label]")) { e.preventDefault(); e.target.blur(); } });
  body.addEventListener("submit", (e) => {
    e.preventDefault(); const inp = e.target.querySelector("input"), name = inp.value.trim(); if (!name) return;
    if (e.target.classList.contains("ax-add")) { inp.value = ""; inp.blur(); addValue(e.target.dataset.ax, name); setTimeout(() => { const f = body.querySelector(`.ax-add[data-ax="${e.target.dataset.ax}"] input`); if (f) f.focus(); }, 0); return; }
    const id = B.uid("v"), doc = { name, order: views.length, filter: toLists(F), mode, sort, cam: mode === "place" ? B.cam() : null };
    B.db.collection("views").doc(id).set(doc).then(() => B.toast("View saved")).catch(() => B.toast("The view was not saved, try again"));
    inp.value = ""; inp.blur(); activeView = id;
  });
  function useView(v, opts = {}) {
    F = fromLists(v.filter);
    mode = v.mode; sort = AXES.includes(v.sort) || v.sort === "title" ? v.sort : "zone"; activeView = v.id;
    applyFilters({ fit: true, keepCam: !!v.cam, ...opts });
    if (v.cam && mode !== "collect") B.setCam(v.cam, 500);
  }
  B.startData = (db) => {
    db.collection("views").onSnapshot((snap) => { views = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0)); renderLeft(); }, console.error);
    db.collection("meta").onSnapshot((snap) => {
      const d = snap.docs.find((x) => x.id === "axes"); if (!d) return;
      const a = d.data() || {};
      for (const k of AXES) if (a[k]) B.axes[k] = { label: a[k].label || B.axes[k].label, values: Array.isArray(a[k].values) ? a[k].values : [] };
      B.renderAll(); renderLeft(); renderInsp();
    }, console.error);
  };

  // ---------- inspector ----------
  let newOpen = null;   // axis whose "new value…" field is open
  const uniq = (arr) => (new Set(arr).size === 1 ? arr[0] : "__mixed");
  function targets() { const kids = B.childrenMap(); return [...B.selection()].flatMap((id) => B.leaves(id, kids)).map((id) => nodes.get(id)).filter((n) => n && !(els.get(n.id) && els.get(n.id).classList.contains("out"))); }
  function axisField(k, list) {
    const ax = B.axes[k], cur = uniq(list.map((n) => n[k] || "")), lc = ax.label.toLowerCase();
    return `<div class="fld"><label for="i-${k}">${B.esc(ax.label)}</label><select id="i-${k}" class="sel" data-axis="${k}">${cur === "__mixed" ? '<option value="__mixed" selected>mixed</option>' : ""}<option value=""${cur === "" ? " selected" : ""}>no ${B.esc(lc)}</option>${ax.values.map((v) => `<option value="${B.esc(v.id)}"${cur === v.id ? " selected" : ""}>${B.esc(v.label)}</option>`).join("")}<option value="__new">new ${B.esc(lc)}…</option></select>${newOpen === k ? `<input id="i-new" class="inp" data-axis="${k}" placeholder="Name, then Enter">` : ""}</div>`;
  }
  function renderInsp() {
    if (B.isShow()) { insp.hidden = true; return; }
    if (insp.contains(document.activeElement) && document.activeElement.tagName !== "BUTTON") return;
    const sel = [...B.selection()], ts = targets();
    if (!sel.length || !ts.length || !B.canWrite()) { insp.hidden = true; insp._h = ""; return; }
    const content = ts.filter(filterable), frames = ts.filter((n) => n.kind === "frame"), single = ts.length === 1 ? ts[0] : null;
    const firstSel = nodes.get(sel[0]);
    const title = sel.length === 1 && firstSel.kind === "group" ? "Group" : single ? { text: "Text", image: "Image", file: "File", frame: "Frame", arrow: "Arrow" }[single.kind] : "Selection";
    let h = `<div class="i-head"><b>${title}</b><span>${ts.length > 1 ? ts.length + " items" : ""}</span></div>`;
    if (frames.length === 1 && single) h += `<div class="fld"><label for="i-title">Title</label><input id="i-title" class="inp" value="${B.esc(single.title || "")}"></div><div class="fld"><label for="i-note">Caption</label><input id="i-note" class="inp" value="${B.esc(single.note || "")}"></div>`;
    if (content.length) h += axisField("type", content) + axisField("zone", content) + axisField("status", content);
    else if (single && single.kind === "frame") h += axisField("zone", [single]);
    if (content.length) {
      const ns = content.filter((n) => n.noshow).length;
      h += `<label class="chk"><input type="checkbox" id="i-show" ${ns === 0 ? "checked" : ""}>Show when presenting${ns && ns < content.length ? " (some)" : ""}</label>`;
      const nf = content.filter((n) => n.fixed).length;
      h += `<label class="chk" title="Filters never dim it; in Collect it sits above the columns. Good for the board's main title"><input type="checkbox" id="i-fixed" ${nf === content.length ? "checked" : ""}>Ignore filters${nf && nf < content.length ? " (some)" : ""}</label>`;
    }
    const texts = ts.filter((n) => n.kind === "text");
    if (texts.length) {
      const st = uniq(texts.map((n) => n.style)), fs = uniq(texts.map((n) => n.fs));
      h += `<div class="fld"><span class="lb">Text style</span><div class="seg"><button data-style="card" aria-pressed="${st === "card"}">Card</button><button data-style="plain" aria-pressed="${st === "plain"}">Label</button></div></div><div class="fld"><label for="i-fs">Size</label><input id="i-fs" class="inp" type="number" min="8" max="400" value="${fs === "__mixed" ? "" : fs}"></div>`;
    }
    if (single && single.src) h += `<div class="src-note">${B.esc(single.src)}</div>`;
    if (sel.length === 1 && firstSel.kind === "frame" && !B.layout) h += `<div class="btns"><button class="b" id="i-arrange" title="Columns inside the frame; one undo brings everything back">Arrange contents</button></div>`;
    h += `<div class="btns"><button class="b" data-z="front" title="]">Forward</button><button class="b" data-z="back" title="[">Back</button>`;
    if (sel.length > 1) h += `<button class="b" id="i-group" title="⌘G">Group</button>`;
    if (sel.some((id) => nodes.get(id).kind === "group")) h += `<button class="b" id="i-ungroup" title="⇧⌘G">Ungroup</button>`;
    h += `<button class="b" id="i-del">Delete</button></div>`;
    insp.hidden = false;
    if (insp._h !== h) { insp.innerHTML = h; insp._h = h; }
  }
  B.onSelection = renderInsp;
  B.focusTitle = (id) => { B.select([id]); setTimeout(() => { const t = $("#i-title"); if (t) { t.focus(); t.select(); } }, 0); };
  const applyAll = (fn) => { const ts = targets(); B.tx(() => ts.forEach((n) => fn(n))); };
  const force = () => { insp._h = ""; if (document.activeElement && insp.contains(document.activeElement)) document.activeElement.blur(); renderInsp(); };
  const setAxis = (k, v) => applyAll((n) => (filterable(n) || (k === "zone" && n.kind === "frame")) && B.patch(n.id, { [k]: v || null }));
  insp.addEventListener("change", (e) => {
    const t = e.target, v = t.value;
    if (t.dataset.axis && t.tagName === "SELECT") {
      if (v === "__new") { newOpen = t.dataset.axis; force(); const i = $("#i-new"); if (i) i.focus(); return; }
      if (v !== "__mixed") setAxis(t.dataset.axis, v); t.blur();
    }
    if (t.id === "i-show") applyAll((n) => filterable(n) && B.patch(n.id, { noshow: !t.checked }));
    if (t.id === "i-fixed") { applyAll((n) => filterable(n) && B.patch(n.id, { fixed: t.checked })); applyFilters({ cam: false }); }
    if (t.id === "i-fs" && +v >= 8) { applyAll((n) => n.kind === "text" && B.patch(n.id, { fs: +v })); }
    if (t.id === "i-title") applyAll((n) => n.kind === "frame" && B.patch(n.id, { title: v }));
    if (t.id === "i-note") applyAll((n) => n.kind === "frame" && B.patch(n.id, { note: v }));
  });
  insp.addEventListener("keydown", (e) => {
    const t = e.target; if (!((t.tagName === "INPUT" && t.type !== "checkbox") || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;   // buttons and checkboxes don't swallow board keys
    e.stopPropagation();
    if (e.key === "Escape") { if (t.id === "i-new") newOpen = null; t.blur(); if (t.id === "i-new") force(); return; }
    if (e.key !== "Enter") return;
    if (t.id === "i-new") { e.preventDefault(); const k = t.dataset.axis, id = addValue(k, t.value); newOpen = null; if (id) setAxis(k, id); force(); }
    if (["i-title", "i-note", "i-fs"].includes(t.id)) t.blur();
  });
  insp.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.style) { applyAll((n) => n.kind === "text" && B.patch(n.id, { style: b.dataset.style })); force(); return; }
    if (b.dataset.z) { let z = b.dataset.z === "front" ? B.maxZ() + 1 : -1e4 - Math.round(Math.random() * 1000); applyAll((n) => B.patch(n.id, { z: z++ })); return; }
    if (b.id === "i-arrange") { arrangeFrame([...B.selection()][0]); return; }
    if (b.id === "i-group") B.group(); if (b.id === "i-ungroup") B.ungroup(); if (b.id === "i-del") B.removeSelection([...B.selection()]);
  });


  // ---------- Arrange contents: columns inside a frame, one transaction ----------
  function arrangeFrame(id) {
    const f = nodes.get(id); if (!f || f.kind !== "frame") return;
    if (B.layout) return B.toast("Arrange works in the In place mode");
    if (!B.canWrite()) return B.toast("Read-only: changes will not be saved");
    const items = B.frameContents(f).map((i) => nodes.get(i)).filter((n) => n && filterable(n));
    if (!items.length) return B.toast("Nothing to arrange in this frame");
    const GAP = 24, PADX = 48, TOP = 96, BOT = 48, cnt = new Map();
    items.forEach((n) => { const w = Math.round(n.w); cnt.set(w, (cnt.get(w) || 0) + 1); });
    let colW = 0, best = 0; for (const [w, c] of cnt) if (c > best) { best = c; colW = w; }
    if (colW < 120) colW = 380;
    // reading order: columns by current x, top to bottom inside a column
    const cols = []; for (const n of [...items].sort((a, b) => a.x - b.x)) { const c = cols[cols.length - 1]; if (c && n.x - c.x0 < colW * .6) c.list.push(n); else cols.push({ x0: n.x, list: [n] }); }
    const seq = cols.flatMap((c) => c.list.sort((a, b) => a.y - b.y));
    const nc = Math.max(1, Math.floor((f.w - 2 * PADX + GAP) / (colW + GAP))), colH = Array(nc).fill(0), put = [];
    for (const n of seq) {
      const h = n.kind === "text" ? (els.get(n.id) ? probeHeight(n, colW) : H.get(n.id) || 60) : Math.max(24, Math.round(colW * (n.h || 1) / (n.w || 1)));
      let c = 0; for (let i = 1; i < nc; i++) if (colH[i] < colH[c]) c = i;
      put.push([n, Math.round(f.x + PADX + c * (colW + GAP)), Math.round(f.y + TOP + colH[c]), h]); colH[c] += h + GAP;
    }
    const need = Math.round(TOP + Math.max(...colH) - GAP + BOT);
    B.tx(() => { for (const [n, x, y, h] of put) B.patch(n.id, n.kind === "text" ? { x, y, w: colW } : { x, y, w: colW, h }); if (need > f.h) B.patch(f.id, { h: need }); });
    B.toast(`Arranged: ${put.length}`, { label: "Undo", fn: B.undo });
  }

  // ---------- presentation ----------
  function buildSteps() {
    const frames = [...nodes.values()].filter((n) => n.kind === "frame").sort((a, b) => a.x - b.x || a.y - b.y);
    return [{ kind: "all", label: "Whole board" }, ...frames.map((f) => ({ kind: "frame", id: f.id, label: f.title || "Frame" })), ...views.map((v) => ({ kind: "view", v, label: v.name }))];
  }
  function go(i) {
    show.i = Math.max(0, Math.min(show.steps.length - 1, i)); show.focus = null;   // moving to another step drops the focus on a card
    const st = show.steps[show.i];
    if (st.kind === "view") useView(st.v);
    else {
      F = emptyF(); mode = "place"; applyFilters({ cam: false });
      if (st.kind === "all") B.fitAll(650);
      else { const b = B.box(st.id), t = B.frameHead(nodes.get(st.id)); b.y -= t; b.h += t; B.setCam(B.camFor(b, false), 650); }
    }
    bar.textContent = `${show.i + 1} / ${show.steps.length} · ${st.label}`; bar.hidden = false; bar.style.opacity = 1;
    clearTimeout(bar._t); bar._t = setTimeout(() => (bar.style.opacity = .25), 2500);
  }
  function startShow(viewId) {
    if (show) return;
    B.closeEditor(); B.select([]);
    show = { i: 0, steps: buildSteps(), F, mode, sort, cam: { ...B.cam() }, activeView, camBefore, fs: false, focus: null };
    searchClose();
    B.isShow = () => true; document.body.classList.add("show"); insp.hidden = true;
    const el = document.documentElement;
    // In fullscreen the browser takes Esc and exits; with keyboard.lock (Chromium) Esc is ours again and a long press exits
    if (el.requestFullscreen) el.requestFullscreen().then(() => { if (!show) return; show.fs = true; if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock(["Escape"]).catch(() => {}); }).catch(() => {});
    if (navigator.wakeLock) navigator.wakeLock.request("screen").then((l) => (show ? (show.lock = l) : l.release())).catch(() => {});
    const start = viewId ? show.steps.findIndex((s) => s.kind === "view" && s.v.id === viewId) : 0;
    go(Math.max(0, start));
  }
  function exitShow() {
    if (!show) return;
    const s = show; show = null; B.isShow = () => false; document.body.classList.remove("show"); bar.hidden = true;
    if (s.lock) s.lock.release().catch(() => {});
    if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    B.setTool("select");                               // a laser turned on while presenting must not keep drawing instead of selecting
    F = s.F; mode = s.mode; sort = s.sort; activeView = s.activeView;
    applyFilters({ cam: false }); camBefore = s.camBefore; B.setCam(s.cam, 400);
  }
  // the browser left fullscreen: from a focused card we only step back, presenting continues in the window
  document.addEventListener("fullscreenchange", () => { if (!show || !show.fs || document.fullscreenElement) return; if (show.focus) { show.fs = false; unfocus(); } else exitShow(); });
  B.startShow = () => startShow();
  B.showKey = (e) => {
    if (["ArrowRight", "PageDown", " ", "Enter"].includes(e.key)) { go(show.i + 1); return true; }
    if (["ArrowLeft", "PageUp", "Backspace"].includes(e.key)) { go(show.i - 1); return true; }
    if (e.key === "Home") { go(0); return true; }
    if (e.key === "End") { go(show.steps.length - 1); return true; }
    if (e.key === "Escape") { if (show.focus) unfocus(); else exitShow(); return true; }
    return false;
  };
  // click a card while presenting: it fills the screen; another click or Esc returns to the previous camera (video toggles in board.js)
  function unfocus() { const c = show.focus.cam; show.focus = null; B.setCam(c, 450); }
  B.showClick = (id) => {
    if (!show) return;
    if (show.focus) return unfocus();
    const n = id && nodes.get(id); if (!n || !filterable(n) || (n.kind === "file" && (n.mime || "").startsWith("video/"))) return;
    show.focus = { cam: { ...B.cam() } }; B.setCam(B.camFor(B.box(id), false), 450);
  };
  $("#show").addEventListener("click", () => startShow());

  // ---------- search ⌘F ----------
  const sbox = $("#search"), sq = $("#q"), sn = $("#q-n");
  let sOpen = false, hitIds = [], hitCur = -1, curEl = null;
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");   // case- and accent-insensitive
  function searchMark() {
    if (curEl) curEl.classList.remove("cur");
    const id = hitIds[hitCur]; curEl = id ? els.get(id) : null; if (curEl) curEl.classList.add("cur");
    const q = sOpen && sq.value.trim();
    sn.textContent = q ? `${hitIds.length ? hitCur + 1 : 0} / ${hitIds.length}` : ""; sn.classList.toggle("none", !!q && !hitIds.length);
  }
  function searchRun(jump) {
    const q = sOpen ? norm(sq.value.trim()) : "", prev = hitIds[hitCur]; hitIds = [];
    for (const n of nodes.values()) {
      if (!filterable(n)) continue;
      const el = els.get(n.id); if (!el) continue;
      const ok = !!q && !el.classList.contains("out") && !el.classList.contains("dim") && norm([n.text, n.title, n.eyebrow].join("\n")).includes(q);
      el.classList.toggle("hit", ok); el.classList.toggle("sfade", !!q && !ok);
      if (ok) hitIds.push(n.id);
    }
    hitIds.sort((a, b) => { const p = B.box(a), r = B.box(b); return p.x - r.x || p.y - r.y; });
    const i = hitIds.indexOf(prev); hitCur = !hitIds.length ? -1 : jump ? 0 : i >= 0 ? i : Math.min(Math.max(hitCur, 0), hitIds.length - 1);
    searchMark();
  }
  // camera to the current match: fit it whole, but no larger than 110 %
  function searchShow() {
    const id = hitIds[hitCur]; if (!id) return;
    const b = B.box(id), t = B.camFor(b), k = Math.min(t.k, 1.1), cx = t.x + (b.x + b.w / 2) * t.k, cy = t.y + (b.y + b.h / 2) * t.k;
    B.setCam({ k, x: cx - (b.x + b.w / 2) * k, y: cy - (b.y + b.h / 2) * k }, 450);
  }
  function searchStep(d) { if (!hitIds.length) return; hitCur = (hitCur + d + hitIds.length) % hitIds.length; searchMark(); searchShow(); }
  function searchOpen() { sOpen = true; sbox.hidden = false; sq.focus(); sq.select(); searchRun(false); }
  function searchClose() { if (!sOpen) return; sOpen = false; sbox.hidden = true; sq.value = ""; if (document.activeElement === sq) sq.blur(); searchRun(false); }
  const searchSoon = () => { if (!sOpen) return; cancelAnimationFrame(searchSoon.t); searchSoon.t = requestAnimationFrame(() => searchRun(false)); };
  B.hooks.push(searchSoon);
  sq.addEventListener("input", () => { searchRun(true); searchShow(); });
  sq.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); searchStep(e.shiftKey ? -1 : 1); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); searchStep(e.key === "ArrowDown" ? 1 : -1); }
    else if (e.key === "Escape") { e.preventDefault(); searchClose(); }
  });
  $("#q-next").addEventListener("click", () => searchStep(1)); $("#q-prev").addEventListener("click", () => searchStep(-1)); $("#q-x").addEventListener("click", searchClose);
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === "KeyF") { if (B.isShow()) return; e.preventDefault(); searchOpen(); }
    else if (e.key === "Escape" && sOpen && !typing()) searchClose();
  });

  // ---------- minimap ----------
  const mm = $("#mm"), mc = $("#mm-c"), mt = $("#mm-t"), MW = 200, MH = 140;
  let mmOn = B.lsGet("board-mm", true), mmCol = null, mmMap = null, mmFrozen = null, mmRaf = 0;
  function mmColors() { const cs = getComputedStyle(document.documentElement), v = (k) => cs.getPropertyValue(k).trim(); mmCol = { mute: v("--mute"), sel: v("--sel"), soft: v("--sel-soft"), t: Array.from({ length: 10 }, (_, i) => v("--t" + (i + 1))) }; }
  function mmDraw() {
    mmRaf = 0;
    if (!mmOn || document.body.classList.contains("show") || innerWidth < 720) return;
    if (!mmCol) mmColors();
    const dpr = window.devicePixelRatio || 1, cw = Math.round(MW * dpr), ch = Math.round(MH * dpr);
    if (mc.width !== cw || mc.height !== ch) { mc.width = cw; mc.height = ch; }
    const x = mc.getContext("2d"), cam = B.cam(), kz = cam.k, vr = { x: -cam.x / kz, y: -cam.y / kz, w: innerWidth / kz, h: innerHeight / kz }, items = [];
    for (const n of nodes.values()) {
      if (n.kind === "group" || n.kind === "arrow") continue;
      const el = els.get(n.id); if (!el || el.classList.contains("out")) continue;
      const b = B.box(n.id); if (b) items.push({ n, b, dim: el.classList.contains("dim") });
    }
    const bd = B.union([vr, ...items.map((i) => (i.n.kind === "frame" ? { x: i.b.x, y: i.b.y - 90, w: i.b.w, h: i.b.h + 90 } : i.b))]), P = 6;
    if (!mmFrozen) { const s = Math.min((MW - 2 * P) / (bd.w || 1), (MH - 2 * P) / (bd.h || 1)); mmMap = { x0: bd.x, y0: bd.y, s, px: (MW - bd.w * s) / 2, py: (MH - bd.h * s) / 2 }; }
    const m = mmFrozen || mmMap, X = (wx) => m.px + (wx - m.x0) * m.s, Y = (wy) => m.py + (wy - m.y0) * m.s;
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, MW, MH);
    x.lineWidth = 1; x.strokeStyle = mmCol.mute;
    for (const i of items) if (i.n.kind === "frame") { x.globalAlpha = i.dim ? .25 : .7; x.strokeRect(X(i.b.x) + .5, Y(i.b.y) + .5, i.b.w * m.s, i.b.h * m.s); }
    for (const i of items) {
      if (i.n.kind === "frame") continue;
      const t = B.axisVal("type", i.n.type);
      x.globalAlpha = i.dim ? .18 : t ? .85 : .5; x.fillStyle = t ? mmCol.t[(t.c - 1) % 10] || mmCol.mute : mmCol.mute;
      x.fillRect(X(i.b.x), Y(i.b.y), Math.max(1.5, i.b.w * m.s), Math.max(1.5, i.b.h * m.s));
    }
    x.globalAlpha = 1; x.fillStyle = mmCol.soft; x.strokeStyle = mmCol.sel; x.lineWidth = 1.5;
    x.fillRect(X(vr.x), Y(vr.y), vr.w * m.s, vr.h * m.s); x.strokeRect(X(vr.x), Y(vr.y), vr.w * m.s, vr.h * m.s);
  }
  const mmSoon = () => { if (!mmRaf) mmRaf = requestAnimationFrame(mmDraw); };
  B.hooks.push(mmSoon); B.camHooks.push(mmSoon);
  // click or drag on the minimap: the window centre moves there at the same zoom; the map is frozen during the gesture
  function mmPan(e, ms) {
    const r = mc.getBoundingClientRect(), m = mmFrozen || mmMap; if (!m) return;
    const wx = (e.clientX - r.left - m.px) / m.s + m.x0, wy = (e.clientY - r.top - m.py) / m.s + m.y0, k = B.cam().k;
    B.setCam({ k, x: innerWidth / 2 - wx * k, y: innerHeight / 2 - wy * k }, ms);
  }
  mc.addEventListener("pointerdown", (e) => { if (e.button !== 0 || !mmMap) return; e.preventDefault(); try { mc.setPointerCapture(e.pointerId); } catch (x) {} mmFrozen = mmMap; mmPan(e, 180); });
  mc.addEventListener("pointermove", (e) => { if (mmFrozen) mmPan(e, 0); });
  const mmUp = () => { if (!mmFrozen) return; mmFrozen = null; mmSoon(); };
  mc.addEventListener("pointerup", mmUp); mc.addEventListener("pointercancel", mmUp);
  function mmApply() { mm.classList.toggle("min", !mmOn); mt.textContent = mmOn ? "−" : "Map"; const t = mmOn ? "Collapse minimap" : "Show minimap"; mt.title = t; mt.setAttribute("aria-label", t); mmSoon(); }
  mt.addEventListener("click", () => { mmOn = !mmOn; B.lsSet("board-mm", mmOn); mmApply(); mt.blur(); });
  $("#theme").addEventListener("click", () => { mmCol = null; mmSoon(); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { mmCol = null; mmSoon(); });
  window.addEventListener("resize", mmSoon);
  mmApply();
  renderLeft();
})();
