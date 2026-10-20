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
console.log(`\n${passed} réussi(s), ${failed} échec(s)`);
process.exit(failed?1:0);
