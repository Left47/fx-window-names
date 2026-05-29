// Window Names — popup
//
// Lets the user view and edit the name and title-bar color of the current
// window. Colors are chosen from preset swatches rather than a native color
// input: on macOS the native picker is a separate window, and opening it would
// close this popup (popups dismiss on focus loss) before a pick is saved.
//
// The actual title/badge/theme updates and persistence happen in background.js.

const input = document.getElementById("name");
const form = document.getElementById("form");
const clearBtn = document.getElementById("clear");
// All color choices, including the "None" swatch that sits on the label row.
const swatchButtons = document.querySelectorAll(".swatch");

let currentWindowId;
let selectedColor = "";

function selectColor(color) {
  selectedColor = color;
  for (const btn of swatchButtons) {
    btn.classList.toggle("selected", btn.dataset.color === color);
  }
}

async function init() {
  const win = await browser.windows.getCurrent();
  currentWindowId = win.id;
  const entry = await browser.runtime.sendMessage({
    action: "get",
    windowId: currentWindowId,
  });
  input.value = entry.name || "";
  selectColor(entry.color || "");
  input.focus();
  input.select();
}

for (const btn of swatchButtons) {
  btn.addEventListener("click", () => selectColor(btn.dataset.color));
}

async function save(name, color) {
  await browser.runtime.sendMessage({
    action: "set",
    windowId: currentWindowId,
    name,
    color,
  });
  window.close();
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  save(input.value, selectedColor);
});

clearBtn.addEventListener("click", () => {
  save("", "");
});

init();
