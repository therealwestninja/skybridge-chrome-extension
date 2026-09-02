// ingest.js — turn a pasted DOCUMENT (a persona backstory, a world/lore doc, a character card, an article, even raw
// HTML) into semantic memory. Split → strip boilerplate → chunk (overlapping, structure-aware) → embed (batched when
// the embedder supports it) → store as facts, deduped by content so a re-import skips re-embedding. Mined from
// epic-dm's shipped book-ingest (`core.mjs`); the browser-only .epub/zip reader is deliberately left there — this is
// the general text pipeline. Chunks become `type:"fact"` records, so recall does RAG over the document and the theme
// layer builds themes across it — no new retrieval path.

// FNV-1a + length suffix — a cheap content fingerprint so the same passage isn't ingested (and re-embedded) twice.
export function hashText(text) {
  const s = String(text).replace(/\s+/g, " ").trim();
  let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0") + "-" + s.length.toString(36);
}

// Drop chunks whose text already appears in `seen` (a Set). Returns { chunks, skipped }.
export function dedupeChunks(chunks, seen = new Set()) {
  const out = []; let skipped = 0;
  for (const c of chunks) { if (seen.has(c.text)) { skipped++; continue; } seen.add(c.text); out.push(c); }
  return { chunks: out, skipped };
}

// Split any paste (blank-line / single-newline / blob) into atomic units, then long units into sentence-packed pieces.
export function splitUnits(text) {
  const t = String(text).replace(/\r\n?/g, "\n").trim();
  const hasBlank = /\n[ \t]*\n/.test(t);
  const sentenceSplit = (s) => s.match(/[^.!?…]+[.!?…]+["'”’)\]]*\s*|\S[\s\S]*?$/g) || [s];
  const out = [];
  for (const block of t.split(hasBlank ? /\n{2,}/ : /\n+/)) {
    const b = block.trim(); if (!b) continue;
    if (b.length <= 1200) { out.push(b); continue; }
    for (const line of (hasBlank ? b.split(/\n+/) : [b])) {
      const ln = line.trim(); if (!ln) continue;
      if (ln.length <= 1200) { out.push(ln); continue; }
      let cur = "";
      for (const s of sentenceSplit(ln)) { if (cur && (cur + s).length > 1000) { out.push(cur.trim()); cur = ""; } cur += s; }
      if (cur.trim()) out.push(cur.trim());
    }
  }
  return out;
}

const MONTH_DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i;
export function isHeading(p) {
  if (p.length > 70 || p.length < 2) return false;
  const bare = p.replace(/^[>#*\s]+/, "");
  if (!/^["'“‘]/.test(bare) && !/\?/.test(p) && /^(chapter|part|book|prologue|epilogue|act|scene|interlude|canto)(\s|:|\.|$)/i.test(bare)) return true;
  const words = p.split(/\s+/).filter(Boolean);
  const endsExclaim = /[!?]["'”’)\]]*$/.test(p);
  if (p === p.toUpperCase() && /^[-*=~#\s]*[A-Z0-9]/.test(p) && words.length >= 3 && !endsExclaim && !/(.)\1\1/.test(p)) return true;
  const endsSentence = /[.!?…]["'”’)\]]*$/.test(p);
  if (!endsSentence && p.length <= 55 && (/\b(1[6-9]\d\d|2\d\d\d|3\d\d\d)\b/.test(p) || MONTH_DATE.test(p))) return true;
  return false;
}
export const isBreak = (p) => /^([*#~=–—•\s-]{3,}|\* \* \*|\.\.\.)$/.test(p);

export function stripBoilerplate(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  let start = 0; while (start < lines.length && (/^\s*>/.test(lines[start]) || !lines[start].trim())) start++;
  if (start < 3) start = 0;
  const BOILER = /^\s*(copyright\b|©|\(c\)\s|all rights reserved\b|isbn[\s:]|published by\b|this is a work of fiction)/i;
  return lines.slice(start).filter((l) => !BOILER.test(l)).join("\n").trim() || String(text).trim();
}

// Pack units into ~targetChars chunks, breaking at headings/scene-breaks and carrying `overlap` units of context across.
export function chunkStory(text, { targetChars = 900, overlap = 1 } = {}) {
  const units = splitUnits(text);
  const chunks = []; let chapter = "Opening", buf = [], bufLen = 0, ord = 0;
  const flush = () => { if (!buf.length) return; chunks.push({ id: ord++, chapter, text: buf.join("\n\n") }); const keep = buf.slice(Math.max(0, buf.length - overlap)); buf = keep.slice(); bufLen = keep.reduce((n, p) => n + p.length, 0); };
  for (const p of units) {
    if (isHeading(p)) { flush(); buf = []; bufLen = 0; chapter = p.replace(/^[#>\s]+/, "").slice(0, 60); continue; }
    if (isBreak(p)) { flush(); buf = []; bufLen = 0; continue; }
    const pieces = p.length > targetChars * 2 ? p.match(new RegExp("[\\s\\S]{1," + targetChars + "}", "g")) : [p];
    for (const piece of pieces) { buf.push(piece); bufLen += piece.length + 2; if (bufLen >= targetChars) flush(); }
  }
  flush();
  return chunks.filter((c, i) => !(i > 0 && c.text === chunks[i - 1].text));
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©" };
export const decodeEntities = (s) => String(s).replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ""; } })
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
  .replace(/&(\w+);/g, (m, e) => (ENT[e] != null ? ENT[e] : m));
export function htmlToText(raw) {
  return decodeEntities(String(raw)
    .replace(/<\?xml[\s\S]*?\?>/g, "").replace(/<head[\s\S]*?<\/head>/gi, "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, "\n\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Character card (AiCC / SillyTavern JSON) → a persona/backstory string, with a {{macro}}/[[injection]] guard.
export function parseCharacterCard(text) {
  let data; try { data = JSON.parse(text); } catch { return null; }
  const d = (data && data.data) || data || {};
  const bits = [d.name && ("This companion is " + d.name + "."), d.description, d.personality, d.instruction || d.roleInstruction, d.system_prompt, d.scenario].filter((x) => typeof x === "string" && x.trim());
  const v = bits.join(" ").replace(/\{\{[^}]*\}\}/g, "").replace(/\[\[[^\]]*\]\]/g, "").replace(/\s+/g, " ").trim();
  return v.slice(0, 1500) || null;
}

// Detect + normalize a document to plain text, then chunk it. `card`/`html` force a mode; otherwise auto-detect.
export function chunkDocument(text, { targetChars, overlap, html, card } = {}) {
  let t = String(text || "");
  if (card || /^\s*[{[]/.test(t)) { const c = parseCharacterCard(t); if (c) return [{ id: 0, chapter: "Card", text: c }]; if (card) return []; }
  if (html || /<(p|div|body|br|h[1-6]|span)\b/i.test(t)) t = htmlToText(t);
  t = stripBoilerplate(t);
  return chunkStory(t, { targetChars, overlap });
}

// Ingest a document into a declarativeStore as `type:"fact"` chunks. Dedups against what's already stored (re-import is
// cheap + idempotent). Batches through the embedder when it exposes embedBatch (the MiniLM fast path), else lets the
// store embed each chunk. Returns { added, skipped, chunks }. Rebuild themes afterward (app.ingest does this).
export async function ingestInto(store, text, { embedder = null, tags = [], source = "document", targetChars, overlap, html, card } = {}) {
  const chunks = chunkDocument(text, { targetChars, overlap, html, card });
  if (!chunks.length) return { added: 0, skipped: 0, chunks: 0 };
  const seen = new Set((store.list ? store.list({ type: "fact" }) : []).map((f) => f.text));
  const { chunks: fresh, skipped } = dedupeChunks(chunks, seen);
  if (!fresh.length) return { added: 0, skipped, chunks: chunks.length };
  const meta = { tags: [...tags, "ingested"], source }; // source "document" (not "model") → full recall weight
  if (embedder && embedder.embedBatch && store.add) {
    const vecs = await embedder.embedBatch(fresh.map((c) => c.text));
    for (let i = 0; i < fresh.length; i++) await store.add({ type: "fact", text: fresh[i].text, vector: vecs[i], ...meta });
  } else {
    for (const c of fresh) await store.addFact(c.text, meta);
  }
  return { added: fresh.length, skipped, chunks: chunks.length };
}
