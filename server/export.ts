// Exports the board as one self-contained, read-only HTML file: fonts and images inside, opens from disk, can be sent as an attachment.
// usage: bun server/export.ts --out board.html [--data <dir>] [--frames <id,id>] [--title "…"] [--with-notes]
// --frames keeps only those top-level frames and everything whose centre lies inside them (frame ids: the inspector or data/elements).
// Cards with "Show when presenting" unticked are speaker notes: they stay out of the file unless --with-notes is given.
// Images are downsized to 1600 px when cwebp is installed; otherwise the originals go in as they are.
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dir, "..");
const argOf = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const DATA = resolve(argOf("--data") || join(ROOT, "data"));
const OUT = argOf("--out");
if (!OUT) { console.error("usage: bun server/export.ts --out board.html [--data <dir>] [--frames <id,id>] [--title \"…\"] [--with-notes]"); process.exit(1); }
const TITLE = argOf("--title") || "talkboard";
const FRAMES = (argOf("--frames") || "").split(",").filter(Boolean);

const readColl = (c: string) => {
  const dir = join(DATA, c), out: Record<string, any> = {};
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith(".json")) out[f.slice(0, -5)] = JSON.parse(readFileSync(join(dir, f), "utf8"));
  return out;
};
const els = readColl("elements");
let keep = els;
if (FRAMES.length) {
  const boxes = FRAMES.map((id) => { if (!els[id]) { console.error("no frame", id); process.exit(1); } return els[id]; });
  const inside = (d: any) => {
    if (d.x == null) return false;
    const cx = d.x + (d.w || 0) / 2, cy = d.y + (d.h || 20) / 2;
    return boxes.some((b) => b.x <= cx && cx <= b.x + b.w && b.y <= cy && cy <= b.y + b.h);
  };
  keep = Object.fromEntries(Object.entries(els).filter(([id, d]) => FRAMES.includes(id) || (d.kind !== "group" && inside(d))));
  for (const d of Object.values(keep)) if (d.parent && els[d.parent]) keep[d.parent] = els[d.parent];   // the groups they belong to
  for (const [id, d] of Object.entries(els)) if (d.kind === "arrow" && keep[d.from] && keep[d.to]) keep[id] = d;   // arrows between kept cards
}
let notes = 0;
if (!process.argv.includes("--with-notes")) {
  keep = { ...keep };
  for (const [id, d] of Object.entries(keep)) if (d.noshow) { delete keep[id]; notes++; }
  for (const [id, d] of Object.entries(keep)) if (d.kind === "arrow" && (!keep[d.from] || !keep[d.to])) delete keep[id];   // arrows to a dropped note
}
const store: Record<string, any> = {};
for (const [id, d] of Object.entries(keep)) store["elements/" + id] = d;
for (const [id, d] of Object.entries(readColl("meta"))) store["meta/" + id] = d;
if (!FRAMES.length) for (const [id, d] of Object.entries(readColl("views"))) store["views/" + id] = d;

// images and files as data URIs
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", pdf: "application/pdf" };
const CWEBP = Bun.which("cwebp");
const tmp = mkdtempSync(join(tmpdir(), "talkboard-"));
const blobs: Record<string, string> = {};
const files = existsSync(join(DATA, "files")) ? readdirSync(join(DATA, "files")) : [];
for (const d of Object.values(keep)) {
  const a = d.asset; if (!a || blobs[a]) continue;
  const f = files.find((x) => x.startsWith(a + ".")); if (!f) { console.error("missing file for", a); continue; }
  const ext = f.slice(f.lastIndexOf(".") + 1).toLowerCase(), src = join(DATA, "files", f);
  let bytes = readFileSync(src), type = MIME[ext] || "application/octet-stream";
  if (CWEBP && /^(png|jpe?g|webp)$/.test(ext)) {
    const dst = join(tmp, a + ".webp");
    const p = Bun.spawnSync([CWEBP, "-quiet", "-q", "82", "-resize", String(Math.min(d.nw || 1600, 1600)), "0", src, "-o", dst]);
    if (p.exitCode === 0) { bytes = readFileSync(dst); type = "image/webp"; }
  }
  blobs[a] = `data:${type};base64,${bytes.toString("base64")}`;
}
rmSync(tmp, { recursive: true, force: true });

const r = (p: string) => readFileSync(join(ROOT, p), "utf8");
const font = (f: string) => `url(data:font/woff2;base64,${readFileSync(join(ROOT, "fonts", f)).toString("base64")})`;
const css = r("src/board.css").replace("url(/fonts/martian-grotesk-vf-ext.woff2)", font("martian-grotesk-vf-ext.woff2")).replace("url(/fonts/martian-mono-vf.woff2)", font("martian-mono-vf.woff2"));
const js = ["board.js", "filters.js"].map((f) => r("src/" + f)).join("\n");
const json = (o: any) => JSON.stringify(o).replace(/</g, "\\u003c");
// a read-only store with the same API as src/store-client.js
const stub = `(() => {
  const store = ${json(store)}; window.__mockBlob = ${json(blobs)};
  const snapDoc = (id, data) => ({ id, exists: data != null, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } });
  const ro = async () => { throw Object.assign(new Error("read only"), { code: "not_granted" }); };
  const coll = (c) => ({
    doc: (id) => ({ id, get: async () => snapDoc(id, store[c + "/" + id]), set: ro, update: ro, delete: ro }),
    onSnapshot(next) {
      const ds = Object.keys(store).filter((k) => k.startsWith(c + "/")).map((k) => snapDoc(k.slice(c.length + 1), store[k]));
      setTimeout(() => next({ docs: ds, size: ds.length, empty: !ds.length, docChanges: () => ds.map((d) => ({ type: "added", doc: d })), metadata: { fromCache: false } }), 0);
      return () => {};
    },
  });
  window.boardStore = { db: { collection: coll, doc: (p) => { const i = p.lastIndexOf("/"); return coll(p.slice(0, i)).doc(p.slice(i + 1)); } }, assets: null, readOnly: true };
})();`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const body = r("src/index.html").replace("<title>talkboard</title>", () => `<title>${esc(TITLE)}</title>`).replace("/*CSS*/", () => css).replace("/*JS*/", () => js);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><script>${stub}</script></head><body>${body}</body></html>`;
await Bun.write(OUT, html);
console.log(`${OUT}: ${Math.round(html.length / 1024)} KB · ${Object.keys(keep).length} items · ${Object.keys(blobs).length} files${notes ? ` · ${notes} speaker notes left out (--with-notes keeps them)` : ""}`);
