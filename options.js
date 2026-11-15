// Window Names — options/help page.
//
// Firefox does not expose the title-bar preference to extensions, so we can't
// toggle it programmatically. We try to open the Customize Toolbar UI (where
// the "Title Bar" checkbox lives); if Firefox blocks navigating to that page,
// we fall back to showing the manual steps.

document.getElementById("openCustomize").addEventListener("click", async () => {
  try {
    await browser.tabs.create({ url: "about:customizing" });
  } catch (e) {
    document.getElementById("hint").hidden = false;
  }
});

// Title format: how the window name is prefixed to the page title. Stored in
// storage.local; background.js rewrites open window titles when it changes.
const FORMAT_KEY = "titleFormat";
const DEFAULT_FORMAT = "{name} — ";

const preset = document.getElementById("formatPreset");
const customRow = document.getElementById("customRow");
const custom = document.getElementById("formatCustom");
const preview = document.getElementById("formatPreview");

function showPreview(format) {
  preview.textContent = format.includes("{name}")
    ? `Preview: “${format.replace("{name}", "Work")}Page title”`
    : "The format needs {name} in it — keeping the previous one.";
}

async function saveFormat(format) {
  showPreview(format);
  if (format.includes("{name}")) {
    await browser.storage.local.set({ [FORMAT_KEY]: format });
  }
}

preset.addEventListener("change", () => {
  const isCustom = preset.value === "custom";
  customRow.hidden = !isCustom;
  if (isCustom) {
    if (!custom.value) custom.value = "«{name}» ";
    custom.focus();
    saveFormat(custom.value);
  } else {
    saveFormat(preset.value);
  }
});

custom.addEventListener("input", () => saveFormat(custom.value));

(async () => {
  const r = await browser.storage.local.get(FORMAT_KEY);
  const format = typeof r[FORMAT_KEY] === "string" ? r[FORMAT_KEY] : DEFAULT_FORMAT;
  const match = [...preset.options].find((o) => o.value === format);
  if (match) {
    preset.value = format;
  } else {
    preset.value = "custom";
    custom.value = format;
    customRow.hidden = false;
  }
  showPreview(format);
})();
