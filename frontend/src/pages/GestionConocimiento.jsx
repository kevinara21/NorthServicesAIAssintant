import { useCallback, useEffect, useState } from 'react';
import { FiCheck, FiEdit2, FiShield, FiTrash2, FiX } from 'react-icons/fi';
import { apiFetch } from '../services/api';
import { useNotification } from '../context/NotificationContext';
import OilLoader from '../components/common/OilLoader';

// ============================================================
// GESTIÓN DE CONOCIMIENTO Y PERMISOS RAG
// ============================================================
//
// Panel del Administrador para:
//   - ver qué categorías puede consultar cada rol;
//   - decidir qué roles entran al módulo de Starlink.
//
// Las categorías se crean al subir un archivo desde Archivos, y desde aquí se
// les puede corregir el nombre, la descripción y la colección.
//
// Google Drive no aparece aquí: es conocimiento general compartido para
// todos los usuarios y no se restringe por rol.
// ============================================================

export default function GestionConocimiento({ token }) {
  const [categorias, setCategorias] = useState([]);
  const [roles, setRoles] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [guardandoRol, setGuardandoRol] = useState(null);
  const [borrador, setBorrador] = useState({});
  const [modalAbierto, setModalAbierto] = useState(false);
  const [editando, setEditando] = useState(null);
  const [guardandoEdicion, setGuardandoEdicion] = useState(false);
  const [guardandoEstado, setGuardandoEstado] = useState(null);
  const [borrandoCategoria, setBorrandoCategoria] = useState(false);
  const [pendienteDeBorrar, setPendienteDeBorrar] = useState(null);
  const { notificarExito, notificarError } = useNotification();

  const cabeceras = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // El modal solo edita: las categorías se crean al subir un archivo desde
  // Archivos, y su nombre se puede corregir en cualquier momento desde aquí.
  const formulario = editando;
  const setFormulario = setEditando;

  const cargar = useCallback(async () => {
    try {
      setCargando(true);
      const respuesta = await apiFetch('/api/admin/rag/permisos', { headers: { Authorization: `Bearer ${token}` } });
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo cargar la configuración.');
      setCategorias(data.categorias || []);
      setRoles(data.roles || []);

      // Copia de trabajo para poder editar sin pisar el guardado.
      const inicial = {};
      (data.roles || []).forEach((item) => {
        inicial[item.clave] = {
          categorias: [...(item.categorias || [])],
          modulos: { starlink: item.modulos?.starlink === true },
        };
      });
      setBorrador(inicial);
    } catch (error) {
      notificarError(error.message, { titulo: 'Error al cargar' });
    } finally {
      setCargando(false);
    }
  }, [token]);

  useEffect(() => { cargar(); }, [cargar]);

  const alternarCategoria = (rol, categoriaId) => {
    setBorrador((actual) => {
      const categoriasActuales = actual[rol]?.categorias || [];
      return {
        ...actual,
        [rol]: {
          ...actual[rol],
          categorias: categoriasActuales.includes(categoriaId)
            ? categoriasActuales.filter((valor) => valor !== categoriaId)
            : [...categoriasActuales, categoriaId],
        },
      };
    });
  };

  const alternarStarlink = (rol) => {
    setBorrador((actual) => ({
      ...actual,
      [rol]: {
        ...actual[rol],
        modulos: { starlink: !(actual[rol]?.modulos?.starlink === true) },
      },
    }));
  };

  // Tras guardar se sincroniza únicamente el bloque del rol affected con lo
  // que el backend devolvió. No se recarga toda la matriz, así el panel no
  // vuelve al loader ni se repositiona el scroll.
  const sincronizarRol = (clave, permisos) => {
    const categoriasGuardadas = [...(permisos?.categorias || [])];
    const modulosGuardados = { starlink: permisos?.modulos?.starlink === true };

    setBorrador((actual) => ({
      ...actual,
      [clave]: { categorias: categoriasGuardadas, modulos: modulosGuardados },
    }));
    setRoles((lista) =>
      lista.map((rol) =>
        rol.clave === clave
          ? { ...rol, categorias: categoriasGuardadas, modulos: modulosGuardados, configurado: true }
          : rol
      )
    );
  };

  const guardarRol = async (rol) => {
    const configuracion = borrador[rol.clave];
    if (!configuracion) return;
    setGuardandoRol(rol.clave);
    try {
      // Solo se envían las categorías que el panel conoce. Así una sesión
      // que quedó abierta antes de que una categoría pasara a estar
      // administrada por el sistema no intenta volver a guardarla.
      const conocidas = new Set(categorias.map((categoria) => categoria.id));
      const respuesta = await apiFetch(`/api/admin/rag/permisos/${encodeURIComponent(rol.clave)}`, {
        method: 'PUT',
        headers: cabeceras,
        body: JSON.stringify({
          ...configuracion,
          categorias: (configuracion.categorias || []).filter((id) => conocidas.has(id)),
        }),
      });
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo guardar.');
      sincronizarRol(rol.clave, data.permisos);
      notificarExito(data.mensaje || 'Permisos actualizados.', { titulo: 'Permisos guardados' });
    } catch (error) {
      notificarError(error.message, { titulo: 'No se pudo guardar' });
    } finally {
      setGuardandoRol(null);
    }
  };

const alternarActiva = async (categoria) => {
    setGuardandoEstado(categoria.id);
    try {
      const respuesta = await apiFetch(`/api/admin/rag/categorias/${encodeURIComponent(categoria.id)}`, {
        method: 'PUT',
        headers: cabeceras,
        body: JSON.stringify({ activa: !categoria.activa }),
      });
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo actualizar la categoría.');

      // Solo se refresca esa fila; el resto del panel no se toca. El conteo de
      // archivos puede haber cambiado (al vaciarse una papelera), así que se
      // toma el que devuelve el backend.
      const activa = !categoria.activa;
      const documentoActualizado = data.categoria || { activa };
      setCategorias((lista) =>
        lista.map((item) => (item.id === categoria.id ? { ...item, ...documentoActualizado } : item))
      );

      // El backend explica cuántos archivos fueron a la papelera o volvieron
      // desde ella; ese detalle es lo que el Administrador necesita ver.
      const [detalle] = data.avisos || [];
      notificarExito(detalle || `"${categoria.nombre}" quedó ${activa ? 'activada' : 'desactivada'}.`, {
        titulo: activa ? 'Categoría activada' : 'Categoría desactivada',
      });
    } catch (error) {
      notificarError(error.message, { titulo: 'No se pudo actualizar' });
    } finally { setGuardandoEstado(null); }
  };

  const abrirEdicion = (categoria) => {
    setEditando({
      id: categoria.id,
      nombre: categoria.nombre || '',
      descripcion: categoria.descripcion || '',
      // Se conserva el conteo que trajo la matriz para poder decir cuántos
      // archivos se borrarían sin tener que volver a preguntar al backend.
      documentos: categoria.documentos || { visibles: 0, enPapelera: 0, total: 0 },
    });
    setPendienteDeBorrar(null);
    setModalAbierto(true);
  };

  const cerrarModal = () => {
    setModalAbierto(false);
    setEditando(null);
    setPendienteDeBorrar(null);
  };

  const guardarEdicion = async () => {
    if (!editando?.nombre?.trim()) return;
    setGuardandoEdicion(true);
    try {
      const respuesta = await apiFetch(
        `/api/admin/rag/categorias/${encodeURIComponent(editando.id)}`,
        {
          method: 'PUT',
          headers: cabeceras,
          // Solo el nombre y la descripción: la colección de vectores es un
          // detalle interno que se deriva del nombre y no se edita a mano.
          body: JSON.stringify({
            nombre: editando.nombre,
            descripcion: editando.descripcion,
          }),
        }
      );
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo guardar la categoría.');

      notificarExito(data.mensaje, { titulo: 'Categoría guardada' });
      cerrarModal();
      await cargar();
    } catch (error) {
      notificarError(error.message, { titulo: 'No se pudo guardar' });
    } finally {
      setGuardandoEdicion(false);
    }
  };

  // Elimina la categoría con todos sus archivos. El backend también la quita
  // de los permisos de todos los roles, así que al terminar solo se recarga
  // el panel para que desaparezca de la matriz.
  const confirmarBorrado = async (aPapelera) => {
    if (!editando?.id) return;
    setBorrandoCategoria(true);
    try {
      const destino = aPapelera ? '?papelera=true' : '';
      const respuesta = await apiFetch(
        `/api/admin/rag/categorias/${encodeURIComponent(editando.id)}${destino}`,
        { method: 'DELETE', headers: cabeceras }
      );
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo eliminar la categoría.');

      notificarExito(data.mensaje, { titulo: 'Categoría eliminada' });
      cerrarModal();
      await cargar();
    } catch (error) {
      notificarError(error.message, { titulo: 'No se pudo eliminar' });
    } finally {
      setBorrandoCategoria(false);
      setPendienteDeBorrar(null);
    }
  };

  // Archivos reales que tiene la categoría, no los fragmentos en que se
  // dividen al indexarse. El backend envía el conteo para poder nombrar una
  // cifra correcta en lugar de decir "todos".
  const totalDocumentos = editando?.documentos?.total ?? 0;

  const hayCambios = (rol) => {
    const original = roles.find((item) => item.clave === rol.clave);
    const actual = borrador[rol.clave];
    if (!original || !actual) return false;
    const antes = [...(original.categorias || [])].sort().join('|');
    const despues = [...actual.categorias].sort().join('|');
    return antes !== despues || (original.modulos?.starlink === true) !== (actual.modulos?.starlink === true);
  };

  if (cargando) return <OilLoader label="Cargando configuración de conocimiento" inline />;

  return (
    <div className="panel-conocimiento">
      <h2 className="panel-conocimiento__titulo">Conocimiento y permisos por rol</h2>
      <p className="panel-conocimiento__intro">
        Decide qué fuentes de conocimiento puede consultar cada rol.
        El Administrador tiene acceso total a todas las categorías.
        El conocimiento compartido de Google Drive está disponible para todos los usuarios y no se restringe por rol.
      </p>

      <div className="panel-conocimiento__tabla-wrap" style={{ marginBottom: '28px' }}>
        <table className="panel-conocimiento__tabla">
          <thead>
            <tr>
              <th>Categoría</th>
              <th>Estado</th>
              <th><span className="panel-conocimiento__oculto">Acciones</span></th>
            </tr>
          </thead>
          <tbody>
            {categorias.map((categoria) => (
              <tr key={categoria.id}>
                <td data-label="Categoría">
                  <div className="panel-conocimiento__celda">
                    <span className="panel-conocimiento__categoria">{categoria.nombre}</span>
                    {categoria.descripcion && (
                      <small className="panel-conocimiento__descripcion">{categoria.descripcion}</small>
                    )}
                  </div>
                </td>
                <td data-label="Estado">
                  <div className="panel-conocimiento__celda">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={categoria.activa}
                      aria-label={`${categoria.nombre}: ${categoria.activa ? 'activa' : 'desactivada'}`}
                      onClick={() => alternarActiva(categoria)}
                      disabled={guardandoEstado === categoria.id}
                      className={`interruptor ${categoria.activa ? 'interruptor--on' : 'interruptor--off'}`}
                    >
                      <span className="interruptor__palanca" />
                      <span className="interruptor__texto">
                        {categoria.activa ? 'Activa' : 'Inactiva'}
                      </span>
                    </button>
                  </div>
                </td>
                <td data-label="Acciones">
                  <div className="panel-conocimiento__celda">
                    <button
                      type="button"
                      className="panel-conocimiento__accion"
                      onClick={() => abrirEdicion(categoria)}
                    >
                      <FiEdit2 aria-hidden="true" /> Editar
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {categorias.length === 0 && (
              <tr>
                <td colSpan={3} className="panel-conocimiento__celda-vacia">
                  <span className="panel-conocimiento__vacio-tabla">
                    Todavía no hay categorías de conocimiento. Crea la primera al subir un archivo
                    desde <strong>Archivos</strong>.
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 className="panel-conocimiento__seccion panel-conocimiento__seccion--roles">Permisos por rol</h3>
      {roles.length === 0 && <p className="panel-conocimiento__vacio">Todavía no hay roles registrados.</p>}
      {roles.map((rol) => {
        const esAdmin = rol.clave === 'administrador';
        const configuracion = borrador[rol.clave] || { categorias: [], modulos: { starlink: false } };
        return (
          <div key={rol.clave} className="panel-conocimiento__rol">
            <div className="panel-conocimiento__rol-cabecera">
              <div>
                <strong className="panel-conocimiento__rol-nombre">
                  <FiShield aria-hidden="true" /> {rol.rol}
                </strong>
                {esAdmin && (
                  <small className="panel-conocimiento__rol-detalle panel-conocimiento__rol-detalle--admin">
                    Acceso total a todas las categorías y a Starlink.
                  </small>
                )}
                {!esAdmin && !rol.configurado && (
                  <small className="panel-conocimiento__rol-detalle panel-conocimiento__rol-detalle--pendiente">
                    Sin configurar: solo podrá usar las categorías marcadas.
                  </small>
                )}
              </div>
              {!esAdmin && (
                <button
                  type="button"
                  className="profile-primary-button"
                  onClick={() => guardarRol(rol)}
                  disabled={guardandoRol === rol.clave || !hayCambios(rol)}
                >
                  <FiCheck /> {guardandoRol === rol.clave ? 'Guardando…' : 'Guardar'}
                </button>
              )}
            </div>

<div className="panel-conocimiento__opciones">
              {categorias.map((categoria) => {
                // El Administrador marca automáticamente solo lo que está
                // activo; una categoría inactiva no se puede marcar.
                // Las categorías del sistema no llegan hasta aquí: el backend
                // las excluye de este panel porque no son conocimiento que se
                // pueda repartir por rol.
                const marcada = esAdmin
                  ? categoria.activa
                  : configuracion.categorias.includes(categoria.id);
                return (
                  <label
                    key={categoria.id}
                    className={`panel-conocimiento__opcion ${categoria.activa ? '' : 'panel-conocimiento__opcion--inactiva'}`}
                  >
                    <input
                      type="checkbox"
                      checked={marcada}
                      disabled={esAdmin || !categoria.activa}
                      onChange={() => alternarCategoria(rol.clave, categoria.id)}
                    />
                    <span>{categoria.nombre}</span>
                    {!categoria.activa && (
                      <em className="panel-conocimiento__opcion-etiqueta-inactiva">inactiva</em>
                    )}
                  </label>
                );
              })}
            </div>

            {!esAdmin && (
              <label className="panel-conocimiento__modulo">
                <input type="checkbox" checked={configuracion.modulos.starlink === true} onChange={() => alternarStarlink(rol.clave)} />
                <span>Acceso al módulo Starlink</span>
              </label>
            )}
          </div>
        );
      })}

      {modalAbierto && editando && (
        <div className="modal-overlay modal-monitoreo-pozo-overlay" role="dialog" aria-modal="true" aria-label="Editar categoría" onClick={(event) => { if (event.target === event.currentTarget) cerrarModal(); }}>
          <div className="modal-monitoreo-pozo modal-monitoreo-pozo-catalog">
            <header className="modal-monitoreo-pozo-header">
              <div>
                <span className="dashboard-eyebrow">Conocimiento</span>
                <h2 style={{ margin: '4px 0 0', color: '#fff', fontSize: 20 }}>Editar categoría</h2>
              </div>
              <button type="button" className="modal-monitoreo-pozo-close" onClick={cerrarModal} aria-label="Cerrar">
                <FiX aria-hidden="true" />
              </button>
            </header>

            <div className="modal-monitoreo-pozo-body">
              <p className="modal-monitoreo-pozo-intro">
                Puedes corregir el nombre y la descripción. Los archivos de la categoría no se ven
                afectados por estos cambios.
              </p>
              <label className="modal-monitoreo-pozo-field">
                Nombre
                <input
                  className="modal-monitoreo-pozo-input"
                  value={formulario.nombre}
                  onChange={(event) => setFormulario((actual) => ({ ...actual, nombre: event.target.value }))}
                  onKeyDown={(event) => { if (event.key === 'Escape') cerrarModal(); }}
                  placeholder="Ej. Mantenimiento"
                />
              </label>
<label className="modal-monitoreo-pozo-field">
                Descripción (opcional)
                <input
                  className="modal-monitoreo-pozo-input"
                  value={formulario.descripcion}
                  onChange={(event) => setFormulario((actual) => ({ ...actual, descripcion: event.target.value }))}
                  onKeyDown={(event) => { if (event.key === 'Escape') cerrarModal(); }}
                  placeholder="Ej. Documentación de mantenimiento de equipos"
                />
              </label>

              {!formulario.nombre?.trim() && (
                <small className="modal-monitoreo-pozo-pista">Escribe un nombre para continuar.</small>
              )}

              <div className="modal-monitoreo-pozo-actions">
                <button type="button" className="btn-monitoreo-pozo-cancel" onClick={cerrarModal}>Cancelar</button>
                <button
                  type="button"
                  className="btn-monitoreo-pozo-primary"
                  disabled={guardandoEdicion || !formulario.nombre?.trim()}
                  onClick={guardarEdicion}
                >
                  {guardandoEdicion ? 'Guardando…' : 'Guardar cambios'}
                </button>
              </div>

              {/* La eliminación se separa de "Guardar cambios" a propósito: es la única
                  acción del panel que borra archivos de forma permanente, así que
                  pide una confirmación explícita antes de ejecutarse. */}
              <div className={`panel-conocimiento__peligro ${pendienteDeBorrar === formulario.id ? 'panel-conocimiento__peligro--confirmando' : ''}`}>
                {pendienteDeBorrar === formulario.id ? (
                  <>
                    <div className="panel-conocimiento__peligro-texto">
                      <strong>¿Eliminar “{formulario.nombre}”?</strong>
                      <small>
                        {totalDocumentos > 0
                          ? `Se borrarán ${totalDocumentos === 1 ? 'su archivo' : `sus ${totalDocumentos} archivos`} y la categoría de forma permanente.`
                          : 'La categoría está vacía y se eliminará de forma permanente.'}
                      </small>
                    </div>
                    <div className="panel-conocimiento__peligro-acciones">
                      <button type="button" className="btn-monitoreo-pozo-cancel" onClick={() => setPendienteDeBorrar(null)} disabled={borrandoCategoria}>
                        Cancelar
                      </button>
                      <button
                        type="button"
                        className="panel-conocimiento__peligro-boton panel-conocimiento__peligro-boton--solido"
                        disabled={borrandoCategoria}
                        onClick={() => confirmarBorrado(false)}
                      >
                        <FiTrash2 aria-hidden="true" />
                        {borrandoCategoria ? 'Eliminando…' : 'Sí, eliminar'}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="panel-conocimiento__peligro-texto">
                      <strong>Eliminar categoría</strong>
                      <small>
                        {totalDocumentos > 0
                          ? `Borras “${formulario.nombre}” junto con ${totalDocumentos === 1 ? 'su archivo' : `sus ${totalDocumentos} archivos`}.`
                          : `Borras “${formulario.nombre}”. No tiene archivos guardados.`}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="panel-conocimiento__peligro-boton"
                      disabled={borrandoCategoria}
                      onClick={() => setPendienteDeBorrar(formulario.id)}
                    >
                      <FiTrash2 aria-hidden="true" /> Eliminar
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}