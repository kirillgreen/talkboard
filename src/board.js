// Canvas core: nodes, camera, selection, editing, undo, saving. Filters, views and presentation live in filters.js.
const $ = (s, r = document) => r.querySelector(s);
const B = window.Board = {};
const vp = $("#vp"), world = $("#world"), lFrames = $("#l-frames"), lArrows = $("#l-arrows"), lItems = $("#l-items"), handlesEl = $("#handles");
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Card markdown: HTML is escaped first, then blocks (#, lists) and inline marks; links are http(s) only. Plain lines stay as they are (pre-wrap).
function inl(s) {
  const st = [], hold = (h) => "\u0000" + (st.push(h) - 1) + "\u0000";
  const em = (t) => t.replace(/\*\*([^*]+?)\*\*/g, "<b>$1</b>").replace(/(^|[^*\w])\*([^*\s](?:[^*\n]*?[^*\s])?)\*(?![*\w])/g, "$1<i>$2</i>").replace(/(^|\W)_([^_\s](?:[^_\n]*?[^_\s])?)_(?!\w)/g, "$1<i>$2</i>");
  s = s.replace(/\u0000/g, "").replace(/`([^`\n]+?)`/g, (_, c) => hold("<code>" + c + "</code>"));
  s = s.replace(/\[([^\]\n]+?)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => hold(`<a href="${u}" target="_blank" rel="noopener">${em(t)}</a>`));
  s = s.replace(/https?:\/\/[^\s\u0000]+/g, (u) => { const k = u.search(/&(?:lt|gt|quot);/); let t = k >= 0 ? u.slice(0, k) : u; t = t.replace(/[.,;:!?)\]]+$/, ""); return t.length > 8 ? hold(`<a href="${t}" target="_blank" rel="noopener">${t}</a>`) + u.slice(t.length) : u; });
  s = em(s);
  for (let i = 0; i < 3 && s.includes("\u0000"); i++) s = s.replace(/\u0000(\d+)\u0000/g, (_, j) => st[j]);
  return s;
}
function md(s) {
  const out = []; let txt = [], list = null;
  const fT = () => { if (txt.length) out.push(inl(esc(txt.join("\n")))); txt = []; };
  const fL = () => { if (list) out.push(`<${list.t}${list.s > 1 ? ` start="${list.s}"` : ""}>` + list.i.map((x) => "<li>" + inl(esc(x)) + "</li>").join("") + `</${list.t}>`); list = null; };
  for (const ln of String(s).split("\n")) {
    let m;
    if ((m = /^(#{1,3}) +(\S.*)$/.exec(ln))) { fT(); fL(); out.push(`<h${m[1].length}>${inl(esc(m[2]))}</h${m[1].length}>`); }
    else if ((m = /^(?:([-*])|(\d+)\.) +(\S.*)$/.exec(ln))) { fT(); const t = m[1] ? "ul" : "ol"; if (list && list.t !== t) fL(); if (!list) list = { t, s: +m[2] || 1, i: [] }; list.i.push(m[3]); }
    else { fL(); txt.push(ln); }
  }
  fT(); fL(); return out.join("");
}
const LOCAL = !!window.__boardLocal;   // served by the local server: data on disk
const blobSrc = (id) => (window.__mockBlob && window.__mockBlob[id]) || "/_blob/" + id;
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const SVGNS = "http://www.w3.org/2000/svg";
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Every card can carry a value on three axes the board's owner defines in Board settings (stored in meta/axes):
// zone – where it belongs (a frame passes its zone to whatever lies inside it), type – what it is, status – how far along it is.
const AXES = ["zone", "type", "status"];
const DEFAULT_AXES = {
  zone: { label: "Section", values: [] },
  type: { label: "Type", values: [{ id: "idea", label: "idea", c: 1 }, { id: "example", label: "example", c: 5 }, { id: "tool", label: "tool", c: 2 }, { id: "task", label: "task", c: 7 }, { id: "note", label: "note", c: 6 }] },
  status: { label: "Status", values: [{ id: "draft", label: "draft", c: 4 }, { id: "ready", label: "ready", c: 1 }] },
};
Object.assign(B, { AXES, md, esc, uid, clone, lsGet, lsSet, $ });

const nodes = B.nodes = new Map();
const els = new Map(), H = new Map();          // id → DOM; id → measured text height
let cam = lsGet("board-cam", null);
const camSaved = !!cam && [cam.x, cam.y, cam.k].every(Number.isFinite) && cam.k > 0;   // decided before applyCam() below writes the default back
if (!camSaved) cam = { x: 300, y: 120, k: .6 };   // a broken saved camera must not break the board
let sel = new Set(), scope = null;             // selected nodes; the group entered with a double click
let tool = "select", spaceDown = false, editing = null;
let db = null, assets = null, canWrite = true;
B.layout = null;                               // Map id → {x,y,w,h}: the sorted layout, never touches node positions
B.axes = clone(DEFAULT_AXES);
B.axisVal = (k, id) => (id ? B.axes[k].values.find((v) => v.id === id) : undefined);
B.afterRender = () => {}; B.onSelection = () => {}; B.onData = () => {};
B.isShow = () => false; B.showKey = () => false; B.showClick = () => {};
// Separate hooks: filters.js overrides B.afterRender, so search, minimap and previews attach here.
const afterAll = () => { B.afterRender(); for (const f of B.hooks) f(); };
B.hooks = []; B.camHooks = [];

// ---------- image previews: ?w=800 → ?w=1600 → original, never back down ----------
const isPreview = (n) => LOCAL && n.kind === "image" && n.asset && !n._blob && !(window.__mockBlob && window.__mockBlob[n.asset]);
const imgLv = (n) => { const w = ((B.layout && B.layout.get(n.id)) || n).w * cam.k * (window.devicePixelRatio || 1); return w > 1600 ? 2 : w > 800 ? 1 : 0; };
const previewSrc = (id, lv) => (lv >= 2 ? "/_blob/" + id : "/_blob/" + id + "?w=" + (lv ? 1600 : 800));
function previewPass() {
  for (const n of nodes.values()) {
    if (!isPreview(n)) continue;
    const el = els.get(n.id), lv = imgLv(n); if (!el || lv <= (el._lv || 0)) continue;
    el._lv = lv; const s = previewSrc(n.asset, lv), img = el.firstChild; if (img.getAttribute("src") !== s) img.setAttribute("src", s);
  }
}
const previewSoon = () => { clearTimeout(previewSoon.t); previewSoon.t = setTimeout(previewPass, 200); };
B.hooks.push(previewSoon); B.camHooks.push(previewSoon);

// ---------- geometry ----------
function childrenMap() {
  const m = new Map();
  for (const n of nodes.values()) if (n.parent) { if (!m.has(n.parent)) m.set(n.parent, []); m.get(n.parent).push(n.id); }
  return m;
}
function leaves(id, kids = childrenMap()) {
  const n = nodes.get(id); if (!n) return [];
  if (n.kind !== "group") return [id];
  return (kids.get(id) || []).flatMap((c) => leaves(c, kids));
}
function chain(id) { const out = []; let n = nodes.get(id), guard = 0; while (n && guard++ < 50) { out.unshift(n.id); n = n.parent ? nodes.get(n.parent) : null; } return out; }
function topFor(id, deep) {
  if (deep) return id;
  const c = chain(id);
  if (scope) { const i = c.indexOf(scope); if (i >= 0 && i + 1 < c.length) return c[i + 1]; }
  return c[0];
}
const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const point = (p) => ({ x: p.x, y: p.y, w: 0, h: 0 });
function edge(b, toward, gap) {
  const c = center(b), dx = toward.x - c.x, dy = toward.y - c.y, len = Math.hypot(dx, dy) || 1;
  const t = Math.min(dx ? (b.w / 2) / Math.abs(dx) : Infinity, dy ? (b.h / 2) / Math.abs(dy) : Infinity);
  return { x: c.x + dx * (t === Infinity ? 0 : t) + (dx / len) * gap, y: c.y + dy * (t === Infinity ? 0 : t) + (dy / len) * gap };
}
function rawBox(n) {
  const o = B.layout && B.layout.get(n.id);
  if (n.kind === "text") return { x: o ? o.x : n.x, y: o ? o.y : n.y, w: o ? o.w : n.w, h: o ? o.h : H.get(n.id) || 60 };
  return { x: o ? o.x : n.x, y: o ? o.y : n.y, w: o ? o.w : n.w, h: o ? o.h : n.h };
}
function arrowPts(a) {
  let p1 = { x: a.x1, y: a.y1 }, p2 = { x: a.x2, y: a.y2 };
  const n1 = a.from && nodes.get(a.from), n2 = a.to && nodes.get(a.to);
  const b1 = n1 && rawBox(n1), b2 = n2 && rawBox(n2);
  const c1 = b1 ? center(b1) : p1, c2 = b2 ? center(b2) : p2;
  if (b1) p1 = edge(b1, c2, 8);
  if (b2) p2 = edge(b2, c1, 10);
  return [p1, p2];
}
function union(list) {
  list = list.filter(Boolean); if (!list.length) return null;
  const x = Math.min(...list.map((b) => b.x)), y = Math.min(...list.map((b) => b.y));
  return { x, y, w: Math.max(...list.map((b) => b.x + b.w)) - x, h: Math.max(...list.map((b) => b.y + b.h)) - y };
}
function box(id, kids) {
  const n = nodes.get(id); if (!n) return null;
  if (n.kind === "group") return union(leaves(id, kids || childrenMap()).map((l) => box(l, kids)));
  if (n.kind === "arrow") { const [a, b] = arrowPts(n); return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }; }
  return rawBox(n);
}
const hits = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
const toWorld = (sx, sy) => ({ x: (sx - cam.x) / cam.k, y: (sy - cam.y) / cam.k });
const maxZ = () => { let m = 0; for (const n of nodes.values()) m = Math.max(m, n.z || 0); return m; };
const minZ = () => { let m = 0; for (const n of nodes.values()) m = Math.min(m, n.z || 0); return m; };
function frameContents(f) {
  const fb = rawBox(f), out = [];
  for (const n of nodes.values()) {
    if (n.id === f.id || n.kind === "group") continue;
    if (n.kind === "frame") { const b = rawBox(n); if (b.w * b.h < fb.w * fb.h && inside(point(center(b)), fb)) out.push(n.id); continue; }
    if (n.kind === "arrow") {
      if (n.from && n.to) continue;                    // both ends follow their items on their own
      const p = n.from ? { x: n.x2, y: n.y2 } : { x: n.x1, y: n.y1 };
      if (inside(point(p), fb)) out.push(n.id);
      continue;
    }
    if (inside(point(center(rawBox(n))), fb)) out.push(n.id);
  }
  return out;
}

// ---------- rendering ----------
const typeOf = (n) => B.axisVal("type", n.type);
// a frame inside a frame is drawn above the larger one, otherwise the larger background hides its title
function orderFrames() {
  const fr = [...lFrames.children], N = (el) => nodes.get(el.dataset.id), area = (el) => { const n = N(el); return n ? (n.w || 0) * (n.h || 0) : 0; };
  const s = [...fr].sort((a, b) => area(b) - area(a));
  if (s.some((el, i) => el !== fr[i])) s.forEach((el) => lFrames.append(el));
  // a frame whose centre lies in a larger frame is nested: its title is regular size (board.css, .fr.nested)
  for (const el of fr) {
    const n = N(el); if (!n) continue;
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2, a = area(el);
    el.classList.toggle("nested", fr.some((o) => { const m = N(o); return m && m !== n && area(o) > a && cx >= m.x && cx <= m.x + m.w && cy >= m.y && cy <= m.y + m.h; }));
  }
}
function renderNode(id) {
  const n = nodes.get(id); let el = els.get(id);
  if (!n || n.kind === "group") { if (el) { el.remove(); els.delete(id); H.delete(id); } return; }
  if (n.kind === "arrow") return renderArrow(n);
  if (!el) {
    el = document.createElement("div"); el.dataset.id = id;
    if (n.kind === "frame") { el.className = "fr"; el.innerHTML = '<div class="f-title" data-part="title"><b></b><i></i></div><div class="f-edge t"></div><div class="f-edge b"></div><div class="f-edge l"></div><div class="f-edge r"></div>'; lFrames.append(el); }
    else if (n.kind === "image") { el.className = "n image"; el.innerHTML = '<img alt="" decoding="async" draggable="false">'; lItems.append(el); }
    else if (n.kind === "file") { el.className = "n file"; lItems.append(el); }
    else { el.className = "n text"; el.innerHTML = '<div class="c-eyebrow" hidden></div><div class="c-meta"></div><div class="body"></div>'; lItems.append(el); }
    els.set(id, el);
  }
  if (n.kind === "frame") {
    el.querySelector("b").textContent = n.title || "Frame";
    el.querySelector("i").textContent = n.note || "";
    orderFrames();
  } else if (n.kind === "image") {
    const img = el.firstChild; let src = n._blob || (n.asset ? blobSrc(n.asset) : "");
    if (isPreview(n)) { el._lv = Math.max(el._lv || 0, imgLv(n)); src = previewSrc(n.asset, el._lv); }   // upwards only: never replace a larger image already loaded
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    img.alt = n.title || "";
    el.classList.toggle("loading", !!n._local);
  } else if (n.kind === "file") {
    renderFile(n, el);
  } else if (editing !== id) {
    const card = n.style === "card", t = typeOf(n);
    el.classList.toggle("card", card); el.classList.toggle("plain", !card);
    const body = el.querySelector(".body"), key = n.text + "|" + n.fs;
    if (el._key !== key) { body.innerHTML = md(n.text || ""); body.style.fontSize = (n.fs || 18) + "px"; el._key = key; }
    const meta = el.querySelector(".c-meta"), m = [];
    if (card && t) m.push(`<span class="c-type" style="--tc:var(--t${t.c})">${esc(t.label)}</span>`);
    const z = card && B.axisVal("zone", n.zone); if (z) m.push(`<span>${esc(z.label)}</span>`);
    const st = card && B.axisVal("status", n.status); if (st) m.push(`<span class="c-badge" style="--tc:var(--t${st.c})">${esc(st.label)}</span>`);
    if (card && n.noshow) m.push('<span class="c-badge">hidden when presenting</span>');
    const mh = m.join(""); if (meta.innerHTML !== mh) meta.innerHTML = mh;
    const eb = el.querySelector(".c-eyebrow"); eb.hidden = !(card && n.eyebrow); if (!eb.hidden) eb.textContent = n.eyebrow;
  }
  el.classList.toggle("noshow", !!n.noshow);
  place(id);
}
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
const extOf = (name) => { const m = /\.([a-z0-9]{1,5})$/i.exec(name || ""); return m ? m[1].toUpperCase() : "FILE"; };
function renderFile(n, el) {
  const src = n._blob || (n.asset ? blobSrc(n.asset) : ""), video = (n.mime || "").startsWith("video/");
  const key = [src, n.title, n.size, n.mime].join("|");
  if (el._key !== key) {
    el._key = key;
    el.classList.toggle("video", video);
    if (video) el.innerHTML = `<video muted playsinline loop preload="metadata"${src ? ` src="${esc(src)}"` : ""}></video><span class="f-play" aria-hidden="true">▶</span><span class="f-cap">${esc(n.title || "video")}</span>`;
    else el.innerHTML = `<div class="f-ico">${esc(extOf(n.title))}</div><div class="f-txt"><b>${esc(n.title || "file")}</b><i>${esc([extOf(n.title), n.size ? fmtSize(n.size) : ""].filter(Boolean).join(" · "))}</i></div>${src && !n._local ? `<a class="f-open" href="${esc(src)}" target="_blank" rel="noopener">Open</a>` : ""}`;
  }
  el.classList.toggle("loading", !!n._local);
}
function toggleVideo(id) {
  const el = els.get(id), v = el && el.querySelector("video"); if (!v) return false;
  if (v.paused) { v.play().then(() => el.classList.add("playing")).catch(() => {}); } else { v.pause(); el.classList.remove("playing"); }
  return true;
}
function place(id) {
  const n = nodes.get(id), el = els.get(id); if (!n || !el) return;
  const o = B.layout && B.layout.get(id);
  el.style.transform = `translate(${o ? o.x : n.x}px,${o ? o.y : n.y}px)`;
  el.style.width = (o ? o.w : n.w) + "px";
  if (n.kind !== "text") el.style.height = (o ? o.h : n.h) + "px";
  if (n.kind !== "frame") el.style.zIndex = Math.round((n.z || 0) * 10) + 100000;
}
// height of a frame's title above its top edge (.f-title in board.css): the camera keeps it in view
const frameHead = (n) => { const el = els.get(n.id); return el && el.classList.contains("nested") ? 80 : 230; };
function renderArrow(a) {
  let g = els.get(a.id);
  if (!g) {
    g = document.createElementNS(SVGNS, "g"); g.setAttribute("class", "a"); g.dataset.id = a.id;
    g.innerHTML = '<path class="hit"/><path class="line"/><polygon/>'; lArrows.append(g); els.set(a.id, g);
  }
  const [p, q] = arrowPts(a), d = `M${p.x} ${p.y}L${q.x} ${q.y}`;
  g.children[0].setAttribute("d", d); g.children[1].setAttribute("d", d);
  if (a.head === false) g.children[2].setAttribute("points", "");
  else { const ang = Math.atan2(q.y - p.y, q.x - p.x), s = 13, mk = (t) => `${q.x - Math.cos(t) * s},${q.y - Math.sin(t) * s}`; g.children[2].setAttribute("points", `${q.x},${q.y} ${mk(ang - .42)} ${mk(ang + .42)}`); }
  g.classList.toggle("noshow", !!a.noshow);
}
function redrawArrowsFor(ids) { for (const n of nodes.values()) if (n.kind === "arrow" && (ids.has(n.from) || ids.has(n.to) || ids.has(n.id))) renderArrow(n); }
function measure(ids) { for (const id of ids) { const n = nodes.get(id), el = els.get(id); if (n && n.kind === "text" && el) { const h = el.offsetHeight; if (h) H.set(id, h); } } }   // hidden (display:none) measures 0: keep the old height
const renderArrows = () => { for (const n of nodes.values()) if (n.kind === "arrow") renderArrow(n); };
function renderAll() {
  for (const id of [...els.keys()]) if (!nodes.has(id)) renderNode(id);
  for (const id of nodes.keys()) renderNode(id);
  measure(nodes.keys());
  for (const n of nodes.values()) if (n.kind === "arrow") renderArrow(n);
  afterAll(); updateOverlay(); updateEmpty();
}
function updateEmpty() {
  const e = $("#empty");
  if (nodes.size) { e.hidden = true; return; }
  if (!B.loaded) return;
  e.hidden = false; $("#empty-t").textContent = "The board is empty";
  $("#empty-s").textContent = "Double-click to add text. Paste or drop an image. F draws a frame, L an arrow.";
}
function applyCam() {
  world.style.transform = `translate(${cam.x}px,${cam.y}px) scale(${cam.k})`;
  // the dot grid stays still: zoom and pan move only the content
  $("#z-val").textContent = Math.round(cam.k * 100) + "%";
  updateOverlay(); for (const f of B.camHooks) f();
  world.classList.add("moving"); clearTimeout(applyCam.t);
  applyCam.t = setTimeout(() => { world.classList.remove("moving"); lsSet("board-cam", cam); }, 250);
}
function zoomAt(sx, sy, f) { const k = Math.min(4, Math.max(.04, cam.k * f)), w = toWorld(sx, sy); cam.k = k; cam.x = sx - w.x * k; cam.y = sy - w.y * k; applyCam(); }
let camAnim = 0;
function animateTo(target, ms = 650) {
  cancelAnimationFrame(camAnim);
  if (!target || ![target.x, target.y, target.k].every(Number.isFinite) || target.k <= 0) return;
  if (reduced || !ms) { cam = target; applyCam(); return; }
  const s = { ...cam }, t0 = performance.now(), ease = (t) => 1 - Math.pow(1 - t, 3);
  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms), e = ease(p), lk = Math.log(s.k) + (Math.log(target.k) - Math.log(s.k)) * e;
    cam = { x: s.x + (target.x - s.x) * e, y: s.y + (target.y - s.y) * e, k: Math.exp(lk) };
    applyCam(); if (p < 1) camAnim = requestAnimationFrame(step);
  };
  camAnim = requestAnimationFrame(step);
}
function camFor(b, chrome = true) {
  const W = innerWidth, Ht = innerHeight, narrow = W <= 720;   // the same breakpoint as the narrow layout in CSS
  // the inspector on the left and the filter panel on the right cover the canvas: the camera keeps clear of them
  const lp = $("#left"), ins = $("#insp"), padL = chrome && !narrow && !ins.hidden ? ins.offsetWidth + 24 : 40, padR =chrome && !narrow && !lp.hidden && !lp.classList.contains("shut") ? 270 : 40, padT = chrome ? 80 : 40, padB = chrome ? 80 : 40;
  const k = Math.min(3, Math.max(.04, Math.min((W - padL - padR) / (b.w || 1), (Ht - padT - padB) / (b.h || 1))));
  return { k, x: padL + (W - padL - padR - b.w * k) / 2 - b.x * k, y: padT + (Ht - padT - padB - b.h * k) / 2 - b.y * k };
}
function fitAll(ms = 400) {
  const list = [...nodes.values()].filter((n) => n.kind !== "group" && (!els.get(n.id) || !els.get(n.id).classList.contains("out")) && !(B.isShow() && n.noshow));
  const b = union(list.map((n) => { const bb = box(n.id); if (n.kind === "frame") { const t = frameHead(n); bb.y -= t; bb.h += t; } return bb; }));
  if (b) animateTo(camFor(b, !B.isShow()), ms);
}
Object.assign(B, { frameHead, cam: () => cam, setCam: animateTo, camFor, fitAll, box, rawBox, renderAll, renderNode, place, updateOverlay: () => updateOverlay(), measure, renderArrows, els, H, union, select: (ids) => setSel(ids), selection: () => sel });

// ---------- transactions and undo ----------
const undoS = [], redoS = []; let cur = null;
// the undo stack survives a tab reload (new code version): it lives in this tab's sessionStorage
try { const s = JSON.parse(sessionStorage.getItem("board-undo") || "null"); if (s) { s.u.forEach((e) => undoS.push(new Map(e))); s.r.forEach((e) => redoS.push(new Map(e))); } } catch (e) {}
addEventListener("pagehide", () => { try { sessionStorage.setItem("board-undo", JSON.stringify({ u: undoS.slice(-100).map((e) => [...e]), r: redoS.slice(-100).map((e) => [...e]) })); } catch (e) {} });
const stripLocal = (n) => { const o = {}; for (const k in n) if (!k.startsWith("_")) o[k] = n[k]; return clone(o); };
function touch(id) { if (cur && !cur.has(id)) { const n = nodes.get(id); cur.set(id, n ? stripLocal(n) : null); } }
function put(n) { touch(n.id); nodes.set(n.id, n); }
function patch(id, p) { touch(id); const n = nodes.get(id); if (n) Object.assign(n, p); }
function del(id) { touch(id); nodes.delete(id); }
function tx(fn, opts = {}) {
  if (!canWrite) { toast("Read-only: changes will not be saved"); return; }
  cur = new Map(); try { fn(); } finally { const t = cur; cur = null; finishTx(t, opts); }
}
function finishTx(t, opts) {
  const entry = new Map();
  for (const [id, before] of t) { const n = nodes.get(id), after = n ? stripLocal(n) : null; if (JSON.stringify(before) !== JSON.stringify(after)) entry.set(id, { before, after }); }
  if (!entry.size) return;
  if (!opts.noUndo) { undoS.push(entry); if (undoS.length > 300) undoS.shift(); redoS.length = 0; }
  applyTouched(entry.keys()); entry.forEach((_, id) => enqueue(id)); refreshUndoBtns();
}
function applyTouched(ids) {
  ids = [...ids]; ids.forEach(renderNode); measure(ids); orderFrames();   // a frame was removed or moved: nesting of its neighbours may have changed
  for (const n of nodes.values()) if (n.kind === "arrow") renderArrow(n);
  for (const id of [...sel]) if (!nodes.has(id)) sel.delete(id);
  if (scope && !nodes.has(scope)) scope = null;
  afterAll(); updateOverlay(); B.onSelection(); updateEmpty();
}
function undoRedo(from, to, key) {
  const e = from.pop(); if (!e) return; to.push(e);
  for (const [id, v] of e) { const val = v[key]; if (val) nodes.set(id, clone(val)); else nodes.delete(id); enqueue(id); }
  applyTouched(e.keys()); refreshUndoBtns();
  // an edit you can't see right now (filtered out, or in place while Collect is open): say so, so ⌘Z isn't pressed again
  const moved = (v) => v.before && v.after && ["x", "y", "w", "h", "x1", "y1", "x2", "y2"].some((k) => v.before[k] !== v.after[k]);
  let hid = 0; for (const [id, v] of e) { const n = nodes.get(id) || v.before || v.after; if ((B.hiddenNow && B.hiddenNow(n)) || (B.layout && moved(v))) hid++; }
  if (hid) toast(`${key === "before" ? "Undone" : "Redone"}: ${hid} of ${e.size} not visible ${B.layout ? "in Collect, switch to In place" : "under the filter"}`);
}
function refreshUndoBtns() { $("#undo").disabled = !undoS.length; $("#redo").disabled = !redoS.length; }
Object.assign(B, { tx, patch, put, del, childrenMap, leaves, undo: () => undoRedo(undoS, redoS, "before"), redo: () => undoRedo(redoS, undoS, "after") });

// ---------- saving: one document per item, only changed fields are written ----------
// retry: writes waiting to be repeated after a connection failure; they count as unsaved for the journal, status and tab close
const server = new Map(), dirty = new Set(), active = new Set(), guard = new Map(), attempts = new Map(), retry = new Set(), recent = new Map();
const MAXC = 8, COL = "elements"; let pumpT = 0, lastSaved = 0, errorState = "";
const toDoc = (n) => { const o = stripLocal(n); delete o.id; return o; };
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const sorted = (o) => { const r = {}; Object.keys(o || {}).sort().forEach((k) => (r[k] = o[k])); return r; };
const unsaved = () => new Set([...dirty, ...active, ...retry]);
const uploading = () => { for (const n of nodes.values()) if (n._local) return true; return false; };
// The unsaved journal survives closing the tab. base is the disk version the edit started from: if the file changed since, the edit is not replayed.
// Tabs share one key: each rewrites only its own entries.
const TAB = uid("tab");
function journalWrite() {
  const old = lsGet("board-journal", null), items = {}, now = Date.now();
  if (old && old.v === 2) for (const id in old.items) { const it = old.items[id]; if (it.tab !== TAB && now - it.at < 864e5) items[id] = it; }
  for (const id of unsaved()) { const n = nodes.get(id); if (n && n._local) continue; const b = server.get(id); items[id] = { tab: TAB, at: now, base: b === undefined ? null : b, body: n ? toDoc(n) : null }; }
  lsSet("board-journal", { v: 2, items });
}
function journalReplay(changed) {
  const j = lsGet("board-journal", null); if (!j || j.v !== 2) return;
  let stale = 0;
  for (const id in j.items) {
    const it = j.items[id], disk = server.get(id); if (Date.now() - it.at > 864e5) continue;
    if (it.body ? disk !== undefined && same(disk, it.body) : disk === undefined) continue;              // already on disk
    if (it.base === null ? disk !== undefined : disk === undefined || !same(disk, it.base)) { stale++; continue; }   // the file changed after the edit: disk wins
    if (it.body) nodes.set(id, { ...clone(it.body), id }); else nodes.delete(id);
    changed.push(id); enqueue(id);
  }
  lsSet("board-journal", { v: 2, items: {} });
  if (stale) setTimeout(() => toast(`${stale} unsaved edit(s) not restored: those items changed on disk since`), 800);
}
function enqueue(id) { dirty.add(id); clearTimeout(pumpT); pumpT = setTimeout(pump, 220); clearTimeout(enqueue.j); enqueue.j = setTimeout(journalWrite, 60); showStatus(); }
function pump() {
  if (!db) return;
  for (const id of [...dirty]) {
    if (active.size >= MAXC) break;
    if (active.has(id)) continue;                      // one write in flight per document
    dirty.delete(id); active.add(id);
    writeOne(id).finally(() => { active.delete(id); journalWrite(); pump(); showStatus(); });
  }
}
async function writeOne(id) {
  const n = nodes.get(id); if (n && n._local) return;
  const ref = db.collection(COL).doc(id), srv = server.get(id);
  let body = null;
  try {
    if (!n) { if (srv !== undefined) { await ref.delete(); server.delete(id); } }
    else {
      body = toDoc(n);
      if (srv === undefined) await ref.set(body);
      else {
        const removed = Object.keys(srv).some((k) => !(k in body)), diff = {};
        for (const k in body) if (JSON.stringify(body[k]) !== JSON.stringify(srv[k])) diff[k] = body[k];
        if (removed) await ref.set(body); else if (Object.keys(diff).length) await ref.update(diff); else { attempts.delete(id); return; }
      }
      server.set(id, body);
    }
    attempts.delete(id); errorState = ""; lastSaved = Date.now(); guardFor(id, body);
  } catch (e) {
    const c = e && e.code;
    if (c === "invalid_argument" || c === "not_granted" || c === "revoked") { canWrite = false; errorState = "Read-only"; console.error(e); return; }
    if (c === "quota_exceeded") { errorState = "Storage is full"; console.error(e); return; }
    const a = (attempts.get(id) || 0) + 1; attempts.set(id, a); errorState = "Offline, retrying"; retry.add(id);
    setTimeout(() => { retry.delete(id); dirty.add(id); pump(); showStatus(); }, Math.min(15000, 500 * 2 ** a) + Math.random() * 300);
  }
}
// for 2.5 s after a write we remember what we sent: an echo of our own write (even a late one) is not someone else's edit
function guardFor(id, body) {
  clearTimeout(guard.get(id));
  if (body) { const r = recent.get(id) || []; r.push(JSON.stringify(sorted(body))); recent.set(id, r.slice(-6)); }
  guard.set(id, setTimeout(() => { guard.delete(id); recent.delete(id); }, 2500));
}
function showStatus() {
  const n = unsaved().size, s = $("#status");
  s.classList.toggle("err", !!errorState);
  if (errorState) s.textContent = errorState + (n ? ` · ${n}` : "");
  else if (n) s.textContent = `Saving · ${n}`;
  else if (lastSaved) s.textContent = "Saved " + new Date(lastSaved).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  else s.textContent = canWrite ? "All saved" : "Read-only";
}
window.addEventListener("beforeunload", (e) => { journalWrite(); if (unsaved().size || uploading()) { e.preventDefault(); e.returnValue = ""; } });
// An outside edit (a script, git pull, another tab) arrived while ours is in flight: take its fields that we didn't change ourselves.
// Otherwise our write would send stale values for those fields and overwrite the outside edit on disk.
function merge3(n, prev, d) {
  const mine = toDoc(n); let ch = false;
  for (const k of new Set([...Object.keys(prev || {}), ...Object.keys(d)])) {
    const was = JSON.stringify(prev ? prev[k] : undefined), now = JSON.stringify(d[k]);
    if (was === now || JSON.stringify(mine[k]) !== was) continue;     // the field didn't change outside, or we are editing it: ours wins
    if (d[k] === undefined) delete n[k]; else n[k] = clone(d[k]);
    ch = true;
  }
  return ch;
}
function applySnapshot(snap) {
  const changed = [];
  for (const c of snap.docChanges()) {
    const id = c.doc.id, pending = c.doc.metadata && c.doc.metadata.hasPendingWrites, mine = dirty.has(id) || active.has(id) || retry.has(id) || editing === id;
    if (c.type === "removed") {
      if (!pending) server.delete(id);
      if (mine) continue;                                             // our edit is in flight: it decides whether the item lives
      if (nodes.has(id)) { nodes.delete(id); changed.push(id); }
      continue;
    }
    const d = c.doc.data();
    if (guard.has(id) && (recent.get(id) || []).includes(JSON.stringify(sorted(d)))) continue;   // echo of our own write
    const prev = server.get(id), n = nodes.get(id);
    if (!pending) server.set(id, clone(d));
    if (mine) { if (n && merge3(n, prev, d)) { changed.push(id); if (active.has(id)) enqueue(id); } continue; }   // no node: we deleted it, the delete is in flight
    if (!n || !same(toDoc(n), d)) { nodes.set(id, { ...clone(d), id }); changed.push(id); }
  }
  return changed;
}
async function boot() {
  const timer = setTimeout(() => { if (!B.loaded) { $("#empty-t").textContent = "The server is not answering yet"; $("#empty-s").textContent = "The board opens by itself once it connects."; } }, 10000);
  if (!window.boardStore) { $("#empty-t").textContent = "No storage"; $("#empty-s").textContent = "Start the board with bun server/server.ts."; return; }
  db = window.boardStore.db; assets = window.boardStore.assets;
  if (window.boardStore.readOnly) { canWrite = false; document.body.classList.add("ro"); }
  if (!db) { canWrite = false; clearTimeout(timer); $("#empty-t").textContent = "Storage unavailable"; $("#empty-s").textContent = "Check that the board server is running."; showStatus(); return; }
  let first = true, recovered = false;
  db.collection(COL).onSnapshot((snap) => {
    const changed = applySnapshot(snap);
    if (!snap.metadata.fromCache && !recovered) {
      recovered = true; clearTimeout(timer);
      journalReplay(changed);
      try { if (sessionStorage.getItem("board-reloaded")) { sessionStorage.removeItem("board-reloaded"); setTimeout(() => toast("Board code updated; your view and undo are kept"), 400); } } catch (e) {}
    }
    if (first) {
      first = false; B.loaded = true; renderAll();
      if (!camSaved || window.boardStore.readOnly) fitAll(0);   // an exported file always opens on the whole board: local files share one localStorage
      document.fonts && document.fonts.ready.then(() => { measure(nodes.keys()); for (const n of nodes.values()) if (n.kind === "arrow") renderArrow(n); updateOverlay(); afterAll(); });
      B.onData();
    } else if (changed.length) { applyTouched(changed); B.onData(); }
    showStatus();
  }, (e) => { errorState = "Connection lost"; console.error(e); showStatus(); });
  B.db = db; B.startData && B.startData(db);
}

// ---------- creating and editing ----------
// The zone comes from the frame under the point; with a filter on, a new item gets matching values (B.fitFilter) so it doesn't fade right after creation.
function withDefaults(n, at) {
  n.zone = zoneAtPoint(at.x, at.y) || n.zone || null;
  if (B.fitFilter) B.fitFilter(n);
  return n;
}
// Collect uses borrowed coordinates: nothing new goes there, we ask to switch back to In place.
function blockedByLayout() { if (!B.layout) return false; toast("Add items in the In place mode"); return true; }
function newText(wx, wy, style = "plain") {
  const id = uid("t"), n = withDefaults({ id, kind: "text", x: Math.round(wx), y: Math.round(wy), w: style === "card" ? 320 : 360, text: "", fs: style === "card" ? 17 : 24, style, z: maxZ() + 1, parent: null, tags: [], type: null }, { x: wx, y: wy });
  nodes.set(id, n); renderNode(id); openEditor(id, true);
}
function openEditor(id, isNew) {
  const n = nodes.get(id), el = els.get(id); if (!n || n.kind !== "text" || !el) return;
  closeEditor(); editing = id; setSel([id]);
  const body = el.querySelector(".body"), ta = document.createElement("textarea");
  ta.className = "edit"; ta.value = n.text || ""; el._orig = ta.value; ta.spellcheck = false; ta.style.fontSize = (n.fs || 18) + "px"; ta.dataset.isnew = isNew ? "1" : "";
  body.replaceWith(ta); el._editor = ta; el._body = body;
  const fit = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; H.set(id, el.offsetHeight); updateOverlay(); };
  ta.addEventListener("input", fit); fit(); ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); closeEditor(); } });
  ta.addEventListener("blur", () => setTimeout(() => { if (editing === id && document.activeElement !== ta) closeEditor(); }, 0));
}
function closeEditor() {
  if (!editing) return;
  const id = editing, n = nodes.get(id), el = els.get(id); editing = null;
  if (!n || !el || !el._editor) return;
  const ta = el._editor, val = ta.value, isNew = ta.dataset.isnew === "1", body = el._body;
  ta.replaceWith(body); el._editor = null; el._key = null;
  if (isNew) {
    nodes.delete(id);
    if (val.trim()) tx(() => put({ ...n, text: val })); else { renderNode(id); setSel([]); }
  } else if (val !== el._orig) { if (val.trim()) tx(() => patch(id, { text: val })); else { renderNode(id); removeSelection([id]); } }   // compare with the text at open time: an outside edit made meanwhile is not rolled back
  else renderNode(id);
  measure([id]); updateOverlay();
}
Object.assign(B, { openEditor, closeEditor });

async function shrink(file) {
  if (file.type === "image/gif" || file.type === "image/svg+xml") return { blob: file };
  try {
    const bmp = await createImageBitmap(file), MAX = 2400, r = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    if (r === 1 && file.size < 3e6) { const d = { blob: file, nw: bmp.width, nh: bmp.height }; bmp.close(); return d; }
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * r); c.height = Math.round(bmp.height * r);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
    const blob = await new Promise((res) => c.toBlob(res, "image/webp", .9));
    return { blob: blob || file, nw: c.width, nh: c.height };
  } catch (e) { return { blob: file }; }
}
const MAXB = (LOCAL ? 500 : 20) * 1048576;
const MIME = { md: "text/markdown", markdown: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json", pdf: "application/pdf", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", svg: "image/svg+xml", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf" };
const mimeOf = (f) => f.type || MIME[(extOf(f.name) || "").toLowerCase()] || (LOCAL ? "application/octet-stream" : "");
const storable = (m) => LOCAL || /^(image|video|text|font)\//.test(m) || m === "application/pdf" || m === "application/json";
async function addFiles(files, at) {
  files = files.filter(Boolean); if (!files.length) return;
  if (!assets) { toast("This board is read-only: files can't be added"); return; }
  const bad = files.filter((f) => !storable(mimeOf(f))), big = files.filter((f) => storable(mimeOf(f)) && f.size > MAXB);
  if (bad.length) toast(`Can't upload ${bad.map((f) => f.name).join(", ")}: unsupported file type`);
  else if (big.length) toast(`${big.map((f) => f.name).join(", ")}: larger than ${MAXB / 1048576} MB`);
  let dx = 0;
  for (const file of files.filter((f) => storable(mimeOf(f)) && f.size <= MAXB)) {
    const mime = mimeOf(file);
    if (!mime.startsWith("image/")) { dx += await addOther(file, mime, { x: at.x + dx, y: at.y }) + 24; continue; }
    const s = await shrink(file), blob = s.blob, url = URL.createObjectURL(blob);
    let nw = s.nw, nh = s.nh;
    if (!nw) [nw, nh] = await new Promise((res) => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.onerror = () => res([800, 600]); i.src = url; });
    const w = Math.min(520, nw), h = Math.round(w * nh / nw), id = uid("i");
    const n = { id, kind: "image", x: Math.round(at.x + dx), y: Math.round(at.y), w, h, nw, nh, asset: null, z: maxZ() + 1, parent: null, tags: [], type: null, zone: zoneAtPoint(at.x + dx + w / 2, at.y + h / 2), title: file.name || "", _blob: url, _local: true };
    withDefaults(n, { x: at.x + dx + w / 2, y: at.y + h / 2 });
    tx(() => put(n)); dx += w + 24;
    assets.upload(blob).then((r) => {
      // the undo entry holds a version without the asset: fill it in so redo after undo keeps the image
      for (const stack of [undoS, redoS]) for (const e of stack) { const v = e.get(id); if (v) { if (v.after) v.after.asset = r.id; if (v.before) v.before.asset = r.id; } }
      const c = nodes.get(id); if (!c) return;
      delete c._local; c.asset = r.id; renderNode(id); enqueue(id);
    }).catch((e) => { console.error(e); tx(() => del(id), { noUndo: true }); toast("Upload failed: " + (e && e.code === "too_large" ? `larger than ${MAXB / 1048576} MB` : "try again")); });
  }
}
async function addOther(file, mime, at) {
  const blob = file.type === mime ? file : new Blob([file], { type: mime }), url = URL.createObjectURL(blob), video = mime.startsWith("video/");
  let w = 320, h = 76;
  if (video) { const [vw, vh] = await new Promise((res) => { const v = document.createElement("video"); v.preload = "metadata"; v.onloadedmetadata = () => res([v.videoWidth || 16, v.videoHeight || 9]); v.onerror = () => res([16, 9]); v.src = url; }); w = 520; h = Math.round(w * vh / vw); }
  const id = uid("f"), n = { id, kind: "file", x: Math.round(at.x), y: Math.round(at.y), w, h, asset: null, mime, size: file.size, title: file.name || (video ? "video" : "file"), z: maxZ() + 1, parent: null, tags: [], type: null, zone: null, _blob: url, _local: true };
  withDefaults(n, { x: at.x + w / 2, y: at.y + h / 2 });
  tx(() => put(n)); setSel([id]);
  assets.upload(blob).then((r) => {
    for (const stack of [undoS, redoS]) for (const e of stack) { const v = e.get(id); if (v) { if (v.after) v.after.asset = r.id; if (v.before) v.before.asset = r.id; } }
    const c = nodes.get(id); if (!c) return;
    delete c._local; delete c._blob; c.asset = r.id; renderNode(id); enqueue(id);
  }).catch((e) => { console.error(e); tx(() => del(id), { noUndo: true }); toast(`${file.name || "File"} failed to upload: ` + (e && e.code === "too_large" ? `larger than ${MAXB / 1048576} MB` : e && /type|unsupported/i.test(e.code || e.message || "") ? "unsupported type" : "try again")); });
  return w;
}
const addImages = addFiles;
function zoneAtPoint(x, y) { let best = null, area = Infinity; for (const n of nodes.values()) if (n.kind === "frame" && n.zone && x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h && n.w * n.h < area) { best = n.zone; area = n.w * n.h; } return best; }

function removeSelection(ids) {
  const kids = childrenMap(), all = new Set(ids.flatMap((id) => [...leaves(id, kids), id]));
  tx(() => {
    for (const n of [...nodes.values()]) if (n.kind === "arrow" && !all.has(n.id)) {
      const hitF = all.has(n.from), hitT = all.has(n.to);
      if (hitF || hitT) { const [p, q] = arrowPts(n); patch(n.id, { x1: p.x, y1: p.y, x2: q.x, y2: q.y, from: hitF ? null : n.from, to: hitT ? null : n.to }); }
    }
    all.forEach(del);
    let again = true;
    while (again) { again = false; const k = childrenMap(); for (const n of [...nodes.values()]) if (n.kind === "group" && !(k.get(n.id) || []).length) { del(n.id); again = true; } }
  });
  setSel([]);
  toast("Deleted", { label: "Undo", fn: B.undo });
}
function group() {
  const list = [...sel].filter((id) => nodes.get(id) && nodes.get(id).kind !== "frame"); if (list.length < 2) return;
  const pars = new Set(list.map((id) => nodes.get(id).parent || null)), parent = pars.size === 1 ? [...pars][0] : null, id = uid("g");
  tx(() => { put({ id, kind: "group", parent, name: "Group", z: 0 }); list.forEach((c) => patch(c, { parent: id })); });
  setSel([id]);
}
function ungroup() {
  const out = [];
  tx(() => { for (const id of [...sel]) { const n = nodes.get(id); if (!n || n.kind !== "group") { out.push(id); continue; } const k = childrenMap().get(id) || []; k.forEach((c) => { patch(c, { parent: n.parent || null }); out.push(c); }); del(id); } });
  setSel(out);
}
function cloneSet(ids, dx, dy, source = nodes, o = {}) {
  // ids are the top-level nodes of the set; subtrees are copied, arrow links inside the set are kept.
  // o.keep: whose parent groups to keep (a copy next to the original); o.fit: fit to the active filter (paste)
  const take = new Map(), add = (id) => { const n = source.get(id); if (!n || take.has(id)) return; take.set(id, n); if (n.kind === "group") for (const c of source.values()) if (c.parent === id) add(c.id); };
  ids.forEach(add);
  const map = new Map([...take.keys()].map((id) => [id, uid("c")])), out = []; let z = maxZ() + 1;
  for (const [id, n] of take) {
    const c = stripLocal(n); c.id = map.get(id);
    c.parent = map.has(n.parent) ? map.get(n.parent) : (o.keep ? (o.keep.has(id) ? n.parent || null : null) : source === nodes ? n.parent || null : null);
    if ("x" in c) { c.x += dx; c.y += dy; }
    if (c.kind === "arrow") { const [p, q] = source === nodes ? arrowPts(n) : [{ x: n.x1, y: n.y1 }, { x: n.x2, y: n.y2 }]; c.x1 = p.x + dx; c.y1 = p.y + dy; c.x2 = q.x + dx; c.y2 = q.y + dy; c.from = map.get(n.from) || null; c.to = map.get(n.to) || null; }
    if (o.fit && B.fitFilter && (c.kind === "text" || c.kind === "image" || c.kind === "file")) B.fitFilter(c);
    c.z = z++; out.push(c);
  }
  tx(() => out.forEach(put));
  const res = ids.map((id) => map.get(id)).filter(Boolean); res.map = map;
  return res;
}
// Duplicate the selection with frame contents, as the clipboard does. sel: copies of the selection, all: every new node.
function cloneSel(dx, dy) {
  const p = selectionPayload(), src = new Map(p.nodes.map((n) => [n.id, n]));
  const tops = p.nodes.filter((n) => !n.parent || !src.has(n.parent)).map((n) => n.id), r = cloneSet(tops, dx, dy, src, { keep: new Set(sel) });
  return { sel: [...sel].map((id) => r.map.get(id)).filter(Boolean), all: [...r.map.values()] };
}
function selectionPayload() {
  const kids = childrenMap(), seen = new Map(), add = (id) => { const n = nodes.get(id); if (!n || seen.has(id)) return; seen.set(id, n); (kids.get(id) || []).forEach(add); };
  sel.forEach(add);
  for (const n of [...seen.values()]) if (n.kind === "frame") frameContents(n).forEach(add);
  return { nodes: [...seen.values()].map((n) => { const c = stripLocal(n); if (n.kind === "arrow") { const [p, q] = arrowPts(n); c.x1 = p.x; c.y1 = p.y; c.x2 = q.x; c.y2 = q.y; } return c; }) };
}
function pasteNodes(p, at) {
  const src = new Map(p.nodes.map((n) => [n.id, n]));
  const pts = union(p.nodes.filter((n) => n.kind !== "group" && n.kind !== "arrow").map((n) => ({ x: n.x, y: n.y, w: n.w || 0, h: n.h || 60 })));
  const dx = at && pts ? at.x - pts.x - pts.w / 2 : 32, dy = at && pts ? at.y - pts.y - pts.h / 2 : 32;
  const tops = p.nodes.filter((n) => !n.parent || !src.has(n.parent)).map((n) => n.id);
  setSel(cloneSet(tops, Math.round(dx), Math.round(dy), src, { fit: true }));
}
Object.assign(B, { group, ungroup, removeSelection, addImages, addFiles });

// ---------- selection and overlay ----------
const chainHas = (ids, g) => ids.some((id) => chain(id).includes(g));
function setSel(ids) { sel = new Set(ids); if (scope && !chainHas(ids, scope)) scope = null; updateOverlay(); B.onSelection(); }
const rectPath = (b) => { const x = b.x * cam.k + cam.x, y = b.y * cam.k + cam.y; return `M${x} ${y}h${b.w * cam.k}v${b.h * cam.k}h${-b.w * cam.k}z`; };
function updateOverlay() {
  const kids = childrenMap(), ids = [...sel].filter((id) => nodes.has(id));
  let d = "";
  for (const id of ids) { const n = nodes.get(id); if (n.kind === "arrow") { const [p, q] = arrowPts(n); d += `M${p.x * cam.k + cam.x} ${p.y * cam.k + cam.y}L${q.x * cam.k + cam.x} ${q.y * cam.k + cam.y}`; } else d += rectPath(box(id, kids)); }
  const b = ids.length ? union(ids.map((id) => box(id, kids))) : null;
  if (b && ids.length > 1) d += rectPath(b);
  $("#ov-sel").setAttribute("d", d);
  $("#ov-scope").setAttribute("d", scope && nodes.has(scope) ? rectPath(box(scope, kids)) : "");
  let html = "";
  const single = ids.length === 1 ? nodes.get(ids[0]) : null;
  if (b && !editing && !B.layout) {
    const P = (h, wx, wy, cl = "") => `<div class="h ${cl}" data-h="${h}" style="left:${wx * cam.k + cam.x}px;top:${wy * cam.k + cam.y}px"></div>`;
    if (single && single.kind === "arrow") { const [p, q] = arrowPts(single); html = P("p1", p.x, p.y, "dot") + P("p2", q.x, q.y, "dot"); }
    else {
      const { x, y, w, h } = b, cor = P("nw", x, y) + P("ne", x + w, y) + P("sw", x, y + h) + P("se", x + w, y + h);
      if (single && single.kind === "text") html = cor + P("e", x + w, y + h / 2) + P("w", x, y + h / 2);
      else if (single && single.kind === "frame") html = cor + P("n", x + w / 2, y) + P("s", x + w / 2, y + h) + P("e", x + w, y + h / 2) + P("w", x, y + h / 2);
      else html = cor;
    }
  }
  if (handlesEl._h !== html) { handlesEl.innerHTML = html; handlesEl._h = html; }
}
function setTool(t) { tool = t; document.querySelectorAll("[data-tool]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.tool === t)); vp.classList.toggle("crosshair", ["text", "frame", "arrow", "laser"].includes(t)); vp.classList.toggle("can-pan", t === "hand"); }

// ---------- laser pointer: a trail in screen coordinates, each point fades over LASER_MS ----------
const LASER_MS = 2500, laser = { strokes: [], cur: null, raf: 0, cv: null };
function laserStart(e) {
  if (!laser.cv) { laser.cv = document.createElement("canvas"); laser.cv.className = "laser"; laser.cv.setAttribute("aria-hidden", "true"); document.body.appendChild(laser.cv); }
  laser.cur = []; laser.strokes.push(laser.cur);
  g = { t: "laser", sx: e.clientX, sy: e.clientY, click: B.isShow() ? { id: nodeAt(e) } : null };
  try { vp.setPointerCapture(e.pointerId); } catch (x) {}
  laserAdd(e);
}
function laserAdd(e) {
  if (!laser.cur) return;
  const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [], now = performance.now();
  for (const p of evs.length ? evs : [e]) laser.cur.push({ x: p.clientX, y: p.clientY, t: now });
  if (!laser.raf) laser.raf = requestAnimationFrame(laserDraw);
}
function laserDraw() {
  laser.raf = 0;
  const cv = laser.cv, dpr = window.devicePixelRatio || 1, W = innerWidth, Hh = innerHeight, now = performance.now();
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(Hh * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr); }
  const x = cv.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, Hh);
  const col = getComputedStyle(document.documentElement).getPropertyValue("--laser").trim() || "#F36923";
  x.lineCap = "butt"; x.strokeStyle = col;   // butt caps: round caps on translucent segments overlap into dots
  laser.strokes = laser.strokes.filter((st) => { while (st.length > 1 && now - st[0].t > LASER_MS) st.shift(); return st === laser.cur || (st.length && now - st[st.length - 1].t < LASER_MS); });
  const fade = (t) => { const a = 1 - (now - t) / LASER_MS; return a <= 0 ? 0 : a * a * (3 - 2 * a); };   // smooth fade to zero
  for (const st of laser.strokes) {
    // curves through segment midpoints: no kinks on fast moves
    for (let i = 1; i < st.length; i++) {
      const p0 = st[i - 1], p1 = st[i], a = fade(p1.t); if (!a) continue;
      const m0 = i === 1 ? p0 : { x: (st[i - 2].x + p0.x) / 2, y: (st[i - 2].y + p0.y) / 2 }, m1 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      x.beginPath(); x.moveTo(m0.x, m0.y); x.quadraticCurveTo(p0.x, p0.y, m1.x, m1.y);
      x.globalAlpha = a; x.lineWidth = .4 + 2.6 * a; x.stroke();      // a thin line that fades and thins
    }
  }
  x.globalAlpha = 1;
  if (laser.strokes.length) laser.raf = requestAnimationFrame(laserDraw);
}
function laserToggle() { setTool(tool === "laser" ? "select" : "laser"); toast(tool === "laser" ? "Laser: drag with the button held, K to turn off" : "Laser off"); }

// ---------- pointer ----------
let g = null, lastDown = { t: 0, x: 0, y: 0 }, lastPointer = { x: innerWidth / 2, y: innerHeight / 2 };
const nodeAt = (e) => { const t = e.target.closest && e.target.closest("[data-id]"); return t && nodes.has(t.dataset.id) ? t.dataset.id : null; };
// keep focus in the text field: a canvas click closes the editor itself, the browser needn't move focus
vp.addEventListener("mousedown", (e) => { if (!(e.target.classList && e.target.classList.contains("edit"))) e.preventDefault(); });
vp.addEventListener("pointerdown", (e) => {
  if (e.target.closest && e.target.closest("a.f-open, .body a")) return;   // links open without selecting or dragging the card
  if (B.isShow()) {
    const t = e.target.closest && e.target.closest(".n.file.video"); if (t && e.button === 0) { toggleVideo(t.dataset.id); return; }
    if (e.button === 0 && tool === "laser") return laserStart(e);          // a click without movement zooms to the card, laser too
    if (e.button === 0 || e.button === 1) { startPan(e); if (e.button === 0) g.click = { id: nodeAt(e) }; }   // a click without movement: focus the card (B.showClick)
    return;
  }
  if (e.target.classList && e.target.classList.contains("edit")) return;
  if (editing) closeEditor();
  if (document.activeElement && document.activeElement !== document.body && !vp.contains(document.activeElement)) document.activeElement.blur();
  if (e.button === 1 || (e.button === 0 && (spaceDown || tool === "hand"))) return startPan(e);
  if (e.button !== 0) return;
  if (tool === "laser") return laserStart(e);
  const w = toWorld(e.clientX, e.clientY), hid = e.target.dataset && e.target.dataset.h;
  if (hid) return startHandle(e, hid);
  const hit = nodeAt(e);
  if ((tool === "text" || tool === "frame" || tool === "arrow") && blockedByLayout()) { setTool("select"); return; }   // Collect uses borrowed coordinates
  if (tool === "text") { setTool("select"); newText(w.x, w.y); return; }
  if (tool === "frame") return startCreateFrame(e, w);
  if (tool === "arrow") return startCreateArrow(e, w, hit);
  const now = performance.now(), dbl = now - lastDown.t < 340 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 6;
  lastDown = { t: dbl ? 0 : now, x: e.clientX, y: e.clientY };
  if (dbl) return onDouble(hit, w);
  if (!hit) { if (!e.shiftKey) { scope = null; setSel([]); } return startMarquee(e, w); }
  const deep = e.metaKey || e.ctrlKey, target = topFor(hit, deep);
  let narrow = null;
  if (e.shiftKey) { const s = new Set(sel); if (s.has(target)) s.delete(target); else s.add(target); setSel([...s]); }
  else if (!sel.has(target)) setSel([target]);
  else if (sel.size > 1) narrow = target;
  if (B.layout) return;
  if (sel.size) startMove(e, w, narrow);
});
function onDouble(hit, w) {
  if (!hit) { if (!B.layout) newText(w.x - 8, w.y - 16); return; }
  const c = chain(hit), selId = [...sel][0], n = nodes.get(selId);
  if (n && n.kind === "group" && c.includes(selId)) { scope = selId; setSel([c[c.indexOf(selId) + 1]]); return; }
  const leaf = nodes.get(hit);
  if (leaf.kind === "text") return openEditor(hit);
  if (leaf.kind === "file" && toggleVideo(hit)) return;
  if (leaf.kind === "frame" && B.focusTitle) return B.focusTitle(hit);
}
function capture(e) { try { vp.setPointerCapture(e.pointerId); } catch (x) {} }
function startPan(e) { capture(e); vp.classList.add("panning"); g = { t: "pan", sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y }; cancelAnimationFrame(camAnim); }
function startMarquee(e, w) { capture(e); g = { t: "marq", w0: w, base: e.shiftKey ? new Set(sel) : new Set(), s0: { x: e.clientX, y: e.clientY } }; }
function moveSet() {
  const kids = childrenMap(), out = new Set();
  for (const id of sel) for (const l of leaves(id, kids)) { out.add(l); const n = nodes.get(l); if (n && n.kind === "frame") frameContents(n).forEach((c) => out.add(c)); }
  return out;
}
function startMove(e, w, narrow) {
  capture(e);
  const ids = moveSet();
  g = { t: "move", w0: w, ids, orig: origOf(ids), moved: false, narrow, copied: null, ...snapPrep(ids) };
}
function origOf(ids) { const orig = new Map(); for (const id of ids) { const n = nodes.get(id); orig.set(id, n.kind === "arrow" ? { x1: n.x1, y1: n.y1, x2: n.x2, y2: n.y2 } : { x: n.x, y: n.y }); } return orig; }
// Option while dragging (from the start or midway): originals snap back and copies move on. A copy appears only on real movement; an Option-click leaves no duplicates.
function altCopy() {
  for (const [id, o] of g.orig) { const n = nodes.get(id); Object.assign(n, o); if (n.kind !== "arrow") place(id); }
  redrawArrowsFor(g.ids);
  const n0 = undoS.length, r = cloneSel(0, 0);
  if (undoS.length === n0) { g.copied = true; return; }            // read-only: no copy, keep moving as before
  g.copied = undoS[undoS.length - 1]; g.narrow = null;
  // only the copies move: a frame copy lies over the original and a recount by its area would catch the original cards
  setSel(r.sel); g.ids = new Set(r.all.filter((id) => nodes.get(id) && nodes.get(id).kind !== "group")); g.orig = origOf(g.ids); Object.assign(g, snapPrep(g.ids));
  vp.classList.add("copying");
}
// Snapping while dragging: edge and centre lines of neighbours in view are computed once at the start.
function snapPrep(ids) {
  const bb = union([...ids].filter((id) => nodes.get(id).kind !== "arrow").map((id) => box(id))); if (!bb) return {};
  const a = toWorld(0, 0), z = toWorld(innerWidth, innerHeight), mx = (z.x - a.x) / 2, my = (z.y - a.y) / 2, vr = { x: a.x - mx, y: a.y - my, w: z.x - a.x + 2 * mx, h: z.y - a.y + 2 * my }, cands = [];
  for (const n of nodes.values()) {
    if (n.kind === "arrow" || n.kind === "group" || ids.has(n.id)) continue;
    const el = els.get(n.id); if (!el || el.classList.contains("dim") || el.classList.contains("out")) continue;
    const b = box(n.id); if (b && hits(b, vr)) cands.push(b);
  }
  return { bb, cands };
}
function snapMove(dx, dy, lx, ly) {
  const b = g.bb, tol = 6 / cam.k, eps = .5 / cam.k, xs = [b.x, b.x + b.w / 2, b.x + b.w], ys = [b.y, b.y + b.h / 2, b.y + b.h];
  const lines = (c) => [[c.x, c.x + c.w / 2, c.x + c.w], [c.y, c.y + c.h / 2, c.y + c.h]];
  let bx = null, by = null;
  for (const c of g.cands) {
    const [cx, cy] = lines(c);
    if (!lx) for (const a of xs) for (const v of cx) { const s = v - (a + dx); if (Math.abs(s) <= tol && (bx === null || Math.abs(s) < Math.abs(bx))) bx = s; }
    if (!ly) for (const a of ys) for (const v of cy) { const s = v - (a + dy); if (Math.abs(s) <= tol && (by === null || Math.abs(s) < Math.abs(by))) by = s; }
  }
  if (bx !== null) dx += bx; if (by !== null) dy += by;
  let d = "";
  const X = (x, y1, y2) => `M${x * cam.k + cam.x} ${y1 * cam.k + cam.y}V${y2 * cam.k + cam.y}`, Y = (y, x1, x2) => `M${x1 * cam.k + cam.x} ${y * cam.k + cam.y}H${x2 * cam.k + cam.x}`;
  if (bx !== null || by !== null) for (const c of g.cands) {
    const [cx, cy] = lines(c), y1 = Math.min(b.y + dy, c.y), y2 = Math.max(b.y + b.h + dy, c.y + c.h), x1 = Math.min(b.x + dx, c.x), x2 = Math.max(b.x + b.w + dx, c.x + c.w);
    if (bx !== null) for (const a of xs) for (const v of cx) if (Math.abs(v - (a + dx)) < eps) d += X(v, y1, y2);
    if (by !== null) for (const a of ys) for (const v of cy) if (Math.abs(v - (a + dy)) < eps) d += Y(v, x1, x2);
  }
  $("#ov-guides").setAttribute("d", d);
  return [dx, dy];
}
function startHandle(e, h) {
  capture(e);
  if (h === "p1" || h === "p2") { const id = [...sel][0]; g = { t: "endpoint", id, h, orig: stripLocal(nodes.get(id)) }; return; }
  const kids = childrenMap(), ids = [...sel].flatMap((id) => leaves(id, kids)), orig = new Map();
  ids.forEach((id) => orig.set(id, stripLocal(nodes.get(id))));
  g = { t: "resize", h, ids, orig, b0: union([...sel].map((id) => box(id, kids))), single: sel.size === 1 && ids.length === 1 ? nodes.get(ids[0]) : null };
}
function startCreateFrame(e, w) { capture(e); const id = uid("f"), n = { id, kind: "frame", x: w.x, y: w.y, w: 1, h: 1, title: "Frame", z: 0, parent: null, tags: [], zone: null, type: null }; nodes.set(id, n); renderNode(id); g = { t: "newframe", id, w0: w }; }
function startCreateArrow(e, w, hit) { capture(e); const from = hit && ["text", "image", "file"].includes(nodes.get(hit).kind) ? hit : null, id = uid("a"), n = { id, kind: "arrow", x1: w.x, y1: w.y, x2: w.x, y2: w.y, from, to: null, z: 0, parent: null, tags: [], head: true }; nodes.set(id, n); renderNode(id); g = { t: "newarrow", id }; }
vp.addEventListener("pointermove", (e) => {
  lastPointer = { x: e.clientX, y: e.clientY };
  if (g && g.t === "laser") { laserAdd(e); return; }
  if (!g) {
    if (B.isShow() || tool !== "select") return;
    const h = nodeAt(e), o = $("#ov-hover");
    o.setAttribute("d", h && !sel.has(topFor(h)) && nodes.get(h).kind !== "arrow" ? rectPath(box(topFor(h))) : "");
    return;
  }
  $("#ov-hover").setAttribute("d", "");
  const w = toWorld(e.clientX, e.clientY);
  if (g.t === "pan") { cam.x = g.cx + e.clientX - g.sx; cam.y = g.cy + e.clientY - g.sy; applyCam(); return; }
  if (g.t === "marq") {
    const m = $("#marquee"), x = Math.min(g.s0.x, e.clientX), y = Math.min(g.s0.y, e.clientY);
    m.hidden = false; m.style.cssText = `left:${x}px;top:${y}px;width:${Math.abs(g.s0.x - e.clientX)}px;height:${Math.abs(g.s0.y - e.clientY)}px`;
    const r = { x: Math.min(g.w0.x, w.x), y: Math.min(g.w0.y, w.y), w: Math.abs(g.w0.x - w.x), h: Math.abs(g.w0.y - w.y) }, s = new Set(g.base);
    for (const n of nodes.values()) {
      if (n.kind === "group") continue;
      const el = els.get(n.id); if (el && (el.classList.contains("dim") || el.classList.contains("out"))) continue;
      const b = box(n.id); if (n.kind === "frame" ? inside(b, r) : hits(b, r)) s.add(topFor(n.id));
    }
    sel = s; updateOverlay(); return;
  }
  if (g.t === "move") {
    let dx = w.x - g.w0.x, dy = w.y - g.w0.y, lx = false, ly = false;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) { dy = 0; ly = true; } else { dx = 0; lx = true; } }
    if (!g.moved && Math.hypot(dx, dy) * cam.k < 3) return;
    g.moved = true;
    if (e.altKey && !g.copied) altCopy();
    if (g.bb && !(e.metaKey || e.ctrlKey)) [dx, dy] = snapMove(dx, dy, lx, ly); else $("#ov-guides").setAttribute("d", "");
    for (const [id, o] of g.orig) { const n = nodes.get(id); if (n.kind === "arrow") { n.x1 = o.x1 + dx; n.y1 = o.y1 + dy; n.x2 = o.x2 + dx; n.y2 = o.y2 + dy; } else { n.x = o.x + dx; n.y = o.y + dy; place(id); } }
    redrawArrowsFor(g.ids); updateOverlay(); return;
  }
  if (g.t === "resize") return doResize(e, w);
  if (g.t === "endpoint") { const n = nodes.get(g.id); if (g.h === "p1") { n.x1 = w.x; n.y1 = w.y; n.from = null; } else { n.x2 = w.x; n.y2 = w.y; n.to = null; } renderArrow(n); updateOverlay(); return; }
  if (g.t === "newframe") { const n = nodes.get(g.id); n.x = Math.min(g.w0.x, w.x); n.y = Math.min(g.w0.y, w.y); n.w = Math.abs(w.x - g.w0.x); n.h = Math.abs(w.y - g.w0.y); place(g.id); return; }
  if (g.t === "newarrow") { const n = nodes.get(g.id); n.x2 = w.x; n.y2 = w.y; renderArrow(n); }
});
function doResize(e, w) {
  const { b0, h, single, orig } = g; let L = b0.x, T = b0.y, R = L + b0.w, Bm = T + b0.h;
  if (h.includes("e")) R = w.x; if (h.includes("w")) L = w.x; if (h.includes("s")) Bm = w.y; if (h.includes("n")) T = w.y;
  if (single && single.kind === "text" && h.length === 1) {
    const n = single, o = orig.get(n.id), nw = Math.max(40, h === "e" ? w.x - o.x : o.x + o.w - w.x);
    n.w = Math.round(nw); if (h === "w") n.x = o.x + o.w - n.w;
    place(n.id); measure([n.id]); redrawArrowsFor(new Set([n.id])); updateOverlay(); return;
  }
  if (single && single.kind === "frame") { single.x = Math.round(Math.min(L, R)); single.y = Math.round(Math.min(T, Bm)); single.w = Math.max(60, Math.round(Math.abs(R - L))); single.h = Math.max(60, Math.round(Math.abs(Bm - T))); place(single.id); updateOverlay(); return; }
  let sx = Math.max(.05, (R - L) / (b0.w || 1)), sy = Math.max(.05, (Bm - T) / (b0.h || 1));
  if (!(single && (single.kind === "image" || single.kind === "file") && e.shiftKey)) sx = sy = Math.max(sx, sy);
  const ox = h.includes("w") ? b0.x + b0.w : b0.x, oy = h.includes("n") ? b0.y + b0.h : b0.y;
  for (const [id, o] of orig) {
    const n = nodes.get(id);
    if (n.kind === "arrow") { n.x1 = ox + (o.x1 - ox) * sx; n.y1 = oy + (o.y1 - oy) * sy; n.x2 = ox + (o.x2 - ox) * sx; n.y2 = oy + (o.y2 - oy) * sy; continue; }
    n.x = ox + (o.x - ox) * sx; n.y = oy + (o.y - oy) * sy; n.w = Math.max(40, o.w * sx);
    if (n.kind === "text") { n.fs = Math.round(Math.max(8, o.fs * sx) * 10) / 10; renderNode(id); } else { n.h = o.h * sy; place(id); }
  }
  measure(orig.keys()); redrawArrowsFor(new Set(orig.keys())); updateOverlay();
}
const movingFrame = (G) => [...G.ids].some((id) => nodes.get(id).kind === "frame");
function elementNodeAt(x, y, exclude) {
  for (const el of document.elementsFromPoint(x, y)) { const t = el.closest && el.closest("[data-id]"); if (t && t.dataset.id !== exclude) { const n = nodes.get(t.dataset.id); if (n && (n.kind === "text" || n.kind === "image" || n.kind === "file")) return n.id; } }
  return null;
}
function finishPointer(e) {
  if (!g) return;
  const G = g; g = null; try { vp.releasePointerCapture(e.pointerId); } catch (x) {}
  if (G.t === "move") { $("#ov-guides").setAttribute("d", ""); vp.classList.remove("copying"); }
  if (G.t === "laser") { laser.cur = null; if (G.click && e.type === "pointerup" && Math.hypot(e.clientX - G.sx, e.clientY - G.sy) < 5) B.showClick(G.click.id); return; }
  if (G.t === "pan") {
    vp.classList.remove("panning");
    if (G.click && e.type === "pointerup" && B.isShow() && Math.hypot(e.clientX - G.sx, e.clientY - G.sy) < 5) B.showClick(G.click.id);
    return;
  }
  if (G.t === "marq") { $("#marquee").hidden = true; setSel([...sel]); return; }
  if (G.t === "move") {
    if (!G.moved) { if (G.narrow) setSel([G.narrow]); return; }
    const end = new Map();
    for (const [id, o] of G.orig) { const n = nodes.get(id); end.set(id, n.kind === "arrow" ? { x1: n.x1, y1: n.y1, x2: n.x2, y2: n.y2 } : { x: Math.round(n.x), y: Math.round(n.y) }); Object.assign(n, o); }
    const zoneToo = !movingFrame(G), n0 = undoS.length;
    tx(() => { for (const [id, p] of end) { patch(id, p); const n = nodes.get(id); if (zoneToo && (n.kind === "text" || n.kind === "image" || n.kind === "file")) { const c = center(rawBox(n)), z = zoneAtPoint(c.x, c.y); if (z && z !== n.zone) patch(id, { zone: z }); } } });
    // the copy and its move are one undo entry: Cmd+Z removes the copy entirely
    if (G.copied instanceof Map && undoS.length > n0) { const mv = undoS.pop(); if (undoS[undoS.length - 1] === G.copied) { for (const [k, v] of mv) { const c = G.copied.get(k); G.copied.set(k, c ? { before: c.before, after: v.after } : v); } } else undoS.push(mv); }
    return;
  }
  if (G.t === "resize") {
    const end = new Map(); for (const [id] of G.orig) end.set(id, stripLocal(nodes.get(id)));
    for (const [id, o] of G.orig) Object.assign(nodes.get(id), o);
    tx(() => { for (const [id, p] of end) { const { id: _i, ...f } = p; if (f.kind !== "arrow") { f.x = Math.round(f.x); f.y = Math.round(f.y); f.w = Math.round(f.w); if (f.h) f.h = Math.round(f.h); } patch(id, f); } });
    return;
  }
  if (G.t === "endpoint") {
    const n = nodes.get(G.id), under = elementNodeAt(e.clientX, e.clientY, G.id), p = stripLocal(n);
    if (G.h === "p1") p.from = under; else p.to = under;
    Object.assign(n, G.orig); const { id: _i, ...f } = p; tx(() => patch(G.id, f)); return;
  }
  if (G.t === "newframe") {
    const n = nodes.get(G.id); nodes.delete(G.id);
    if (n.w < 20 || n.h < 20) { n.w = 900; n.h = 640; n.x = G.w0.x; n.y = G.w0.y; }
    n.x = Math.round(n.x); n.y = Math.round(n.y); n.w = Math.round(n.w); n.h = Math.round(n.h);
    tx(() => put(n)); setTool("select"); setSel([n.id]); return;
  }
  if (G.t === "newarrow") {
    const n = nodes.get(G.id); nodes.delete(G.id);
    if (Math.hypot(n.x2 - n.x1, n.y2 - n.y1) < 12) { renderNode(G.id); setTool("select"); return; }
    n.to = elementNodeAt(e.clientX, e.clientY, G.id);
    if (n.to === n.from) n.to = null;
    tx(() => put(n)); setTool("select"); setSel([n.id]);
  }
}
vp.addEventListener("pointerup", finishPointer);
vp.addEventListener("pointercancel", finishPointer);
vp.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.deltaMode ? .05 : .0065)));
  else { cancelAnimationFrame(camAnim); cam.x -= e.deltaX; cam.y -= e.deltaY; applyCam(); }
}, { passive: false });

// ---------- keys and clipboard ----------
const typing = () => { const a = document.activeElement; return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable); };
function order(front) { const ids = [...sel].flatMap((id) => leaves(id)); let z = front ? maxZ() + 1 : minZ() - ids.length; tx(() => ids.forEach((id) => patch(id, { z: z++ }))); }
function selectAll() { const s = new Set(); for (const n of nodes.values()) { if (n.kind === "group" || n.kind === "frame") continue; const el = els.get(n.id); if (el && (el.classList.contains("dim") || el.classList.contains("out"))) continue; s.add(topFor(n.id)); } setSel([...s]); }
document.addEventListener("keydown", (e) => {
  const kK = e.code === "KeyK" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;   // by key code: works on any keyboard layout
  if (B.isShow()) { if (kK) { e.preventDefault(); laserToggle(); return; } if (B.showKey(e)) e.preventDefault(); return; }
  if (typing()) return;
  if (kK) { laserToggle(); return; }
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase(), c = e.code;
  if (c === "Space") { spaceDown = true; vp.classList.add("can-pan"); e.preventDefault(); return; }
  if (mod && c === "KeyZ") { e.preventDefault(); e.shiftKey ? B.redo() : B.undo(); return; }
  if (mod && c === "KeyY") { e.preventDefault(); B.redo(); return; }
  if (mod && c === "KeyA") { e.preventDefault(); selectAll(); return; }
  if (mod && c === "KeyD") { e.preventDefault(); if (sel.size && !blockedByLayout()) setSel(cloneSel(32, 32).sel); return; }
  if (mod && c === "KeyG") { e.preventDefault(); e.shiftKey ? ungroup() : group(); return; }
  if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomAt(innerWidth / 2, innerHeight / 2, 1.25); return; }
  if (mod && e.key === "-") { e.preventDefault(); zoomAt(innerWidth / 2, innerHeight / 2, .8); return; }
  if (mod && e.key === "0") { e.preventDefault(); zoomAt(innerWidth / 2, innerHeight / 2, 1 / cam.k); return; }
  if (e.shiftKey && c === "Digit1") { e.preventDefault(); fitAll(); return; }
  if (e.shiftKey && c === "Digit2") { e.preventDefault(); const b = union([...sel].map((i) => box(i))); if (b) animateTo(camFor(b)); return; }
  if (mod) return;
  if (e.key === "Delete" || e.key === "Backspace") { if (sel.size && !B.layout) { e.preventDefault(); removeSelection([...sel]); } return; }
  if (e.key === "Escape") { if (scope) { const s = scope; scope = nodes.get(s).parent || null; setSel([s]); } else setSel([]); setTool("select"); return; }
  if (e.key === "Enter") { const n = sel.size === 1 && nodes.get([...sel][0]); if (n && n.kind === "text") { e.preventDefault(); openEditor(n.id); } return; }
  if (c === "BracketRight" || c === "BracketLeft") { order(c === "BracketRight"); return; }
  if (e.key.startsWith("Arrow") && sel.size && !B.layout) {
    e.preventDefault();
    const st = e.shiftKey ? 10 : 1, d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key], ids = moveSet();
    tx(() => ids.forEach((id) => { const n = nodes.get(id); if (n.kind === "arrow") patch(id, { x1: n.x1 + d[0], y1: n.y1 + d[1], x2: n.x2 + d[0], y2: n.y2 + d[1] }); else patch(id, { x: n.x + d[0], y: n.y + d[1] }); }));
    return;
  }
  // by key code, like K: works on any keyboard layout
  const map = { KeyV: "select", KeyH: "hand", KeyT: "text", KeyF: "frame", KeyL: "arrow" };
  if (map[c] && !e.shiftKey && !e.altKey) { setTool(map[c]); return; }
  if (c === "KeyP" && !e.shiftKey && !e.altKey && B.startShow) B.startShow();
});
document.addEventListener("keyup", (e) => { if (e.code === "Space") { spaceDown = false; vp.classList.toggle("can-pan", tool === "hand"); } });
const MARK = "TALKBOARD:";
document.addEventListener("copy", (e) => { if (typing() || !sel.size || B.isShow()) return; e.clipboardData.setData("text/plain", MARK + JSON.stringify(selectionPayload())); e.preventDefault(); toast("Copied"); });
document.addEventListener("cut", (e) => { if (typing() || !sel.size || B.isShow()) return; e.clipboardData.setData("text/plain", MARK + JSON.stringify(selectionPayload())); e.preventDefault(); removeSelection([...sel]); });
document.addEventListener("paste", (e) => {
  if (typing() || B.isShow()) return;
  const files = [...(e.clipboardData.files || [])], at = toWorld(lastPointer.x, lastPointer.y);
  if ((files.length || e.clipboardData.getData("text/plain").trim()) && B.layout) { e.preventDefault(); blockedByLayout(); return; }
  if (files.length) { e.preventDefault(); addFiles(files, at); return; }
  const txt = e.clipboardData.getData("text/plain");
  if (txt.startsWith(MARK)) { e.preventDefault(); try { pasteNodes(JSON.parse(txt.slice(MARK.length)), at); } catch (x) { toast("Could not paste"); } return; }
  if (txt.trim()) { e.preventDefault(); const id = uid("t"), n = { id, kind: "text", x: Math.round(at.x), y: Math.round(at.y), w: 360, text: txt.trim(), fs: 18, style: "card", z: maxZ() + 1, parent: null, tags: [], type: null }; withDefaults(n, at); tx(() => put(n)); setSel([id]); }
});
let dragDepth = 0; const dz = $("#dropzone");
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
window.addEventListener("dragenter", (e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; dz.hidden = false; } });
window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dz.hidden = true; });
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; dz.hidden = true; if (blockedByLayout()) return; addFiles([...e.dataTransfer.files], toWorld(e.clientX, e.clientY)); });

// ---------- buttons ----------
function toast(t, action) { const el = $("#toast"); $("#toast-t").textContent = t; const b = $("#toast-b"); b.hidden = !action; if (action) { b.textContent = action.label; b.onclick = () => { action.fn(); el.hidden = true; }; } el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), action ? 7000 : 2200); }
B.toast = toast;
// a gesture, an open editor or pending writes: a page reload (new code version) waits
B.busy = () => !!g || editing != null || unsaved().size > 0 || uploading();
// a button gives up focus after a mouse click: otherwise Enter and Space press it again and board keys stay silent
document.addEventListener("click", (e) => { if (!e.detail) return; const b = e.target.closest && e.target.closest("button, input[type=checkbox]"); if (b && document.activeElement === b) b.blur(); });
document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
$("#add-image").addEventListener("click", () => { if (!blockedByLayout()) $("#file").click(); });
$("#file").addEventListener("change", (e) => { addFiles([...e.target.files], toWorld(innerWidth / 2, innerHeight / 2)); e.target.value = ""; });
$("#undo").addEventListener("click", () => B.undo()); $("#redo").addEventListener("click", () => B.redo());
$("#z-in").addEventListener("click", () => zoomAt(innerWidth / 2, innerHeight / 2, 1.25));
$("#z-out").addEventListener("click", () => zoomAt(innerWidth / 2, innerHeight / 2, .8));
$("#z-val").addEventListener("click", () => zoomAt(innerWidth / 2, innerHeight / 2, 1 / cam.k));
$("#fit").addEventListener("click", () => fitAll());
const th = lsGet("board-theme", null); if (th) document.documentElement.dataset.theme = th;
$("#theme").addEventListener("click", () => { const c = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"), next = c === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = next; lsSet("board-theme", next); });
window.addEventListener("resize", updateOverlay);
setTool("select"); refreshUndoBtns(); applyCam();
Object.assign(B, { setTool, maxZ, assets: () => assets, frameContents, toDoc, enqueue, dirty, active, toWorld, canWrite: () => canWrite, boot });
// filters.js is appended to the same script and must attach first: boot runs as the next task
setTimeout(boot, 0);
