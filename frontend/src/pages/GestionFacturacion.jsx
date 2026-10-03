import { useEffect, useState } from 'react';
import { FiEdit2, FiEye, FiEyeOff, FiPlus, FiRefreshCw, FiSave, FiX, FiCheckCircle, FiXCircle } from 'react-icons/fi';
import { apiFetch } from '../services/api';
import { useNotification } from '../context/NotificationContext';
import OilLoader from '../components/common/OilLoader';

function obtenerFechaActual() {
  const hoy = new Date();
  const mes = String(hoy.getMonth() + 1).padStart(2, '0');
  const dia = String(hoy.getDate()).padStart(2, '0');
  return `${hoy.getFullYear()}-${mes}-${dia}`;
}

function calcularDiaPago(diaInicio) {
  const dia = Number(diaInicio);
  if (dia >= 29 && dia <= 31) return 28;
  return dia >= 1 && dia <= 31 ? (dia === 1 ? 31 : dia - 1) : '';
}

function crearPozoVacio() {
  const diaActual = new Date().getDate();
  return {
    nombrePozo: '', correo: '', codigoKit: '', serieAntena: '',
    fechaInicioPeriodo: obtenerFechaActual(),
    diaInicioPeriodo: diaActual,
    diaPago: calcularDiaPago(diaActual),
    estadoPago: 'no_pagado',
    monto: 0,
    contrasena: '',
    estadoActivo: true,
    comentario: '',
  };
}

function fechaParaDia(dia) {
  const numero = Number(dia);
  if (!numero) return '';
  const hoy = new Date();
  const mes = String(hoy.getMonth() + 1).padStart(2, '0');
  const diaFormateado = String(numero).padStart(2, '0');
  return `${hoy.getFullYear()}-${mes}-${diaFormateado}`;
}

export default function GestionFacturacion({ token }) {
  const [pozos, setPozos] = useState([]);
  const [formulario, setFormulario] = useState(crearPozoVacio);
  const [editando, setEditando] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [modalAbierto, setModalAbierto] = useState(false);
  const [modalDetallesAbierto, setModalDetallesAbierto] = useState(false);
  const [pozoSeleccionado, setPozoSeleccionado] = useState(null);
  const [mostrarContrasena, setMostrarContrasena] = useState(false);
  const { notificarError, notificarExito } = useNotification();

  const cargarPozos = async () => {
    try {
      const respuesta = await apiFetch('/api/admin/starlink', { headers: { Authorization: `Bearer ${token}` } });
      const texto = await respuesta.text();
      let data;
      try {
        data = JSON.parse(texto);
      } catch {
        throw new Error('El backend no respondió la API de Starlink. Reinicia el servidor backend en el puerto 8000.');
      }
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo cargar la información.');
      setPozos((data.pozos || []).sort((a, b) => {
        if (!a.diaPago) return 1;
        if (!b.diaPago) return -1;
        return Number(a.diaPago) - Number(b.diaPago);
      }));
    } catch (error) {
      notificarError(error.message, { titulo: 'No se pudo cargar Starlink' });
    } finally { setCargando(false); }
  };

  useEffect(() => { cargarPozos(); }, []);

  const cambiarCampo = (campo, valor) => {
    setFormulario((actual) => ({
      ...actual,
      [campo]: campo === 'estadoActivo' ? valor === 'true' : valor, // Convertir string a boolean
      ...(campo === 'fechaInicioPeriodo'
        ? {
          diaInicioPeriodo: valor ? Number(valor.slice(-2)) : '',
          diaPago: valor ? calcularDiaPago(Number(valor.slice(-2))) : '',
        }
        : {}),
    }));
  };

  const editarPozo = (pozo) => {
    setEditando(pozo.id);
    setFormulario({
      ...crearPozoVacio(),
      ...pozo,
      fechaInicioPeriodo: pozo.fechaInicioPeriodo || fechaParaDia(pozo.diaInicioPeriodo),
      diaPago: calcularDiaPago(pozo.diaInicioPeriodo),
      estadoActivo: pozo.estadoActivo !== false, // Asegurar que sea booleano
    });
    setMostrarContrasena(false); // Resetear visibilidad de contraseña
    setModalAbierto(true);
  };

  const cancelarEdicion = () => { 
    setEditando(null); 
    setFormulario(crearPozoVacio()); 
    setModalAbierto(false);
  };

  const abrirModalNuevo = () => {
    setEditando(null);
    setFormulario(crearPozoVacio());
    setModalAbierto(true);
  };

  const sincronizarConMongoDB = async () => {
    try {
      const respuesta = await apiFetch('/api/admin/starlink/sync-mongodb', { 
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` } 
      });
      const data = await respuesta.json();
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo sincronizar con MongoDB.');
      
      notificarExito(data.mensaje, { titulo: 'Sincronización completada' });
    } catch (error) {
      notificarError(error.message, { titulo: 'Error al sincronizar' });
    }
  };

  const verDetalles = (pozo) => {
    setPozoSeleccionado(pozo);
    setModalDetallesAbierto(true);
  };

  const guardarPozo = async (event) => {
    event.preventDefault();
    setGuardando(true);
    const ruta = editando ? `/api/admin/starlink/${editando}` : '/api/admin/starlink';
    try {
      const respuesta = await apiFetch(ruta, {
        method: editando ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(formulario),
      });
      const texto = await respuesta.text();
      let data;
      try {
        data = JSON.parse(texto);
      } catch {
        throw new Error('El backend no respondió correctamente. Reinicia el servidor backend.');
      }
      if (!respuesta.ok) throw new Error(data.error || 'No se pudo guardar el pozo.');
      notificarExito(editando ? 'Información actualizada en Firebase.' : 'Pozo agregado a Firebase.', {
        titulo: editando ? 'Registro actualizado' : 'Pozo agregado',
      });
      setModalAbierto(false);
      cancelarEdicion();
      await cargarPozos();
    } catch (error) {
      notificarError(error.message, { titulo: 'No se pudo guardar el registro' });
    } finally { setGuardando(false); }
  };

  if (cargando) return <OilLoader label="Cargando facturación de Starlink" inline />;

  return (
    <section className="billing-page">
      <div className="billing-heading">
        <span className="dashboard-eyebrow">Administración</span>
        <h1>Pagos de Starlink</h1>
        <p>Consulta y actualiza el estado de pago, manteniendo la información actualizada y disponible para el asistente.</p>
        <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
          <button 
            className="profile-primary-button" 
            onClick={abrirModalNuevo}
          >
            <FiPlus /> Agregar Starlink
          </button>
          <button 
            className="profile-secondary-button" 
            onClick={sincronizarConMongoDB}
          >
            <FiRefreshCw /> Actualizar
          </button>
        </div>
      </div>

      {modalAbierto && (
        <div className="modal-overlay modal-monitoreo-pozo-overlay" role="dialog" aria-modal="true" aria-label="Gestión de Starlink" onClick={(event) => { if (event.target === event.currentTarget) setModalAbierto(false); }}>
          <div className="modal-monitoreo-pozo">
            <header className="modal-monitoreo-pozo-header">
              <div>
                <span className="dashboard-eyebrow">Gestión de Starlink</span>
                <h2 style={{ margin: '4px 0 0', color: '#fff', fontSize: 20 }}>{editando ? 'Editar registro' : 'Agregar Starlink'}</h2>
              </div>
              <button type="button" className="modal-monitoreo-pozo-close" onClick={() => setModalAbierto(false)} aria-label="Cerrar modal"><FiX aria-hidden="true" /></button>
            </header>

            <div className="modal-monitoreo-pozo-body">
              <p className="modal-monitoreo-pozo-intro">Gestiona la información de los equipos Starlink. El pago se calcula automáticamente un día antes del inicio del periodo. Para inicios los días 29, 30 o 31, Starlink ajusta el cobro al día 28.</p>

              <form className="starlink-form" onSubmit={guardarPozo}>
                <div className="starlink-form-section">
                  <h4 className="starlink-section-title">Información del Equipo</h4>
                  <div className="starlink-form-grid">
                    <div className="starlink-form-group">
                      <label>Ubicación</label>
                      <input 
                        type="text" 
                        value={formulario.nombrePozo} 
                        onChange={(event) => cambiarCampo('nombrePozo', event.target.value)} 
                        required 
                        placeholder="Ej. Pozo GAV-1XD"
                        className="starlink-input"
                      />
                    </div>
                    <div className="starlink-form-group">
                      <label>Correo</label>
                      <input 
                        type="email" 
                        value={formulario.correo} 
                        onChange={(event) => cambiarCampo('correo', event.target.value)} 
                        placeholder="correo@ejemplo.com"
                        className="starlink-input"
                      />
                    </div>
                  </div>
                </div>

                <div className="starlink-form-section">
                  <h4 className="starlink-section-title">Identificadores</h4>
                  <div className="starlink-form-grid">
                    <div className="starlink-form-group">
                      <label>Código KIT</label>
                      <input 
                        type="text" 
                        value={formulario.codigoKit} 
                        readOnly={Boolean(editando)} 
                        onChange={(event) => cambiarCampo('codigoKit', event.target.value)} 
                        placeholder="Ej. KIT-12345"
                        className={`starlink-input ${editando ? 'starlink-input-readonly' : ''}`}
                      />
                    </div>
                    <div className="starlink-form-group">
                      <label>N° Serie Antena</label>
                      <input 
                        type="text" 
                        value={formulario.serieAntena || formulario.codigo4Pba || ''} 
                        readOnly={Boolean(editando)} 
                        onChange={(event) => cambiarCampo('serieAntena', event.target.value)} 
                        placeholder="Ej. SN-67890"
                        className={`starlink-input ${editando ? 'starlink-input-readonly' : ''}`}
                      />
                    </div>
                  </div>
                </div>

                <div className="starlink-form-section">
                  <h4 className="starlink-section-title">Facturación</h4>
                  <div className="starlink-form-grid">
                    <div className="starlink-form-group">
                      <label>Inicio del periodo</label>
                      <input 
                        type="date" 
                        value={formulario.fechaInicioPeriodo} 
                        onChange={(event) => cambiarCampo('fechaInicioPeriodo', event.target.value)} 
                        required 
                        className="starlink-input"
                      />
                    </div>
                    <div className="starlink-form-group">
                      <label>Día de pago</label>
                      <input 
                        type="number" 
                        value={formulario.diaPago} 
                        readOnly 
                        className="starlink-input starlink-input-readonly"
                      />
                    </div>
                    <div className="starlink-form-group">
                      <label>Estado de pago</label>
                      <select 
                        value={formulario.estadoPago} 
                        onChange={(event) => cambiarCampo('estadoPago', event.target.value)}
                        className="starlink-select"
                      >
                        <option value="no_pagado">No pagado</option>
                        <option value="pagado">Pagado</option>
                      </select>
                    </div>
                    <div className="starlink-form-group">
                      <label>Monto (S/)</label>
                      <input 
                        type="number" 
                        step="0.01" 
                        min="0" 
                        value={formulario.monto || ''} 
                        onChange={(event) => cambiarCampo('monto', event.target.value)} 
                        placeholder="0.00"
                        className="starlink-input"
                      />
                    </div>
                  </div>
                </div>

                <div className="starlink-form-section">
                  <h4 className="starlink-section-title">Acceso</h4>
                  <div className="starlink-form-grid starlink-form-grid-2">
                    <div className="starlink-form-group">
                      <label>Contraseña</label>
                      <div className="starlink-password-wrapper">
                        <input 
                          type={mostrarContrasena ? 'text' : 'password'} 
                          value={formulario.contrasena || ''} 
                          onChange={(event) => cambiarCampo('contrasena', event.target.value)}
                          placeholder="•••••••••"
                          className="starlink-input starlink-password-input"
                        />
                        <button 
                          type="button" 
                          className="starlink-password-toggle"
                          onClick={() => setMostrarContrasena(!mostrarContrasena)}
                          title={mostrarContrasena ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                        >
                          {mostrarContrasena ? <FiEyeOff /> : <FiEye />}
                        </button>
                      </div>
                    </div>
                    <div className="starlink-form-group">
                      <label>Estado Activo</label>
                      <select 
                        value={formulario.estadoActivo ? 'true' : 'false'} 
                        onChange={(event) => cambiarCampo('estadoActivo', event.target.value === 'true')}
                        className="starlink-select"
                      >
                        <option value="true">Activo</option>
                        <option value="false">Inactivo</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="starlink-form-section">
                  <h4 className="starlink-section-title">Notas</h4>
                  <div className="starlink-form-grid">
                    <div className="starlink-form-group starlink-form-group-full">
                      <label>Comentario</label>
                      <textarea 
                        value={formulario.comentario || ''} 
                        onChange={(event) => cambiarCampo('comentario', event.target.value)}
                        placeholder="Defectos, piezas faltantes, mantenimiento requerido, etc."
                        className="starlink-textarea"
                        rows={3}
                      />
                    </div>
                  </div>
                </div>

                <div className="starlink-form-actions">
                  <button className="starlink-submit-button" type="submit" disabled={guardando}>
                    {guardando ? (
                      <>
                        <FiRefreshCw className="starlink-spin" /> Procesando...
                      </>
                    ) : editando ? (
                      <>
                        <FiSave /> Guardar cambios
                      </>
                    ) : (
                      <>
                        <FiPlus /> Agregar Starlink
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      <div className="billing-table-wrap">
        <table className="billing-table"><thead><tr><th>Ubicación</th><th>Correo</th><th>Periodo</th><th>Pago</th><th>Estado</th></tr></thead><tbody>
          {pozos.length === 0 ? <tr><td colSpan="5" className="billing-empty">No hay pozos registrados.</td></tr> : pozos.map((pozo) => {
            // Un monto en cero no es un dato faltante: se muestra siempre para
            // que todas las filas muestren la misma información.
            const monto = Number(pozo.monto || 0);
            const sinMonto = monto <= 0;

            return (
            <tr
              key={pozo.id}
              className="billing-row-clickable"
              onClick={() => verDetalles(pozo)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  verDetalles(pozo);
                }
              }}
              role="button"
              tabIndex={0}
              title="Ver detalles del equipo"
            >
              <td data-label="Ubicación"><div className="billing-celda"><strong>{pozo.nombrePozo}</strong></div></td>
              <td data-label="Correo"><div className="billing-celda">{pozo.correo || 'Sin correo'}</div></td>
              <td data-label="Periodo">
                <div className="billing-celda">
                  <span>Vence el día {pozo.diaPago || '-'}</span>
                  <small>Nuevo ciclo desde el día {pozo.diaInicioPeriodo || pozo.periodoInicio || '-'}</small>
                </div>
              </td>
              <td data-label="Pago">
                <div className="billing-celda">
                  <span className={`billing-status ${pozo.estadoPago}`}>{pozo.estadoPago === 'pagado' ? 'Pagado' : 'No pagado'}</span>
                  <small className={sinMonto ? 'billing-monto-cero' : undefined}>Monto: S/ {monto.toFixed(2)}</small>
                  {pozo.fechaUltimoPago && <small>Último pago: {pozo.fechaUltimoPago}</small>}
                </div>
              </td>
              <td data-label="Estado">
                <div className="billing-celda">
                  <span className={pozo.estadoActivo ? 'billing-servicio billing-servicio--activo' : 'billing-servicio billing-servicio--inactivo'}>
                    {pozo.estadoActivo ? <FiCheckCircle aria-hidden="true" /> : <FiXCircle aria-hidden="true" />}
                    {pozo.estadoActivo ? 'Activo' : 'Inactivo'}
                  </span>
                </div>
              </td>
            </tr>
            );
          })}
        </tbody></table>
      </div>

      {modalDetallesAbierto && pozoSeleccionado && (
        <div className="modal-overlay modal-monitoreo-pozo-overlay" role="dialog" aria-modal="true" aria-label="Detalles de Starlink" onClick={(event) => { if (event.target === event.currentTarget) setModalDetallesAbierto(false); }}>
          <div className="modal-monitoreo-pozo">
            <header className="modal-monitoreo-pozo-header">
              <div>
                <span className="dashboard-eyebrow">Detalles de Starlink</span>
                <h2 style={{ margin: '4px 0 0', color: '#fff', fontSize: 20 }}>{pozoSeleccionado.nombrePozo}</h2>
              </div>
              <button type="button" className="modal-monitoreo-pozo-close" onClick={() => setModalDetallesAbierto(false)} aria-label="Cerrar modal"><FiX aria-hidden="true" /></button>
            </header>

            <div className="modal-monitoreo-pozo-body">
              <div className="starlink-details-grid">
                <div className="starlink-detail-item">
                  <span className="starlink-detail-label">Código KIT</span>
                  <span className="starlink-detail-value">{pozoSeleccionado.codigoKit || '-'}</span>
                </div>
                <div className="starlink-detail-item">
                  <span className="starlink-detail-label">Serie Antena</span>
                  <span className="starlink-detail-value">{pozoSeleccionado.serieAntena || pozoSeleccionado.codigo4Pba || '-'}</span>
                </div>
                <div className="starlink-detail-item">
                  <span className="starlink-detail-label">Correo</span>
                  <span className="starlink-detail-value">{pozoSeleccionado.correo || '-'}</span>
                </div>
                <div className="starlink-detail-item">
                  <span className="starlink-detail-label">Día de pago</span>
                  <span className="starlink-detail-value">{pozoSeleccionado.diaPago || '-'}</span>
                </div>
                <div className="starlink-detail-item">
                  <span className="starlink-detail-label">Estado de pago</span>
                  <span className="starlink-detail-value">{pozoSeleccionado.estadoPago === 'pagado' ? 'Pagado' : 'No pagado'}</span>
                </div>
                <div className="starlink-detail-item">
                  <span className="starlink-detail-label">Monto</span>
                  <span className="starlink-detail-value">S/ {Number(pozoSeleccionado.monto || 0).toFixed(2)}</span>
                </div>
                <div className="starlink-detail-item">
                  <span className="starlink-detail-label">Estado del servicio</span>
                  <span className="starlink-detail-value">{pozoSeleccionado.estadoActivo ? 'Activo' : 'Inactivo'}</span>
                </div>
                <div className="starlink-detail-item">
                  <span className="starlink-detail-label">Inicio periodo</span>
                  <span className="starlink-detail-value">{pozoSeleccionado.fechaInicioPeriodo || '-'}</span>
                </div>
                <div className="starlink-detail-item starlink-detail-item-full">
                  <span className="starlink-detail-label">Comentario</span>
                  <span className="starlink-detail-value">{pozoSeleccionado.comentario || 'Sin comentarios'}</span>
                </div>
              </div>
              
              <div className="starlink-details-actions">
                <button 
                  className="starlink-submit-button" 
                  type="button" 
                  onClick={() => {
                    setModalDetallesAbierto(false);
                    editarPozo(pozoSeleccionado);
                  }}
                >
                  <FiEdit2 /> Editar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
