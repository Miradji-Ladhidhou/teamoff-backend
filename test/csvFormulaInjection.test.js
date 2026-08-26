'use strict';
/**
 * csvFormulaInjection.test.js — Fix #37
 *
 * Un champ commençant par =, +, -, @, \t ou \r est exécuté comme formule
 * dans Excel / LibreOffice à l'ouverture du CSV.
 * AVANT fix : les valeurs arrivent telles quelles dans le fichier.
 * APRÈS fix  : chaque cellule dangereuse est préfixée d'une apostrophe ('=... → ''=...).
 *
 * On teste via les méthodes ExportService directement pour inspecter le CSV brut.
 */

const bcrypt       = require('bcrypt');
const ExportService = require('../src/services/exportService');
const { Entreprise, Utilisateur, Conge, CongeType } = require('../src/models');

const TS = Date.now();

let entreprise, admin, injectUser, congeType, conge;

beforeAll(async () => {
  const hash = await bcrypt.hash('Test1234!', 10);

  entreprise = await Entreprise.create({
    nom: `Inject37_${TS}`,
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });

  admin = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Admin', nom: 'Normal37',
    email: `admin.inject37.${TS}@test.internal`,
    role: 'admin_entreprise', password_hash: hash, statut: 'actif',
  });

  // Utilisateur dont le prénom commence par = (injection formula)
  injectUser = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: '=CMD(calc)',       // payload Excel classique
    nom:    '+HYPERLINK("http://evil.example")',
    email:  `inject37.${TS}@test.internal`,
    role: 'employe', password_hash: hash, statut: 'actif',
    service: '@SUM(A1:A100)',   // @ est aussi un trigger
  });

  congeType = await CongeType.create({
    entreprise_id: entreprise.id,
    code: `EX37_${String(TS).slice(-8)}`,  // max 20 chars
    libelle: '-EXPLOIT',        // - est aussi un trigger
    jours_par_an: 25,
    actif: true,
  });

  conge = await Conge.create({
    entreprise_id: entreprise.id,
    utilisateur_id: injectUser.id,
    conge_type_id: congeType.id,
    date_debut: '2025-07-01',
    date_fin: '2025-07-05',
    statut: 'en_attente_manager',
    motif: 'test',
  });
});

afterAll(async () => {
  await Conge.destroy({ where: { id: conge.id } }).catch(() => {});
  await CongeType.destroy({ where: { id: congeType.id } }).catch(() => {});
  await Utilisateur.destroy({ where: { id: [admin.id, injectUser.id] } }).catch(() => {});
  await Entreprise.destroy({ where: { id: entreprise.id } }).catch(() => {});
});

// Helpers
const INJECTION_CHARS = /(?:^|,|")([=+\-@\t\r][^"]*)/;

describe('Fix #37 — CSV formula injection', () => {

  it('generateUtilisateursCSV : prenom =CMD(calc) est neutralisé', async () => {
    const csv = await ExportService.generateUtilisateursCSV(entreprise.id, {});

    // AVANT fix : la cellule CSV est "=CMD(calc)..." (guillemet + = sans apostrophe)
    // APRÈS fix  : la cellule est "'=CMD(calc)..." (apostrophe entre le guillemet et =)
    expect(csv).not.toMatch(/"=CMD\(calc\)/);   // pas de guillemet-direct-= dans le CSV
    expect(csv).toContain("'=CMD(calc)");        // présence du préfixe apostrophe
  });

  it('generateUtilisateursCSV : service @SUM est neutralisé', async () => {
    const csv = await ExportService.generateUtilisateursCSV(entreprise.id, {});
    expect(csv).not.toMatch(/"@SUM/);   // pas de guillemet-direct-@ dans le CSV
    expect(csv).toContain("'@SUM");
  });

  it('generateCongesCSV : champ employe avec = est neutralisé', async () => {
    const csv = await ExportService.generateCongesCSV(entreprise.id, {});

    // Le champ employe est prenom + " " + nom
    expect(csv).not.toMatch(/"=CMD\(calc\)/);
    expect(csv).toContain("'=CMD(calc)");
  });

  it('generateCongesCSV : type de congé commençant par - est neutralisé', async () => {
    const csv = await ExportService.generateCongesCSV(entreprise.id, {});
    expect(csv).not.toMatch(/"-EXPLOIT/);
    expect(csv).toContain("'-EXPLOIT");
  });

  it('aucun caractère dangereux non préfixé dans generateUtilisateursCSV', async () => {
    const csv = await ExportService.generateUtilisateursCSV(entreprise.id, {});

    // Toutes les lignes de données (après le header) ne doivent pas contenir de
    // valeur commençant par un caractère de formule sans le préfixe '
    const dataLines = csv.split('\n').slice(5); // sauter le header TeamOff
    for (const line of dataLines) {
      // Chaque valeur entre guillemets ne doit pas commencer par = + - @ \t \r
      const cells = line.match(/"[^"]*"/g) || [];
      for (const cell of cells) {
        const inner = cell.slice(1, -1); // retirer les guillemets CSV
        if (/^[=+\-@\t\r]/.test(inner)) {
          throw new Error(`Valeur non neutralisée trouvée : ${cell}`);
        }
      }
    }
  });
});
