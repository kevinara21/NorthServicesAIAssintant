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
  const [archivosSeleccionados, setArchivosSeleccionados] = useState([]);
  const [nombre, setNombre] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [cargando, setCargando] = useState(false);
  const { notificarError, notificarExito, notificarInfo } = useNotification();
  const esAdministrador = usuario?.rol?.toLowerCase() === 'administrador';
  const [confirmacion, setConfirmacion] = useState({ visible: false, titulo: '', mensaje: '', onConfirm: null });

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

  const quitarArchivoSeleccionado = (indice) => {
    setArchivosSeleccionados((actual) => {
      const siguientes = actual.filter((_, i) => i !== indice);
      if (!siguientes.length) {
        const input = document.getElementById('archivo-colaborativo');
        if (input) input.value = '';
      }
      return siguientes;
    });
  };

  const subir = async (event) => {
    event.preventDefault();
    if (!archivosSeleccionados.length) return notificarInfo('Selecciona al menos un archivo para continuar.', { titulo: 'Archivo requerido' });
    setCargando(true);
    let subidos = 0;
    let errores = 0;
    try {
      for (const archivo of archivosSeleccionados) {
        try {
          const datos = new FormData();
          datos.append('archivo', archivo);
          datos.append('nombre', nombre.trim());
          datos.append('descripcion', descripcion.trim());
          const respuesta = await apiFetch('/api/archivos', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: datos });
          const data = await respuesta.json();
          if (!respuesta.ok) throw new Error(data.error || 'No se pudo procesar.');
          subidos++;
        } catch { errores++; }
      }
      if (subidos > 0) notificarExito(`${subidos} archivo${subidos > 1 ? 's' : ''} publicado${subidos > 1 ? 's' : ''}.`, { titulo: 'Archivos subidos' });
      if (errores > 0) notificarError(`${errores} archivo${errores > 1 ? 's' : ''} no se pudo${errores === 1 ? '' : ''} procesar.`, { titulo: 'Algunos archivos fallaron' });
      setArchivosSeleccionados([]); setNombre(''); setDescripcion('');
      document.getElementById('archivo-colaborativo').value = '';
      await cargarArchivos();
    } catch (error) {
      notificarError(error.message, { titulo: 'Error al subir archivos' });
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
    setConfirmacion({ visible: true, titulo: `¿Enviar "${item.nombre || item.nombreArchivo}" a la papelera?`, mensaje: 'El archivo dejará de estar disponible para la IA y el chat. Podrás restaurarlo desde la Papelera.', onConfirm: async () => {
      setConfirmacion({ visible: false });
      try {
        const respuesta = await apiFetch(`/api/archivos/${item.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
        const data = await respuesta.json();
        if (!respuesta.ok) throw new Error(data.error || 'No se pudo eliminar el archivo.');
        setArchivos((actual) => actual.filter((archivoActual) => archivoActual.id !== item.id));
        notificarExito(data.mensaje, { titulo: 'Archivo enviado a la papelera' });
      } catch (error) { notificarError(error.message, { titulo: 'No se pudo eliminar' }); }
    }});
  };

  return (
    <section>
      <span className="dashboard-eyebrow">Contenido para IA</span>
      <h1>Archivos</h1>
      <p>Cualquier usuario activo puede subir archivos. Se indexan PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), Visio (.vsdx) y formatos de texto; los demás se guardan para descarga.</p>
      <form className="compact-upload-form" onSubmit={subir}>
        <label className="compact-upload-file">Archivo
          <input id="archivo-colaborativo" type="file" multiple onChange={(event) => setArchivosSeleccionados([...(event.target.files || [])])} disabled={cargando} required />
          <div className={archivosSeleccionados.length ? 'compact-file-picker selected' : 'compact-file-picker'}><FiPaperclip aria-hidden="true" /> {archivosSeleccionados.length ? `${archivosSeleccionados.length} archivo${archivosSeleccionados.length > 1 ? 's' : ''} seleccionado${archivosSeleccionados.length > 1 ? 's' : ''}` : 'Seleccionar archivo(s) para subir...'}</div>
          {archivosSeleccionados.length > 0 && (
            <div className="compact-selected-files">
              {archivosSeleccionados.map((archivoSeleccionado, indice) => (
                <div className="compact-selected-file" key={`${archivoSeleccionado.name}-${indice}`}>
                  <span title={archivoSeleccionado.name}>{archivoSeleccionado.name}</span>
                  <small>{formatearTamano(archivoSeleccionado.size)}</small>
                  <button type="button" onClick={() => quitarArchivoSeleccionado(indice)} aria-label={`Quitar ${archivoSeleccionado.name}`}>×</button>
                </div>
              ))}
            </div>
          )}
        </label>
        <label>Nombre<input value={nombre} onChange={(event) => setNombre(event.target.value)} disabled={cargando} /></label>
        <label>Descripción<input value={descripcion} onChange={(event) => setDescripcion(event.target.value)} disabled={cargando} /></label>
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
      {confirmacion.visible && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }} onClick={() => setConfirmacion({ visible: false })}>
        <div style={{ background: '#fff', borderRadius: 12, padding: '28px 32px', maxWidth: 420, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', border: '1px solid #e2e8f0' }} onClick={(e) => e.stopPropagation()}>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', marginBottom: 8 }}>{confirmacion.titulo}</div>
          <p style={{ color: '#64748b', fontSize: 14, lineHeight: 1.6, margin: 0, marginBottom: 24 }}>{confirmacion.mensaje}</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setConfirmacion({ visible: false })} style={{ padding: '8px 18px', border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', color: '#374151', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Cancelar</button>
            <button type="button" onClick={confirmacion.onConfirm} style={{ padding: '8px 18px', border: 'none', borderRadius: 6, background: '#DC2626', color: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>Enviar a papelera</button>
          </div>
        </div>
      </div>
    )}
  </section>
  );
}
