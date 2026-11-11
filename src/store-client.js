// Storage client: a small document-store API (collections, docs, live snapshots, uploads) over the local server (server/server.ts).
(() => {
  window.__boardLocal = true;
  const err = (code, msg) => Object.assign(new Error(msg || code), { code });
  async function call(method, path, body, type) {
    let r;
    try { r = await fetch(path, { method, body, headers: body == null ? {} : { "content-type": type || "application/json" } }); }
    catch (e) { throw err("unavailable", "the board server is not answering"); }
    if (r.status === 404) throw err("not_found");
    if (r.status === 413) throw err("too_large");
    if (!r.ok) throw err("unavailable", await r.text());
    return r.status === 204 ? null : r.json();
  }
  const snapDoc = (id, data) => ({ id, exists: data != null, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } });
  const subs = new Map(); // collection → Set of subscribers {cache: Map, next}
  const emit = (s, changes) => {
    if (!changes.length) return;
    const docs = [...s.cache].map(([id, d]) => snapDoc(id, d));
    s.next({ docs, size: docs.length, empty: !docs.length, docChanges: () => changes, metadata: { fromCache: false } });
  };
  async function resync(c, s) { // full list from the server → diff against what the subscriber has seen
    const { docs } = await call("GET", `/api/${c}`), seen = new Map(docs.map((d) => [d.id, d.data])), ch = [];
    for (const [id, d] of seen) {
      const old = s.cache.get(id);
      if (old === undefined) ch.push({ type: "added", doc: snapDoc(id, d) });
      else if (JSON.stringify(old) !== JSON.stringify(d)) ch.push({ type: "modified", doc: snapDoc(id, d) });
    }
    for (const id of s.cache.keys()) if (!seen.has(id)) ch.push({ type: "removed", doc: snapDoc(id, null) });
    s.cache = seen; emit(s, ch);
  }
  // new code version: the reload waits for gestures, text edits, presenting and disk writes to finish
  let reloadT = 0;
  function reloadSoon() {
    clearTimeout(reloadT);
    reloadT = setTimeout(() => {
      const a = document.activeElement, B = window.Board;
      const busy = (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) || document.body.classList.contains("show") || (B && B.busy && B.busy());
      if (busy) { reloadSoon(); return; }
      try { sessionStorage.setItem("board-reloaded", "1"); } catch (e) {}
      location.reload();
    }, 600);
  }
  let es = null, everOpen = false;
  function stream() {
    if (es) return; es = new EventSource("/api/events");
    es.onopen = () => { if (everOpen) for (const [c, set] of subs) for (const s of set) if (s.ready) resync(c, s).catch(console.error); everOpen = true; };
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      if (ev.coll === "__code") { reloadSoon(); return; }
      const set = subs.get(ev.coll); if (!set) return;
      for (const s of set) {
        if (!s.ready) { s.missed = true; continue; }   // the first list hasn't arrived: resync fully once it does
        const had = s.cache.has(ev.id);
        if (ev.data == null) { if (!had) continue; s.cache.delete(ev.id); emit(s, [{ type: "removed", doc: snapDoc(ev.id, null) }]); }
        else { if (had && JSON.stringify(s.cache.get(ev.id)) === JSON.stringify(ev.data)) continue; s.cache.set(ev.id, ev.data); emit(s, [{ type: had ? "modified" : "added", doc: snapDoc(ev.id, ev.data) }]); }
      }
    };
  }
  const coll = (c) => ({
    doc: (id) => {
      const p = `/api/${c}/${encodeURIComponent(id)}`;
      return {
        id,
        get: async () => { try { const d = await call("GET", p); return snapDoc(id, d); } catch (e) { if (e.code === "not_found") return snapDoc(id, null); throw e; } },
        set: (d) => call("PUT", p, JSON.stringify(d)).then(() => {}),
        update: (d) => call("PATCH", p, JSON.stringify(d)).then(() => {}),
        delete: () => call("DELETE", p).then(() => {}),
      };
    },
    onSnapshot(next, onError) {
      const s = { cache: new Map(), next, ready: false, missed: false };
      if (!subs.has(c)) subs.set(c, new Set()); subs.get(c).add(s); stream();
      (async () => {
        for (let a = 0; ; a++) {
          try {
            const { docs } = await call("GET", `/api/${c}`); s.cache = new Map(docs.map((d) => [d.id, d.data]));
            const all = docs.map((d) => snapDoc(d.id, d.data));
            next({ docs: all, size: all.length, empty: !all.length, docChanges: () => all.map((d) => ({ type: "added", doc: d })), metadata: { fromCache: false } });
            s.ready = true; if (s.missed) { s.missed = false; resync(c, s).catch(console.error); }
            return;
          } catch (e) { if (a === 0 && onError) onError(e); await new Promise((r) => setTimeout(r, Math.min(5000, 500 * 2 ** a))); }
        }
      })();
      return () => subs.get(c).delete(s);
    },
  });
  const db = { collection: coll, doc: (p) => { const i = p.lastIndexOf("/"); return coll(p.slice(0, i)).doc(p.slice(i + 1)); } };
  const assets = {
    upload: async (blob) => call("POST", "/api/upload?name=" + encodeURIComponent(blob.name || ""), blob, blob.type || "application/octet-stream"),
  };
  window.boardStore = { db, assets, readOnly: false };
})();
