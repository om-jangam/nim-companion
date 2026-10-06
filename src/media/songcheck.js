'use strict';
/*
 * Is this video a piece of music? Asked of Qwen, on this computer, from the
 * video's title and channel only - nothing else is sent, and nothing leaves
 * the machine.
 *
 * Only for a browser video whose title says nothing either way and whose
 * lyrics were not found: "GE vs LOUD - Group Stage" or "My day in Tokyo". The
 * sound alone cannot tell a song from a match with commentary or a vlog with
 * music under it; the title usually can. The answer is held to true or false
 * by a JSON schema, asked once per video, and only decides whether Nim may
 * dance - it can never cause an action.
 */
const { noThinking } = require('../brain/thinking');

const HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const cache = new Map();

/* Asked as "what kind of video is it?" rather than "is it music?": asked yes or
 * no, a small model says no to plain song names ("Tum Hi Ho" from T-Series);
 * asked to sort, it got 30 of 30 titles right, songs and the rest. */
const KINDS = ['music', 'gaming', 'sport', 'film', 'talk', 'lesson', 'other'];
const SYSTEM = 'You sort a YouTube video into one kind from its title and channel. ' +
  '"music": a song, music video, lyric video, live concert, cover, remix, DJ set or music mix - ' +
  'a title that is only a song\'s name, from a singer, band or music label, is music. ' +
  '"gaming", "sport", "film" (films, trailers, scenes, shows), "talk" (vlogs, podcasts, news, opinions, interviews), ' +
  '"lesson" (tutorials, classes, recipes), "other". Reply with JSON only.';

/* true (music), false (not music) or null (could not ask). */
async function isMusic(info, opts = {}) {
  const title = String(info.title || '').slice(0, 150);
  const channel = String(info.artist || '').slice(0, 80);
  if (!title) return null;
  const key = title + '|' + channel;
  if (cache.has(key)) return cache.get(key);

  const model = opts.model || 'qwen2.5:3b';
  let verdict = null;
  try {
    const res = await (opts.fetch || fetch)(HOST + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs || 25000),
      body: JSON.stringify(Object.assign({
        model,
        stream: false,
        keep_alive: '20m',
        format: { type: 'object', properties: { kind: { type: 'string', enum: KINDS } }, required: ['kind'] },
        // the planner's context size, so the model already loaded is used as it is
        options: { temperature: 0, num_predict: 16, num_ctx: 8192 },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: 'Title: ' + title + (channel ? '\nChannel: ' + channel : '') }
        ]
      }, noThinking(model)))
    });
    if (res.ok) {
      const body = await res.json();
      const kind = JSON.parse(body && body.message && body.message.content).kind;
      if (KINDS.includes(kind)) verdict = kind === 'music';
    }
  } catch { verdict = null; }

  // a real answer is kept; no answer is asked again next time
  if (verdict !== null) {
    cache.set(key, verdict);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
  }
  return verdict;
}

module.exports = { isMusic, KINDS };
