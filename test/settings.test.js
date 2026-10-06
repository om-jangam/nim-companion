'use strict';
/*
 * The settings window may change only what is listed, only to values each
 * setting can take - a window cannot reach the model, the projects or the
 * safety rules through it.
 */
const h = require('./helpers');
const { clean, view, SKINS } = require('../src/desktop/settings-model');

h.section('only the listed settings');
h.check('a switch takes true or false', clean('wakeWord', false).ok && clean('wakeWord', false).value === false);
h.check('not a string pretending to be one', !clean('wakeWord', 'false').ok);
for (const key of ['brain', 'projects', 'disabledTools', 'browser', 'diagnostics', '__proto__', 'constructor', 'toString']) {
  h.check('"' + key + '" cannot be set from the window', !clean(key, { ollamaModel: 'x' }).ok && !clean(key, true).ok);
}

h.section('each value within its range');
h.check('speed is held between slow and fast', clean('rate', 9).value === 1.35 && clean('rate', 0.1).value === 0.75);
h.check('speed must be a number', !clean('rate', '1.2').ok && !clean('rate', NaN).ok);
h.check('breaks: one of the offered lengths', clean('breakMinutes', 45).ok && !clean('breakMinutes', 1).ok);
h.check('colour: one of the colours', SKINS.every((s) => clean('skin', s).ok) && !clean('skin', 'url(x)').ok);
h.check('a name is letters, kept short', clean('name', 'Sam <script>alert(1)</script>').value === 'Sam scriptalert1script' &&
  clean('name', 'x'.repeat(80)).value.length === 30);
h.check('a city keeps its accents', clean('city', 'São Paulo').value === 'São Paulo');

h.section('what the window shows');
const v = view({ name: 'Sam', wakeWord: true, outfit: { skin: 'lilac', hat: 'bow' } });
h.check('read from the config, with defaults', v.name === 'Sam' && v.wakeWord && v.followUp && v.breakMinutes === 60 && v.skin === 'lilac');
h.check('no hats or clothes any more', !('hat' in v));

h.finish();
