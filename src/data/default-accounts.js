'use strict';

/**
 * Seeded for every new account so a movimento can be linked to a conto
 * straight away. Users can rename, recolor, add or delete them afterwards.
 */
module.exports = [
  { name: 'Contanti', kind: 'cash', color: '#4cc9a4' },
  { name: 'Conto corrente', kind: 'bank', color: '#6c8cff' },
  { name: 'Carta di credito', kind: 'card', color: '#b57edc' },
];
