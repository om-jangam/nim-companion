'use strict';
/*
 * The agent runtime.
 *
 * Takes a plan that has already been through the validator and walks it:
 * picking steps whose dependencies are met, calling the tool, checking what
 * actually happened, and emitting a snapshot and an event after every single
 * transition.
 *
 * Three rules shape everything here:
 *
 *   1. The snapshot is derived from real step state, never from a guess. There
 *      is no "progress" counter to drift out of sync - it is counted from the
 *      steps themselves every time it is asked for. Nothing can show a number
 *      the runtime has not actually reached.
 *
 *   2. Risk is the runtime's to decide, never the plan's. Each step's risk is
 *      the tool's own level, raised by what the tool says about these exact
 *      arguments, worked out again right before it runs (a file that did not
 *      exist when the plan was made may exist by then). Anything at or above
 *      APPROVE_AT waits for a yes recorded against that specific step. The gate
 *      is here, not in the interface, so it holds even with every window shut.
 *
 *   3. Done means checked. A tool that can look at its own effect gets the last
 *      word: returning from run() is not the same as having worked. A failed
 *      check is a failed step - retried once, then reported, never glossed over.
 */
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const planner = require('./planner');
const tools = require('./tools');

const RISK_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };

/* Anything at or above this level stops and asks. Lowering it to 'high' would
 * let moving and renaming files through unasked; raising it would let worse
 * through. 'medium' is the setting that matches what people expect. */
const APPROVE_AT = 'medium';

const MAX_ATTEMPTS = 2;          // bounded: one try, one retry, then it reports
const DEFAULT_TIMEOUT = 30000;

const AUDIT = process.env.NIM_AUDIT_FILE || path.join(__dirname, '..', '..', 'logs', 'audit.log');

/* Every decision that touched the computer, in the order it happened. Append
 * only. It records which tool ran, at what risk, whether you approved it and
 * whether it verified - and never the arguments, the goal text or the output.
 * Those can hold anything from a password you dictated to the contents of a
 * file it read, and a log is the last place either belongs. */
function audit(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
    const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry));
    fs.appendFileSync(AUDIT, line + '\n');
  } catch { /* a log that cannot be written must not stop the work */ }
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(what + ' took longer than ' + Math.round(ms / 1000) + 's')), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

function higher(a, b) { return (RISK_ORDER[b] || 0) > (RISK_ORDER[a] || 0) ? b : a; }

function label(fn, ...args) {
  if (typeof fn !== 'function') return null;
  try { const s = fn(...args); return s ? String(s).slice(0, 120) : null; } catch { return null; }
}

const IDLE = {
  status: 'idle', goal: null, title: null, steps: [], currentStepId: null,
  pendingApproval: null, result: null, error: null,
  startedAt: null, finishedAt: null
};

class Agent extends EventEmitter {
  constructor() {
    super();
    this.reset();
    this.ctx = { say: async () => {} };
  }

  reset() {
    this.status = 'idle';
    this.goal = null;
    this.title = null;
    this.steps = [];
    this.currentStepId = null;
    this.result = null;
    this.error = null;
    this.startedAt = null;
    this.finishedAt = null;
    this.lastData = null;
    this.outputs = {};
    this.lastLabel = null;
    this._cancelled = false;
    this._pauseGate = null;
    this._approvalGate = null;
  }

  /** Everything the interface is allowed to know, counted fresh each time. */
  snapshot() {
    const done = this.steps.filter((s) => s.status === 'done').length;
    const failed = this.steps.filter((s) => s.status === 'failed').length;
    const awaiting = this.steps.find((s) => s.status === 'awaiting-approval') || null;

    return {
      status: this.status,
      goal: this.goal,
      title: this.title,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      currentStepId: this.currentStepId,
      result: this.result,
      error: this.error,
      progress: { done: done, failed: failed, total: this.steps.length },
      pendingApproval: awaiting
        ? { stepId: awaiting.id, title: awaiting.title, question: awaiting.question, tool: awaiting.tool, risk: awaiting.risk }
        : null,
      steps: this.steps.map((s) => ({
        id: s.id,
        title: s.title,
        tool: s.tool,
        status: s.status,
        risk: s.risk,
        sensitive: s.sensitive,
        verified: s.verified,
        verifyNote: s.verifyNote || null,
        summary: s.summary || null,
        doneLabel: s.doneLabel || null,
        error: s.error || null,
        attempts: s.attempts
      }))
    };
  }

  emitUpdate() {
    this.emit('update', this.snapshot());
  }

  setStatus(status) {
    this.status = status;
    this.emitUpdate();
  }

  /* ---- running ----------------------------------------------------------- */

  /** Plan from the goal with the offline planner, then run it. */
  async start(goal, ctx) {
    return this._begin(goal, ctx, null);
  }

  /**
   * Run a plan that was already made - by the brain, and already through the
   * validator. The runtime still does its own checks while running: the risk,
   * the approval gate, timeouts and verification do not trust the plan either.
   */
  async startPlan(goal, plan, ctx) {
    return this._begin(goal, ctx, plan);
  }

  async _begin(goal, ctx, given) {
    if (this.isBusy()) throw new Error('already working on something');
    if (ctx) this.ctx = Object.assign({}, this.ctx, ctx);

    this.reset();
    this.goal = String(goal || '').trim();
    this.startedAt = Date.now();
    this.runId = this.startedAt.toString(36);
    // "{{last}}" means what was last produced before this request, fixed now
    this.lastAtStart = this.ctx.context && this.ctx.context.last ? this.ctx.context.last.text : null;
    audit({ run: this.runId, event: 'started' });
    this.setStatus('planning');

    let plan = given;
    if (!plan) {
      try {
        plan = await planner.plan(this.goal, Object.assign({ tools: tools.list() }, this.ctx));
      } catch (err) {
        return this.fail('I could not work out a plan: ' + err.message);
      }
    }

    this.title = plan.title || plan.goal || this.goal;
    this.steps = plan.steps.map((s) => {
      const tool = tools.byName(s.tool);
      const risk = tool ? higher(s.risk && RISK_ORDER[s.risk] !== undefined ? s.risk : 'low', tools.riskOf(tool, s.args)) : 'low';
      return {
        id: s.id,
        title: s.title || (tool ? tool.title : s.tool),
        tool: s.tool,
        args: s.args,
        dependsOn: s.dependsOn,
        risk: tool ? higher(tool.risk, risk) : 'low',
        sensitive: needsApproval(tool ? higher(tool.risk, risk) : 'low'),
        verifiable: !!(tool && typeof tool.verify === 'function'),
        status: 'pending',
        summary: null,
        error: null,
        verified: null,          // true, false, or null for "cannot be checked"
        verifyNote: null,
        doneLabel: null,
        question: null,
        attempts: 0,
        approved: false
      };
    });

    if (!this.steps.length) {
      return this.fail('I could not turn that into anything I know how to do.');
    }

    this.emitUpdate();
    this._loop();              // deliberately not awaited: start() returns at once
    return this.snapshot();
  }

  isBusy() {
    return ['planning', 'working', 'waiting-approval', 'paused'].includes(this.status);
  }

  async _loop() {
    try {
      for (;;) {
        if (this._cancelled) return this.finish('cancelled');

        if (this.status === 'paused') {
          await this._pauseGate.promise;
          if (this._cancelled) return this.finish('cancelled');
        }

        const step = this._nextReady();
        if (!step) break;

        const ok = await this._execute(step);
        if (!ok) return;                      // failed, cancelled, or still paused
      }

      const anyFailed = this.steps.some((s) => s.status === 'failed');
      if (anyFailed) return;                  // fail() has already reported it

      this.result = this.steps
        .filter((s) => s.summary)
        .map((s) => s.summary)
        .join('\n');
      this.finish('completed');
    } catch (err) {
      this.fail(err && err.message ? err.message : String(err));
    }
  }

  /** The first pending step whose dependencies have all finished successfully. */
  _nextReady() {
    return this.steps.find((s) => {
      if (s.status !== 'pending') return false;
      return (s.dependsOn || []).every((id) => {
        const dep = this.steps.find((d) => d.id === id);
        return dep && dep.status === 'done';
      });
    }) || null;
  }

  async _execute(step) {
    const tool = tools.byName(step.tool);
    if (!tool) {
      step.status = 'failed';
      step.error = 'no such tool: ' + step.tool;
      this.fail(step.error);
      return false;
    }

    // fill in anything this step takes from earlier ones: {{s1}} becomes what
    // step s1 actually produced, {{last}} what the last request produced. The
    // validator has already made sure every reference points somewhere real.
    const args = resolveRefs(step.args, this.outputs, this.lastAtStart);
    const uses = refersBack(step.args);

    // the risk, worked out again now, against the arguments as they really are
    step.risk = higher(step.risk, tools.riskOf(tool, args));
    step.sensitive = needsApproval(step.risk);

    // The approval gate. A step at or above the approval threshold cannot
    // proceed without an explicit yes recorded against it, and the runtime
    // simply waits here until it has one.
    if (step.sensitive && !step.approved) {
      step.status = 'awaiting-approval';
      step.question = label(tool.confirm, args) || (step.title + '?');
      this.currentStepId = step.id;
      this._approvalGate = makeGate();
      this.setStatus('waiting-approval');
      this.emit('event', 'confirmation_required', { stepId: step.id, title: step.title, question: step.question, risk: step.risk, tool: step.tool });

      const granted = await this._approvalGate.promise;
      this._approvalGate = null;
      this.emit('event', 'confirmation_resolved', { stepId: step.id, granted: !!granted });

      if (this._cancelled) { this.finish('cancelled'); return false; }
      audit({ run: this.runId, step: step.id, tool: step.tool, risk: step.risk,
              event: granted ? 'approved' : 'declined' });

      if (!granted) {
        step.status = 'skipped';
        step.error = 'you did not approve this';
        this.setStatus('working');
        return true;                           // declining one step is not a failure
      }
      step.approved = true;
    }

    step.status = 'running';
    this.currentStepId = step.id;
    this.setStatus('working');
    this.emit('event', 'tool_started', { stepId: step.id, tool: step.tool, title: step.title, label: label(tool.doing, args), uses });

    // what this one step may report back while it works
    const stepCtx = Object.assign({}, this.ctx, {
      progress: (fraction, text) => this.emit('event', 'tool_progress', {
        stepId: step.id, tool: step.tool, fraction: Number(fraction) || 0, label: text ? String(text).slice(0, 80) : undefined
      })
    });

    try {
      // observe first, where the tool knows how - so that afterwards it can tell
      // the difference between what it did and what was already there
      let seenBefore = null;
      if (typeof tool.before === 'function') {
        try {
          seenBefore = await withTimeout(Promise.resolve(tool.before(args, stepCtx)), 10000, 'looking first');
        } catch { seenBefore = null; }
      }

      // act, under a deadline so a wedged tool cannot hold the whole run
      const out = await withTimeout(
        Promise.resolve(tool.run(args, stepCtx, seenBefore)),
        tool.timeout || DEFAULT_TIMEOUT,
        step.title
      );

      step.summary = (out && out.summary) || 'done';
      if (out && out.data !== undefined) this.lastData = out.data;
      this.outputs[step.id] = out && typeof out.data === 'string' ? out.data
        : (out && out.data && typeof out.data.text === 'string' && out.data.text ? out.data.text
          : (out && out.data !== undefined ? JSON.stringify(out.data) : step.summary));

      /* Then verify. Returning from run() is not the same as having worked, and
       * a step that cannot be checked is recorded as unverified, not proven. */
      if (typeof tool.verify === 'function') {
        this.emit('event', 'verification_started', { stepId: step.id, tool: step.tool });
        const check = await withTimeout(
          Promise.resolve(tool.verify(args, out, stepCtx, seenBefore)),
          20000, 'checking "' + step.title + '"'
        );
        step.verified = !!(check && check.ok);
        step.verifyNote = (check && check.note) || null;
        this.emit('event', 'verification_completed', { stepId: step.id, tool: step.tool, ok: step.verified });
        if (!step.verified) throw new Error('it did not take effect: ' + (step.verifyNote || 'unknown'));
      } else {
        step.verified = null;
      }

      step.status = 'done';
      step.doneLabel = label(tool.done, args, out);
      if (step.doneLabel) this.lastLabel = step.doneLabel;
      audit({ run: this.runId, step: step.id, tool: step.tool, risk: step.risk,
              event: 'done', verified: step.verified });

      // what "it", "that" and "there" mean from now on
      if (typeof tool.remember === 'function' && typeof this.ctx.remember === 'function') {
        try { this.ctx.remember(tool.remember(args, out) || {}); } catch { /* context is a convenience */ }
      }

      this.emit('event', 'tool_completed', { stepId: step.id, tool: step.tool, verified: step.verified, label: step.doneLabel });
      this.emitUpdate();
      return true;
    } catch (err) {
      step.attempts += 1;
      step.error = err && err.message ? err.message : String(err);
      audit({ run: this.runId, step: step.id, tool: step.tool, risk: step.risk,
              event: 'failed', attempt: step.attempts });

      // bounded: one retry, because most failures here are a window not ready
      // yet; but a refusal (a rule said no) is not something trying again fixes
      if (step.attempts < MAX_ATTEMPTS && !isRefusal(step.error)) {
        step.status = 'pending';
        step.verified = null;
        this.emitUpdate();
        return true;
      }

      step.status = 'failed';
      this.emit('event', 'tool_failed', { stepId: step.id, tool: step.tool });
      this.fail(step.attempts > 1
        ? '"' + step.title + '" failed after ' + step.attempts + ' attempts: ' + step.error
        : step.error.charAt(0).toUpperCase() + step.error.slice(1) + '.');
      return false;
    }
  }

  /* ---- control ----------------------------------------------------------- */

  pause() {
    if (!['working', 'planning'].includes(this.status)) return this.snapshot();
    this._pauseGate = makeGate();
    this.setStatus('paused');
    return this.snapshot();
  }

  resume() {
    if (this.status !== 'paused') return this.snapshot();
    this.setStatus('working');
    if (this._pauseGate) { this._pauseGate.resolve(); this._pauseGate = null; }
    return this.snapshot();
  }

  cancel() {
    if (!this.isBusy()) return this.snapshot();
    this._cancelled = true;
    if (this._pauseGate) { this._pauseGate.resolve(); this._pauseGate = null; }
    if (this._approvalGate) { this._approvalGate.resolve(false); this._approvalGate = null; }
    else this.finish('cancelled');
    return this.snapshot();
  }

  approve(stepId, granted) {
    const step = this.steps.find((s) => s.id === stepId);
    if (!step || step.status !== 'awaiting-approval') return this.snapshot();
    if (this._approvalGate) {
      const gate = this._approvalGate;
      this._approvalGate = null;
      gate.resolve(!!granted);
    }
    return this.snapshot();
  }

  /** Put a failed run back on its feet from the step that broke. */
  retry() {
    if (!['error'].includes(this.status)) return this.snapshot();
    const failed = this.steps.find((s) => s.status === 'failed');
    if (!failed) return this.snapshot();

    failed.status = 'pending';
    failed.attempts = 0;
    failed.error = null;
    this.error = null;
    this.finishedAt = null;
    this._cancelled = false;
    this.setStatus('working');
    this._loop();
    return this.snapshot();
  }

  /* ---- endings ----------------------------------------------------------- */

  finish(status) {
    this.status = status;
    this.currentStepId = null;
    this.finishedAt = Date.now();
    this.emitUpdate();
    if (status === 'completed') this.emit('event', 'task_completed', { title: this.title, label: this.lastLabel || 'Done' });
    if (status === 'cancelled') this.emit('event', 'task_cancelled', {});
    return this.snapshot();
  }

  fail(message) {
    this.error = message;
    this.status = 'error';
    this.currentStepId = null;
    this.finishedAt = Date.now();
    this.emitUpdate();
    this.emit('event', 'error', { message });
    return this.snapshot();
  }

  /** Back to just being a creature on your desktop. */
  clear() {
    if (this.isBusy()) this.cancel();
    this.reset();
    this.emitUpdate();
    return this.snapshot();
  }
}

/* Swap {{s1}} for what step s1 produced and {{last}} for the last result, in
 * every string argument. Capped, so one huge page cannot balloon every step
 * after it. */
const REF = /\{\{\s*([\w-]+)\s*\}\}/g;
function resolveRefs(args, outputs, last) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    out[k] = typeof v === 'string'
      ? v.replace(REF, (_, id) => String(id === 'last' ? (last == null ? '' : last) : (outputs[id] == null ? '' : outputs[id])).slice(0, 40000))
      : v;
  }
  return out;
}

function refersBack(args) {
  return Object.values(args || {}).some((v) => typeof v === 'string' && /\{\{\s*[\w-]+\s*\}\}/.test(v));
}

/* Errors that come from a rule, not from bad luck. */
function isRefusal(message) {
  return /outside your home folder|not one of your listed projects|never open|leave it alone|reserved by Windows|settings folder|belongs to Windows|will not|could not find an app|is not there|is not open|not a folder|already/i.test(String(message));
}

/** Whether a step at this risk has to wait for the user's yes. */
function needsApproval(riskOrTool) {
  const risk = typeof riskOrTool === 'string' ? riskOrTool : (riskOrTool && riskOrTool.risk);
  if (!risk) return false;
  return (RISK_ORDER[risk] || 0) >= RISK_ORDER[APPROVE_AT];
}

function makeGate() {
  const gate = {};
  gate.promise = new Promise((resolve) => { gate.resolve = resolve; });
  return gate;
}

module.exports = new Agent();
module.exports.Agent = Agent;
module.exports.IDLE = IDLE;
module.exports.needsApproval = needsApproval;
module.exports.RISK_ORDER = RISK_ORDER;
module.exports.APPROVE_AT = APPROVE_AT;
module.exports.AUDIT_PATH = AUDIT;
module.exports.resolveRefs = resolveRefs;
