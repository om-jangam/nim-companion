'use strict';
/* Memory: only what you asked it to keep, and you can take it back. */
const fs = require('node:fs');
const h = require('./helpers');
h.stubElectron();
h.isolate('memory');

const store = require('../src/memory/store');
const tools = require('../src/agent/tools');
try { fs.unlinkSync(store.FILE); } catch {}

(async () => {
  h.section('remembering');
  const remember = tools.byName('memory.remember');
  const args = remember.match('remember that I use Brave');
  h.check('the phrase is recognised', args && args.text === 'I use Brave', JSON.stringify(args));
  const out = await remember.run(args);
  h.check('it is saved to a plain file you can read', fs.existsSync(store.FILE));
  h.check('and verifies by reading it back', (await remember.verify(args, out)).ok);
  await remember.run({ text: 'I use Brave' });
  h.check('the same thing twice is one memory', store.recall('').length === 1);

  h.section('recalling');
  await remember.run({ text: 'my deadline is Friday' });
  const recall = tools.byName('memory.recall');
  const r = await recall.run({ query: '' });
  h.check('it lists what you asked it to keep', /Brave/.test(r.summary) && /Friday/.test(r.summary), r.summary);
  h.check('a query narrows it', store.recall('deadline').length === 1);
  h.check('remembered facts reach the planner', store.forPrompt().some((l) => /Brave/.test(l)));

  h.section('forgetting');
  const forget = tools.byName('memory.forget');
  h.check('forgetting asks first', forget.risk === 'medium');
  await forget.run({ query: 'Brave' });
  h.check('one fact can be removed', store.recall('').length === 1 && !store.recall('Brave').length);
  await forget.run({ query: 'everything' });
  h.check('or all of them', store.recall('').length === 0);

  h.section('session memory never touches the disk');
  store.note('user', 'secret plan');
  const onDisk = fs.existsSync(store.FILE) ? fs.readFileSync(store.FILE, 'utf8') : '';
  h.check('kept in memory', store.recent().some((x) => x.text === 'secret plan'));
  h.check('not written to the file', !onDisk.includes('secret plan'));

  try { fs.unlinkSync(store.FILE); } catch {}
  h.finish();
})().catch((e) => { console.error(e); process.exit(1); });
