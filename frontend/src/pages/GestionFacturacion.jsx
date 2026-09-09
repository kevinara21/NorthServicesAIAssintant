import { useEffect, useState } from 'react';
import { FiEdit2, FiPlus, FiSave } from 'react-icons/fi';
import { apiFetch } from '../services/api';

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
  const [mensaje, setMensaje] = useState(null);

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
      setMensaje({ tipo: 'error', texto: error.message });
    } finally { setCargando(false); }
  };

  useEffect(() => { cargarPozos(); }, []);

  const cambiarCampo = (campo, valor) => {
    setFormulario((actual) => ({
      ...actual,
      [campo]: valor,
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
    });
    setMensaje(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelarEdicion = () => { setEditando(null); setFormulario(crearPozoVacio()); };

  const guardarPozo = async (event) => {
    event.preventDefault();
    setGuardando(true);
    setMensaje(null);
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
      setMensaje({ tipo: 'exito', texto: editando ? 'Información actualizada en Firebase.' : 'Pozo agregado a Firebase.' });
      cancelarEdicion();
      await cargarPozos();
    } catch (error) {
      setMensaje({ tipo: 'error', texto: error.message });
    } finally { setGuardando(false); }
  };

  if (cargando) return <p className="billing-loading">Cargando pozos y facturación...</p>;

  return (
    <section className="billing-page">
      <div className="billing-heading">
        <span className="dashboard-eyebrow">Administración</span>
        <h1>Pago de Starlink</h1>
        <p>Consulta y actualiza el estado de pago. El pago se calcula automáticamente un día antes del inicio del periodo.</p>
      </div>

      {mensaje && <div className={`profile-message ${mensaje.tipo}`}>{mensaje.texto}</div>}

      <form className="billing-form" onSubmit={guardarPozo}>
        <div className="billing-form-header"><h3>{editando ? 'Editar registro Starlink' : 'Agregar Starlink'}</h3>{editando && <button className="billing-cancel" type="button" onClick={cancelarEdicion}>Cancelar</button>}</div>
        <div className="billing-form-grid">
          <label>Ubicación<input value={formulario.nombrePozo} onChange={(event) => cambiarCampo('nombrePozo', event.target.value)} required /></label>
          <label>Correo<input type="email" value={formulario.correo} onChange={(event) => cambiarCampo('correo', event.target.value)} /></label>
          <label>Código KIT<input value={formulario.codigoKit} readOnly={Boolean(editando)} onChange={(event) => cambiarCampo('codigoKit', event.target.value)} /></label>
          <label>N° Serie Antena<input value={formulario.serieAntena || formulario.codigo4Pba || ''} readOnly={Boolean(editando)} onChange={(event) => cambiarCampo('serieAntena', event.target.value)} /></label>
          <label>Inicio del periodo<input type="date" value={formulario.fechaInicioPeriodo} onChange={(event) => cambiarCampo('fechaInicioPeriodo', event.target.value)} required /></label>
          <label>Día de pago<input type="number" value={formulario.diaPago} readOnly /></label>
          <label className="billing-status-field">Estado de pago<select value={formulario.estadoPago} onChange={(event) => cambiarCampo('estadoPago', event.target.value)}><option value="no_pagado">No pagado</option><option value="pagado">Pagado</option></select></label>
          <div className="billing-form-actions"><button className="profile-primary-button" type="submit" disabled={guardando}>{editando ? <><FiSave /> Guardar cambios</> : <><FiPlus /> Agregar pozo</>}</button></div>
        </div>
        <p className="billing-immutable-period">El pago vence un día antes del inicio. Para inicios los días 29, 30 o 31, Starlink ajusta el cobro al día 28.</p>
      </form>

      <div className="billing-table-wrap">
        <table className="billing-table"><thead><tr><th>Ubicación</th><th>Correo</th><th>Identificadores</th><th>Periodo</th><th>Pago</th><th>Acción</th></tr></thead><tbody>
          {pozos.length === 0 ? <tr><td colSpan="6" className="billing-empty">No hay pozos registrados.</td></tr> : pozos.map((pozo) => (
            <tr key={pozo.id}>
              <td data-label="Ubicación"><strong>{pozo.nombrePozo}</strong></td>
              <td data-label="Correo">{pozo.correo || 'Sin correo'}</td>
              <td data-label="Identificadores"><small>KIT S/N: {pozo.codigoKit || '-'}<br />Serie antena: {pozo.serieAntena || pozo.codigo4Pba || '-'}</small></td>
              <td data-label="Periodo">Día {pozo.diaInicioPeriodo || pozo.periodoInicio || '-'} de cada mes</td>
              <td data-label="Pago"><span className={`billing-status ${pozo.estadoPago}`}>{pozo.estadoPago === 'pagado' ? 'Pagado' : 'No pagado'}</span><small>Vence día {pozo.diaPago || pozo.fechaPago || '-'}</small>{pozo.fechaUltimoPago && <small>Último pago: {pozo.fechaUltimoPago}</small>}</td>
              <td data-label="Acción"><button className="billing-edit-button" type="button" onClick={() => editarPozo(pozo)}><FiEdit2 /> Editar</button></td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </section>
  );
}
