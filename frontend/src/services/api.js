const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export { API_URL };

export async function apiFetch(ruta, opciones = {}) {
  return fetch(`${API_URL}${ruta}`, opciones);
}

// Error con los datos que el backend añade a las respuestas 429 (por ejemplo
// `reintentarEn` y `restanteHoy`). Así la interfaz puede arrancar el conteo
// aunque el envío haya sido rechazado.
export class ApiError extends Error {
  constructor(mensaje, { status = 0, data = {} } = {}) {
    super(mensaje);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    if (data.reintentarEn !== undefined) this.reintentarEn = data.reintentarEn;
    if (data.restanteHoy !== undefined) this.restanteHoy = data.restanteHoy;
  }
}

export async function apiJson(ruta, opciones = {}) {
  const respuesta = await apiFetch(ruta, opciones);
  const texto = await respuesta.text();

  let data;
  try {
    data = texto ? JSON.parse(texto) : {};
  } catch {
    throw new ApiError(
      'El servidor no respondió correctamente. Verifica que el backend esté ejecutándose.',
      { status: respuesta.status }
    );
  }

  if (!respuesta.ok || data.ok === false) {
    throw new ApiError(data.error || 'No se pudo completar la operación.', {
      status: respuesta.status,
      data,
    });
  }

  return data;
}
