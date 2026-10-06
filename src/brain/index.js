'use strict';
/*
 * Nim's brain: understanding what was said, on this computer.
 *
 *   think(text, ctx) -> { source, plan, tried, fallback, ms }
 *
 * Two minds, both local, both free:
 *
 *   1. The rules, when they are sure. "Volume down", "open Brave", "take a
 *      screenshot" are answered instantly and identically every time; sending
 *      them to a model would be slower and no better.
 *   2. Qwen, running in Ollama, for everything else - questions, requests the
 *      rules have no pattern for, "that" and "it", anything that takes several
 *      steps. It only proposes: its plan goes through the validator, and a plan
 *      that fails is sent back once with the reasons, then refused.
 *
 * If Qwen is not running, the rules anyway - exactly how Nim behaved before
 * it had a model, so losing the GPU degrades it rather than breaking it.
 *
 * Nothing here calls a paid service or leaves the machine. A new local model
 * is a new file in providers/ with available() and plan(); nothing downstream -
 * the validator, the runtime, the tools, the interface - changes.
 */
const validator = require('../agent/validator');
const memory = require('../memory/store');

const PROVIDERS = {
  rules: require('./providers/rules'),
  ollama: require('./providers/ollama')
};

const TIMEOUT = { ollama: 90000 };

/* Plans that are safe but not good enough. Kept apart from the validator on
 * purpose: the validator is the security boundary and stays about safety;
 * this is about whether the plan actually does what was asked.
 *
 * The one it catches is the commonest small-model failure: asked to write
 * ideas or a list, it writes "Idea 1, Idea 2, Idea 3" instead. */
/* A reply that says something is being done, with nothing that does it:
 * "Closing Spotify..." and no step. Nim must never pretend. */
const CLAIMS_ACTION = /^(?:(?:ok(?:ay)?|sure|alright|done)[,!.]?\s*)?(?:closing|opening|launching|starting|playing|pausing|searching|setting|turning|muting|taking|creating|deleting|saving|sending|i(?:'ve| have| just)?\s+(?:opened|closed|launched|started|played|paused|set|turned|muted|taken|created|deleted|saved|sent))\b(?!\s+(?:hours|times|ceremony|night|line|point|soon)\b)/i;

function qualityIssues(plan) {
  const issues = [];
  if (plan.reply && !plan.steps.length && CLAIMS_ACTION.test(String(plan.reply).trim())) {
    issues.push('the reply says an action is being done but the plan has no steps - use the tool that does it, or say you cannot');
  }
  for (const s of plan.steps) {
    const content = ['files.write', 'notes.add', 'clipboard.write'].includes(s.tool) ? String(s.args.content || s.args.text || '') : '';
    if (!content || /\{\{/.test(content)) continue;
    const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const placeholder = lines.length > 0 && lines.every((l) =>
      /^\W*(?:idea|item|point|thing|option|example|task|entry|line|name|tip|step)\s*#?\d+\W*$/i.test(l));
    if (placeholder || /lorem ipsum/i.test(content)) {
      issues.push('the content of step ' + s.id + ' is placeholder text; use text.compose to write the real content first, then use "{{' + 's1' + '}}"');
    }
  }
  return issues;
}

/* Replies are spoken, and a voice reading out "backtick backtick backtick css"
 * is worse than useless. Code, markdown and lists are flattened into sentences
 * a person would actually say, and long answers are cut at a sentence. */
function speakable(plan) {
  if (!plan.reply) return plan;
  let r = plan.reply
    .replace(/```[\s\S]*?```/g, ' ')            // code blocks: not speakable
    .replace(/`([^`]+)`/g, '$1')                // inline code: keep the words
    .replace(/\*\*|__|\*|#+\s*/g, '')           // emphasis and headings
    .replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s+/gm, '') // list markers ("- ", "1. ", "2) ") - not "15 percent"
    .replace(/\s+/g, ' ')
    .trim();
  if (r.length > 420) {
    const cut = r.slice(0, 420);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    r = end > 120 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '...';
  }
  return Object.assign({}, plan, { reply: r || plan.reply });
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what + ' took too long')), ms); })
  ]).finally(() => clearTimeout(timer));
}

async function think(text, ctx) {
  ctx = ctx || {};
  const said = String(text || '').trim();
  const started = Date.now();
  const tried = [];
  // what is happening, for the event stream every surface draws from
  const tell = (type, data) => { try { if (ctx.onEvent) ctx.onEvent(type, data || {}); } catch { /* telling is not thinking */ } };

  function done(source, plan, extra) {
    memory.note('user', said);
    // a spoken reply is noted when it is said; a plan is noted here
    if (!plan.reply && plan.steps.length) memory.note('nim', '(did: ' + plan.steps.map((s) => s.tool).join(', ') + ')');
    return Object.assign({ source, plan, tried, fallback: false, ms: Date.now() - started }, extra || {});
  }

  if (!said) return done('none', { intent: 'answer', reply: '', goal: '', steps: [] });

  // 1. the rules, when they are sure
  const ruled = await PROVIDERS.rules.plan(said, ctx);
  const checked = validator.validate(ruled.plan, ctx);
  if (ruled.confident && checked.ok) return done('rules', checked.plan);

  // A request the rules understood perfectly but that breaks a rule - a path
  // outside your home folder, say - is refused here. Asking a model would only
  // produce the same plan with more words.
  if (ruled.confident && !checked.ok && !checked.errors.every((e) => /\{\{last\}\}/.test(e))) {
    return done('rules', {
      intent: 'refuse', goal: '', steps: [],
      reply: 'I cannot do that: ' + checked.errors[0].replace(/^step \d+: /, '') + '.'
    });
  }

  // 2. the local model
  const provider = PROVIDERS.ollama;
  let available = false;
  try { available = await provider.available(ctx); } catch { available = false; }
  if (!available) {
    tried.push('ollama: not available');
  } else {
    try {
      tell('provider', { provider: 'ollama' });
      let raw = await withTimeout(provider.plan(said, ctx), TIMEOUT.ollama, 'ollama');
      tell('validation_started', {});
      let v = validator.validate(raw, ctx);
      let problems = v.ok ? qualityIssues(v.plan) : v.errors;

      // One chance to repair. Small models miss a required argument now and
      // then, or cut a corner; shown exactly what was wrong, they usually fix
      // it. Once only - a model that cannot fix its plan the second time is
      // not going to on the fifth.
      if (problems.length) {
        tried.push('ollama: first plan sent back - ' + problems.slice(0, 2).join('; '));
        tell('validation_failed', { count: problems.length });
        const feedback = 'Your previous plan was rejected: ' + problems.slice(0, 3).join('; ') +
                         '. Return a corrected plan.';
        raw = await withTimeout(provider.plan(said, ctx, { feedback }), TIMEOUT.ollama, 'ollama');
        tell('validation_started', {});
        v = validator.validate(raw, ctx);
        problems = v.ok ? qualityIssues(v.plan) : v.errors;
      }

      if (v.ok && !problems.length) return done('ollama', speakable(v.plan));
      if (v.ok) tried.push('ollama: plan still not right - ' + problems[0]);
      else tried.push('ollama: plan rejected - ' + v.errors.slice(0, 2).join('; '));
    } catch (err) {
      tried.push('ollama: ' + (err.message || err));
    }
  }

  // 3. nothing better - the rules, unsure as they are. A request that only fell
  //    through to the catch-all is answered honestly rather than attempted.
  const onlyGuessing = checked.ok && checked.plan.steps.every((s) => s.tool === 'skill');
  if (checked.ok && !onlyGuessing) return done('rules', checked.plan, { fallback: true });
  return done('rules', {
    intent: 'answer', goal: '', steps: [],
    reply: !available
      ? 'I cannot do that one yet - my thinking model is not running, so I only know my basic commands.'
      : 'I could not work out how to do that one. Could you say it another way?'
  }, { fallback: true });
}

/** Which minds are available right now, for diagnostics. */
async function status(ctx) {
  const out = {};
  for (const [name, p] of Object.entries(PROVIDERS)) {
    try { out[name] = await p.available(ctx); } catch { out[name] = false; }
  }
  return out;
}

module.exports = { think, status, PROVIDERS, qualityIssues, speakable };
