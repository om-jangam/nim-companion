'use strict';
/*
 * Turning a goal into a plan, by rules.
 *
 * The planner's only job is to return a plan; it never executes anything. The
 * rule-based planner below works offline and instantly; the brain (src/brain)
 * uses it first and hands anything it is not sure about to the local model.
 * Either way the runtime is given the same shape, through the validator.
 *
 * A plan is:
 *   { title, steps: [ { id, title, tool, args, dependsOn: [ids] } ] }
 *
 * `dependsOn` is honoured by the runtime, so a real task graph works, not just
 * a straight list.
 */
const tools = require('./tools');

/* The verbs that start a new request inside one sentence. */
const VERBS = 'open|play|search|write|save|create|make|read|list|wait|say|go|visit|fetch|download|launch|start|tell|' +
  'remember|check|run|take|set|turn|mute|unmute|lock|find|organi[sz]e|tidy|move|copy|rename|delete|close|switch|' +
  'remind|note|summari[sz]e|show|put|send|restart|shut';

/* Goals arrive as one sentence. People join tasks with "and then", "then",
 * "after that", a semicolon, a plain "and", or - especially once Whisper has
 * punctuated what they said - just a comma before the next verb. */
const SEAMS = new RegExp('\\s*(?:,?\\s*(?:and\\s+then|then|after\\s+that|afterwards|next)\\s+|;\\s*|,?\\s+and\\s+(?=(?:' +
  VERBS + ')\\b)|,\\s*(?=(?:' + VERBS + ')\\b)|\\.\\s+(?=[A-Z]))\\s*', 'i');

/* Some pairs of clauses are one action, and splitting them changes the meaning.
 * "Open YouTube and search for X" means search YouTube - not open YouTube's
 * homepage and then go and search Google. "Open Brave and search for X" means
 * the search happens in Brave. These are rewritten into one clause before the
 * sentence is split. */
const BROWSER = '(brave|chrome|google chrome|edge|microsoft edge|firefox)';
const ONE_ACTION = [
  [/\bopen\s+youtube\s*,?\s*(?:and\s+)?(?:then\s+)?search\s+(?:it\s+|on\s+it\s+)?(?:for\s+)?/i, 'search youtube for '],
  [/\bgo\s+to\s+youtube\s*,?\s*(?:and\s+)?(?:then\s+)?search\s+(?:for\s+)?/i, 'search youtube for '],
  [new RegExp('\\b(?:open|launch|start)\\s+' + BROWSER + '\\s*,?\\s*(?:and\\s+)?(?:then\\s+)?(?:search|google|look up)\\s+(?:for\\s+)?', 'i'), 'search in $1 for '],
  [new RegExp('\\b(?:open|launch|start)\\s+' + BROWSER + '\\s*,?\\s*(?:and\\s+)?(?:then\\s+)?(?:go\\s+to|open|visit)\\s+', 'i'), 'open in $1 '],
  [/\bopen\s+spotify\s*,?\s*(?:and\s+)?(?:then\s+)?play\s+(.+?)(\s*(?:,|\band\b|\bthen\b|$))/i, 'play $1 on spotify$2']
];

/* "open in brave github.com" back into "open github.com in brave". */
function tidy(clause) {
  const m = new RegExp('^open in ' + BROWSER + ' (.+)$', 'i').exec(clause);
  return m ? 'open ' + m[2] + ' in ' + m[1] : clause;
}

function splitGoal(goal) {
  let text = String(goal || '').trim().replace(/[.!?]+$/, '');
  for (const [pattern, replacement] of ONE_ACTION) text = text.replace(pattern, replacement);
  return text
    .split(SEAMS)
    .map((s) => tidy(s.trim().replace(/[,.]+$/, '').replace(/^(?:please|could you|can you|would you|nim)\s+/i, '').replace(/^(?:please\s+)/i, '')))
    .filter(Boolean);
}

/** The planner used when nothing better is plugged in. No model, no network. */
function rulePlanner(goal, ctx) {
  const clauses = splitGoal(goal);
  const steps = [];
  let unmatched = 0;

  clauses.forEach((clause, i) => {
    const found = tools.findFor(clause, ctx);
    if (!found) { unmatched++; return; }
    const { tool, args } = found;
    steps.push({
      id: 's' + (i + 1),
      title: tool.title + (tool.describe ? ' - ' + tool.describe(args) : ''),
      tool: tool.name,
      args: args,
      // a straight list is a graph where each step waits for the one before it
      dependsOn: steps.length ? [steps[steps.length - 1].id] : []
    });
  });

  return {
    title: clauses.length > 1 ? clauses.length + ' things' : (clauses[0] || goal),
    steps: steps,
    unmatched
  };
}

let current = rulePlanner;

/**
 * Replace the planner. The replacement takes (goal, ctx) and returns a plan,
 * or a promise of one.
 */
function use(fn) {
  current = typeof fn === 'function' ? fn : rulePlanner;
  return current;
}

function useDefault() {
  current = rulePlanner;
}

async function plan(goal, ctx) {
  const result = await current(goal, ctx || {});
  const steps = (result && result.steps) || [];

  // Whatever produced this, the runtime is handed something well formed.
  return {
    title: (result && result.title) || goal,
    steps: steps.map((s, i) => ({
      id: s.id || 's' + (i + 1),
      title: s.title || s.tool || 'step ' + (i + 1),
      tool: s.tool,
      args: s.args || {},
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : []
    }))
  };
}

module.exports = { plan, use, useDefault, rulePlanner, splitGoal, name: () => current.name || 'custom' };
