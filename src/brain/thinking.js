'use strict';
/*
 * Some local models (Qwen 3, DeepSeek R1) think out loud before they answer:
 * hundreds of words of reasoning nobody hears, each one more wait. Nim's
 * requests are short and their answers are checked anyway, so for those
 * models the thinking is switched off. Older models do not know the switch
 * and would refuse it, so it is only sent to the ones that have it.
 */
const THINKERS = /^(?:qwen3|deepseek-r1|magistral|gpt-oss)\b/i;

function noThinking(model) {
  return THINKERS.test(String(model || '')) ? { think: false } : {};
}

module.exports = { noThinking };
