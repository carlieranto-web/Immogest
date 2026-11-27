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
const ctx2 = vm.createContext({});
vm.runInContext([extract('prorataJours'), extract('prorataDetail'), 'this.prorataJours=prorataJours;'].join('\n'), ctx2);
const { prorataJours } = ctx2;

// ── Simulateur : cas réel Charbonnerie (valeurs du 13/10/2026)
const charbo = { prix: 77000, notaire: 8, impr: 0, apport: 0, taux: 4.2, duree: 20, tf: 4000, pno: 600, gest: 4, vac: 0, entr: 0, cible: 10,
  dBas: 2000, dHaut: 2300, dFrais: 5000, capi: 8,
  lots: [{ s: 27.55, l: 500, w: 20000 }, { s: 29.83, l: 500, w: 20000 }, { s: 36.31, l: 500, w: 25000 }, { s: 26.26, l: 380, w: 20000 }, { s: 35.48, l: 500, w: 25000 }, { s: 15.79, l: 380, w: 5000 }],
  pcs: [{ m: 60000 }] };
test('prix de revient = prix + notaire + travaux', () => {
  const c = projCalc(charbo);
  near(c.frais_notaire, 6160); near(c.travaux_total, 175000); near(c.prix_de_revient, 258160); near(c.surface, 171.22);
});
test('Prorata : 1er mois d\'un nouveau locataire, loyer + charges', () => {
  near(prorataJours(430, '2026-11', '2026-11-17', ''), 200.67); // Studio 5 Lannion : 14 jours / 30
  near(prorataJours(440, '2026-11', '2026-11-20', ''), 161.33); // Studio A Lannion : 11 jours / 30
  near(prorataJours(430, '2026-11', '2026-11-01', ''), 430);    // entrée le 1er : loyer plein
  near(prorataJours(430, '2026-12', '2026-11-17', ''), 430);    // mois suivant : loyer plein
  near(prorataJours(310, '2027-02', '2027-02-15', ''), 155);    // février : 14 jours / 28
});
test('Simulateur : fourchette basse des loyers', () => {
  const base = { prix: 100000, notaire: 8, impr: 0, taux: 4.2, duree: 20, tf: 1000, pno: 500, gest: 4, vac: 5, entr: 5, lots: [{ s: 30, l: 500, lb: 450, w: 10000 }, { s: 30, l: 400, w: 10000 }] };
  const c = projCalc(base);
  near(c.loyers_mensuels, 900); near(c.fourchette_basse.loyers_mensuels, 850); // lot sans loyer bas : loyer normal repris
  near(c.fourchette_basse.cash_flow_an, 850 * 12 - c.annuite - 500 - 1000 - 850 * 12 * 0.04);
  assert.equal(projCalc({ lots: [{ l: 500 }] }).fourchette_basse, null);
});
test('Simulateur : % travaux en plus par lot et global', () => {
  const c = projCalc({ prix: 100000, notaire: 8, impr: 10, lots: [{ s: 40, l: 500, w: 20000, wp: 25 }, { s: 30, l: 400, w: 10000 }], pcs: [{ m: 5000 }] });
  near(c.travaux_lots_hors_majoration, 30000); near(c.majoration_lots, 5000); near(c.travaux_lots, 35000);
  near(c.imprevus, 4000); near(c.travaux_total, 44000); near(c.prix_de_revient, 152000);
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
const UI_PAI = ['gLoc', 'gLog', 'gLogLoc', 'gPai', 'paiDu', 'duMois', 'lotLoyerAt', 'lotMoisNext', 'lotLoyerDefMois', 'lotSetLoyer', 'prorataJours', 'locMoisListe', 'majStatutLoc', 'recalcPai', 'quickPay', 'validerBank', 'addVersement', 'locNom', 'fmt'];
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

// ── Non-régression audit sécurité / fiabilité (v152)
// XSS : aucune valeur saisie (nom, référence, adresse…) concaténée sans esc() dans une instruction qui construit du HTML
function unescapedHtml(ui, F) {
  const ranges = [...ui.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => [m.index + 8, m.index + 8 + m[1].length]);
  const val = new RegExp("\\+\\s*(\\(\\s*[\\w$.]+\\s*\\?\\s*\\(?\\s*)?((?:locNom|ancNom)\\([^()]*\\)|[A-Za-z_$][\\w$]*(?:\\([^()]*\\))?(?:\\.[A-Za-z_$][\\w$]*)?\\.(?:" + F + ")\\b)(?!\\s*\\(|\\.charAt|\\.toLowerCase|\\.length)", 'g');
  const inEsc = (t, pos) => { const st = []; for (let k = 0; k < pos; k++) { const c = t[k]; if (c === "'" || c === '"') { let j = k + 1; while (j < t.length && t[j] !== c) { if (t[j] === '\\') j++; j++; } k = j; continue; }
    if (c === '(') { const w = /([\w$]+)\s*$/.exec(t.slice(Math.max(0, k - 12), k)); st.push(w ? w[1] : ''); } else if (c === ')') st.pop(); } return st.some(n => n === 'esc' || n === 'pdE'); };
  const out = [];
  for (const [a, b] of ranges) { const s = ui.slice(a, b); let i = 0, st = 0, lits = [], prev = ''; const stmts = [];
    const flush = e => { stmts.push({ s: st, e, lits }); st = e + 1; lits = []; };
    while (i < s.length) { const c = s[i];
      if (c === "'" || c === '"' || c === '`') { let j = i + 1; while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; j++; } lits.push(s.slice(i + 1, j)); i = j + 1; prev = 'x'; continue; }
      if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
      if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i + 2) + 2; continue; }
      if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]$|return$|^$/.test(prev)) { let j = i + 1, cls = false; while (j < s.length) { if (s[j] === '\\') { j += 2; continue; } if (s[j] === '[') cls = true; else if (s[j] === ']') cls = false; else if (s[j] === '/' && !cls) break; else if (s[j] === '\n') break; j++; } i = j + 1; while (/[a-z]/.test(s[i])) i++; prev = 'x'; continue; }
      if (c === ';' || c === '{' || c === '}') flush(i);
      if (!/\s/.test(c)) { prev = /[\w$]/.test(c) ? (/[\w$]/.test(prev.slice(-1)) ? prev + c : c) : c; if (prev.length > 8) prev = prev.slice(-8); }
      i++; }
    flush(s.length);
    for (const t of stmts) { if (!t.lits.some(l => /<\/?[a-zA-Z][a-zA-Z0-9]*[\s>\/]|<\/?[a-z]+$|^[a-z]*>/.test(l))) continue;
      const txt = s.slice(t.s, t.e); if (/textContent\s*=|\.value\s*=|confirm\(|toast\(|prompt\(|alert\(|P\.(text|wrap)/.test(txt) && !/innerHTML|html\s*\+?=|\bh\s*\+?=|return\s*'</.test(txt)) continue;
      let m; val.lastIndex = 0; while ((m = val.exec(txt))) { const start = m.index + m[0].indexOf(m[1] || m[2]); if (inEsc(txt, start)) continue; out.push(txt.slice(Math.max(0, m.index - 50), m.index + m[0].length + 20).replace(/\n/g, ' ')); } } }
  return out;
}
test('XSS : noms, références, adresses… toujours échappés (esc) dans le HTML de l\'appli', () => {
  const r = unescapedHtml(uiHtml, 'ref|nom|prenom|nom2|prenom2|email|tel|adresse|desc|banque|presta|msg|sub|label|titre|batiment|garantNom|lotRef|regime|type|contrat|libelle|cat|mode|surface');
  assert.equal(r.length, 0, r.length + ' valeur(s) non échappée(s), ex. : ' + r.slice(0, 3).join(' ║ '));
  assert.ok(!/'\+\(DB\.notes\[[^\]]+\]\|\|''\)\+'/.test(uiHtml), 'note locataire non échappée dans le textarea');
  const e = vm.createContext({}); vm.runInContext(extractUI('esc') + ';this.esc=esc;', e);
  assert.equal(e.esc('<img src=x onerror="a">\'&'), '&lt;img src=x onerror=&quot;a&quot;&gt;&#39;&amp;');
});
test('visionneuse : un document qui n\'est ni PDF ni image s\'ouvre dans un cadre isolé (sandbox)', () => {
  const v = { style: {}, classList: { add() {} } };
  const c = vm.createContext({ document: { getElementById: () => null, createElement: () => v, body: { appendChild() {}, classList: { add() {} } } }, navigator: {}, viewerRenderPdf() {} });
  vm.runInContext(extractUI('esc') + '\n' + extractUI('showViewer') + ';this.showViewer=showViewer;', c);
  c.showViewer('blob:https://x/1', 'piege.html', 'text/html', null);
  assert.match(v.innerHTML, /<iframe[^>]*\ssandbox[\s>=]/, 'iframe de même origine sans sandbox'); assert.ok(!/allow-scripts|allow-same-origin/.test(v.innerHTML));
  c.showViewer('blob:https://x/2', 'photo.jpg', 'image/jpeg', null); assert.match(v.innerHTML, /<img /);
  assert.match(extractUI('viewerRenderPdf'), /sandbox/, 'cadre de secours du PDF sans sandbox pour un autre type');
});
test('synchro : démarrage hors ligne → la 1re modification reçoit un _ts (photo prise au chargement)', () => {
  const store = { immogest_v4: JSON.stringify({ logements: [{ id: 'l1', loyer: 500, _ts: 100 }], settings: { a: 1, _ts: 100 } }) };
  const c = vm.createContext({ localStorage: { getItem: k => store[k] || null, setItem() {} } });
  vm.runInContext('var SK="immogest_v4";var DB={charges:[],prets:[],logements:[],settings:{}};var _snapCache={};' + extractUI('touchTimestamps') + '\n' + extractUI('loadPersisted') + ';this.lp=loadPersisted;this.tt=touchTimestamps;this.db=function(){return DB;};', c);
  assert.equal(c.lp(), true); const DB = c.db();
  DB.logements[0].loyer = 520; c.tt();
  assert.ok(DB.logements[0]._ts > 100, '_ts non mis à jour : la modification perdrait contre le serveur');
});
test('fusion des réglages et notes clé par clé (identique appli / serveur), compatible avec un appareil v150', () => {
  const mergeCtx = vm.createContext({});
  vm.runInContext(['const ARR_KEYS=' + arrKeys + ';', extract('mergeArr'), extract('mergeObj'), extract('mergeDB'), 'this.mergeDB=mergeDB;this.mergeObj=mergeObj;'].join('\n'), mergeCtx);
  assert.equal(extractUI('mergeObj'), extract('mergeObj'), 'mergeObj diffère entre appli et serveur');
  const M = (s, c) => mergeCtx.mergeDB({ settings: s }, { settings: c }).settings;
  // appareil v150 (objet entier, sans _kts) : sa modification de « a » est gardée, la modification de « b » faite ailleurs aussi
  let r = M({ a: 1, b: 2, _ts: 10, _kts: { b: 10 } }, { a: 5, b: 1, _ts: 20 });
  assert.equal(r.a, 5); assert.equal(r.b, 2);
  // deux appareils récents : chacun sa clé
  r = M({ a: 'A2', b: 'B1', _ts: 20, _kts: { a: 20 } }, { a: 'A1', b: 'B2', _ts: 25, _kts: { b: 25 } });
  assert.equal(r.a, 'A2'); assert.equal(r.b, 'B2'); assert.equal(r._ts, 25);
  // sans _kts nulle part : ancienne règle (l'objet le plus récent gagne, clés absentes comprises)
  r = M({ a: 1, x: 9, _ts: 10 }, { a: 2, _ts: 20 }); assert.equal(r.a, 2); assert.ok(!('x' in r));
  r = M({ a: 1, _ts: 30 }, { a: 2, _ts: 20 }); assert.equal(r.a, 1);
  // suppression datée d'une note
  const n = mergeCtx.mergeDB({ notes: { n1: 'x', n2: 'y', _ts: 10, _kts: { n1: 10 } } }, { notes: { n2: 'y', _ts: 20, _kts: { n1: 20 } } }).notes;
  assert.ok(!('n1' in n)); assert.equal(n.n2, 'y');
});
test('appli : la modification d\'un réglage est datée clé par clé (_kts)', () => {
  const c = vm.createContext({}); vm.runInContext('var DB={settings:{a:1,b:2,_ts:5},notes:{}};var _snapCache={};' + extractUI('touchTimestamps') + ';this.tt=touchTimestamps;this.db=function(){return DB;};', c);
  c.tt(true); c.db().settings.b = 3; c.tt();
  const s = c.db().settings; assert.ok(s._kts && s._kts.b > 5, 'pas de date pour la clé modifiée'); assert.ok(!s._kts.a); assert.ok(s._ts > 5);
});
test('fiche lot : loyer ou surface à 0 enregistrés ; champ vide = valeur inchangée', () => {
  const run = (vals) => { const l = { id: 'l1', ref: 'A1', loyer: 500, surface: 30, charges: 50, statut: 'Occupé' }, els = {};
    Object.keys(vals).forEach(k => els[k] = { value: vals[k] });
    const c = vm.createContext({ gLog: () => l, gLogLoc: () => null, gv: id => (els[id] || { value: '' }).value, persist() {}, cM() {}, refreshCurrentView() {}, buildSidebar() {}, toast() {}, openSortie() {}, logChDetailSave() {} });
    vm.runInContext('var DB={_editLogId:"l1"};' + (uiHtml.includes('function numOr(') ? extractUI('numOr') : '') + '\n' + ['lotMoisNext','lotLoyerDefMois','lotSetLoyer'].map(extractUI).join('\n') + '\nvar NOW=new Date("2026-11-15T12:00:00Z");DB.paiements=[];qMoisLabel=function(m){return m;};\n' + extractUI('saveLog') + ';this.saveLog=saveLog;', c); c.saveLog(); return l; };
  const base = { 'log-ref': 'A1', 'log-type': 'T1', 'log-etage': '', 'log-charges': '50', 'log-statut': 'Occupé', 'log-meuble': 'Non', 'log-dpe': '', 'log-ext': '', 'log-ep': '', 'log-ep-nom': '' };
  let l = run(Object.assign({}, base, { 'log-loyer': '0', 'log-surface': '0' })); assert.equal(l.loyer, 0); assert.equal(l.surface, 0);
  l = run(Object.assign({}, base, { 'log-loyer': '', 'log-surface': '' })); assert.equal(l.loyer, 500); assert.equal(l.surface, 30);
  l = run(Object.assign({}, base, { 'log-loyer': '512,5', 'log-surface': '31' })); assert.equal(l.loyer, 512.5); assert.equal(l.surface, 31);
});
test('sommes robustes (loyer, capital restant dû, date du jour) : même calcul dans l\'appli et sur le serveur', () => {
  ['gBatLoyer', 'gPretR', 'calAm', 'isoToday'].forEach(n => assert.equal(extractUI(n), extract(n), n + ' diffère entre appli et serveur'));
  const c = vm.createContext({}); vm.runInContext('var NOW=new Date("2026-11-19T10:00:00Z");' + ['calMens', 'calAm', 'calAmRow', 'gPretR'].map(extract).join('\n') + ';this.r=gPretR;', c);
  const v = c.r({ capital: 120000, duree: 240, debut: '2024-01-05' }); assert.ok(isFinite(v) && v > 0 && v < 120000, 'CRD sans taux : ' + v);
  assert.equal(c.r({ hasSchedule: true, schedule: [{ date: '2026-11-05', principal: 1, interest: 1, total: 2 }] }), 0);
});
test('serveur : date du jour à l\'heure de Paris (le 31/10 à 23 h 30 UTC, on est le 1er novembre)', () => {
  const c = vm.createContext({}); vm.runInContext(extract('parisParts') + '\n' + extract('parisToday') + '\n' + extract('parisNow') + ';this.t=parisToday;this.n=parisNow;', c);
  assert.equal(c.t(Date.UTC(2026, 9, 31, 23, 30)), '2026-11-01'); assert.equal(c.t(Date.UTC(2026, 6, 14, 22, 30)), '2026-07-15'); assert.equal(c.t(Date.UTC(2026, 6, 14, 21, 30)), '2026-07-14');
  const n = c.n(Date.UTC(2026, 9, 31, 23, 30)); assert.equal(n.getMonth(), 10); assert.equal(n.getDate(), 1);
  const server = src.split('\n').filter((l, i) => i !== 9).join('\n');
  assert.ok(!/new Date\(\)\.toISOString\(\)\.slice\(0,(7|10)\)/.test(server), 'date du jour encore calculée en UTC');
  assert.ok(server.includes('makeEngine(d,parisNow())'));
});
// ── Non-régression v153 : boucle de synchro (doublons « Impayé » de l'ancien locataire) et bugs vus par le test d'interface v151
const same = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m); // tableaux venant d'un autre contexte vm
function uiRun(names, DB, extra = '', els = {}) {
  const c = vm.createContext({ toast: (m) => { c.__toasts.push(m); }, __toasts: [], persist: () => { c.__persist++; }, __persist: 0, updateNB: () => {}, cM: () => {}, rBat: () => {}, rLoyers: () => {},
    requestAnimationFrame: () => {}, uid: () => 'u' + Math.random().toString(36).slice(2), confirm: () => true,
    gv: id => (els[id] || {}).value || '', document: { getElementById: id => els[id] || null, querySelector: () => null } });
  c.__DB = DB; vm.runInContext('var NOW=new Date("2026-11-19T10:00:00Z");var DB=this.__DB;var _VIEWMODE=false;' + names.map(extractUI).join('\n') + '\n' + extra, c); return c;
}
const ancDB = () => ({ logements: [{ id: 'l1', batId: 'b1', ref: 'Studio 1', loyer: 500, charges: 50, statut: 'Vacant' }], locataires: [], paiements: [], _tomb: {},
  anciens: [{ id: 'anc1', logId: 'l1', prenom: 'Anthony', nom: 'Collet', entree: '2025-01-01', sortie: '2026-11-15', sortieSaisie: true }] });
const SOLDE = ['gLog', 'gLogLoc', 'isLotOcc', 'prorataJours', 'soldeProrataDepart', 'soldeSortieNotee', 'reparerProrataDeparts'];
test('boucle de synchro : soldeSortieNotee appelée deux fois → 0 au second appel, aucune ligne en double', () => {
  const DB = ancDB(), c = uiRun(SOLDE, DB), a = DB.anciens[0];
  assert.ok(c.soldeSortieNotee(a) > 0, '1er appel : la ligne du mois de sortie est créée');
  assert.equal(DB.paiements.length, 1); const p = DB.paiements[0]; near(p.du, 275); // 550 × 15/30 assert.equal(p.ancId, 'anc1');
  const snap = JSON.stringify(DB.paiements);
  assert.equal(c.soldeSortieNotee(a), 0, '2e appel : rien ne change'); assert.equal(c.soldeSortieNotee(a), 0);
  assert.equal(DB.paiements.length, 1, 'ligne recréée à chaque synchro'); assert.equal(JSON.stringify(DB.paiements), snap);
});
test('boucle de synchro : reparerProrataDeparts idempotent (une ligne existante sans ancId est rattachée une seule fois)', () => {
  const DB = ancDB(); DB.paiements.push({ id: 'p1', logId: 'l1', mois: '2026-11', montant: 0, statut: 'En attente', versements: [] }, { id: 'p0', logId: 'l1', mois: '2026-10', montant: 550, statut: 'Payé', versements: [{ montant: 550 }] });
  const c = uiRun(SOLDE, DB);
  assert.ok(c.reparerProrataDeparts() > 0); const snap = JSON.stringify(DB.paiements);
  for (let i = 0; i < 5; i++) assert.equal(c.reparerProrataDeparts(), 0, 'appel ' + (i + 2) + ' : persist relancé');
  assert.equal(DB.paiements.length, 2); assert.equal(JSON.stringify(DB.paiements), snap);
});
const dupRows = (n, extra) => Array.from({ length: n }, (_, i) => Object.assign({ id: 'd' + String(i).padStart(3, '0'), logId: 'l1', mois: '2026-11', montant: 0, du: 266.13, prorata: true, statut: 'Impayé', versements: [], locNom: 'Anthony Collet', ancId: 'anc1', _ts: 1000 + i }, extra || {}));
const DEDUP = ['dedupPaiAnc', 'nettoyerDoublonsPai'];
test('nettoyage : 50 doublons vides + 1 ligne payée → la ligne payée seule est conservée, 50 tombstones', () => {
  const DB = ancDB(); DB.paiements = dupRows(50).concat([{ id: 'pay', logId: 'l1', mois: '2026-11', montant: 266.13, du: 266.13, statut: 'Payé', versements: [{ montant: 266.13, date: '2026-11-10' }], ancId: 'anc1', _ts: 5 },
    { id: 'autre', logId: 'l1', mois: '2026-10', montant: 0, statut: 'Impayé', versements: [], ancId: 'anc1', _ts: 7 }, { id: 'nouv', logId: 'l1', mois: '2026-11', montant: 0, statut: 'En attente', versements: [], _ts: 8 }]);
  const c = uiRun(DEDUP, DB);
  assert.equal(c.nettoyerDoublonsPai(), 50);
  same(DB.paiements.map(p => p.id), ['pay', 'autre', 'nouv'], 'ligne payée, autre mois et ligne du nouvel entrant intacts');
  assert.equal(Object.keys(DB._tomb).length, 50); dupRows(50).forEach(p => assert.ok(DB._tomb[p.id] >= p._ts, 'tombstone ' + p.id));
  assert.equal(c.nettoyerDoublonsPai(), 0, 'idempotent');
});
test('nettoyage : 50 doublons vides sans paiement → la plus ancienne est gardée, 49 supprimées', () => {
  const DB = ancDB(); DB.paiements = dupRows(50).reverse(); const c = uiRun(DEDUP, DB);
  assert.equal(c.nettoyerDoublonsPai(), 49); assert.equal(DB.paiements.length, 1); assert.equal(DB.paiements[0].id, 'd000');
  assert.equal(Object.keys(DB._tomb).length, 49); assert.ok(!DB._tomb.d000);
});
test('nettoyage : une ligne avec versements, montant, montant ajusté, date ou note n\'est jamais supprimée', () => {
  const DB = ancDB(); DB.paiements = [dupRows(1, { id: 'v1', versements: [{ montant: 0, date: '2026-11-02' }] })[0], dupRows(1, { id: 'v2', versements: [{ montant: 100 }] })[0],
    dupRows(1, { id: 'm1', montant: 50 })[0], dupRows(1, { id: 'dm', duManuel: true, du: 200 })[0], dupRows(1, { id: 'dt', date: '2026-11-03' })[0], dupRows(1, { id: 'nt', note: 'arrangement' })[0]];
  const c = uiRun(DEDUP, DB);
  assert.equal(c.nettoyerDoublonsPai(), 0); assert.equal(DB.paiements.length, 6); assert.equal(Object.keys(DB._tomb).length, 0);
});
test('nettoyage des doublons : même règle dans l\'appli et sur le serveur', () => {
  assert.equal(extractUI('dedupPaiAnc'), extract('dedupPaiAnc'));
});
test('fusion : un appareil resté en v150-v152 qui renvoie les doublons supprimés ne les ressuscite pas', () => {
  const rows = dupRows(50), tomb = {}; rows.slice(1).forEach(p => { tomb[p.id] = 2000; });
  const server = { paiements: [rows[0]], tomb }, old = { paiements: rows, tomb: {} };
  const m = mergeDB(server, old); same(m.paiements.map(p => p.id), ['d000']);
});
test('fiche ancien locataire : ne liste pas le paiement du nouvel entrant du mois de sortie (appli et serveur)', () => {
  const a = { id: 'anc1', logId: 'l1', entree: '2025-01-01', sortie: '2026-11-15' };
  const pais = [{ id: 'own', logId: 'l1', mois: '2026-11', montant: 266.13, ancId: 'anc1' }, { id: 'new', logId: 'l1', mois: '2026-11', montant: 290 }, { id: 'old', logId: 'l1', mois: '2026-05', montant: 550 },
    { id: 'apr', logId: 'l1', mois: '2026-12', montant: 550 }, { id: 'x', logId: 'l2', mois: '2026-05', montant: 1 }];
  const locs = [{ id: 't2', logId: 'l1', entree: '2026-11-16' }];
  const cs = vm.createContext({}), cu = vm.createContext({});
  vm.runInContext(extract('ancPaiFiltre') + ';this.f=ancPaiFiltre;', cs); vm.runInContext(extractUI('ancPaiFiltre') + ';this.f=ancPaiFiltre;', cu);
  [cs.f, cu.f].forEach(f => {
    same(f(a, pais, locs).map(p => p.id).sort(), ['old', 'own']);
    same(f(a, pais.filter(p => p.id !== 'own'), locs).map(p => p.id), ['old'], 'nouvel entrant entré le 16 : sa ligne n\'est pas celle du sortant');
    same(f(a, pais.filter(p => p.id !== 'own'), []).map(p => p.id).sort(), ['new', 'old'], 'ancienne donnée sans ancId ni nouvel entrant : conservée');
  });
  assert.equal(extract('ancPaiFiltre'), extractUI('ancPaiFiltre'));
  assert.ok(/ancPaiFiltre\(a,DB\.paiements,DB\.locataires\)/.test(extractUI('ancPais')), 'ancPais utilise ancPaiFiltre');
});
const PAI_FN = ['gLog', 'gBat', 'gLogLoc', 'paiOf', 'paiDu', 'duMois', 'lotLoyerAt', 'lotMoisNext', 'lotLoyerDefMois', 'lotSetLoyer', 'prorataJours', 'locMoisListe', 'majStatutLoc', 'r2', 'fmt', 'fmtC', 'savePai'];
test('enregistrer un paiement : « Payé » choisi à la main pour 400 € sur 550 € dus → Partiel', () => {
  const DB = uiDB(); DB.batiments = []; DB._cl = 'l1'; DB._cv = {};
  const els = { 'pai-mois': { value: '2026-10' }, 'pai-montant': { value: '400' }, 'pai-date': { value: '2026-10-05' }, 'pai-mode': { value: 'Virement' }, 'pai-statut': { value: 'Payé' } };
  uiRun(PAI_FN, DB, '', els).savePai(); const p = DB.paiements[0];
  assert.equal(p.montant, 400); assert.equal(p.statut, 'Partiel');
  els['pai-montant'].value = '550'; els['pai-statut'].value = 'Partiel'; uiRun(PAI_FN, DB, '', els).savePai();
  assert.equal(DB.paiements.length, 1); assert.equal(DB.paiements[0].statut, 'Payé', '550 sur 550 : Payé même si « Partiel » est choisi');
});
test('« + Paiement » global : pas de paiement sans lot ; le lot choisi dans la liste est utilisé', () => {
  const DB = uiDB(); DB.batiments = []; DB._cl = null; DB._cv = {};
  const els = { 'pai-mois': { value: '2026-10' }, 'pai-montant': { value: '550' }, 'pai-date': { value: '2026-10-05' }, 'pai-mode': { value: 'Virement' }, 'pai-statut': { value: 'Payé' }, 'pai-lot': { value: '' } };
  let c = uiRun(PAI_FN, DB, '', els); c.savePai();
  assert.equal(DB.paiements.length, 0, 'paiement créé sans lot'); assert.ok(c.__toasts.some(t => /lot/i.test(t)));
  els['pai-lot'].value = 'l1'; DB._cl = null; uiRun(PAI_FN, DB, '', els).savePai();
  assert.equal(DB.paiements.length, 1); assert.equal(DB.paiements[0].logId, 'l1'); assert.equal(DB.paiements[0].statut, 'Payé');
});
test('charges annuelles (tableau de bord, statistiques, patrimoine, onglet Charges) : une charge ponctuelle n\'est pas annuelle', () => {
  const DB = { batiments: [{ id: 'b1' }], charges: [{ id: 'c1', batId: 'b1', freq: 'Ponctuelle', montant: 8000 }, { id: 'c2', batId: 'b1', freq: 'Annuelle', montant: 300 }, { id: 'c3', batId: 'b1', freq: 'Mensuelle', montant: 10 }, { id: 'c4', batId: 'b1', freq: 'Trimestrielle', montant: '25' }] };
  const c = uiRun(['gBat', 'gBatCh', 'gBatChAn'], DB); assert.equal(c.gBatChAn('b1'), 300 + 120 + 100);
});
test('Loyers du mois : reste par lot = dû réel du mois − reçu ; « Attendu HC » au prorata comme le CC', () => {
  const c = uiRun(['duHC'], {}); near(c.duHC({ loyer: 500, charges: 50 }, 266.13), 241.94); assert.equal(c.duHC({ loyer: 0, charges: 0 }, 0), 0); assert.equal(c.duHC({ loyer: 500, charges: 50 }, 550), 500);
  const rl = extractUI('rLoyers');
  assert.ok(!rl.includes('var due=r.l.loyer+(r.l.charges||0)'), 'reste calculé sur loyer + charges au lieu du dû du mois');
  assert.ok(!rl.includes('return a+r.l.loyer;},0);\n  var occ'), 'Attendu HC non proratisé');
});
test('montants au centime : 283,87 € et non 284 € (confirmation d\'encaissement, ligne du mois)', () => {
  const c = uiRun(['fmt', 'fmtC'], {}); assert.equal(c.fmtC(283.87), '283,87 €'); assert.equal(c.fmt(283.87, 1), '283,87 €'); assert.equal(c.fmt(283.87), '284 €', 'fmt sans option inchangé'); assert.match(c.fmtC(550), /^550 €$/); assert.match(c.fmtC(1200.5), /^1\s?200,50 €$/);
  assert.ok(extractUI('quickPay').includes("encaissement de '+fmt(reste,1)"), 'confirmation d\'encaissement arrondie à l\'euro');
  assert.ok(uiHtml.includes("min-width:60px;text-align:right;\">'+fmtC(reste)") && uiHtml.includes("(r.pai&&r.pai.montant>0?fmtC(r.pai.montant)") && uiHtml.includes("(p.montant>0?fmtC(p.montant):'—')"), 'récapitulatif, ligne du mois et fiche ancien au centime');
});
test('message de quittance : « d\'octobre », « d\'août » (élision), « de novembre » (appli et serveur)', () => {
  ['ui', 'srv'].forEach(w => {
    const ex = w === 'ui' ? extractUI : extract, c = vm.createContext({});
    vm.runInContext(['prenomFeminin', 'locCivilite', 'quittMsgTexte'].map(ex).join('\n') + ';this.f=quittMsgTexte;', c);
    const loc = { id: 't1', civilite: 'Monsieur', prenom: 'Jean', nom: 'Dupont' };
    const o = c.f(loc, 'octobre 2026', false, 'X', false), a = c.f(loc, 'août 2026', false, 'X', false), n = c.f(loc, 'novembre 2026', false, 'X', false);
    assert.ok(/d'octobre 2026/.test(o) && !/de octobre/.test(o), w + ' : ' + o); assert.ok(/d'août 2026/.test(a) && !/de août/.test(a), w); assert.ok(/de novembre 2026/.test(n), w);
  });
});
test('durée d\'occupation : 01/01/2024 → 31/12/2026 = 3 ans (dernier jour inclus)', () => {
  const c = uiRun(['ancDuree'], {}); assert.equal(c.ancDuree({ entree: '2024-01-01', sortie: '2026-12-31' }), '3 ans');
  assert.equal(c.ancDuree({ entree: '2025-01-01', sortie: '2026-11-15' }), '1 an 10 mois'); assert.equal(c.ancDuree({ entree: '2026-01-01', sortie: '2026-06-30' }), '6 mois');
});
test('libellé « prorata » seulement si le mois est réellement partiel (entrée le 1er ou sortie le dernier jour : mois complet)', () => {
  const c = uiRun(['jourPartiel'], {});
  assert.equal(c.jourPartiel('2026-10', '2026-10-01', false), false); assert.equal(c.jourPartiel('2026-10', '2026-10-16', false), true);
  assert.equal(c.jourPartiel('2026-10', '2026-10-31', true), false); assert.equal(c.jourPartiel('2026-10', '2026-10-15', true), true);
  assert.equal(c.jourPartiel('2026-11', '2026-10-16', false), false); assert.equal(c.jourPartiel('2026-10', '', false), false);
  assert.ok(!/\(p\.prorata\?' \(prorata\)':''\)/.test(uiHtml), 'fiche ancien : (prorata) affiché pour un mois complet');
  assert.ok(!uiHtml.includes(":'prorata';\n"), 'modale d\'encaissement : « prorata » par défaut');
});
test('prêt : mensualité affichée assurance comprise, avec la part hors assurance précisée', () => {
  assert.ok(/dont assurance/.test(uiHtml) && /hors assurance/.test(uiHtml));
});
// ── v165 : robustesse de l'interface, performance, service worker, contrôle de syntaxe
async function atest(name, fn) { try { await fn(); passed++; console.log('✓ ' + name); } catch (e) { failed++; console.error('✗ ' + name + '\n   ' + e.message); } }
test('échéancier de prêt : dates formatées par un Intl.DateTimeFormat en cache, résultat identique à toLocaleDateString (appli et serveur)', () => {
  assert.ok(/DateTimeFormat/.test(extractUI('calAm')), 'formateur de date recréé à chaque ligne (lent sur 35 prêts × 240 mois)');
  assert.equal(extractUI('calAm'), extract('calAm'));
  const ref = 'function calAmRef(p){if(Array.isArray(p.schedule)&&p.schedule.length){return p.schedule.map(function(row,i){var d=new Date(row.date);return{n:i+1,date:d.toLocaleDateString(\'fr-FR\',{month:\'short\',year:\'numeric\'}),intr:row.interest,am:row.principal,m:row.total,r:Math.max(0,+row.balance||0)};});}'
    + 'var t=(+p.taux||0)/100/12,m=calMens(+p.capital||0,+p.taux||0,+p.duree||0),rows=[],r=+p.capital||0,sd=new Date(p.debut);for(var i=1;i<=(+p.duree||0);i++){var intr=r*t,am=m-intr;r-=am;var d=new Date(sd);d.setMonth(d.getMonth()+i-1);rows.push({n:i,date:d.toLocaleDateString(\'fr-FR\',{month:\'short\',year:\'numeric\'}),intr:intr,am:am,m:m,r:Math.max(0,r)});}return rows;}';
  for (const get of [extractUI, extract]) {
    const c = vm.createContext({}); vm.runInContext([get('calMens'), get('calAm'), ref, 'this.calAm=calAm;this.calAmRef=calAmRef;'].join('\n'), c);
    for (const p of [{ capital: 400000, taux: 1.6, duree: 240, debut: '2019-07-05' }, { capital: 1000, taux: 0, duree: 3, debut: 'pas une date' },
      { hasSchedule: true, schedule: [{ date: '2027-08-05', interest: 10, principal: 90, total: 100, balance: 900 }, { date: '', interest: 0, principal: 0, total: 0, balance: 0 }] }])
      assert.equal(JSON.stringify(c.calAm(p)), JSON.stringify(c.calAmRef(p)));
    assert.equal(c.calAm({ capital: 400000, taux: 1.6, duree: 240, debut: '2019-07-05' })[0].date, 'juil. 2019');
  }
});
test('service worker : /api/, /mcp et /oauth ne passent jamais par le cache (données privées), la page oui', () => {
  const sw = Buffer.from(src.match(/const SW_B64='([A-Za-z0-9+/=]+)'/)[1], 'base64').toString('utf8');
  const L = {}, self = { location: { origin: 'https://x.test' }, addEventListener: (t, f) => { L[t] = f; }, skipWaiting() {}, clients: { claim() {} } };
  vm.runInNewContext(sw, { self, caches: { open: () => Promise.resolve({ put() {} }), match: () => Promise.resolve(null), keys: () => Promise.resolve([]) }, fetch: () => Promise.resolve({ status: 200, type: 'basic', clone() { return this; } }), URL });
  const ev = u => { const e = { request: { method: 'GET', url: 'https://x.test' + u }, n: 0, respondWith() { e.n++; } }; L.fetch(e); return e.n; };
  for (const u of ['/api/data', '/api/backup?day=2026-11-22', '/api/files/f1/raw', '/mcp', '/oauth/authorize', '/.well-known/oauth-authorization-server']) assert.equal(ev(u), 0, u + ' mis en cache');
  assert.equal(ev('/'), 1); assert.equal(ev('/manifest.json'), 1);
});
const exA = n => { const i = uiHtml.indexOf('function ' + n + '('); return (uiHtml.slice(i - 6, i) === 'async ' ? 'async ' : '') + extractUI(n); }; // garde « async »
const uiCtx2 = (names, extra = {}) => { const c = vm.createContext(Object.assign({ __t: [], toast(m, e) { c.__t.push([m, !!e]); }, API: { token: 't' }, saveAuth() {}, sessionExpired() {}, window: {}, console: { error() {}, log() {} } }, extra));
  vm.runInContext(names.map(exA).join('\n'), c); return c; };
await atest('api() : réseau coupé → {_status:0, error:"Hors ligne"} au lieu d\'une exception', async () => {
  const c = uiCtx2(['api'], { fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
  const r = await c.api('/api/devices'); assert.equal(r._status, 0); assert.equal(r.error, 'Hors ligne'); assert.ok(!r.ok);
});
await atest('synchro hors ligne : envoi gardé en attente, pas d\'alerte « synchronisation en échec »', async () => {
  let toasts = 0; const c = uiCtx2(['_syncPushImpl'], { _VIEWMODE: false, _pendingPush: false, SYNC: {}, setSS() {}, dbPayload: () => ({}), syncErrToast() { toasts++; }, api: async () => ({ _status: 0, error: 'Hors ligne' }) });
  vm.runInContext('var _pendingPush=false,_lastPullAt=0;', c);
  await c._syncPushImpl(); assert.equal(vm.runInContext('_pendingPush', c), true); assert.match(c.SYNC.lastError, /Hors ligne/); assert.equal(toasts, 0);
});
await atest('hors ligne : aucun appelant de api() n\'annonce un succès (connecteur, e-mails, appareils, documents)', async () => {
  const off = async () => ({ _status: 0, error: 'Hors ligne' }), el = { innerHTML: '' };
  const c = uiCtx2(['btnBusy', 'btnFree', 'uiErr', 'setMcp', 'revokeMcp', 'clearMailCfg', 'revokeDevice', 'revokeFace', 'delDoc', 'annDel', 'annFirst'], { api: off, confirm: () => true, loadMcp() {}, drawMailCard() { c.__drawn = 1; }, loadDevices() {}, rParams() {}, loadLocDocs() {}, annLoadPhotos() {}, bioName: () => 'Face ID', updFaceBtn() {},
    _ann: { photos: [{ id: 'p0', ord: 0 }, { id: 'p1', ord: 1 }] }, isO: () => true, esc: s => String(s), document: { getElementById: () => el } });
  vm.runInContext('var _mailCfg={configured:true};', c);
  c.setMcp(true); c.revokeMcp('x'); c.clearMailCfg(); await c.revokeDevice('d'); await c.revokeFace('f'); await c.delDoc('f', 'l'); await c.annDel(0); await c.annFirst(1);
  await new Promise(r => setTimeout(r, 10));
  assert.ok(c.__t.length >= 8, 'toasts : ' + JSON.stringify(c.__t)); c.__t.forEach(([m, e]) => assert.ok(e, 'succès annoncé hors ligne : ' + m));
  assert.equal(vm.runInContext('_mailCfg.configured', c), true, 'configuration e-mail effacée de l\'écran alors que rien n\'a été fait');
});
const FIN = ['savePINs', 'ribDocBlob', 'delDoc', 'annDel', 'annFirst', 'mailBackupNow', 'doRestore', 'revokeDevice', 'revokeFace', 'loadShares', 'revokeShare'];
await atest('actions asynchrones : erreur interceptée et bouton réactivé (finally) dans les 11 fonctions', async () => {
  FIN.forEach(n => assert.ok(/finally\{/.test(extractUI(n)), n + ' sans finally'));
  const btn = { disabled: false, dataset: {}, tagName: 'BUTTON' };
  const c = uiCtx2(['btnBusy', 'btnFree', 'uiErr', 'mailBackupNow', 'revokeShare', 'loadShares'], { api: () => Promise.reject(new Error('panne')), loadDevices() {}, window: {}, document: { getElementById: () => ({ innerHTML: '' }) }, pdE: s => s });
  await c.mailBackupNow(btn); assert.equal(btn.disabled, false, 'bouton resté désactivé'); assert.ok(c.__t.some(([m, e]) => e && /panne/.test(m)));
  btn.dataset.armed = '1'; await c.revokeShare('s1', btn); assert.equal(btn.disabled, false);
  await c.loadShares(); // ne lève pas
  const c2 = uiCtx2(['btnBusy', 'btnFree', 'ribDocBlob'], { fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
  await assert.rejects(c2.ribDocBlob({ ribFileId: 'f' }), /Hors ligne/);
});
test('erreurs inattendues : toast discret (une fois par période) via unhandledrejection et error', () => {
  assert.ok(/addEventListener\('unhandledrejection'/.test(uiHtml) && /window\.addEventListener\('error'/.test(uiHtml));
  let now = 1e12; const c = uiCtx2(['uiErrToast'], { Date: { now: () => now } }); vm.runInContext('var _uiErrAt=0;', c);
  c.uiErrToast(new Error('a')); c.uiErrToast(new Error('b')); assert.equal(c.__t.length, 1); now += 60000; c.uiErrToast('c'); assert.equal(c.__t.length, 2);
  c.uiErrToast({ name: 'AbortError', message: 'x' }); now += 60000; c.uiErrToast({ name: 'NotAllowedError' }); assert.equal(c.__t.length, 2, 'annulation de l\'utilisateur signalée comme erreur');
});
test('mémoire de l\'appareil pleine : indicateur permanent tant que l\'écriture locale échoue, retiré quand elle réussit', () => {
  let full = true; const nodes = {}, body = { appendChild(n) { nodes[n.id] = n; n.remove = () => { delete nodes[n.id]; }; } };
  const c = uiCtx2(['writeLocal', 'lsWarn'], { _VIEWMODE: false, SK: 'k', DB: {}, localStorage: { setItem() { if (full) throw new Error('QuotaExceededError'); } },
    document: { body, getElementById: id => nodes[id] || null, createElement: () => ({ style: {}, setAttribute() {} }) } });
  vm.runInContext('var _storageWarned=false;', c);
  assert.equal(c.writeLocal(), false); assert.ok(nodes['ls-warn'], 'pas d\'indicateur'); assert.match(nodes['ls-warn'].textContent, /mémoire/i);
  c.writeLocal(); assert.equal(Object.keys(nodes).length, 1); assert.equal(c.__t.length, 1, 'un seul toast');
  full = false; assert.equal(c.writeLocal(), true); assert.equal(nodes['ls-warn'], undefined, 'indicateur non retiré');
});
test('sauvegarde du serveur en échec : bandeau du tableau de bord (propriétaire) et Paramètres', () => {
  const c = uiCtx2(['bkErrHtml'], { isO: () => true, _VIEWMODE: false, esc: s => String(s).replace(/</g, '&lt;'), SYNC: { bkErr: { at: Date.UTC(2026, 10, 22, 8), day: '2026-11-22', message: 'quota <dépassé>' } } });
  const h = c.bkErrHtml(); assert.match(h, /sauvegarde/i); assert.ok(h.includes('quota &lt;dépassé>'));
  c.SYNC.bkErr = null; assert.equal(c.bkErrHtml(), '');
  assert.ok(/bkErrHtml\(\)/.test(extractUI('rDash')), 'bandeau absent du tableau de bord'); assert.ok(/backupErr/.test(extractUI('loadDevices')));
  assert.ok(/SYNC\.bkErr=/.test(extractUI('_syncPushImpl')) && /SYNC\.bkErr=/.test(extractUI('_syncPullImpl')));
});
await atest('contrôle de syntaxe : chaque <script> de l\'interface et worker.js compilent (tests/check-ui.mjs)', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [new URL('./check-ui.mjs', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
test('Statut de paiement : pas de « Retard » pour les mois antérieurs au suivi du lot dans l\'appli (Studio K)', () => {
  const DB = { logements: [{ id: 'K', loyer: 395, charges: 0 }], locataires: [{ id: 'm', logId: 'K', entree: '2025-11-21', statutPaiement: 'Retard' }], baux: [],
    paiements: ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11'].map(mo => ({ logId: 'K', mois: mo, montant: 395, du: 395 })) };
  const c = uiRun(['gLog', 'gLogLoc', 'paiDu', 'duMois', 'lotLoyerAt', 'lotMoisNext', 'lotLoyerDefMois', 'lotSetLoyer', 'prorataJours', 'locMoisListe', 'majStatutLoc'], DB);
  c.majStatutLoc(DB.locataires[0]);
  assert.equal(DB.locataires[0].statutPaiement, 'À jour');
  DB.paiements[2].montant = 0; c.majStatutLoc(DB.locataires[0]);
  assert.equal(DB.locataires[0].statutPaiement, 'Retard'); // un vrai mois impayé reste détecté
});
test('Quittance : limitée au bail du locataire actuel ; ancien locataire sur ses propres dates', () => {
  const DB = { logements: [{ id: 'L', loyer: 420, charges: 20 }], locataires: [{ id: 'c', logId: 'L', entree: '2026-10-20' }], paiements: [], baux: [] };
  const c = uiRun(['gLog', 'gLogLoc', 'paiDu', 'duMois', 'lotLoyerAt', 'lotMoisNext', 'lotLoyerDefMois', 'lotSetLoyer', 'prorataJours', 'qMoisFin', 'qDuM'], DB);
  const anc = { locId: 'old', logId: 'L', entree: '2024-03-10', sortie: '2026-10-15' };
  near(c.qDuM(DB.logements[0], anc, '2026-09', { mois: '2026-09', montant: 440 }), 440); // mois plein de l'ancien locataire (pas 0 du nouveau)
  near(c.qDuM(DB.logements[0], anc, '2026-10', null), 440 * 15 / 31);                    // sortie le 15/10
  near(c.qDuM(DB.logements[0], DB.locataires[0], '2026-10', null), 440 * 12 / 31);       // entrée du nouveau le 20/10
});
test('Loyers du mois : ligne et totaux d\'immeuble au dû du mois d\'entrée (prorata loyer + charges), activation du bail et bail au prorata', () => {
  const DB = uiDB(); DB.locataires[0].entree = '2026-10-16';
  const c = uiRun(['gLog', 'gLogLoc', 'paiDu', 'duMois', 'lotLoyerAt', 'lotMoisNext', 'lotLoyerDefMois', 'lotSetLoyer', 'prorataJours', 'qMoisFin', 'qMoisLabel', 'qDuM', 'qPerMois', 'eur2', 'fmt', 'lrDu', 'lrAmtHtml', 'duHC'], DB);
  const r = { l: DB.logements[0], loc: DB.locataires[0], pai: null, status: 'late' };
  near(c.lrDu(r, '2026-10'), 283.87); const h = c.lrAmtHtml(r, '2026-10');
  assert.ok(h.includes('prorata entrée 16/10') && /= 283,87/.test(h.replace(/\s/g, ' ')), h);
  assert.ok(/258,06/.test(h.replace(/\s/g, ' ')) && /25,81/.test(h.replace(/\s/g, ' ')), 'loyer et charges répartis : ' + h);
  assert.ok(!/prorata/.test(c.lrAmtHtml(r, '2026-11')), 'mois suivant : loyer plein');
  r.pai = { logId: 'l1', mois: '2026-10', du: 300, montant: 100 }; assert.equal(c.lrDu(r, '2026-10'), 300, 'dû figé à l\'encaissement prioritaire');
  const rl = extractUI('rLoyers'); assert.ok(rl.includes('a+lrDu(r,ms)') && rl.includes('duHC(r.l,lrDu(r,ms))'), 'totaux d\'immeuble au dû du mois');
  assert.ok(/entreeAppliquer\(nl,''\)/.test(extractUI('activateBail')), 'activation du bail : 1er mois au prorata');
  assert.ok(/Premier mois \(période '\+qPeriodeJours\(ms/.test(extractUI('buildBailHTML')), 'bail : montant du 1er mois au prorata');
});
test('changement de loyer : les mois passés gardent l\'ancien loyer, les mois suivants le nouveau', () => {
  const l = { id: 'l1', ref: 'A1', loyer: 500, charges: 50, statut: 'Occupé' };
  const DB = { logements: [l], locataires: [{ id: 'c1', logId: 'l1', entree: '2025-01-01' }], paiements: [{ id: 'p1', logId: 'l1', mois: '2026-11', montant: 550, statut: 'Payé', du: 550 }] };
  const c = uiRun(['gLog', 'gLogLoc', 'paiDu', 'duMois', 'lotLoyerAt', 'lotMoisNext', 'lotLoyerDefMois', 'lotSetLoyer', 'prorataJours', 'qMoisFin', 'qDuM', 'qPerMois'], DB);
  vm.runInContext('NOW=new Date("2026-11-20T12:00:00Z");', c);
  assert.equal(c.lotLoyerDefMois(l), '2026-12', 'mois en cours déjà encaissé → mois suivant');
  assert.ok(c.lotSetLoyer(l, 520, 50, ''));
  near(c.duMois('l1', '2026-10'), 550, 0.01, 'octobre (passé)'); near(c.duMois('l1', '2026-11'), 550, 0.01, 'novembre (déjà encaissé)'); near(c.duMois('l1', '2027-01'), 570, 0.01, 'janvier (futur)');
  const q = c.qPerMois(l, DB.locataires[0], '2026-09', null, 520, 50); near(q.loyer, 500, 0.01, 'quittance de septembre : ancien loyer');
  c.lotSetLoyer(l, 530, 50, '2026-12'); near(c.duMois('l1', '2026-11'), 550, 0.01, '2e modif : passé intact'); near(c.duMois('l1', '2026-12'), 580);
  l.loyer = 540; near(c.duMois('l1', '2027-02'), 590, 0.01, 'modif directe : période en cours'); near(c.duMois('l1', '2026-06'), 550, 0.01, 'modif directe : passé intact');
});
test('entrée prévue : bouton ✕ pour la supprimer (fiche, disponibilités, formulaire du lot)', () => {
  assert.ok(uiHtml.includes('function clearEntreePrevue('));
  assert.ok((uiHtml.match(/clearEntreePrevue\(\\'/g) || []).length >= 2, 'bouton ✕ sur la fiche et dans les disponibilités');
  assert.ok(/id="log-ep"[^]*?✕<\/button>/.test(uiHtml), 'bouton ✕ dans le formulaire du lot');
});

console.log(`\n${passed} réussi(s), ${failed} échec(s)`);
process.exit(failed ? 1 : 0);
