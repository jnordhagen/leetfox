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

// ---------- Mic permission ----------

const micGrantBtn = document.getElementById("mic-grant-btn");
const micStatus = document.getElementById("mic-status");

async function checkMicStatus() {
  const { micEnabled } = await chrome.storage.local.get("micEnabled");
  if (micEnabled) {
    micStatus.textContent = "Granted";
    micStatus.style.color = "#00b8a3";
    micGrantBtn.textContent = "Re-enable Microphone";
  } else {
    micStatus.textContent = "Not granted";
    micStatus.style.color = "#888";
  }
}

micGrantBtn.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    await chrome.storage.local.set({ micEnabled: true });
    micStatus.textContent = "Granted";
    micStatus.style.color = "#00b8a3";
    micGrantBtn.textContent = "Re-enable Microphone";
  } catch (err) {
    micStatus.textContent = "Denied — check your browser/OS microphone settings";
    micStatus.style.color = "#ff375f";
  }
});

checkMicStatus();
loadSettings();
