'use strict';

function parseCsvResponse(response, callback) {
  const chunks = [];
  response.on('data', chunk => chunks.push(Buffer.from(chunk)));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
  response.on('error', callback);
}

module.exports = { parseCsvResponse };
