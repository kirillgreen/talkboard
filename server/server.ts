// talkboard server: serves the page and writes every edit straight to disk.
// usage: bun server/server.ts [--port 4317] [--data <dir>] [--git]
// Data: <dir>/<collection>/<id>.json, files: <dir>/files/<id>.<ext>. The default <dir> is ./data next to the code.
// Listens on 127.0.0.1 only. The page is assembled from src/ on every request, so a source edit shows after a reload.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync, watch, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const argOf = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const DATA = resolve(argOf("--data") || join(ROOT, "data"));
const FILES = join(DATA, "files");
const COLLS = ["elements", "views", "meta"];
const PORT = Number(argOf("--port")) || 4317;
const MAX = 500 * 1048576;
const FONTS = join(ROOT, "fonts");                // Martian Grotesk and Mono (SIL OFL), served locally: the board needs nothing from the network
const PREV = join(DATA, ".previews");             // downsized image copies, never committed
const SNAPSHOTS = process.argv.includes("--git");   // hourly commits of the data folder, opt-in
const ID = /^(?!\.)[A-Za-z0-9_\-.~:@+]{1,200}$/;
let changedSince = false;

// First run on an empty data folder: copy the demo board in, so a new user sees how it works (--empty starts blank).
const DEMO = join(ROOT, "demo");
if (!existsSync(join(DATA, "elements")) && existsSync(DEMO) && !process.argv.includes("--empty")) {
  for (const c of [...COLLS, "files"]) { const from = join(DEMO, c); if (!existsSync(from)) continue; mkdirSync(join(DATA, c), { recursive: true }); for (const f of readdirSync(from)) writeFileSync(join(DATA, c, f), readFileSync(join(from, f))); }
  console.log("talkboard: new data folder, demo board copied in");
}
for (const c of [...COLLS, "files", ".previews"]) mkdirSync(join(DATA, c), { recursive: true });

// ---------- store: one document = one file, cached in memory ----------
const sortKeys = (v: any): any => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const ser = (d: any) => JSON.stringify(sortKeys(d), null, 1) + "\n";
const cache = new Map<string, Map<string, any>>();
function load(c: string) {
  const m = new Map<string, any>();
  for (const f of readdirSync(join(DATA, c))) if (f.endsWith(".json")) {
    try { m.set(f.slice(0, -5), JSON.parse(readFileSync(join(DATA, c, f), "utf8"))); } catch (e) { console.error("unreadable file", c, f, e); }
  }
  cache.set(c, m);
}
COLLS.forEach(load);
function writeDoc(c: string, id: string, d: any) {
  const p = join(DATA, c, id + ".json"), tmp = p + ".tmp";
  writeFileSync(tmp, ser(d)); renameSync(tmp, p); // atomic: the file is either old or new
  cache.get(c)!.set(id, d); broadcast(c, id, d); changedSince = true;
}
function deleteDoc(c: string, id: string) {
  const p = join(DATA, c, id + ".json");
  if (existsSync(p)) unlinkSync(p);
  cache.get(c)!.delete(id); broadcast(c, id, null); changedSince = true;
}

// ---------- live updates: SSE to every open tab ----------
const clients = new Set<ReadableStreamDefaultController>();
const enc = new TextEncoder();
function broadcast(coll: string, id: string, data: any) {
  const msg = enc.encode(`data: ${JSON.stringify({ coll, id, data })}\n\n`);
  for (const c of clients) { try { c.enqueue(msg); } catch { clients.delete(c); } }
}
setInterval(() => { for (const c of clients) { try { c.enqueue(enc.encode(": ping\n\n")); } catch { clients.delete(c); } } }, 20000);
// A code edit reloads open tabs, so nobody works on an old version with fresh data.
let codeT: ReturnType<typeof setTimeout> | undefined;
const codeChanged = () => { clearTimeout(codeT); codeT = setTimeout(() => broadcast("__code", "", null), 400); };
watch(join(ROOT, "src"), (_ev, f) => { if (f && /\.(js|css|html)$/.test(f)) codeChanged(); });

// Edits made outside (git pull, another editor, a script) reach open tabs too.
for (const c of COLLS) watch(join(DATA, c), (_ev, f) => {
  if (!f || !f.endsWith(".json")) return;
  const id = f.slice(0, -5), p = join(DATA, c, f), m = cache.get(c)!;
  setTimeout(() => {
    if (!existsSync(p)) { if (m.has(id)) { m.delete(id); broadcast(c, id, null); } return; }
    try { const d = JSON.parse(readFileSync(p, "utf8")); if (ser(d) !== ser(m.get(id))) { m.set(id, d); broadcast(c, id, d); } } catch { /* the file is still being written */ }
  }, 60);
});

// ---------- files ----------
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif", "image/heic": "heic", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "application/pdf": "pdf", "text/markdown": "md", "text/plain": "txt", "text/csv": "csv", "application/json": "json", "font/woff2": "woff2", "font/ttf": "ttf", "font/otf": "otf" };
const TYPE: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));
TYPE.jpeg = "image/jpeg"; TYPE.m4v = "video/mp4"; TYPE.markdown = "text/markdown";
const findFile = (id: string) => readdirSync(FILES).find((f) => f.startsWith(id + "."));
const newId = () => crypto.randomUUID().replace(/-/g, "");

// ---------- image previews (macOS: sips, optionally cwebp); elsewhere the original is served ----------
const CWEBP = Bun.which("cwebp") || (existsSync("/opt/homebrew/bin/cwebp") ? "/opt/homebrew/bin/cwebp" : null);
const RASTER = new Set(["png", "jpg", "jpeg", "webp", "heic", "avif", "tif", "tiff"]);
const pending = new Map<string, Promise<string | null>>();
async function run(cmd: string[]) { try { const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" }); const out = await new Response(p.stdout).text(); return (await p.exited) === 0 ? out : null; } catch { return null; } }
function preview(src: string, id: string, w: number): Promise<string | null> {
  const out = join(PREV, `${id}-${w}.webp`), jpg = out.replace(/\.webp$/, ".jpg");
  if (existsSync(out)) return Promise.resolve(out);
  if (existsSync(jpg)) return Promise.resolve(jpg);
  const key = out; if (pending.has(key)) return pending.get(key)!;
  const job = (async () => {
    const info = await run(["sips", "-g", "pixelWidth", src]);
    const pw = Number(/pixelWidth: (\d+)/.exec(info || "")?.[1] || 0);
    if (!pw || pw <= w) return src;                  // no wider than the preview (or no sips): serve the original
    // sips can't write webp: cwebp makes it when installed, otherwise sips writes jpeg
    const cw = CWEBP && /\.(png|jpe?g|webp|tiff?)$/i.test(src), dst = cw ? out : out.replace(/\.webp$/, ".jpg"), tmp = dst + ".tmp";
    const ok = cw ? await run([CWEBP!, "-quiet", "-q", "82", "-alpha_q", "90", "-resize", String(w), "0", src, "-o", tmp])
                  : await run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "82", "--resampleWidth", String(w), src, "--out", tmp]);
    if (ok === null || !existsSync(tmp)) return null;
    renameSync(tmp, dst); return dst;
  })().finally(() => pending.delete(key));
  pending.set(key, job); return job;
}

// ---------- git snapshots (--git): hourly if anything changed, and on server stop ----------
let REPO = SNAPSHOTS ? (await run(["git", "-C", DATA, "rev-parse", "--show-toplevel"]))?.trim() || null : null;
if (SNAPSHOTS && !REPO) console.error("--git: the data folder is not inside a git repository, snapshots are off");
if (REPO && Bun.spawnSync(["git", "-C", REPO, "check-ignore", "-q", "--", DATA]).exitCode === 0) {
  console.error("--git: the data folder is git-ignored here (the default ./data is ignored by talkboard's own .gitignore); keep the board elsewhere with --data <dir> inside your own repository. Snapshots are off");
  REPO = null;
}
if (REPO && !existsSync(join(DATA, ".gitignore"))) writeFileSync(join(DATA, ".gitignore"), ".previews/\n");   // previews are a cache: keep them out of snapshots
async function snapshot(reason: string) {
  if (!REPO || !changedSince) return;
  changedSince = false;
  const rel = DATA;                                  // commit only the board's data folder, nothing else
  const add = await run(["git", "-C", REPO, "add", "-A", "--", rel]);
  const diff = Bun.spawnSync(["git", "-C", REPO, "diff", "--cached", "--quiet", "--", rel]).exitCode;
  if (add === null) { changedSince = true; console.error("snapshot: git add failed"); return; }
  if (diff === 0) return;
  const ok = await run(["git", "-C", REPO, "commit", "-q", "-m", `talkboard: snapshot (${reason})`, "--", rel]);
  if (ok === null) { changedSince = true; await run(["git", "-C", REPO, "reset", "-q", "--", rel]); console.error("snapshot: git commit failed, index restored, retrying in an hour"); }   // never leave data/ staged: an unrelated commit would pick it up
  else console.log(new Date().toISOString(), "git snapshot:", reason);
}
if (REPO) setInterval(() => snapshot("hourly"), 3600e3);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, async () => { await snapshot("server stop"); process.exit(0); });

// ---------- cleanup: files no item has referenced for a week are deleted ----------
// The week counts from the day cleanup first saw the file unreferenced (.previews/unref.json), not from upload:
// undo can still bring back an image from a card deleted today for a whole week.
const UNREF = join(PREV, "unref.json");
function sweep() {
  try { sweepOnce(); } catch (e) { console.error("cleanup failed, retrying tomorrow", e); }
}
function sweepOnce() {
  // A document that failed to parse may point at files we can't see: skip the whole sweep rather than delete them.
  for (const c of COLLS) for (const f of readdirSync(join(DATA, c))) if (f.endsWith(".json") && !cache.get(c)!.has(f.slice(0, -5))) {
    console.error("cleanup skipped: unreadable document", c + "/" + f); return;
  }
  // Every string value anywhere in a document counts as a reference, whatever the id looks like (uploads get 32 hex, the demo has names).
  const used = new Set<string>();
  const walk = (v: any) => { if (typeof v === "string") { used.add(v); for (const m of v.matchAll(/[0-9a-f]{32}/g)) used.add(m[0]); } else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x); };
  for (const c of COLLS) for (const d of cache.get(c)!.values()) walk(d);
  let seen: Record<string, number> = {}; try { seen = JSON.parse(readFileSync(UNREF, "utf8")); } catch { /* first run */ }
  const now = Date.now(), week = now - 7 * 864e5, next: Record<string, number> = {}; let n = 0;
  for (const f of readdirSync(FILES)) {
    const id = f.slice(0, f.indexOf(".")); if (used.has(id)) continue;
    const p = join(FILES, f), first = seen[id] || now;
    if (first > week || statSync(p).mtimeMs > week) { next[id] = first; continue; }
    unlinkSync(p); n++;
    for (const pv of readdirSync(PREV)) if (pv.startsWith(id + "-")) unlinkSync(join(PREV, pv));
  }
  writeFileSync(UNREF + ".tmp", JSON.stringify(next)); renameSync(UNREF + ".tmp", UNREF);
  if (n) { changedSince = true; console.log(new Date().toISOString(), "cleanup: unreferenced files deleted:", n); }
}
setTimeout(sweep, 60e3); setInterval(sweep, 864e5);

// ---------- page ----------
function page() {
  const r = (p: string) => readFileSync(join(ROOT, p), "utf8");
  const css = r("src/board.css");
  const js = ["board.js", "filters.js"].map((f) => r("src/" + f)).join("\n");
  const html = r("src/index.html").replace("/*CSS*/", () => css).replace("/*JS*/", () => js);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>${r("src/store-client.js")}</script></head><body>${html}</body></html>`;
}

// Other pages in the browser must not reach the board: DNS rebinding (a foreign name on 127.0.0.1) and no-cors requests from other sites.
const OWN = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
function foreign(req: Request) {
  if (!OWN.has(req.headers.get("host") || "")) return true;
  const o = req.headers.get("origin");
  return req.method !== "GET" && req.method !== "HEAD" && !!o && !OWN.has(o.replace(/^http:\/\//, ""));
}
// A file opens on the board's own origin: svg and html are sandboxed, the type is never sniffed
const SAFE_INLINE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "mp4", "m4v", "mov", "webm", "pdf", "md", "markdown", "txt", "csv", "json", "woff2", "ttf", "otf"]);
const blobHeaders = (ext: string, type: string) => ({ "content-type": type, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff", ...(SAFE_INLINE.has(ext) ? {} : { "content-security-policy": "sandbox" }) });

const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  maxRequestBodySize: MAX + 1024,
  idleTimeout: 0,
  async fetch(req) {
    if (foreign(req)) return new Response("forbidden", { status: 403 });
    const url = new URL(req.url), path = decodeURIComponent(url.pathname), m = req.method;
    if (path === "/" || path === "/index.html") return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (path === "/api/health") return json({ ok: true, root: ROOT });
    if (path === "/api/events") {
      let ctl: ReadableStreamDefaultController;
      const stream = new ReadableStream({ start(c) { ctl = c; clients.add(c); c.enqueue(enc.encode(": hello\n\n")); }, cancel() { clients.delete(ctl); } });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
    }
    if (path === "/api/upload" && m === "POST") {
      const type = (req.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
      const buf = new Uint8Array(await req.arrayBuffer());
      if (buf.byteLength > MAX) return new Response("too large", { status: 413 });
      const name = url.searchParams.get("name") || "";
      const ext = EXT[type] || (extname(name).slice(1).toLowerCase().replace(/[^a-z0-9]/g, "") || "bin");
      const id = newId();
      writeFileSync(join(FILES, `${id}.${ext}`), buf);
      return json({ id, url: "/_blob/" + id, sizeBytes: buf.byteLength, contentType: type });
    }
    if (path.startsWith("/fonts/")) {
      const f = path.slice(7); if (!/^[a-z0-9-]+\.woff2$/.test(f) || !existsSync(join(FONTS, f))) return new Response("not found", { status: 404 });
      return new Response(Bun.file(join(FONTS, f)), { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" } });
    }
    if (path.startsWith("/_blob/")) {
      const id = path.slice(7); if (!ID.test(id)) return new Response("bad id", { status: 400 });
      const f = findFile(id); if (!f) return new Response("not found", { status: 404 });
      const ext = f.slice(f.lastIndexOf(".") + 1).toLowerCase();
      const w = Number(url.searchParams.get("w"));
      if ((w === 800 || w === 1600) && RASTER.has(ext)) {
        const p = await preview(join(FILES, f), id, w);
        if (p) return new Response(Bun.file(p), { headers: blobHeaders(ext, p.endsWith(".webp") ? "image/webp" : p.endsWith(".jpg") ? "image/jpeg" : TYPE[ext]) });
      }
      // Bun.file serves Range requests, which video seeking needs
      return new Response(Bun.file(join(FILES, f)), { headers: blobHeaders(ext, TYPE[ext] || "application/octet-stream") });
    }
    const api = path.match(/^\/api\/([a-z]+)(?:\/([^/]+))?$/);
    if (api && COLLS.includes(api[1])) {
      const [, c, id] = api, col = cache.get(c)!;
      if (!id) return m === "GET" ? json({ docs: [...col].map(([id, data]) => ({ id, data })) }) : new Response("method", { status: 405 });
      if (!ID.test(id)) return new Response("bad id", { status: 400 });
      if (m === "GET") return col.has(id) ? json(col.get(id)) : new Response("not found", { status: 404 });
      if (m === "PUT") { writeDoc(c, id, await req.json()); return new Response(null, { status: 204 }); }
      if (m === "PATCH") {
        if (!col.has(id)) return new Response("not found", { status: 404 });
        writeDoc(c, id, { ...col.get(id), ...(await req.json()) }); return new Response(null, { status: 204 });
      }
      if (m === "DELETE") { deleteDoc(c, id); return new Response(null, { status: 204 }); }
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`talkboard: http://127.0.0.1:${PORT}  ·  data: ${DATA}${REPO ? "  ·  git snapshots on" : ""}`);
