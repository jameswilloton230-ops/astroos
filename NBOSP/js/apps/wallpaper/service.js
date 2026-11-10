'use strict';

const WALLPAPER_PRESETS = Object.freeze({
  'stock-blue': {
    name: 'Lineage Dark',
    gradient: '#0f0f0f',
  },
  'stock-dark': {
    name: 'Obsidian',
    gradient: 'radial-gradient(ellipse at 70% 25%, #160a28 0%, transparent 55%), radial-gradient(ellipse at 25% 75%, #0c0818 0%, transparent 50%), linear-gradient(150deg, #080810 0%, #0e0818 50%, #08080e 100%)',
  },
  'stock-light': {
    name: 'Frost',
    gradient: 'radial-gradient(ellipse at 40% 30%, #ffffff 0%, #e8f0ff 45%, transparent 70%), linear-gradient(160deg, #dde8f8 0%, #eaf0ff 45%, #d8e6f5 100%)',
  },
  'stock-green': {
    name: 'Evergreen',
    gradient: 'radial-gradient(ellipse at 30% 40%, #0a5c2a 0%, #043818 38%, transparent 65%), linear-gradient(155deg, #020c06 0%, #040e08 45%, #060e06 75%, #020c06 100%)',
  },
  'stock-purple': {
    name: 'Deep Violet',
    gradient: 'radial-gradient(ellipse at 62% 32%, #4a1272 0%, #2c0858 40%, transparent 65%), radial-gradient(ellipse at 22% 70%, #1e084a 0%, transparent 50%), linear-gradient(155deg, #0a0414 0%, #140628 50%, #0a0414 100%)',
  },
  'stock-red': {
    name: 'Ember Core',
    gradient: 'radial-gradient(ellipse at 35% 42%, #8c1a10 0%, #5c0808 40%, transparent 65%), radial-gradient(ellipse at 75% 70%, #3a0c0c 0%, transparent 50%), linear-gradient(155deg, #0e0404 0%, #180808 45%, #0e0404 100%)',
  },
  'stock-gray': {
    name: 'Steel',
    gradient: 'radial-gradient(ellipse at 50% 32%, #2c3c4e 0%, #1a2838 40%, transparent 65%), linear-gradient(155deg, #0c1018 0%, #16202c 45%, #0c1218 75%, #0c1018 100%)',
  },
  'stock-teal': {
    name: 'Abyss',
    gradient: 'radial-gradient(ellipse at 38% 36%, #0a5e70 0%, #044050 40%, transparent 65%), radial-gradient(ellipse at 72% 68%, #042835 0%, transparent 50%), linear-gradient(155deg, #020c10 0%, #041520 45%, #021018 100%)',
  },
});

function applyWallpaper(settings) {
  if (typeof settings !== 'function') {
    throw new TypeError('Wallpaper settings reader must be a function');
  }

  const customWallpaper = settings('customWallpaper');
  const wallpaperId = settings('wallpaperId');
  const wallpaper = document.getElementById('wallpaper');
  const desktop = document.getElementById('desktop');
  const targets = [wallpaper, desktop].filter(Boolean);
  if (targets.length === 0) return false;

  const preset = WALLPAPER_PRESETS[wallpaperId] || WALLPAPER_PRESETS['stock-blue'];
  for (const target of targets) {
    const style = target.style;
    // AstroOS fix: a flat hex like '#0f0f0f' is not a valid backgroundImage
    // value — it gets silently rejected and the previous background stays
    // showing. Route flat colours to backgroundColor, everything else to
    // backgroundImage.
    const paint = customWallpaper
      ? `url(${JSON.stringify(String(customWallpaper))})`
      : preset.gradient;
    const isFlatColor = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(paint).trim());
    if (isFlatColor) {
      style.backgroundColor = paint;
      style.backgroundImage = 'none';
    } else {
      style.backgroundImage = paint;
      style.backgroundColor = '';
    }
    style.backgroundSize = customWallpaper ? 'cover' : '';
    style.backgroundPosition = customWallpaper ? 'center' : '';
    style.backgroundRepeat = customWallpaper ? 'no-repeat' : '';
  }
  return true;
}

window.WallpaperService = Object.freeze({
  apply: applyWallpaper,
  getPresets: () => Object.entries(WALLPAPER_PRESETS).map(([id, preset]) => ({
    id,
    name: preset.name,
    gradient: preset.gradient,
  })),
});
