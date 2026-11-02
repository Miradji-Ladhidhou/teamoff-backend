'use strict';

jest.mock('../../src/models', () => ({ Entreprise: { findByPk: jest.fn() }, Utilisateur: { findOne: jest.fn() } }));
const { Entreprise, Utilisateur } = require('../../src/models');
const { canReadComments, maskCommentFields, filterRecordComments } = require('../../src/services/commentVisibilityService');

beforeEach(() => jest.clearAllMocks());

test.each(['super_admin', 'admin_entreprise', 'manager', 'employe', 'apprenti'])('une restriction %s ne retire ni les dossiers personnels ni les commentaires stockés', async role => {
  const preferences = { comment_reading: { [role]: { conges: false } } };
  const recipient = { id: 'reader', role };
  expect(canReadComments(preferences, recipient, 'conges', 'owner')).toBe(false);
  expect(canReadComments(preferences, recipient, 'conges', 'reader')).toBe(true);
  expect(canReadComments(preferences, recipient, 'maladie', 'owner')).toBe(true);
  Entreprise.findByPk.mockResolvedValue({ parametres: { notifications: preferences } });
  const record = { entreprise_id: 'company', utilisateur_id: 'owner', commentaire_employe: 'Privé',
    commentaire_manager: 'Manager', commentaire_admin: 'Admin', statut: 'valide_final' };
  const filtered = await filterRecordComments([record, record, { ...record, utilisateur_id: 'reader' }], recipient);
  expect(filtered[0]).toMatchObject({ commentaire_employe: null, commentaire_manager: null, commentaire_admin: null, statut: 'valide_final' });
  expect(filtered[2].commentaire_employe).toBe('Privé');
  expect(record.commentaire_employe).toBe('Privé');
  expect(Entreprise.findByPk).toHaveBeenCalledTimes(1);
});

test('les catégories et entreprises sont isolées, y compris les demandes formelles imbriquées', async () => {
  Entreprise.findByPk.mockImplementation(async id => ({ parametres: { notifications: {
    comment_reading: { manager: { conges: id === 'other', maladie: false } },
  } } }));
  const record = { entreprise_id: 'company', utilisateur_id: 'owner', commentaire_employe: 'Motif',
    conge: { commentaire_manager: 'Décision' } };
  const filtered = await filterRecordComments({ rows: [record, { ...record, entreprise_id: 'other' },
    { entreprise_id: 'company', utilisateur_id: 'owner', type_absence: 'maladie', commentaire: 'Santé' },
    { entreprise_id: 'company', utilisateur_id: 'owner', type_absence: 'absence_exceptionnelle', commentaire: 'Absence' }] },
  { role: 'manager', id: 'manager' });
  expect(filtered.rows[0].conge.commentaire_manager).toBeNull();
  expect(filtered.rows[1].commentaire_employe).toBe('Motif');
  expect(filtered.rows[2].commentaire).toBeNull();
  expect(filtered.rows[3].commentaire).toBe('Absence');
});

test('le masque email traite les anciens commentaires et les blocs HTML sans modifier les données ni les dates', () => {
  const date = new Date();
  const data = { commentaire: 'Motif', ancien_commentaire_employe: 'Avant', comments_rows: '<div>Privé</div>',
    conge: { commentaire_admin: 'Décision' }, requires_manager_comment: true, date };
  const result = maskCommentFields(data);
  expect(result).toEqual({ commentaire: null, ancien_commentaire_employe: null, comments_rows: null,
    conge: { commentaire_admin: null }, requires_manager_comment: true, date });
  expect(data.conge.commentaire_admin).toBe('Décision');
});

test('un échec de lecture des droits est propagé, jamais remplacé par une autorisation', async () => {
  Entreprise.findByPk.mockRejectedValue(new Error('Lecture impossible'));
  await expect(filterRecordComments({ entreprise_id: 'company', utilisateur_id: 'owner', commentaire: 'Privé' },
    { id: 'manager', role: 'manager' })).rejects.toThrow('Lecture impossible');
});

test('un ancien audit d’absence sans type ne contourne pas une restriction médicale', async () => {
  Entreprise.findByPk.mockResolvedValue({ parametres: { notifications: {
    comment_reading: { super_admin: { maladie: false } },
  } } });
  const audit = { entreprise_id: 'company', entity: 'Absence', metadata: { updates: { commentaire: 'Privé' } } };
  const result = await filterRecordComments([audit], { role: 'super_admin', id: 'reader' });
  expect(result[0].metadata.updates.commentaire).toBeNull();
  expect(audit.metadata.updates.commentaire).toBe('Privé');
});

test('la case nominative suit le service du demandeur, prime sur le rôle et ne touche pas aux dossiers personnels', async () => {
  const rules = { notification_routing: { RH: { conges: { reader: { comments: false } } },
    Finance: { conges: { reader: { comments: true } } } } };
  const preferences = { comment_reading: { manager: { conges: false } } };
  const reader = { id: 'reader', role: 'manager' };
  expect(canReadComments(preferences, reader, 'conges', 'owner', rules, 'Finance')).toBe(true);
  expect(canReadComments({}, reader, 'conges', 'owner', rules, 'RH')).toBe(false);
  expect(canReadComments(preferences, reader, 'conges', 'reader', rules, 'RH')).toBe(true);
  Entreprise.findByPk.mockResolvedValue({ parametres: { notifications: preferences }, politique_conges: rules });
  Utilisateur.findOne.mockResolvedValue({ service: 'RH' });
  const record = { entreprise_id: 'company', utilisateur_id: 'owner', commentaire_employe: 'Privé' };
  const result = await filterRecordComments([record, record], reader);
  expect(result.every(item => item.commentaire_employe === null)).toBe(true);
  expect(Utilisateur.findOne).toHaveBeenCalledTimes(1);
  expect(Utilisateur.findOne).toHaveBeenCalledWith({ where: { id: 'owner', entreprise_id: 'company' }, attributes: ['service'] });
});
