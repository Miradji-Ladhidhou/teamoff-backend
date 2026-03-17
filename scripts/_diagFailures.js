require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const { sequelize, Utilisateur, CongeType } = require('../src/models');

(async () => {
  await sequelize.authenticate();
  const adm = await Utilisateur.findOne({ where: { role: 'admin_entreprise' } });
  const mgr = await Utilisateur.findOne({ where: { role: 'manager' } });
  const emp = await Utilisateur.findOne({ where: { role: 'employe' } });

  function tok(u) {
    return jwt.sign({ id: u.id, role: u.role, entreprise_id: u.entreprise_id }, process.env.JWT_SECRET, { expiresIn: '5m' });
  }

  const B = 'http://localhost:5500/api';

  async function get(label, url, token) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    let j; try { j = await r.json(); } catch(_) { j = {}; }
    console.log(`[${label}] ${r.status}: ${j?.message || j?.error || JSON.stringify(j).substring(0, 150)}`);
  }

  async function post(label, url, token, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
    let j; try { j = await r.json(); } catch(_) { j = {}; }
    console.log(`[${label}] ${r.status}: ${j?.message || j?.error || JSON.stringify(j).substring(0, 150)}`);
  }

  console.log('\n=== POST JOURS FERIES - adm ===');
  await post('adm POST JF', `${B}/jours-feries`, tok(adm), { nom: 'Test', date: '2025-09-20', recurrent: false });

  console.log('\n=== CongeType for mgr ===');
  const ct = await CongeType.findOne({ where: { entreprise_id: mgr.entreprise_id } });
  console.log('CongeType:', ct?.id, ct?.code, ct?.entreprise_id);

  console.log('\n=== POST CONGE - manager ===');
  const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+40);
  const dateDebut = d.toISOString().slice(0,10);
  d.setDate(d.getDate()+1);
  const dateFin = d.toISOString().slice(0,10);
  await post('mgr POST CONGE', `${B}/conges/demande`, tok(mgr), {
    utilisateur_id: mgr.id, conge_type_id: ct?.id, date_debut: dateDebut, date_fin: dateFin,
    debut_demi_journee: 'matin', fin_demi_journee: 'apres_midi', commentaire_employe: 'test mgr'
  });

  console.log('\n=== POST CONGE passé ===');
  await post('emp POST past', `${B}/conges/demande`, tok(emp), {
    utilisateur_id: emp.id, conge_type_id: ct?.id,
    date_debut: '2025-01-10', date_fin: '2025-01-11',
    debut_demi_journee: 'matin', fin_demi_journee: 'apres_midi', commentaire_employe: 'test past'
  });

  await sequelize.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
