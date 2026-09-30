import { useEffect, useMemo, useState } from 'react';
import { FiAlertTriangle, FiCheckSquare, FiFile, FiLock, FiRefreshCw, FiSearch, FiSquare, FiTrash2, FiX } from 'react-icons/fi';
import { apiFetch } from '../services/api';
import { useNotification } from '../context/NotificationContext';
import OilLoader from '../components/common/OilLoader';

function parseFecha(fecha) {
  if (!fecha) return null;
  if (typeof fecha.toDate === 'function') return fecha.toDate();
  if (typeof fecha === 'object' && (fecha._seconds != null || fecha.seconds != null)) {
    return new Date((fecha._seconds ?? fecha.seconds) * 1000);
  }
  const fechaParseada = new Date(fecha);
  return Number.isNaN(fechaParseada.getTime()) ? null : fechaParseada;
}

function formatearFechaHora(fecha) {
  const d = parseFecha(fecha);
  if (!d) return '—';
  return d.toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

const MS_POR_DIA = 24 * 60 * 60 * 1000;

function calcularRestante(eliminadoEn, diasRetencion, ahora) {
  const inicio = parseFecha(eliminadoEn);
  if (!inicio) return null;
  const totalMs = diasRetencion * MS_POR_DIA;
  const restanteMs = inicio.getTime() + totalMs - ahora;
  if (restanteMs <= 0) return { texto: 'Se elimina hoy', porcentaje: 100, urgente: true };
  const totalSeg = Math.floor(restanteMs / 1000);
  const dias = Math.floor(totalSeg / 86400);
  const horas = Math.floor((totalSeg % 86400) / 3600);
  const min = Math.floor((totalSeg % 3600) / 60);
  const seg = totalSeg % 60;
  const detalle = dias > 0 ? `${dias}d ${horas}h ${min}m` : horas > 0 ? `${horas}h ${min}m ${seg}s` : `${min}m ${seg}s`;
  return {
    texto: `Se elimina en ${detalle}`,
    porcentaje: Math.min(100, Math.max(0, ((totalMs - restanteMs) / totalMs) * 100)),
    urgente: dias === 0,
  };
}

export default function Papelera({ token, usuario }) {
  const [items, setItems] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [procesando, setProcesando] = useState(null);
  // Elementos a la espera de confirmación en el modal de borrado definitivo.
  const [porEliminar, setPorEliminar] = useState(null);
  const [busqueda, setBusqueda] = useState('');
  const [modoSeleccion, setModoSeleccion] = useState(false);
  const [idsSeleccionados, setIdsSeleccionados] = useState([]);
  const [diasRetencion, setDiasRetencion] = useState(30);
  const [ahora, setAhora] = useState(() => Date.now());
  const { notificarError, notificarExito } = useNotification();
  const esAdmin = usuario?.rol?.toLowerCase() === 'administrador';

  const cargarPapelera = async () => {
    setCargando(true);
    try {
      const res = await apiFetch('/api/papelera', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo cargar la papelera.');
      setItems(data.items || []);
      setDiasRetencion(data.diasRetencion || 30);
      setAhora(Date.now());
    } catch (error) {
      notificarError(error.message, { titulo: 'No se pudo cargar la papelera' });
    } finally { setCargando(false); }
  };

  useEffect(() => { cargarPapelera(); }, []);

  useEffect(() => {
    const temporizador = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(temporizador);
  }, []);

  const itemsFiltrados = useMemo(() => {
    const termino = busqueda.trim().toLowerCase();
    if (!termino) return items;
    return items.filter((item) => [item.nombre, item.nombreArchivo, item.descripcion, item.eliminadoPorNombre, item.propietarioNombre]
      .filter(Boolean).some((valor) => valor.toLowerCase().includes(termino)));
  }, [items, busqueda]);

  // Los archivos bloqueados por categoría no entran en la selección: no se
  // pueden restaurar desde aquí, así que no tiene sentido marcarlos.
  const idsVisibles = itemsFiltrados.filter((item) => !item.bloqueadoPorCategoria).map((item) => item.id);
  const todosSeleccionados = idsVisibles.length > 0 && idsVisibles.every((id) => idsSeleccionados.includes(id));
  const seleccionActual = itemsFiltrados.filter((item) => idsSeleccionados.includes(item.id));
  const haySeleccion = seleccionActual.length > 0;

  const alternarModoSeleccion = () => {
    setModoSeleccion((activo) => {
      if (activo) setIdsSeleccionados([]);
      return !activo;
    });
  };

  const alternarSeleccion = (id) => {
    setIdsSeleccionados((actual) => actual.includes(id) ? actual.filter((valor) => valor !== id) : [...actual, id]);
  };

  const alternarTodos = () => {
    setIdsSeleccionados(todosSeleccionados ? [] : idsVisibles);
  };

const restaurar = async (lista) => {
    // Los archivos que están en la papelera porque se desactivó toda su
  // categoría no se restauran uno por uno: primero hay que reactivar la
  // categoría. Se avisa en vez de dejar que el backend rechace cada uno.
  const bloqueados = lista.filter((item) => item.bloqueadoPorCategoria);
  if (bloqueados.length === lista.length) {
    notificarError(
      'Estos archivos se mandaron a la papelera al desactivar toda su categoría. Reactívala desde Conocimiento y permisos por rol.',
      { titulo: 'Restauración disponible desde Conocimiento' }
    );
    return;
  }
  if (bloqueados.length > 0) {
    notificarError(
      `Se omitieron ${bloqueados.length} archivo(s) que dependen de una categoría desactivada. Reactívala desde Conocimiento y permisos por rol.`,
      { titulo: 'Restauración parcial' }
    );
    setIdsSeleccionados((actual) =>
      actual.filter((id) => !bloqueados.some((item) => item.id === id))
    );
  }

  const restaurables = lista.filter((item) => !item.bloqueadoPorCategoria).map((item) => item.id);
  if (!restaurables.length) return;

  setProcesando(restaurables.join(','));
  try {
    const res = await apiFetch('/api/papelera/lote/restaurar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: restaurables }),
    });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo restaurar.');
      setItems((actual) => actual.filter((item) => !restaurables.includes(item.id)));
      setIdsSeleccionados((actual) => actual.filter((id) => !restaurables.includes(id)));
      notificarExito(`${data.procesados} elemento${data.procesados === 1 ? '' : 's'} restaurado${data.procesados === 1 ? '' : 's'}. La información vuelve a estar disponible para el asistente IA.`, { titulo: 'Restaurado' });
    } catch (error) {
      notificarError(error.message, { titulo: 'Error al restaurar' });
    } finally { setProcesando(null); }
  };

  // El borrado definitivo se pide con un modal propio en vez de window.confirm:
// el del navegador no se puede vestir con los colores de la aplicación y
// muestra el mensaje del sistema operativo en otro idioma.
const eliminarDefinitivo = async (lista) => {
  const ids = lista.map((item) => item.id);
  setProcesando(ids.join(','));
  try {
    const res = await apiFetch('/api/papelera/lote/definitivo', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo eliminar.');
    setItems((actual) => actual.filter((item) => !ids.includes(item.id)));
    setIdsSeleccionados((actual) => actual.filter((id) => !ids.includes(id)));
    notificarExito(data.mensaje, { titulo: 'Eliminado permanentemente' });
  } catch (error) {
    notificarError(error.message, { titulo: 'Error al eliminar' });
  } finally { setProcesando(null); }
  };

  const confirmarEliminacionDefinitiva = async () => {
    const lista = porEliminar;
    if (!lista?.length) return;
    setPorEliminar(null);
    await eliminarDefinitivo(lista);
  };

  if (cargando) return <OilLoader label="Cargando papelera" inline />;

  return (
    <section style={{ padding: '20px 0' }}>
      <div style={{ marginBottom: 24 }}>
        <span className="dashboard-eyebrow">Gestión de contenido</span>
        <h1 style={{ margin: '8px 0 12px' }}>Papelera</h1>
        <p style={{ color: '#64748b', fontSize: 14, lineHeight: 1.6 }}>
          Elementos eliminados recientemente. Permanecen 30 días y luego se eliminan automáticamente. Al enviar a la papelera, la información deja de estar disponible para el asistente IA. {esAdmin ? 'Puedes ver y restaurar los archivos de todos los usuarios.' : 'Solo puedes ver los elementos que tú eliminaste.'}
        </p>
      </div>

      <div className="library-toolbar" style={{ marginBottom: 20 }}>
        <label className="library-search"><FiSearch aria-hidden="true" /><input value={busqueda} onChange={(event) => setBusqueda(event.target.value)} placeholder="Buscar por archivo, descripción o quién lo eliminó…" /></label>
        <button type="button" className={`library-select-toggle${modoSeleccion ? ' active' : ''}`} onClick={alternarModoSeleccion} title={modoSeleccion ? 'Cancelar selección' : 'Selección múltiple'}>
          {modoSeleccion ? <FiCheckSquare /> : <FiSquare />}
        </button>
        {modoSeleccion && itemsFiltrados.length > 0 && (
          <label className="library-select-all">
            <input type="checkbox" checked={todosSeleccionados} onChange={alternarTodos} />
            Seleccionar todos ({seleccionActual.length}/{itemsFiltrados.length})
          </label>
        )}
        {itemsFiltrados.length > 0 && (
          <>
            <button type="button" className="library-icon-button success" disabled={modoSeleccion && !haySeleccion} onClick={() => restaurar(haySeleccion ? seleccionActual : itemsFiltrados)} title="Restaurar todo">
              <FiRefreshCw />
            </button>
            <button type="button" className="library-icon-button danger" disabled={modoSeleccion && !haySeleccion} onClick={() => setPorEliminar(haySeleccion ? seleccionActual : itemsFiltrados)} title="Eliminar todo">
              <FiTrash2 />
            </button>
          </>
        )}
      </div>

      <div className="trash-table-wrap">
        {itemsFiltrados.length === 0 ? (
          <div className="trash-empty">
            <FiTrash2 />
            <p>{items.length === 0 ? 'La papelera está vacía.' : 'No hay elementos que coincidan con la búsqueda.'}</p>
          </div>
        ) : (
          <table className="trash-table">
            <thead>
              <tr>
                {modoSeleccion && <th className="trash-check-col" />}
                <th>Archivo</th>
                <th>Eliminado por</th>
                <th>Fecha</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {itemsFiltrados.map((item) => (
                <tr key={item.id} className={idsSeleccionados.includes(item.id) ? 'selected' : ''}>
                  {modoSeleccion && (
                    <td className="trash-check-cell">
                      <input type="checkbox" className="trash-checkbox" checked={idsSeleccionados.includes(item.id)} disabled={item.bloqueadoPorCategoria} onChange={() => alternarSeleccion(item.id)} aria-label={item.bloqueadoPorCategoria ? `${item.nombre} se restaura reactivando su categoría desde Conocimiento y permisos por rol` : `Seleccionar ${item.nombre}`} />
                    </td>
                  )}
                  <td className="trash-file-cell" data-label="Archivo">
                    <div>
                      <FiFile className="trash-file-icon" />
                      <div className="trash-file-body">
                        <div className="trash-file-name">{item.nombre}</div>
                        {item.descripcion && <small className="trash-file-desc">{item.descripcion}</small>}
                      </div>
                    </div>
                  </td>
                  <td className="trash-meta" data-label="Eliminado por">
                    <div>
                      <div>{item.eliminadoPorNombre || item.propietarioNombre}</div>
                      {item.bloqueadoPorCategoria && (
                        <small className="trash-bloqueado-nota">Desactivación de categoría</small>
                      )}
                    </div>
                  </td>
                  <td className="trash-date" data-label="Fecha">
                    <div>
                      <div>{formatearFechaHora(item.eliminadoEn)}</div>
                      {(() => {
                        const restante = calcularRestante(item.eliminadoEn, diasRetencion, ahora);
                        if (!restante) return <small>Se elimina en {item.diasRestantes} día{item.diasRestantes === 1 ? '' : 's'}</small>;
                        return (
                          <>
                            <small className={restante.urgente ? 'trash-countdown urgent' : 'trash-countdown'}>{restante.texto}</small>
                            <span className="trash-progress" role="progressbar" aria-valuenow={Math.round(restante.porcentaje)} aria-valuemin={0} aria-valuemax={100} aria-label="Tiempo de retención transcurrido">
                              <span style={{ width: `${restante.porcentaje}%` }} />
                            </span>
                          </>
                        );
                      })()}
                    </div>
                  </td>
                  <td className="trash-actions-cell" data-label="Acciones">
                    <div className="trash-actions">
                      {/* Cuando el archivo está aquí porque se desactivó toda su categoría, no se
                      muestra el botón de restaurar: la operación fue de colección
                      y se revierte completa desde Conocimiento. Un botón
                      apagado solo invita a pulsarlo y a obtener un error, así que
                      en su lugar se explica dónde está el действи. */}
                      {item.bloqueadoPorCategoria ? (
                        <div className="trash-bloqueado">
                          <FiLock />
                          <small>Se recupera al reactivar la categoría desde Conocimiento y permisos por rol</small>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="trash-btn restore"
                          disabled={procesando === item.id}
                          onClick={() => restaurar([item])}
                          title="Restaurar"
                        >
                          <FiRefreshCw /> Restaurar
                        </button>
                      )}
                      <button
                        type="button"
                        className="trash-btn delete"
                        disabled={procesando === item.id}
                        onClick={() => setPorEliminar([item])}
                        title="Eliminar permanentemente"
                      >
                        <FiTrash2 /> Eliminar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {porEliminar && (
        <div
          className="modal-overlay modal-monitoreo-pozo-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="papelera-confirmar-titulo"
          onClick={(event) => { if (event.target === event.currentTarget) setPorEliminar(null); }}
          onKeyDown={(event) => { if (event.key === 'Escape') setPorEliminar(null); }}
        >
          <div className="modal-monitoreo-pozo modal-monitoreo-pozo-confirmacion">
            <header className="modal-monitoreo-pozo-header">
              <div>
                <span className="dashboard-eyebrow">Papelera</span>
                <h2 id="papelera-confirmar-titulo" style={{ margin: '4px 0 0', color: '#fff', fontSize: 20 }}>
                  Eliminar definitivamente
                </h2>
              </div>
              <button type="button" className="modal-monitoreo-pozo-close" onClick={() => setPorEliminar(null)} aria-label="Cerrar">
                <FiX aria-hidden="true" />
              </button>
            </header>

            <div className="modal-monitoreo-pozo-body">
              <div className="papelera-confirmacion">
                <span className="papelera-confirmacion-icono" aria-hidden="true">
                  <FiAlertTriangle />
                </span>
                <div>
                  <strong>
                    {porEliminar.length === 1
                      ? `¿Eliminar “${porEliminar[0].nombre}” permanentemente?`
                      : `¿Eliminar ${porEliminar.length} elementos permanentemente?`}
                  </strong>
                  <p>
                    {porEliminar.length === 1
                      ? 'Se borrará de forma definitiva y el asistente ya no podrá recuperarlo.'
                      : 'Se borrarán de forma definitiva y el asistente ya no podrá recuperarlos.'}
                    {' '}Esta acción no se puede deshacer.
                  </p>

                  {porEliminar.length > 1 && (
                    <ul className="papelera-confirmacion-lista">
                      {porEliminar.slice(0, 5).map((item) => (
                        <li key={item.id}>{item.nombre}</li>
                      ))}
                      {porEliminar.length > 5 && (
                        <li className="papelera-confirmacion-mas">y {porEliminar.length - 5} más…</li>
                      )}
                    </ul>
                  )}
                </div>
              </div>

              <div className="modal-monitoreo-pozo-actions">
                <button type="button" className="btn-monitoreo-pozo-cancel" onClick={() => setPorEliminar(null)}>
                  Cancelar
                </button>
                <button type="button" className="panel-conocimiento__peligro-boton panel-conocimiento__peligro-boton--solido" onClick={confirmarEliminacionDefinitiva}>
                  <FiTrash2 aria-hidden="true" /> Sí, eliminar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
