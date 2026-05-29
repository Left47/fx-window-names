// Window Names — background script
//
// Stores a custom name + color per window in storage.local (keyed by window
// id) and reflects them into Firefox:
//   - the window title, via `windows.update({ titlePreface })` (shows in the
//     OS title bar, taskbar/window switcher, and macOS dock window menu);
//   - the toolbar button badge + tooltip (always visible in the chrome);
//   - the window's chrome color, via a per-window `theme.update(windowId, …)`.
//
// Note: window ids are assigned fresh each browser session, so names/colors do
// not survive a full restart — they live for as long as the window is open.

const STORAGE_KEY = "windowNames";
const SEPARATOR = " — "; // separates the custom name from the page title

async function loadEntries() {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {};
}

async function saveEntries(entries) {
  await browser.storage.local.set({ [STORAGE_KEY]: entries });
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

  const entries = await loadEntries();
  for (const [id, entry] of Object.entries(entries)) {
    if (Number(id) === clearedWindowId || !entry.color) continue;
    try {
      await applyColor(Number(id), entry.color);
    } catch (e) {
      /* ignore */
    }
  }
}

// Apply name + color to a window and persist. Empty values clear them.
async function applyEntry(windowId, name, color) {
  const entries = await loadEntries();
  const prev = entries[windowId] || {};
  const trimmed = (name || "").trim();

  const titlePreface = trimmed ? trimmed + SEPARATOR : "";
  try {
    await browser.windows.update(windowId, { titlePreface });
  } catch (e) {
    // Window may have closed between read and write — ignore.
  }
  await applyToChrome(windowId, trimmed, color);

  if (color) {
    try {
      await applyColor(windowId, color);
    } catch (e) {
      /* window gone or theme API unavailable — ignore */
    }
  } else if (prev.color) {
    await restoreThemes(windowId);
  }

  if (trimmed || color) {
    entries[windowId] = { name: trimmed, color: color || "" };
  } else {
    delete entries[windowId];
  }
  await saveEntries(entries);
}

async function getEntry(windowId) {
  const entries = await loadEntries();
  const e = entries[windowId] || {};
  return { name: e.name || "", color: e.color || "" };
}

// Re-apply stored names/colors to currently open windows. Useful if the
// background script is restarted while windows are still open.
async function reapplyAll() {
  const entries = await loadEntries();
  const windows = await browser.windows.getAll();
  const live = new Set(windows.map((w) => String(w.id)));
  let changed = false;

  for (const w of windows) {
    const entry = entries[w.id];
    if (!entry) continue;
    await applyToChrome(w.id, entry.name, entry.color);
    if (entry.name) {
      try {
        await browser.windows.update(w.id, {
          titlePreface: entry.name + SEPARATOR,
        });
      } catch (e) {
        /* ignore */
      }
    }
    if (entry.color) {
      try {
        await applyColor(w.id, entry.color);
      } catch (e) {
        /* ignore */
      }
    }
  }

  // Drop entries for windows that no longer exist.
  for (const id of Object.keys(entries)) {
    if (!live.has(id)) {
      delete entries[id];
      changed = true;
    }
  }
  if (changed) await saveEntries(entries);
}

// Clean up storage when a window closes.
browser.windows.onRemoved.addListener(async (windowId) => {
  const entries = await loadEntries();
  if (entries[windowId] !== undefined) {
    delete entries[windowId];
    await saveEntries(entries);
  }
});

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
