'use strict';

const { query } = require('../db/pool');
const { httpError } = require('./validate');

/**
 * La categoria deve essere dell'utente e, se si indica expectedKind
 * ('expense' | 'income'), del tipo giusto: una spesa non può avere una
 * categoria di entrata. id null/undefined = nessuna categoria, sempre valido.
 */
async function assertCategory(userId, id, expectedKind) {
  if (id == null) return;
  const f = await query('SELECT kind FROM categories WHERE id = $1 AND user_id = $2', [id, userId]);
  if (f.rowCount === 0) throw httpError(400, 'bad_category', 'Categoria non valida');
  if (expectedKind && f.rows[0].kind !== expectedKind) {
    throw httpError(400, 'category_kind_mismatch', 'La categoria non è compatibile con il tipo di movimento');
  }
}

/** Vero se tipo o categoria cambiano davvero rispetto ai valori salvati (BIGINT arriva come stringa). */
const categoryPairChanged = (current, next) =>
  next.type !== current.type || String(next.categoryId ?? '') !== String(current.category_id ?? '');

module.exports = { assertCategory, categoryPairChanged };
