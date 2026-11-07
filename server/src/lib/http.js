'use strict';
/* Route helper: runs a handler inside one database transaction (all of a
   request's changes are saved together or not at all) and sends its result. */
const db = require('../db');

class Reply {
  constructor(status, body) { this.status = status; this.body = body; }
}
const created = (body) => new Reply(201, body);

function route(handler, { tx = true } = {}) {
  return async (req, res, next) => {
    try {
      let result;
      if (tx) await db().transaction(async (trx) => { result = await handler(req, res, trx); });
      else result = await handler(req, res, db());
      if (res.headersSent) return undefined;
      if (result instanceof Reply) return res.status(result.status).json(result.body);
      if (typeof result === 'function') return result(res);   // file responses, sent after commit
      if (result !== undefined) return res.json(result);
      return undefined;
    } catch (err) { return next(err); }
  };
}
module.exports = { route, created, Reply };
