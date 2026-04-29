// UUID v4 strict : version = 4, variante = 8/9/a/b (RFC 4122)
// Rejette volontairement v1/v3/v5 qui ne sont pas cryptographiquement aléatoires.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Middleware factory : valide que req.params[paramName] est un UUID v4 valide.
 * Retourne 400 si invalide, évitant des erreurs Sequelize peu claires.
 *
 * Usage : router.get('/:id', validateUUIDParam('id'), handler)
 *         router.get('/:userId/...', validateUUIDParam('userId'), handler)
 */
function validateUUIDParam(paramName = 'id') {
  return (req, res, next) => {
    const value = req.params[paramName];
    if (!value || !UUID_V4_RE.test(value)) {
      return res.status(400).json({ message: `Paramètre invalide : ${paramName} doit être un UUID valide` });
    }
    next();
  };
}

module.exports = validateUUIDParam;
