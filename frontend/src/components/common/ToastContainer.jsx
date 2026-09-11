import React, { useEffect, useState, useRef } from 'react';
import {
  FiCheckCircle,
  FiAlertCircle,
  FiAlertTriangle,
  FiInfo,
  FiX,
} from 'react-icons/fi';

function ToastItem({ notificacion, onCerrar }) {
  const { id, mensaje, titulo, tipo, duracion } = notificacion;
  const [saliendo, setSaliendo] = useState(false);
  const [pausado, setPausado] = useState(false);
  const [tiempoRestante, setTiempoRestante] = useState(duracion);
  const inicioRef = useRef(Date.now());
  const timerRef = useRef(null);

  const iniciarCierre = () => {
    setSaliendo(true);
    setTimeout(() => {
      onCerrar(id);
    }, 280); // Duración de animación de salida
  };

  useEffect(() => {
    if (duracion <= 0) return;

    let intervalo = null;

    if (!pausado) {
      const step = 50;
      intervalo = setInterval(() => {
        setTiempoRestante((prev) => {
          if (prev <= step) {
            clearInterval(intervalo);
            iniciarCierre();
            return 0;
          }
          return prev - step;
        });
      }, step);
    }

    return () => {
      if (intervalo) clearInterval(intervalo);
    };
  }, [pausado, duracion]);

  const obtenerIcono = () => {
    switch (tipo) {
      case 'exito':
      case 'success':
        return <FiCheckCircle aria-hidden="true" />;
      case 'error':
        return <FiAlertCircle aria-hidden="true" />;
      case 'advertencia':
      case 'warning':
        return <FiAlertTriangle aria-hidden="true" />;
      case 'info':
      default:
        return <FiInfo aria-hidden="true" />;
    }
  };

  const obtenerTituloPorDefecto = () => {
    switch (tipo) {
      case 'exito':
      case 'success':
        return 'Operación Exitosa';
      case 'error':
        return 'Error';
      case 'advertencia':
      case 'warning':
        return 'Atención';
      case 'info':
      default:
        return 'Notificación';
    }
  };

  const porcentaje = duracion > 0 ? (tiempoRestante / duracion) * 100 : 0;

  return (
    <div
      className={`toast-bubble toast-${tipo} ${saliendo ? 'toast-exit' : 'toast-enter'}`}
      role="alert"
      aria-live="assertive"
      onMouseEnter={() => setPausado(true)}
      onMouseLeave={() => setPausado(false)}
    >
      <div className="toast-icon-container">
        {obtenerIcono()}
      </div>

      <div className="toast-body">
        <strong className="toast-title">{titulo || obtenerTituloPorDefecto()}</strong>
        <p className="toast-message">{mensaje}</p>
      </div>

      <button
        type="button"
        className="toast-close-btn"
        aria-label="Cerrar notificación"
        onClick={iniciarCierre}
      >
        <FiX aria-hidden="true" />
      </button>

      {duracion > 0 && (
        <div className="toast-progress-track">
          <div
            className="toast-progress-bar"
            style={{ width: `${porcentaje}%` }}
          />
        </div>
      )}
    </div>
  );
}

export default function ToastContainer({ notificaciones, onCerrar }) {
  if (!notificaciones || notificaciones.length === 0) return null;

  return (
    <div className="toast-container-root" aria-label="Notificaciones del sistema">
      {notificaciones.map((notificacion) => (
        <ToastItem
          key={notificacion.id}
          notificacion={notificacion}
          onCerrar={onCerrar}
        />
      ))}
    </div>
  );
}
