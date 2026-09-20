import { useEffect, useMemo, useState } from 'react';
import { FiCheckSquare, FiDownload, FiFile, FiPaperclip, FiSearch, FiSquare, FiTrash2, FiUploadCloud, FiX } from 'react-icons/fi';
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
  const [idsSeleccionados, setIdsSeleccionados] = useState([]);
  const [modoSeleccion, setModoSeleccion] = useState(false);
  const [nombre, setNombre] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [cargando, setCargando] = useState(false);
  const { notificarError, notificarExito, notificarInfo } = useNotification();
  const esAdministrador = usuario?.rol?.toLowerCase() === 'administrador';
  const [confirmacion, setConfirmacion] = useState({ visible: false, titulo: '', mensaje: '', etiqueta: 'Enviar a papelera', onConfirm: null });
  const [modalSubirAbierto, setModalSubirAbierto] = useState(false);

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

  const puedeEliminarItem = (item) => esAdministrador || item.propietarioUid === usuario?.uid;
  const idsVisibles = archivosFiltrados.map((item) => item.id);
  const todosSeleccionados = idsVisibles.length > 0 && idsVisibles.every((id) => idsSeleccionados.includes(id));
  const seleccionActual = archivosFiltrados.filter((item) => idsSeleccionados.includes(item.id));
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

  const archivosPermitidos = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.vsdx', '.txt', '.rtf', '.odt', '.ods', '.odp', '.csv', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
  const archivosProhibidos = ['.php', '.py', '.exe', '.dll', '.bat', '.sh', '.cmd', '.js', '.jar', '.com', '.msi', '.app', '.deb', '.rpm', '.dmg', '.pkg', '.vbs', '.ps1', '.pl', '.rb', '.go', '.java', '.class', '.war', '.ear', '.apk', '.ipa', '.bin', '.scr', '.pif', '.vbe', '.jse', '.wsf', '.wsc', '.ws', '.reg', '.inf', '.url', '.lnk', '.iso', '.img', '.dmg', '.toast', '.vcd', '.nrg', '.cue', '.bin', '.mdf', '.mnds', '.ccd', '.sub', '.srt', '.ass', '.ssa', '.sub', '.idx'];

  const validarArchivo = (archivo) => {
    const extension = archivo.name.toLowerCase().substring(archivo.name.lastIndexOf('.'));
    if (archivosProhibidos.includes(extension)) {
      return { valido: false, error: `No se permiten archivos ejecutables o scripts (${extension}). Solo se permite documentación.` };
    }
    return { valido: true };
  };

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
      setModalSubirAbierto(false);
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

  const descargarVarios = async (lista) => {
    if (!lista.length) return notificarInfo('No hay archivos seleccionados para descargar.', { titulo: 'Descarga requerida' });
    let exitosos = 0;
    let fallidos = 0;
    for (const item of lista) {
      try {
        await descargar(item);
        exitosos++;
      } catch (error) {
        fallidos++;
      }
      await new Promise((resolver) => setTimeout(resolver, 250));
    }
    if (exitosos > 0) notificarExito(`${exitosos} archivo${exitosos > 1 ? 's' : ''} descargado${exitosos > 1 ? 's' : ''}.`, { titulo: 'Descarga completada' });
    if (fallidos > 0) notificarError(`${fallidos} archivo${fallidos > 1 ? 's' : ''} no se pudo${fallidos === 1 ? '' : ''} descargar.`, { titulo: 'Error en descarga' });
  };

  const enviarAPapelera = (lista) => {
    const elegibles = lista.filter(puedeEliminarItem);
    if (!elegibles.length) return notificarInfo('No tienes permiso para eliminar los archivos seleccionados.', { titulo: 'Sin permiso' });
    const varios = elegibles.length > 1;
    setConfirmacion({
      visible: true,
      titulo: varios ? `¿Enviar ${elegibles.length} archivos a la papelera?` : `¿Enviar "${elegibles[0].nombre || elegibles[0].nombreArchivo}" a la papelera?`,
      mensaje: 'Los archivos dejarán de verse aquí, pero el contenido se mantiene para la IA. Permanecen 30 días en la papelera antes de eliminarse de forma permanente.',
      etiqueta: varios ? 'Enviar a papelera' : 'Enviar a papelera',
      onConfirm: async () => {
        setConfirmacion({ visible: false });
        try {
          const ids = elegibles.map((item) => item.id);
          const respuesta = await apiFetch('/api/archivos/lote/eliminar', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
          });
          const data = await respuesta.json();
          if (!respuesta.ok) throw new Error(data.error || 'No se pudo enviar a la papelera.');
          setArchivos((actual) => actual.filter((archivoActual) => !ids.includes(archivoActual.id)));
          setIdsSeleccionados((actual) => actual.filter((id) => !ids.includes(id)));
          notificarExito(data.mensaje, { titulo: 'Enviado a la papelera' });
        } catch (error) { notificarError(error.message, { titulo: 'No se pudo eliminar' }); }
      },
    });
  };

  return (
    <section>
      <span className="dashboard-eyebrow">Contenido para IA</span>
      <h1>Archivos</h1>
      <p>Cualquier usuario activo puede subir archivos. Se indexan PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), Visio (.vsdx) y formatos de texto; los demás se guardan para descarga. No se permiten archivos ejecutables o scripts (PHP, Python, EXE, etc.) por seguridad. Al eliminar, el archivo va a la papelera 30 días y el contenido se mantiene para la IA.</p>
      


      {modalSubirAbierto && (
        <div className="modal-overlay eclipse-modal-overlay" role="dialog" aria-modal="true" aria-label="Subir archivo" onClick={(event) => { if (event.target === event.currentTarget) setModalSubirAbierto(false); }}>
          <div className="eclipse-modal">
            <header className="eclipse-modal-header">
              <div>
                <span className="dashboard-eyebrow">Subir archivo</span>
              </div>
              <button type="button" className="eclipse-modal-close" onClick={() => setModalSubirAbierto(false)} aria-label="Cerrar modal"><FiX aria-hidden="true" /></button>
            </header>

            <div className="eclipse-modal-body">
              <p className="eclipse-intro">Sube archivos de documentación para que estén disponibles para el asistente IA. Solo se permiten formatos de documento y no archivos ejecutables o scripts por seguridad.</p>

              <form className="modal-upload-form" onSubmit={subir}>
                <label className="compact-upload-file">Archivo
                  <input id="archivo-colaborativo" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.vsdx,.txt,.rtf,.odt,.ods,.odp,.csv,.jpg,.jpeg,.png,.gif,.bmp,.webp" onChange={(event) => {
                    const files = event.target.files || [];
                    const archivosValidos = [];
                    const archivosInvalidos = [];
                    for (const file of files) {
                      const validacion = validarArchivo(file);
                      if (validacion.valido) {
                        archivosValidos.push(file);
                      } else {
                        archivosInvalidos.push(file.name);
                      }
                    }
                    if (archivosInvalidos.length > 0) {
                      notificarError(`Los siguientes archivos no están permitidos: ${archivosInvalidos.join(', ')}. Solo se permite documentación.`, { titulo: 'Archivos no permitidos' });
                    }
                    setArchivosSeleccionados(archivosValidos);
                  }} disabled={cargando} required />
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
            </div>
          </div>
        </div>
      )}
      <div className="library-toolbar">
        <label className="library-search"><FiSearch aria-hidden="true" /><input value={busqueda} onChange={(event) => setBusqueda(event.target.value)} placeholder="Buscar por nombre, archivo o autor…" /></label>
        <button type="button" className="library-icon-button" onClick={() => setModalSubirAbierto(true)} title="Subir archivo">
          <FiUploadCloud />
        </button>
        <button type="button" className={`library-select-toggle${modoSeleccion ? ' active' : ''}`} onClick={alternarModoSeleccion} title={modoSeleccion ? 'Cancelar selección' : 'Selección múltiple'}>
          {modoSeleccion ? <FiCheckSquare /> : <FiSquare />}
        </button>
        {modoSeleccion && archivosFiltrados.length > 0 && (
          <label className="library-select-all">
            <input type="checkbox" checked={todosSeleccionados} onChange={alternarTodos} />
            Seleccionar todos ({seleccionActual.length}/{archivosFiltrados.length})
          </label>
        )}
        {archivosFiltrados.length > 0 && (
          <>
            <button type="button" className="library-icon-button" disabled={modoSeleccion && !haySeleccion} onClick={() => descargarVarios(haySeleccion ? seleccionActual : archivosFiltrados)} title="Descargar todo">
              <FiDownload />
            </button>
            <button type="button" className="library-icon-button danger" disabled={(modoSeleccion && !haySeleccion) || !(haySeleccion ? seleccionActual : archivosFiltrados).some(puedeEliminarItem)} onClick={() => enviarAPapelera(haySeleccion ? seleccionActual : archivosFiltrados)} title="Eliminar todo">
              <FiTrash2 />
            </button>
          </>
        )}
      </div>
      <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
        {archivosFiltrados.length === 0 ? <p>{busqueda ? 'No hay archivos que coincidan con la búsqueda.' : 'No hay archivos colaborativos todavía.'}</p> : archivosFiltrados.map((item) => {
          const puedeEliminar = puedeEliminarItem(item);
          const seleccionado = idsSeleccionados.includes(item.id);
          return <article key={item.id} style={{ background: seleccionado ? '#fef2f2' : '#fff', padding: 16, borderRadius: 8, border: `1px solid ${seleccionado ? '#fecaca' : '#e5e7eb'}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, minWidth: 0, flex: 1 }}>
              {modoSeleccion && (
                <input type="checkbox" checked={seleccionado} onChange={() => alternarSeleccion(item.id)} style={{ marginTop: 6, width: 16, height: 16, accentColor: '#DD2226' }} />
              )}
              <div>
                <h3 style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center' }}><FiFile /> {item.nombre || item.nombreArchivo}</h3>
                <small>{item.nombreArchivo} · {formatearTamano(item.tamano)} · Subido por {item.propietarioNombre || item.propietarioEmail || 'Usuario'}</small>
                <p style={{ marginBottom: 0 }}>{item.estadoIndexacion === 'completada' ? 'Disponible para el asistente IA.' : item.estadoIndexacion === 'sin_texto' ? 'Guardado; este formato no se puede indexar automáticamente.' : 'Procesamiento pendiente o con error.'}</p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}><button type="button" className="profile-primary-button" onClick={() => descargar(item)}><FiDownload /></button>{puedeEliminar && <button type="button" className="billing-cancel" onClick={() => enviarAPapelera([item])}><FiTrash2 /></button>}</div>
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
            <button type="button" onClick={confirmacion.onConfirm} style={{ padding: '8px 18px', border: 'none', borderRadius: 6, background: '#DC2626', color: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>{confirmacion.etiqueta || 'Enviar a papelera'}</button>
          </div>
        </div>
      </div>
    )}
  </section>
  );
}
