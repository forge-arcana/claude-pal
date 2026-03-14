const sharp = require('sharp');

// Claude Pal icon: Dark rounded-square background with a stylized gauge arc
// and a friendly "CP" monogram in Claude's terracotta/coral palette
const size = 128;
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a1a2e"/>
      <stop offset="100%" style="stop-color:#16213e"/>
    </linearGradient>
    <linearGradient id="arc" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#e07a5f"/>
      <stop offset="50%" style="stop-color:#d4956b"/>
      <stop offset="100%" style="stop-color:#81b29a"/>
    </linearGradient>
    <linearGradient id="needle" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#e07a5f"/>
      <stop offset="100%" style="stop-color:#f2cc8f"/>
    </linearGradient>
  </defs>

  <!-- Background rounded square -->
  <rect width="128" height="128" rx="24" ry="24" fill="url(#bg)"/>

  <!-- Gauge arc background (subtle) -->
  <path d="M 28 88 A 40 40 0 1 1 100 88"
        fill="none" stroke="#2a2a4a" stroke-width="8" stroke-linecap="round"/>

  <!-- Gauge arc fill (usage indicator ~65%) -->
  <path d="M 28 88 A 40 40 0 1 1 85 52"
        fill="none" stroke="url(#arc)" stroke-width="8" stroke-linecap="round"/>

  <!-- Gauge tick marks -->
  <circle cx="28" cy="88" r="2.5" fill="#3a3a5a"/>
  <circle cx="24" cy="64" r="2.5" fill="#3a3a5a"/>
  <circle cx="36" cy="44" r="2.5" fill="#3a3a5a"/>
  <circle cx="64" cy="36" r="2.5" fill="#3a3a5a"/>
  <circle cx="92" cy="44" r="2.5" fill="#3a3a5a"/>
  <circle cx="104" cy="64" r="2.5" fill="#3a3a5a"/>
  <circle cx="100" cy="88" r="2.5" fill="#3a3a5a"/>

  <!-- Needle pointing ~65% position -->
  <line x1="64" y1="76" x2="82" y2="50"
        stroke="url(#needle)" stroke-width="3" stroke-linecap="round"/>

  <!-- Center dot -->
  <circle cx="64" cy="76" r="5" fill="#e07a5f"/>
  <circle cx="64" cy="76" r="2.5" fill="#1a1a2e"/>

  <!-- "CP" text below gauge -->
  <text x="64" y="108" text-anchor="middle"
        font-family="system-ui, -apple-system, sans-serif"
        font-size="16" font-weight="700" letter-spacing="3"
        fill="#e07a5f" opacity="0.8">CP</text>
</svg>
`;

sharp(Buffer.from(svg))
  .resize(128, 128)
  .png()
  .toFile('/root/dev/forge/vsix/claude-pal/assets/claude-pal-icon-128.png')
  .then(() => console.log('Icon generated: claude-pal-icon-128.png'))
  .catch(err => console.error('Error:', err));
