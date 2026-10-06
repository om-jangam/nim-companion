'use strict';
/*
 * The clipboard helper: copy a paragraph and Nim offers to summarize it,
 * translate it or fix its grammar.
 *
 * Only prose is offered on - a few sentences, mostly words. Anything that
 * could be a password, a key, a code or a single link is left alone: never
 * looked at further, never offered, never kept. What is offered on is held in
 * memory only for the few seconds the offer stands, and never logged.
 */

function looksSecret(t) {
  const s = t.trim();
  if (/\b(password|passcode|otp|one[- ]time|pin|api[_ -]?key|secret|token|cvv|private key)\b/i.test(s)) return true;
  if (/-----BEGIN [A-Z ]+-----/.test(s)) return true;
  // one long run of letters, digits and symbols with no spaces: a key or a code
  if (!/\s/.test(s) && s.length >= 12) return true;
  // card numbers and long digit runs
  if (/\b\d[\d -]{11,}\d\b/.test(s)) return true;
  return false;
}

/* Is this worth offering on? Prose of a decent length, not a secret, not code. */
function worthOffering(text) {
  const t = String(text || '').trim();
  if (t.length < 80 || t.length > 12000) return false;
  if (looksSecret(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 12) return false;
  if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return false;
  // mostly letters (any script) - not code, not a table of numbers
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (letters / t.length < 0.55) return false;
  const codey = (t.match(/[{};=<>()[\]$]/g) || []).length;
  if (codey / t.length > 0.04) return false;
  return true;
}

/* The fixed plans, one per button. The copied text is only ever the material
 * a step works on - never a request: nothing in it can choose what Nim does. */
const ACTIONS = {
  summarize: {
    label: 'Summarize what I copied',
    steps: (text) => [
      { id: 's1', tool: 'text.compose', args: { task: 'summarize', instruction: 'Summarize this in three short bullet points.', input: text } }
    ]
  },
  translate: {
    label: 'Translate what I copied',
    steps: (text) => [
      { id: 's1', tool: 'text.compose', args: { task: 'transform', instruction: 'Translate this into English. If it is already English, translate it into Hindi. Give only the translation.', input: text } },
      { id: 's2', tool: 'clipboard.write', args: { text: '{{s1}}' }, dependsOn: ['s1'] }
    ]
  },
  fix: {
    label: 'Fix the grammar of what I copied',
    steps: (text) => [
      { id: 's1', tool: 'text.compose', args: { task: 'transform', instruction: 'Correct the spelling and grammar. Keep the meaning, tone and language. Give only the corrected text.', input: text } },
      { id: 's2', tool: 'clipboard.write', args: { text: '{{s1}}' }, dependsOn: ['s1'] }
    ]
  }
};

function planFor(action, text) {
  const a = ACTIONS[action];
  if (!a) return null;
  return { intent: 'multi_step_task', goal: a.label, reply: '', steps: a.steps(String(text)) };
}

module.exports = { worthOffering, looksSecret, planFor, ACTIONS };
