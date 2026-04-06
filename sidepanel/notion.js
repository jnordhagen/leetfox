// ---------- Constants ----------

export const DB_SCHEMA = {
  "Problem":         "title",
  "LC #":            "number",
  "Type":            "select",
  "Pattern":         "multi_select",
  "Difficulty":      "select",
  "Last Result":     "select",
  "Last Done":       "date",
  "Interval (days)": "number",
  "Times Reviewed":  "number",
  "Notes":           "rich_text",
};

export const RESULT_LABELS = {
  clean:  "Clean 🟢",
  hints:  "Hints 🟡",
  failed: "Failed 🔴",
};

// ---------- Notion API ----------

export async function validateNotionSchema(notionToken, notionDbId) {
  const { ok, data, error } = await chrome.runtime.sendMessage({
    type: "NOTION_VALIDATE",
    notionToken,
    notionDbId,
  });
  if (error) throw new Error(error);
  if (!ok) throw new Error(data?.message || `Notion API error`);
  const db = data;

  const errors = [];
  for (const [name, expectedType] of Object.entries(DB_SCHEMA)) {
    const prop = db.properties[name];
    if (!prop) {
      errors.push(`Missing property: "${name}" (expected type: ${expectedType})`);
    } else if (prop.type !== expectedType) {
      errors.push(`"${name}" has type "${prop.type}", expected "${expectedType}"`);
    }
  }
  return errors;
}

export function inferType(tags) {
  const designKeywords = ["design", "system", "architecture"];
  if ((tags || []).some((t) => designKeywords.some((k) => t.toLowerCase().includes(k)))) {
    return "System Design";
  }
  return "DSA";
}

// Throws on network or API error; returns the created page object on success.
export async function createNotionPage(payload, notionToken, notionDbId) {
  const { ok, data, error } = await chrome.runtime.sendMessage({
    type: "NOTION_CREATE_PAGE",
    notionToken,
    payload,
  });
  if (error) throw new Error(error);
  if (!ok) throw new Error(data?.message || `Notion error`);
  return data;
}
