import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
import { config } from '../config.js';

const DIR = path.join(config.dataDir, 'creatives');
const UPLOADS = path.join(config.dataDir, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

export const SIZES = {
  square: { w: 1080, h: 1080 },   // Meta feed
};

/** Resolves a stored creative file name to an absolute path, rejecting traversal. */
export function creativePath(file) {
  const name = path.basename(String(file));
  if (!/^[a-z0-9_-]+\.png$/i.test(name)) throw new Error('Invalid creative file name');
  return path.join(DIR, name);
}

export function uploadPath(file) {
  const name = path.basename(String(file));
  if (!/^[a-z0-9_-]+\.(png|jpe?g)$/i.test(name)) throw new Error('Invalid upload file name');
  return path.join(UPLOADS, name);
}
export const UPLOAD_DIR = UPLOADS;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const hex = (c, fallback) => (/^#[0-9a-fA-F]{6}$/.test(c ?? '') ? c : fallback);

function wrap(text, maxChars, maxLines) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  }
  return lines;
}

const CTA_LABEL = {
  LEARN_MORE: 'Learn more', SHOP_NOW: 'Shop now', SIGN_UP: 'Sign up', CONTACT_US: 'Contact us',
  GET_QUOTE: 'Get a quote', DOWNLOAD: 'Download', APPLY_NOW: 'Apply now', SUBSCRIBE: 'Subscribe',
};

function buildSvg({ w, h }, design, cta, brand, productImage) {
  const bgFrom = hex(design.bg_from, '#1E3A8A');
  const bgTo = hex(design.bg_to, '#0F172A');
  const accent = hex(design.accent, '#F59E0B');
  const fg = hex(design.text_color, '#FFFFFF');
  const landscape = w > h;
  const pad = Math.round(w * 0.07);
  const font = `font-family="Segoe UI, Arial, Helvetica, DejaVu Sans, sans-serif"`;

  let layout = design.layout;
  if (!productImage && layout === 'left') layout = 'center';

  // Product photo occupies a panel; text sits in the remaining space.
  let img = '';
  let textX = pad, textW = w - pad * 2, anchor = 'start', textTop = pad * 1.6;
  if (productImage) {
    if (layout === 'left' || landscape) {
      const iw = Math.round(w * 0.45);
      img = `<image href="${productImage}" x="${w - iw}" y="0" width="${iw}" height="${h}" preserveAspectRatio="xMidYMid slice"/>
             <rect x="${w - iw}" y="0" width="${iw}" height="${h}" fill="url(#fade)"/>`;
      textW = w - iw - pad * 1.5;
    } else if (layout === 'bottom') {
      const ih = Math.round(h * 0.55);
      img = `<image href="${productImage}" x="0" y="0" width="${w}" height="${ih}" preserveAspectRatio="xMidYMid slice"/>`;
      textTop = ih + pad * 0.9;
    } else {
      img = `<image href="${productImage}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" opacity="0.35"/>`;
    }
  }
  if (layout === 'center' && !(productImage && landscape)) { anchor = 'middle'; textX = w / 2; }

  const scale = landscape ? 0.85 : 1;
  const btnH = Math.round(84 * scale);
  const maxBottom = h - pad - btnH - pad * 0.5; // text must end above the CTA button

  // Shrink type until the headline + subtext block fits the available area without truncation.
  let hSize = Math.round(84 * scale), sSize = Math.round(36 * scale), hLines, sLines, blockH;
  for (;;) {
    hLines = wrap(design.overlay_headline, Math.max(8, Math.floor(textW / (hSize * 0.56))), 4);
    sLines = wrap(design.overlay_subtext, Math.max(12, Math.floor(textW / (sSize * 0.5))), 3);
    blockH = hLines.length * hSize * 1.12 + sSize * 0.6 + sLines.length * sSize * 1.3;
    const truncated = hLines.at(-1)?.endsWith('…') || sLines.at(-1)?.endsWith('…');
    if ((!truncated && textTop + blockH <= maxBottom) || hSize <= 36) break;
    hSize -= 4;
    sSize = Math.max(22, Math.round(hSize * 0.43));
  }

  if (!productImage || (layout === 'center' && !landscape)) {
    // Vertically centre the text block in the space above the CTA button.
    textTop = Math.max(pad * 1.6, (maxBottom - blockH) / 2);
  }

  let y = textTop + hSize;
  const headline = hLines.map((l, i) => `<text x="${textX}" y="${y + i * hSize * 1.12}" ${font} font-size="${hSize}" font-weight="800" fill="${fg}" text-anchor="${anchor}">${esc(l)}</text>`).join('');
  y += hLines.length * hSize * 1.12 + sSize * 0.6;
  const sub = sLines.map((l, i) => `<text x="${textX}" y="${y + i * sSize * 1.3}" ${font} font-size="${sSize}" fill="${fg}" opacity="0.9" text-anchor="${anchor}">${esc(l)}</text>`).join('');

  const btnLabel = CTA_LABEL[cta] ?? 'Learn more';
  const btnW = Math.round((btnLabel.length * 22 + 90) * scale);
  const btnY = h - pad - btnH;
  const btnX = anchor === 'middle' ? w / 2 - btnW / 2 : textX;
  const button = `<rect x="${btnX}" y="${btnY}" width="${btnW}" height="${btnH}" rx="${btnH / 2}" fill="${accent}"/>
    <text x="${btnX + btnW / 2}" y="${btnY + btnH / 2 + 12 * scale}" ${font} font-size="${Math.round(34 * scale)}" font-weight="700" fill="#111111" text-anchor="middle">${esc(btnLabel)}</text>`;

  const badge = design.badge
    ? `<rect x="${pad}" y="${pad * 0.6}" width="${design.badge.length * 20 * scale + 48}" height="${58 * scale}" rx="10" fill="${accent}"/>
       <text x="${pad + 24}" y="${pad * 0.6 + 40 * scale}" ${font} font-size="${Math.round(30 * scale)}" font-weight="800" fill="#111111">${esc(design.badge.toUpperCase())}</text>`
    : '';
  const brandMark = brand
    ? `<text x="${w - pad}" y="${h - pad * 0.45}" ${font} font-size="${Math.round(24 * scale)}" fill="${fg}" opacity="0.75" text-anchor="end">${esc(brand)}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bgFrom}"/><stop offset="1" stop-color="${bgTo}"/></linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${bgTo}" stop-opacity="0.9"/><stop offset="0.35" stop-color="${bgTo}" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <circle cx="${w * 0.9}" cy="${h * 0.1}" r="${w * 0.25}" fill="${accent}" opacity="0.12"/>
  ${img}${badge}${headline}${sub}${button}${brandMark}
</svg>`;
}

function productDataUri(file) {
  if (!file) return null;
  const p = uploadPath(file);
  if (!fs.existsSync(p)) return null;
  const mime = p.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
}

/** Renders both creative sizes to PNG and returns their stored file names. */
export function renderCreatives(design, cta, { brand, productImage } = {}) {
  const img = productDataUri(productImage);
  const out = {};
  for (const [name, size] of Object.entries(SIZES)) {
    const svg = buildSvg(size, design, cta, brand, img);
    // No external resources: fonts come from the system, images are inline data URIs only.
    const png = new Resvg(svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } }).render().asPng();
    const file = `cr_${name}_${crypto.randomBytes(8).toString('hex')}.png`;
    fs.writeFileSync(path.join(DIR, file), png);
    out[name] = file;
  }
  return out;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Store a user-supplied finished creative. Only real PNG files are accepted. */
export function storeUploadedCreative(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('Finished creatives must be PNG files');
  const file = `cr_upload_${crypto.randomBytes(8).toString('hex')}.png`;
  fs.writeFileSync(path.join(DIR, file), buffer);
  return file;
}
