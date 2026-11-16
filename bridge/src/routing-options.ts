/** Collapse whitespace and truncate a label for text-only channels. */
export const menuLine = (text: string, limit = 80) => {
  const normalized = text.replaceAll(/[\s\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, " ").trim();
  return normalized.length > limit ? normalized.slice(0, Math.max(0, limit - 1)) + "\u2026" : normalized;
};
