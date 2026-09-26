import React, { useState, useEffect, useRef } from 'react';
import { API_URL } from '../services/api';

// ============================================================================
// Mapeo de entorno / Dev Logger
// ============================================================================
// Solo imprime mensajes de depuración cuando la app corre en desarrollo
// (vite dev / import.meta.env.DEV === true). En producción estos calls son
// no-ops y no generan ni overhead ni salida en consola.
const IS_DEV = Boolean(import.meta.env?.DEV);

const logDebug = IS_DEV
  ? (...args) => console.log('[CHATBOT]', ...args)
  : () => {};

// Bandera a nivel módulo: el log de carga se imprime UNA SOLA VEZ por
// recarga real de la página, sin importar re-montajes de React 19.
let chatbotLogImpreso = false;

// ============================================================================
// Helpers de formato
// ============================================================================
function limpiarFormatoRespuesta(texto) {
  return texto
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/(^|\n)\s*\*\s+/g, '$1- ')
    .replace(/(^|\n)\s*#{1,6}\s+/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1');
}

const estilosEnlaceChat = {
  color: '#DD2226',
  textDecoration: 'underline',
  fontWeight: 600,
  wordBreak: 'break-all',
};

function renderizarTextoEnriquecido(texto) {
  const textoLimpio = limpiarFormatoRespuesta(texto);
  const patron = /(https?:\/\/[^\s<>)'"\]}]+)|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})|(\+[\d\s()-]{7,18}\d)/g;
  const fragmentos = [];
  let ultimoIndex = 0;
  let coincidencia;
  let llave = 0;
  while ((coincidencia = patron.exec(textoLimpio)) !== null) {
    if (coincidencia.index > ultimoIndex) {
      fragmentos.push(textoLimpio.slice(ultimoIndex, coincidencia.index));
    }
    const [completo, url, email, telefono] = coincidencia;
    let enlace = null;
    if (url) {
      enlace = { href: url, texto: url, externo: true };
    } else if (email) {
      enlace = { href: `mailto:${email}`, texto: email };
    } else if (telefono) {
      const digitos = telefono.replace(/\D/g, '');
      enlace = { href: `https://wa.me/${digitos}`, texto: telefono, externo: true };
    }
    if (enlace) {
      fragmentos.push(
        <a
          key={llave++}
          href={enlace.href}
          target={enlace.externo ? '_blank' : undefined}
          rel={enlace.externo ? 'noreferrer' : undefined}
          style={estilosEnlaceChat}
        >
          {enlace.texto}
        </a>
      );
    } else {
      fragmentos.push(completo);
    }
    ultimoIndex = coincidencia.index + completo.length;
  }
  if (ultimoIndex < textoLimpio.length) {
    fragmentos.push(textoLimpio.slice(ultimoIndex));
  }
  return fragmentos;
}

// ============================================================================
// Componente principal
// ============================================================================
export default function Chatbot({ token, uid }) {
  // Log de carga (solo 1 vez por vida de la página y solo en dev)
  useEffect(() => {
    if (chatbotLogImpreso) return;
    chatbotLogImpreso = true;
    logDebug('====================================');
    logDebug('Chatbot.jsx CARGADO');
    logDebug('API_URL:', API_URL);
    logDebug('====================================');
  }, []);

  const [pregunta, setPregunta] = useState('');
  const [historial, setHistorial] = useState([]);
  const [cargando, setCargando] = useState(false);

  // Persistencia del historial por usuario
  const claveHistorial = `chat_historial_${uid || 'anonimo'}`;

  useEffect(() => {
    try {
      const guardado = localStorage.getItem(claveHistorial);
      if (guardado) {
        const datos = JSON.parse(guardado);
        if (Array.isArray(datos)) setHistorial(datos);
      }
    } catch {
      // Historial previo inválido; se ignora y se empieza vacío.
    }
  }, [claveHistorial]);

  useEffect(() => {
    try {
      if (historial.length === 0) {
        localStorage.removeItem(claveHistorial);
        return;
      }
      const completo = historial.filter((mensaje) => mensaje.emisor !== 'bot' || mensaje.texto);
      localStorage.setItem(claveHistorial, JSON.stringify(completo));
    } catch {
      // Almacenamiento no disponible; el chat sigue funcionando sin guardar.
    }
  }, [historial, claveHistorial]);

  // Scroll automático al final (solo si el usuario no está leyendo arriba)
  const contenedorChatRef = useRef(null);
  const cercaDelFinalRef = useRef(true);

  const manejarScrollChat = () => {
    const contenedor = contenedorChatRef.current;
    if (!contenedor) return;
    const distanciaAlFinal = contenedor.scrollHeight - contenedor.scrollTop - contenedor.clientHeight;
    cercaDelFinalRef.current = distanciaAlFinal < 80;
  };

  useEffect(() => {
    const contenedor = contenedorChatRef.current;
    if (!contenedor) return;
    if (cercaDelFinalRef.current) contenedor.scrollTop = contenedor.scrollHeight;
  }, [historial]);

  // Descarga de fuentes (archivos adjuntos)
  const descargarFuente = async (ruta, etiqueta) => {
    try {
      const respuesta = await fetch(`${API_URL}${ruta}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!respuesta.ok) throw new Error('No se pudo descargar el recurso solicitado.');
      const blob = await respuesta.blob();
      const url = URL.createObjectURL(blob);

      const disposicion = respuesta.headers.get('Content-Disposition') || '';
      const coincidencia = disposicion.match(/filename\*?=(?:UTF-8'')?["']?([^;"']+)["']?/i);
      const nombreArchivoReal = coincidencia
        ? decodeURIComponent(coincidencia[1].trim())
        : (etiqueta || 'archivo');

      const descripcion = respuesta.headers.get('Content-Disposition') || '';
      const partes = descripcion.match(/filename\*?=(?:UTF-8'')?["']?([^;"']+)["']?/i);
      const nombreReal = partes
        ? decodeURIComponent(partes[1].trim())
        : (etiqueta || 'archivo');

      const enlace = document.createElement('a');
      enlace.href = url;
      enlace.download = nombreReal;
      enlace.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      window.alert(error.message);
    }
  };

  // =========================================================================
  // Envío de mensaje + stream SSE
  // =========================================================================
  const manejarEnvio = async (e) => {
    e.preventDefault();

    logDebug('====================================');
    logDebug('manejarEnvio() EJECUTADO');
    logDebug('Pregunta actual:', pregunta);
    logDebug('====================================');

    if (!pregunta.trim()) {
      logDebug('Pregunta vacía, se ignora.');
      return;
    }

    if (cargando) {
      logDebug('Ya existe una consulta en proceso, se ignora.');
      return;
    }

    const consultaUsuario = pregunta.trim();
    logDebug('Consulta enviada:', consultaUsuario);

    setPregunta('');
    setCargando(true);

    setHistorial((prev) => [
      ...prev,
      {
        emisor: 'usuario',
        texto: consultaUsuario,
      },
      {
        emisor: 'bot',
        texto: '',
        fuentes: [],
        metricas: null,
      },
    ]);

    try {
      logDebug('Enviando POST a:', `${API_URL}/api/chat`);
      logDebug('Token disponible:', token ? 'SÍ' : 'NO');

      const res = await fetch(
        `${API_URL}/api/chat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            pregunta: consultaUsuario,
          }),
        }
      );

      logDebug('====================================');
      logDebug('RESPUESTA HTTP RECIBIDA');
      logDebug('Status:', res.status);
      logDebug('Status Text:', res.statusText);
      logDebug('Content-Type:', res.headers.get('content-type'));
      logDebug('====================================');

      if (!res.ok) {
        let mensaje = `Error HTTP ${res.status}`;

        try {
          const errorData = await res.json();

          console.error(
            '[CHATBOT] Error JSON del backend:',
            errorData
          );

          if (errorData.error) {
            mensaje = errorData.error;
          }
        } catch (errorJSON) {
          console.warn(
            '[CHATBOT] No se pudo leer JSON del error:',
            errorJSON
          );
        }

        throw new Error(mensaje);
      }

      if (!res.body) {
        console.error('[CHATBOT] res.body NO EXISTE');
        throw new Error('El servidor no devolvió un stream de respuesta.');
      }

      logDebug('res.body existe correctamente.');

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      // Mutación del último mensaje del bot en el historial
      const actualizarUltimoBot = (callback) => {
        setHistorial((prev) => {
          if (prev.length === 0) return prev;

          const nuevoHistorial = [...prev];
          const ultimoIndex = nuevoHistorial.length - 1;
          const ultimo = nuevoHistorial[ultimoIndex];

          if (ultimo.emisor !== 'bot') {
            console.warn('[CHATBOT] El último mensaje no es del bot');
            return prev;
          }

          nuevoHistorial[ultimoIndex] = callback(ultimo);
          return nuevoHistorial;
        });
      };

      // Procesa UN evento SSE ya parseado (separado por \n\n)
      const procesarEvento = (evento) => {
        const lineas = evento.split(/\r?\n/);

        for (const linea of lineas) {
          const lineaLimpia = linea.trim();
          if (!lineaLimpia.startsWith('data:')) continue;

          const contenido = lineaLimpia.substring(5).trim();
          if (!contenido) continue;

          let data;
          try {
            data = JSON.parse(contenido);
          } catch (error) {
            console.error('[CHATBOT] ERROR PARSEANDO JSON SSE:', error);
            console.error('[CHATBOT] Contenido problemático:', contenido);
            continue;
          }

          logDebug('Evento SSE tipo:', data.tipo);

          // --- TEXTO ---------------------------------------------------------
          if (data.tipo === 'texto') {
            actualizarUltimoBot((ultimo) => ({
              ...ultimo,
              texto: ultimo.texto + (data.texto || ''),
            }));
          }

          // --- REINICIAR TEXTO ----------------------------------------------
          if (data.tipo === 'texto_reset') {
            logDebug('TEXTO_RESET: limpiando respuesta parcial.');
            actualizarUltimoBot((ultimo) => ({
              ...ultimo,
              texto: '',
            }));
          }

          // --- FUENTES -------------------------------------------------------
          if (data.tipo === 'fuentes') {
            logDebug('FUENTES RECIBIDAS:', data.fuentes);
            actualizarUltimoBot((ultimo) => ({
              ...ultimo,
              fuentes: data.fuentes || [],
            }));
          }

          // --- MÉTRICAS ------------------------------------------------------
          if (data.tipo === 'metricas') {
            logDebug('MÉTRICAS RECIBIDAS:', data.metricas);
            actualizarUltimoBot((ultimo) => ({
              ...ultimo,
              metricas: data.metricas || null,
            }));
          }

          // --- ERROR (evento tipificado) ------------------------------------
          if (data.tipo === 'error') {
            console.error(
              '[CHATBOT] ERROR ENVIADO POR BACKEND:',
              data.error
            );

            actualizarUltimoBot((ultimo) => ({
              ...ultimo,
              texto:
                data.error ||
                'Ocurrió un error al procesar la consulta.',
            }));
          }

          // --- FIN -----------------------------------------------------------
          if (data.tipo === 'fin') {
            logDebug('EVENTO FIN RECIBIDO');
            setCargando(false);
          }
        }
      };

      logDebug('INICIANDO LECTURA DEL STREAM');

      while (true) {
        const { value, done } = await reader.read();

        // Stream terminado
        if (done) {
          logDebug('STREAM TERMINADO');
          break;
        }

        // Decodificar chunk
        const textoRecibido = decoder.decode(value, { stream: true });
        buffer += textoRecibido;

        // Separar eventos SSE
        const eventos = buffer.split(/\r?\n\r?\n/);
        buffer = eventos.pop() || '';

        for (const evento of eventos) {
          if (evento.trim()) procesarEvento(evento);
        }
      }

      // Decodificar resto del buffer que haya quedado colgado
      buffer += decoder.decode();

      if (buffer.trim()) {
        logDebug('BUFFER FINAL:', buffer);
        procesarEvento(buffer);
      }

      logDebug('====================================');
      logDebug('CONSULTA TERMINADA CORRECTAMENTE');
      logDebug('====================================');

      setCargando(false);
    } catch (error) {
      // ERROR REAL: sí se debe imprimir en producción para trazabilidad
      console.error('====================================');
      console.error('[CHATBOT] ERROR REAL');
      console.error('[CHATBOT] Nombre:', error?.name);
      console.error('[CHATBOT] Mensaje:', error?.message);
      console.error('[CHATBOT] Error:', error);
      console.error('[CHATBOT] Stack:', error?.stack);
      console.error('====================================');

      setHistorial((prev) => {
        if (prev.length === 0) return prev;

        const nuevoHistorial = [...prev];
        const ultimoIndex = nuevoHistorial.length - 1;
        const ultimo = nuevoHistorial[ultimoIndex];

        if (ultimo.emisor === 'bot') {
          nuevoHistorial[ultimoIndex] = {
            ...ultimo,
            texto:
              `Error: ${
                error?.message ||
                'No se pudo conectar con el servidor.'
              }`,
          };
        }

        return nuevoHistorial;
      });

      setCargando(false);
    }
  };

  // Limpiar historial (solo cuando no hay request en vuelo)
  const limpiarChat = () => {
    if (cargando) return;
    setHistorial([]);
  };

  // =========================================================================
  // Render
  // =========================================================================
  return (
    <div
      style={{
        padding: '10px',
        maxWidth: '900px',
        width: '100%',
        margin: '0 auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '8px',
        }}
      >
        {historial.length > 0 && (
          <button
            type="button"
            onClick={limpiarChat}
            disabled={cargando}
            style={{
              padding: '7px 12px',
              border: '1px solid #d1d5db',
              background: '#fff',
              color: '#374151',
              borderRadius: '6px',
              cursor: cargando ? 'not-allowed' : 'pointer',
              fontSize: '13px',
            }}
          >
            Limpiar
          </button>
        )}
      </div>

      {/* Área del chat */}
      <div
        ref={contenedorChatRef}
        onScroll={manejarScrollChat}
        style={{
          height: '400px',
          border: '1px solid #cbd5e1',
          borderRadius: '8px',
          padding: '15px',
          overflowY: 'auto',
          background: '#f8fafc',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          boxSizing: 'border-box',
        }}
      >
        {/* Chat vacío */}
        {historial.length === 0 && (
          <div
            style={{
              color: '#94a3b8',
              textAlign: 'center',
              marginTop: '190px',
            }}
          >
            <div
              style={{
                fontSize: '16px',
                fontWeight: 600,
                color: '#64748b',
                marginBottom: '6px',
              }}
            >
              North Services AI Assistant
            </div>
          </div>
        )}

        {/* Mensajes */}
        {historial.map((msg, i) => {
          const esUsuario = msg.emisor === 'usuario';

          return (
            <div
              key={i}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: esUsuario ? 'flex-end' : 'flex-start',
              }}
            >
              <div
                style={{
                  background:
                    esUsuario ? '#DD2226' : '#ffffff',
                  color:
                    esUsuario ? '#ffffff' : '#0f172a',
                  padding: '10px 13px',
                  borderRadius:
                    esUsuario
                      ? '12px 12px 3px 12px'
                      : '12px 12px 12px 3px',
                  maxWidth: '82%',
                  lineHeight: 1.55,
                  fontSize: '14px',
                  whiteSpace: 'pre-wrap',
                  border:
                    esUsuario ? 'none' : '1px solid #e2e8f0',
                  boxShadow:
                    esUsuario
                      ? 'none'
                      : '0 1px 2px rgba(0,0,0,0.04)',
                }}
              >
                {msg.texto ? renderizarTextoEnriquecido(msg.texto) : (
                  <span
                    style={{
                      color: '#64748b',
                      fontStyle: 'italic',
                    }}
                  >
                    Generando respuesta...
                  </span>
                )}
              </div>

              {!esUsuario &&
                msg.fuentes
                  ?.flatMap((fuente) => fuente.descargas || [])
                  .filter(
                    (descarga, indice, lista) =>
                      lista.findIndex((item) => item.ruta === descarga.ruta) ===
                      indice
                  )
                  .map((descarga) => (
                    <button
                      type="button"
                      key={descarga.ruta}
                      onClick={() =>
                        descargarFuente(descarga.ruta, descarga.etiqueta)
                      }
                      style={{
                        marginTop: 8,
                        marginRight: 8,
                        border: 'none',
                        borderRadius: 5,
                        padding: '7px 10px',
                        background: '#DD2226',
                        color: '#fff',
                        cursor: 'pointer',
                        fontWeight: 600,
                      }}
                    >
                      {descarga.etiqueta}
                    </button>
                  ))}
            </div>
          );
        })}

        {/* Procesando */}
        {cargando && (
          <div
            style={{
              alignSelf: 'flex-start',
              color: '#64748b',
              fontSize: '13px',
              paddingLeft: '4px',
            }}
          />
        )}
      </div>

      {/* Formulario */}
      <form
        onSubmit={manejarEnvio}
        style={{
          display: 'flex',
          gap: '10px',
          marginTop: '10px',
        }}
      >
        <input
          className="chat-message-input"
          type="text"
          value={pregunta}
          onChange={(e) => setPregunta(e.target.value)}
          placeholder="Haz una pregunta sobre los manuales técnicos..."
          disabled={cargando}
          style={{
            flex: 1,
            padding: '11px 12px',
            border: '1px solid #cbd5e1',
            borderRadius: '6px',
            outline: 'none',
            fontSize: '14px',
            color: '#0f172a',
            boxSizing: 'border-box',
            background: cargando ? '#f8fafc' : '#fff',
          }}
        />

        <button
          type="submit"
          disabled={cargando || !pregunta.trim()}
          style={{
            padding: '10px 18px',
            background:
              cargando || !pregunta.trim() ? '#B5181C' : '#DD2226',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            cursor:
              cargando || !pregunta.trim() ? 'not-allowed' : 'pointer',
            fontWeight: 600,
          }}
        >
          {cargando ? 'Generando...' : 'Enviar'}
        </button>
      </form>
    </div>
  );
}
