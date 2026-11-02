import { useCallback, useEffect, useReducer, useRef } from 'react';

// El vencimiento se guarda como marca de tiempo absoluta para que el conteo
// sobreviva a recargas de página y cambios de pantalla. Se usa sessionStorage:
// el conteo pertenece a la pestaña que hizo el envío y desaparece al cerrarla.
function leerVencimiento(clave) {
  if (!clave) return 0;
  try {
    return Number(sessionStorage.getItem(clave) || 0) || 0;
  } catch {
    return 0;
  }
}

function calcularRestante(vencimiento) {
  if (!vencimiento) return 0;
  return Math.max(0, Math.ceil((vencimiento - Date.now()) / 1000));
}

export function formatearSegundos(segundos) {
  const total = Math.max(0, Math.ceil(Number(segundos) || 0));
  const minutos = Math.floor(total / 60);
  const resto = total % 60;
  return `${minutos}:${String(resto).padStart(2, '0')}`;
}

export default function useCountdown(clave, { onFinalizar } = {}) {
  // El restante siempre se deriva del almacenamiento en cada render; el
  // reducer solo fuerza un repintado por segundo. Así nunca queda
  // desincronizado con otra pestaña ni con una recarga.
  const [, forceRender] = useReducer((valor) => valor + 1, 0);
  const callbackRef = useRef(onFinalizar);
  const restante = calcularRestante(leerVencimiento(clave));
  const activo = restante > 0;

  useEffect(() => {
    callbackRef.current = onFinalizar;
  }, [onFinalizar]);

  useEffect(() => {
    if (!activo) {
      if (clave) {
        try { sessionStorage.removeItem(clave); } catch { /* almacenamiento no disponible */ }
      }
      return undefined;
    }

    const intervalo = setInterval(() => {
      const siguiente = calcularRestante(leerVencimiento(clave));
      forceRender();
      if (siguiente <= 0) {
        clearInterval(intervalo);
        if (clave) {
          try { sessionStorage.removeItem(clave); } catch { /* almacenamiento no disponible */ }
        }
        callbackRef.current?.();
      }
    }, 1000);

    return () => clearInterval(intervalo);
  }, [clave, activo]);

  const iniciar = useCallback((segundos) => {
    const total = Math.max(0, Math.ceil(Number(segundos) || 0));
    if (clave) {
      try {
        if (total > 0) sessionStorage.setItem(clave, String(Date.now() + total * 1000));
        else sessionStorage.removeItem(clave);
      } catch { /* almacenamiento no disponible */ }
    }
    forceRender();
  }, [clave]);

  return { restante, iniciar, activo };
}
