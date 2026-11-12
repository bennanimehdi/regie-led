/* Régie LED — petit serveur local sans dépendance.
 *   node serve.js [port]   →   http://localhost:4400
 * Il sert l'interface, les médias du dossier media/ (avec lecture partielle pour les vidéos)
 * et enregistre le show dans data/show.json. Écoute uniquement sur cet ordinateur (127.0.0.1).
 * Utilisable aussi comme module : `startServer({ root, dataDir, mediaDir, toolsDir, port })` (c'est ce que fait l'application de bureau). */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';

const DEFAULT_ROOT = path.dirname(fileURLToPath(import.meta.url));


const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.ico': 'image/x-icon',
};
const VIDEO = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);
const STATIC = new Set(['index.html', 'output.html', 'logo.png']);   // + dossiers js/ et css/
// Documents convertis en images (une par page) : PDF directement, Office en pilotant l'application installée (macOS).
const DOCS = { '.pdf': 'pdf', '.pptx': 'powerpoint', '.ppt': 'powerpoint', '.ppsx': 'powerpoint', '.pps': 'powerpoint',
  '.docx': 'word', '.doc': 'word', '.xlsx': 'excel', '.xls': 'excel' };
const APP_NAME = { powerpoint: 'PowerPoint', word: 'Word', excel: 'Excel' };
const docId = raw => { const n = String(raw || ''); return n && n === path.basename(n) && !n.startsWith('.') && !/[\u0000-\u001f\\/]/.test(n) ? n : null; };
const PPT_EXT = new Set(['.pptx', '.ppt', '.ppsx', '.pps']);

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

/** Erreur d'écriture sur le disque, expliquée. Sous Windows, « ENOENT » ou « EPERM » dans Documents vient presque toujours de la
 *  « Protection contre les ransomwares » (accès contrôlé aux dossiers) qui bloque les applications inconnues. */
function fsMessage(e, dir) {
  const code = e?.code || '';
  if (process.platform === 'win32' && /ENOENT|EPERM|EACCES/.test(code)) return `Windows empêche la régie d'écrire dans « ${dir} ». Ouvre Sécurité Windows → Protection contre les virus et menaces → Protection contre les ransomwares → « Autoriser une application » et ajoute Régie LED (ou désactive l'accès contrôlé aux dossiers), puis relance la régie. (${code})`;
  if (/ENOSPC/.test(code)) return 'Le disque est plein : libère de la place puis réessaie.';
  if (/EACCES|EPERM/.test(code)) return `Écriture refusée dans « ${dir} » : vérifie les autorisations de ce dossier. (${code})`;
  return String(e?.message || e);
}

/** Nom de fichier sûr : jamais de chemin, jamais de fichier caché. */
function safeName(raw) {
  const n = path.basename(String(raw || '').normalize('NFC')).replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim();
  if (!n || n.startsWith('.')) return null;
  const ext = path.extname(n).toLowerCase();
  if (!VIDEO.has(ext) && !IMAGE.has(ext)) return null;
  return n;
}


/** Sert un fichier, avec prise en charge de Range (indispensable pour lire/chercher dans une vidéo). */
async function serveFile(req, res, file, cache) {
  let st;
  try { st = await fsp.stat(file); } catch { return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8'); }
  if (!st.isFile()) return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache ? 'max-age=3600' : 'no-store' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? +m[1] : Math.max(0, st.size - +m[2]);
    let end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  }
  res.writeHead(200, { ...head, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('trop gros')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); reject(err); } else resolve(String(stdout).trim());
    });
  });
}


function presName(raw) {
  const n = path.basename(String(raw || '').normalize('NFC')).replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim();
  return n && !n.startsWith('.') && PPT_EXT.has(path.extname(n).toLowerCase()) ? n : null;
}

/**
 * Démarre le serveur et renvoie `{ server, port, url, close }` une fois à l'écoute.
 *   root     — dossier des fichiers de l'interface (index.html, js/, css/…)      : ce dossier
 *   dataDir  — show, sauvegardes, documents, PowerPoint                            : root/data
 *   mediaDir — médiathèque                                                        : root/media
 *   toolsDir — scripts de conversion (osascript)                                  : root/tools
 *   port     — 0 = port libre choisi par le système                               : 4400
 */
export function startServer(opts = {}) {
  const root = opts.root || DEFAULT_ROOT;
  const MEDIA = opts.mediaDir || path.join(root, 'media');
  const DATA = opts.dataDir || path.join(root, 'data');
  const TOOLS = opts.toolsDir || path.join(root, 'tools');
  const SHOW = path.join(DATA, 'show.json');
  const BACKUPS = path.join(DATA, 'backups');                 // historique du show : une copie par minute d'enregistrement, 60 au plus
  const DOCD = path.join(DATA, 'documents');             // documents à pages (PDF, Word, Excel, PowerPoint en images) : un dossier par document
  const PRES = path.join(DATA, 'presentations');          // PowerPoint joués « en direct » (fenêtre capturée par la régie)
  // Dossier de travail dans /private/tmp : c'est le seul endroit où Word (application « bac à sable ») accepte d'écrire son PDF.
  const WORK = process.platform === 'darwin' ? '/private/tmp/regie-led-conversion' : path.join(DATA, 'conversion');
  let converting = false;
  const diag = {};
  fs.mkdirSync(MEDIA, { recursive: true });
  fs.mkdirSync(BACKUPS, { recursive: true });

  /** Garde une copie datée du show avant de l'écraser (au plus une par minute), et ne conserve que les 60 dernières. */
  async function backupShow() {
    try {
      if (!fs.existsSync(SHOW)) return;
      const d = new Date(), stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
      const dest = path.join(BACKUPS, `show-${stamp}.json`);
      if (fs.existsSync(dest)) return;                         // déjà une copie pour cette minute
      await fsp.copyFile(SHOW, dest);
      const old = (await fsp.readdir(BACKUPS)).filter(n => /^show-\d{8}-\d{4}\.json$/.test(n)).sort().slice(0, -60);
      for (const n of old) await fsp.rm(path.join(BACKUPS, n), { force: true });
    } catch { /* la sauvegarde ne doit jamais empêcher l'enregistrement */ }
  }

  /* ---------- espace disque : empreinte et dernière utilisation de chaque fichier, doublons, nettoyage ----------
   * data/fichiers.json : { media: {nom: {size, mtime, hash, lastUsed}}, docs: {id: lastUsed}, ppt: {nom: lastUsed},
   *   alias: {doublon supprimé: fichier gardé}, autoClean: jours (0 = jamais) }.
   * « Dernière utilisation » = le dernier enregistrement d'un show qui s'en sert : un show ouvert met à jour ses fichiers. */
  const INDEX = path.join(DATA, 'fichiers.json');
  let idx = { media: {}, docs: {}, ppt: {}, alias: {}, autoClean: 0 };
  try { idx = { ...idx, ...JSON.parse(fs.readFileSync(INDEX, 'utf8')) }; } catch { /* premier lancement */ }
  let idxT = null;
  const saveIdx = () => { clearTimeout(idxT); idxT = setTimeout(() => fsp.writeFile(INDEX, JSON.stringify(idx)).catch(() => {}), 400); };
  const hashFile = file => new Promise((ok, ko) => { const h = crypto.createHash('sha256'); fs.createReadStream(file).on('data', c => h.update(c)).on('end', () => ok(h.digest('hex'))).on('error', ko); });
  async function mediaHash(name) {
    const file = path.join(MEDIA, name), st = await fsp.stat(file), e = idx.media[name];
    if (e?.hash && e.size === st.size && e.mtime === Math.round(st.mtimeMs)) return e.hash;
    const hash = await hashFile(file);
    idx.media[name] = { ...(e || {}), size: st.size, mtime: Math.round(st.mtimeMs), hash, lastUsed: e?.lastUsed || Date.now() };
    saveIdx(); return hash;
  }
  /** Un fichier au contenu identique (même taille puis même empreinte) est-il déjà dans media/ ? */
  async function findSame(size, hash) {
    for (const name of await fsp.readdir(MEDIA)) {
      if (name.startsWith('.') || !safeName(name)) continue;
      const st = await fsp.stat(path.join(MEDIA, name)).catch(() => null);
      if (st?.isFile() && st.size === size && await mediaHash(name) === hash) return name;
    }
    return null;
  }
  /** Fichiers dont un show se sert : clips (src, diaporamas, documents, PowerPoint) et sa médiathèque (show.files). */
  function showRefs(sh) {
    const media = new Set(), docs = new Set(), ppt = new Set();
    const add = src => { const m = /^\/media\/(.+)$/.exec(String(src || '')); if (m) { try { const n = decodeURIComponent(m[1]); media.add(idx.alias[n] || n); } catch { /* adresse abîmée */ } } };
    for (const c of Object.values(sh?.clips || {})) { add(c?.src); for (const it of c?.items || []) add(it?.src); if (c?.doc) docs.add(c.doc); if (c?.ppt) ppt.add(c.ppt); }
    for (const f of Array.isArray(sh?.files) ? sh.files : []) { if (f.startsWith('doc:')) docs.add(f.slice(4)); else if (f.startsWith('ppt:')) ppt.add(f.slice(4)); else if (!f.startsWith('cam:')) media.add(idx.alias[f] || f); }
    return { media, docs, ppt };
  }
  function touchRefs(sh) {
    const r = showRefs(sh), now = Date.now();
    for (const n of r.media) (idx.media[n] ||= {}).lastUsed = now;
    for (const d of r.docs) idx.docs[d] = now;
    for (const n of r.ppt) idx.ppt[n] = now;
    saveIdx();
  }
  const dirSize = async dir => { let n = 0; for (const f of await fsp.readdir(dir).catch(() => [])) { const st = await fsp.stat(path.join(dir, f)).catch(() => null); if (st?.isFile()) n += st.size; } return n; };
  /** Inventaire : chaque fichier avec sa taille, sa dernière utilisation et s'il sert au show en cours ; groupes de doublons. */
  async function storage() {
    let cur = null; try { cur = JSON.parse(await fsp.readFile(SHOW, 'utf8')); } catch { /* pas de show */ }
    const r = showRefs(cur), now = Date.now(), media = [], docs = [], ppt = [], byHash = {};
    for (const name of await fsp.readdir(MEDIA).catch(() => [])) {
      if (name.startsWith('.') || !safeName(name)) continue;
      const st = await fsp.stat(path.join(MEDIA, name)).catch(() => null); if (!st?.isFile()) continue;
      const hash = await mediaHash(name), e = idx.media[name];
      if (!e.lastUsed) e.lastUsed = now;
      media.push({ name, size: st.size, lastUsed: e.lastUsed, used: r.media.has(name) });
      (byHash[hash] ||= []).push(name);
    }
    for (const d of await fsp.readdir(DOCD).catch(() => [])) {
      let meta = null; try { meta = JSON.parse(await fsp.readFile(path.join(DOCD, d, 'meta.json'), 'utf8')); } catch { continue; }
      if (!idx.docs[d]) idx.docs[d] = now;
      docs.push({ id: d, name: meta.name || d, size: await dirSize(path.join(DOCD, d)), lastUsed: idx.docs[d], used: r.docs.has(d) });
    }
    for (const name of await fsp.readdir(PRES).catch(() => [])) {
      if (!presName(name) || name.startsWith('~$')) continue;
      const st = await fsp.stat(path.join(PRES, name)).catch(() => null); if (!st?.isFile()) continue;
      if (!idx.ppt[name]) idx.ppt[name] = now;
      ppt.push({ name, size: st.size, lastUsed: idx.ppt[name], used: r.ppt.has(name) });
    }
    saveIdx();
    const dups = Object.values(byHash).filter(g => g.length > 1).map(g => {
      // on garde celui dont se sert le show, sinon le nom sans « (2) », sinon le plus court
      const keep = [...g].sort((a, b) => (r.media.has(b) - r.media.has(a)) || (/\(\d+\)\.[^.]+$/.test(a) - /\(\d+\)\.[^.]+$/.test(b)) || a.length - b.length || a.localeCompare(b))[0];
      return { keep, drop: g.filter(n => n !== keep), size: media.find(m => m.name === keep).size * (g.length - 1) };
    });
    return { media, docs, ppt, dups, autoClean: idx.autoClean || 0 };
  }
  /** Supprime les doublons : un seul fichier gardé par contenu ; les noms supprimés restent valables (alias) pour tous les shows. */
  async function dedupe() {
    const st = await storage(), map = {}; let freed = 0;
    for (const g of st.dups) for (const n of g.drop) {
      await fsp.rm(path.join(MEDIA, n), { force: true });
      idx.alias[n] = g.keep; for (const [k, v] of Object.entries(idx.alias)) if (v === n) idx.alias[k] = g.keep;
      delete idx.media[n]; map[n] = g.keep; freed += st.media.find(m => m.name === n)?.size || 0;
    }
    saveIdx();
    return { map, freed };
  }
  /** Fichiers inutilisés depuis `days` jours (et pas utilisés par le show en cours) → corbeille de l'ordinateur (récupérables). */
  async function cleanUnused(days, dry) {
    const st = await storage(), limit = Date.now() - days * 86400000, out = [];
    const old = x => !x.used && x.lastUsed < limit;
    for (const m of st.media.filter(old)) out.push({ kind: 'media', name: m.name, size: m.size, file: path.join(MEDIA, m.name) });
    for (const d of st.docs.filter(old)) out.push({ kind: 'doc', name: d.name, id: d.id, size: d.size, file: path.join(DOCD, d.id) });
    for (const x of st.ppt.filter(old)) out.push({ kind: 'ppt', name: x.name, size: x.size, file: path.join(PRES, x.name) });
    if (dry) return { files: out.map(({ file, ...f }) => f), freed: out.reduce((a, f) => a + f.size, 0) };
    const done = [];
    for (const f of out) {
      try {
        if (opts.trash) await opts.trash(f.file);
        else { const bin = path.join(DATA, 'corbeille'); await fsp.mkdir(bin, { recursive: true }); await fsp.rename(f.file, path.join(bin, Date.now() + '-' + path.basename(f.file))); }
        if (f.kind === 'media') delete idx.media[f.name]; else if (f.kind === 'doc') delete idx.docs[f.id]; else delete idx.ppt[f.name];
        done.push(f);
      } catch { /* fichier ouvert ailleurs : on le laisse */ }
    }
    saveIdx();
    return { files: done.map(({ file, ...f }) => f), freed: done.reduce((a, f) => a + f.size, 0) };
  }
  if (idx.autoClean > 0) setTimeout(() => cleanUnused(idx.autoClean).then(r => { if (r.files.length) diag.nettoyage = { at: new Date().toISOString(), ...r }; }).catch(() => {}), 15000);

  async function listMedia() {
    const out = [];
    for (const name of await fsp.readdir(MEDIA)) {
      const ext = path.extname(name).toLowerCase();
      const type = VIDEO.has(ext) ? 'video' : IMAGE.has(ext) ? 'image' : null;
      if (!type || name.startsWith('.')) continue;
      const st = await fsp.stat(path.join(MEDIA, name));
      if (st.isFile()) out.push({ name, type, size: st.size, mtime: st.mtimeMs, url: '/media/' + encodeURIComponent(name) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
  }

  /** Document (PDF, PowerPoint, Word, Excel) → images JPEG dans media/, une par page. Renvoie la liste des fichiers créés. */
  async function importDoc(req, rawName, maxSide) {
    const ext = path.extname(String(rawName || '')).toLowerCase(), kind = DOCS[ext];
    if (!kind) throw Object.assign(new Error('Type de document non pris en charge (PDF, PowerPoint, Word, Excel).'), { code: 400 });
    if (process.platform !== 'darwin' && process.platform !== 'win32') throw Object.assign(new Error('La conversion de documents n\'est disponible que sur Mac et Windows.'), { code: 400 });
    if (converting) throw Object.assign(new Error('Une conversion est déjà en cours : attends qu\'elle se termine.'), { code: 409 });
    converting = true;
    try {
      await fsp.rm(WORK, { recursive: true, force: true });
      await fsp.mkdir(WORK, { recursive: true });
      const id = 'regie-import-' + Math.random().toString(36).slice(2, 8);     // nom unique : le script ne referme que ce document
      const src = path.join(WORK, id + ext);
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(src);
        req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject);
        req.on('aborted', () => reject(new Error('envoi interrompu')));
      });
      let pdf = src;
      if (process.platform === 'win32' && kind === 'pdf') return { pdfFile: src };     // PDF : la régie le lit elle-même (pdf.js)
      if (process.platform === 'win32' && kind !== 'powerpoint') {          // Word / Excel : Office l'exporte en PDF, la régie le lit (pdf.js)
        pdf = path.join(WORK, id + '.pdf');
        const app = APP_NAME[kind];
        try { await runPs('office2pdf.ps1', [kind, src, pdf], 250000); }
        catch (e) {
          if (/80040154|introuvable|Class not registered/i.test(e.stderr)) throw new Error(`${app} est introuvable sur cet ordinateur : installe Microsoft ${app}, ou exporte le fichier en PDF puis importe le PDF.`);
          if (e.killed) throw new Error(`${app} n'a pas répondu à temps : une fenêtre y attend peut-être une réponse. Regarde dans ${app}, puis réessaie.`);
          throw new Error(`${app} n'a pas pu convertir ce fichier. Exporte-le en PDF depuis ${app}, puis importe le PDF. (${String(e.stderr || '').trim().split('\n').pop().slice(0, 160)})`);
        }
        const st = await fsp.stat(pdf).catch(() => null);
        if (!st || !st.size) throw new Error(`${app} n'a produit aucune page. Exporte le fichier en PDF, puis importe le PDF.`);
        return { pdfFile: pdf };
      }
      if (process.platform === 'win32') {                                   // PowerPoint exporte lui-même chaque diapositive en JPEG
        try { await runPs('pptexport.ps1', [src, path.join(WORK, 'p-'), String(maxSide), '200', 'JPG'], 250000); }
        catch (e) {
          if (/80040154|introuvable|Class not registered/i.test(e.stderr)) throw new Error('PowerPoint est introuvable sur cet ordinateur : installe Microsoft PowerPoint, ou exporte le fichier en images.');
          if (e.killed) throw new Error('PowerPoint n\'a pas répondu à temps : une fenêtre y attend peut-être une réponse. Regarde dans PowerPoint, puis réessaie.');
          throw new Error('PowerPoint n\'a pas pu convertir ce fichier. (' + e.stderr.trim().split('\n').pop().slice(0, 160) + ')');
        }
      } else if (kind !== 'pdf') {
        pdf = path.join(WORK, id + '.pdf');
        try { await run('osascript', [path.join(TOOLS, 'office2pdf.applescript'), kind, src, pdf], 250000); }
        catch (e) {
          const app = APP_NAME[kind];
          if (/-1743|not authorized|pas autoris/i.test(e.stderr)) throw new Error(`macOS a bloqué le pilotage de ${app}. Ouvre Réglages Système → Confidentialité et sécurité → Automatisation, et autorise ${app} pour l'application qui a lancé la régie (Terminal).`);
          if (e.killed) throw new Error(`${app} n'a pas répondu à temps : une fenêtre y attend peut-être une réponse. Regarde dans ${app}, puis réessaie.`);
          if (/-600|-10810|n.est pas ouvert|introuvable/i.test(e.stderr)) throw new Error(`${app} est introuvable sur ce Mac. Exporte le fichier en PDF, puis importe le PDF.`);
          throw new Error(`${app} n'a pas pu convertir ce fichier. Exporte-le en PDF depuis ${app}, puis importe le PDF. (${e.stderr.trim().split('\n').pop().slice(0, 160)})`);
        }
        const st = await fsp.stat(pdf).catch(() => null);
        if (!st || !st.size) throw new Error(`${APP_NAME[kind]} n'a produit aucune page. Exporte le fichier en PDF, puis importe le PDF.`);
      }
      if (process.platform === 'darwin') {
        try { await run('osascript', ['-l', 'JavaScript', path.join(TOOLS, 'pdf2img.js'), pdf, path.join(WORK, 'p-'), String(maxSide), '200'], 180000); }
        catch (e) { throw new Error('Ce PDF n\'a pas pu être lu (fichier protégé ou abîmé ?).'); }
      }
      const pages = (await fsp.readdir(WORK)).filter(n => /^p-\d+\.jpg$/.test(n)).sort();
      if (!pages.length) throw new Error('Aucune page trouvée dans ce document.');
      const base = (path.basename(String(rawName).normalize('NFC'), path.extname(rawName)).replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim() || 'Document').slice(0, 60);
      // Le document reste entier : ses pages vont dans data/documents/<nom>/001.jpg, 002.jpg… (pas dans la médiathèque).
      const dir = path.join(DOCD, base);
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(dir, { recursive: true });
      for (const [i, p] of pages.entries()) await fsp.rename(path.join(WORK, p), path.join(dir, String(i + 1).padStart(3, '0') + '.jpg'));
      const meta = { id: base, name: String(rawName), pages: pages.length, at: Date.now() };
      await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
      return meta;
    } finally {
      converting = false;
      if (!keepWork) fsp.rm(WORK, { recursive: true, force: true }).catch(() => {});
      keepWork = false;
    }
  }
  let keepWork = false;                                       // le PDF produit est encore à envoyer à la régie

  /* Pages d'un document rendues par la régie elle-même (pdf.js) : envoyées une par une, puis rangées comme un document converti. */
  const pageTok = t => (/^[a-z0-9]{6,24}$/.test(String(t || '')) ? String(t) : null);
  async function saveDocPage(req, tok, i) {
    const dir = path.join(DATA, 'pages-' + tok);
    await fsp.mkdir(dir, { recursive: true });
    const buf = await readBody(req, 25 * 1024 * 1024);
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw Object.assign(new Error('Page illisible (JPEG attendu).'), { code: 400 });
    await fsp.writeFile(path.join(dir, 'p-' + String(i).padStart(3, '0') + '.jpg'), buf);
  }
  async function finishDocPages(tok, rawName) {
    const tmp = path.join(DATA, 'pages-' + tok);
    const pages = (await fsp.readdir(tmp).catch(() => [])).filter(n => /^p-\d+\.jpg$/.test(n)).sort();
    if (!pages.length) throw Object.assign(new Error('Aucune page reçue.'), { code: 400 });
    const base = (path.basename(String(rawName).normalize('NFC'), path.extname(String(rawName))).replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim() || 'Document').slice(0, 60);
    const dir = path.join(DOCD, base);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    for (const [i, p] of pages.entries()) await fsp.rename(path.join(tmp, p), path.join(dir, String(i + 1).padStart(3, '0') + '.jpg'));
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    const meta = { id: base, name: String(rawName), pages: pages.length, at: Date.now() };
    await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
    return meta;
  }

  /** Pilote le diaporama PowerPoint en direct. Renvoie {pos, total, cropT, cropB} : position + rognage de la fenêtre capturée.
   *  Mac : tools/pptlive.applescript (osascript). Windows : tools/pptlive.ps1 (PowerShell + automation COM). */
  async function pptLive(args) {
    if (process.platform !== 'darwin' && process.platform !== 'win32') throw Object.assign(new Error('PowerPoint en direct n\'est disponible que sur Mac et Windows.'), { code: 400 });
    let out;
    try { out = await (process.platform === 'darwin' ? run('osascript', [path.join(TOOLS, 'pptlive.applescript'), ...args], 110000) : runPs('pptlive.ps1', args, 110000)); }
    catch (e) {
      if (/aucun diaporama/i.test(e.stderr)) throw Object.assign(new Error('Aucun diaporama en cours dans PowerPoint : clique sur « Relancer le diaporama ».'), { code: 409 });
      if (/-1743|not authorized|pas autoris/i.test(e.stderr)) throw new Error('macOS a bloqué le pilotage de PowerPoint. Ouvre Réglages Système → Confidentialité et sécurité → Automatisation, et autorise PowerPoint pour l\'application qui a lancé la régie.');
      if (/80040154|introuvable|Class not registered|-600|-10810/i.test(e.stderr)) throw new Error('PowerPoint est introuvable sur cet ordinateur : installe Microsoft PowerPoint pour jouer un diaporama en direct.');
      if (e.killed) throw new Error('PowerPoint n\'a pas répondu : une fenêtre y attend peut-être une réponse.');
      throw new Error('PowerPoint n\'a pas pu exécuter la commande. (' + e.stderr.trim().split('\n').pop().slice(0, 160) + ')');
    }
    const [pos, total, h, cap] = out.split('/').map(Number);
    if (cap > 0 && h > 0) return { pos: pos || 0, total: total || 0, cropT: cap / h, cropB: 0 };   // Windows : barre de titre mesurée par le script
    // Mac, fenêtre de 768 points : 32 de barre de titre + 8 de marge, la diapositive, puis 16 en bas (marge + coins arrondis).
    const crop = h === 768 ? { cropT: 40 / 768, cropB: 16 / 768 } : { cropT: h > 0 ? 32 / h : 0, cropB: 0 };
    return { pos: pos || 0, total: total || 0, ...crop };
  }
  /** Windows : lance un script PowerShell de tools/ (automation COM d'Office). */
  const runPs = (script, args, timeout) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS, script), ...args], timeout);
  async function uniqueName(name) {
    const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
    let cand = name, i = 2;
    while (fs.existsSync(path.join(MEDIA, cand))) cand = `${base} (${i++})${ext}`;
    return cand;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(url.pathname);

      // Seules les pages servies par ce serveur peuvent écrire (bloque un site web tiers qui viserait localhost).
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return send(res, 403, { error: 'Origine refusée' });
      }

      if (p === '/api/diag') {                                       // dépannage : dernier état envoyé par la régie et par la sortie
        if (req.method === 'GET') return send(res, 200, diag);
        if (req.method === 'POST') {
          const who = url.searchParams.get('who') === 'sortie' ? 'sortie' : 'regie';
          try { diag[who] = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')); } catch { /* état illisible : ignoré */ }
          return send(res, 200, { ok: true });
        }
      }

      if (p === '/api/version' && req.method === 'GET') {            // date du fichier le plus récent : la sortie se recharge si elle est en retard
        let v = 0;
        const files = ['index.html', 'output.html'];
        for (const d of ['js', 'css']) for (const n of await fsp.readdir(path.join(root, d))) files.push(path.join(d, n));
        for (const f of files) v = Math.max(v, (await fsp.stat(path.join(root, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs);
        return send(res, 200, { v: Math.round(v) });
      }

      if (p === '/api/show') {
        if (req.method === 'GET') {
          try { return send(res, 200, await fsp.readFile(SHOW)); } catch { return send(res, 200, 'null'); }
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          const body = await readBody(req);
          const parsed = JSON.parse(body.toString('utf8'));        // refuse un JSON invalide
          try { touchRefs(parsed); } catch { /* l'index ne doit jamais empêcher l'enregistrement */ }
          if (fs.existsSync(SHOW)) await fsp.copyFile(SHOW, SHOW + '.bak').catch(() => {});
          await backupShow();
          const tmp = SHOW + '.tmp';
          await fsp.writeFile(tmp, body);
          await fsp.rename(tmp, SHOW);
          return send(res, 200, { ok: true });
        }
      }

      if (p === '/api/media') {
        if (req.method === 'GET') return send(res, 200, await listMedia());
        if (req.method === 'POST') {
          const name = safeName(url.searchParams.get('name'));
          if (!name) return send(res, 400, { error: 'Type de fichier non pris en charge (vidéo mp4/mov/webm ou image).' });
          const final = await uniqueName(name);
          const tmp = path.join(MEDIA, '.envoi-' + Date.now() + '-' + Math.random().toString(36).slice(2));
          const h = crypto.createHash('sha256'); let size = 0;
          try {
            await fsp.mkdir(MEDIA, { recursive: true });              // dossier supprimé ou déplacé entre-temps : on le recrée
            await new Promise((resolve, reject) => {
              const ws = fs.createWriteStream(tmp);
              req.on('data', c => { h.update(c); size += c.length; });
              req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject);
              req.on('aborted', () => reject(new Error('envoi interrompu')));
            });
            const hash = h.digest('hex'), same = await findSame(size, hash);
            if (same) {                                                // déjà dans le dossier : pas de doublon, on réutilise ce fichier
              await fsp.rm(tmp, { force: true });
              (idx.media[same] ||= {}).lastUsed = Date.now(); saveIdx();
              return send(res, 200, { ok: true, name: same, url: '/media/' + encodeURIComponent(same), dup: true });
            }
            await fsp.rename(tmp, path.join(MEDIA, final));
            const st = await fsp.stat(path.join(MEDIA, final));
            idx.media[final] = { size, mtime: Math.round(st.mtimeMs), hash, lastUsed: Date.now() }; delete idx.alias[final]; saveIdx();
          } catch (e) { req.resume(); await fsp.rm(tmp, { force: true }).catch(() => {}); return send(res, 500, { error: fsMessage(e, MEDIA) }); }
          return send(res, 200, { ok: true, name: final, url: '/media/' + encodeURIComponent(final) });
        }
        if (req.method === 'DELETE') {
          const name = safeName(url.searchParams.get('name'));
          if (!name) return send(res, 400, { error: 'Nom invalide' });
          await fsp.rm(path.join(MEDIA, name), { force: true });
          return send(res, 200, { ok: true });
        }
      }

      if (p === '/api/rename' && req.method === 'POST') {           // renommer un média, un PowerPoint en direct ou un document gardé par la régie
        const kind = url.searchParams.get('kind');
        const to = String(url.searchParams.get('to') || '').normalize('NFC').replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim().slice(0, 80);
        if (!to || to.startsWith('.')) return send(res, 400, { error: 'Nom invalide' });
        if (kind === 'media') {
          const name = safeName(url.searchParams.get('name'));
          if (!name || !fs.existsSync(path.join(MEDIA, name))) return send(res, 404, { error: 'Fichier introuvable' });
          const ext = path.extname(name), final = await uniqueName(to.toLowerCase().endsWith(ext.toLowerCase()) ? to : to + ext);
          await fsp.rename(path.join(MEDIA, name), path.join(MEDIA, final));
          return send(res, 200, { ok: true, name: final, url: '/media/' + encodeURIComponent(final) });
        }
        if (kind === 'ppt') {
          const name = presName(url.searchParams.get('name'));
          if (!name || !fs.existsSync(path.join(PRES, name))) return send(res, 404, { error: 'Fichier introuvable' });
          const ext = path.extname(name), final = to.toLowerCase().endsWith(ext.toLowerCase()) ? to : to + ext;
          if (!presName(final)) return send(res, 400, { error: 'Nom invalide' });
          if (final !== name && fs.existsSync(path.join(PRES, final))) return send(res, 409, { error: 'Un PowerPoint porte déjà ce nom' });
          await fsp.rename(path.join(PRES, name), path.join(PRES, final));
          await fsp.rename(path.join(PRES, '.vignettes', name + '.png'), path.join(PRES, '.vignettes', final + '.png')).catch(() => {});
          return send(res, 200, { ok: true, name: final });
        }
        if (kind === 'doc') {                                        // le dossier (id) ne bouge pas : seul le nom affiché change
          const id = docId(url.searchParams.get('name')), file = id && path.join(DOCD, id, 'meta.json');
          if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'Document introuvable' });
          const meta = JSON.parse(await fsp.readFile(file, 'utf8')); meta.name = to;
          await fsp.writeFile(file, JSON.stringify(meta));
          return send(res, 200, { ok: true, ...meta });
        }
        return send(res, 400, { error: 'Type inconnu' });
      }

      if (p === '/api/import-doc' && req.method === 'POST') {
        const max = Math.max(1280, Math.min(3840, +url.searchParams.get('max') || 1920));
        try {
          keepWork = true;
          const r = await importDoc(req, url.searchParams.get('name'), max);
          if (r.pdfFile) {                                          // la régie fera les images elle-même : on lui renvoie le PDF
            const buf = await fsp.readFile(r.pdfFile);
            fsp.rm(WORK, { recursive: true, force: true }).catch(() => {});
            return send(res, 200, buf, 'application/pdf');
          }
          fsp.rm(WORK, { recursive: true, force: true }).catch(() => {});
          return send(res, 200, { ok: true, ...r });
        } catch (e) { keepWork = false; req.resume(); return send(res, e.code || 500, { error: String(e.message || e) }); }
      }
      if (p === '/api/doc-page' && req.method === 'POST') {            // une page rendue par la régie (pdf.js)
        const tok = pageTok(url.searchParams.get('tok')), i = Math.round(+url.searchParams.get('i'));
        if (!tok || !(i >= 1 && i <= 999)) { req.resume(); return send(res, 400, { error: 'Page invalide' }); }
        try { await saveDocPage(req, tok, i); return send(res, 200, { ok: true }); }
        catch (e) { req.resume(); return send(res, e.code || 500, { error: fsMessage(e, DATA) }); }
      }
      if (p === '/api/doc-done' && req.method === 'POST') {            // toutes les pages sont arrivées : on range le document
        const tok = pageTok(url.searchParams.get('tok'));
        if (!tok) return send(res, 400, { error: 'Document invalide' });
        try { return send(res, 200, { ok: true, ...(await finishDocPages(tok, url.searchParams.get('name') || 'Document')) }); }
        catch (e) { return send(res, e.code || 500, { error: fsMessage(e, DATA) }); }
      }

      if (p === '/api/ppt/open' && req.method === 'POST') {          // envoi du fichier + lancement du diaporama en fenêtre
        const name = presName(url.searchParams.get('name'));
        if (!name) { req.resume(); return send(res, 400, { error: 'Ce n\'est pas un fichier PowerPoint (.pptx, .ppt, .ppsx).' }); }
        await fsp.mkdir(PRES, { recursive: true });
        const file = path.join(PRES, name), tmp = file + '.envoi';
        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(tmp);
          req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject);
          req.on('aborted', () => reject(new Error('envoi interrompu')));
        });
        await fsp.rename(tmp, file);
        try { return send(res, 200, { ok: true, file: name, ...(await pptLive(['open', file])) }); }
        catch (e) { return send(res, e.code || 500, { error: String(e.message || e) }); }
      }
      if (p === '/api/docs') {                                       // documents à pages gardés par la régie
        if (req.method === 'GET') {
          const out = [];
          for (const d of await fsp.readdir(DOCD).catch(() => [])) {
            try { out.push(JSON.parse(await fsp.readFile(path.join(DOCD, d, 'meta.json'), 'utf8'))); } catch { /* dossier incomplet : ignoré */ }
          }
          return send(res, 200, out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr', { numeric: true })));
        }
        if (req.method === 'DELETE') {
          const id = docId(url.searchParams.get('id'));
          if (!id) return send(res, 400, { error: 'Nom invalide' });
          await fsp.rm(path.join(DOCD, id), { recursive: true, force: true });
          return send(res, 200, { ok: true });
        }
      }
      if (p === '/api/storage' && req.method === 'GET') return send(res, 200, await storage());
      if (p === '/api/storage/dedupe' && req.method === 'POST') return send(res, 200, { ok: true, ...(await dedupe()) });
      if (p === '/api/storage/clean' && req.method === 'POST') {
        const days = Math.max(1, Math.min(3650, Math.round(+url.searchParams.get('days') || 0)));
        if (!+url.searchParams.get('days')) return send(res, 400, { error: 'Nombre de jours manquant' });
        return send(res, 200, { ok: true, ...(await cleanUnused(days, url.searchParams.get('dry') === '1')) });
      }
      if (p === '/api/storage/auto' && req.method === 'POST') {
        idx.autoClean = Math.max(0, Math.min(3650, Math.round(+url.searchParams.get('days') || 0))); saveIdx();
        return send(res, 200, { ok: true, autoClean: idx.autoClean });
      }
      if (p === '/api/ppt/list' && req.method === 'GET') {           // PowerPoint « en direct » gardés par la régie (pour la médiathèque)
        const out = [];
        for (const name of await fsp.readdir(PRES).catch(() => [])) {
          if (!presName(name) || name.startsWith('~$')) continue;                // ~$… : fichier verrou créé par PowerPoint
          const st = await fsp.stat(path.join(PRES, name));
          if (st.isFile()) out.push({ name, size: st.size, mtime: st.mtimeMs });
        }
        return send(res, 200, out.sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true })));
      }
      if (p === '/api/ppt/thumb' && req.method === 'GET') {          // vignette de la première diapositive (Coup d'œil de macOS)
        const name = presName(url.searchParams.get('name')), file = name && path.join(PRES, name);
        if (!file || !fs.existsSync(file)) return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
        const dir = path.join(PRES, '.vignettes'), png = path.join(dir, name + '.png');
        const fresh = await Promise.all([fsp.stat(png), fsp.stat(file)]).then(([a, b]) => a.mtimeMs >= b.mtimeMs).catch(() => false);
        if (!fresh) {
          if (process.platform !== 'darwin' && process.platform !== 'win32') return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
          await fsp.mkdir(dir, { recursive: true });
          if (process.platform === 'darwin') await run('qlmanage', ['-t', '-s', '480', '-o', dir, file], 25000).catch(() => {});
          else await runPs('pptexport.ps1', [file, path.join(dir, name + '-'), '480', '1', 'PNG'], 60000).then(() => fsp.rename(path.join(dir, name + '-001.png'), png)).catch(() => {});
        }
        return serveFile(req, res, png, false);
      }
      if (p === '/api/ppt' && req.method === 'DELETE') {
        const name = presName(url.searchParams.get('name'));
        if (!name) return send(res, 400, { error: 'Nom invalide' });
        await fsp.rm(path.join(PRES, name), { force: true });
        await fsp.rm(path.join(PRES, '.vignettes', name + '.png'), { force: true });
        return send(res, 200, { ok: true });
      }
      if (p === '/api/ppt/cmd' && req.method === 'POST') {           // suivant / précédent / début / position / relancer / arrêter
        const act = url.searchParams.get('do');
        try {
          if (act === 'open') {
            const name = presName(url.searchParams.get('file'));
            if (!name || !fs.existsSync(path.join(PRES, name))) return send(res, 404, { error: 'Ce PowerPoint n\'est plus dans la régie : importe-le à nouveau.' });
            return send(res, 200, { ok: true, ...(await pptLive(['open', path.join(PRES, name)])) });
          }
          if (!['next', 'prev', 'first', 'pos', 'stop', 'park'].includes(act)) return send(res, 400, { error: 'Commande inconnue' });
          return send(res, 200, { ok: true, ...(await pptLive([act])) });
        } catch (e) { return send(res, e.code || 500, { error: String(e.message || e) }); }
      }

      if (p === '/api/open-media' && req.method === 'POST') {
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
        execFile(cmd, [MEDIA], () => {});
        return send(res, 200, { ok: true, path: MEDIA });
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Méthode non autorisée' });

      if (p.startsWith('/doc/')) {                                   // une page d'un document : /doc/<nom>/003.jpg
        const [id, page] = p.slice(5).split('/');
        if (!docId(id) || !/^\d{3,4}\.jpg$/.test(page || '')) return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
        return serveFile(req, res, path.join(DOCD, id, page), true);
      }
      if (p.startsWith('/media/')) {
        const name = safeName(p.slice(7));
        if (!name) return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
        const real = !fs.existsSync(path.join(MEDIA, name)) && idx.alias[name] ? idx.alias[name] : name;     // doublon supprimé : le fichier gardé
        return serveFile(req, res, path.join(MEDIA, real), true);
      }

      const rel = p === '/' ? 'index.html' : p.slice(1);
      const ok = STATIC.has(rel) || /^(js|css)\/[\w.-]+\.(js|css)$/.test(rel);
      if (!ok) return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
      return serveFile(req, res, path.join(root, rel), false);
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: String(e.message || e) }); else res.destroy();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4400, opts.host || '127.0.0.1', () => {
      const port = server.address().port, url = 'http://localhost:' + port;
      resolve({ server, port, url, root, dataDir: DATA, mediaDir: MEDIA, close: () => new Promise(r => server.close(r)) });
    });
  });
}

// Lancé directement (`node serve.js [port]`) : on écoute sur le port demandé et on l'affiche.
const launchedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (launchedDirectly) {
  startServer({ port: +(process.env.PORT || process.argv[2] || 4400) })
    .then(s => console.log('Régie LED : ' + s.url))
    .catch(e => { console.error('Impossible de démarrer le serveur : ' + e.message); process.exit(1); });
}
