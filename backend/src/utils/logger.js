'use strict';

// Logs del backend.
//
// Por defecto se muestra lo importante: arranque, avisos y errores. El detalle
// por consulta (tiempos, scores, fuentes, detección de intenciones) queda tras
// LOG_LEVEL=debug para no llenar la terminal en cada pregunta.
//
// Niveles: error < warn < info < debug.

const NIVELES = { error: 0, warn: 1, info: 2, debug: 3 };
const configurado = String(process.env.LOG_LEVEL || 'info').trim().toLowerCase();
const nivel = NIVELES[configurado] ?? NIVELES.info;

function debug(...args) {
  if (nivel >= NIVELES.debug) console.log(...args);
}

function info(...args) {
  if (nivel >= NIVELES.info) console.log(...args);
}

function warn(...args) {
  if (nivel >= NIVELES.warn) console.warn(...args);
}

function error(...args) {
  console.error(...args);
}

module.exports = { debug, info, warn, error, nivel };
