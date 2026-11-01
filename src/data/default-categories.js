'use strict';

/**
 * Seeded for every new account so the app is usable immediately.
 * Users can rename, recolor, move to the other scope, or delete them afterwards.
 */
module.exports = [
  { name: 'Alimentari', color: '#4cc9a4', kind: 'expense', scope: 'home' },
  { name: 'Casa & Bollette', color: '#6c8cff', kind: 'expense', scope: 'home' },
  { name: 'Trasporti', color: '#f4a259', kind: 'expense', scope: 'personal' },
  { name: 'Salute', color: '#e15c7b', kind: 'expense', scope: 'personal' },
  { name: 'Svago', color: '#b57edc', kind: 'expense', scope: 'personal' },
  { name: 'Ristoranti', color: '#f4d35e', kind: 'expense', scope: 'personal' },
  { name: 'Shopping', color: '#5cc8e1', kind: 'expense', scope: 'personal' },
  { name: 'Altro', color: '#9aa4b2', kind: 'expense', scope: 'personal' },
  { name: 'Stipendio', color: '#2fb380', kind: 'income', scope: 'personal' },
  { name: 'Rimborsi', color: '#7bd389', kind: 'income', scope: 'personal' },
  { name: 'Extra', color: '#a0d995', kind: 'income', scope: 'personal' },
];
