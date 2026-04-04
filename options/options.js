// options.js

const FIELDS = {
  "anthropic-key":   "anthropicKey",
  "notion-token":    "notionToken",
  "notion-db-id":    "notionDbId",
  "interval-clean":  "intervalClean",
  "interval-hints":  "intervalHints",
  "interval-failed": "intervalFailed",
};

async function loadSettings() {
  const keys = Object.values(FIELDS);
  const stored = await chrome.storage.local.get(keys);

  for (const [elId, storageKey] of Object.entries(FIELDS)) {
    const el = document.getElementById(elId);
    if (!el) continue;
    if (stored[storageKey] !== undefined) {
      el.value = stored[storageKey];
    }
  }
}

async function saveSettings() {
  const toSave = {};
  for (const [elId, storageKey] of Object.entries(FIELDS)) {
    const el = document.getElementById(elId);
    if (!el) continue;
    const val = el.value.trim();
    if (val === "") continue;
    // Parse numbers for interval fields
    if (el.type === "number") {
      const num = parseInt(val, 10);
      if (!isNaN(num)) toSave[storageKey] = num;
    } else {
      toSave[storageKey] = val;
    }
  }

  await chrome.storage.local.set(toSave);

  // Show confirmation
  const msg = document.getElementById("saved-msg");
  msg.classList.add("visible");
  setTimeout(() => msg.classList.remove("visible"), 2000);
}

document.getElementById("save-btn").addEventListener("click", saveSettings);

loadSettings();
