// A fast drop-in for makefun-site 1.0.0: run(input) returns the same output tree (path -> text) as the
// reference build, byte for byte, computed with tighter loops. Self-contained ES module, no imports, no
// fs/clock/randomness; every cache lives inside one run() call and is discarded with it.

const REPORT_FILE = 'build-report.txt';
const SLUG_MAX = 64;
const INCLUDE_DEPTH = 8;
const RESERVED = ['posts', 'tags', 'page'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------- text primitives

/** Code-unit order comparison. */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const ESC_RE = /[&<>"']/g;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped; returns the input untouched when it holds none of them. */
function esc(text) {
  ESC_RE.lastIndex = 0;
  let m = ESC_RE.exec(text);
  if (m === null) return text;
  let out = '';
  let start = 0;
  while (m !== null) {
    out += text.slice(start, m.index) + ESCAPES[m[0]];
    start = m.index + 1;
    m = ESC_RE.exec(text);
  }
  return out + text.slice(start);
}

/** The slug of `text` (NFKD, marks dropped, A-Z lowered, other runs one "-", cut at 64), memoized in `cache`. */
function slugify(text, cache) {
  let hit = cache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  const parts = [];
  let gap = false;
  for (const ch of plain) {
    const cc = ch.codePointAt(0);
    let keep = null;
    if (cc >= 65 && cc <= 90) keep = ch.toLowerCase();
    else if ((cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57)) keep = ch;
    if (keep === null) {
      gap = parts.length > 0;
      continue;
    }
    if (gap) parts.push('-');
    gap = false;
    parts.push(keep);
  }
  let out = parts.join('').slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  out = out.slice(0, end);
  hit = out === '' ? 'untitled' : out;
  cache.set(text, hit);
  return hit;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether code unit `cc` is one of JavaScript's \s characters. */
function isSpace(cc) {
  if (cc < 160) return cc === 32 || (cc >= 9 && cc <= 13);
  return cc === 160 || cc === 5760 || (cc >= 8192 && cc <= 8202)
    || cc === 8232 || cc === 8233 || cc === 8239 || cc === 8287 || cc === 12288 || cc === 65279;
}

/** The number of words in `text`: its runs of non-whitespace, counted without allocating them. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isSpace(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** `s` with spaces and tabs dropped at both ends. */
function trimST(s) {
  let a = 0;
  let b = s.length;
  while (a < b) {
    const c = s.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = s.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/** Whether `s` holds a U+2028/U+2029 line terminator (which a regex "." cannot cross). */
const hasLineTerminator = (s) => s.includes('\u2028') || s.includes('\u2029');

const dirOf = (path) => {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
};

/** `rel` ("/"-separated) resolved from directory `dir`, or null when it climbs above the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const next = raw[i + 1];
        if ((next !== '"' && next !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += next;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= SLUG_MAX ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body by offset scanning: the opening "---" line, the next exact "---" line,
 * and the body sliced once after it. Returns { data, body } or { error } with the first refusal reason.
 */
function parseFrontMatter(text) {
  if (text.length < 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45
    || (text.length > 3 && text.charCodeAt(3) !== 10)) return { error: 'no front matter' };
  const data = {};
  let pos = 3; // index of the newline ending the line just read (or text.length)
  let lineNo = 1;
  for (;;) {
    if (pos >= text.length) return { error: 'the front matter is not closed' };
    const nl = text.indexOf('\n', pos + 1);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos + 1, lineEnd);
    lineNo++;
    if (line === '---') {
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body: text.slice(nl === -1 ? text.length : nl + 1) };
    }
    // blank (spaces/tabs only) or comment lines are skipped
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      // "key: value" — key of [a-z_]+, a colon, then end of line or one space and the value
      const ci = line.indexOf(':');
      let key = null;
      let value;
      if (ci > 0) {
        let keyOk = true;
        for (let i = 0; i < ci; i++) {
          const c = line.charCodeAt(i);
          if (!((c >= 97 && c <= 122) || c === 95)) { keyOk = false; break; }
        }
        if (keyOk) {
          if (ci === line.length - 1) { key = line.slice(0, ci); value = undefined; }
          else if (line.charCodeAt(ci + 1) === 32) { key = line.slice(0, ci); value = line.slice(ci + 2); }
        }
      }
      if (key === null || (value !== undefined && hasLineTerminator(value))) return { error: `line ${lineNo} is not "key: value"` };
      // trailing spaces/tabs dropped from the value
      let raw = value ?? '';
      let e = raw.length;
      while (e > 0) {
        const c = raw.charCodeAt(e - 1);
        if (c !== 32 && c !== 9) break;
        e--;
      }
      raw = raw.slice(0, e);
      if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = nl === -1 ? text.length : nl;
  }
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** The language of a fence-opening line ("" for none), or null when the line opens no fence. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const n = line.length;
  while (i < n && isLangChar(line.charCodeAt(i))) i++;
  const lang = line.slice(3, i);
  for (; i < n; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text (trailing spaces/tabs dropped), or null. */
function headingOf(line) {
  let i = 0;
  const n = line.length;
  while (i < n && line.charCodeAt(i) === 35) i++;
  if (i === 0 || i > 6 || i >= n) return null;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  const text = trimST(line.slice(i));
  if (text === '' || hasLineTerminator(line)) return null;
  return { depth: i, text };
}

function isHr(line) {
  const c = line.charCodeAt(0);
  if (line.length < 3 || line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const cc = line.charCodeAt(i);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** A bullet item's text (after "- " or "* "), or null. */
function bulletItem(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) {
    const text = line.slice(2);
    return hasLineTerminator(text) ? null : text;
  }
  return null;
}

/** An ordered item's number and text (after "12. "), or null. */
function orderedItem(line) {
  let i = 0;
  const n = line.length;
  while (i < n && i < 9) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0 || line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  const text = line.slice(i + 2);
  if (hasLineTerminator(text)) return null;
  return { num: Number(line.slice(0, i)), text };
}

/** Whether a line continues a list item: two or more spaces, then a non-whitespace character. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i < line.length && !isSpace(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (isBlankLine(line)) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const cand = s.indexOf(what, from);
  if (cand === -1) return -1;
  const bs = s.indexOf('\\', from);
  if (bs === -1 || bs > cand) return cand;
  const limit = s.length - what.length;
  for (let j = from; j <= limit; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  if (s.indexOf('\\', from) === -1) {
    let j = s.indexOf('*', from);
    while (j !== -1) {
      if (s[j + 1] !== '*') return j;
      j = s.indexOf('*', j + 2);
    }
    return -1;
  }
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `target` holds any whitespace (the link rule). */
function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) if (isSpace(s.charCodeAt(i))) return true;
  return false;
}

/** `s` rendered inline; a regex jumps between special characters, plain runs are escaped in bulk. */
function inline(s, env, cache) {
  const parts = [];
  const n = s.length;
  let plainStart = 0;
  const re = /[\\`*[]/g; // fresh per call: inline recurses
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = m.index;
    const c = m[0];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        if (i > plainStart) parts.push(esc(s.slice(plainStart, i)));
        parts.push(esc(s[i + 1]));
        plainStart = i + 2;
        re.lastIndex = plainStart;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > plainStart) parts.push(esc(s.slice(plainStart, i)));
        parts.push(`<code>${esc(s.slice(i + 1, j))}</code>`);
        plainStart = j + 1;
        re.lastIndex = plainStart;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > plainStart) parts.push(esc(s.slice(plainStart, i)));
          parts.push(`<strong>${inline(s.slice(i + 2, j), env, cache)}</strong>`);
          plainStart = j + 2;
          re.lastIndex = plainStart;
        } else re.lastIndex = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > plainStart) parts.push(esc(s.slice(plainStart, i)));
        parts.push(`<em>${inline(s.slice(i + 1, j), env, cache)}</em>`);
        plainStart = j + 1;
        re.lastIndex = plainStart;
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', i + 1);
    const close = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = close === -1 ? '' : s.slice(k + 2, close);
    if (target !== '' && !hasWhitespace(target)) {
      if (i > plainStart) parts.push(esc(s.slice(plainStart, i)));
      parts.push(`<a href="${esc(env.link(target))}">${inline(s.slice(i + 1, k), env, cache)}</a>`);
      plainStart = close + 1;
      re.lastIndex = plainStart;
    }
  }
  if (plainStart < n) parts.push(esc(s.slice(plainStart)));
  return parts.join('');
}

/**
 * `src` rendered in one pass: its HTML (each block followed by "\n"), its toc (level 2/3 headings) and its
 * excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, cache) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        const inner = [];
        while (i < n && !isFenceClose(lines[i])) inner.push(`${esc(lines[i++])}\n`);
        i++;
        const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
        blocks.push(`<pre><code${cls}>${inner.join('')}</code></pre>`, '\n');
        continue;
      }
    }
    if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text, cache), ids);
        const html = inline(h.text, env, cache);
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`, '\n');
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && isHr(line)) {
      blocks.push('<hr>', '\n');
      i++;
      continue;
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimST(l);
        if (l !== '') body.push(l);
        i++;
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(body.join('\n'), env, cache)}</p>\n</blockquote>`, '\n');
      continue;
    }
    const bullet = bulletItem(line);
    const ordered = bullet === null ? orderedItem(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [[trimST(isOrdered ? ordered.text : bullet)]];
      i++;
      while (i < n) {
        const l = lines[i];
        const m = isOrdered ? orderedItem(l) : bulletItem(l);
        if (m !== null) {
          items.push([trimST(isOrdered ? m.text : m)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimST(l));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.num !== 1 ? `<ol start="${ordered.num}">` : `<${tag}>`;
      let out = `${open}\n`;
      for (const parts of items) out += `<li>${inline(parts.join('\n'), env, cache)}</li>\n`;
      blocks.push(`${out}</${tag}>`, '\n');
      continue;
    }
    const body = [trimST(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimST(lines[i++]));
    const html = inline(body.join('\n'), env, cache);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`, '\n');
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why, as the report line. */
class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlankLine(src.slice(lineStart, open)) && isBlankLine(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  const first = path[0];
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true/false, an array joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    const parts = new Array(v.length);
    for (let i = 0; i < v.length; i++) parts[i] = textOf(v[i]);
    return parts.join(', ');
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` (an array of chunks) in `scope`; includes nest at most INCLUDE_DEPTH deep. */
function renderNodes(nodes, scope, templates, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(esc(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, templates, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = {};
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
          renderNodes(n.body, { vars, parent: scope }, templates, depth, out);
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, templates, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text, exactly as makefun-site 1.0.0's build returns it. */
export function run(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};
  const broken = new Set();
  const bySource = new Map();

  // 1. Sources in code-unit order; .md files are sources (line ends made "\n"), the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter and the refusal checks, in order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved against the built pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const pathCache = new Map();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        let path = null;
        if (rel !== '') {
          const key = `${dir}\0${rel}`;
          path = pathCache.get(key);
          if (path === undefined) {
            path = resolvePath(dir, rel);
            pathCache.set(key, path);
          }
        }
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first (ties by slug), with newer/older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug and named as first met in collection order.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugify(name, slugCache);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and page records, as templates read them.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const s of sources) cards.set(s, cardOf(s));
  const pageOf = (s) => ({
    ...cards.get(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Layouts: every page, the index pages, the tag pages; then the static files.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, 0, out);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
