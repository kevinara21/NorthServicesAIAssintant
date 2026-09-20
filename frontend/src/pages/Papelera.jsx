import { useEffect, useMemo, useState } from 'react';
import { FiCheckSquare, FiFile, FiRefreshCw, FiSearch, FiSquare, FiTrash2 } from 'react-icons/fi';
import { apiFetch } from '../services/api';
import { useNotification } from '../context/NotificationContext';

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

export default function Papelera({ token, usuario }) {
  const [items, setItems] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [procesando, setProcesando] = useState(null);
  const [busqueda, setBusqueda] = useState('');
  const [modoSeleccion, setModoSeleccion] = useState(false);
  const [idsSeleccionados, setIdsSeleccionados] = useState([]);
  const { notificarError, notificarExito } = useNotification();
  const esAdmin = usuario?.rol?.toLowerCase() === 'administrador';

  const cargarPapelera = async () => {
    setCargando(true);
    try {
      const res = await apiFetch('/api/papelera', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo cargar la papelera.');
      setItems(data.items || []);
    } catch (error) {
      notificarError(error.message, { titulo: 'No se pudo cargar la papelera' });
    } finally { setCargando(false); }
  };

  useEffect(() => { cargarPapelera(); }, []);

  const itemsFiltrados = useMemo(() => {
    const termino = busqueda.trim().toLowerCase();
    if (!termino) return items;
    return items.filter((item) => [item.nombre, item.nombreArchivo, item.descripcion, item.eliminadoPorNombre, item.propietarioNombre]
      .filter(Boolean).some((valor) => valor.toLowerCase().includes(termino)));
  }, [items, busqueda]);

  const idsVisibles = itemsFiltrados.map((item) => item.id);
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
    const ids = lista.map((item) => item.id);
    setProcesando(ids.join(','));
    try {
      const res = await apiFetch('/api/papelera/lote/restaurar', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo restaurar.');
      setItems((actual) => actual.filter((item) => !ids.includes(item.id)));
      setIdsSeleccionados((actual) => actual.filter((id) => !ids.includes(id)));
      notificarExito(data.mensaje, { titulo: 'Restaurado' });
    } catch (error) {
      notificarError(error.message, { titulo: 'Error al restaurar' });
    } finally { setProcesando(null); }
  };

  const eliminarDefinitivo = async (lista) => {
    const nombres = lista.map((item) => item.nombre).join(', ');
    if (!window.confirm(`¿Eliminar ${lista.length === 1 ? `"${nombres}"` : `${lista.length} elementos`} permanentemente? Esta acción no se puede deshacer y también se quitará de la base de conocimiento de la IA.`)) return;
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

  if (cargando) return <p style={{ padding: 20, textAlign: 'center' }}>Cargando papelera...</p>;

  return (
    <section style={{ padding: '20px 0' }}>
      <div style={{ marginBottom: 24 }}>
        <span className="dashboard-eyebrow">Gestión de contenido</span>
        <h1 style={{ margin: '8px 0 12px' }}>Papelera</h1>
        <p style={{ color: '#64748b', fontSize: 14, lineHeight: 1.6 }}>
          Elementos eliminados recientemente. Permanecen 30 días y luego se eliminan automáticamente. Durante este periodo la información sigue disponible para el asistente IA. {esAdmin ? 'Puedes ver y restaurar los archivos de todos los usuarios.' : 'Solo puedes ver los elementos que tú eliminaste.'}
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
            <button type="button" className="library-icon-button danger" disabled={modoSeleccion && !haySeleccion} onClick={() => eliminarDefinitivo(haySeleccion ? seleccionActual : itemsFiltrados)} title="Eliminar todo">
              <FiTrash2 />
            </button>
          </>
        )}
      </div>

      <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e2e8f0', overflow: 'hidden', marginBottom: 24 }}>
        {itemsFiltrados.length === 0 ? (
          <div style={{ padding: '64px 24px', textAlign: 'center', color: '#94a3b8' }}>
            <FiTrash2 style={{ fontSize: 48, marginBottom: 16 }} />
            <p style={{ margin: 0, fontSize: 15 }}>{items.length === 0 ? 'La papelera está vacía.' : 'No hay elementos que coincidan con la búsqueda.'}</p>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                {modoSeleccion && <th style={{ padding: '16px 20px', width: 36 }} />}
                <th style={{ padding: '16px 20px', fontSize: 13, fontWeight: 600, color: '#64748b' }}>Archivo</th>
                <th style={{ padding: '16px 20px', fontSize: 13, fontWeight: 600, color: '#64748b' }}>Eliminado por</th>
                <th style={{ padding: '16px 20px', fontSize: 13, fontWeight: 600, color: '#64748b' }}>Fecha</th>
                <th style={{ padding: '16px 20px', fontSize: 13, fontWeight: 600, color: '#64748b' }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {itemsFiltrados.map((item) => (
                <tr key={item.id} style={{ borderBottom: '1px solid #f1f5f9', background: idsSeleccionados.includes(item.id) ? '#fef2f2' : 'transparent' }}>
                  {modoSeleccion && (
                    <td style={{ padding: '16px 20px' }}>
                      <input type="checkbox" checked={idsSeleccionados.includes(item.id)} onChange={() => alternarSeleccion(item.id)} style={{ width: 16, height: 16, accentColor: '#DD2226' }} />
                    </td>
                  )}
                  <td style={{ padding: '16px 20px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <FiFile style={{ color: '#94a3b8', flexShrink: 0, fontSize: 18 }} />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{item.nombre}</div>
                        {item.descripcion && <small style={{ color: '#94a3b8', display: 'block', marginTop: 4 }}>{item.descripcion}</small>}
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '16px 20px', fontSize: 13, color: '#64748b' }}>{item.eliminadoPorNombre || item.propietarioNombre}</td>
                  <td style={{ padding: '16px 20px', fontSize: 13, color: '#64748b', whiteSpace: 'nowrap' }}>
                    <div>{formatearFechaHora(item.eliminadoEn)}</div>
                    <small style={{ color: '#94a3b8', display: 'block', marginTop: 4 }}>Se elimina en {item.diasRestantes} día{item.diasRestantes === 1 ? '' : 's'}</small>
                  </td>
                  <td style={{ padding: '16px 20px' }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        disabled={procesando === item.id}
                        onClick={() => restaurar([item])}
                        title="Restaurar"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', border: 'none', borderRadius: 6, background: '#16a34a', color: '#fff', cursor: procesando === item.id ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600 }}
                      >
                        <FiRefreshCw /> Restaurar
                      </button>
                      <button
                        type="button"
                        disabled={procesando === item.id}
                        onClick={() => eliminarDefinitivo([item])}
                        title="Eliminar permanentemente"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', border: 'none', borderRadius: 6, background: '#DC2626', color: '#fff', cursor: procesando === item.id ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600 }}
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
    </section>
  );
}
