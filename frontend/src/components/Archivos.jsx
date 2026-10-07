import { useEffect, useMemo, useRef, useState } from 'react';
import { FiCheck, FiCheckSquare, FiDownload, FiFile, FiFilter, FiLayers, FiPaperclip, FiPlus, FiRefreshCw, FiSearch, FiSquare, FiTrash2, FiUploadCloud, FiX } from 'react-icons/fi';
import { apiFetch } from '../services/api';
import { useNotification } from '../context/NotificationContext';
import OilLoader from './common/OilLoader';

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
  const [descripcion, setDescripcion] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [filtroCategoria, setFiltroCategoria] = useState('');

  // Categorías de conocimiento: las trae el backend, no están fijas en el
  // frontend, así que el Administrador puede agregar más sin desplegar.
  const [categorias, setCategorias] = useState([]);
  const [categoriaId, setCategoriaId] = useState('');
  const [cargando, setCargando] = useState(false);
  const [cargandoInicial, setCargandoInicial] = useState(true);
  const { notificarError, notificarExito, notificarInfo } = useNotification();
  const esAdministrador = usuario?.rol?.toLowerCase() === 'administrador';
  const [confirmacion, setConfirmacion] = useState({ visible: false, titulo: '', mensaje: '', etiqueta: 'Enviar a papelera', onConfirm: null });
  const [modalSubirAbierto, setModalSubirAbierto] = useState(false);
  const inputActualizacionRef = useRef(null);
  const archivoActualizacionRef = useRef(null);

  // Crear una categoría nueva desde este mismo formulario, para no tener
  // que salir a Conocimiento y permisos por rol a medio trabajo.
  const [creandoCategoria, setCreandoCategoria] = useState(false);
  const [guardandoCategoria, setGuardandoCategoria] = useState(false);
  const [nuevaCategoria, setNuevaCategoria] = useState({ nombre: '', descripcion: '' });

  const categoriaElegida = useMemo(
    () => categorias.find((categoria) => categoria.id === categoriaId) || null,
    [categorias, categoriaId]
  );

  const cargarArchivos = async () => {
    try {
      const respuesta = await apiFetch('/api/archivos', { headers: { Authorization: `Bearer ${token}` } });
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudieron cargar los archivos.');
      setArchivos(data.archivos || []);
    } catch (error) {
      notificarError(error.message, { titulo: 'No se pudieron cargar los archivos' });
    } finally {
      setCargandoInicial(false);
    }
  };

  const cargarCategorias = async () => {
    try {
      const respuesta = await apiFetch('/api/rag/categorias', { headers: { Authorization: `Bearer ${token}` } });
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudieron cargar las categorías.');
      const lista = data.categorias || [];
      setCategorias(lista);
      // La general es la fuente compartida: se propone por defecto y el
      // usuario puede cambiarla antes de subir.
      if (lista.length) {
        setCategoriaId((actual) => {
          if (actual && lista.some((categoria) => categoria.id === actual)) return actual;
          const general = lista.find((categoria) => categoria.id === 'conocimiento_general');
          return general?.id || lista[0].id;
        });
      }
    } catch (error) {
      notificarError(error.message, { titulo: 'No se pudieron cargar las categorías' });
    }
  };

  useEffect(() => { cargarArchivos(); cargarCategorias(); }, []);

  const alternarFormularioCategoria = () => {
    setCreandoCategoria((actual) => !actual);
    if (creandoCategoria) setNuevaCategoria({ nombre: '', descripcion: '' });
  };

  const crearCategoriaDesdeSubida = async () => {
    if (!nuevaCategoria.nombre.trim()) return;
    setGuardandoCategoria(true);
    try {
      // Cualquier rol puede crear la categoría. El backend la enlaza al rol de
// quien la crea, así que el archivo recién subido se ve de inmediato sin que
// un Administrador tenga que marcar permisos.
const respuesta = await apiFetch('/api/rag/categorias', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(nuevaCategoria),
      });
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo crear la categoría.');
      notificarExito(data.mensaje, { titulo: 'Categoría creada' });
      setNuevaCategoria({ nombre: '', descripcion: '' });
      setCreandoCategoria(false);
      await cargarCategorias();
      // Se selecciona la recién creada para no tener que buscarla en la lista.
      setCategoriaId(data.categoria?.id || '');
    } catch (error) {
      notificarError(error.message, { titulo: 'No se pudo crear la categoría' });
    } finally {
      setGuardandoCategoria(false);
    }
  };

  // Las categorías del sistema (Software y Manuales) no son conocimiento que
  // se pueda repartir: a ellas no se les sube nada y no aparecen como filtro.
  // Se apartan aquí una sola vez para que el resto del componente trabaje
  // únicamente con lo que este usuario realmente puede elegir.
  const categoriasSubida = useMemo(
    () => categorias.filter((categoria) => !categoria.sistema),
    [categorias]
  );

  // Primero se aplica el filtro de categoria elegida y despues la busqueda
  // por texto, para que ambas condiciones se puedan combinar.
  const archivosFiltrados = useMemo(() => {
    const porCategoria = filtroCategoria
      ? archivos.filter((item) => item.categoriaId === filtroCategoria)
      : archivos;

    const termino = busqueda.trim().toLowerCase();
    if (!termino) return porCategoria;
    return porCategoria.filter((item) => [item.nombre, item.nombreArchivo, item.descripcion, item.propietarioNombre, item.propietarioEmail, item.categoriaNombre]
      .filter(Boolean).some((valor) => valor.toLowerCase().includes(termino)));
  }, [archivos, busqueda, filtroCategoria]);

  const nombreCategoria = useMemo(() => {
    const mapa = new Map(categorias.map((categoria) => [categoria.id, categoria.nombre]));
    return (item) => mapa.get(item.categoriaId) || item.categoriaNombre || 'Sin categoría';
  }, [categorias]);

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
    if (!archivosPermitidos.includes(extension)) {
      return { valido: false, error: `El formato ${extension || 'sin extensión'} no está permitido. Selecciona un archivo de documentación compatible.` };
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
    if (!categoriaId) return notificarInfo('Selecciona el tipo de información del documento.', { titulo: 'Categoría requerida' });
    setCargando(true);
    let subidos = 0;
    let errores = 0;
    try {
      for (const archivo of archivosSeleccionados) {
        try {
          const datos = new FormData();
          datos.append('archivo', archivo);
          // No hay campo "Nombre" en el formulario: cada archivo lleva el suyo.
          // Si no se envía, el backend guarda el nombre del archivo sin la
          // extensión, que es exactamente lo que se quería.
          datos.append('descripcion', descripcion.trim());
          // El backend decide la colección de embeddings a partir de esto.
          datos.append('categoriaId', categoriaId);
          const respuesta = await apiFetch('/api/archivos', { method: 'POST',           headers: {
            Authorization: `Bearer ${token}`,
          }, body: datos });
          const data = await respuesta.json();
          if (!respuesta.ok) throw new Error(data.error || 'No se pudo procesar.');
          subidos++;
        } catch { errores++; }
      }
      if (subidos > 0) notificarExito(`${subidos} archivo${subidos > 1 ? 's' : ''} publicado${subidos > 1 ? 's' : ''}.`, { titulo: 'Archivos subidos' });
      if (errores > 0) notificarError(`${errores} archivo${errores > 1 ? 's' : ''} no se pudo${errores === 1 ? '' : ''} procesar.`, { titulo: 'Algunos archivos fallaron' });
      setArchivosSeleccionados([]); setDescripcion('');
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

  const confirmarActualizacion = (item, archivoNuevo) => {
    setConfirmacion({
      visible: true,
      titulo: `¿Reemplazar "${item.nombre || item.nombreArchivo}"?`,
      mensaje: 'El documento anterior y sus fragmentos dejarán de estar disponibles para la IA. Se conservarán el nombre, la descripción, la categoría y los permisos; el archivo nuevo se volverá a procesar e indexar.',
      etiqueta: 'Reemplazar documento',
      onConfirm: async () => {
        setConfirmacion({ visible: false });
        setCargando(true);
        try {
          const datos = new FormData();
          datos.append('archivo', archivoNuevo);
          const respuesta = await apiFetch(`/api/archivos/${item.id}/actualizar`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token },
            body: datos,
          });
          const data = await respuesta.json();
          if (!respuesta.ok) throw new Error(data.error || 'No se pudo reemplazar el documento.');
          notificarExito(data.mensaje, { titulo: 'Documento actualizado' });
          await cargarArchivos();
        } catch (error) {
          notificarError(error.message, { titulo: 'No se pudo actualizar el documento' });
        } finally {
          setCargando(false);
          if (inputActualizacionRef.current) inputActualizacionRef.current.value = '';
        }
      },
    });
  };

  const actualizarArchivoSeleccionado = (event) => {
    const archivoNuevo = event.target.files?.[0];
    const item = archivoActualizacionRef.current;
    archivoActualizacionRef.current = null;
    if (!archivoNuevo || !item) return;

    const validacion = validarArchivo(archivoNuevo);
    if (!validacion.valido) {
      notificarError(validacion.error, { titulo: 'Formato no permitido' });
      event.target.value = '';
      return;
    }
    confirmarActualizacion(item, archivoNuevo);
  };

  const seleccionarArchivoParaActualizar = (item) => {
    archivoActualizacionRef.current = item;
    if (inputActualizacionRef.current) {
      inputActualizacionRef.current.value = '';
      inputActualizacionRef.current.click();
    }
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
      mensaje: 'Los archivos dejarán de verse aquí y el contenido dejará de estar disponible para la IA. Permanecen 30 días en la papelera antes de eliminarse de forma permanente.',
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
      <p>Cualquier usuario activo puede subir archivos. Se indexan PDF, Word, Excel, PowerPoint, Visio y texto. No se permiten ejecutables ni scripts. Los archivos eliminados pasan a la papelera por 30 días y dejan de estar disponibles para la IA.</p>
      <input
        ref={inputActualizacionRef}
        type="file"
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.vsdx,.txt,.rtf,.odt,.ods,.odp,.csv,.jpg,.jpeg,.png,.gif,.bmp,.webp"
        onChange={actualizarArchivoSeleccionado}
        hidden
      />
      


      {modalSubirAbierto && (
        <div className="modal-overlay modal-monitoreo-pozo-overlay" role="dialog" aria-modal="true" aria-label="Subir archivo" onClick={(event) => { if (event.target === event.currentTarget) setModalSubirAbierto(false); }}>
          <div className="modal-monitoreo-pozo">
            <header className="modal-monitoreo-pozo-header">
              <div>
                <span className="dashboard-eyebrow">Subir archivo</span>
              </div>
              <button type="button" className="modal-monitoreo-pozo-close" onClick={() => setModalSubirAbierto(false)} aria-label="Cerrar modal"><FiX aria-hidden="true" /></button>
            </header>

            <div className="modal-monitoreo-pozo-body">
              <p className="modal-monitoreo-pozo-intro">Sube archivos de documentación para que estén disponibles para el asistente IA. Solo se permiten formatos de documento y no archivos ejecutables o scripts por seguridad.</p>

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
                <label>Descripción<input value={descripcion} onChange={(event) => setDescripcion(event.target.value)} disabled={cargando} /></label>

                <div className="archivo-categoria">
                  <span className="archivo-categoria__etiqueta">
                    Tipo de información
                    {categoriaElegida?.coleccion && (
                      <code className="archivo-categoria__coleccion">{categoriaElegida.coleccion}</code>
                    )}
                  </span>

                  {categoriasSubida.length === 0 ? (
                    <div className="archivo-categoria__vacio">
                      <span>Aún no hay categorías de conocimiento. Crea la primera para poder subir archivos.</span>
                    </div>
                  ) : (
                    <div className="archivo-categoria__selector">
                      <select
                        className="archivo-categoria__select"
                        value={categoriaId}
                        onChange={(event) => setCategoriaId(event.target.value)}
                        disabled={cargando}
                        required
                      >
                        {categoriasSubida.map((categoria) => (
                          <option key={categoria.id} value={categoria.id}>{categoria.nombre}</option>
                        ))}
                      </select>
                      <FiLayers aria-hidden="true" className="archivo-categoria__icono" />
                    </div>
                  )}

                  {categoriaElegida?.descripcion && (
                    <p className="archivo-categoria__ayuda">{categoriaElegida.descripcion}</p>
                  )}

                  {/* Cualquier usuario activo puede crear una categoría: el
                      backend la guarda y la otorga automáticamente a su rol,
                      así que quien la crea ya ve su archivo sin intervención
                      del Administrador. */}
                  <>
                    <button
                      type="button"
                      className="archivo-categoria__nueva"
                      onClick={alternarFormularioCategoria}
                      disabled={cargando || guardandoCategoria}
                    >
                      <FiPlus aria-hidden="true" />
                      {creandoCategoria ? 'Cancelar' : 'Crear nueva categoría'}
                    </button>

                    {creandoCategoria && (
                      <div className="archivo-categoria__form">
                        <label>
                          Nombre de la categoría
                          <input
                            value={nuevaCategoria.nombre}
                            onChange={(event) => setNuevaCategoria((actual) => ({ ...actual, nombre: event.target.value }))}
                            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); crearCategoriaDesdeSubida(); } }}
                            placeholder="Ej. Procedimientos de arranque"
                            disabled={guardandoCategoria}
                          />
                        </label>
                        <label>
                          Descripción (opcional)
                          <input
                            value={nuevaCategoria.descripcion}
                            onChange={(event) => setNuevaCategoria((actual) => ({ ...actual, descripcion: event.target.value }))}
                            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); crearCategoriaDesdeSubida(); } }}
                            disabled={guardandoCategoria}
                          />
                        </label>
                        <button
                          className="profile-primary-button"
                          type="button"
                          onClick={crearCategoriaDesdeSubida}
                          disabled={guardandoCategoria || !nuevaCategoria.nombre.trim()}
                        >
                          <FiCheck />
                          {guardandoCategoria ? 'Creando…' : 'Crear categoría'}
                        </button>
                      </div>
                    )}
                  </>
                </div>

                <button className="profile-primary-button" type="submit" disabled={cargando}><FiUploadCloud /> {cargando ? 'Procesando…' : 'Subir archivo'}</button>
              </form>
            </div>
          </div>
        </div>
      )}
      <div className="library-toolbar">
        <label className="library-search"><FiSearch aria-hidden="true" /><input value={busqueda} onChange={(event) => setBusqueda(event.target.value)} placeholder="Buscar por nombre, archivo o autor…" /></label>
        {categoriasSubida.length > 0 && (
          <div className="library-filtros-categoria" role="group" aria-label="Filtrar por categoría">
            <FiFilter aria-hidden="true" />
            <button type="button" className={!filtroCategoria ? 'active' : ''} onClick={() => setFiltroCategoria('')}>Todas</button>
            {categoriasSubida.map((categoria) => (
              <button
                key={categoria.id}
                type="button"
                className={filtroCategoria === categoria.id ? 'active' : ''}
                onClick={() => setFiltroCategoria(filtroCategoria === categoria.id ? '' : categoria.id)}
              >
                {categoria.nombre}
              </button>
            ))}
          </div>
        )}
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
      <div className="file-list">
        {cargandoInicial ? <OilLoader label="Cargando archivos" inline /> : archivosFiltrados.length === 0 ? <p>{busqueda ? 'No hay archivos que coincidan con la búsqueda.' : 'No hay archivos colaborativos todavía.'}</p> : archivosFiltrados.map((item) => {
          const puedeEliminar = puedeEliminarItem(item);
          const seleccionado = idsSeleccionados.includes(item.id);
          return <article key={item.id} className={`file-card${seleccionado ? ' selected' : ''}`}>
            <div className="file-card-main">
              {modoSeleccion && (
                <input type="checkbox" className="file-card-checkbox" checked={seleccionado} onChange={() => alternarSeleccion(item.id)} aria-label={`Seleccionar ${item.nombre || item.nombreArchivo}`} />
              )}
              <div className="file-card-info">
                <h3><FiFile /> <span>{item.nombre || item.nombreArchivo}</span></h3>
                <small>{item.nombreArchivo} · {formatearTamano(item.tamano)} · Subido por {item.propietarioNombre || item.propietarioEmail || 'Usuario'}</small>
                <p><strong>{nombreCategoria(item)}</strong> · {item.estadoIndexacion === 'completada' ? 'Disponible para el asistente IA.' : item.estadoIndexacion === 'sin_texto' ? 'Guardado; este formato no se puede indexar automáticamente.' : 'Procesamiento pendiente o con error.'}</p>
              </div>
            </div>
            <div className="file-card-actions"><button type="button" className="profile-primary-button" onClick={() => descargar(item)} aria-label="Descargar"><FiDownload /></button>{puedeEliminar && <><button type="button" className="library-icon-button" onClick={() => seleccionarArchivoParaActualizar(item)} disabled={cargando} aria-label="Actualizar documento" title="Actualizar documento"><FiRefreshCw /></button><button type="button" className="billing-cancel" onClick={() => enviarAPapelera([item])} aria-label="Enviar a papelera"><FiTrash2 /></button></>}</div>
          </article>;
        })}
      </div>
      {confirmacion.visible && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }} onClick={() => setConfirmacion({ visible: false })}>
        <div style={{ background: '#fff', borderRadius: 12, padding: '24px', maxWidth: 420, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', border: '1px solid #e2e8f0' }} onClick={(e) => e.stopPropagation()}>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', marginBottom: 8, overflowWrap: 'anywhere' }}>{confirmacion.titulo}</div>
          <p style={{ color: '#64748b', fontSize: 14, lineHeight: 1.6, margin: 0, marginBottom: 24 }}>{confirmacion.mensaje}</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button type="button" onClick={() => setConfirmacion({ visible: false })} style={{ padding: '10px 18px', border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', color: '#374151', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Cancelar</button>
            <button type="button" onClick={confirmacion.onConfirm} style={{ padding: '10px 18px', border: 'none', borderRadius: 6, background: '#DC2626', color: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>{confirmacion.etiqueta || 'Enviar a papelera'}</button>
          </div>
        </div>
      </div>
    )}
  </section>
  );
}
