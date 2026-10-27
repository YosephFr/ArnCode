import pc from 'picocolors';

export type ThemeName = 'dark' | 'light' | 'plain';

export interface Theme {
  name: ThemeName;
  color: boolean;
  accent(text: string): string;
  muted(text: string): string;
  strong(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  /** Diff lines and the input band use tinted backgrounds instead of drawn borders. */
  added(text: string): string;
  removed(text: string): string;
  surface(text: string): string;
}

type Tint = number | [number, number, number];

const background = (tint: Tint) => (text: string) =>
  `\u001b[48;${typeof tint === 'number' ? `5;${tint}` : `2;${tint.join(';')}`}m${text}\u001b[49m`;

// Neutral grays and soft tints that keep the default foreground readable. Truecolor terminals
// get gentler RGB tints; others use the closest 256-color entries.
const tints: Record<'dark' | 'light', Record<'surface' | 'added' | 'removed', [Tint, Tint]>> = {
  dark: {
    surface: [236, [44, 44, 46]],
    added: [22, [28, 54, 36]],
    removed: [52, [62, 30, 32]],
  },
  light: {
    surface: [255, [238, 238, 240]],
    added: [194, [222, 244, 228]],
    removed: [224, [250, 226, 226]],
  },
};

export function createTheme(name: ThemeName, enabled = true, truecolor = false): Theme {
  if (name === 'plain' || !enabled) {
    const plain = (text: string) => text;
    return {
      name: 'plain',
      color: false,
      accent: plain,
      muted: plain,
      strong: plain,
      success: plain,
      warning: plain,
      error: plain,
      added: plain,
      removed: plain,
      surface: plain,
    };
  }
  const colors = pc.createColors(true);
  const pick = (key: 'surface' | 'added' | 'removed') => tints[name][key][truecolor ? 1 : 0];
  return {
    name,
    color: true,
    accent: name === 'dark' ? colors.cyan : colors.blue,
    muted: colors.dim,
    strong: colors.bold,
    success: colors.green,
    warning: colors.yellow,
    error: colors.red,
    added: background(pick('added')),
    removed: background(pick('removed')),
    surface: background(pick('surface')),
  };
}

/** Pick a theme for a stream: plain without a color TTY, light when the terminal reports it. */
export function themeFor(
  stream: { isTTY?: boolean },
  preference: ThemeName | 'auto' = 'auto',
  env: NodeJS.ProcessEnv = process.env,
): Theme {
  const enabled = Boolean(stream.isTTY) && !env.NO_COLOR && env.TERM !== 'dumb';
  if (!enabled) return createTheme('plain', false);
  const truecolor = /^(?:truecolor|24bit)$/i.test(env.COLORTERM ?? '');
  if (preference !== 'auto') return createTheme(preference, true, truecolor);
  // COLORFGBG ends with the background color index; 7 and 15 are the light grays and white.
  const backgroundColor = Number(env.COLORFGBG?.split(';').at(-1));
  return createTheme([7, 15].includes(backgroundColor) ? 'light' : 'dark', true, truecolor);
}
