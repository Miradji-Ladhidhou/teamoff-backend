'use strict';

const {
  CATEGORIES, normalizeManagerCrossServicePolicy, validateManagerCrossServicePolicy,
  getManagerCategorySettings, resolveManagerDelivery,
} = require('../src/services/managerCrossServicePolicy');

test('la compatibilité conserve exactement les anciens droits sans nouveau canal absence', () => {
  const config = normalizeManagerCrossServicePolicy({
    manager_can_validate_all_services: true, manager_can_view_all_absences: true,
  });
  expect(config.conges).toEqual({ view: true, email: true, in_app: true, participation: 'action' });
  for (const type of ['maladie', 'absence_exceptionnelle']) {
    expect(config[type]).toEqual({ view: true, email: true, in_app: false, participation: 'information' });
  }
});

test.each(CATEGORIES)('les canaux %s sont indépendants des droits et des autres catégories', category => {
  const manager = { service: 'RH' };
  for (const email of [true, false]) {
    for (const in_app of [true, false]) {
      const rules = { service_policies: { RH: { manager_cross_service: {
        [category]: { view: false, email, in_app, participation: 'information' },
      } } } };
      const delivery = resolveManagerDelivery({ rules, manager, targetService: 'IT', category, actionRequired: true });
      expect(delivery).toEqual({ local: false, canView: false, canAct: false, email, in_app, mode: 'information' });
      for (const other of CATEGORIES.filter(type => type !== category)) {
        expect(getManagerCategorySettings(rules, manager, other)).toEqual({
          view: false, email: false, in_app: false, participation: 'information',
        });
      }
    }
  }
});

test.each(CATEGORIES)('peut agir sur %s implique la consultation, jamais l’activation des canaux', category => {
  const manager = { service: 'RH' };
  const rules = { service_policies: { RH: { manager_cross_service: {
    [category]: { email: false, in_app: false, participation: 'action' },
  } } } };
  const resolve = actionRequired => resolveManagerDelivery({ rules, manager, targetService: 'IT', category, actionRequired });
  expect(resolve(true)).toMatchObject({ mode: 'action', canAct: true, canView: true, email: false, in_app: false });
  expect(resolve(false)).toMatchObject({ mode: 'information', canAct: true });
});

test('le propre service conserve ses droits et les managers sans service n’obtiennent aucun accès global', () => {
  expect(resolveManagerDelivery({ rules: {}, manager: { service: 'RH' }, targetService: 'RH', actionRequired: true }))
    .toMatchObject({ local: true, canAct: true, canView: true, email: true, in_app: true, mode: 'action' });
  expect(resolveManagerDelivery({ rules: {}, manager: { service: null }, targetService: 'RH', actionRequired: true }))
    .toMatchObject({ local: false, canAct: false, canView: false, email: false, in_app: false, mode: 'information' });
});

test.each([
  null, 'true', [], { inconnu: {} }, { conges: null },
  { maladie: { email: 'true' } }, { conges: { participation: 'validation' } },
  { conges: { extra: true } },
])('rejette un paramètre mal formé sans succès trompeur (%j)', value => {
  expect(() => validateManagerCrossServicePolicy(value)).toThrow(/invalides/);
  try { validateManagerCrossServicePolicy(value); } catch (error) { expect(error.status).toBe(400); }
});

test('une règle explicite peut révoquer les anciens droits', () => {
  const config = normalizeManagerCrossServicePolicy({
    manager_can_validate_all_services: true,
    manager_cross_service: { conges: { view: false, email: false, in_app: false, participation: 'information' } },
  });
  expect(config.conges).toEqual({ view: false, email: false, in_app: false, participation: 'information' });
});
