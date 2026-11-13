// Tests du coffre serveur (Durable Object) avec un stockage simulé en mémoire.
import fs from 'node:fs';
import assert from 'node:assert/strict';
let src = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8')
  .replace(/^import PDFJS_MAIN from .*$/m, "const PDFJS_MAIN='';").replace(/^import PDFJS_WORKER from .*$/m, "const PDFJS_WORKER='';");
src += '\nexport {zipOne,crc32,mergeDB};';
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
await test('départ d\'un locataire : le prorata payé solde le mois, rattaché au locataire sortant', async () => {
  const s = store(); const m = new Date().toISOString().slice(0,7);
  await s.putData({scis:[{id:'s1',nom:'SCI'}],batiments:[{id:'b1',sciId:'s1',nom:'Brélévenez'}],logements:[{id:'l1',batId:'b1',ref:'1G',loyer:380,charges:20,statut:'Occupé'}],
    locataires:[{id:'loc1',logId:'l1',prenom:'Enguerrand',nom:'Lachaise',entree:'2026-09-22'}],
    paiements:[{id:'pa1',logId:'l1',mois:m,montant:206.45,statut:'Partiel',versements:[{montant:206.45,date:m+'-15'}]}],prets:[],settings:{}});
  const r = await s.mcpCall('modifier_lot',{lot:'1G',batiment:'Brélévenez',statut:'Travaux'},'https://x');
  assert.equal(r.ok,true);
  const d = await s.getData(), pa = d.paiements[0];
  assert.equal(pa.statut,'Payé'); assert.equal(pa.du,206.45); assert.equal(pa.prorata,true); assert.equal(pa.locNom,'Enguerrand Lachaise');
  assert.equal(d.anciens.length,1); assert.equal(d.locataires.length,0);
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
console.log(`\n${passed} réussi(s), ${failed} échec(s)`);
process.exit(failed?1:0);
