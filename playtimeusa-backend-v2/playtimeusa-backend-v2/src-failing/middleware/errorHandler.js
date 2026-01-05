const config = require('../config/env');

function errorHandler(err, req, res, next) {
  console.error('[ERROR]', err);

  const status = err.status || err.statusCode || 500;

  const payload = {
    error: err.message || 'Internal Server Error',
  };

  if (config.isDev) {
    payload.stack = err.stack;
    payload.details = err.details || undefined;
  }

  res.status(status).json(payload);
}

module.exports = errorHandler;
