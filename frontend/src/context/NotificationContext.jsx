import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import ToastContainer from '../components/common/ToastContainer';

const NotificationContext = createContext(null);

let idContador = 0;

export function NotificationProvider({ children }) {
  const [notificaciones, setNotificaciones] = useState([]);
  const notificacionesRef = useRef([]);
  notificacionesRef.current = notificaciones;

  const eliminarNotificacion = useCallback((id) => {
    setNotificaciones((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const agregarNotificacion = useCallback((mensaje, opciones = {}) => {
    if (!mensaje) return null;

    idContador += 1;
    const id = `toast-${Date.now()}-${idContador}`;

    const nuevaNotificacion = {
      id,
      mensaje: typeof mensaje === 'string' ? mensaje : String(mensaje),
      titulo: opciones.titulo || null,
      tipo: opciones.tipo || 'info', // 'exito' | 'error' | 'advertencia' | 'info'
      duracion: typeof opciones.duracion === 'number' ? opciones.duracion : 4500,
      icono: opciones.icono || null,
      creadoEn: Date.now(),
    };

    setNotificaciones((prev) => {
      // Limitar a máximo 5 notificaciones en pantalla a la vez
      const lista = prev.length >= 5 ? prev.slice(prev.length - 4) : prev;
      return [...lista, nuevaNotificacion];
    });

    return id;
  }, []);

  const notificarExito = useCallback((mensaje, opciones = {}) => {
    return agregarNotificacion(mensaje, {
      ...opciones,
      tipo: 'exito',
      titulo: opciones.titulo || 'Operación exitosa',
    });
  }, [agregarNotificacion]);

  const notificarError = useCallback((mensaje, opciones = {}) => {
    return agregarNotificacion(mensaje, {
      ...opciones,
      tipo: 'error',
      titulo: opciones.titulo || 'Error',
      duracion: opciones.duracion || 5500,
    });
  }, [agregarNotificacion]);

  const notificarAdvertencia = useCallback((mensaje, opciones = {}) => {
    return agregarNotificacion(mensaje, {
      ...opciones,
      tipo: 'advertencia',
      titulo: opciones.titulo || 'Atención',
      duracion: opciones.duracion || 5500,
    });
  }, [agregarNotificacion]);

  const notificarInfo = useCallback((mensaje, opciones = {}) => {
    return agregarNotificacion(mensaje, {
      ...opciones,
      tipo: 'info',
      titulo: opciones.titulo || 'Información',
    });
  }, [agregarNotificacion]);

  const contextValue = {
    notificaciones,
    agregarNotificacion,
    eliminarNotificacion,
    notificar: agregarNotificacion,
    notificarExito,
    notificarError,
    notificarAdvertencia,
    notificarInfo,
    // Alias en inglés para compatibilidad
    success: notificarExito,
    error: notificarError,
    warning: notificarAdvertencia,
    info: notificarInfo,
  };

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
      <ToastContainer
        notificaciones={notificaciones}
        onCerrar={eliminarNotificacion}
      />
    </NotificationContext.Provider>
  );
}

export function useNotification() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotification debe ser utilizado dentro de un NotificationProvider');
  }
  return context;
}

export default NotificationContext;
