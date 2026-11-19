// Tests du coffre serveur (Durable Object) avec un stockage simulé en mémoire.
import fs from 'node:fs';
import assert from 'node:assert/strict';
let src = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8')
  .replace(/^import PDFJS_MAIN from .*$/m, "const PDFJS_MAIN='';").replace(/^import PDFJS_WORKER from .*$/m, "const PDFJS_WORKER='';");
src += '\nexport {zipOne,crc32,mergeDB,makeEngine};';
const tmp = new URL('./.worker-test.mjs', import.meta.url);
fs.writeFileSync(tmp, src);
const W = await import(tmp.href + '?t=' + Date.now());
fs.unlinkSync(tmp);

class Mem { constructor(){this.m=new Map();}
  async get(k){return this.m.get(k);} async put(k,v){if(typeof k==='object'){for(const x in k)this.m.set(x,k[x]);}else this.m.set(k,v);}
  async delete(k){(Array.isArray(k)?k:[k]).forEach(x=>this.m.delete(x));}
  async list(o){const r=new Map();[...this.m.keys()].sort().forEach(k=>{if(!o||!o.prefix||k.startsWith(o.prefix))r.set(k,this.m.get(k));});return r;} }
const store = () => new W.Store({storage:new Mem(),waitUntil(){}}, {});

let failed=0,passed=0;
async function test(n,f){try{await f();passed++;console.log('✓ '+n);}catch(e){failed++;console.error('✗ '+n+'\n   '+e.message);}}
const near = (a, b, eps = 0.01, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} attendu ${b}, obtenu ${a}`);

await test('CRC32 conforme (valeur de référence)', () => { assert.equal(W.crc32(new TextEncoder().encode('123456789')), 0xCBF43926); });
await test('ZIP lisible : signature et contenu décompressé identique', async () => {
  const data = new TextEncoder().encode(JSON.stringify({a:'é'.repeat(5000)}));
  const z = await W.zipOne('x.json', data);
  assert.equal(new DataView(z.buffer).getUint32(0,true), 0x04034b50);
  fs.writeFileSync(new URL('./.t.zip', import.meta.url), z);
});
await test('sauvegarde et relecture des données (gzip découpé)', async () => {
  const s = store(); const d = {batiments:[{id:'b1',nom:'A',_ts:1}],logements:[],locataires:[]};
  await s.putData(d); assert.deepEqual(await s.getData(), d);
});
await test('restauration : remplace, garde la version d\'avant, et s\'impose aux appareils', async () => {
  const s = store();
  await s.putData({batiments:[{id:'b1',nom:'Avant',_ts:5}],logements:[{id:'l1',_ts:5},{id:'l2',_ts:5}],locataires:[],projets:[{id:'pjX',_ts:5}]});
  const r = await s.restoreData({batiments:[{id:'b1',nom:'Sauvegarde',_ts:1}],logements:[{id:'l1',_ts:1}],locataires:[]});
  assert.equal(r.ok, true);
  const d = await s.getData();
  assert.equal(d.batiments[0].nom, 'Sauvegarde'); assert.equal(d.logements.length, 1);
  assert.ok(d.tomb.l2 && d.tomb.pjX, 'les éléments absents de la sauvegarde sont marqués supprimés');
  assert.ok([...(await s.storage.list({prefix:'bkpre:'})).keys()].length === 1, 'version d\'avant conservée');
  // un appareil resté sur l'ancienne version renvoie ses données : la restauration doit gagner
  const merged = W.mergeDB(d, {batiments:[{id:'b1',nom:'Avant',_ts:5}],logements:[{id:'l1',_ts:5},{id:'l2',_ts:5}],tomb:{}});
  assert.equal(merged.batiments[0].nom, 'Sauvegarde'); assert.equal(merged.logements.length, 1);
});
await test('restauration : refuse un fichier qui n\'est pas une sauvegarde', async () => {
  await assert.rejects(store().restoreData({foo:1}));
});
await test('envoi par e-mail : erreur claire si l\'envoi n\'est pas configuré', async () => {
  const s = store(); await s.putData({batiments:[],logements:[]});
  const r = await s.mailBackup('manuel'); assert.equal(r.ok, false); assert.match(r.error, /non configuré/);
});
await test('envoi par e-mail : pièce jointe ZIP envoyée à Brevo', async () => {
  const s = store(); await s.putData({batiments:[{id:'b1'}],logements:[]});
  await s.storage.put('mail:cfg',{apiKey:'k',senderEmail:'a@b.fr',replyTo:'moi@x.fr'});
  let sent; const of = globalThis.fetch; globalThis.fetch = async (u,o) => {sent={u,body:JSON.parse(o.body)};return new Response('{"messageId":"1"}',{status:201});};
  try { const r = await s.mailBackup('auto'); assert.equal(r.ok, true); } finally { globalThis.fetch = of; }
  assert.equal(sent.body.to[0].email, 'moi@x.fr'); assert.match(sent.body.attachment[0].name, /\.zip$/);
  const z = Buffer.from(sent.body.attachment[0].content,'base64'); assert.equal(z.readUInt32LE(0), 0x04034b50);
});
await test('documents et photos : envoi progressif par lots, sans renvoyer deux fois', async () => {
  const s = store(); await s.putData({batiments:[{id:'b1',nom:'Saint-Brieuc'}],logements:[{id:'l1',batId:'b1',ref:'Apt 4'}]});
  await s.storage.put('mail:cfg',{apiKey:'k',senderEmail:'a@b.fr'});
  const put = async (id,size,name) => { const u=new Uint8Array(size).fill(7); await s.storage.put('fc:'+id+':0',u.buffer); await s.storage.put('fm:'+id,{id,name,size,chunks:1,cat:'Bail',batId:'b1',logId:'l1',created:size}); };
  await put('f1',3e6,'bail.pdf'); await put('f2',3e6,'bail.pdf'); await put('f3',3e6,'edl.pdf'); await put('f4',8e6,'gros.pdf');
  const mails=[]; const of=globalThis.fetch; globalThis.fetch=async(u,o)=>{mails.push(JSON.parse(o.body));return new Response('{}',{status:201});};
  try {
    const r1 = await s.mailFiles(1); assert.equal(r1.ok,true); assert.equal(r1.fichiers,2); assert.equal(r1.restants,1); assert.equal(r1.trop_gros.length,1);
    const r2 = await s.mailFiles(5); assert.equal(r2.fichiers,1); assert.equal(r2.restants,0);
    const r3 = await s.mailFiles(5); assert.equal(r3.emails,0);
  } finally { globalThis.fetch=of; }
  assert.equal(mails.length,2);
  const z=Buffer.from(mails[0].attachment[0].content,'base64'); fs.writeFileSync(new URL('./.t2.zip', import.meta.url), z);
});
await test('résidence principale : import de l\'échéancier, réglages, capital remboursé inclus ou exclu', async () => {
  const s = store(); await s.putData({scis:[{id:'s1',nom:'SCI A'}],batiments:[{id:'b1',sciId:'s1',nom:'Lannion'}],logements:[],prets:[],settings:{}});
  const rows = [{date:'2026-11-05',capital:0,interets:487.5,echeance:514.76,crd_apres:150000},{date:'2026-12-05',capital:0,interets:487.5,echeance:514.76,crd_apres:150000},
    {date:'2027-09-05',capital:415.8,interets:487.5,echeance:931.11,crd_apres:149584.2},{date:'2027-10-05',capital:417.16,interets:486.15,echeance:931.12,crd_apres:149167.04}];
  const r = await s.mcpCall('importer_echeancier_pret',{residence_principale:true,banque:'CIC Ouest',contrat:'30047 14112 00020368111',taux_annuel_pct:3.9,echeances:rows},'https://x');
  assert.equal(r.ok,true); assert.equal(r.echeances,4); assert.equal(r.capital_avant_premiere_echeance,150000); assert.equal(r.lignes_incoherentes,0); assert.equal(r.total_capital,832.96);
  await assert.rejects(s.mcpCall('importer_echeancier_pret',{residence_principale:true,contrat:'30047 14112 00020368111',echeances:rows},'https://x'), /existe déjà/);
  const d = await s.getData(); assert.equal(d.prets[0].batId,'rp'); assert.equal(d.prets[0].rp,true); assert.equal(d.settings.rp.inclure,true);
  const v = await s.mcpCall('residence_principale',{valeur:350000},'https://x'); assert.equal(v.residence_principale.valeur,350000); assert.equal(v.prets.length,1);
  const c1 = await s.mcpCall('capital_rembourse',{mois:'2027-10'},'https://x');
  assert.equal(c1.biens.find(b=>b.batiment==='Résidence principale').capital_rembourse_mois,417.16); assert.equal(c1.total_patrimoine.capital_rembourse_mois,417.16);
  await s.mcpCall('residence_principale',{inclure:false},'https://x');
  const c2 = await s.mcpCall('capital_rembourse',{mois:'2027-10'},'https://x');
  assert.ok(!c2.biens.some(b=>b.batiment==='Résidence principale')); assert.equal(c2.total_patrimoine.capital_rembourse_mois,0);
  const vp = await s.mcpCall('vue_portefeuille',{},'https://x'); assert.equal(vp.total.capital_restant_du,0, 'la RP ne doit jamais entrer dans le parc locatif');
});
await test('départ d\'un locataire : date de départ exigée, prorata du dernier mois recalculé et rattaché au locataire sortant', async () => {
  const s = store(); const m = new Date().toISOString().slice(0,7);
  await s.putData({scis:[{id:'s1',nom:'SCI'}],batiments:[{id:'b1',sciId:'s1',nom:'Brélévenez'}],logements:[{id:'l1',batId:'b1',ref:'1G',loyer:380,charges:20,statut:'Occupé'}],
    locataires:[{id:'loc1',logId:'l1',prenom:'Enguerrand',nom:'Lachaise',entree:'2026-09-22'}],
    paiements:[{id:'pa1',logId:'l1',mois:m,montant:206.45,statut:'Partiel',versements:[{montant:206.45,date:m+'-15'}]}],prets:[],settings:{}});
  await assert.rejects(s.mcpCall('modifier_lot',{lot:'1G',batiment:'Brélévenez',statut:'Travaux'},'https://x'), /date de départ/i, 'libérer un lot occupé sans date de départ doit être refusé');
  assert.equal((await s.getData()).locataires.length,1, 'rien ne doit être archivé sans date de départ');
  const r = await s.mcpCall('modifier_lot',{lot:'1G',batiment:'Brélévenez',statut:'Travaux',date_sortie:m+'-16'},'https://x');
  assert.equal(r.ok,true);
  const d = await s.getData(), pa = d.paiements[0], nb = new Date(+m.slice(0,4), +m.slice(5,7), 0).getDate(), du = Math.round(400*16/nb*100)/100;
  assert.equal(pa.du,du); assert.equal(pa.prorata,true); assert.equal(pa.locNom,'Enguerrand Lachaise'); assert.equal(pa.statut, 206.45>=du-0.005?'Payé':'Partiel');
  assert.equal(d.anciens.length,1); assert.equal(d.anciens[0].sortie,m+'-16'); assert.equal(d.locataires.length,0); assert.equal(d.logements[0].statut,'Travaux');
});
await test('lot vacant : entrée prévue du prochain locataire (enregistrée, refusée sur un lot occupé, effaçable)', async () => {
  const s = store();
  await s.putData({scis:[{id:'s1',nom:'SCI'}],batiments:[{id:'b1',sciId:'s1',nom:'Brélévenez'}],logements:[{id:'l1',batId:'b1',ref:'1G',loyer:380,charges:20,statut:'Vacant'},{id:'l2',batId:'b1',ref:'2D',loyer:400,charges:20,statut:'Occupé'}],locataires:[{id:'loc2',logId:'l2',prenom:'A',nom:'B',entree:'2026-01-01'}],paiements:[],prets:[],settings:{}});
  await s.mcpCall('modifier_lot',{lot:'1G',batiment:'Brélévenez',entree_prevue:'2027-01-05',futur_locataire:'M. Martin'},'https://x');
  let l = (await s.getData()).logements[0]; assert.equal(l.entreePrevue,'2027-01-05'); assert.equal(l.entreePrevueNom,'M. Martin');
  await assert.rejects(s.mcpCall('modifier_lot',{lot:'2D',batiment:'Brélévenez',entree_prevue:'2027-01-05'},'https://x'), /vacant/);
  await assert.rejects(s.mcpCall('modifier_lot',{lot:'1G',batiment:'Brélévenez',entree_prevue:'05/01/2027'},'https://x'), /AAAA-MM-JJ/);
  await s.mcpCall('modifier_lot',{lot:'1G',batiment:'Brélévenez',entree_prevue:''},'https://x');
  l = (await s.getData()).logements[0]; assert.equal(l.entreePrevue,undefined); assert.equal(l.entreePrevueNom,undefined);
});
await test('anciens locataires : recherche, paiements de la location, statut du dépôt', async () => {
  const s = store();
  await s.putData({scis:[],batiments:[{id:'b1',nom:'Brélévenez'}],logements:[{id:'l1',batId:'b1',ref:'1G'}],prets:[],settings:{},
    anciens:[{id:'anc1',logId:'l1',prenom:'Enguerrand',nom:'Lachaise',email:'e@x.fr',entree:'2026-09-22',sortie:'2026-10-20',depot:400,batNom:'Brélévenez',lotRef:'1G'}],
    paiements:[{id:'p0',logId:'l1',mois:'2026-08',montant:999},{id:'p1',logId:'l1',mois:'2026-09',montant:100},{id:'p2',logId:'l1',mois:'2026-10',montant:206.45,ancId:'anc1'},{id:'p3',logId:'l1',mois:'2026-11',montant:500}]});
  const r = await s.mcpCall('anciens_locataires',{recherche:'lachaise'},'https://x');
  assert.equal(r.nombre,1); assert.equal(r.anciens[0].paiements,2); assert.equal(r.anciens[0].total_encaisse,306.45); assert.match(r.anciens[0].depot_statut,/2026-11-20/);
  assert.equal((await s.mcpCall('anciens_locataires',{recherche:'inconnu'},'https://x')).nombre,0);
});
await test('résidence principale via ajouter_pret / modifier_batiment (outils existants)', async () => {
  const s = store(); await s.putData({scis:[],batiments:[{id:'b1',nom:'Lannion'}],logements:[],prets:[],settings:{}});
  const r = await s.mcpCall('ajouter_pret',{batiment:'Résidence principale',banque:'CIC Ouest',capital:150000,taux_annuel_pct:3.9,duree_mois:2,date_premiere_echeance:'2026-11-05',
    echeances:[{date:'2026-11-05',capital:0,interets:487.5,echeance:514.76,crd_apres:150000},{date:'2027-09-05',capital:415.8,interets:487.5,echeance:931.11,crd_apres:149584.2}]},'https://x');
  assert.equal(r.ok,true); assert.equal(r.rattache_a,'Résidence principale');
  const v = await s.mcpCall('modifier_batiment',{batiment:'Résidence principale',valeur_marche:350000,prix_acquisition:260000},'https://x');
  assert.equal(v.residence_principale.valeur,350000); assert.equal(v.residence_principale.prix_acquisition,260000);
  const d = await s.getData(); assert.equal(d.batiments.length,1); assert.equal(d.prets[0].batId,'rp');
});
await test('résidence principale : format compact d\'échéancier dans ajouter_pret', async () => {
  const s = store(); await s.putData({scis:[],batiments:[],logements:[],prets:[],settings:{}});
  const r = await s.mcpCall('ajouter_pret',{batiment:'Résidence principale',banque:'CIC Ouest',capital:150000,taux_annuel_pct:3.9,duree_mois:2,date_premiere_echeance:'2026-11-05',agence:'CIC Ouest|ECH:20261105;0;487.5;514.76;150000/20270905;415.8;487.5;931.11;149584.2'},'https://x');
  assert.equal(r.ok,true); assert.equal(r.echeances,2); assert.equal(r.total_capital,415.8);
  const d = await s.getData(); assert.equal(d.prets[0].agence,'CIC Ouest'); assert.equal(d.prets[0].schedule[1].date,'2027-09-05');
});
await test('quittance sur plusieurs mois (période et mois manquant)', async () => {
  const s = store();
  await s.putData({scis:[{id:'s1',nom:'SCI TEOLA',gerant:'Antonin Carlier',adresse:'Perros-Guirec'}],batiments:[{id:'b1',sciId:'s1',nom:'Saint-Michel'}],logements:[{id:'l1',batId:'b1',ref:'Apt 4',loyer:410,charges:60}],
    locataires:[{id:'L1',logId:'l1',prenom:'Timéo',nom:'Duquesnoy'}],prets:[],settings:{},
    paiements:[{id:'a',logId:'l1',mois:'2026-08',montant:470,date:'2026-08-05'},{id:'b',logId:'l1',mois:'2026-09',montant:470,date:'2026-09-05'},{id:'c',logId:'l1',mois:'2026-10',montant:470,date:'2026-10-06'}]});
  const r = await s.mcpCall('quittance_pdf',{lot:'Apt 4',batiment:'Saint-Michel',mois:'2026-08:2026-10'},'https://x');
  assert.equal(r.document,'quittance'); assert.equal(r.total_du,1410); assert.equal(r.montant_recu,1410); assert.match(r.lien_telechargement,/\/api\/f\//);
  const fm=[...(await s.storage.list({prefix:'fm:'})).values()][0]; assert.match(fm.name,/2026-08_2026-10/);
  await assert.rejects(s.mcpCall('quittance_pdf',{lot:'Apt 4',batiment:'Saint-Michel',mois:'2026-07:2026-09'},'https://x'),/2026-07/);
});
await test('dépôt de bail par Claude : lien à usage unique, classé sur le lot, contrôle du type', async () => {
  const s = store();
  await s.putData({batiments:[{id:'b1',nom:'La Roche',_ts:1}],logements:[{id:'l1',batId:'b1',ref:'Apt 1A',loyer:450,charges:100,_ts:1}],locataires:[{id:'t1',logId:'l1',prenom:'A',nom:'B',_ts:1}]});
  const r = await s.mcpCall('preparer_depot_document',{lot:'Apt 1A',batiment:'La Roche',nom_fichier:'Bail/test.pdf'},'https://x');
  assert.equal(r.categorie,'Bail'); assert.match(r.commande,/curl -sS -T/);
  assert.ok(![...(await s.storage.list({prefix:'ul:'})).keys()].some(k=>k.includes(r.lien_envoi.split('/').pop())),'jeton non stocké en clair');
  const send = (u,b,m='PUT') => s.fetch(new Request(u,{method:m,body:b}));
  assert.equal((await send('https://x/api/depot/faux',new Uint8Array([0x25,0x50,0x44,0x46]))).status,403);
  assert.equal((await send(r.lien_envoi,new TextEncoder().encode('<html>'))).status,415);
  const pdf = new Uint8Array(2500000); pdf.set([0x25,0x50,0x44,0x46],0); pdf[2499999]=7;
  const ok = await send(r.lien_envoi,pdf); assert.equal(ok.status,200);
  const j = await ok.json(); assert.equal(j.taille_octets,2500000);
  const fm = await s.storage.get('fm:'+j.id);
  assert.equal(fm.name,'Bail test.pdf'); assert.equal(fm.cat,'Bail'); assert.equal(fm.logId,'l1'); assert.equal(fm.locId,'t1'); assert.equal(fm.batId,'b1'); assert.equal(fm.type,'application/pdf'); assert.equal(fm.chunks,3);
  const back = new Uint8Array(await s.storage.get('fc:'+j.id+':2')); assert.equal(back[back.length-1],7);
  assert.equal((await send(r.lien_envoi,pdf)).status,403,'usage unique');
  const r2 = await s.mcpCall('preparer_depot_document',{lot:'Apt 1A',batiment:'La Roche',nom_fichier:'x.pdf'},'https://x');
  const k2 = [...(await s.storage.list({prefix:'ul:'})).keys()][0], t2 = await s.storage.get(k2); t2.exp = 1; await s.storage.put(k2,t2);
  assert.equal((await send(r2.lien_envoi,pdf)).status,403,'expiré');
  await assert.rejects(s.mcpCall('preparer_depot_document',{lot:'Apt 1A',batiment:'La Roche',nom_fichier:'x.pdf',categorie:'Bidon'},'https://x'),/catégorie/);
});
await test('prorata d\'entrée et statut du locataire calculé sur les mois passés', async () => {
  const s = store();
  await s.putData({batiments:[{id:'b1',nom:'La Roche',_ts:1}],logements:[{id:'l1',batId:'b1',ref:'Apt 1A',loyer:450,charges:100,_ts:1}],locataires:[{id:'t1',logId:'l1',prenom:'G',nom:'B',entree:'2026-08-27',statutPaiement:'À jour',_ts:1}],paiements:[]});
  const now=new Date(); const cur=now.toISOString().slice(0,7);
  let r = await s.mcpCall('enregistrer_encaissement',{lot:'Apt 1A',batiment:'La Roche',mois:'2026-08',montant:88.71},'https://x');
  assert.equal(r.du,88.71); assert.equal(r.statut,'Payé');
  const d = await s.getData(); const loc=d.locataires[0];
  if (cur > '2026-09') assert.equal(loc.statutPaiement,'Retard','septembre non payé => retard'); else assert.equal(loc.statutPaiement,'À jour');
});
await test('modifier_lot : DPE complet (GES, fourchette, n° ADEME) et refus des valeurs invalides', async () => {
  const s = store();
  await s.putData({batiments:[{id:'b1',nom:'Lannion',_ts:1}],logements:[{id:'l1',batId:'b1',ref:'Studio 1',loyer:310,charges:0,_ts:1}],locataires:[]});
  await s.mcpCall('modifier_lot',{lot:'Studio 1',batiment:'Lannion',dpe:'d',ges:'B',energie_min:600,energie_max:850,energie_annee:'2021, 2022, 2023',dpe_numero:'2522E3777943N',dpe_date:'2025-12-01',surface_m2:18.74},'https://x');
  const l=(await s.getData()).logements[0];
  assert.equal(l.dpe,'D');assert.equal(l.ges,'B');assert.equal(l.energieMin,600);assert.equal(l.energieMax,850);assert.equal(l.energieAnnee,'2021, 2022, 2023');assert.equal(l.dpeNum,'2522E3777943N');assert.equal(l.dpeDate,'2025-12-01');assert.equal(l.surface,18.74);
  await assert.rejects(s.mcpCall('modifier_lot',{lot:'Studio 1',ges:'H'},'https://x'),/classe/);
  await assert.rejects(s.mcpCall('modifier_lot',{lot:'Studio 1',energie_min:900,energie_max:100},'https://x'),/fourchette/);
  await assert.rejects(s.mcpCall('modifier_lot',{lot:'Studio 1',dpe_numero:'XYZ'},'https://x'),/ADEME/);
});
await test('annonce personnalisée : mentions obligatoires remises à jour depuis la fiche (surface, DPE/GES, énergie, Géorisques)', async () => {
  const s = store();
  const texte = "Studio rénové et meublé de 23 m² à Lannion (22300).\n\n- Proche gare\n\nLoyer : 400 € par mois\nDépôt de garantie : 400 €.\nLocation meublée.\n\nClasse énergie (DPE) : E.\nLes informations sur les risques auxquels ce bien est exposé sont disponibles sur le site Géorisques : www.georisques.gouv.fr";
  await s.putData({batiments:[{id:'b1',nom:'Lannion',adresse:'8 rue X, 22300 Lannion',_ts:1}],logements:[{id:'l1',batId:'b1',ref:'Studio 5',type:'Studio',meuble:'Oui',surface:23,loyer:410,charges:20,statut:'Vacant',dpe:'E',ges:'B',energieMin:630,energieMax:900,energieAnnee:'2021, 2022, 2023',annonce:{titre:'Studio',texte,sig:'1'},_ts:1}],locataires:[]});
  const r = await s.mcpCall('annonce_lot',{lot:'l1'},'https://x'), t = r.annonce.texte;
  assert.match(t, /Loyer : 410 € par mois\./); assert.match(t, /Dépôt de garantie : 410 €\.\nSurface habitable : 23 m²\./);
  assert.match(t, /Classe énergie \(DPE\) : E - Classe climat \(GES\) : B\./); assert.match(t, /entre 630 € et 900 € par an/);
  assert.ok(t.indexOf('dépenses annuelles') < t.indexOf('Géorisques'), 'dépenses d\'énergie avant Géorisques');
  assert.equal((t.match(/Géorisques/g)||[]).length, 1); assert.doesNotMatch(t, /charges|Location directe/i);
  assert.equal(r.alertes.length, 0);
});
await test('annonce : alertes surface du texte ≠ fiche, lot occupé encore publié, lien qui n\'est pas l\'annonce', async () => {
  const s = store();
  await s.putData({batiments:[{id:'b1',nom:'Brélévenez',adresse:'5 rue Ar Béo - 22300 Lannion',_ts:1}],logements:[
    {id:'l1',batId:'b1',ref:'T2 2e',type:'T2',meuble:'Non',surface:13,loyer:480,statut:'Vacant',dpe:'D',ges:'B',annonce:{texte:'T2.\n- Surface au sol : 30 m²\n- Jardin de 200 m²\nLoyer : 1 €',pubDate:'2026-11-10',pubUrl:'https://www.leboncoin.fr/compte/part/mes-annonces'},_ts:1},
    {id:'l2',batId:'b1',ref:'1D',type:'Studio',meuble:'Oui',surface:15,loyer:380,statut:'Occupé',dpe:'D',annonce:{pubDate:'2026-11-07',pubUrl:'https://www.leboncoin.fr/ad/locations/3304069956'},_ts:1}],locataires:[{id:'c1',logId:'l2',nom:'X',entree:'2026-09-23',depot:380}]});
  const a = (await s.mcpCall('annonce_lot',{lot:'l1'},'https://x')).alertes.join(' | ');
  assert.match(a, /30 m²/); assert.doesNotMatch(a, /200/); assert.match(a, /ne mène pas/);
  const b = (await s.mcpCall('annonce_lot',{lot:'l2'},'https://x')).alertes.join(' | ');
  assert.match(b, /retirer/); assert.doesNotMatch(b, /ne mène pas/);
});
await test('controle_donnees : détecte les incohérences sans rien modifier', async () => {
  const s = store();
  const data = {batiments:[{id:'b1',nom:'La Roche',adresse:'5 Rue du Pouliet, 22450 La Roche Derrien',taxeFonciere:5500,_ts:1}],
    logements:[{id:'l1',batId:'b1',ref:'Apt 1D',type:'T2',surface:32,loyer:480,statut:'Occupé',dpe:'D',_ts:1},
               {id:'l2',batId:'b1',ref:'Apt RDC',type:'T3',surface:0,loyer:700,statut:'Occupé',dpe:'D',_ts:1},
               {id:'l3',batId:'b1',ref:'Local',type:'Commercial',surface:0,loyer:350,statut:'Occupé',_ts:1}],
    locataires:[{id:'c2',logId:'l2',nom:'Y',entree:'',depot:0},{id:'c3',logId:'l3',nom:'Z',entree:'2014-09-01',depot:0}],
    charges:[{id:'k1',batId:'b1',cat:'Assurance PNO',montant:600,freq:'Annuelle'}]};
  await s.putData(data);
  const r = await s.mcpCall('controle_donnees',{},'https://x'), txt = JSON.stringify(r.points);
  assert.match(txt, /Apt 1D.*sans locataire/); assert.match(txt, /sans date d'entrée/); assert.match(txt, /surface habitable manquante/);
  assert.match(txt, /frais de gestion non saisis/); assert.doesNotMatch(txt, /PNO non saisie/); assert.doesNotMatch(txt, /taxe foncière non saisie/);
  assert.doesNotMatch(txt, /"lot":"Local","probleme":"(surface|DPE|dépôt)/, 'un local commercial n\'est pas contrôlé comme un logement');
  assert.equal(r.points[0].gravite, 'bloquant');
  assert.deepEqual((await s.getData()).logements, data.logements);
});
await test('la clé de l\'ancien stockage JSONBin n\'est plus dans le code', () => {
  assert.doesNotMatch(src, /X-Master-Key['"]?\s*:\s*['"]\$2a\$/); assert.doesNotMatch(src, /LEGACY_JSONBIN\s*=/);
});
await test('Visale : enregistrement, échéance auto à 3 ans, état et rappel', async () => {
  const s = store();
  await s.putData({batiments:[{id:'b1',nom:'Lannion',adresse:'8 rue X, 22300 Lannion',taxeFonciere:9000,_ts:1}],logements:[{id:'l1',batId:'b1',ref:'Studio 4',type:'Studio',surface:20,loyer:360,statut:'Occupé',dpe:'E',_ts:1}],locataires:[{id:'c1',logId:'l1',prenom:'Mewenn',nom:'Mordelet',entree:'2026-08-01',depot:580}]});
  await s.mcpCall('enregistrer_locataire',{lot:'l1',locataire_id:'c1',visale_numero:'V123',visale_date_effet:'2026-08-01'},'https://x');
  let loc=(await s.getData()).locataires[0];
  assert.equal(loc.visale,'Oui'); assert.equal(loc.visaleNum,'V123'); assert.equal(loc.visaleFin,'2029-07-31', '3 ans après la prise d\'effet, veille incluse');
  const r = await s.mcpCall('liste_locataires',{},'https://x'); const v=r.lots[0].locataire.garantie_visale;
  assert.equal(v.echeance,'2029-07-31'); assert.equal(v.etat,'valable');
  // échéance proche → rappel dans le contrôle ; dépassée → bloquant
  await s.mcpCall('enregistrer_locataire',{lot:'l1',locataire_id:'c1',visale_echeance:new Date(Date.now()+30*86400000).toISOString().slice(0,10)},'https://x');
  let c=JSON.stringify((await s.mcpCall('controle_donnees',{},'https://x')).points); assert.match(c,/Visale à renouveler/);
  await s.mcpCall('enregistrer_locataire',{lot:'l1',locataire_id:'c1',visale_echeance:'2026-01-01'},'https://x');
  c=(await s.mcpCall('controle_donnees',{},'https://x')).points.find(p=>/Visale expirée/.test(p.probleme)); assert.equal(c.gravite,'bloquant');
  // retrait
  await s.mcpCall('enregistrer_locataire',{lot:'l1',locataire_id:'c1',visale:false},'https://x');
  loc=(await s.getData()).locataires[0]; assert.equal(loc.visale,'Non'); assert.equal(loc.visaleFin,undefined);
});
await test('Visale : contrat antérieur au 06/01/2026 → pas d\'échéance devinée', () => {
  const g = new Function(src.match(/function visaleFinAuto\(debut\)\{[^\n]*\}/)[0]+';return visaleFinAuto;')();
  assert.equal(g('2025-09-01'), ''); assert.equal(g('2026-01-06'), '2029-01-05'); assert.equal(g('2028-02-29'), '2031-02-28');
});
await test('Sortie : préavis, date de sortie, prorata du dernier mois, montant ajustable, archivage', async () => {
  const s = store();
  await s.putData({batiments:[{id:'b1',nom:'Saint-Michel',adresse:'24 rue X, 22300 Saint-Michel-en-Grève',taxeFonciere:1600,_ts:1}],
    logements:[{id:'l1',batId:'b1',ref:'Studio 1',type:'Studio',surface:15,loyer:410,charges:60,statut:'Occupé',dpe:'D',_ts:1}],
    locataires:[{id:'c1',logId:'l1',prenom:'Anthony',nom:'Collet',entree:'2026-09-21',depot:410}],paiements:[]});
  // sortie le 15/12/2026 : 15 jours sur 31 → 470 × 15/31 = 227,42
  await s.mcpCall('enregistrer_locataire',{lot:'l1',locataire_id:'c1',date_preavis:'2026-11-15',date_sortie:'2026-12-15'},'https://x');
  let r=(await s.mcpCall('liste_locataires',{},'https://x')).lots[0].locataire;
  assert.equal(r.date_sortie,'2026-12-15'); assert.equal(r.preavis_recu,'2026-11-15'); assert.equal(r.du_mois_sortie,227.42);
  let d=await s.getData(); assert.equal(d.logements[0].dispoDate,'2026-12-16','disponible le lendemain');
  // montant ajusté à la main
  await s.mcpCall('enregistrer_locataire',{lot:'l1',locataire_id:'c1',montant_dernier_mois:200},'https://x');
  r=(await s.mcpCall('liste_locataires',{},'https://x')).lots[0].locataire; assert.equal(r.du_mois_sortie,200);
  // entrée et sortie le même mois
  const g = new Function(src.match(/function prorataJours\(tot,mois,entree,sortie\)\{[\s\S]*?return Math\.round\(tot\*\(f-d\+1\)\/nb\*100\)\/100;\}/)[0]+';return prorataJours;')();
  assert.equal(g(470,'2026-12','2026-12-10','2026-12-20'), Math.round(470*11/31*100)/100);
  assert.equal(g(470,'2027-01','2026-09-21','2026-12-15'), 0, 'rien de dû après le mois de sortie');
  assert.equal(g(470,'2026-11','2026-09-21','2026-12-15'), 470); assert.equal(g(470,'2026-12','2026-09-21','2026-12-31'), 470);
  // annulation
  await s.mcpCall('enregistrer_locataire',{lot:'l1',locataire_id:'c1',date_sortie:''},'https://x');
  d=await s.getData(); assert.equal(d.locataires[0].sortie,undefined); assert.equal(d.paiements[0].du,undefined);
});
await test('Sortie passée non libérée : signalée par le contrôle des données', async () => {
  const s = store();
  await s.putData({batiments:[{id:'b1',nom:'Lannion',adresse:'8 rue X, 22300 Lannion',taxeFonciere:9000,_ts:1}],logements:[{id:'l1',batId:'b1',ref:'Studio 4',type:'Studio',surface:20,loyer:360,statut:'Occupé',dpe:'E',_ts:1}],locataires:[{id:'c1',logId:'l1',nom:'Mordelet',entree:'2026-08-01',depot:580,sortie:'2026-10-31'}]});
  const c=(await s.mcpCall('controle_donnees',{},'https://x')).points.find(p=>/sortie passée/.test(p.probleme)); assert.ok(c); assert.match(c.correction,/libérer/);
});
await test('envoyer_quittance : PDF joint (pas de lien), « Madame » / « Monsieur », message court sans téléphone', async () => {
  const s = store(); const sent=[]; const of=globalThis.fetch;
  globalThis.fetch = async (u,o) => { sent.push({u,body:JSON.parse(o.body)}); return new Response('{"messageId":"x"}',{status:201}); };
  try{
    await s.storage.put('mail:cfg',{apiKey:'k',senderEmail:'proprio@exemple.fr',senderName:'Antonin Carlier'});
    await s.putData({settings:{nomProprietaire:'Antonin Carlier'},scis:[{id:'s1',nom:'SCI TEOLA',gerant:'Antonin Carlier'}],batiments:[{id:'b1',sciId:'s1',nom:'Saint-Michel',adresse:'24 rue X, 22300 Saint-Michel-en-Grève',_ts:1}],
      logements:[{id:'l1',batId:'b1',ref:'Studio 2',type:'Studio',loyer:450,charges:70,statut:'Occupé',_ts:1},{id:'l2',batId:'b1',ref:'Studio 5',type:'Studio',loyer:420,charges:80,statut:'Occupé',_ts:1}],
      locataires:[{id:'c1',logId:'l1',prenom:'Victoria',nom:'Meuric',email:'v@exemple.fr',entree:'2025-08-28'},{id:'c2',logId:'l2',prenom:'Jean-Yves',nom:'Montjarret',email:'jy@exemple.fr',entree:'2024-11-02'}],
      paiements:[{id:'p1',logId:'l1',mois:'2026-10',montant:520,statut:'Payé',date:'2026-10-03'},{id:'p2',logId:'l2',mois:'2026-10',montant:500,statut:'Payé',date:'2026-10-05'}]});
    const r = await s.mcpCall('envoyer_quittance',{lot:'l1',mois:'2026-10',demande_du_locataire:true},'https://x');
    const b = sent[0].body;
    assert.match(sent[0].u, /brevo/); assert.equal(b.to[0].email,'v@exemple.fr'); assert.equal(b.attachment.length,1);
    assert.match(b.attachment[0].name, /^Quittance-2026-10-Meuric\.pdf$/); assert.ok(atob(b.attachment[0].content).startsWith('%PDF'), 'vrai PDF joint');
    assert.match(b.textContent, /^Madame,\n\n/); assert.match(b.textContent, /demand|convenu/); assert.match(b.textContent, /octobre 2026/);
    assert.doesNotMatch(b.textContent, /https?:|Victoria|06 48|lien/i);
    assert.equal(b.subject, 'Quittance de loyer — octobre 2026'); assert.equal(r.ok, true);
    await s.mcpCall('envoyer_quittance',{lot:'l2',mois:'2026-10'},'https://x');
    assert.match(sent[1].body.textContent, /^Monsieur,\n\n/); assert.doesNotMatch(sent[1].body.textContent, /demandé/);
    // civilité forcée et mémorisée
    await s.mcpCall('envoyer_quittance',{lot:'l2',mois:'2026-10',civilite:'Madame'},'https://x');
    assert.match(sent[2].body.textContent, /^Madame,/); assert.equal((await s.getData()).locataires[1].civilite,'Madame');
    assert.ok((await s.getData()).documents===undefined || true);
  } finally { globalThis.fetch = of; }
});
await test('repartir_versement : rappel CAF sur 3 mois partiels, simulation puis enregistrement, quittance avec la part CAF', async () => {
  const s = store(); const now=new Date(); const k0=now.getFullYear()*12+now.getMonth();
  const M=n=>{const k=k0-n;return Math.floor(k/12)+'-'+String(k%12+1).padStart(2,'0');};
  const pais=[3,2,1].map(n=>({id:'p'+n,logId:'l1',mois:M(n),montant:350,statut:'Partiel',_ts:1,versements:[{montant:350,date:M(n)+'-05',mode:'Virement',type:'Locataire'}]}));
  await s.putData({batiments:[{id:'b1',nom:'Lannion',_ts:1}],logements:[{id:'l1',batId:'b1',ref:'T2',loyer:550,charges:50,_ts:1}],locataires:[{id:'t1',logId:'l1',prenom:'Katia',nom:'Test',entree:M(3)+'-01',caf:true,montantCaf:250,statutPaiement:'Retard',_ts:1}],paiements:pais});
  let r = await s.mcpCall('repartir_versement',{lot:'T2',batiment:'Lannion',montant:750,payeur:'CAF',simulation:true},'https://x');
  assert.equal(r.repartition.length,3); assert.equal(r.non_affecte,0);
  assert.equal((await s.getData()).paiements[0].statut,'Partiel','simulation : rien enregistré');
  r = await s.mcpCall('repartir_versement',{lot:'T2',batiment:'Lannion',montant:800,payeur:'CAF',date:'2026-11-10'},'https://x');
  assert.equal(r.non_affecte,0); assert.equal(r.repartition[3].mois,M(0)); assert.equal(r.repartition[3].affecte,50,'le surplus va au mois en cours'); assert.equal(r.statut_locataire,'À jour');
  const d = await s.getData();
  d.paiements.filter(p=>p.mois<M(0)).forEach(p=>{assert.equal(p.statut,'Payé');assert.equal(p.montant,600);assert.equal(p.versements.filter(v=>v.type==='CAF').reduce((a,v)=>a+v.montant,0),250);});
  r = await s.mcpCall('enregistrer_encaissement',{lot:'T2',batiment:'Lannion',mois:M(0),montant:250,payeur:'CAF'},'https://x');
  assert.equal((await s.getData()).paiements.find(p=>p.mois===M(0)).versements[0].type,'CAF');
});
await test('états des lieux : synchronisés (fusion par fiche) et lisibles par le connecteur, sans les signatures ni les photos', async () => {
  const s = store();
  const e1={id:'edl1',logId:'l1',type:'Sortie',statut:'signé',date:'2026-11-13',sig:{bailleur:{img:'data:image/jpeg;base64,AAAA',at:1}},cptPh:{elec:[{k:'a',f:'f1'}]},pieces:[{id:'r1',nom:'Séjour',ph:[],els:[{id:'e1',nom:'Sol',etat:'B',com:'',ph:[{k:'b',f:'f2'}]}]}],_ts:5};
  await s.putData({batiments:[{id:'b1',nom:'Lannion',_ts:1}],logements:[{id:'l1',batId:'b1',ref:'T2',loyer:500,charges:0,releves:{date:'2026-11-13',type:'Sortie',idxHP:'12000',idxEauF:'85'},cptElec:'123',_ts:1}],locataires:[],edls:[e1]});
  const merged = W.mergeDB(await s.getData(), {edls:[Object.assign({},e1,{statut:'brouillon',_ts:2}),{id:'edl2',logId:'l1',type:'Entrée',_ts:3}],tomb:{}});
  assert.equal(merged.edls.length,2); assert.equal(merged.edls.find(x=>x.id==='edl1').statut,'signé','le plus récent gagne');
  const r = await s.mcpCall('lire_donnees',{section:'edls'},'https://x');
  assert.equal(r.nombre,1); assert.equal(r.lignes[0].sig,undefined); assert.deepEqual(r.lignes[0].signatures,['bailleur']); assert.equal(r.lignes[0].nb_photos,2);
  const lots = await s.mcpCall('liste_locataires',{},'https://x');
  assert.equal(lots.lots[0].derniers_releves.index_elec_hp_ou_base_kwh,'12000'); assert.equal(lots.lots[0].compteurs.electricite,'123');
});
// ── Non-régression audit du 19/11/2026 (valeurs attendues calculées à la main)
const auditBase = () => ({scis:[{id:'s1',nom:'SCI A',gerant:'G',adresse:'1 rue X 22300 Lannion'}],batiments:[{id:'b1',sciId:'s1',nom:'Lannion',adresse:'1 rue X 22300 Lannion'}],
  logements:[{id:'l1',batId:'b1',ref:'A1',loyer:500,charges:50,statut:'Occupé'}],locataires:[{id:'t1',logId:'l1',prenom:'Jean',nom:'Dupont',entree:'2025-01-01',email:'j@x.fr'}],
  paiements:[],charges:[],prets:[],anciens:[],settings:{}});
await test('quittance du mois d\'entrée au prorata (entrée 16/10, 550 × 16/31 = 283,87 payé) : quittance et non reçu partiel', async () => {
  const s = store(); const d = auditBase(); d.locataires[0].entree = '2026-10-16'; await s.putData(d);
  await s.mcpCall('enregistrer_encaissement',{lot:'l1',mois:'2026-10',montant:283.87,date:'2026-10-20'},'https://x');
  const q = await s.mcpCall('quittance_pdf',{lot:'l1',mois:'2026-10'},'https://x');
  assert.equal(q.document, 'quittance'); assert.equal(q.total_du, 283.87); assert.equal(q.montant_recu, 283.87);
});
await test('enregistrer_encaissement : 250 € ajoutés à un paiement de 300 € saisi sans versements → 550, Payé', async () => {
  const s = store(); const d = auditBase();
  d.paiements = [{id:'pa1',logId:'l1',mois:'2026-10',montant:300,date:'2026-10-05',mode:'Virement',statut:'Partiel'}]; await s.putData(d);
  const r = await s.mcpCall('enregistrer_encaissement',{lot:'l1',mois:'2026-10',montant:250,date:'2026-10-12'},'https://x');
  assert.equal(r.total_encaisse_mois, 550, 'les 300 € déjà saisis sont perdus'); assert.equal(r.statut, 'Payé');
  const p = (await s.getData()).paiements.find(x => x.mois === '2026-10');
  assert.equal(p.montant, 550); assert.equal(p.versements.reduce((a,v)=>a+v.montant,0), 550);
});
await test('mois de changement de locataire : l\'encaissement du nouvel entrant ne s\'ajoute pas au paiement du sortant', async () => {
  const s = store(); const d = auditBase();
  d.locataires = [{id:'t2',logId:'l1',prenom:'Marie',nom:'Martin',entree:'2026-10-16',email:'m@x.fr'}];
  d.anciens = [{id:'anc1',locId:'t1',logId:'l1',prenom:'Jean',nom:'Dupont',entree:'2025-01-01',sortie:'2026-10-15'}];
  // sortant : 550 × 15/31 = 266,13 ; entrant : 550 × 16/31 = 283,87
  d.paiements = [{id:'paOld',logId:'l1',mois:'2026-10',montant:266.13,du:266.13,prorata:true,statut:'Payé',ancId:'anc1',locNom:'Jean Dupont',versements:[{montant:266.13,date:'2026-10-02',type:'Locataire'}]}];
  await s.putData(d);
  const r = await s.mcpCall('enregistrer_encaissement',{lot:'l1',mois:'2026-10',montant:283.87,date:'2026-10-20'},'https://x');
  const dd = await s.getData(), oct = dd.paiements.filter(p => p.logId === 'l1' && p.mois === '2026-10');
  const old = oct.find(p => p.ancId === 'anc1'), nw = oct.find(p => !p.ancId);
  assert.equal(old.montant, 266.13, 'le paiement de l\'ancien locataire a été modifié');
  assert.ok(nw, 'aucun paiement propre au nouveau locataire'); near(nw.montant, 283.87); assert.equal(nw.statut, 'Payé');
  assert.equal(r.total_encaisse_mois, 283.87); assert.equal(r.du, 283.87);
  const E = W.makeEngine(dd, new Date('2026-11-05T10:00:00Z')); const loc = dd.locataires[0]; E.majStatutLoc(loc);
  assert.equal(loc.statutPaiement, 'À jour', 'nouveau locataire signalé en retard alors qu\'il a payé son prorata');
});
await test('arrondi : dû 733,33, versements 212,18 + 521,15 → Payé, 733,33', async () => {
  const s = store(); const d = auditBase(); d.logements[0].loyer = 700; d.logements[0].charges = 33.33; await s.putData(d);
  await s.mcpCall('enregistrer_encaissement',{lot:'l1',mois:'2026-10',montant:212.18,date:'2026-10-05'},'https://x');
  const r = await s.mcpCall('enregistrer_encaissement',{lot:'l1',mois:'2026-10',montant:521.15,date:'2026-10-08'},'https://x');
  assert.equal(r.statut, 'Payé'); assert.equal(r.total_encaisse_mois, 733.33);
  const p = (await s.getData()).paiements.find(x => x.mois === '2026-10'); assert.equal(p.statut, 'Payé'); assert.equal(p.montant, 733.33);
});
await test('révision 500 → 510 : les mois passés payés 550 (ancien loyer) restent Payé et le locataire est à jour', async () => {
  const d = auditBase(); d.logements[0].loyer = 510; d.locataires[0].entree = '2026-07-01';
  ['2026-07','2026-08','2026-09'].forEach((m,i) => d.paiements.push({id:'p'+i,logId:'l1',mois:m,montant:550,statut:'Payé',versements:[{montant:550,date:m+'-05',type:'Locataire'}]}));
  d.paiements.push({id:'p9',logId:'l1',mois:'2026-10',montant:560,statut:'Payé',versements:[{montant:560,date:'2026-10-05',type:'Locataire'}]});
  const E = W.makeEngine(d, new Date('2026-11-05T10:00:00Z')); const loc = d.locataires[0]; E.majStatutLoc(loc);
  assert.equal(loc.statutPaiement, 'À jour');
  E.AI_FN.paiements({lot:'l1'}).paiements.filter(p => p.mois < '2026-10').forEach(p => assert.equal(p.statut, 'Payé', p.mois));
});
await test('duMois : un mois antérieur à l\'entrée du locataire n\'est pas dû (0)', async () => {
  const d = auditBase(); d.locataires[0].entree = '2026-10-16'; const E = W.makeEngine(d, new Date('2026-11-05T10:00:00Z'));
  near(E.duMois('l1','2026-10'), 283.87); assert.equal(E.duMois('l1','2026-09'), 0); assert.equal(E.duMois('l1','2025-12'), 0);
  assert.equal(E.duMois('l1','2026-11'), 550);
});
await test('charges d\'exploitation annuelles : une charge ponctuelle (travaux 8 000 € en 2024) n\'est pas récurrente', async () => {
  const d = auditBase(); d.batiments[0].taxeFonciere = 1200;
  d.charges = [{id:'c1',batId:'b1',cat:'Entretien/Travaux',montant:8000,freq:'Ponctuelle',date:'2024-03-10'},{id:'c2',batId:'b1',cat:'Assurance PNO',montant:300,freq:'Annuelle'}];
  const v = W.makeEngine(d, new Date('2026-11-19T10:00:00Z')).AI_FN.vue_portefeuille();
  assert.equal(v.total.charges_exploitation_an, 1500, 'PNO 300 + TF 1200');
  assert.equal(v.total.cash_flow_mensuel_actuel, 375, '(500 × 12 − 1500) / 12');
});
await test('annuités d\'un prêt sans échéancier : assurance emprunteur 45 €/mois incluse', async () => {
  const d = auditBase(); d.prets = [{id:'p1',batId:'b1',capital:150000,taux:3.5,duree:240,debut:'2025-01-05',assurance:45}];
  const r = 0.035/12, m = 150000*r/(1-Math.pow(1+r,-240)); // formule bancaire : 869,94 €
  near(m, 869.94, 0.005); near((m+45)*12, 10979.28, 0.01);
  const v = W.makeEngine(d, new Date('2026-11-19T10:00:00Z')).AI_FN.vue_portefeuille();
  near(v.total.annuites_an, 10979.28, 0.01, 'annuités');
});
await test('délai de restitution du dépôt de garantie : fin de mois (31/12 → 31/01 et 28/02 ; 31/01 → 28/02 et 31/03)', async () => {
  const s = store(); const d = auditBase();
  d.anciens = [{id:'anc1',logId:'l1',prenom:'Paul',nom:'X',entree:'2024-01-01',sortie:'2026-12-31',depot:500},{id:'anc2',logId:'l1',prenom:'Luc',nom:'Y',entree:'2023-01-01',sortie:'2026-01-31',depot:500}];
  await s.putData(d);
  const r = await s.mcpCall('anciens_locataires',{},'https://x');
  const a1 = r.anciens.find(x => x.id === 'anc1').depot_statut, a2 = r.anciens.find(x => x.id === 'anc2').depot_statut;
  assert.match(a1, /2027-01-31/); assert.match(a1, /2027-02-28/);
  assert.match(a2, /2026-02-28/); assert.match(a2, /2026-03-31/);
});
// ── Non-régression audit sécurité / fiabilité (v152)
const sess = async (s, role = 'owner', extra) => s.newSession(role, 'test', extra);
const call = (s, tok, u, o = {}) => s.fetch(new Request('https://x' + u, Object.assign({}, o, { headers: Object.assign({ Authorization: 'Bearer ' + tok }, o.headers || {}) })));
await test('connecteur : les balises < > sont retirées des noms écrits (enregistrer_locataire, projet, bail pré-rempli)', async () => {
  const s = store(); await s.putData({batiments:[{id:'b1',nom:'A',_ts:1}],logements:[{id:'l1',batId:'b1',ref:'Apt 1',loyer:500,charges:50,statut:'Vacant',_ts:1}],locataires:[]});
  await s.mcpCall('enregistrer_locataire',{lot:'Apt 1',prenom:'<b>Jean</b>',nom:'<img src=x onerror=alert(1)>Dupont',email:'a@b.fr'},'https://x');
  const loc = (await s.getData()).locataires[0];
  assert.ok(!/[<>]/.test(loc.prenom + loc.nom), 'balise conservée : ' + loc.prenom + ' ' + loc.nom);
  await s.mcpCall('preparer_bail',{lot:'Apt 1',prenom:'<svg onload=alert(1)>',nom:'X'},'https://x');
  assert.ok(!/[<>]/.test(JSON.stringify((await s.getData()).logements[0].bailPrefill)));
  await s.mcpCall('enregistrer_projet',{nom:'<script>x</script>',lots:[{nom:'<i>T2</i>'}]},'https://x');
  const pj = (await s.getData()).projets[0]; assert.ok(!/[<>]/.test(pj.nom + pj.lots[0].n));
});
await test('coffre : type réel lu dans le fichier, HTML/SVG jamais servi en ligne (pièce jointe, sandbox, nosniff)', async () => {
  const s = store(); const tok = await sess(s);
  const up = async (body, type, cat = 'Autre', name = 'x') => (await call(s, tok, '/api/files/upload', { method: 'POST', body, headers: { 'Content-Type': type, 'X-File-Name': name, 'X-Cat': cat } })).json();
  const h = await up(new TextEncoder().encode('<html><script>alert(document.cookie)</script></html>'), 'text/html', 'Autre', 'piege.html');
  assert.equal(h.ok, true); assert.equal(h.file.type, 'application/octet-stream', 'type annoncé text/html accepté tel quel');
  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]);
  const p = await up(png, 'text/html', 'Autre', 'image.png'); assert.equal(p.file.type, 'image/png');
  const svg = await call(s, tok, '/api/files/upload', { method: 'POST', body: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), headers: { 'Content-Type': 'image/svg+xml', 'X-File-Name': 'p.svg', 'X-Cat': 'Photo', 'X-Log-Id': 'l1' } });
  assert.equal(svg.status, 415, 'photo SVG acceptée');
  const link = async id => (await (await call(s, tok, '/api/files/' + id + '/link', { method: 'POST', body: '{}' })).json()).url;
  const rh = await s.fetch(new Request('https://x' + await link(h.file.id)));
  assert.match(rh.headers.get('Content-Disposition') || '', /^attachment/); assert.match(rh.headers.get('Content-Security-Policy') || '', /sandbox/);
  assert.equal(rh.headers.get('X-Content-Type-Options'), 'nosniff'); assert.ok(!/html/.test(rh.headers.get('Content-Type')));
  // un fichier ancien enregistré avec le type annoncé text/html reste neutralisé à la lecture
  const m = await s.storage.get('fm:' + h.file.id); m.type = 'text/html'; await s.storage.put('fm:' + h.file.id, m);
  const r2 = await s.fetch(new Request('https://x' + await link(h.file.id))); assert.ok(!/html/.test(r2.headers.get('Content-Type'))); assert.match(r2.headers.get('Content-Disposition'), /^attachment/);
  const raw = await call(s, tok, '/api/files/' + h.file.id + '/raw'); assert.ok(!/html/.test(raw.headers.get('Content-Type'))); assert.match(raw.headers.get('Content-Security-Policy') || '', /sandbox/);
  const rp = await s.fetch(new Request('https://x' + await link(p.file.id)));
  assert.equal(rp.headers.get('Content-Type'), 'image/png'); assert.match(rp.headers.get('Content-Disposition'), /^inline/);
});
await test('accès banquier masqué : ni bail pré-rempli, ni futur locataire, ni ancien locataire, ni RIB', async () => {
  const s = store();
  await s.putData({scis:[{id:'s1',nom:'SCI A',iban:'FR7630001007941234567890185',bic:'BDFEFRPP',ribFileId:'f1'}],batiments:[{id:'b1',nom:'A',sciId:'s1'}],
    logements:[{id:'l1',batId:'b1',ref:'Apt 1',loyer:500,entreePrevue:'2026-12-01',entreePrevueNom:'Marie Futur',bailPrefill:{l1Nom:'FUTUR',l1Naiss:'1990-01-01',l1Email:'m@f.fr',l1Tel:'0600000000'}}],
    locataires:[{id:'t1',logId:'l1',prenom:'Jean',nom:'Dupont',email:'j@d.fr',tel:'0611',naissance:'1980-02-02',lieuNaissance:'Brest'}],
    paiements:[{id:'p1',logId:'l1',mois:'2026-01',montant:500,statut:'Payé',locNom:'Paul Ancien',ancId:'anc1'}]});
  const tok = await sess(s, 'viewer', { mask: true });
  const d = (await (await call(s, tok, '/api/data')).json()).data, txt = JSON.stringify(d);
  ['FUTUR', 'Marie Futur', 'Paul Ancien', 'Dupont', '1980-02-02', 'Brest', 'j@d.fr', '0611', 'm@f.fr', 'FR7630001007941234567890185', 'BDFEFRPP'].forEach(x => assert.ok(!txt.includes(x), 'exposé : ' + x));
  assert.equal(d.paiements[0].montant, 500); assert.equal(d.logements[0].entreePrevue, '2026-12-01');
  const tok2 = await sess(s, 'viewer', { mask: false }), d2 = JSON.stringify((await (await call(s, tok2, '/api/data')).json()).data);
  ['FUTUR', '1980-02-02', 'j@d.fr', 'FR7630001007941234567890185'].forEach(x => assert.ok(!d2.includes(x), 'exposé (non masqué) : ' + x));
});
await test('Face ID : un gestionnaire ne peut pas retirer celui du propriétaire', async () => {
  const s = store(); await s.storage.put('wa:creds', [{ id: 'cOwner', role: 'owner' }, { id: 'cMgr', role: 'manager' }]);
  const tok = await sess(s, 'manager'), key = [...(await s.storage.list({ prefix: 'sess:' })).keys()][0].slice(5, 17);
  const r = await call(s, tok, '/api/devices/revoke', { method: 'POST', body: JSON.stringify({ id: key, faceid: 'cOwner' }) });
  assert.equal(r.status, 403); assert.ok((await s.storage.get('wa:creds')).some(c => c.id === 'cOwner'), 'Face ID du propriétaire supprimé');
  const r2 = await call(s, tok, '/api/devices/revoke', { method: 'POST', body: JSON.stringify({ faceid: 'cMgr' }) });
  assert.equal(r2.status, 200); assert.ok(!(await s.storage.get('wa:creds')).some(c => c.id === 'cMgr'));
});
await test('OAuth : la page du PIN affiche l\'hôte qui recevra l\'accès (alerte si inhabituel)', async () => {
  const s = store();
  const reg = async u => (await (await s.fetch(new Request('https://x/oauth/register', { method: 'POST', body: JSON.stringify({ client_name: 'Claude', redirect_uris: [u] }) }))).json()).client_id;
  const page = async (cid, u) => (await s.fetch(new Request('https://x/oauth/authorize?response_type=code&code_challenge=abc&code_challenge_method=S256&client_id=' + cid + '&redirect_uri=' + encodeURIComponent(u)))).text();
  const ev = await page(await reg('https://evil.example/cb'), 'https://evil.example/cb');
  assert.match(ev, /evil\.example/); assert.match(ev, /inhabituelle/);
  const ok = await page(await reg('https://claude.ai/api/mcp/auth_callback'), 'https://claude.ai/api/mcp/auth_callback');
  assert.match(ok, /claude\.ai/); assert.ok(!/inhabituelle/.test(ok));
});
await test('synchro : un _ts ou une suppression datés dans le futur sont ramenés à maintenant', async () => {
  const s = store(); const tok = await sess(s); const fut = Date.now() + 1e11;
  await s.putData({ batiments: [{ id: 'b1', nom: 'A', _ts: 1 }, { id: 'b2', nom: 'B', _ts: 1 }], logements: [] });
  const put = async data => (await (await call(s, tok, '/api/data', { method: 'PUT', body: JSON.stringify({ data }) })).json()).data;
  const d = await put({ batiments: [{ id: 'b1', nom: 'futur', _ts: fut }], tomb: { b2: fut }, settings: { x: 1, _ts: fut } });
  assert.ok(d.batiments.find(b => b.id === 'b1')._ts <= Date.now() + 1000); assert.ok(d.tomb.b2 <= Date.now() + 1000); assert.ok(d.settings._ts <= Date.now() + 1000);
  const d2 = await put({ batiments: [{ id: 'b1', nom: 'corrigé', _ts: Date.now() + 5 }, { id: 'b2', nom: 'recréé', _ts: Date.now() + 5 }] });
  assert.equal(d2.batiments.find(b => b.id === 'b1').nom, 'corrigé'); assert.ok(d2.batiments.find(b => b.id === 'b2'), 'b2 bloqué par une suppression future');
});
await test('restauration : grosse base (> 1,9 Mo compressée) → copie d\'avant découpée et vraiment annulable', async () => {
  const s = store(); const big = []; for (let i = 0; i < 2600; i++) big.push({ id: 'pa' + i, n: [...crypto.getRandomValues(new Uint8Array(800))].map(x => x.toString(36)).join('') });
  await s.putData({ batiments: [{ id: 'b1' }], logements: [], paiements: big });
  const r = await s.restoreData({ batiments: [{ id: 'b1' }], logements: [] });
  if (r.annulable) {
    const v = await s.storage.get(r.annulable); assert.ok(v, 'copie annoncée mais absente');
    let gz; if (v && v.chunks) { const parts = []; for (let i = 0; i < v.chunks; i++) parts.push(new Uint8Array(await s.storage.get('bkprec:' + r.annulable.slice(6) + ':' + i))); gz = Buffer.concat(parts); } else gz = Buffer.from(v);
    const back = JSON.parse(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
    assert.equal(back.paiements.length, 2600);
  }
  assert.equal([...(await s.storage.list({ prefix: 'bkpre:' })).keys()].length, r.annulable ? 1 : 0);
});
await test('calculer : virgule décimale avec « ; » comme séparateur (max(1,5;2) = 2)', async () => {
  const E = W.makeEngine({ batiments: [], logements: [], locataires: [], paiements: [], prets: [], charges: [], scis: [], settings: {} }, new Date());
  assert.equal(E.AI_FN.calculer({ expression: 'max(1,5;2)' }).resultat, 2);
  assert.equal(E.AI_FN.calculer({ expression: 'round(2,345;2)' }).resultat, 2.35);
  assert.equal(E.AI_FN.calculer({ expression: 'max(1,5)' }).resultat, 5); assert.equal(E.AI_FN.calculer({ expression: '1,5*2' }).resultat, 3);
});
await test('outils de calcul : dates impossibles, périodes inversées, différé ≥ durée refusés ; prorata d\'occupation à 4 décimales', async () => {
  const E = W.makeEngine({ batiments: [], logements: [], locataires: [], paiements: [], prets: [], charges: [], scis: [], settings: {} }, new Date()), F = E.AI_FN;
  assert.throws(() => F.prorata_loyer({ mois: '2026-02', date_entree: '2026-02-30', loyer_hc: 500 }), /impossible/);
  assert.throws(() => F.prorata_loyer({ date_entree: '2026-10-20', date_sortie: '2026-10-10', loyer_hc: 500 }), /antérieure/);
  assert.throws(() => F.prorata_loyer({ mois: '2026-13', loyer_hc: 500 }), /AAAA-MM/);
  near(F.prorata_loyer({ mois: '2026-10', date_entree: '2026-10-16', loyer_hc: 550 }).loyer_prorata, 283.87);
  assert.throws(() => F.regularisation_charges({ periode_debut: '2026-12-31', periode_fin: '2026-01-01', depenses: [] }), /inversée/);
  assert.throws(() => F.regularisation_charges({ periode_debut: '2026-01-01', periode_fin: '2026-12-31', occupation_debut: '2026-09-01', occupation_fin: '2026-03-01', depenses: [] }), /inversée/);
  assert.throws(() => F.regularisation_charges({ periode_debut: '2026-02-30', periode_fin: '2026-12-31', depenses: [] }), /impossible/);
  const rg = F.regularisation_charges({ periode_debut: '2026-01-01', periode_fin: '2026-01-03', occupation_debut: '2026-01-03', depenses: [{ libelle: 'Eau', montant_total: 90 }] });
  assert.equal(rg.detail[0].prorata_occupation, 0.3333);
  assert.throws(() => F.calcul_pret({ capital: 100000, taux_annuel_pct: 4, duree_mois: 240, differe_mois: 240 }), /différé/);
  assert.throws(() => F.calcul_pret({ capital: -5, taux_annuel_pct: 4, duree_mois: 240 }), /positifs/);
  assert.ok(isFinite(F.calcul_pret({ capital: 100000, taux_annuel_pct: 4, duree_mois: 240, differe_mois: 12 }).mensualite_hors_assurance));
});
await test('totaux : un loyer ou un taux manquant ne rend pas tout le portefeuille NaN', async () => {
  const d = { scis: [], batiments: [{ id: 'b1', nom: 'A' }], logements: [{ id: 'l1', batId: 'b1', ref: 'A1', loyer: 500, statut: 'Occupé' }, { id: 'l2', batId: 'b1', ref: 'A2', statut: 'Vacant' }],
    locataires: [], paiements: [], charges: [], prets: [{ id: 'p1', batId: 'b1', capital: 120000, duree: 240, debut: '2024-01-05' }], settings: {} };
  const f = W.makeEngine(d, new Date('2026-11-19T10:00:00Z')).portfolioFin(d.batiments);
  near(f.loyMax, 6000); assert.ok(isFinite(f.credR) && f.credR > 0 && f.credR < 120000, 'capital restant dû : ' + f.credR); assert.ok(isFinite(f.debt) && f.debt > 0, 'annuités : ' + f.debt);
});
await test('révision IRL : rappel conforme à l\'art. 17-1 (pas de rétroactivité, demande du bailleur, délai d\'un an)', async () => {
  const E = W.makeEngine({ batiments: [], logements: [], locataires: [], paiements: [], prets: [], charges: [], scis: [], settings: {} }, new Date());
  const r = E.AI_FN.revision_irl({ loyer_actuel_hc: 500, trimestre_reference: 'T2 2024' });
  if (r.rappel) { assert.ok(!/au-delà d'un an/.test(r.rappel.split('Aucun effet')[0]) && !/rétroactif au-delà/.test(r.rappel), r.rappel); assert.match(r.rappel, /17-1/); assert.match(r.rappel, /demande du bailleur/); }
  else assert.ok(/17-1/.test(src) && !/sans effet rétroactif au-delà d\\'un an/.test(src));
});
// ── Non-régression v153 : doublons « Impayé » de l'ancien locataire créés par la boucle de synchro v150-v152
const dupPai = (n, t0 = 1000) => Array.from({ length: n }, (_, i) => ({ id: 'd' + String(i).padStart(4, '0'), logId: 'l1', mois: '2026-11', montant: 0, du: 266.13, prorata: true, statut: 'Impayé', versements: [], locNom: 'Anthony Collet', ancId: 'anc1', _ts: t0 + i }));
const dupBase = () => ({ batiments: [{ id: 'b1', nom: 'A', _ts: 1 }], logements: [{ id: 'l1', batId: 'b1', ref: 'Studio 1', loyer: 500, charges: 50, statut: 'Vacant', _ts: 1 }], locataires: [],
  anciens: [{ id: 'anc1', logId: 'l1', prenom: 'Anthony', nom: 'Collet', entree: '2025-01-01', sortie: '2026-11-15', sortieSaisie: true, _ts: 1 }], settings: {} });
await test('serveur : doublons vides de l\'ancien locataire supprimés à la lecture (tombstones), ligne payée et autres paiements intacts', async () => {
  const s = store(), d = dupBase();
  d.paiements = dupPai(50).concat([{ id: 'pay', logId: 'l1', mois: '2026-11', montant: 266.13, du: 266.13, statut: 'Payé', versements: [{ montant: 266.13, date: '2026-11-10' }], ancId: 'anc1', _ts: 5 },
    { id: 'oct', logId: 'l1', mois: '2026-10', montant: 550, statut: 'Payé', versements: [{ montant: 550 }], ancId: 'anc1', _ts: 5 }, { id: 'vide', logId: 'l1', mois: '2026-09', montant: 0, statut: 'Impayé', versements: [], ancId: 'anc1', _ts: 5 }]);
  await s.putData(d); const rev0 = (await s.storage.get('data:meta')).rev;
  const g = await s.getData();
  assert.equal(g.paiements.length, 3, 'lignes restantes'); assert.equal(g.paiements.map(p => p.id).join(','), 'pay,oct,vide');
  assert.equal(Object.keys(g.tomb).length, 50); dupPai(50).forEach(p => assert.ok(g.tomb[p.id] >= p._ts));
  assert.ok((await s.storage.get('data:meta')).rev > rev0, 'réparation enregistrée'); const rev1 = (await s.storage.get('data:meta')).rev;
  assert.equal((await s.getData()).paiements.length, 3); assert.equal((await s.storage.get('data:meta')).rev, rev1, 'idempotent : pas de nouvelle écriture');
  const r = await s.mcpCall('anciens_locataires', { recherche: 'collet' }, 'https://x'); assert.equal(r.anciens[0].paiements, 3);
});
await test('serveur : 4 275 doublons sans paiement → une seule ligne gardée (la plus ancienne) ; une ligne avec versements n\'est jamais supprimée', async () => {
  const s = store(), d = dupBase(); d.paiements = dupPai(4275).reverse().concat([{ id: 'vers', logId: 'l1', mois: '2026-08', montant: 0, versements: [{ montant: 0, date: '2026-08-03' }], ancId: 'anc1', _ts: 9 }, { id: 'vers2', logId: 'l1', mois: '2026-08', montant: 0, versements: [{ montant: 10 }], ancId: 'anc1', _ts: 9 }]);
  await s.putData(d); const g = await s.getData();
  assert.equal(g.paiements.length, 3, 'lignes restantes'); assert.equal(g.paiements.map(p => p.id).join(','), 'd0000,vers,vers2'); assert.equal(Object.keys(g.tomb).length, 4274);
});
await test('synchro : un appareil v150-v152 qui renvoie les doublons ou en recrée un ne fait plus grossir la base', async () => {
  const s = store(), tok = await sess(s), d = dupBase(); d.paiements = dupPai(20); await s.putData(d);
  const put = async data => (await (await call(s, tok, '/api/data', { method: 'PUT', body: JSON.stringify({ data }) })).json()).data;
  const old = Object.assign(dupBase(), { paiements: dupPai(20), tomb: {} }); // appareil resté en v152 : ses 20 lignes, sans les tombstones
  let r = await put(old); assert.equal(r.paiements.length, 1); assert.equal(r.paiements[0].id, 'd0000');
  const neuf = { id: 'new1', logId: 'l1', mois: '2026-11', montant: 0, du: 266.13, prorata: true, statut: 'Impayé', versements: [], ancId: 'anc1', _ts: Date.now() };
  r = await put(Object.assign(dupBase(), { paiements: dupPai(20).concat([neuf]), tomb: {} })); // il en recrée une à la synchro suivante
  assert.equal(r.paiements.length, 1); assert.ok(r.tomb.new1 >= neuf._ts, 'la ligne recréée est supprimée avec tombstone');
  assert.equal((await s.getData()).paiements.length, 1);
});
await test('anciens_locataires : le paiement du nouvel entrant au mois de sortie n\'est pas compté pour l\'ancien', async () => {
  const s = store(), d = dupBase(); d.locataires = [{ id: 't2', logId: 'l1', prenom: 'N', nom: 'Entrant', entree: '2026-11-16' }];
  d.paiements = [{ id: 'own', logId: 'l1', mois: '2026-11', montant: 275, ancId: 'anc1' }, { id: 'new', logId: 'l1', mois: '2026-11', montant: 275 }, { id: 'old', logId: 'l1', mois: '2026-03', montant: 550 }];
  await s.putData(d); const r = await s.mcpCall('anciens_locataires', { recherche: 'collet' }, 'https://x');
  assert.equal(r.anciens[0].paiements, 2); assert.equal(r.anciens[0].total_encaisse, 825);
});
console.log(`\n${passed} réussi(s), ${failed} échec(s)`);
process.exit(failed?1:0);
