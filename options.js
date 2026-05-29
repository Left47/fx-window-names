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
