// Importing index.html (and re-exporting it) makes esbuild emit the page next to
// the bundle and keeps the import from being tree-shaken away.
import index from './index.html';
export function getFilePaths() {
  return { index };
}

import { encode as blurhashEncode, decode as blurhashDecode } from 'blurhash';
import { rgbaToThumbHash, thumbHashToRGBA } from 'thumbhash';

// A real consumer would `import ... from '@graysonlang/finehash'`; the demo
// imports the local source directly so it always tracks src/.
import * as finehash from '../src/finehash.js';

import { createSampleSuite } from './samples.mjs';

const WEBP_SUPPORTED = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  return c.toDataURL('image/webp', 0).startsWith('data:image/webp');
})();

const COLUMNS = ['Original', 'FineHash', 'ThumbHash', 'BlurHash', ...(WEBP_SUPPORTED ? ['Teeny WebP'] : [])];
// Longest preview side, px - read from the page's --cell so it lives in one place.
const CELL = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell')) || 140;
const WORK_MAX = 100; // working-grid longest side for hashing
const HERO_MAX = 240;
const FULL_MAX = 1024; // cap the full-res read so a huge dropped image can't stall the tab

// The comparison renders in sRGB on purpose: ThumbHash and BlurHash do no color
// management and are tuned for sRGB, so any wider gamut would misrepresent them.
const COLOR_SPACE = 'srgb';

function ctx2d(canvas, opts = {}) {
  return canvas.getContext('2d', { colorSpace: COLOR_SPACE, ...opts });
}

function imageData(data, w, h) {
  return new ImageData(data, w, h, { colorSpace: COLOR_SPACE });
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    node.append(child?.nodeType ? child : document.createTextNode(child ?? ''));
  }
  return node;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

function readFull(img) {
  const cap = Math.min(1, FULL_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const fw = Math.max(1, Math.round(img.naturalWidth * cap));
  const fh = Math.max(1, Math.round(img.naturalHeight * cap));
  const canvas = el('canvas', { width: fw, height: fh });
  const ctx = ctx2d(canvas, { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, fw, fh);
  return { data: ctx.getImageData(0, 0, fw, fh).data, width: fw, height: fh };
}

// Downsample with FineHash's gamma-correct (linear-light) resampler, NOT the
// browser canvas, which averages in gamma space and darkens gradients.
function downsampleGrid(full, maxSide) {
  return finehash.downsampleToWorkingGrid(full.data, full.width, full.height, maxSide);
}

function toWorkingData(img, maxSide) {
  return downsampleGrid(readFull(img), maxSide);
}

function previewDims(w, h) {
  const scale = CELL / Math.max(w, h);
  return { dw: Math.max(1, Math.round(w * scale)), dh: Math.max(1, Math.round(h * scale)) };
}

function heroDims(w, h) {
  const scale = Math.min(1, HERO_MAX / Math.max(w, h));
  return { dw: Math.max(1, Math.round(w * scale)), dh: Math.max(1, Math.round(h * scale)) };
}

function toHexGrid(bytes, perRow = 7) {
  const hex = [...bytes].map(b => b.toString(16).toUpperCase().padStart(2, '0'));
  const rows = [];
  for (let i = 0; i < hex.length; i += perRow) {
    rows.push(hex.slice(i, i + perRow).join(' '));
  }
  return rows.join('\n');
}

function paintRgbaInto(canvas, rgba, w, h) {
  const src = el('canvas', { width: w, height: h });
  ctx2d(src).putImageData(imageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  const ctx = ctx2d(canvas);
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
}

function rgbaCanvas(rgba, w, h, dw, dh) {
  const out = el('canvas', { width: dw, height: dh });
  paintRgbaInto(out, rgba, w, h);
  return out;
}

function cell(node, meta, { pending = false, hash = null, bytes = null, originalBytes = null } = {}) {
  const classes = pending ? 'cell pending' : 'cell';
  const children = [node, el('div', { className: 'meta', innerHTML: meta })];
  if (bytes != null && originalBytes) children.push(perfBar(bytes, originalBytes));
  if (hash) {
    children.push(el('div', {
      className: 'hash',
      title: 'click to copy',
      textContent: hash,
      onclick: () => navigator.clipboard?.writeText(hash),
    }));
  }
  return el('td', {}, el('div', { className: classes }, children));
}

function formatBytes(n) {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}

// The label is the true percentage; the bar width is sqrt-scaled so the sub-1%
// placeholders stay visible next to the full-width original baseline.
function perfBar(bytes, originalBytes) {
  const ratio = originalBytes > 0 ? bytes / originalBytes : 0;
  const safe = Number.isFinite(ratio) ? ratio : 0;
  const pct = safe * 100;
  const fill = el('div', { className: 'perf-fill' });
  fill.style.width = `${Math.min(100, Math.sqrt(safe) * 100)}%`;
  const label = pct >= 100 ? '100%' : `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}% of original`;
  return el('div', { className: 'perf', title: `${formatBytes(bytes)} of ${formatBytes(originalBytes)}` }, [
    el('div', { className: 'perf-track' }, fill),
    el('div', { className: 'perf-label', textContent: label }),
  ]);
}

async function sourceBytes(src) {
  try {
    return (await (await fetch(src)).blob()).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Per-algorithm columns. Each returns a <td>.

// Mark a placeholder canvas as a shift-hover peek target, snapshotting its pixels
// so they restore after the peek. (The Original column itself is not a target.)
function peekable(canvas) {
  canvas.classList.add('peek');
  canvas._snapshot = ctx2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
  return canvas;
}

function originalCell(img, full, dw, dh, originalBytes) {
  let canvas;
  if (img.naturalWidth >= dw) {
    const grid = downsampleGrid(full, Math.max(dw, dh));
    canvas = el('canvas', { width: grid.width, height: grid.height });
    ctx2d(canvas).putImageData(imageData(grid.data, grid.width, grid.height), 0, 0);
  } else {
    canvas = el('canvas', { width: dw, height: dh });
    const ctx = ctx2d(canvas);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, dw, dh);
  }
  const meta = `<b>${img.naturalWidth}&times;${img.naturalHeight}</b> &middot; ${formatBytes(originalBytes)}`;
  return cell(canvas, meta, { bytes: originalBytes, originalBytes });
}

function blurhashCell(work, dw, dh, originalBytes) {
  const { data, width, height } = work;
  const ratio = width / height;
  const cx = Math.max(1, Math.min(9, Math.round(4 * Math.min(1, ratio))));
  const cy = Math.max(1, Math.min(9, Math.round(4 * Math.min(1, 1 / ratio))));
  const hash = blurhashEncode(data, width, height, cx, cy);
  const pixels = blurhashDecode(hash, dw, dh);
  return cell(peekable(rgbaCanvas(pixels, dw, dh, dw, dh)), `<b>${hash.length}</b> chars &middot; ${cx}&times;${cy}`, { hash, bytes: hash.length, originalBytes });
}

function thumbhashCell(work, dw, dh, originalBytes) {
  const { data, width, height } = work;
  const hash = rgbaToThumbHash(width, height, data);
  const { w, h, rgba } = thumbHashToRGBA(hash);
  const base64 = btoa(String.fromCharCode(...hash));
  return cell(peekable(rgbaCanvas(rgba, w, h, dw, dh)), `<b>${hash.length}</b> B &middot; ${base64.length} chars`, { hash: base64, bytes: hash.length, originalBytes });
}

// Teeny WebP baseline, a la the ThumbHash demo, but alpha-aware so it's a fair
// competitor to the alpha-carrying codecs rather than a white-flattened straw man.
// A 16x16, 0%-quality WebP whose "hash" is the chunk data needed to reconstruct:
// the VP8 (color) chunk, plus the ALPH (alpha) chunk when the source is
// transparent. RIFF/VP8X framing is regenerable, so - matching the demo's
// VP8-chunk convention - it isn't counted.
function teenyEncode(img) {
  const canvas = el('canvas', { width: 16, height: 16 });
  ctx2d(canvas).drawImage(img, 0, 0, 16, 16); // no white flatten - keep transparency
  const prefix = 'data:image/webp;base64,';
  const url = canvas.toDataURL('image/webp', 0);
  if (!url.startsWith(prefix)) return null;
  const bytes = Uint8Array.from(atob(url.slice(prefix.length)), x => x.charCodeAt(0));
  let rgb = null;
  let alpha = null;
  for (let o = 12; o + 8 <= bytes.length;) {
    const tag = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    const len = (bytes[o + 4] | (bytes[o + 5] << 8) | (bytes[o + 6] << 16) | (bytes[o + 7] << 24)) >>> 0;
    if (tag === 'VP8 ') rgb = bytes.subarray(o + 8, o + 8 + len);
    else if (tag === 'ALPH') alpha = bytes.subarray(o + 8, o + 8 + len);
    o += 8 + len + (len & 1); // chunk payloads are padded to even length
  }
  return rgb ? { url, rgb, alpha } : null;
}

// Decode the WebP to 16x16 and apply the demo's 2-pass box blur - but in
// PREMULTIPLIED space and over all four channels, so transparent edges blur
// cleanly (straight-alpha blurring fringes dark/colored halos around cutouts).
async function teenyBlur(url) {
  const img = await loadImage(url);
  const canvas = el('canvas', { width: 16, height: 16 });
  const c = ctx2d(canvas);
  c.drawImage(img, 0, 0, 16, 16);
  const pixels = c.getImageData(0, 0, 16, 16);
  const data = pixels.data;

  const buf = new Float64Array(16 * 16 * 4); // premultiplied RGBA
  for (let i = 0; i < buf.length; i += 4) {
    const f = data[i + 3] / 255;
    buf[i] = data[i] * f;
    buf[i + 1] = data[i + 1] * f;
    buf[i + 2] = data[i + 2] * f;
    buf[i + 3] = data[i + 3];
  }

  const temp = new Float64Array(16 * 16 * 4);
  for (let pass = 0; pass < 2; pass++) {
    const radius = pass ? 1 : 2;
    const d = 2 * radius;
    const acc = [0, 0, 0, 0];
    let total = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16 + d; x++) {
        if (x < 16) {
          const i = (x + y * 16) << 2;
          for (let k = 0; k < 4; k++) acc[k] += buf[i + k];
          total++;
        }
        if (x >= radius && x < radius + 16) {
          const i = ((x - radius) * 16 + y) << 2;
          for (let k = 0; k < 4; k++) temp[i + k] = acc[k] / total;
        }
        if (x >= d) {
          const i = ((x - d) + y * 16) << 2;
          for (let k = 0; k < 4; k++) acc[k] -= buf[i + k];
          total--;
        }
      }
    }
    acc.fill(0);
    total = 0;
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 16 + d; y++) {
        if (y < 16) {
          const i = (x * 16 + y) << 2;
          for (let k = 0; k < 4; k++) acc[k] += temp[i + k];
          total++;
        }
        if (y >= radius && y < radius + 16) {
          const i = (x + (y - radius) * 16) << 2;
          for (let k = 0; k < 4; k++) buf[i + k] = acc[k] / total;
        }
        if (y >= d) {
          const i = (x * 16 + (y - d)) << 2;
          for (let k = 0; k < 4; k++) acc[k] -= temp[i + k];
          total--;
        }
      }
    }
  }

  for (let i = 0; i < buf.length; i += 4) {
    const a = buf[i + 3];
    const f = a > 0 ? 255 / a : 0; // un-premultiply back to straight alpha
    data[i] = buf[i] * f;
    data[i + 1] = buf[i + 1] * f;
    data[i + 2] = buf[i + 2] * f;
    data[i + 3] = a;
  }
  c.putImageData(pixels, 0, 0);
  return canvas;
}

async function teenyWebpCell(img, dw, dh, originalBytes) {
  const out = el('canvas', { width: dw, height: dh });
  const webp = teenyEncode(img);
  if (!webp) {
    return cell(out, '<span class="badge">no webp</span>');
  }
  const { url, rgb, alpha } = webp;
  const bytes = rgb.length + (alpha ? alpha.length : 0);
  const hash = alpha ? Uint8Array.from([...alpha, ...rgb]) : rgb;
  const b64 = btoa(String.fromCharCode(...hash));
  const ctx = ctx2d(out);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(await teenyBlur(url), 0, 0, dw, dh);
  const tag = alpha ? ' VP8+&alpha;' : ' VP8';
  return cell(peekable(out), `<b>${bytes}</b> B${tag} &middot; ${b64.length} chars`, { hash: b64, bytes, originalBytes });
}

function finehashCell(work, dw, dh, originalBytes) {
  const { data, width, height } = work;
  try {
    const bytes = finehash.encode(data, width, height);
    const b64 = finehash.toBase64(bytes);
    // Decode straight at the display size - FineHash's DCT is resolution-independent.
    const { rgba: pixels, width: fw, height: fh } = finehash.decode(bytes, { width: dw, height: dh });
    const meta = `<b>${bytes.length}</b> B &middot; ${b64.length} chars`;
    const canvas = peekable(rgbaCanvas(pixels, fw, fh, dw, dh));
    return cell(canvas, meta, { hash: b64, bytes: bytes.length, originalBytes });
  } catch (err) {
    const placeholder = el('canvas', { width: dw, height: dh });
    const ctx = ctx2d(placeholder);
    ctx.fillStyle = '#3a1d1d';
    ctx.fillRect(0, 0, dw, dh);
    return cell(placeholder, `<span class="badge">error</span> ${err.message}`, { pending: true });
  }
}

// ---------------------------------------------------------------------------
// Hero - the featured source -> hash -> placeholder flow at the top of the page.

function featureImage(img) {
  const work = toWorkingData(img, WORK_MAX);
  const { dw, dh } = heroDims(img.naturalWidth, img.naturalHeight);
  const source = document.getElementById('hero-img');
  source.width = dw;
  source.height = dh;
  ctx2d(source).drawImage(img, 0, 0, dw, dh);
  let bytes = null;
  let err = null;
  try {
    bytes = finehash.encode(work.data, work.width, work.height);
  } catch (e) {
    err = e;
  }
  renderHeroHash(bytes, err);
  renderHeroRender(bytes, dw, dh);
}

function renderHeroHash(bytes, err) {
  const box = document.getElementById('hero-hash');
  if (bytes) {
    box.classList.remove('pending');
    box.textContent = toHexGrid(bytes);
  } else {
    box.classList.add('pending');
    box.innerHTML = `<span class="badge">error</span><div class="pending-note">${err.message}</div>`;
  }
}

function renderHeroRender(bytes, dw, dh) {
  const canvas = document.getElementById('hero-render');
  canvas.width = dw;
  canvas.height = dh;
  try {
    if (!bytes) throw new Error('encode failed');
    const { rgba: pixels, width, height } = finehash.decode(bytes, { width: dw, height: dh });
    canvas.classList.remove('pending');
    paintRgbaInto(canvas, pixels, width, height);
  } catch {
    canvas.classList.add('pending');
    const ctx = ctx2d(canvas);
    ctx.fillStyle = '#1d1d1d';
    ctx.fillRect(0, 0, dw, dh);
    ctx.fillStyle = '#777';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('preview unavailable', dw / 2, dh / 2);
  }
}

// ---------------------------------------------------------------------------
// Procedural test patterns (defined in samples.mjs), rendered here to PNG data-URLs.

const buildSamples = createSampleSuite({
  makeCanvas: (w, h) => {
    const canvas = el('canvas', { width: w, height: h });
    return { canvas, ctx: ctx2d(canvas) };
  },
  makeImageData: (data, w, h) => imageData(data, w, h),
});

function syntheticSamples() {
  return buildSamples().map(({ canvas }) => canvas.toDataURL('image/png'));
}

// ---------------------------------------------------------------------------
// Rows

async function buildRow(src) {
  const [img, originalBytes] = await Promise.all([loadImage(src), sourceBytes(src)]);
  const { dw, dh } = previewDims(img.naturalWidth, img.naturalHeight);
  const full = readFull(img);
  const work = downsampleGrid(full, WORK_MAX);
  const fineTd = finehashCell(work, dw, dh, originalBytes);
  return el('tr', {}, [
    originalCell(img, full, dw, dh, originalBytes),
    fineTd,
    thumbhashCell(work, dw, dh, originalBytes),
    blurhashCell(work, dw, dh, originalBytes),
    ...(WEBP_SUPPORTED ? [await teenyWebpCell(img, dw, dh, originalBytes)] : []),
  ]);
}

async function addRow(src, { prepend = false } = {}) {
  const row = await buildRow(src);
  const tbody = document.getElementById('rows');
  if (prepend) tbody.prepend(row);
  else tbody.append(row);
  return row;
}

function handleFiles(files) {
  const urls = [...files]
    .filter(file => file.type.startsWith('image/'))
    .map(file => URL.createObjectURL(file));
  // Insert in reverse so the first selected file ends up on top.
  for (const url of [...urls].reverse()) {
    addRow(url, { prepend: true }).catch(console.error);
  }
  if (urls[0]) loadImage(urls[0]).then(featureImage).catch(console.error);
}

function buildHead() {
  const head = document.getElementById('head-row');
  for (const name of COLUMNS) head.append(el('th', {}, name));
}

function setupDropzone() {
  const zone = document.getElementById('dropzone');
  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  for (const t of ['dragenter', 'dragover']) {
    window.addEventListener(t, (e) => {
      stop(e);
      zone.classList.add('dragover');
    });
  }
  for (const t of ['dragleave', 'drop']) {
    window.addEventListener(t, (e) => {
      stop(e);
      zone.classList.remove('dragover');
    });
  }
  window.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
}

function setupUpload() {
  const input = document.getElementById('file-input');
  document.getElementById('upload-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    handleFiles(input.files);
    input.value = '';
  });
}

function toggleChecker() {
  const light = document.body.classList.toggle('checker-light');
  document.getElementById('checker-label').textContent = light ? 'light' : 'dark';
}

function setupCheckerToggle() {
  document.getElementById('checker-toggle').addEventListener('click', toggleChecker);
  document.addEventListener('click', (e) => {
    if (e.target.tagName === 'CANVAS' && e.target.closest('.cell, #hero')) toggleChecker();
  });
}

// Shift-hover any placeholder preview to peek at the row's original.
function setupPeek() {
  let shift = false;
  let hovered = null;
  const show = (canvas, on) => {
    if (!canvas) return;
    const ctx = ctx2d(canvas);
    const orig = canvas.closest('tr')?.cells[0]?.querySelector('canvas');
    if (on && orig) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(orig, 0, 0, canvas.width, canvas.height);
    } else if (canvas._snapshot) {
      ctx.putImageData(canvas._snapshot, 0, 0);
    }
  };
  document.addEventListener('mouseover', (e) => {
    if (e.target.classList?.contains('peek')) {
      hovered = e.target;
      if (shift) show(hovered, true);
    }
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target === hovered) {
      show(hovered, false);
      hovered = null;
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && !shift) {
      shift = true;
      show(hovered, true);
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') {
      shift = false;
      show(hovered, false);
    }
  });
}

window.addEventListener('load', async () => {
  buildHead();
  setupDropzone();
  setupUpload();
  setupCheckerToggle();
  setupPeek();
  const urls = syntheticSamples();
  if (urls[0]) loadImage(urls[0]).then(featureImage).catch(console.error);
  // Build all rows concurrently but append in order, each as soon as it and
  // its predecessors are ready, so the page fills incrementally.
  const tbody = document.getElementById('rows');
  let tail = Promise.resolve();
  for (const url of urls) {
    const pending = buildRow(url).catch(err => (console.error(err), null));
    tail = tail.then(() => pending).then(row => { if (row) tbody.append(row); });
  }
});
