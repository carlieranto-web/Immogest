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
test('Simulateur : valeur avant / après travaux', () => {
  const c = projCalc(Object.assign({}, charbo, { vAvant: 90000, vApres: 250000 }));
  near(c.decote_achat, 13000); near(c.valeur_creee_travaux, 160000);
  near(c.plus_value_apres_travaux, 250000 - c.prix_de_revient); near(c.ltv_apres_travaux_pct, c.montant_emprunte / 250000 * 100);
  near(c.valeur_creee_par_euro_travaux, 160000 / c.travaux_total, 1e-9);
  const z = projCalc(charbo); assert.equal(z.valeur_avant_travaux, null); assert.equal(z.plus_value_apres_travaux, null);
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

// ── Non-régression audit du 19/11/2026 : fonctions de l'appli (interface décodée depuis HTML_B64)
const uiHtml = Buffer.from(src.match(/const HTML_B64 = '([A-Za-z0-9+/=]+)'/)[1], 'base64').toString('utf8');
function extractUI(name) {
  const i = uiHtml.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'fonction ' + name + ' introuvable dans l\'appli');
  let depth = 0, j = uiHtml.indexOf('{', i);
  for (let k = j; k < uiHtml.length; k++) {
    if (uiHtml[k] === '{') depth++;
    else if (uiHtml[k] === '}') { depth--; if (depth === 0) return uiHtml.slice(i, k + 1); }
  }
  throw new Error('fin de ' + name + ' introuvable');
}
const UI_PAI = ['gLoc', 'gLog', 'gLogLoc', 'gPai', 'paiDu', 'duMois', 'prorataJours', 'locMoisListe', 'majStatutLoc', 'recalcPai', 'quickPay', 'validerBank', 'addVersement', 'locNom', 'fmt'];
// Contexte appli : DOM, toasts et sauvegarde neutralisés ; NOW figé au 19/11/2026
function uiCtx(DB, els = {}) {
  const c = vm.createContext({ confirm: () => true, toast: () => {}, persist: () => {}, updateNB: () => {}, gPage: () => {}, paiRefresh: () => {}, renderVersModal: () => {},
    refreshCurrentView: () => {}, requestAnimationFrame: () => {}, uid: () => Math.random().toString(36).slice(2), __els: els,
    gv: id => (els[id] || {}).value || '', document: { getElementById: id => els[id] || null, querySelector: () => null } });
  vm.runInContext('var NOW=new Date("2026-11-19T10:00:00Z");var DB;' + UI_PAI.map(extractUI).join('\n'), c);
  c.__DB = DB; vm.runInContext('DB=this.__DB', c); return c;
}
const uiDB = () => ({ logements: [{ id: 'l1', batId: 'b1', ref: 'A1', loyer: 500, charges: 50, statut: 'Occupé' }],
  locataires: [{ id: 't1', logId: 'l1', prenom: 'Jean', nom: 'Dupont', entree: '2025-01-01' }], paiements: [] });

test('la version affichée par l\'appli (window.APP_VERSION) est celle du worker', () => {
  const v = src.match(/const APP_VERSION = '([^']+)'/)[1];
  const u = uiHtml.match(/window\.APP_VERSION='([^']+)'/);
  assert.ok(u, 'window.APP_VERSION absent de l\'appli'); assert.equal(u[1], v);
});
const proSrv = vm.createContext({}), proUI = vm.createContext({});
vm.runInContext(extract('prorataJours') + '\nthis.f=prorataJours;', proSrv);
vm.runInContext(extractUI('prorataJours') + '\nthis.f=prorataJours;', proUI);
test('prorata au jour : entrée/sortie en cours de mois, février bissextile, mois complet (appli et serveur)', () => {
  [proSrv.f, proUI.f].forEach(f => {
    near(f(550, '2026-10', '2026-10-16'), 283.87);            // 550 × 16/31
    near(f(550, '2026-10', '2025-01-01', '2026-10-15'), 266.13); // 550 × 15/31
    near(f(550, '2028-02', '2028-02-15'), 284.48);            // 550 × 15/29
    near(f(550, '2026-02', '2026-02-15'), 275);               // 550 × 14/28
    near(f(550, '2026-11', '2026-10-16'), 550); near(f(0, '2026-10', '2026-10-16'), 0);
    near(f(550, '2026-11', '2025-01-01', '2026-10-15'), 0);   // après la sortie
  });
});
test('prorata : un mois antérieur à l\'entrée vaut 0 (appli et serveur)', () => {
  assert.equal(proSrv.f(550, '2026-09', '2026-10-16'), 0, 'serveur');
  assert.equal(proUI.f(550, '2026-09', '2026-10-16'), 0, 'appli');
  assert.equal(proSrv.f(550, '2025-12', '2026-01-01'), 0, 'serveur, changement d\'année');
});
test('appli « encaisser le reste » : paiement de 300 € saisi sans versements → 550, Payé', () => {
  const DB = uiDB(); DB.paiements.push({ id: 'pa1', logId: 'l1', mois: '2026-10', montant: 300, date: '2026-10-05', mode: 'Virement', statut: 'Partiel' });
  uiCtx(DB).quickPay('l1', '2026-10'); const p = DB.paiements[0];
  assert.equal(p.montant, 550); assert.equal(p.statut, 'Payé');
});
test('appli « ajouter un versement » : 250 € sur un paiement de 300 € saisi sans versements → 550, Payé', () => {
  const DB = uiDB(); DB.paiements.push({ id: 'pa1', logId: 'l1', mois: '2026-10', montant: 300, date: '2026-10-05', mode: 'Virement', statut: 'Partiel' });
  DB._versLog = 'l1'; DB._versMois = '2026-10';
  uiCtx(DB, { 'vers-montant': { value: '250' }, 'vers-date': { value: '2026-10-12' }, 'vers-mode': { value: 'Virement' }, 'vers-type': { value: 'Locataire' } }).addVersement();
  const p = DB.paiements[0]; assert.equal(p.montant, 550); assert.equal(p.statut, 'Payé');
});
test('import bancaire : virement 200 € ajouté à la CAF 250 € déjà saisie → 450, Partiel, 2 versements', () => {
  const DB = uiDB(); DB.paiements.push({ id: 'pa1', logId: 'l1', mois: '2026-10', montant: 250, statut: 'Partiel', versements: [{ montant: 250, type: 'CAF', date: '2026-10-05' }] });
  const c = uiCtx(DB, { 'tx-0': { checked: true }, 'tx-amt-0': { value: '200' } });
  c.validerBank(encodeURIComponent(JSON.stringify([{ locataire_id: 't1', montant: 200, date: '2026-10-08' }])), '2026-10', 'releve.csv');
  const p = DB.paiements[0];
  assert.equal(p.montant, 450); assert.equal(p.statut, 'Partiel'); assert.equal((p.versements || []).length, 2);
  c.recalcPai(p); assert.equal(p.montant, 450, 'le virement importé disparaît au recalcul');
});
test('appli, arrondi : dû 733,33, versements 212,18 + 521,15 → Payé, 733,33', () => {
  const DB = uiDB(); DB.logements[0].loyer = 700; DB.logements[0].charges = 33.33;
  DB.paiements.push({ id: 'pa1', logId: 'l1', mois: '2026-10', montant: 0, statut: 'En attente', versements: [{ montant: 212.18, date: '2026-10-05' }, { montant: 521.15, date: '2026-10-08' }] });
  uiCtx(DB).recalcPai(DB.paiements[0]); const p = DB.paiements[0];
  assert.equal(p.statut, 'Payé'); assert.equal(p.montant, 733.33);
});
test('appli, révision 500 → 510 : les mois payés 550 avant la révision laissent le locataire à jour', () => {
  const DB = uiDB(); DB.logements[0].loyer = 510; DB.locataires[0].entree = '2026-07-01';
  ['2026-07', '2026-08', '2026-09'].forEach((m, i) => DB.paiements.push({ id: 'p' + i, logId: 'l1', mois: m, montant: 550, statut: 'Payé', versements: [{ montant: 550, date: m + '-05' }] }));
  DB.paiements.push({ id: 'p9', logId: 'l1', mois: '2026-10', montant: 560, statut: 'Payé', versements: [{ montant: 560, date: '2026-10-05' }] });
  const loc = DB.locataires[0]; uiCtx(DB).majStatutLoc(loc);
  assert.equal(loc.statutPaiement, 'À jour');
});

console.log(`\n${passed} réussi(s), ${failed} échec(s)`);
process.exit(failed ? 1 : 0);
