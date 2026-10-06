'use strict';
/* Project awareness, against Nim's own real repository. */
const h = require('./helpers');
h.stubElectron();
h.isolate('project');

const tools = require('../src/agent/tools');

(async () => {
  h.section('what is this project - read from the files, not guessed');
  const inspect = tools.byName('project.inspect');
  h.check('the phrase is recognised', !!inspect.match('what is this project'));
  const r = await inspect.run({ project: '' }, {});
  h.check('it names the project', r.summary.includes(require('../package.json').name), r.summary.split('\n')[0]);
  h.check('it counts real source files', r.data.counts['.js'] > 10, JSON.stringify(r.data.counts));
  h.check('it lists the real scripts', r.data.scripts && 'start' in r.data.scripts);

  h.section('git status - read from git');
  const git = tools.byName('git.status');
  h.check('"what changed" is recognised', !!git.match('what has changed'));
  try {
    const g = await git.run({ project: '' }, {});
    h.check('it reports a branch', /^On /.test(g.summary), g.summary);
  } catch (err) {
    h.check('or says plainly why it cannot', /git/.test(err.message), err.message);
  }

  h.section('running tests is guarded');
  const test = tools.byName('project.test');
  h.check('running a project\'s tests is high risk', test.risk === 'high');
  h.check('"run the tests" is recognised', !!test.match('run the tests'));

  h.section('only listed projects');
  let refused = null;
  try { await git.run({ project: 'C:/Windows' }, { projects: {} }); } catch (err) { refused = err.message; }
  h.check('an unlisted folder is refused', /not one of your listed projects/.test(refused || ''), refused);
  let listed = null;
  try { listed = await inspect.run({ project: 'mine' }, { projects: { mine: process.cwd() } }); } catch (err) { listed = err; }
  h.check('a listed one is allowed', listed && listed.summary, String(listed && listed.message));

  h.finish();
})().catch((e) => { console.error(e); process.exit(1); });
