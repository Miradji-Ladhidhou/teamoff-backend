const {
  validateUUID,
  validateDate,
  validateDateRange,
  validateDemiJournee,
  validateConge,
} = require('../src/utils/validation');

describe('Validation utils', () => {
  it('validateUUID works for valid/invalid UUID', () => {
    expect(validateUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(validateUUID('not-a-uuid')).toBe(false);
  });

  it('validateDate and validateDateRange enforce YYYY-MM-DD and ordering', () => {
    expect(validateDate('2026-03-18')).toBe(true);
    expect(validateDate('18/03/2026')).toBe(false);

    expect(validateDateRange('2026-03-01', '2026-03-10')).toBe(true);
    expect(validateDateRange('2026-03-10', '2026-03-01')).toBe(false);
  });

  it('validateDemiJournee accepts only matin/apres_midi', () => {
    expect(validateDemiJournee('matin')).toBe(true);
    expect(validateDemiJournee('apres_midi')).toBe(true);
    expect(validateDemiJournee('soir')).toBe(false);
  });

  it('validateConge throws for invalid payload and passes for valid payload', () => {
    const valid = {
      utilisateur_id: '550e8400-e29b-41d4-a716-446655440000',
      conge_type_id: '550e8400-e29b-41d4-a716-446655440001',
      date_debut: '2026-03-20',
      date_fin: '2026-03-22',
      debut_demi_journee: 'matin',
      fin_demi_journee: 'apres_midi',
    };

    expect(() => validateConge(valid)).not.toThrow();

    const invalid = { ...valid, date_fin: '2026-03-10' };
    expect(() => validateConge(invalid)).toThrow('Dates invalides ou date_fin < date_debut');
  });
});
