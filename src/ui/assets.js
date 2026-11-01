// assets.js - the one place that turns an art id into an <img>.
//
// Every image in the UI is asked for by manifest id (assets/manifest.json): `img('hero-wide')`,
// `cardImg('gold-7')`. Missing art never leaves a broken image: an unknown id, a failed manifest
// load or a 404 on the file all end in a small text chip carrying the id's label. The page is
// built to look finished with the chips and to improve by itself when the art is there.

const BASE = 'assets/';

const COLOURS = ['red', 'gold', 'green', 'blue', 'purple'];

// Built-in id -> file table, used until (and if) assets/manifest.json loads. It mirrors the
// manifest, so the page works even if the manifest fetch fails (offline, file://, 404).
const BUILT_IN = {
  'hero-wide': 'hero-wide.webp',
  'key-art-main': 'key-art-main.webp',
  'card-back': 'card-back.webp',
  'score-pile': 'score-pile.webp',
  'table-texture': 'table-texture.webp',
  favicon: 'favicon.png',
};
for (const c of COLOURS) {
  BUILT_IN[`glyph-${c}`] = `glyph-${c}.webp`;
  BUILT_IN[`avatar-${c}`] = `avatar-${c}.webp`;
  for (let n = 1; n <= 11; n++) BUILT_IN[`card-${c}-${n}`] = `cards/card-${c}-${n}.webp`;
}

const table = new Map(Object.entries(BUILT_IN).map(([id, file]) => [id, { file, w: 0, h: 0 }]));

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Reads assets/manifest.json ({ assets: [...] } or a bare array). Never throws; on any failure the built-in table stays. */
export async function loadManifest(timeoutMs = 2500) {
  try {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    const res = await fetch(`${BASE}manifest.json`, ctl ? { signal: ctl.signal } : undefined);
    if (timer) clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data && data.assets);
    if (!Array.isArray(list)) return false;
    for (const a of list) {
      if (a && typeof a.id === 'string' && typeof a.file === 'string' && a.status !== 'missing') {
        table.set(a.id, { file: a.file, w: a.width || 0, h: a.height || 0 });
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Replaces the table from an already parsed manifest (tests). */
export function useManifest(data) {
  const list = Array.isArray(data) ? data : data.assets;
  table.clear();
  for (const a of list) table.set(a.id, { file: a.file, w: a.width || 0, h: a.height || 0 });
}

/** URL for an art id, or null if the id is unknown. */
export function assetUrl(id) {
  const a = table.get(id);
  return a ? BASE + a.file : null;
}

/** Every id the built-in table knows (tests compare it with the manifest). */
export function builtInIds() {
  return Object.keys(BUILT_IN);
}

/** A text chip standing in for art. */
export function chip(label, cls = '') {
  return `<span class="asset-chip ${esc(cls)}" role="img" aria-label="${esc(label)}">${esc(label)}</span>`;
}

/**
 * An <img> for an art id, as an HTML string. Options: alt, cls, label (chip text if the art
 * is missing; defaults to alt or the id), w / h (intrinsic size attributes, stops layout jumps).
 */
export function img(id, { alt = '', cls = '', label = '', w = 0, h = 0 } = {}) {
  const url = assetUrl(id);
  const text = label || alt || id;
  if (!url) return chip(text, cls);
  const size = w && h ? ` width="${w}" height="${h}"` : '';
  return `<img class="${esc(cls)}" src="${url}" alt="${esc(alt)}" data-asset="${esc(id)}" data-label="${esc(text)}"${size} decoding="async" draggable="false">`;
}

/** A card face as an <img> (aspect ratio is fixed by CSS). */
export function cardImg(card, { cls = '', alt = '' } = {}) {
  return img(`card-${card}`, { cls: `cardimg ${cls}`.trim(), alt, label: card.replace('-', ' '), w: 280, h: 388 });
}

export function cardBackImg(cls = '') {
  return img('card-back', { cls: `cardimg ${cls}`.trim(), alt: '', label: 'Card back', w: 280, h: 388 });
}

export function glyphImg(colour, cls = '') {
  return img(`glyph-${colour}`, { cls: `glyph ${cls}`.trim(), alt: '', label: colour, w: 160, h: 160 });
}

/** Seat avatar: one Daruma doll per seat, in seat order. */
export function avatarId(seat) {
  return `avatar-${COLOURS[seat % COLOURS.length]}`;
}

/**
 * Once per page: turns any <img data-asset> that fails to load into its text chip.
 * `error` does not bubble, so the listener is a capture listener on the document.
 */
export function installImageFallback(doc = document) {
  doc.addEventListener('error', (e) => {
    const el = e.target;
    if (!el || el.tagName !== 'IMG' || !el.dataset || !el.dataset.asset) return;
    const span = doc.createElement('span');
    span.className = `asset-chip ${el.className || ''}`.trim();
    span.setAttribute('role', 'img');
    span.setAttribute('aria-label', el.dataset.label || el.dataset.asset);
    span.textContent = el.dataset.label || el.dataset.asset;
    el.replaceWith(span);
  }, true);
}
