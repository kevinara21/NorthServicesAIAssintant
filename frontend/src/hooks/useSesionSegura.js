import { useEffect, useRef, useState } from 'react';

export const DURACION_SESION_MS = 60 * 60 * 1000;
const UMBRAL_INACTIVIDAD_MS = 15 * 60 * 1000;
const VENTANA_CIERRE_MS = 5 * 60 * 1000;

const EVENTOS_INTERACCION = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];

export function formatearMinSeg(ms) {
  const totalSegundos = Math.max(0, Math.floor(ms / 1000));
  const minutos = Math.floor(totalSegundos / 60);
  const segundos = totalSegundos % 60;
  return `${String(minutos).padStart(2, '0')}:${String(segundos).padStart(2, '0')}`;
}

export default function useSesionSegura({ activo, inicioSesion, onExpirar }) {
  const [ahora, setAhora] = useState(() => Date.now());
  const ultimaInteraccion = useRef(Date.now());
  const [inactivo, setInactivo] = useState(false);
  const onExpirarRef = useRef(onExpirar);

  useEffect(() => {
    onExpirarRef.current = onExpirar;
  }, [onExpirar]);

  useEffect(() => {
    if (!activo) return undefined;
    ultimaInteraccion.current = Date.now();
    setInactivo(false);

    const registrar = () => {
      ultimaInteraccion.current = Date.now();
      setInactivo(false);
    };
    EVENTOS_INTERACCION.forEach((evento) => window.addEventListener(evento, registrar, { passive: true }));

    const intervalo = setInterval(() => setAhora(Date.now()), 1000);

    return () => {
      EVENTOS_INTERACCION.forEach((evento) => window.removeEventListener(evento, registrar));
      clearInterval(intervalo);
    };
  }, [activo]);

  const tiempoInactivo = activo ? ahora - ultimaInteraccion.current : 0;
  const excedeInactividad = tiempoInactivo >= UMBRAL_INACTIVIDAD_MS;

  useEffect(() => {
    if (!activo) return;
    if (excedeInactividad && !inactivo) setInactivo(true);
  }, [excedeInactividad, inactivo, activo]);

  useEffect(() => {
    if (activo && tiempoInactivo >= UMBRAL_INACTIVIDAD_MS + VENTANA_CIERRE_MS) {
      onExpirarRef.current?.();
    }
  }, [tiempoInactivo, activo]);

  // Cierre automático cuando se agota la duración total de la sesión
  // (redirige al login porque App renderiza <Login> al no haber usuario).
  const sesionAgotada = Boolean(activo && inicioSesion && ahora - inicioSesion >= DURACION_SESION_MS);

  useEffect(() => {
    if (sesionAgotada) {
      onExpirarRef.current?.();
    }
  }, [sesionAgotada]);

  const restanteSesion = activo && inicioSesion
    ? Math.max(0, DURACION_SESION_MS - (ahora - inicioSesion))
    : DURACION_SESION_MS;

  const restanteCierre = Math.max(0, UMBRAL_INACTIVIDAD_MS + VENTANA_CIERRE_MS - tiempoInactivo);
  const progresoCierre = restanteCierre / VENTANA_CIERRE_MS;

  return {
    tiempoSesionTexto: formatearMinSeg(restanteSesion),
    mostrarModalInactividad: inactivo && excedeInactividad,
    cuentaRegresivaTexto: formatearMinSeg(restanteCierre),
    progresoCierre: Math.min(1, Math.max(0, progresoCierre)),
  };
}
