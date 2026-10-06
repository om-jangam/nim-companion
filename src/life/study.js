'use strict';
/*
 * Study buddy: Nim reads something - what you copied, the last thing it read
 * or wrote, a page, a file - and quizzes you on it, one question at a time.
 *
 * The questions are written by Qwen on this computer, held to a fixed shape
 * by a JSON schema, and checked again here: a question needs four different
 * options and an answer among them, or it is dropped.
 */

const { noThinking } = require('../brain/thinking');
const HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

const SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array', minItems: 3, maxItems: 5,
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 4 },
          answer: { type: 'integer', minimum: 0, maximum: 3 },
          why: { type: 'string' }
        },
        required: ['question', 'options', 'answer', 'why']
      }
    }
  },
  required: ['questions']
};

/* Keeps only questions that are whole and make sense. */
function cleanQuiz(raw) {
  const list = raw && Array.isArray(raw.questions) ? raw.questions : [];
  return list.map((q) => ({
    question: String(q && q.question || '').trim().slice(0, 240),
    options: Array.isArray(q && q.options) ? q.options.map((o) => String(o || '').trim().slice(0, 120)) : [],
    answer: Number(q && q.answer),
    why: String(q && q.why || '').trim().slice(0, 240)
  })).filter((q) => q.question && q.options.length === 4 && q.options.every(Boolean) &&
    new Set(q.options.map((o) => o.toLowerCase())).size === 4 &&
    Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4).slice(0, 5);
}

async function makeQuiz(material, opts) {
  opts = opts || {};
  const text = String(material || '').trim();
  if (text.length < 120) throw new Error('there is not enough there to quiz you on');
  const res = await (opts.fetch || fetch)(HOST + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(opts.timeoutMs || 120000),
    body: JSON.stringify(Object.assign({
      model: opts.model || 'qwen2.5:3b',
      stream: false,
      keep_alive: '20m',
      format: SCHEMA,
      options: { temperature: 0.3, num_ctx: 8192, num_predict: 900 },
      messages: [
        { role: 'system', content: 'You write short multiple-choice quizzes that test understanding of the material given. ' +
          'Each question has exactly four different options and one correct answer (its index 0-3), and a one-sentence why. ' +
          'Use only facts from the material. Reply with JSON only.' },
        { role: 'user', content: 'Material:\n' + text.slice(0, 6000) + '\n\nWrite 5 questions.' }
      ]
    }, noThinking(opts.model || 'qwen2.5:3b')))
  });
  if (!res.ok) throw new Error('my thinking model did not answer');
  const body = await res.json();
  let raw = null;
  try { raw = JSON.parse(body && body.message && body.message.content); } catch { raw = null; }
  const quiz = cleanQuiz(raw);
  if (quiz.length < 2) throw new Error('I could not make good questions from that');
  return quiz;
}

module.exports = { makeQuiz, cleanQuiz, SCHEMA };
