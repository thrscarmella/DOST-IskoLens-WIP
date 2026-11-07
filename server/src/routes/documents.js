'use strict';
/* Supporting documents (grade reports, COR, termination evidence, appeals).
   Files are stored outside the web folder with random names and only served
   to signed-in staff; the type is checked from the file's first bytes; every
   opening is logged. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const audit = require('../lib/audit');
const { route, created } = require('../lib/http');
const { ApiError, now, cleanText, bool, iso } = require('../lib/util');
const S = require('../lib/security');
const D = require('../lib/data');
const { singleFile } = require('../lib/upload');
const { getScholar } = require('./scholars');

const router = express.Router();
const SIGNATURES = {
  'application/pdf': [Buffer.from('%PDF')],
  'image/png': [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  'image/jpeg': [Buffer.from([0xff, 0xd8, 0xff])],
};
const docPath = (d) => path.join(config.DOCUMENTS_DIR, String(d.scholar_id), d.stored_name);

async function docJson(k, d) {
  const names = await D.userNames(k, [d.uploaded_by_id]);
  return { id: d.id, doc_type: d.doc_type, description: d.description, filename: d.original_filename, mime_type: d.mime_type,
    size_bytes: d.size_bytes, uploaded_by: names[d.uploaded_by_id] ?? null, uploaded_at: iso(d.uploaded_at), termination_request_id: d.termination_request_id };
}

router.get('/scholars/:code/documents', route(async (req, res, k) => {
  S.requireLogin(req);
  const s = await getScholar(k, req, req.params.code);
  const docs = await k('scholar_documents').where({ scholar_id: s.id }).whereIn('is_deleted', [0, false]).orderBy('uploaded_at', 'desc').orderBy('id', 'desc');
  return { ok: true, documents: await Promise.all(docs.map((d) => docJson(k, d))), types: D.DOCUMENT_TYPES };
}, { tx: false }));

router.post('/scholars/:code/documents', singleFile(), route(async (req, res, trx) => {
  S.requireLogin(req);
  const s = await getScholar(trx, req, req.params.code);
  if (bool(s.is_deactivated) || bool(s.is_anonymized)) throw new ApiError('Documents cannot be added to this record.', 409);
  const f = req.file;
  if (!f || !f.originalname) throw new ApiError('Choose a file to upload.', 422, { file: 'No file selected.' });
  const docType = req.body.doc_type;
  if (!D.DOCUMENT_TYPES.includes(docType)) throw new ApiError('Select the document type.', 422, { doc_type: 'Select the document type.' });
  const description = cleanText(req.body.description, 255) || null;
  const ext = path.extname(f.originalname).toLowerCase();
  const mime = config.ALLOWED_DOCUMENT_TYPES[ext];
  if (!mime) throw new ApiError('Upload a PDF, JPG or PNG file.', 422, { file: 'Only PDF, JPG and PNG files are accepted.' });
  const data = f.buffer;
  if (!data || !data.length) throw new ApiError('The file is empty.', 422, { file: 'The file is empty.' });
  if (data.length > config.MAX_DOCUMENT_BYTES) throw new ApiError('The file is larger than 10 MB.', 413, { file: 'Maximum size is 10 MB.' });
  if (!SIGNATURES[mime].some((sig) => data.subarray(0, sig.length).equals(sig))) {
    throw new ApiError("The file's contents do not match its type. Save it again as PDF, JPG or PNG.", 422, { file: 'The file is not a real PDF, JPG or PNG.' });
  }
  const reqId = req.body.termination_request_id ? Number(req.body.termination_request_id) : null;
  if (reqId) {
    const tr = await trx('termination_requests').where({ id: reqId }).first();
    if (!tr || tr.scholar_id !== s.id) throw new ApiError('Termination request not found for this scholar.', 404);
  }
  const stored = crypto.randomBytes(16).toString('hex') + ext;
  const dir = path.join(config.DOCUMENTS_DIR, String(s.id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, stored), data);
  const [id] = await trx('scholar_documents').insert({
    scholar_id: s.id, termination_request_id: reqId, doc_type: docType, description, original_filename: path.basename(f.originalname).slice(0, 255),
    stored_name: stored, mime_type: mime, size_bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'),
    uploaded_by_id: req.user.id, uploaded_at: now(), is_deleted: false,
  });
  await audit.log(trx, req, 'edit', 'Document uploaded', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s),
    details: { document_id: id, type: docType, file: path.basename(f.originalname), bytes: data.length } });
  return created({ ok: true, document: await docJson(trx, await trx('scholar_documents').where({ id }).first()) });
}));

async function getDoc(trx, req) {
  const s = await getScholar(trx, req, req.params.code);
  const d = await trx('scholar_documents').where({ id: Number(req.params.id), scholar_id: s.id }).whereIn('is_deleted', [0, false]).first();
  if (!d) throw new ApiError('Document not found.', 404);
  return [s, d];
}
router.get('/scholars/:code/documents/:id', route(async (req, res, trx) => {
  S.requireLogin(req);
  const [s, d] = await getDoc(trx, req);
  const p = docPath(d);
  if (!fs.existsSync(p)) throw new ApiError('The file is missing from storage. Restore it from a backup.', 410);
  await audit.log(trx, req, 'access', 'Document opened', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s),
    details: { document_id: d.id, file: d.original_filename } });
  const inline = req.query.inline === '1';
  return (r) => {
    r.set('Cache-Control', 'no-store').set('Content-Type', d.mime_type);
    r.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${d.original_filename.replace(/"/g, '')}"`);
    r.sendFile(p);
  };
}));
router.delete('/scholars/:code/documents/:id', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  const [s, d] = await getDoc(trx, req);
  const reason = cleanText((req.body || {}).reason, 255);
  if (reason.length < 5) throw new ApiError('Say briefly why the document is being removed.', 422, { reason: 'Say briefly why the document is being removed (e.g. wrong scholar).' });
  await trx('scholar_documents').where({ id: d.id }).update({ is_deleted: true, deleted_at: now(), deleted_by_id: req.user.id, delete_reason: reason });
  try { fs.rmSync(docPath(d), { force: true }); } catch { console.warn(`Could not remove document file ${d.stored_name}`); }
  await audit.log(trx, req, 'edit', 'Document removed', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s),
    details: { document_id: d.id, file: d.original_filename, reason } });
  return { ok: true };
}));

module.exports = { router, docJson, docPath };
