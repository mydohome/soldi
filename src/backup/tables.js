'use strict';

/**
 * Tables to back up, in a foreign-key-safe order (parents first).
 * Restore truncates and re-inserts in this same order; the reverse order is
 * used when clearing existing rows.
 */
module.exports = [
  { name: 'users', columns: ['id', 'email', 'password_hash', 'display_name', 'created_at'] },
  {
    name: 'categories',
    columns: ['id', 'user_id', 'name', 'color', 'kind', 'created_at'],
  },
  {
    name: 'accounts',
    columns: ['id', 'user_id', 'name', 'kind', 'color', 'created_at'],
  },
  {
    name: 'recurring_rules',
    columns: [
      'id',
      'user_id',
      'name',
      'type',
      'amount_cents',
      'category_id',
      'account_id',
      'scope',
      'day_of_month',
      'note',
      'active',
      'start_month',
      'last_run_month',
      'created_at',
    ],
  },
  {
    name: 'transactions',
    columns: [
      'id',
      'user_id',
      'type',
      'amount_cents',
      'category_id',
      'account_id',
      'recurring_rule_id',
      'scope',
      'note',
      'occurred_on',
      'created_at',
    ],
  },
];
