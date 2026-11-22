// Contrôle de syntaxe lancé par la CI (et par tests/run.mjs) : chaque <script> inline de l'interface (HTML_B64),
// le service worker (SW_B64) et worker.js doivent compiler. Une accolade en trop dans l'interface ne passe plus inaperçue.
// node tests/check-ui.mjs [chemin/vers/worker.js]  → code de sortie 1 en cas d'erreur.
import fs from 'node:fs';
import vm from 'node:vm';
const file = process.argv[2] || new URL('../worker.js', import.meta.url);
const src = fs.readFileSync(file, 'utf8');
const b64 = name => { const m = src.match(new RegExp('const ' + name + "\\s*=\\s*'([A-Za-z0-9+/=]+)'")); if (!m) throw new Error(name + ' introuvable'); return Buffer.from(m[1], 'base64').toString('utf8'); };
let n = 0, err = 0;
const check = (code, filename) => { n++; try { new vm.Script(code, { filename }); } catch (e) { err++; console.error(filename + ' : ' + e.message); } };
const html = b64('HTML_B64');
let k = 0; for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) check(m[1], 'interface-script-' + (++k) + '.js');
if (!k) { err++; console.error('aucun <script> trouvé dans l\'interface'); }
check(b64('SW_B64'), 'sw.js');
check(src.replace(/^import .*$/mg, '').replace(/^export default /m, 'const __d=').replace(/^export /mg, ''), 'worker.js');
console.log(n + ' fichier(s) vérifié(s) (' + k + ' script(s) de l\'interface, service worker, worker.js), ' + err + ' erreur(s)');
process.exit(err ? 1 : 0);
