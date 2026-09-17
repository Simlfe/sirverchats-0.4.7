/**
 * Load optional theme fonts only when a theme actually selects them.
 * The core UI/Arabic fonts are loaded in index.html so first paint stays
 * stable without downloading every decorative font in the theme library.
 */
const FONT_WEIGHTS: Record<string, string> = {
  Alexandria: '400;600;700;800',
  Almarai: '400;700;800',
  'Cinzel Decorative': '700;900',
  Cinzel: '500;700;900',
  'DM Sans': '400;500;600;700;800',
  'El Messiri': '500;600;700',
  'Fira Code': '400;500;700',
  Inter: '400;500;600;700',
  'JetBrains Mono': '400;500;700',
  Lexend: '400;500;600;700',
  Nunito: '400;600;700;800;900',
  Orbitron: '500;700;900',
  Outfit: '400;500;600;700;800',
  Poppins: '400;500;600;700',
  'Readex Pro': '400;500;600;700',
  Rubik: '400;500;600;700',
  Sora: '400;500;600;700;800',
  'Space Grotesk': '400;500;600;700',
  Syne: '500;700;800',
  Urbanist: '400;500;600;700;800',
};

const loadedFonts = new Set(['Plus Jakarta Sans', 'Cairo', 'Tajawal']);

function fontNames(stack: string): string[] {
  return stack
    .split(',')
    .map((name) => name.trim().replace(/^['"]|['"]$/g, ''))
    .filter((name) => Boolean(FONT_WEIGHTS[name]));
}

export function loadThemeFonts(...stacks: Array<string | undefined>): void {
  if (typeof document === 'undefined') return;

  for (const name of new Set(stacks.flatMap((stack) => fontNames(stack || '')))) {
    if (loadedFonts.has(name)) continue;
    loadedFonts.add(name);

    const family = `${name.replace(/ /g, '+')}:wght@${FONT_WEIGHTS[name]}`;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
    link.dataset.sirverThemeFont = name;
    document.head.appendChild(link);
  }
}
