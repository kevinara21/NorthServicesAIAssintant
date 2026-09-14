import { useEffect, useMemo, useState } from 'react';
import { FiBookOpen, FiBox, FiSearch, FiTrash2 } from 'react-icons/fi';
import { apiFetch } from '../services/api';
import { useNotification } from '../context/NotificationContext';

export default function Recursos({ token, esAdministrador }) {
  const [recursos, setRecursos] = useState([]);
  const [busqueda, setBusqueda] = useState('');
  const [cargando, setCargando] = useState(true);
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
    if (!window.confirm(`¿Eliminar ${recurso.nombre}? Se borrarán las dos descargas y sus vectores de la IA.`)) return;
    try {
      const respuesta = await apiFetch(`/api/admin/recursos/${recurso.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo eliminar el recurso.');
      setRecursos((actual) => actual.filter((item) => item.id !== recurso.id));
      notificarExito(data.mensaje, { titulo: 'Recurso eliminado' });
    } catch (error) { notificarError(error.message, { titulo: 'No se pudo eliminar' }); }
  };

  if (cargando) return <p>Cargando recursos autorizados...</p>;

  return <section>
    <span className="dashboard-eyebrow">Biblioteca compartida</span>
    <h1>Recursos</h1>
    <p>Software autorizado y su manual técnico aparecen juntos en una sola ficha.</p>
    <label className="library-search"><FiSearch aria-hidden="true" /><input value={busqueda} onChange={(event) => setBusqueda(event.target.value)} placeholder="Buscar por nombre, versión o archivo…" /></label>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 20, marginTop: 20 }}>
      {recursosFiltrados.length === 0 ? <p>{busqueda ? 'No hay recursos que coincidan con la búsqueda.' : 'No hay recursos disponibles.'}</p> : recursosFiltrados.map((recurso) => <article key={recurso.id} style={{ background: '#fff', padding: 20, borderRadius: 8, border: '1px solid #e5e7eb' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><h3 style={{ margin: 0 }}>{recurso.nombre}</h3><span>{recurso.software && <FiBox aria-label="Software" />} {recurso.manual && <FiBookOpen aria-label="Manual" />}</span></div>
        <small>{recurso.version || 'Sin versión'}</small><p style={{ color: '#475569' }}>{recurso.descripcion || 'Sin descripción.'}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {recurso.software && <button type="button" className="resource-icon-button primary" onClick={() => descargar(recurso, 'software')} aria-label="Descargar software" title="Descargar software"><FiBox aria-hidden="true" /></button>}
          {recurso.manual && <button type="button" className="resource-icon-button" onClick={() => descargar(recurso, 'manual')} aria-label="Descargar manual" title="Descargar manual"><FiBookOpen aria-hidden="true" /></button>}
          {esAdministrador && <button type="button" className="resource-icon-button danger" onClick={() => eliminar(recurso)} aria-label="Eliminar recurso" title="Eliminar recurso"><FiTrash2 aria-hidden="true" /></button>}
        </div>
      </article>)}
    </div>
  </section>;
}
