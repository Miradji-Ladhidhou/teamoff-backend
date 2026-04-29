'use strict';
const { randomUUID } = require('crypto');
const { runWithRequestId } = require('../utils/requestContext');

function requestId(req, res, next) {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);
  runWithRequestId(req.id, () => next());
}

module.exports = requestId;
