import { useEffect, useState } from 'react';
import { FiEdit2, FiExternalLink, FiLink, FiMonitor, FiTrash2, FiX } from 'react-icons/fi';
import { apiFetch } from '../services/api';
import { useNotification } from '../context/NotificationContext';

function formatearFecha(valor) {
  if (!valor) return '';
  try {
    let fecha;
    if (typeof valor === 'string' || typeof valor === 'number') {
      fecha = new Date(valor);
    } else if (typeof valor?.toDate === 'function') {
      fecha = valor.toDate();
    } else {
      const segundos = valor?.seconds ?? valor?._seconds;
      fecha = typeof segundos === 'number' ? new Date(segundos * 1000) : new Date(valor);
    }
    const texto = fecha.toLocaleString('es-PE');
    return texto === 'Invalid Date' ? '' : texto;
  } catch {
    return '';
  }
}

export default function EclipseTouch({ token, usuario, onCerrar }) {
  const [enlaces, setEnlaces] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [nombrePozo, setNombrePozo] = useState('');
  const [lote, setLote] = useState('');
  const [link, setLink] = useState('');
  const [editandoId, setEditandoId] = useState(null);
  const { notificarExito, notificarError } = useNotification();
  const esAdministrador = usuario?.rol?.toLowerCase() === 'administrador';

  const cargarEnlaces = async () => {
    try {
      const respuesta = await apiFetch('/api/eclipse-touch', { headers: { Authorization: `Bearer ${token}` } });
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudieron cargar los enlaces.');
      setEnlaces(data.enlaces || []);
    } catch (error) {
      notificarError(error.message, { titulo: 'No se pudieron cargar los enlaces' });
    }
  };

  useEffect(() => {
    cargarEnlaces();
    const manejarTecla = (evento) => {
      if (evento.key === 'Escape') onCerrar();
    };
    document.addEventListener('keydown', manejarTecla);
    return () => document.removeEventListener('keydown', manejarTecla);
  }, []);

  const abrirEnlace = (item) => {
    const ventana = window.open(item.link, '_blank');
    if (!ventana) {
      notificarError('El navegador bloqueó la ventana. Permite ventanas emergentes e inténtalo de nuevo.', { titulo: 'Apertura bloqueada' });
      return;
    }
    ventanasAbiertas.current.push(ventana);
    notificarExito('Abriendo el enlace del pozo…', { titulo: 'Eclipse Touch' });
  };

  const guardar = async (event) => {
    event.preventDefault();
    if (!nombrePozo.trim() || !lote.trim() || !link.trim()) {
      return notificarError('Completa el nombre del pozo, el lote y el enlace.', { titulo: 'Campos incompletos' });
    }
    setCargando(true);
    try {
      const esEdicion = Boolean(editandoId);
      const respuesta = await apiFetch(esEdicion ? `/api/eclipse-touch/${editandoId}` : '/api/eclipse-touch', {
        method: esEdicion ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ nombrePozo: nombrePozo.trim(), lote: lote.trim(), link: link.trim() }),
      });
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo guardar el enlace.');
      notificarExito(esEdicion ? 'Enlace actualizado correctamente.' : 'Enlace publicado correctamente.', { titulo: 'Eclipse Touch' });
      setEditandoId(null); setNombrePozo(''); setLote(''); setLink('');
      await cargarEnlaces();
    } catch (error) {
      notificarError(error.message, { titulo: 'No se pudo guardar' });
    } finally {
      setCargando(false);
    }
  };

  const empezarEdicion = (item) => {
    setEditandoId(item.id);
    setNombrePozo(item.nombrePozo || '');
    setLote(item.lote || '');
    setLink(item.link || '');
  };

  const cancelarEdicion = () => {
    setEditandoId(null);
    setNombrePozo(''); setLote(''); setLink('');
  };

  const eliminar = async (item) => {
    if (!window.confirm(`¿Eliminar el enlace del pozo "${item.nombrePozo}"?`)) return;
    try {
      const respuesta = await apiFetch(`/api/eclipse-touch/${item.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo eliminar el enlace.');
      setEnlaces((actual) => actual.filter((enlace) => enlace.id !== item.id));
      notificarExito(data.mensaje, { titulo: 'Enlace eliminado' });
    } catch (error) {
      notificarError(error.message, { titulo: 'No se pudo eliminar' });
    }
  };

  return (
    <div className="modal-overlay eclipse-modal-overlay" role="dialog" aria-modal="true" aria-label="Eclipse Touch" onClick={(event) => { if (event.target === event.currentTarget) onCerrar(); }}>
      <div className="eclipse-modal">
        <header className="eclipse-modal-header">
          <div>
            <span className="dashboard-eyebrow">Monitoreo de pozos</span>
            <h2>Eclipse Touch</h2>
          </div>
          <button type="button" className="eclipse-modal-close" onClick={onCerrar} aria-label="Cerrar Eclipse Touch"><FiX aria-hidden="true" /></button>
        </header>

        <div className="eclipse-modal-body">
          <p className="eclipse-intro">Cualquier usuario activo puede publicar un enlace de Eclipse Touch indicando el nombre del pozo y su lote. Haz clic sobre un pozo para abrir su enlace directamente y administra el que compartiste.</p>

          <form className="compact-upload-form" onSubmit={guardar}>
            <label>Nombre del pozo
              <input value={nombrePozo} onChange={(event) => setNombrePozo(event.target.value)} disabled={cargando} placeholder="Ej. Pozo Norte 12" />
            </label>
            <label>Lote
              <input value={lote} onChange={(event) => setLote(event.target.value)} disabled={cargando} placeholder="Ej. Lote X" />
            </label>
            <label>Enlace <small>(URL)</small>
              <input value={link} onChange={(event) => setLink(event.target.value)} disabled={cargando} placeholder="https://..." />
            </label>
            <button className="profile-primary-button" type="submit" disabled={cargando}><FiLink aria-hidden="true" /> {cargando ? 'Guardando…' : (editandoId ? 'Guardar cambios' : 'Publicar enlace')}</button>
          </form>
          {editandoId && (
            <button type="button" className="profile-secondary-button" style={{ marginTop: 10 }} onClick={cancelarEdicion} disabled={cargando}>Cancelar edición</button>
          )}

          <div className="eclipse-list">
            {enlaces.length === 0 ? (
              <p>No hay enlaces de Eclipse Touch publicados todavía.</p>
            ) : enlaces.map((item) => {
              const puedeAdministrar = esAdministrador || item.propietarioUid === usuario?.uid;
              return (
                <article key={item.id} className="eclipse-card">
                  <div style={{ minWidth: 0 }}>
                    <h3><FiMonitor aria-hidden="true" /> {item.nombrePozo}</h3>
                    <small>Lote {item.lote} · Publicado por {item.propietarioNombre || item.propietarioEmail || 'Usuario'} · {formatearFecha(item.fechaCreacion)}</small>
                    <div>
                      <button type="button" className="eclipse-card-link" onClick={() => abrirEnlace(item)} title="Abrir enlace del pozo">
                        {item.link} <FiExternalLink aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  <div className="eclipse-card-actions">
                    <button type="button" className="profile-primary-button" style={{ minHeight: 34, padding: '6px 12px' }} onClick={() => abrirEnlace(item)}><FiExternalLink aria-hidden="true" /> Abrir</button>
                    {puedeAdministrar && (
                      <>
                        <button type="button" className="billing-edit-button" onClick={() => empezarEdicion(item)}><FiEdit2 aria-hidden="true" /> Editar</button>
                        <button type="button" className="billing-cancel" onClick={() => eliminar(item)}><FiTrash2 aria-hidden="true" /></button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}