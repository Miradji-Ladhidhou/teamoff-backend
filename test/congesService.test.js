const congesService = require('../src/services/congesService');

describe('Conges Service (smoke)', () => {
  it('exports expected public methods', () => {
    expect(typeof congesService.createConge).toBe('function');
    expect(typeof congesService.getConges).toBe('function');
    expect(typeof congesService.getCongeById).toBe('function');
    expect(typeof congesService.updateConge).toBe('function');
    expect(typeof congesService.deleteConge).toBe('function');
    expect(typeof congesService.validerConge).toBe('function');
    expect(typeof congesService.rejeterConge).toBe('function');
    expect(typeof congesService.calcJoursConges).toBe('function');
  });
});
