# Security

Nim listens to a microphone and acts on a computer, so its safety rules matter
more than its features. The rules are described under **Safety** in the
[README](README.md) and tried for real in `test/security.test.js`.

## Reporting a problem

If you find a way to get Nim to do something it should not - run a command,
reach a local network address, touch files outside your own folders, act
without asking when it should ask - please report it privately through
GitHub's **Report a vulnerability** button on this repository (Security tab),
not in a public issue. Include what you said or what the page contained, and
what Nim did.

## What is in scope

- Prompt injection: text from a web page, the clipboard, a song title or a
  file name leading to an action.
- Anything in `src/agent/validator.js`, the tools in `src/agent/tools/`, the
  runtime's approval gate, and the PowerShell bridge (`src/system/`).
- Electron isolation: preloads, IPC sender checks, permissions, CSP.

## Good to know

- Nothing Nim thinks with leaves the computer: the brain (Ollama), the ears
  (Whisper) and the voice (Kokoro or Piper) all run locally. The only network
  calls are the ones you ask for (search, reading a page, weather by city name,
  song lyrics by title).
- Keep Electron and the other dependencies up to date (`npm outdated`,
  `npm audit`); Electron releases carry Chromium's security fixes.
