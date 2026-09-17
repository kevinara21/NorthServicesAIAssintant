import { useEffect, useRef, useState } from 'react';
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

export default function MonitoreoPozos({ token, usuario, onCerrar }) {
  const [enlaces, setEnlaces] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [nombrePozo, setNombrePozo] = useState('');
  const [lote, setLote] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [link, setLink] = useState('');
  const [editandoId, setEditandoId] = useState(null);
  const [confirmacion, setConfirmacion] = useState({ visible: false, item: null });
  const ventanasAbiertas = useRef([]);
  const { notificarExito, notificarError } = useNotification();
  const esAdministrador = usuario?.rol?.toLowerCase() === 'administrador';

  const cargarEnlaces = async () => {
    try {
      const respuesta = await apiFetch('/api/monitoreo', { headers: { Authorization: `Bearer ${token}` } });
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

  useEffect(() => {
    const ventanas = ventanasAbiertas.current;
    return () => ventanas.forEach((ventana) => ventana.close());
  }, []);

  const abrirEnlace = (item) => {
    const ventana = window.open(item.link, '_blank');
    if (!ventana) {
      notificarError('El navegador bloqueó la ventana. Permite ventanas emergentes e inténtalo de nuevo.', { titulo: 'Apertura bloqueada' });
      return;
    }
    ventanasAbiertas.current.push(ventana);
    notificarExito('Abriendo el enlace del pozo…', { titulo: 'Monitoreo remoto' });
  };

  const guardar = async (event) => {
    event.preventDefault();
    if (!nombrePozo.trim() || !lote.trim() || !link.trim()) {
      return notificarError('Completa el nombre del pozo, el lote y el enlace.', { titulo: 'Campos incompletos' });
    }
    setCargando(true);
    try {
      const esEdicion = Boolean(editandoId);
      const respuesta = await apiFetch(esEdicion ? `/api/monitoreo/${editandoId}` : '/api/monitoreo', {
        method: esEdicion ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ nombrePozo: nombrePozo.trim(), lote: lote.trim(), descripcion: descripcion.trim(), link: link.trim() }),
      });
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo guardar el enlace.');
      notificarExito(esEdicion ? 'Transmisión actualizada correctamente.' : 'Transmisión publicada correctamente.', { titulo: 'Monitoreo remoto' });
      setEditandoId(null); setNombrePozo(''); setLote(''); setDescripcion(''); setLink('');
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
    setDescripcion(item.descripcion || '');
    setLink(item.link || '');
  };

  const cancelarEdicion = () => {
    setEditandoId(null);
    setNombrePozo(''); setLote(''); setDescripcion(''); setLink('');
  };

  const eliminar = async (item) => {
    setConfirmacion({ visible: true, item });
  };

  const confirmarEliminar = async () => {
    const item = confirmacion.item;
    setConfirmacion({ visible: false, item: null });
    if (!item) return;
    try {
      const respuesta = await apiFetch(`/api/monitoreo/${item.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo eliminar el enlace.');
      setEnlaces((actual) => actual.filter((enlace) => enlace.id !== item.id));
      notificarExito(data.mensaje, { titulo: 'Enlace eliminado' });
    } catch (error) {
      notificarError(error.message, { titulo: 'No se pudo eliminar' });
    }
  };

  return (
    <div className="modal-overlay eclipse-modal-overlay" role="dialog" aria-modal="true" aria-label="Monitoreo remoto de pozos" onClick={(event) => { if (event.target === event.currentTarget) onCerrar(); }}>
      <div className="eclipse-modal">
        <header className="eclipse-modal-header">
          <div>
            <span className="dashboard-eyebrow">Monitoreo remoto en vivo</span>
          </div>
          <button type="button" className="eclipse-modal-close" onClick={onCerrar} aria-label="Cerrar Monitoreo de pozos"><FiX aria-hidden="true" /></button>
        </header>

        <div className="eclipse-modal-body">
          <p className="eclipse-intro">Cualquier usuario activo puede publicar una transmisión indicando pozo, lote y el enlace de monitoreo. En la descripción señala qué transmisión es (por ejemplo, Sureshot o Eclipse Touch). Haz clic sobre un pozo para abrir su enlace y administra el que compartiste.</p>

          <form className="compact-upload-form" onSubmit={guardar}>
            <label>Pozo
              <input value={nombrePozo} onChange={(event) => setNombrePozo(event.target.value)} disabled={cargando} placeholder="Ej. GAV-1XD" />
            </label>
            <label>Lote
              <input value={lote} onChange={(event) => setLote(event.target.value)} disabled={cargando} placeholder="Ej. Lote VII" />
            </label>
            <label>Descripción
              <input value={descripcion} onChange={(event) => setDescripcion(event.target.value)} disabled={cargando} placeholder="Ej. Transmisión Sureshot" />
            </label>
            <label>Enlace
              <input value={link} onChange={(event) => setLink(event.target.value)} disabled={cargando} placeholder="https://..." />
            </label>
            <button className="profile-primary-button" type="submit" disabled={cargando}><FiLink aria-hidden="true" /> {cargando ? 'Guardando…' : (editandoId ? 'Guardar cambios' : 'Publicar enlace')}</button>
          </form>
          {editandoId && (
            <button type="button" className="profile-secondary-button" style={{ marginTop: 10 }} onClick={cancelarEdicion} disabled={cargando}>Cancelar edición</button>
          )}

          <div className="eclipse-list">
            {enlaces.length === 0 ? (
              <p>No hay transmisiones publicadas todavía.</p>
            ) : enlaces.map((item) => {
              const puedeAdministrar = esAdministrador || item.propietarioUid === usuario?.uid;
              return (
                <article key={item.id} className="eclipse-card">
                  <div style={{ minWidth: 0 }}>
                    <h3><FiMonitor aria-hidden="true" /> {item.nombrePozo}</h3>
                    <small>Lote {item.lote} · Publicado por {item.propietarioNombre || item.propietarioEmail || 'Usuario'} · {formatearFecha(item.fechaCreacion)}</small>
                    {item.descripcion && <div style={{ marginTop: 6, fontSize: 12, fontWeight: 600, color: '#0f172a' }}>{item.descripcion}</div>}
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

      {confirmacion.visible && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }} onClick={() => setConfirmacion({ visible: false, item: null })}>
          <div style={{ background: '#fff', borderRadius: 12, padding: '28px 32px', maxWidth: 420, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', border: '1px solid #e2e8f0' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', marginBottom: 8 }}>¿Eliminar la transmisión del pozo "{confirmacion.item?.nombrePozo}"?</div>
            <p style={{ color: '#64748b', fontSize: 14, lineHeight: 1.6, margin: 0, marginBottom: 24 }}>El enlace ya no estará disponible para los demás usuarios.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setConfirmacion({ visible: false, item: null })} style={{ padding: '8px 18px', border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', color: '#374151', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Cancelar</button>
              <button type="button" onClick={confirmarEliminar} style={{ padding: '8px 18px', border: 'none', borderRadius: 6, background: '#DC2626', color: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>Eliminar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}