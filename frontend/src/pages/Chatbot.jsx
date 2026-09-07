import React, { useState } from 'react';

const API_URL = 'http://localhost:8000';

export default function Chatbot({ token }) {
  // =========================================================
  // PRUEBA: confirma que ESTE Chatbot.jsx está siendo cargado
  // =========================================================
  console.log('====================================');
  console.log('[CHATBOT] Chatbot.jsx CARGADO');
  console.log('[CHATBOT] API_URL:', API_URL);
  console.log('====================================');

  const [pregunta, setPregunta] = useState('');
  const [historial, setHistorial] = useState([]);
  const [cargando, setCargando] = useState(false);

  // =========================================================
  // ENVÍO DE MENSAJE
  // =========================================================
  const manejarEnvio = async (e) => {
    e.preventDefault();

    console.log('====================================');
    console.log('[CHATBOT] manejarEnvio() EJECUTADO');
    console.log('[CHATBOT] Pregunta actual:', pregunta);
    console.log('====================================');

    if (!pregunta.trim()) {
      console.log('[CHATBOT] Pregunta vacía');
      return;
    }

    if (cargando) {
      console.log('[CHATBOT] Ya existe una consulta en proceso');
      return;
    }

    const consultaUsuario = pregunta.trim();

    console.log(
      '[CHATBOT] Consulta enviada:',
      consultaUsuario
    );

    setPregunta('');
    setCargando(true);

    // =======================================================
    // AGREGAR MENSAJES AL HISTORIAL
    // =======================================================
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
      // =====================================================
      // FETCH
      // =====================================================
      console.log(
        '[CHATBOT] Enviando POST a:',
        `${API_URL}/api/chat`
      );

      console.log(
        '[CHATBOT] Token disponible:',
        token ? 'SÍ' : 'NO'
      );

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

      // =====================================================
      // RESPUESTA HTTP
      // =====================================================
      console.log('====================================');
      console.log('[CHATBOT] RESPUESTA HTTP RECIBIDA');
      console.log('[CHATBOT] Status:', res.status);
      console.log(
        '[CHATBOT] Status Text:',
        res.statusText
      );
      console.log(
        '[CHATBOT] Content-Type:',
        res.headers.get('content-type')
      );
      console.log('====================================');

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

      // =====================================================
      // COMPROBAR STREAM
      // =====================================================
      if (!res.body) {
        console.error(
          '[CHATBOT] res.body NO EXISTE'
        );

        throw new Error(
          'El servidor no devolvió un stream de respuesta.'
        );
      }

      console.log(
        '[CHATBOT] res.body existe correctamente'
      );

      const reader = res.body.getReader();

      const decoder = new TextDecoder(
        'utf-8'
      );

      let buffer = '';

      // =====================================================
      // FUNCIÓN PARA ACTUALIZAR EL ÚLTIMO MENSAJE DEL BOT
      // =====================================================
      const actualizarUltimoBot = (
        callback
      ) => {
        setHistorial((prev) => {
          if (prev.length === 0) {
            return prev;
          }

          const nuevoHistorial = [
            ...prev,
          ];

          const ultimoIndex =
            nuevoHistorial.length - 1;

          const ultimo =
            nuevoHistorial[ultimoIndex];

          if (ultimo.emisor !== 'bot') {
            console.warn(
              '[CHATBOT] El último mensaje no es del bot'
            );

            return prev;
          }

          nuevoHistorial[
            ultimoIndex
          ] = callback(ultimo);

          return nuevoHistorial;
        });
      };

      // =====================================================
      // PROCESAR EVENTO SSE
      // =====================================================
      const procesarEvento = (
        evento
      ) => {
        console.log(
          '------------------------------------'
        );

        console.log(
          '[CHATBOT] Evento SSE recibido:'
        );

        console.log(evento);

        console.log(
          '------------------------------------'
        );

        const lineas =
          evento.split(/\r?\n/);

        for (
          const linea of lineas
        ) {
          const lineaLimpia =
            linea.trim();

          if (
            !lineaLimpia.startsWith(
              'data:'
            )
          ) {
            continue;
          }

          const contenido =
            lineaLimpia
              .substring(5)
              .trim();

          if (!contenido) {
            continue;
          }

          console.log(
            '[CHATBOT] DATA:',
            contenido
          );

          let data;

          try {
            data = JSON.parse(
              contenido
            );
          } catch (error) {
            console.error(
              '[CHATBOT] ERROR PARSEANDO JSON SSE:',
              error
            );

            console.error(
              '[CHATBOT] Contenido problemático:',
              contenido
            );

            continue;
          }

          console.log(
            '[CHATBOT] Evento tipo:',
            data.tipo
          );

          // =================================================
          // TEXTO
          // =================================================
          if (
            data.tipo === 'texto'
          ) {
            console.log(
              '[CHATBOT] TEXTO RECIBIDO:',
              data.texto
            );

            actualizarUltimoBot(
              (ultimo) => ({
                ...ultimo,

                texto:
                  ultimo.texto +
                  (data.texto || ''),
              })
            );
          }

          // =================================================
          // FUENTES
          // =================================================
          if (
            data.tipo === 'fuentes'
          ) {
            console.log(
              '[CHATBOT] FUENTES RECIBIDAS:',
              data.fuentes
            );

            actualizarUltimoBot(
              (ultimo) => ({
                ...ultimo,

                fuentes:
                  data.fuentes || [],
              })
            );
          }

          // =================================================
          // MÉTRICAS
          // =================================================
          if (
            data.tipo === 'metricas'
          ) {
            console.log(
              '[CHATBOT] MÉTRICAS RECIBIDAS:',
              data.metricas
            );

            actualizarUltimoBot(
              (ultimo) => ({
                ...ultimo,

                metricas:
                  data.metricas ||
                  null,
              })
            );
          }

          // =================================================
          // ERROR
          // =================================================
          if (
            data.tipo === 'error'
          ) {
            console.error(
              '[CHATBOT] ERROR ENVIADO POR BACKEND:',
              data.error
            );

            actualizarUltimoBot(
              (ultimo) => ({
                ...ultimo,

                texto:
                  data.error ||
                  'Ocurrió un error al procesar la consulta.',
              })
            );
          }

          // =================================================
          // FIN
          // =================================================
          if (
            data.tipo === 'fin'
          ) {
            console.log(
              '[CHATBOT] EVENTO FIN RECIBIDO'
            );

            setCargando(false);
          }
        }
      };

      // =====================================================
      // LEER STREAM
      // =====================================================
      console.log(
        '[CHATBOT] INICIANDO LECTURA DEL STREAM'
      );

      while (true) {
        console.log(
          '[CHATBOT] Ejecutando reader.read()...'
        );

        const {
          value,
          done,
        } = await reader.read();

        console.log(
          '[CHATBOT] reader.read() resultado:',
          {
            done,
            bytes: value
              ? value.length
              : 0,
          }
        );

        // ===================================================
        // STREAM TERMINADO
        // ===================================================
        if (done) {
          console.log(
            '[CHATBOT] STREAM TERMINADO'
          );

          break;
        }

        // ===================================================
        // DECODIFICAR CHUNK
        // ===================================================
        const textoRecibido =
          decoder.decode(
            value,
            {
              stream: true,
            }
          );

        console.log(
          '[CHATBOT] CHUNK RECIBIDO:',
          JSON.stringify(
            textoRecibido
          )
        );

        buffer += textoRecibido;

        // ===================================================
        // SEPARAR EVENTOS SSE
        // ===================================================
        const eventos =
          buffer.split(
            /\r?\n\r?\n/
          );

        // El último puede estar incompleto
        buffer =
          eventos.pop() || '';

        for (
          const evento of eventos
        ) {
          if (
            evento.trim()
          ) {
            procesarEvento(
              evento
            );
          }
        }
      }

      // =====================================================
      // DECODIFICAR RESTO DEL STREAM
      // =====================================================
      buffer += decoder.decode();

      if (
        buffer.trim()
      ) {
        console.log(
          '[CHATBOT] BUFFER FINAL:',
          buffer
        );

        procesarEvento(
          buffer
        );
      }

      // =====================================================
      // FINAL NORMAL
      // =====================================================
      console.log(
        '===================================='
      );

      console.log(
        '[CHATBOT] CONSULTA TERMINADA CORRECTAMENTE'
      );

      console.log(
        '===================================='
      );

      setCargando(false);

    } catch (error) {
      // =====================================================
      // ERROR
      // =====================================================
      console.error(
        '===================================='
      );

      console.error(
        '[CHATBOT] ERROR REAL'
      );

      console.error(
        '[CHATBOT] Nombre:',
        error?.name
      );

      console.error(
        '[CHATBOT] Mensaje:',
        error?.message
      );

      console.error(
        '[CHATBOT] Error:',
        error
      );

      console.error(
        '[CHATBOT] Stack:',
        error?.stack
      );

      console.error(
        '===================================='
      );

      setHistorial((prev) => {
        if (prev.length === 0) {
          return prev;
        }

        const nuevoHistorial = [
          ...prev,
        ];

        const ultimoIndex =
          nuevoHistorial.length - 1;

        const ultimo =
          nuevoHistorial[
            ultimoIndex
          ];

        if (
          ultimo.emisor === 'bot'
        ) {
          nuevoHistorial[
            ultimoIndex
          ] = {
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

  // =========================================================
  // LIMPIAR CHAT
  // =========================================================
  const limpiarChat = () => {
    if (cargando) {
      return;
    }

    setHistorial([]);
  };

  // =========================================================
  // INTERFAZ
  // =========================================================
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
          justifyContent:
            'space-between',
          alignItems: 'center',
          marginBottom: '8px',
        }}
      >
        {historial.length >
          0 && (
          <button
            type="button"
            onClick={
              limpiarChat
            }
            disabled={
              cargando
            }
            style={{
              padding:
                '7px 12px',

              border:
                '1px solid #d1d5db',

              background:
                '#fff',

              color:
                '#374151',

              borderRadius:
                '6px',

              cursor:
                cargando
                  ? 'not-allowed'
                  : 'pointer',

              fontSize:
                '13px',
            }}
          >
            Limpiar
          </button>
        )}
      </div>

      {/* ===================================================
          ÁREA DEL CHAT
      =================================================== */}
      <div
        style={{
          height: '400px',

          border:
            '1px solid #cbd5e1',

          borderRadius:
            '8px',

          padding:
            '15px',

          overflowY:
            'auto',

          background:
            '#f8fafc',

          display:
            'flex',

          flexDirection:
            'column',

          gap:
            '12px',

          boxSizing:
            'border-box',
        }}
      >
        {/* CHAT VACÍO */}
        {historial.length ===
          0 && (
          <div
            style={{
              color:
                '#94a3b8',

              textAlign:
                'center',

              marginTop:
                '190px',
            }}
          >
            <div
              style={{
                fontSize:
                  '16px',

                fontWeight:
                  600,

                color:
                  '#64748b',

                marginBottom:
                  '6px',
              }}
            >
              Asistente Virtual IA
            </div>

            <div
              style={{
                fontSize:
                  '14px',
              }}
            >
              Haz una pregunta
              sobre los manuales
              técnicos...
            </div>
          </div>
        )}

        {/* MENSAJES */}
        {historial.map(
          (msg, i) => {
            const esUsuario =
              msg.emisor ===
              'usuario';

            return (
              <div
                key={i}
                style={{
                  display:
                    'flex',

                  flexDirection:
                    'column',

                  alignItems:
                    esUsuario
                      ? 'flex-end'
                      : 'flex-start',
                }}
              >
                {/* MENSAJE */}
                <div
                  style={{
                    background:
                      esUsuario
                        ? '#DD2226'
                        : '#ffffff',

                    color:
                      esUsuario
                        ? '#ffffff'
                        : '#0f172a',

                    padding:
                      '10px 13px',

                    borderRadius:
                      esUsuario
                        ? '12px 12px 3px 12px'
                        : '12px 12px 12px 3px',

                    maxWidth:
                      '82%',

                    lineHeight:
                      1.55,

                    fontSize:
                      '14px',

                    whiteSpace:
                      'pre-wrap',

                    border:
                      esUsuario
                        ? 'none'
                        : '1px solid #e2e8f0',

                    boxShadow:
                      esUsuario
                        ? 'none'
                        : '0 1px 2px rgba(0,0,0,0.04)',
                  }}
                >
                  {msg.texto || (
                    <span
                      style={{
                        color:
                          '#64748b',

                        fontStyle:
                          'italic',
                      }}
                    >
                      Generando respuesta...
                    </span>
                  )}
                </div>

                {/* FUENTES */}
                {!esUsuario &&
                  msg.fuentes &&
                  msg.fuentes.length >
                    0 && (
                    <div
                      style={{
                        marginTop:
                          '8px',

                        maxWidth:
                          '82%',

                        width:
                          '100%',
                      }}
                    >
                      <div
                        style={{
                          fontSize:
                            '12px',

                          fontWeight:
                            700,

                          color:
                            '#475569',

                          marginBottom:
                            '5px',
                        }}
                      >
                        Fuentes consultadas
                      </div>

                      <div
                        style={{
                          display:
                            'flex',

                          flexDirection:
                            'column',

                          gap:
                            '5px',
                        }}
                      >
                        {msg.fuentes.map(
                          (
                            fuente,
                            index
                          ) => (
                            <div
                              key={
                                index
                              }
                              style={{
                                background:
                                  '#f1f5f9',

                                border:
                                  '1px solid #e2e8f0',

                                borderRadius:
                                  '6px',

                                padding:
                                  '7px 9px',

                                fontSize:
                                  '12px',

                                color:
                                  '#475569',
                              }}
                            >
                              <strong>
                                {fuente.titulo_seccion ||
                                  fuente.nombreManual ||
                                  `Fuente ${
                                    index +
                                    1
                                  }`}
                              </strong>

                              {fuente.score !==
                                undefined && (
                                <span
                                  style={{
                                    marginLeft:
                                      '8px',

                                    color:
                                      '#64748b',
                                  }}
                                >
                                  Relevancia:{' '}
                                  {Number(
                                    fuente.score
                                  ).toFixed(
                                    3
                                  )}
                                </span>
                              )}
                            </div>
                          )
                        )}
                      </div>
                    </div>
                  )}

                {/* MÉTRICAS */}
                {!esUsuario &&
                  msg.metricas &&
                  !cargando && (
                    <div
                      style={{
                        marginTop:
                          '6px',

                        fontSize:
                          '11px',

                        color:
                          '#94a3b8',
                      }}
                    >
                      Consulta:{' '}
                      {
                        msg.metricas
                          .totalMs
                      }{' '}
                      ms

                      {msg.metricas
                        .firstTokenMs !==
                        undefined &&
                        ` · Primer token: ${msg.metricas.firstTokenMs} ms`}
                    </div>
                  )}
              </div>
            );
          }
        )}

        {/* PROCESANDO */}
        {cargando && (
          <div
            style={{
              alignSelf:
                'flex-start',

              color:
                '#64748b',

              fontSize:
                '13px',

              paddingLeft:
                '4px',
            }}
          >
            Procesando consulta...
          </div>
        )}
      </div>

      {/* ===================================================
          FORMULARIO
      =================================================== */}
      <form
        onSubmit={
          manejarEnvio
        }
        style={{
          display:
            'flex',

          gap:
            '10px',

          marginTop:
            '10px',
        }}
      >
        <input
          className="chat-message-input"
          type="text"
          value={pregunta}
          onChange={(e) =>
            setPregunta(
              e.target.value
            )
          }
          placeholder="Ej. ¿Cómo resuelvo el Error 402?"
          disabled={
            cargando
          }
          style={{
            flex: 1,

            padding:
              '11px 12px',

            border:
              '1px solid #cbd5e1',

            borderRadius:
              '6px',

            outline:
              'none',

            fontSize:
              '14px',

            color:
              '#0f172a',

            boxSizing:
              'border-box',

            background:
              cargando
                ? '#f8fafc'
                : '#fff',
          }}
        />

        <button
          type="submit"
          disabled={
            cargando ||
            !pregunta.trim()
          }
          style={{
            padding:
              '10px 18px',

            background:
              cargando ||
              !pregunta.trim()
                ? '#94a3b8'
                : '#2563eb',

            color:
              '#fff',

            border:
              'none',

            borderRadius:
              '6px',

            cursor:
              cargando ||
              !pregunta.trim()
                ? 'not-allowed'
                : 'pointer',

            fontWeight:
              600,
          }}
        >
          {cargando
            ? 'Generando...'
            : 'Enviar'}
        </button>
      </form>
    </div>
  );
}