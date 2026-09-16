import { useEffect, useMemo, useState } from 'react';
import { FiBookOpen, FiBox, FiSearch, FiTrash2 } from 'react-icons/fi';
import { apiFetch } from '../services/api';
import { useNotification } from '../context/NotificationContext';

export default function Recursos({ token, esAdministrador }) {
  const [recursos, setRecursos] = useState([]);
  const [busqueda, setBusqueda] = useState('');
  const [cargando, setCargando] = useState(true);
  const [confirmacion, setConfirmacion] = useState({ visible: false, titulo: '', mensaje: '', onConfirm: null });
  const { notificarError, notificarExito } = useNotification();

  const cargarRecursos = async () => {
    setCargando(true);
    try {
      const respuesta = await apiFetch('/api/recursos', { headers: { Authorization: `Bearer ${token}` } });
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudieron cargar los recursos.');
      setRecursos(data.recursos || []);
    } catch (error) { notificarError(error.message, { titulo: 'No se pudieron cargar los recursos' }); }
    finally { setCargando(false); }
  };

  useEffect(() => { cargarRecursos(); }, []);

  const recursosFiltrados = useMemo(() => {
    const termino = busqueda.trim().toLowerCase();
    if (!termino) return recursos;
    return recursos.filter((recurso) => [recurso.nombre, recurso.descripcion, recurso.version, recurso.software?.nombreArchivo, recurso.manual?.nombreArchivo]
      .filter(Boolean).some((valor) => valor.toLowerCase().includes(termino)));
  }, [busqueda, recursos]);

  const descargar = async (recurso, tipo) => {
    try {
      const respuesta = await apiFetch(`/api/recursos/${recurso.id}/${tipo}/download`, { headers: { Authorization: `Bearer ${token}` } });
      if (!respuesta.ok) throw new Error((await respuesta.json()).error || 'No se pudo descargar el recurso.');
      const url = URL.createObjectURL(await respuesta.blob());
      const enlace = document.createElement('a'); enlace.href = url; enlace.download = tipo === 'manual' ? recurso.manual?.nombreArchivo : recurso.software?.nombreArchivo; enlace.click(); URL.revokeObjectURL(url);
    } catch (error) { notificarError(error.message, { titulo: 'Error de descarga' }); }
  };

  const eliminar = async (recurso) => {
    setConfirmacion({
      visible: true,
      titulo: `¿Eliminar "${recurso.nombre}"?`,
      mensaje: 'Se borrarán el software, el manual y toda su información indexada para la IA. Esta acción es permanente.',
      onConfirm: async () => {
        setConfirmacion({ visible: false });
        try {
          const respuesta = await apiFetch(`/api/admin/recursos/${recurso.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
          const data = await respuesta.json();
          if (!respuesta.ok) throw new Error(data.error || 'No se pudo eliminar el recurso.');
          setRecursos((actual) => actual.filter((item) => item.id !== recurso.id));
          notificarExito(data.mensaje, { titulo: 'Recurso eliminado' });
        } catch (error) { notificarError(error.message, { titulo: 'No se pudo eliminar' }); }
      },
    });
  };

  if (cargando) return <p>Cargando recursos autorizados...</p>;

  return <section>
    <span className="dashboard-eyebrow">Biblioteca compartida</span>
    <h1>Recursos</h1>
    <p>Software autorizado y su manual técnico aparecen juntos en una sola ficha.</p>
    <label className="library-search"><FiSearch aria-hidden="true" /><input value={busqueda} onChange={(event) => setBusqueda(event.target.value)} placeholder="Buscar por nombre, versión o archivo…" /></label>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 20, marginTop: 20 }}>
      {recursosFiltrados.length === 0 ? <p>{busqueda ? 'No hay recursos que coincidan con la búsqueda.' : 'No hay recursos disponibles.'}</p> : recursosFiltrados.map((recurso) => <article key={recurso.id} style={{ background: '#fff', padding: 20, borderRadius: 8, border: '1px solid #e5e7eb' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}><h3 style={{ margin: 0 }}>{recurso.nombre}</h3><span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}><span>{recurso.software && <FiBox aria-label="Software" />} {recurso.manual && <FiBookOpen aria-label="Manual" />}</span><small>{recurso.version || 'Sin versión'}</small></span></div>
        <p style={{ color: '#475569', marginTop: 8 }}>{recurso.descripcion || 'Sin descripción.'}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {recurso.software && <button type="button" className="resource-icon-button primary" onClick={() => descargar(recurso, 'software')} aria-label="Descargar software" title="Descargar software"><FiBox aria-hidden="true" /></button>}
          {recurso.manual && <button type="button" className="resource-icon-button" onClick={() => descargar(recurso, 'manual')} aria-label="Descargar manual" title="Descargar manual"><FiBookOpen aria-hidden="true" /></button>}
          {esAdministrador && <button type="button" className="resource-icon-button danger" onClick={() => eliminar(recurso)} aria-label="Eliminar recurso" title="Eliminar recurso"><FiTrash2 aria-hidden="true" /></button>}
        </div>
      </article>)}
    </div>
    {confirmacion.visible && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }} onClick={() => setConfirmacion({ visible: false })}>
        <div style={{ background: '#fff', borderRadius: 12, padding: '28px 32px', maxWidth: 420, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', border: '1px solid #e2e8f0' }} onClick={(e) => e.stopPropagation()}>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', marginBottom: 8 }}>{confirmacion.titulo}</div>
          <p style={{ color: '#64748b', fontSize: 14, lineHeight: 1.6, margin: 0, marginBottom: 24 }}>{confirmacion.mensaje}</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setConfirmacion({ visible: false })} style={{ padding: '8px 18px', border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', color: '#374151', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Cancelar</button>
            <button type="button" onClick={confirmacion.onConfirm} style={{ padding: '8px 18px', border: 'none', borderRadius: 6, background: '#DC2626', color: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>Sí, eliminar</button>
          </div>
        </div>
      </div>
    )}
  </section>;
}
