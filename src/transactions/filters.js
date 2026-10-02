'use strict';

// Filtri dei movimenti, condivisi da GET /api/transactions e dall'esportazione.
// La query deve fare JOIN categories con alias "c" (il filtro q cerca anche nel
// nome della categoria) e leggere transactions con alias "t".

const { z } = require('zod');
const { isoDate } = require('../http/validate');

const filterFields = {
  from: isoDate.optional(),
  to: isoDate.optional(),
  type: z.enum(['expense', 'income']).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  accountId: z.coerce.number().int().positive().optional(),
  scope: z.enum(['personal', 'home']).optional(),
  q: z.string().trim().max(100).optional(),
};

// Escape LIKE wildcards so a user's "%" or "_" is matched literally.
const likeContains = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

/**
 * Condizioni WHERE per i filtri già validati `q`. Sempre limitate a `userId`.
 * @returns {{ where: string[], params: any[] }} parametri già numerati ($1 = userId)
 */
function buildTxFilter(userId, q) {
  const where = ['t.user_id = $1'];
  const params = [userId];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (q.from) add('t.occurred_on >= ?', q.from);
  if (q.to) add('t.occurred_on <= ?', q.to);
  if (q.type) add('t.type = ?', q.type);
  if (q.categoryId) add('t.category_id = ?', q.categoryId);
  if (q.accountId) add('t.account_id = ?', q.accountId);
  if (q.scope) add('t.scope = ?', q.scope);
  if (q.q) {
    params.push(likeContains(q.q));
    const p = `$${params.length}`;
    where.push(`(t.note ILIKE ${p} ESCAPE '\\' OR c.name ILIKE ${p} ESCAPE '\\')`);
  }
  return { where, params };
}

module.exports = { filterFields, buildTxFilter };
