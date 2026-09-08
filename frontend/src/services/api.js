const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export { API_URL };

export async function apiFetch(ruta, opciones = {}) {
  return fetch(`${API_URL}${ruta}`, opciones);
}
