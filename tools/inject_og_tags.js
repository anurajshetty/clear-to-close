#!/usr/bin/env node
/**
 * inject_og_tags.js — post-export Open Graph injection (Oct 20, 2026).
 *
 * Why this exists: the web app exports in SPA ("single") mode, and in
 * that mode Expo builds index.html from the Expo config template only —
 * app/+html.tsx is honored solely by the static/server export paths,
 * and the config template has no Open Graph support. Switching the
 * rendering model app-wide for a metadata rider was rejected
 * (change-scope rule), so the tags are injected here instead, as part
 * of the sanctioned `npm run export:web` path (the repo's only web
 * export route). The deploy script regenerates 404.html from
 * index.html, so the deployed shell carries the tags too.
 *
 * Idempotent: re-running changes nothing. Fails loudly (exit 1) when
 * dist/index.html or its </head> is missing — a silent no-op would
 * ship a bare preview card.
 */
const fs = require('fs');
const path = require('path');

const TAGS = [
  '<meta property="og:title" content="Clear to Close">',
  '<meta property="og:description" content="Your escrow, step by step. Clear to Close keeps you and your realtor connected and up to date, from accepted offer to closing.">',
  '<meta property="og:image" content="https://anurajshetty.github.io/clear-to-close/app-icon.png">',
  '<meta property="og:type" content="website">',
  '<meta name="twitter:card" content="summary">',
];

const file = path.join(__dirname, '..', 'dist', 'index.html');
if (!fs.existsSync(file)) {
  console.error('inject_og_tags: dist/index.html not found — run the web export first.');
  process.exit(1);
}
const html = fs.readFileSync(file, 'utf8');
if (html.includes('property="og:title"')) {
  console.log('inject_og_tags: OG tags already present, nothing to do.');
  process.exit(0);
}
if (!html.includes('</head>')) {
  console.error('inject_og_tags: no </head> in dist/index.html — refusing to guess.');
  process.exit(1);
}
fs.writeFileSync(file, html.replace('</head>', TAGS.join('\n') + '\n</head>'));
console.log('inject_og_tags: Open Graph tags injected into dist/index.html.');
