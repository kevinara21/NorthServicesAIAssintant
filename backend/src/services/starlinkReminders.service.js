'use strict';

const crypto = require('crypto');
const { enviarCorreoCorporativo } = require('./corporateEmail.service');

const ZONA_HORARIA = 'America/Lima';
const INTERVALO_REVISION_MS = 30 * 60 * 1000;
const VIGENCIA_RECLAMO_MS = 15 * 60 * 1000;
const COLECCION_RECORDATORIOS = 'recordatoriosStarlink';

function fechaLocal(fecha = new Date()) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_HORARIA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(fecha);
  const valores = Object.fromEntries(partes.map(({ type, value }) => [type, value]));
  return `${valores.year}-${valores.month}-${valores.day}`;
}

function sumarDias(fecha, cantidad) {
  const [anio, mes, dia] = fecha.split('-').map(Number);
  const resultado = new Date(Date.UTC(anio, mes - 1, dia + cantidad));
  return resultado.toISOString().slice(0, 10);
}

function diaDePagoEnFecha(fecha, diaPago) {
  const [anio, mes] = fecha.split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${fecha.slice(0, 7)}-${String(Math.min(diaPago, ultimoDia)).padStart(2, '0')}`;
}

function normalizarDiaPago(valor) {
  const dia = Number.parseInt(valor, 10);
  return Number.isInteger(dia) && dia >= 1 && dia <= 31 ? dia : null;
}

function escaparHtml(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (caracter) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[caracter]);
}

function construirCorreo(pozos, fechaVencimiento) {
  const filas = pozos.map((pozo) => `
    <tr>
      <td>${escaparHtml(pozo.nombrePozo || pozo.ubicacion || 'Sin ubicación')}</td>
      <td>${escaparHtml(pozo.codigoKit || pozo.id || 'Sin código')}</td>
      <td>${escaparHtml(pozo.correo || 'Sin correo registrado')}</td>
      <td>${escaparHtml(pozo.serieAntena || 'Sin serie')}</td>
      <td>S/ ${Number(pozo.monto || 0).toFixed(2)}</td>
      <td>${escaparHtml(pozo.comentario || '—')}</td>
    </tr>`).join('');

  const tablaTexto = pozos.map((pozo) => [
    `Pozo: ${pozo.nombrePozo || pozo.ubicacion || 'Sin ubicación'}`,
    `Código KIT: ${pozo.codigoKit || pozo.id || 'Sin código'}`,
    `Correo registrado: ${pozo.correo || 'Sin correo registrado'}`,
    `Serie de antena: ${pozo.serieAntena || 'Sin serie'}`,
    `Monto: S/ ${Number(pozo.monto || 0).toFixed(2)}`,
    `Comentario: ${pozo.comentario || '—'}`,
  ].join('\n')).join('\n\n');

  return {
    asunto: `Recordatorio: vencimiento de Starlink el ${fechaVencimiento}`,
    texto: `El siguiente pago de Starlink vence mañana (${fechaVencimiento}).\n\n${tablaTexto}`,
    html: `<!doctype html><html lang="es"><meta charset="utf-8"><body>
      <h2>Vencimiento de Starlink mañana</h2>
      <p>El siguiente pago vence el <strong>${fechaVencimiento}</strong>.</p>
      <table border="1" cellpadding="8" cellspacing="0">
        <thead><tr><th>Pozo</th><th>Código KIT</th><th>Correo registrado</th><th>Serie de antena</th><th>Monto</th><th>Comentario</th></tr></thead>
        <tbody>${filas}</tbody>
      </table>
      <p>Mensaje automático de North Services AI Assistant.</p>
    </body></html>`,
  };
}

async function obtenerAdministradores(db) {
  const snapshot = await db.collection('users').get();
  return [...new Set(snapshot.docs
    .map((documento) => documento.data())
    .filter((usuario) => String(usuario.rol || '').trim().toLowerCase() === 'administrador'
      && usuario.estado === 'activo'
      && typeof usuario.email === 'string')
    .map((usuario) => usuario.email.trim().toLowerCase())
    .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];
}

async function reclamarRecordatorio(db, clave) {
  const referencia = db.collection(COLECCION_RECORDATORIOS).doc(clave);
  return db.runTransaction(async (transaccion) => {
    const documento = await transaccion.get(referencia);
    if (documento.exists) {
      const datos = documento.data();
      const creadoEn = typeof datos.creadoEn?.toDate === 'function'
        ? datos.creadoEn.toDate()
        : datos.creadoEn;
      const reclamoVigente = datos.estado === 'enviando'
        && creadoEn instanceof Date
        && Date.now() - creadoEn.getTime() < VIGENCIA_RECLAMO_MS;
      if (datos.estado === 'enviado' || reclamoVigente) return null;

      transaccion.update(referencia, { estado: 'enviando', creadoEn: new Date() });
      return referencia;
    }

    transaccion.create(referencia, {
      estado: 'enviando',
      creadoEn: new Date(),
    });
    return referencia;
  });
}

async function liberarRecordatorio(referencia) {
  if (!referencia) return;
  await referencia.delete();
}

function crearServicioRecordatorios({ db, enviarCorreo = enviarCorreoCorporativo, reloj = () => new Date() }) {
  let revisionEnCurso = false;

  async function revisar() {
    if (revisionEnCurso) return;
    revisionEnCurso = true;

    try {
      const hoy = fechaLocal(reloj());
      const manana = sumarDias(hoy, 1);
      const pozosSnapshot = await db.collection('facturacionStarlink').get();
      const pozosVencenManana = pozosSnapshot.docs
        .map((documento) => ({ id: documento.id, ...documento.data() }))
        .filter((pozo) => pozo.estadoActivo !== false
          && normalizarDiaPago(pozo.diaPago || pozo.fechaPago) !== null
          && diaDePagoEnFecha(manana, normalizarDiaPago(pozo.diaPago || pozo.fechaPago)) === manana);

      if (!pozosVencenManana.length) return;

      const administradores = await obtenerAdministradores(db);
      if (!administradores.length) {
        console.warn('[STARLINK] No hay administradores activos con correo válido; se reintentará en la siguiente revisión.');
        return;
      }

      const enviado = [];
      for (const pozo of pozosVencenManana) {
        const codigo = String(pozo.codigoKit || pozo.id);
        const clave = crypto.createHash('sha256')
          .update(`${codigo}:${manana}`)
          .digest('hex');
        const referencia = await reclamarRecordatorio(db, clave);
        if (referencia) enviado.push({ pozo, referencia });
      }
      if (!enviado.length) return;

      try {
        const correo = construirCorreo(enviado.map(({ pozo }) => pozo), manana);
        const resultado = await enviarCorreo({
          para: administradores.join(', '),
          ...correo,
        });
        if (!resultado.ok) throw new Error(resultado.error || 'No se pudo enviar el correo.');

        const lote = db.batch();
        for (const { referencia } of enviado) {
          lote.update(referencia, {
            estado: 'enviado',
            enviadoEn: new Date(),
            messageId: resultado.messageId || null,
          });
        }
        await lote.commit();
        console.log(`[STARLINK] Aviso enviado a ${administradores.length} administrador(es) para ${enviado.length} equipo(s); vence ${manana}.`);
      } catch (error) {
        await Promise.all(enviado.map(({ referencia }) => liberarRecordatorio(referencia)));
        throw error;
      }
    } catch (error) {
      console.error('[STARLINK] Error al revisar recordatorios de vencimiento:', error.message);
    } finally {
      revisionEnCurso = false;
    }
  }

  function iniciar() {
    revisar();
    const intervalo = setInterval(revisar, INTERVALO_REVISION_MS);
    if (typeof intervalo.unref === 'function') intervalo.unref();
    return intervalo;
  }

  return { revisar, iniciar };
}

module.exports = { crearServicioRecordatorios, fechaLocal, sumarDias, diaDePagoEnFecha };
