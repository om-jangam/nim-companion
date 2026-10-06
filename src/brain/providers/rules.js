'use strict';
/*
 * The offline planner: pattern rules, no model at all.
 *
 * It is instant and it is deterministic, which is exactly what you want for
 * "volume down" or "open Brave" - running a language model for those is slower
 * and no more correct. What it cannot do is understand anything it has no
 * pattern for, so it reports its own confidence. Confident means every part
 * of the request landed on a specific tool, or on a built-in skill that really
 * exists; a request with any part left over, or that only fell through to the
 * catch-all, is not confident, and the brain hands it to the local model.
 */
const planner = require('../../agent/planner');
const skills = require('../skills');

const name = 'rules';

async function available() { return true; }

async function plan(text, ctx) {
  const raw = await planner.rulePlanner(text, ctx);
  const steps = raw.steps || [];

  const confident = steps.length > 0 && !raw.unmatched && steps.every((s) =>
    s.tool !== 'skill' || !!skills.match(s.args && s.args.text));

  return {
    confident,
    plan: {
      intent: steps.length > 1 ? 'multi_step_task' : 'command',
      reply: '',
      goal: raw.title || text,
      steps: steps.map((s) => ({ id: s.id, tool: s.tool, args: s.args, dependsOn: s.dependsOn }))
    }
  };
}

module.exports = { name, available, plan };
