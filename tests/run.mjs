// Tests de non-régression d'ImmoGest — lancés avant chaque déploiement (GitHub Actions).
// node tests/run.mjs  → code de sortie 1 si un test échoue.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
let failed = 0, passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('✓ ' + name); } catch (e) { failed++; console.error('✗ ' + name + '\n   ' + e.message); } }
const near = (a, b, eps = 0.01, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} attendu ${b}, obtenu ${a}`);

// Extrait une fonction de premier niveau du worker par son nom
function extract(name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'fonction ' + name + ' introuvable');
  let depth = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error('fin de ' + name + ' introuvable');
}
const arrKeys = src.match(/const ARR_KEYS=(\[[^\]]+\]);/)[1];
const ctx = vm.createContext({});
vm.runInContext(['const ARR_KEYS=' + arrKeys + ';', extract('projCalc'), extract('mergeArr'), extract('mergeDB'),
  'this.projCalc=projCalc;this.mergeDB=mergeDB;this.ARR_KEYS=ARR_KEYS;'].join('\n'), ctx);
const { projCalc, mergeDB, ARR_KEYS } = ctx;

// ── Simulateur : cas réel Charbonnerie (valeurs du 13/10/2026)
const charbo = { prix: 77000, notaire: 8, impr: 0, apport: 0, taux: 4.2, duree: 20, tf: 4000, pno: 600, gest: 4, vac: 0, entr: 0, cible: 10,
  dBas: 2000, dHaut: 2300, dFrais: 5000, capi: 8,
  lots: [{ s: 27.55, l: 500, w: 20000 }, { s: 29.83, l: 500, w: 20000 }, { s: 36.31, l: 500, w: 25000 }, { s: 26.26, l: 380, w: 20000 }, { s: 35.48, l: 500, w: 25000 }, { s: 15.79, l: 380, w: 5000 }],
  pcs: [{ m: 60000 }] };
test('prix de revient = prix + notaire + travaux', () => {
  const c = projCalc(charbo);
  near(c.frais_notaire, 6160); near(c.travaux_total, 175000); near(c.prix_de_revient, 258160); near(c.surface, 171.22);
});
test('loyers et rendement brut', () => {
  const c = projCalc(charbo);
  near(c.loyers_annuels, 33120); near(c.rendement_brut_pct, 33120 / 258160 * 100, 1e-9);
});
test('mensualité = formule bancaire standard', () => {
  const c = projCalc(charbo), r = 0.042 / 12, n = 240;
  near(c.mensualite, 258160 * r / (1 - Math.pow(1 + r, -n)), 1e-6);
});
test('cash-flow = loyers − crédit − PNO − TF − gestion', () => {
  const c = projCalc(charbo);
  near(c.cash_flow_an, 33120 - c.mensualite * 12 - 600 - 4000 - 33120 * 0.04, 1e-6);
  near(c.cash_flow_mois * 12, c.cash_flow_an, 1e-6);
});
test('cash-flow prudent retire vacance et entretien', () => {
  const c = projCalc(Object.assign({}, charbo, { vac: 5, entr: 5 }));
  near(c.cash_flow_prudent_an, c.cash_flow_an - 33120 * 0.10, 1e-6);
});
test('prix maximal pour le rendement visé redonne exactement la cible', () => {
  const c = projCalc(charbo), c2 = projCalc(Object.assign({}, charbo, { prix: c.prix_achat_max_cible }));
  near(c2.rendement_brut_pct, 10, 1e-6);
});
test('taux zéro, apport total et projet vide ne cassent pas le calcul', () => {
  near(projCalc(Object.assign({}, charbo, { taux: 0 })).mensualite, 258160 / 240, 1e-6);
  near(projCalc(Object.assign({}, charbo, { apport: 300000 })).mensualite, 0);
  const v = projCalc({});
  assert.equal(v.prix_de_revient, 0); assert.equal(v.rendement_brut_pct, 0); assert.equal(v.dscr, null);
});
test('valeur de sortie', () => {
  const c = projCalc(charbo);
  near(c.sortie_decoupe_bas, 171.22 * 2000 - 5000); near(c.sortie_bloc, 33120 / 0.08);
});

// ── Synchronisation : les nouvelles collections ne doivent jamais être perdues par le serveur
test('le serveur synchronise anciens locataires et projets', () => {
  assert.ok(ARR_KEYS.includes('anciens') && ARR_KEYS.includes('projets'));
});
test('fusion : un appareil ancien (sans projets) n\'efface pas les projets du serveur', () => {
  const server = { projets: [{ id: 'pj1', nom: 'A', _ts: 10 }], anciens: [{ id: 'anc1', _ts: 5 }] };
  const out = mergeDB(server, { locataires: [] });
  assert.equal(out.projets.length, 1); assert.equal(out.anciens.length, 1);
});
test('fusion : la version la plus récente gagne, la suppression (tomb) est respectée', () => {
  const server = { projets: [{ id: 'pj1', nom: 'ancien', _ts: 10 }, { id: 'pj2', nom: 'x', _ts: 10 }] };
  const client = { projets: [{ id: 'pj1', nom: 'nouveau', _ts: 20 }], tomb: { pj2: 15 } };
  const out = mergeDB(server, client);
  assert.equal(out.projets.find(p => p.id === 'pj1').nom, 'nouveau');
  assert.ok(!out.projets.find(p => p.id === 'pj2'));
});
test('fusion : archiver un locataire ne supprime pas sa fiche archivée', () => {
  const t = 1000;
  const out = mergeDB({ locataires: [{ id: 'loc1', nom: 'X', _ts: 500 }] },
    { locataires: [], anciens: [{ id: 'ancA', locId: 'loc1', nom: 'X', _ts: t }], tomb: { loc1: t } });
  assert.equal(out.locataires.length, 0); assert.equal(out.anciens.length, 1);
});

// ── Cohérence appli / serveur : même calcul des deux côtés
test('le calcul du simulateur est identique dans l\'appli et sur le serveur', () => {
  const html = Buffer.from(src.match(/const HTML_B64 = '([A-Za-z0-9+/=]+)'/)[1], 'base64').toString('utf8');
  const a = html.slice(html.indexOf('function projCalc('), html.indexOf('\n// ═══ PAGE: PROJETS'));
  assert.equal(a.trim(), extract('projCalc').trim());
});
test('la version du cache est identique dans le worker et le service worker', () => {
  const v = src.match(/const APP_VERSION = '([^']+)'/)[1];
  const sw = Buffer.from(src.match(/const SW_B64='([A-Za-z0-9+/=]+)'/)[1], 'base64').toString('utf8');
  assert.ok(sw.includes(v), 'service worker sans ' + v);
});

console.log(`\n${passed} réussi(s), ${failed} échec(s)`);
process.exit(failed ? 1 : 0);
