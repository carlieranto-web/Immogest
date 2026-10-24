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

test('cash-flow brut = loyers − crédit, cash-flow = brut − PNO − TF − gestion', () => {
  const c = projCalc(charbo);
  near(c.cash_flow_brut_an, c.loyers_annuels - c.annuite, 1e-9);
  near(c.cash_flow_brut_mois, c.cash_flow_brut_an / 12, 1e-9);
  near(c.cash_flow_an, c.cash_flow_brut_an - c.pno_an - c.tf_an - c.gestion_an, 1e-9);
});

// ── Cohérence appli / serveur : même calcul des deux côtés
test('le calcul du simulateur est identique dans l\'appli et sur le serveur', () => {
  const html = Buffer.from(src.match(/const HTML_B64 = '([A-Za-z0-9+/=]+)'/)[1], 'base64').toString('utf8');
  const a = html.slice(html.indexOf('function projCalc('), html.indexOf('\n// ═══ PAGE: PROJETS'));
  assert.equal(a.trim(), extract('projCalc').trim());
});
// ── Second locataire sur le même bail (couple, colocation)
const nomCtx = vm.createContext({});
vm.runInContext(extract('locNom') + '\nthis.locNom=locNom;', nomCtx);
test('nom affiché : un seul locataire, deux locataires, même nom de famille', () => {
  const { locNom } = nomCtx;
  assert.equal(locNom({ prenom: 'Jean', nom: 'Dupont' }), 'Jean Dupont');
  assert.equal(locNom({ prenom: 'Jean', nom: 'Dupont', prenom2: 'Marie', nom2: 'Martin' }), 'Jean Dupont et Marie Martin');
  assert.equal(locNom({ prenom: 'Jean', nom: 'Dupont', prenom2: 'Marie', nom2: 'dupont' }), 'Jean et Marie Dupont');
  assert.equal(locNom(null), '');
});
test('le nom affiché est calculé de la même façon dans l\'appli et sur le serveur', () => {
  const html = Buffer.from(src.match(/const HTML_B64 = '([A-Za-z0-9+/=]+)'/)[1], 'base64').toString('utf8');
  const i = html.indexOf('function locNom('), j = html.indexOf('\n', i);
  assert.equal(html.slice(i, j).trim(), extract('locNom').trim());
});
test('la version du cache est identique dans le worker et le service worker', () => {
  const v = src.match(/const APP_VERSION = '([^']+)'/)[1];
  const sw = Buffer.from(src.match(/const SW_B64='([A-Za-z0-9+/=]+)'/)[1], 'base64').toString('utf8');
  assert.ok(sw.includes(v), 'service worker sans ' + v);
});

// ── Capital remboursé (échéanciers des prêts)
const capCtx = vm.createContext({});
vm.runInContext([extract('capSeries'), extract('capCrd'), extract('capReport'),
  'var DB={batiments:[],prets:[],scis:[]};function gSCI(id){return DB.scis.find(function(s){return s.id===id;});}',
  'function gBatPrets(bid){var b=DB.batiments.find(function(x){return x.id===bid;});return DB.prets.filter(function(p){return p.batId===bid||(b&&p.batiment===b.nom);});}',
  'this.capSeries=capSeries;this.capCrd=capCrd;this.capReport=capReport;this.setDB=function(d){DB=d;};'].join('\n'), capCtx);
const K = (y, m) => y * 12 + m - 1;
const sched = [ // échéancier bancaire : 2 mois de différé (intérêts seuls) puis amortissement
  { date: '2026-09-05', principal: 0, interest: 300, total: 300, balance: 100000 },
  { date: '2026-10-05', principal: 0, interest: 300, total: 300, balance: 100000 },
  { date: '2026-11-05', principal: 500.5, interest: 300, total: 800.5, balance: 99499.5 },
  { date: '2026-12-05', principal: 502, interest: 298.5, total: 800.5, balance: 98997.5 },
  { date: '2027-01-05', principal: 503.5, interest: 297, total: 800.5, balance: 98494 }];
const dbCap = { scis: [{ id: 's1', nom: 'SCI A' }],
  batiments: [{ id: 'b1', sciId: 's1', nom: 'Lannion' }, { id: 'b2', sciId: 's1', nom: 'La Roche' }, { id: 'b3', sciId: 's1', nom: 'Sans prêt', creditRestant: 50000 }, { id: 'b4', sciId: 's1', nom: 'Payé cash' }],
  prets: [{ id: 'p1', batId: 'b1', hasSchedule: true, capital: 100000, schedule: sched },
          { id: 'p2', batiment: 'La Roche', capital: 12000, taux: 0, duree: 12, debut: '2026-01-15' }] };
capCtx.setDB(dbCap);
test('capital remboursé : pris dans l\'échéancier de la banque, différé à zéro', () => {
  const s = capCtx.capSeries(dbCap.prets[0]);
  assert.equal(s.m[K(2026, 10)].cap, 0); near(s.m[K(2026, 11)].cap, 500.5); near(s.m[K(2026, 12)].int, 298.5);
});
test('capital remboursé : déduit du capital restant dû si la colonne manque', () => {
  const p = { hasSchedule: true, capital: 100000, schedule: sched.map(r => ({ date: r.date, total: r.total, balance: r.balance })) };
  const s = capCtx.capSeries(p);
  near(s.m[K(2026, 9)].cap, 0); near(s.m[K(2026, 11)].cap, 500.5); near(s.m[K(2027, 1)].cap, 503.5);
});
test('prêt sans échéancier : la somme du capital remboursé redonne le capital emprunté', () => {
  const s = capCtx.capSeries({ capital: 150000, taux: 3.5, duree: 240, debut: '2026-01-15' });
  near(s.keys.reduce((a, k) => a + s.m[k].cap, 0), 150000, 1e-6); near(s.m[s.keys[239]].crd, 0, 1e-6);
});
test('capital restant dû avant, pendant et après le prêt', () => {
  const s = capCtx.capSeries(dbCap.prets[0]);
  near(capCtx.capCrd(s, K(2026, 1)), 100000); near(capCtx.capCrd(s, K(2026, 12)), 98997.5); near(capCtx.capCrd(s, K(2030, 1)), 0);
});
test('rapport du mois : bien par bien, total = somme, cumul depuis janvier et année', () => {
  const R = capCtx.capReport(K(2026, 12));
  const lan = R.batiments.find(b => b.nom === 'Lannion'), roc = R.batiments.find(b => b.nom === 'La Roche');
  near(lan.cap, 502); near(lan.capAn, 1002.5); near(lan.crd, 98997.5);
  near(roc.cap, 1000); near(roc.capAn, 12000); near(roc.capAnTot, 12000);
  near(R.total.cap, 1502); near(R.total.capAn, 13002.5); near(R.mois[10], 500.5 + 1000);
  assert.equal(R.batiments.length, 2); assert.deepEqual([...R.sans_echeancier], ['Sans prêt']);
});
test('rapport : cumul depuis janvier repart à zéro chaque année', () => {
  const R = capCtx.capReport(K(2027, 1)); near(R.batiments.find(b => b.nom === 'Lannion').capAn, 503.5);
});
test('différé avec intérêts reportés : la hausse de dette est séparée, jamais comptée en remboursement', () => {
  const p = { hasSchedule: true, capital: 702101.41, schedule: [
    { date: '2026-08-05', principal: 0, interest: 2369.59, total: 126.39, balance: 705951.18 },
    { date: '2026-09-05', principal: 0, interest: 2369.59, total: 126.39, balance: 708320.77 },
    { date: '2026-10-05', principal: 0, interest: 2369.59, total: 126.39, balance: 710690.36 }] };
  const s = capCtx.capSeries(p);
  near(s.m[K(2026, 9)].cap, 0); near(s.m[K(2026, 9)].capi, 2369.59); near(s.m[K(2026, 10)].capi, 2369.59);
  near(capCtx.capCrd(s, K(2026, 1)), 705951.18);
});
test('le calcul du capital remboursé est identique dans l\'appli et sur le serveur', () => {
  const html = Buffer.from(src.match(/const HTML_B64 = '([A-Za-z0-9+/=]+)'/)[1], 'base64').toString('utf8');
  ['capSeries', 'capCrd', 'capReport'].forEach(n => {
    const i = html.indexOf('function ' + n + '('); assert.ok(i >= 0, n + ' absent de l\'appli');
    assert.ok(html.slice(i).startsWith(extract(n)), n + ' diffère entre appli et serveur');
  });
});

console.log(`\n${passed} réussi(s), ${failed} échec(s)`);
process.exit(failed ? 1 : 0);
