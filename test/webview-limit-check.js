// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Checks on src/webview-limit.js against a client file system held in memory. That file system is asynchronous like the
 * real one, so test/check.js runs this as a child process and reads the verdicts it prints as JSON.
 */
const out = [];
const ok = (m) => out.push(['ok', m]);
const bad = (m) => out.push(['bad', m]);
const wl = require('../src/webview-limit');
/* A client's files as the vscode-local scheme shows them, in memory: paths to text, and directories listed from them. */
const client = (files, refuse) => {
  const has = (p) => Object.prototype.hasOwnProperty.call(files, p);
  const dirs = (p) => [...new Set(Object.keys(files).filter((f) => f.startsWith(p + '/')).map((f) => f.slice(p.length + 1).split('/')[0]))];
  const err = (code) => Object.assign(new Error(code), { code });
  return {
    at: (p) => ({ path: p }),
    fs: {
      stat: async (u) => { if (has(u.path) || dirs(u.path).length) return {}; throw err('ENOENT'); },
      readFile: async (u) => { if (!has(u.path)) throw err('ENOENT'); return new TextEncoder().encode(files[u.path]); },
      writeFile: async (u, b) => { if (refuse) throw err(refuse); files[u.path] = new TextDecoder().decode(b); },
      readDirectory: async (u) => { const d = dirs(u.path); if (!d.length) throw err('ENOENT'); return d.map((n) => [n, 2]); },
    },
    files,
  };
};
const SW = '/' + wl.SW;
const sw = (n) => `self.x=1;const a=12,maxActiveHostResourceResponseBodies=${n},b=3;`;
const product = (commit) => JSON.stringify({ version: '1.144.1', commit });
const mac = '/Applications/Visual Studio Code.app/Contents/Resources/app';
const win = '/c:/Users/me/AppData/Local/Programs/Microsoft VS Code/261c84cb1e/resources/app';
const oldWin = '/c:/Users/me/AppData/Local/Programs/Microsoft VS Code/2c33b50b16/resources/app';
(async () => {
  /* A remote window: the client is searched, and only the installation with the server's commit is taken. */
  const c = client({
    [mac + '/product.json']: product('aaa'), [mac + SW]: sw(32),
    [win + '/product.json']: product('261c84'), [win + SW]: sw(32),
    [oldWin + '/product.json']: product('2c33b5'), [oldWin + SW]: sw(32),
  });
  const found = await wl.find({ fs: c.fs, at: c.at, local: false, commit: '261c84' });
  const done = found.length === 1 ? await wl.setLimit(c.fs, found[0], wl.OLD, wl.NEW) : 'not found';
  const again = await wl.find({ fs: c.fs, at: c.at, local: false, commit: '261c84' });
  if (found.length === 1 && found[0].root === win && found[0].limit === 32 && done === '' && again[0].limit === 1000000
    && c.files[mac + SW] === sw(32) && c.files[oldWin + SW] === sw(32)) {
    ok('in a remote window the client VS Code with the server\'s commit is found and only its limit is raised');
  } else bad(`webview limit, remote: ${JSON.stringify([found, done, again])}`);

  /* A local window: the application is this VS Code's own. Putting it back reverses it. */
  const l = client({ [mac + SW]: sw(32) });
  const here = await wl.find({ fs: l.fs, at: l.at, local: true, appRoot: mac });
  const up = await wl.setLimit(l.fs, here[0], wl.OLD, wl.NEW);
  const down = await wl.setLimit(l.fs, here[0], wl.NEW, wl.OLD);
  if (here.length === 1 && up === '' && down === '' && l.files[mac + SW] === sw(32)) {
    ok('in a local window the limit of VS Code itself is raised, and putting it back restores the file exactly');
  } else bad(`webview limit, local: ${JSON.stringify([here, up, down])}`);

  /* Text not there exactly once means a VS Code that changed this code: it is left alone. */
  const twice = client({ [mac + SW]: sw(32) + sw(32) }), none = client({ [mac + SW]: 'self.x=1;' });
  const t = await wl.find({ fs: twice.fs, at: twice.at, local: true, appRoot: mac });
  const n = await wl.find({ fs: none.fs, at: none.at, local: true, appRoot: mac });
  const tw = await wl.setLimit(twice.fs, t[0], wl.OLD, wl.NEW);
  if (t[0].limit === null && n[0].limit === null && tw === 'changed' && twice.files[mac + SW] === sw(32) + sw(32)) {
    ok('a service worker without the text exactly once is reported as unknown and not written');
  } else bad(`webview limit, unknown: ${JSON.stringify([t, n, tw])}`);

  /* Not allowed to write: the reason comes back, and the command to do it by hand names the file. */
  const ro = client({ [mac + SW]: sw(32) }, 'EACCES');
  const roFound = await wl.find({ fs: ro.fs, at: ro.at, local: true, appRoot: '/usr/share/code/resources/app' });
  const roLinux = client({ ['/usr/share/code/resources/app' + SW]: sw(32) }, 'EACCES');
  const lf = await wl.find({ fs: roLinux.fs, at: roLinux.at, local: true, appRoot: '/usr/share/code/resources/app' });
  const why = await wl.setLimit(roLinux.fs, lf[0], wl.OLD, wl.NEW);
  /* A local Windows window reports its application root with a lowercase drive letter and backslashes. */
  const hands = [wl.byHand(lf[0], 'linux'), wl.byHand({ root: mac }, 'darwin'), wl.byHand({ root: '/c:/Program Files/Microsoft VS Code/261c84cb1e/resources/app' }, 'win32'),
    wl.byHand({ root: 'c:\\Program Files\\Microsoft VS Code\\261c84cb1e\\resources\\app' }, 'win32')];
  if (roFound.length === 0 && why === 'EACCES'
    && hands[0] === "sudo sed -i 's/maxActiveHostResourceResponseBodies=32,/maxActiveHostResourceResponseBodies=1000000,/' '/usr/share/code/resources/app/" + wl.SW + "'"
    && hands[1].startsWith("sudo sed -i '' ") && hands[2].includes("C:\\Program Files\\Microsoft VS Code\\261c84cb1e\\resources\\app\\out\\vs\\")
    && hands[3].startsWith("$f = 'c:\\Program Files") && hands[3].includes("c:\\Program Files\\Microsoft VS Code\\261c84cb1e\\resources\\app\\out\\vs\\")
    && wl.platformOf('c:\\Program Files\\Microsoft VS Code\\resources\\app', 'linux') === 'win32'
    && wl.platformOf(mac, 'linux') === 'darwin' && wl.platformOf(win, 'linux') === 'win32' && wl.platformOf('/usr/share/code/resources/app', 'linux') === 'linux'
    && wl.platformOf('C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\resources\\app', 'win32') === 'win32') {
    ok('a refused write says why, and the command for doing it by hand fits the platform and names the file');
  } else bad(`webview limit, refused: ${JSON.stringify([why, hands])}`);
})().catch((e) => bad('webview limit: ' + (e && e.stack))).then(() => process.stdout.write(JSON.stringify(out)));
