// Window Names — background script
//
// Stores a custom name + color per window and reflects them into Firefox:
//   - the window title, via `windows.update({ titlePreface })` (shows in the
//     OS title bar, taskbar/window switcher, and macOS dock window menu);
//   - the toolbar button badge + tooltip (always visible in the chrome);
//   - the window's chrome color, via a per-window `theme.update(windowId, …)`.
//
// Each window's name/color is attached to the window itself with
// `sessions.setWindowValue`. Firefox saves that value with the session and
// gives it back to the same window when the session is restored, so names
// survive a restart and follow the right window. (Window ids are reassigned
// every session, so keying storage by id put names on the wrong windows.)

const VALUE_KEY = "entry"; // per-window session value: { name, color }
const LEGACY_STORAGE_KEY = "windowNames"; // old id-keyed store, no longer used
const FORMAT_KEY = "titleFormat"; // storage.local: how the name is shown
const DEFAULT_FORMAT = "{name} — ";

async function getStoredEntry(windowId) {
  try {
    const e = await browser.sessions.getWindowValue(windowId, VALUE_KEY);
    return e && typeof e === "object" ? e : null;
  } catch (e) {
    return null; // window gone
  }
}

async function setStoredEntry(windowId, entry) {
  try {
    if (entry) {
      await browser.sessions.setWindowValue(windowId, VALUE_KEY, entry);
    } else {
      await browser.sessions.removeWindowValue(windowId, VALUE_KEY);
    }
  } catch (e) {
    /* window gone — ignore */
  }
}

async function getFormat() {
  const r = await browser.storage.local.get(FORMAT_KEY);
  const f = r[FORMAT_KEY];
  return typeof f === "string" && f.includes("{name}") ? f : DEFAULT_FORMAT;
}

async function titlePrefaceFor(name) {
  if (!name) return "";
  return (await getFormat()).replace("{name}", name);
}

function toRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex({ r, g, b }) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Relative luminance (sRGB, simplified), 0 (black) .. 1 (white).
function luminance(hex) {
  const c = toRgb(hex);
  if (!c) return 0;
  return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
}

// Pick black or white text for legibility on a given hex background.
function contrastText(hex) {
  return luminance(hex) > 0.6 ? "#000000" : "#ffffff";
}

// Mix a color toward white or black by `ratio` (0..1) to get a related shade —
// used to give the URL field / selected tab a bit of depth against the chrome.
function shade(hex, ratio) {
  const c = toRgb(hex);
  if (!c) return hex;
  const target = luminance(hex) > 0.6 ? 0 : 255; // darken light colors, lighten dark
  return toHex({
    r: c.r + (target - c.r) * ratio,
    g: c.g + (target - c.g) * ratio,
    b: c.b + (target - c.b) * ratio,
  });
}

function lighten(hex, ratio) {
  const c = toRgb(hex);
  return c ? toHex({ r: c.r + (255 - c.r) * ratio, g: c.g + (255 - c.g) * ratio, b: c.b + (255 - c.b) * ratio }) : hex;
}

function darken(hex, ratio) {
  const c = toRgb(hex);
  return c ? toHex({ r: c.r * (1 - ratio), g: c.g * (1 - ratio), b: c.b * (1 - ratio) }) : hex;
}

async function canvasToDataUri(canvas) {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// A single edge gradient image (PNG data URI). It fades from an accent shade at
// the OUTER edge to the solid base color at the INNER edge, so it blends
// seamlessly into the solid middle. Pinning one of these to each side (with the
// base color filling the stretchy middle) gives gradients on the edges that
// stay put while the window resizes — the technique the Alpenglow theme uses.
async function edgeGradient(color, width, side) {
  const w = Math.max(40, Math.min(Math.round(width) || 140, 800));
  const h = 64; // tiled vertically (repeat-y), so the row height is arbitrary
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const accent = darken(color, 0.4);
  const g = ctx.createLinearGradient(0, 0, w, 0);
  if (side === "left") {
    g.addColorStop(0, accent); // outer (window edge)
    g.addColorStop(1, color); // inner (toward middle)
  } else {
    g.addColorStop(0, color); // inner
    g.addColorStop(1, accent); // outer (window edge)
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  return canvasToDataUri(canvas);
}

const DEFAULT_BADGE_BG = "#0a84ff";

// Reflect a name + color into the in-chrome toolbar button (badge + tooltip).
// The badge background takes the window's chosen color — a reliable, visible
// confirmation that the name/color were saved, independent of theming.
async function applyToChrome(windowId, name, color) {
  try {
    await browser.action.setBadgeText({ windowId, text: name || "" });
    await browser.action.setTitle({
      windowId,
      title: name ? `Window: ${name}` : "Name this window",
    });
    await browser.action.setBadgeBackgroundColor({
      windowId,
      color: color || DEFAULT_BADGE_BG,
    });
    if (browser.action.setBadgeTextColor) {
      await browser.action.setBadgeTextColor({
        windowId,
        color: contrastText(color || DEFAULT_BADGE_BG),
      });
    }
  } catch (e) {
    /* window gone — ignore */
  }
}

// Paint a window's whole chrome a solid color via a per-window theme.
//
// We do NOT merge into the user's existing theme: merging into an image-based
// theme left the chrome backgrounds coming from that theme (so the color only
// showed up on accents), and leaving keys unset made Firefox fill them with its
// dark defaults (the black title bar). Instead we set a complete, self-
// consistent set of chrome colors so the title bar, toolbar, tabs, sidebar, and
// menus all take the background color. The user's real theme is restored intact
// on clear by re-enabling their installed theme add-on.
async function applyColor(windowId, color) {
  const text = contrastText(color);
  const field = shade(color, 0.18); // URL bar / selected tab, for subtle depth
  const border = shade(color, 0.3);

  const colors = {
    // Title bar / window frame.
    frame: color,
    frame_inactive: shade(color, 0.12),
    // Tab strip.
    tab_background_text: text,
    tab_selected: field,
    tab_text: text,
    tab_line: text,
    tab_loading: text,
    // Toolbar (nav row) + its icons/text.
    toolbar: color,
    toolbar_text: text,
    icons: text,
    icons_attention: text,
    bookmark_text: text,
    toolbar_top_separator: border,
    toolbar_bottom_separator: border,
    // URL / search field.
    toolbar_field: field,
    toolbar_field_text: text,
    toolbar_field_border: border,
    toolbar_field_focus: field,
    toolbar_field_text_focus: text,
    // Sidebar (vertical tabs / panels).
    sidebar: color,
    sidebar_text: text,
    sidebar_border: border,
    // Menus / popups.
    popup: color,
    popup_text: text,
    popup_border: border,
  };

  // The native macOS title bar can't take an arbitrary color — it only follows
  // the theme's light/dark scheme. Match it to the chosen color's brightness so
  // it goes dark for dark colors and light for light ones (instead of Firefox's
  // default dark, which is why an under-specified theme showed a black bar).
  const properties = { color_scheme: text === "#000000" ? "light" : "dark" };

  // Pin a gradient image to each edge with the solid color filling the middle,
  // so the chrome resizes gracefully (only the solid middle stretches). The
  // frame stays the solid color; the toolbar is transparent so the edge images
  // and frame color show through it instead of being painted over.
  try {
    let winWidth = 1600;
    try {
      const win = await browser.windows.get(windowId);
      if (win.width) winWidth = win.width;
    } catch (e) {
      /* use default */
    }
    // A narrow accent strip at each edge; the solid color fills the middle.
    // Cap to a fraction of the window so the strips never meet on tiny windows.
    const sideWidth = Math.min(150, Math.round(winWidth * 0.25));
    const [leftImg, rightImg] = await Promise.all([
      edgeGradient(color, sideWidth, "left"),
      edgeGradient(color, sideWidth, "right"),
    ]);
    await browser.theme.update(windowId, {
      images: { additional_backgrounds: [leftImg, rightImg] },
      properties: {
        ...properties,
        // repeat-y so the strip runs the full height (e.g. a vertical-tab
        // sidebar), not just the top toolbar band.
        additional_backgrounds_alignment: ["left top", "right top"],
        additional_backgrounds_tiling: ["repeat-y", "repeat-y"],
      },
      colors: {
        ...colors,
        frame: color, // solid, stretchy middle
        frame_inactive: color,
        toolbar: "rgba(0,0,0,0)", // let the edge images + frame show through
      },
    });
  } catch (e) {
    // Some builds reject data-URI theme images — fall back to the solid color.
    console.warn("[Window Names] gradient image failed, using solid:", e);
    await browser.theme.update(windowId, { properties, colors });
  }
}

const DEFAULT_THEME_ID = "default-theme@mozilla.org";

// Re-apply the user's installed theme add-on by toggling it off and on. This
// is the reliable way to bring back an image-based theme: Firefox re-applies
// it (images included) across all windows, which a per-window dynamic theme
// can't reconstruct. Returns true if an installed theme was re-enabled.
async function reenableInstalledTheme() {
  try {
    const addons = await browser.management.getAll();
    const theme = addons.find(
      (a) => a.type === "theme" && a.enabled && a.id !== DEFAULT_THEME_ID
    );
    if (theme) {
      await browser.management.setEnabled(theme.id, false);
      await browser.management.setEnabled(theme.id, true);
      // Let the re-applied theme settle before we re-paint other windows,
      // otherwise the global re-apply lands last and wipes those colors.
      await new Promise((r) => setTimeout(r, 300));
      return true;
    }
  } catch (e) {
    console.warn("[Window Names] could not re-enable installed theme:", e);
  }
  return false;
}

// Restore themes after clearing one window's color: drop that window's
// override, re-apply the user's installed theme globally, then re-paint any
// OTHER windows that are still colored (since the global re-enable resets all).
async function restoreThemes(clearedWindowId) {
  try {
    await browser.theme.reset(clearedWindowId);
  } catch (e) {
    /* ignore */
  }

  const reenabled = await reenableInstalledTheme();
  if (!reenabled) {
    // No installed theme add-on (e.g. the default theme) — reset is enough.
    try {
      await browser.theme.reset(clearedWindowId);
    } catch (e) {
      /* ignore */
    }
  }

  const windows = await browser.windows.getAll();
  for (const w of windows) {
    if (w.id === clearedWindowId) continue;
    const entry = await getStoredEntry(w.id);
    if (!entry || !entry.color) continue;
    try {
      await applyColor(w.id, entry.color);
    } catch (e) {
      /* ignore */
    }
  }
}

// Reflect a stored entry into a window: title, badge, color.
async function paintWindow(windowId, entry) {
  try {
    await browser.windows.update(windowId, {
      titlePreface: await titlePrefaceFor(entry.name),
    });
  } catch (e) {
    /* window gone — ignore */
  }
  await applyToChrome(windowId, entry.name, entry.color);
  if (entry.color) {
    try {
      await applyColor(windowId, entry.color);
    } catch (e) {
      /* window gone or theme API unavailable — ignore */
    }
  }
}

// Apply name + color to a window and persist. Empty values clear them.
async function applyEntry(windowId, name, color) {
  const prev = (await getStoredEntry(windowId)) || {};
  const trimmed = (name || "").trim();
  const entry = { name: trimmed, color: color || "" };

  await paintWindow(windowId, entry);
  if (!entry.color && prev.color) {
    await restoreThemes(windowId);
  }
  await setStoredEntry(windowId, trimmed || color ? entry : null);
}

async function getEntry(windowId) {
  const e = (await getStoredEntry(windowId)) || {};
  return { name: e.name || "", color: e.color || "" };
}

// Re-apply a window's stored name/color. During session restore Firefox can
// create the window before it hands back the window's saved values, so if
// nothing is there yet, check again a few times before giving up.
const RESTORE_RETRY_MS = [0, 500, 1500, 4000];

async function reapplyWindow(windowId) {
  for (const delay of RESTORE_RETRY_MS) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const entry = await getStoredEntry(windowId);
    if (entry && (entry.name || entry.color)) {
      await paintWindow(windowId, entry);
      return;
    }
  }
}

async function reapplyAll() {
  const windows = await browser.windows.getAll();
  await Promise.all(windows.map((w) => reapplyWindow(w.id)));
}

// Restored windows (session restore, or reopening a recently closed window)
// arrive as new windows carrying their saved values.
browser.windows.onCreated.addListener((win) => {
  reapplyWindow(win.id);
});

// The title format changed in the options page — rewrite every window title.
browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes[FORMAT_KEY]) return;
  const windows = await browser.windows.getAll();
  for (const w of windows) {
    const entry = await getStoredEntry(w.id);
    if (!entry || !entry.name) continue;
    try {
      await browser.windows.update(w.id, {
        titlePreface: await titlePrefaceFor(entry.name),
      });
    } catch (e) {
      /* ignore */
    }
  }
});

// Drop the old id-keyed store: its ids belong to past sessions, which is what
// put names on the wrong windows after a restart.
browser.storage.local.remove(LEGACY_STORAGE_KEY);

// Style the badge once so the name reads clearly on the toolbar button.
browser.action.setBadgeBackgroundColor({ color: "#0a84ff" });
if (browser.action.setBadgeTextColor) {
  browser.action.setBadgeTextColor({ color: "#ffffff" });
}

browser.runtime.onStartup.addListener(reapplyAll);
reapplyAll();

// Messages from the popup.
browser.runtime.onMessage.addListener((msg) => {
  if (msg.action === "get") {
    return getEntry(msg.windowId);
  }
  if (msg.action === "set") {
    return applyEntry(msg.windowId, msg.name, msg.color).then(() => ({
      ok: true,
    }));
  }
});
