'use strict';
/* File upload middleware (multer, in memory) with the 10 MB limit. */
const multer = require('multer');
const config = require('../config');
const { ApiError } = require('./util');

const uploader = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 } });
function singleFile(field = 'file') {
  return (req, res, next) => uploader.single(field)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(new ApiError('The file is larger than the 10 MB limit.', 413, { file: 'Maximum size is 10 MB.' }));
    return next(new ApiError('The upload could not be read. Try again.', 400));
  });
}
module.exports = { singleFile };
