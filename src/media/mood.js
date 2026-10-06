'use strict';
/*
 * What a song feels like: romantic, sad, party, happy, chill, angry or epic.
 *
 * Asked of Qwen, running on this computer through Ollama - nothing leaves the
 * machine - from the song's title, artist and first lines of its lyrics. The
 * answer can only be one of the seven words: the model is held to them by a
 * JSON schema, and anything else is thrown away. It only colours the dance;
 * it can never cause an action.
 *
 * Only when Qwen is already loaded (you have talked to Nim lately): loading it
 * just for this would tie the computer up for half a minute in the middle of
 * a song. Otherwise, or if it is slow, the lyrics' own words decide.
 */

const { noThinking } = require('../brain/thinking');
const HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const MOODS = ['romantic', 'sad', 'party', 'happy', 'chill', 'angry', 'epic'];
const cache = new Map();

/* The fallback: counting words. English, Hindi (both scripts) and Korean,
 * since those are what get played here. */
const WORDS = {
  romantic: /\b(love|lover|heart|kiss|baby|darling|forever|hold me|pyaa?r|ishq|mohabbat|dil|jaan|sanam)\b|प्यार|इश्क|दिल|मोहब्बत|사랑|그대/gi,
  sad: /\b(cry|crying|tears?|alone|lonely|pain|hurt|goodbye|broken|miss you|gone|dard|aansu|tanha)\b|आँसू|दर्द|तन्हा|눈물|아파|이별/gi,
  party: /\b(party|dance|club|tonight|drink|shots|move|bounce|nacho|naach|dj|floor)\b|नाच|파티|춤/gi,
  angry: /\b(hate|rage|fight|kill|burn|war|enemy|scream)\b|नफ़रत|싸워/gi,
  epic: /\b(rise|legend|hero|fire|thunder|kingdom|glory|believer|warriors?)\b|영웅/gi,
  happy: /\b(happy|smile|sunshine|good day|fun|joy|laugh|khushi)\b|खुशी|행복|웃어/gi
};

function moodFromWords(text) {
  let best = null, top = 1;            // two hits at least, or no opinion
  for (const mood of Object.keys(WORDS)) {
    const n = (String(text).match(WORDS[mood]) || []).length;
    if (n > top) { best = mood; top = n; }
  }
  return best;
}

/* Is the model already in memory? Ollama says so at /api/ps. */
async function loaded(model, fetchImpl) {
  try {
    const res = await fetchImpl(HOST + '/api/ps', { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const body = await res.json();
    return (body.models || []).some((m) => m.name === model || m.model === model);
  } catch { return false; }
}

async function moodFromQwen(info, opts) {
  const lyric = (info.lines || []).map((l) => l.text).filter(Boolean).slice(0, 10).join(' / ').slice(0, 500);
  const fetchImpl = opts.fetch || fetch;
  const model = opts.model || 'qwen2.5:3b';
  if (!opts.skipLoadedCheck && !(await loaded(model, fetchImpl))) return null;
  const res = await fetchImpl(HOST + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(opts.timeoutMs || 40000),
    body: JSON.stringify(Object.assign({
      model,
      stream: false,
      keep_alive: '20m',
      format: { type: 'object', properties: { mood: { type: 'string', enum: MOODS } }, required: ['mood'] },
      // the same context size as the planner, so the model already loaded is used as it is
      options: { temperature: 0, num_predict: 20, num_ctx: 8192 },
      messages: [
        { role: 'system', content: 'You name the mood of a song in one word, from: ' + MOODS.join(', ') + '. Reply with JSON only.' },
        { role: 'user', content: 'Song: ' + String(info.title || '').slice(0, 120) + (info.artist ? ' by ' + String(info.artist).slice(0, 80) : '') +
          (lyric ? '\nLyrics: ' + lyric : '') }
      ]
    }, noThinking(model)))
  });
  if (!res.ok) return null;
  const body = await res.json();
  let mood = null;
  try { mood = JSON.parse(body && body.message && body.message.content).mood; } catch { return null; }
  return MOODS.includes(mood) ? mood : null;
}

/* { mood, by: 'qwen' | 'words' } or null. Once per song. */
async function songMood(info, opts = {}) {
  const key = String(info.key || info.title || '');
  if (cache.has(key)) return cache.get(key);
  let result = null;
  try {
    const m = await moodFromQwen(info, opts);
    if (m) result = { mood: m, by: 'qwen' };
  } catch { /* not running, or too slow: the words decide */ }
  if (!result) {
    const m = moodFromWords((info.title || '') + ' ' + (info.lines || []).map((l) => l.text).join(' '));
    if (m) result = { mood: m, by: 'words' };
  }
  cache.set(key, result);
  if (cache.size > 80) cache.delete(cache.keys().next().value);
  return result;
}

module.exports = { songMood, moodFromWords, MOODS };
