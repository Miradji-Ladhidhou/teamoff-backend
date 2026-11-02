'use strict';

function futureWorkingWeek() {
  const monday = new Date();
  monday.setUTCDate(monday.getUTCDate() + 30);
  monday.setUTCDate(monday.getUTCDate() + (8 - monday.getUTCDay()) % 7);
  const friday = new Date(monday);
  friday.setUTCDate(friday.getUTCDate() + 4);
  return {
    date_debut: monday.toISOString().slice(0, 10),
    date_fin: friday.toISOString().slice(0, 10),
    annee: monday.getUTCFullYear(),
  };
}

module.exports = { futureWorkingWeek };
