import { useEffect, useState } from 'react';
import { FiRefreshCw, FiTrash2, FiFile, FiArrowLeft } from 'react-icons/fi';
import { apiFetch } from '../services/api';
import { useNotification } from '../context/NotificationContext';

function formatearFecha(fecha) {
  if (!fecha) return '';
  try {
    const d = fecha.toDate ? fecha.toDate() : new Date(fecha);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

export default function Papelera({ token, usuario }) {
  const [items, setItems] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [procesando, setProcesando] = useState(null);
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

  const restaurar = async (item) => {
    setProcesando(item.id);
    try {
      const res = await apiFetch(`/api/papelera/${item.id}/restaurar`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo restaurar.');
      setItems((actual) => actual.filter((i) => i.id !== item.id));
      notificarExito(data.mensaje, { titulo: 'Restaurado' });
    } catch (error) {
      notificarError(error.message, { titulo: 'Error al restaurar' });
    } finally { setProcesando(null); }
  };

  const eliminarDefinitivo = async (item) => {
    if (!window.confirm(`¿Eliminar "${item.nombre}" permanentemente? Esta acción no se puede deshacer.`)) return;
    setProcesando(item.id);
    try {
      const res = await apiFetch(`/api/papelera/${item.id}/definitivo`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo eliminar.');
      setItems((actual) => actual.filter((i) => i.id !== item.id));
      notificarExito(data.mensaje, { titulo: 'Eliminado permanentemente' });
    } catch (error) {
      notificarError(error.message, { titulo: 'Error al eliminar' });
    } finally { setProcesando(null); }
  };

  if (cargando) return <p style={{ padding: 20, textAlign: 'center' }}>Cargando papelera...</p>;

  return (
    <section style={{ padding: 0 }}>
      <div style={{ marginBottom: 16 }}>
        <span className="dashboard-eyebrow">Gestión de contenido</span>
        <h1 style={{ margin: '4px 0 6px' }}>Papelera</h1>
        <p style={{ color: '#64748b', fontSize: 14 }}>
          Elementos eliminados recientemente. {esAdmin ? 'Puedes ver y restaurar los borradores de todos los usuarios.' : 'Solo puedes ver los elementos que tú eliminaste.'}
        </p>
      </div>

      <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
        {items.length === 0 ? (
          <div style={{ padding: '48px 20px', textAlign: 'center', color: '#94a3b8' }}>
            <FiTrash2 style={{ fontSize: 32, marginBottom: 8 }} />
            <p style={{ margin: 0 }}>La papelera está vacía.</p>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                <th style={{ padding: '12px 16px', fontSize: 13, fontWeight: 600, color: '#64748b' }}>Archivo</th>
                <th style={{ padding: '12px 16px', fontSize: 13, fontWeight: 600, color: '#64748b' }}>Eliminado por</th>
                <th style={{ padding: '12px 16px', fontSize: 13, fontWeight: 600, color: '#64748b' }}>Fecha</th>
                <th style={{ padding: '12px 16px', fontSize: 13, fontWeight: 600, color: '#64748b' }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <FiFile style={{ color: '#94a3b8', flexShrink: 0 }} />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{item.nombre}</div>
                        {item.descripcion && <small style={{ color: '#94a3b8' }}>{item.descripcion}</small>}
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '12px 16px', fontSize: 13, color: '#64748b' }}>{item.propietarioNombre}</td>
                  <td style={{ padding: '12px 16px', fontSize: 13, color: '#64748b' }}>{formatearFecha(item.eliminadoEn)}</td>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        disabled={procesando === item.id}
                        onClick={() => restaurar(item)}
                        title="Restaurar"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', border: 'none', borderRadius: 6, background: '#16a34a', color: '#fff', cursor: procesando === item.id ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600 }}
                      >
                        <FiRefreshCw /> Restaurar
                      </button>
                      <button
                        type="button"
                        disabled={procesando === item.id}
                        onClick={() => eliminarDefinitivo(item)}
                        title="Eliminar permanentemente"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', border: 'none', borderRadius: 6, background: '#DC2626', color: '#fff', cursor: procesando === item.id ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600 }}
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
