/**
 * Cheap local filter that decides whether a message is worth sending to the AI classifier.
 * Goal: skip obvious chatter ("thanks!", "lol", emoji, bare links) to keep cost down,
 * while never skipping anything that looks like a problem, a question, or abuse.
 */

const SIGNAL_WORDS = [
  "help", "urgent", "asap", "emergency", "error", "issue", "problem", "bug", "broken", "not working",
  "doesn't work", "does not work", "can't", "cannot", "cant", "unable", "stuck", "locked out", "login",
  "password", "access", "deadline", "due", "extension", "grade", "submit", "submission", "missing",
  "wrong", "confused", "unclear", "refund", "complain", "report", "harass", "threat", "hate", "kill",
  "stupid", "idiot", "shut up",
];

const EMOJI_OR_PUNCT_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\p{P}\p{S}\s]+$/u;
const URL_ONLY = /^(<?https?:\/\/\S+>?\s*)+$/i;
const CUSTOM_EMOJI = /<a?:\w+:\d+>/g;

export function shouldClassify(content: string, minChars: number): boolean {
  const text = content.replace(CUSTOM_EMOJI, "").trim();
  if (!text) return false;
  if (EMOJI_OR_PUNCT_ONLY.test(text) || URL_ONLY.test(text)) return false;

  const lower = text.toLowerCase();
  if (text.includes("?")) return true;
  if (SIGNAL_WORDS.some((w) => lower.includes(w))) return true;
  // Mostly-caps shouting often signals frustration or abuse.
  const letters = text.replace(/[^a-z]/gi, "");
  if (letters.length >= 8 && letters === letters.toUpperCase()) return true;

  return text.length >= minChars;
}
