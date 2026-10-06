'use strict';
/*
 * The plan validator: the line a model's output has to cross before anything
 * touches the computer.
 *
 * A language model proposes; it does not decide. Whatever produced a plan -
 * the offline rules or the local model - it lands here first, and nothing runs
 * unless every step passes:
 *
 *   - the tool exists in the registry, and is not switched off. A made-up tool
 *     is rejected, not guessed at.
 *   - the arguments match that tool's schema: required ones present, types
 *     right, enums respected, unknown ones dropped rather than smuggled through.
 *   - paths stay inside your own folders (no "..", no other drives, no links
 *     that lead out, no file:// addresses, no AppData, no key files); projects
 *     are ones you have listed; web addresses are http or https.
 *   - dependencies point at real steps, the graph has no cycles, and a step only
 *     uses the output of a step it waits for. "{{last}}" is only allowed when
 *     there is a last result to use.
 *   - the plan is a reasonable size.
 *
 * Risk is never taken from the model. A plan cannot mark its own file deletion
 * as low risk: the level comes from the registry (raised, for some tools, by
 * the exact arguments), and the runtime enforces the approval gate on that.
 *
 * Invalid plans are rejected whole. Running the good half of a confused plan is
 * how you get the wrong half of a task done.
 */
const tools = require('./tools');
const { safePath, projectRoot } = require('./tools/common');

const INTENTS = ['answer', 'command', 'multi_step_task', 'clarify', 'refuse'];
const MAX_STEPS = 12;
const LIMITS = { content: 100000, text: 4000, query: 500, question: 500, url: 2000, instruction: 2000, input: 100000, name: 200, when: 100 };
const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];

/* Which arguments are paths, and which of those default to Documents. */
const PATH_ARGS = ['file', 'dir', 'from', 'to', 'folder'];
const DOC_DEFAULT = new Set(['files.read', 'files.write', 'files.open', 'files.delete', 'files.rename']);

function checkArgs(tool, raw, ctx, where, errors) {
  const schema = tool.input || { properties: {}, required: [] };
  const props = schema.properties || {};
  const out = {};
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    errors.push(where + ': the arguments are not a set of named values');
  }

  for (const [key, spec] of Object.entries(props)) {
    let v = given[key];
    if (v === undefined || v === null || v === '') continue;

    if (spec.type === 'number') {
      // small models write "5" as often as 5
      const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.-]/g, ''));
      if (!Number.isFinite(n)) { errors.push(where + ': ' + key + ' must be a number'); continue; }
      v = n;
    } else if (spec.type === 'string') {
      if (typeof v === 'object') { errors.push(where + ': ' + key + ' must be text'); continue; }
      if (typeof v !== 'string') v = String(v);
      v = v.trim();
      if (LIMITS[key] && v.length > LIMITS[key]) {
        errors.push(where + ': ' + key + ' is too long');
        continue;
      }
    }
    if (spec.enum && !spec.enum.includes(String(v).toLowerCase())) {
      errors.push(where + ': ' + key + ' must be one of ' + spec.enum.join(', '));
      continue;
    }
    out[key] = spec.enum ? String(v).toLowerCase() : v;
  }

  for (const key of schema.required || []) {
    if (out[key] === undefined) errors.push(where + ': ' + tool.name + ' needs "' + key + '"');
  }

  // the checks that keep a plan inside the lines, done before anything runs
  for (const key of Object.keys(out)) {
    if (typeof out[key] !== 'string') continue;
    try {
      if (key === 'url' && !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(out.url)) throw new Error('only http and https addresses are allowed');
      if (PATH_ARGS.includes(key) && !/\{\{/.test(out[key])) {
        safePath(out[key], DOC_DEFAULT.has(tool.name) && key !== 'dir' ? { defaultDir: 'documents' } : null);
      }
    } catch (err) {
      errors.push(where + ': ' + err.message);
    }
  }
  try {
    if (tool.name.startsWith('project.') || tool.name === 'git.status') projectRoot(out.project, ctx);
  } catch (err) {
    errors.push(where + ': ' + err.message);
  }
  return out;
}

/** True if following dependsOn edges from any step comes back to it. */
function hasCycle(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map();                         // 1 visiting, 2 done
  function visit(id) {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const dep of (byId.get(id) || {}).dependsOn || []) if (visit(dep)) return true;
    state.set(id, 2);
    return false;
  }
  return steps.some((s) => visit(s.id));
}

/**
 * validate(plan, ctx) -> { ok, plan, errors, notes }
 * `plan` is what a planner proposed; the returned `plan` is the cleaned version
 * that is safe to hand to the runtime. `ctx` carries what the checks need:
 * listed projects, switched-off tools, and the conversation context.
 */
function validate(plan, ctx) {
  ctx = ctx || {};
  const errors = [];
  const notes = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, plan: null, errors: ['the plan is not an object'], notes };

  if (plan.intent !== undefined && !INTENTS.includes(plan.intent)) errors.push('"' + String(plan.intent).slice(0, 30) + '" is not an intent');
  const intent = INTENTS.includes(plan.intent) ? plan.intent
    : (Array.isArray(plan.steps) && plan.steps.length ? 'multi_step_task' : 'answer');
  if (plan.steps !== undefined && !Array.isArray(plan.steps)) errors.push('steps must be a list');
  const rawSteps = Array.isArray(plan.steps) ? plan.steps : [];

  if (['answer', 'clarify', 'refuse'].includes(intent)) {
    const reply = String(plan.reply || '').trim();
    if (!reply) errors.push('an ' + intent + ' needs something to say');
    if (rawSteps.length) notes.push('steps on an ' + intent + ' were dropped');
    return {
      ok: errors.length === 0,
      plan: { intent, reply, goal: String(plan.goal || '').trim(), steps: [] },
      errors, notes
    };
  }

  if (!rawSteps.length) errors.push('a task needs at least one step');
  if (rawSteps.length > MAX_STEPS) errors.push('too many steps (' + rawSteps.length + ', limit ' + MAX_STEPS + ')');

  const disabled = new Set((ctx.disabledTools || []).map(String));
  const hasLast = !!(ctx.context && ctx.context.last);
  const seen = new Set();
  const steps = rawSteps.slice(0, MAX_STEPS).map((raw, i) => {
    const where = 'step ' + (i + 1);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(where + ': is not a step');
      return { id: 's' + (i + 1), tool: '?', args: {}, dependsOn: [] };
    }
    const id = String(raw.id || 's' + (i + 1)).slice(0, 20);
    if (!/^[\w-]+$/.test(id)) errors.push(where + ': "' + id + '" is not a usable step id');
    if (id === 'last') errors.push(where + ': "last" is reserved');
    if (seen.has(id)) errors.push(where + ': duplicate id ' + id);
    seen.add(id);

    const tool = tools.byName(raw.tool);
    if (!tool) {
      errors.push(where + ': there is no tool called "' + String(raw.tool).slice(0, 40) + '"');
      return { id, tool: String(raw.tool), args: {}, dependsOn: [] };
    }
    if (disabled.has(tool.name)) {
      errors.push(where + ': ' + tool.name + ' is switched off on this computer');
    }

    const args = checkArgs(tool, raw.args, ctx, where, errors);
    // whatever the plan says about risk is ignored: the registry decides
    const risk = tools.riskOf(tool, args);
    if (raw.risk !== undefined) {
      if (!RISK_LEVELS.includes(raw.risk)) errors.push(where + ': "' + String(raw.risk).slice(0, 20) + '" is not a risk level');
      else if (RISK_LEVELS.indexOf(raw.risk) < RISK_LEVELS.indexOf(risk)) notes.push(where + ': the plan called ' + tool.name + ' ' + raw.risk + ' risk; it is ' + risk);
    }
    const deps = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(deps)) errors.push(where + ': dependsOn must be a list');
    return {
      id,
      tool: tool.name,
      title: tool.title + (tool.describe ? ' - ' + safeDescribe(tool, args) : ''),
      args,
      risk,
      dependsOn: Array.isArray(deps) ? deps.map(String) : []
    };
  });

  const ids = new Set(steps.map((s) => s.id));
  steps.forEach((s, i) => {
    for (const dep of s.dependsOn) {
      if (dep === s.id) errors.push('step ' + (i + 1) + ' depends on itself');
      else if (!ids.has(dep)) errors.push('step ' + (i + 1) + ' depends on a step that does not exist (' + dep + ')');
    }
  });
  if (hasCycle(steps)) errors.push('the steps depend on each other in a circle');

  // a step may only use the output of a step it waits for - otherwise it could
  // run before that output exists and silently use nothing; and "{{last}}" only
  // when there is something to refer back to
  steps.forEach((s, i) => {
    for (const v of Object.values(s.args)) {
      if (typeof v !== 'string') continue;
      for (const m of v.matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)) {
        if (m[1] === 'last') {
          if (!hasLast) errors.push('step ' + (i + 1) + ' uses {{last}} but there is no previous result to use');
        } else if (!s.dependsOn.includes(m[1])) {
          errors.push('step ' + (i + 1) + ' uses {{' + m[1] + '}} but does not depend on that step');
        }
      }
    }
  });

  return {
    ok: errors.length === 0,
    plan: { intent: steps.length === 1 ? 'command' : intent, goal: String(plan.goal || '').trim(), reply: '', steps },
    errors,
    notes
  };
}

function safeDescribe(tool, args) {
  try { return String(tool.describe(args) || ''); } catch { return ''; }
}

module.exports = { validate, INTENTS, MAX_STEPS };
