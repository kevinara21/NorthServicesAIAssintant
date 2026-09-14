import { useEffect, useMemo, useState } from 'react';
import { FiDownload, FiFile, FiPaperclip, FiSearch, FiTrash2, FiUploadCloud } from 'react-icons/fi';
import { apiFetch } from '../services/api';
import { useNotification } from '../context/NotificationContext';

function formatearTamano(bytes = 0) {
  if (!bytes) return '0 B';
  const unidades = ['B', 'KB', 'MB', 'GB'];
  const indice = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), unidades.length - 1);
  return `${(bytes / (1024 ** indice)).toFixed(indice ? 1 : 0)} ${unidades[indice]}`;
}

export default function Archivos({ token, usuario }) {
  const [archivos, setArchivos] = useState([]);
  const [archivo, setArchivo] = useState(null);
  const [nombre, setNombre] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [cargando, setCargando] = useState(false);
  const { notificarError, notificarExito, notificarInfo } = useNotification();
  const esAdministrador = usuario?.rol?.toLowerCase() === 'administrador';

  const cargarArchivos = async () => {
    try {
      const respuesta = await apiFetch('/api/archivos', { headers: { Authorization: `Bearer ${token}` } });
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudieron cargar los archivos.');
      setArchivos(data.archivos || []);
    } catch (error) {
      notificarError(error.message, { titulo: 'No se pudieron cargar los archivos' });
    }
  };

  useEffect(() => { cargarArchivos(); }, []);

  const archivosFiltrados = useMemo(() => {
    const termino = busqueda.trim().toLowerCase();
    if (!termino) return archivos;
    return archivos.filter((item) => [item.nombre, item.nombreArchivo, item.descripcion, item.propietarioNombre, item.propietarioEmail]
      .filter(Boolean).some((valor) => valor.toLowerCase().includes(termino)));
  }, [archivos, busqueda]);

  const subir = async (event) => {
    event.preventDefault();
    if (!archivo) return notificarInfo('Selecciona un archivo para continuar.', { titulo: 'Archivo requerido' });
    setCargando(true);
    try {
      const datos = new FormData();
      datos.append('archivo', archivo);
      datos.append('nombre', nombre.trim());
      datos.append('descripcion', descripcion.trim());
      const respuesta = await apiFetch('/api/archivos', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: datos });
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo procesar el archivo.');
      notificarExito(data.mensaje, { titulo: 'Archivo publicado' });
      setArchivo(null); setNombre(''); setDescripcion('');
      document.getElementById('archivo-colaborativo').value = '';
      await cargarArchivos();
    } catch (error) {
      notificarError(error.message, { titulo: 'Error al subir el archivo' });
    } finally {
      setCargando(false);
    }
  };

  const descargar = async (item) => {
    try {
      const respuesta = await apiFetch(`/api/archivos/${item.id}/download`, { headers: { Authorization: `Bearer ${token}` } });
      if (!respuesta.ok) throw new Error((await respuesta.json()).error || 'No se pudo descargar el archivo.');
      const url = URL.createObjectURL(await respuesta.blob());
      const enlace = document.createElement('a'); enlace.href = url; enlace.download = item.nombreArchivo; enlace.click(); URL.revokeObjectURL(url);
    } catch (error) { notificarError(error.message, { titulo: 'Error de descarga' }); }
  };

  const eliminar = async (item) => {
    if (!window.confirm(`¿Eliminar ${item.nombreArchivo}? También se eliminará de MongoDB y dejará de estar disponible para la IA.`)) return;
    try {
      const respuesta = await apiFetch(`/api/archivos/${item.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo eliminar el archivo.');
      setArchivos((actual) => actual.filter((archivoActual) => archivoActual.id !== item.id));
      notificarExito(data.mensaje, { titulo: 'Archivo eliminado' });
    } catch (error) { notificarError(error.message, { titulo: 'No se pudo eliminar' }); }
  };

  return (
    <section>
      <span className="dashboard-eyebrow">Contenido para IA</span>
      <h1>Archivos</h1>
      <p>Cualquier usuario activo puede subir archivos. Se indexan PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), Visio (.vsdx) y formatos de texto; los demás se guardan para descarga.</p>
      <form className="compact-upload-form" onSubmit={subir}>
        <label className="compact-upload-file">Archivo
          <input id="archivo-colaborativo" type="file" onChange={(event) => setArchivo(event.target.files?.[0] || null)} disabled={cargando} required />
          <span className={archivo ? 'compact-file-picker selected' : 'compact-file-picker'}><FiPaperclip aria-hidden="true" /> {archivo?.name || 'Seleccionar archivo para subir...'}</span>
        </label>
        <label>Nombre <small>(opcional)</small><input value={nombre} onChange={(event) => setNombre(event.target.value)} disabled={cargando} /></label>
        <label>Descripción <small>(opcional)</small><input value={descripcion} onChange={(event) => setDescripcion(event.target.value)} disabled={cargando} /></label>
        <button className="profile-primary-button" type="submit" disabled={cargando}><FiUploadCloud /> {cargando ? 'Procesando…' : 'Subir archivo'}</button>
      </form>
      <label className="library-search"><FiSearch aria-hidden="true" /><input value={busqueda} onChange={(event) => setBusqueda(event.target.value)} placeholder="Buscar por nombre, archivo o autor…" /></label>
      <div style={{ display: 'grid', gap: 12, marginTop: 20 }}>
        {archivosFiltrados.length === 0 ? <p>{busqueda ? 'No hay archivos que coincidan con la búsqueda.' : 'No hay archivos colaborativos todavía.'}</p> : archivosFiltrados.map((item) => {
          const puedeEliminar = esAdministrador || item.propietarioUid === usuario?.uid;
          return <article key={item.id} style={{ background: '#fff', padding: 16, borderRadius: 8, border: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div><h3 style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center' }}><FiFile /> {item.nombre || item.nombreArchivo}</h3><small>{item.nombreArchivo} · {formatearTamano(item.tamano)} · Subido por {item.propietarioNombre || item.propietarioEmail || 'Usuario'}</small><p style={{ marginBottom: 0 }}>{item.estadoIndexacion === 'completada' ? 'Disponible para el asistente IA.' : item.estadoIndexacion === 'sin_texto' ? 'Guardado; este formato no se puede indexar automáticamente.' : 'Procesamiento pendiente o con error.'}</p></div>
            <div style={{ display: 'flex', gap: 8 }}><button type="button" className="profile-primary-button" onClick={() => descargar(item)}><FiDownload /></button>{puedeEliminar && <button type="button" className="billing-cancel" onClick={() => eliminar(item)}><FiTrash2 /></button>}</div>
          </article>;
        })}
      </div>
    </section>
  );
}
