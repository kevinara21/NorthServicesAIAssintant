import React, { useState, useEffect, useRef } from 'react';
import { FiDownload, FiTrash2, FiVolume2, FiVolumeX } from 'react-icons/fi';
import { MdHeadset, MdHeadsetOff, MdStop, MdVolumeUp } from 'react-icons/md';
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

// ============================================================================
// VOZ DEL BOT (TTS)
// ----------------------------------------------------------------------------
// Esta es la voz que usa el asistente para leer TODAS sus respuestas (tanto el
// botón "Escuchar" como la lectura automática).
//
// Ve cambiando INDICE_VOZ_BOT para escuchar una voz distinta cada vez:
//   0 = VOCES_BOT[0], 1 = VOCES_BOT[1], 2 = VOCES_BOT[2], etc.
// Cuando encuentres la voz que te gusta, deja ese número fijo aquí.
//
// Si el texto de VOCES_BOT[INDICE_VOZ_BOT] no coincide con ninguna voz del
// sistema, se usa la selección automática (voz masculina en español).
// Pon INDICE_VOZ_BOT = null para volver a la selección automática.
//
// Las voces reales del sistema se imprimen en consola (solo en desarrollo):
//   [CHATBOT] Voces disponibles: ...
//   [CHATBOT] Voz en uso: ...
// ============================================================================
const VOCES_BOT = [
  'Microsoft Pablo',
  'Microsoft Raul',
  'Microsoft Jorge',
  'Microsoft Diego',
  'Microsoft Carlos',
  'Microsoft Helena',
  'Microsoft Laura',
  'Microsoft Sabina',
  'Google español',
  'es-ES',
];

const INDICE_VOZ_BOT = 2;

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

// Resalta la palabra que el asistente está leyendo en voz alta. Divide el
// texto visible (sin formato) en palabras y sombrea la que corresponde al
// índice indicado, conservando el resto del contenido y los enlaces.
// El conteo de palabras usa la MISMA lista que el narrador (palabrasParaVoz)
// para que el índice coincida y el sombreado no se quede atascado.
function renderizarConGuia(texto, palabraResaltada, palabras) {
  const base = limpiarFormatoRespuesta(texto);
  if (palabraResaltada == null || !palabras || !palabras.length) {
    return renderizarTextoEnriquecido(base);
  }

  // Se recorre el texto y se cuenta palabra por palabra comparando con la
  // lista del narrador: la palabra en la posición palabraResaltada se resalta.
  const tokens = base.split(/(\s+)/);
  let indicePalabra = 0;

  return tokens.map((token, i) => {
    if (/^\s*$/.test(token)) return token;
    const esActual = indicePalabra === palabraResaltada;
    indicePalabra += 1;
    if (esActual) {
      return (
        <mark key={`guia-${i}`} className="chat-guia-palabra">
          {token}
        </mark>
      );
    }
    return <React.Fragment key={`guia-${i}`}>{renderizarTextoEnriquecido(token)}</React.Fragment>;
  });
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
  const [sonidoRespuesta, setSonidoRespuesta] = useState(() => {
    try {
      return localStorage.getItem('chat_sonido_respuesta') !== 'false';
    } catch {
      return true;
    }
  });
  const [vozRespuesta, setVozRespuesta] = useState(() => {
    try {
      return localStorage.getItem('chat_voz_respuesta') === 'true';
    } catch {
      return false;
    }
  });
  const sonidoRespuestaRef = useRef(sonidoRespuesta);
  const vozRespuestaRef = useRef(vozRespuesta);
  const contextoAudioRef = useRef(null);
  const utteranceEnCursoRef = useRef(null);
  const indiceBotAutoRef = useRef(null);
  const temporizadorGuiaRef = useRef(null);
  const [mensajeLeyendo, setMensajeLeyendo] = useState(null);
  const [palabraLeyendo, setPalabraLeyendo] = useState(null);

  useEffect(() => {
    try {
      localStorage.setItem('chat_sonido_respuesta', String(sonidoRespuesta));
    } catch {
      // El sonido sigue disponible durante esta sesión aunque no se pueda guardar la preferencia.
    }
  }, [sonidoRespuesta]);

  useEffect(() => {
    try {
      localStorage.setItem('chat_voz_respuesta', String(vozRespuesta));
    } catch {
      // La preferencia de voz no se guarda, pero funciona esta sesión.
    }
    vozRespuestaRef.current = vozRespuesta;
  }, [vozRespuesta]);

  useEffect(() => () => {
    if (contextoAudioRef.current && contextoAudioRef.current.state !== 'closed') {
      contextoAudioRef.current.close();
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignorar
      }
    }
    if (temporizadorGuiaRef.current) {
      clearInterval(temporizadorGuiaRef.current);
      temporizadorGuiaRef.current = null;
    }
    utteranceEnCursoRef.current = null;
  }, []);

  const habilitarAudioParaRespuesta = () => {
    if (!sonidoRespuestaRef.current || typeof window === 'undefined') return;
    const AudioContexto = window.AudioContext || window.webkitAudioContext;
    if (!AudioContexto) return;

    try {
      contextoAudioRef.current ||= new AudioContexto();
      contextoAudioRef.current.resume().catch((error) => {
        logDebug('No se pudo habilitar el sonido de respuesta:', error);
      });
    } catch (error) {
      logDebug('No se pudo preparar el sonido de respuesta:', error);
    }
  };

  const limpiarTextoParaVoz = (texto) => String(texto || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`#>|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Diccionario de unidades y siglas técnicas de perforación / MWD-LWD.
  // El TTS del navegador pronuncia muy mal las unidades compuestas y las
  // abreviaturas (Ft/Lbs, PSI, RPM, GPM...), así que se reemplazan por su
  // lectura en español antes de enviar el texto a la voz. Se aplica DESPUÉS
  // de limpiarTextoParaVoz para que el sombreado y la narración coincidan.
  const DICCIONARIO_UNIDADES_TECNICAS = [
    // Torque y fuerza. Cada reemplazo es UNA sola palabra para que el número
    // de tokens no cambie y el sombreado quede alineado con el texto visible.
    [/\bft[\s/.-]*lbs?\b/gi, 'pieslibra'],
    [/\bft[\s/.-]*lb\b/gi, 'pieslibra'],
    [/\blbs?[\s/.-]*ft\b/gi, 'libraspie'],
    [/\bN[\s/.-]*m\b/g, 'newtonmetro'],
    [/\bkN[\s/.-]*m\b/g, 'kilonewtonmetro'],
    [/\bkg[\s/.-]*m\b/gi, 'kilogramometro'],
    [/\blbf\b/gi, 'libras'],
    [/\bkgf\b/gi, 'kilogramos'],
    [/\bWOB\b/g, 'WOB'],
    [/\bTOB\b/g, 'TOB'],
    // Presión
    [/\bkg[\s/.-]*cm2\b/gi, 'kilogramospercentímetrouadrado'],
    [/\bkg[\s/.-]*cm²\b/gi, 'kilogramospercentímetrouadrado'],
    [/\bpsi\b/gi, 'psí'],
    [/\bkpa\b/gi, 'kilopascal'],
    [/\bmpa\b/gi, 'megapascal'],
    [/\bbar\b/gi, 'bar'],
    [/\bGPM\b/g, 'galonesminuto'],
    [/\bLPM\b/g, 'litrosminuto'],
    // Velocidad y rotación
    [/\brpm\b/gi, 'rpm'],
    [/\bROP\b/g, 'ROP'],
    [/\bm[\s/.-]*h\b/gi, 'metroshora'],
    [/\bm[\s/.-]*s\b/gi, 'metrosporsegundo'],
    [/\bft[\s/.-]*h\b/gi, 'pieshora'],
    [/\bft[\s/.-]*min\b/gi, 'piesminuto'],
    // Longitud y diámetro
    [/\bmm\b/gi, 'milímetros'],
    [/\bcm\b/gi, 'centímetros'],
    [/\bkm\b/gi, 'kilómetros'],
    [/\bin\b/gi, 'pulgadas'],
    [/\bfeet\b/gi, 'pies'],
    [/\bft\b/gi, 'pies'],
    [/\bOD\b/g, 'OD'],
    [/\bID\b/g, 'ID'],
    [/\bBHA\b/g, 'BHA'],
    [/\bTD\b/g, 'TD'],
    [/\bMD\b/g, 'MD'],
    [/\bTVD\b/g, 'TVD'],
    // Peso y volumen
    [/\bkg\b/gi, 'kilogramos'],
    [/\blb\b/gi, 'libras'],
    [/\bm3\b/gi, 'metroscúbicos'],
    [/\bL\b/g, 'litros'],
    [/\bgal\b/gi, 'galones'],
    [/\bbbl\b/gi, 'barriles'],
    // Temperatura y eléctrico
    [/\b°C\b/g, 'gradoscentígrados'],
    [/\b°F\b/g, 'gradosfahrenheit'],
    [/\bV\b/g, 'voltios'],
    [/\bA\b/g, 'amperios'],
    [/\bHz\b/g, 'hertz'],
    [/\bkHz\b/g, 'kilohertz'],
  ];

  const normalizarUnidades = (texto) => DICCIONARIO_UNIDADES_TECNICAS.reduce(
    (acumulado, [patron, reemplazo]) => acumulado.replace(patron, reemplazo),
    String(texto || '')
  );

  // Texto final que se envía a la voz (limpieza + unidades normalizadas).
  const textoParaNarracion = (texto) => normalizarUnidades(limpiarTextoParaVoz(texto));

  // Palabras que se sombrean al leer: se derivan SIEMPRE de textoParaNarracion,
  // el mismo texto que se narra, para que el índice del guía y el del
  // temporizador coincidan exactamente.
  const palabrasParaVoz = (texto) => textoParaNarracion(texto).split(' ').filter(Boolean);

  // Devuelve la voz elegida en VOCES_BOT[INDICE_VOZ_BOT] si existe en el sistema.
  const elegirVozDelBot = (voces) => {
    const elegido = VOCES_BOT[INDICE_VOZ_BOT];
    if (!elegido) return null;
    const objetivo = String(elegido).toLowerCase();
    return voces.find((voz) => String(voz?.name || '').toLowerCase().includes(objetivo)) || null;
  };

  // Elige la mejor voz disponible: prioriza una voz masculina en español.
  const elegirVozEspanolMasculina = (voces) => {
    const nombresHombres = 'jorge diego raul pablo carlos antonio miguel hernan juan manuel pedro javier francisco alberto hugo ramon victor emilio sergio daniel cristian andres alex ruben oscar luis mariano ignacio enrique fernando ricardo arturo guillermo alejandro roberto tomas juanpa';
    const nombresMujeres = 'elvira isabel isabela helena catalina lola lucia monica mónica rosa elena patricia gabriela carmen conchita soledad nuria irene beatriz ana sara sofia maria valeria laura paulina';
    const nombreVoz = (voz) => String(voz?.name || '').toLowerCase();
    const esEspanol = (voz) => /^es([-_]|$)/i.test(String(voz?.lang || ''));
    const contieneHombre = (voz) => nombresHombres.split(/\s+/).some((n) => nombreVoz(voz).includes(n));
    const contieneMujer = (voz) => nombresMujeres.split(/\s+/).some((n) => nombreVoz(voz).includes(n));

    return voces.find((voz) => esEspanol(voz) && contieneHombre(voz))
      || voces.find((voz) => esEspanol(voz) && !contieneMujer(voz))
      || voces.find((voz) => esEspanol(voz))
      || voces.find((voz) => contieneHombre(voz) && !contieneMujer(voz))
      || voces[0]
      || null;
  };

  const narrarTexto = (limpio, indice) => {
    const sintesis = window.speechSynthesis;
    const rate = 1.25;
    let arranco = false;
    let reintentoHecho = false;

    // Palabras del texto limpio (mismo criterio que el render del guía).
    const palabras = palabrasParaVoz(limpio);

    const detenerTemporizador = () => {
      if (temporizadorGuiaRef.current) {
        clearTimeout(temporizadorGuiaRef.current);
        temporizadorGuiaRef.current = null;
      }
    };

    // Sombreado estimado: onboundary no existe en la mayoría de móviles, así
    // que la palabra activa avanza con un temporizador proporcional a la
    // longitud de cada palabra y a la velocidad de lectura. Si el navegador SÍ
    // emite onboundary (PC), se cancela el temporizador y se usa el índice real.
    const avanzarConTiempo = () => {
      detenerTemporizador();
      if (!palabras.length) return;
      // Caracteres por segundo de una voz es-ES. En móvil el motor suele ser
      // más lento que en PC y además arranca con retardo, así que se estima
      // conservador (~26 c/s) y se espera un poco antes de la primera palabra.
      const duracionBase = (palabra) => Math.max(
        220,
        (palabra.replace(/[^\p{L}\p{N}]/gu, '').length + 2) / (26 * rate) * 1000
      );
      // La voz hace pausas al final de frases y cláusulas; se suman para que el
      // sombreado no se adelante en los puntos y comas.
      const pausaSigno = (palabra) => {
        const final = palabra.slice(-1);
        if (final === '.' || final === '?' || final === '!' || final === '…') return 800;
        if (final === ',' || final === ';' || final === ':') return 600;
        // Unidades compuestas como ft/Lbs, kg/cm2 o m3/min se leen más despacio.
        if (/\//.test(palabra)) return 260;
        return 0;
      };
      const duracionPalabra = (palabra) => duracionBase(palabra) + pausaSigno(palabra);
      const retardoArranque = 350;
      let posicion = 0;
      setPalabraLeyendo(posicion);
      const avanzar = () => {
        temporizadorGuiaRef.current = setTimeout(() => {
          posicion += 1;
          if (posicion >= palabras.length) {
            detenerTemporizador();
            return;
          }
          setPalabraLeyendo(posicion);
          avanzar();
        }, duracionPalabra(palabras[posicion]));
      };
      temporizadorGuiaRef.current = setTimeout(avanzar, retardoArranque);
    };

    const construirUtterance = () => {
      const utterance = new SpeechSynthesisUtterance(limpio);
      utterance.lang = 'es-ES';
      utterance.rate = rate;
      utterance.pitch = rate;
      utterance.volume = 1;

      const vozElegida = elegirVozDelBot(sintesis.getVoices?.() || [])
        || elegirVozEspanolMasculina(sintesis.getVoices?.() || []);
      if (vozElegida) {
        utterance.voice = vozElegida;
      }

      utterance.onstart = () => {
        arranco = true;
        if (utteranceEnCursoRef.current !== utterance) return;
        setMensajeLeyendo(indice);
        avanzarConTiempo();
      };
      // Cuando el navegador lo emite (PC), da el índice real y cancela el
      // temporizador. En móvil rara vez llega y el temporizador sigue igual.
      utterance.onboundary = (event) => {
        if (event.name && event.name !== 'word') return;
        if (utteranceEnCursoRef.current !== utterance) return;
        detenerTemporizador();
        const hasta = limpio.slice(0, event.charIndex);
        const palabrasAntes = hasta.split(/\s+/).filter(Boolean).length;
        const enInicioDePalabra = hasta === '' || /\s$/.test(hasta);
        setPalabraLeyendo(enInicioDePalabra ? palabrasAntes : Math.max(palabrasAntes - 1, 0));
      };
      utterance.onend = () => {
        if (utteranceEnCursoRef.current === utterance) {
          utteranceEnCursoRef.current = null;
          detenerTemporizador();
          setMensajeLeyendo(null);
          setPalabraLeyendo(null);
        }
      };
      utterance.onerror = () => {
        if (utteranceEnCursoRef.current === utterance) {
          utteranceEnCursoRef.current = null;
          detenerTemporizador();
          setMensajeLeyendo(null);
          setPalabraLeyendo(null);
        }
      };

      return utterance;
    };

    const limpiar = () => {
      utteranceEnCursoRef.current = null;
      detenerTemporizador();
      setMensajeLeyendo(null);
      setPalabraLeyendo(null);
    };

    let utterance = construirUtterance();
    utteranceEnCursoRef.current = utterance;

    try {
      sintesis.resume?.();
      sintesis.speak(utterance);
    } catch (error) {
      logDebug('No se pudo leer la respuesta en voz:', error);
      limpiar();
      return false;
    }

    // Chromium a veces ignora speak() (cola atascada) y onstart nunca dispara;
    // se reintenta una sola vez creando una utterance nueva.
    setTimeout(() => {
      if (arranco || reintentoHecho || utteranceEnCursoRef.current !== utterance) return;
      reintentoHecho = true;
      try {
        sintesis.cancel();
        utterance = construirUtterance();
        utteranceEnCursoRef.current = utterance;
        setTimeout(() => {
          if (utteranceEnCursoRef.current !== utterance) return;
          try {
            sintesis.resume?.();
            sintesis.speak(utterance);
          } catch (errorReintento) {
            logDebug('No se pudo reintentar la lectura en voz:', errorReintento);
            limpiar();
          }
        }, 40);
      } catch (error) {
        logDebug('No se pudo preparar el reintento de voz:', error);
      }
    }, 1200);

    return true;
  };

  // Lectura en voz directa: no consulta la preferencia del usuario, de modo
  // que el botón "Escuchar" de cada respuesta siempre funcione.
  const hablarTexto = (texto, indice = null) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return false;
    const limpio = textoParaNarracion(texto);
    if (!limpio) return false;
    const sintesis = window.speechSynthesis;

    try {
      sintesis.cancel();
    } catch {
      // ignorar
    }

    const voces = sintesis.getVoices?.() || [];
    if (voces.length === 0) {
      // Las voces cargan de forma asíncrona en algunos navegadores; se espera
      // al evento para no caer en la voz femenina por defecto.
      let ejecutado = false;
      const iniciar = () => {
        if (ejecutado) return;
        ejecutado = true;
        sintesis.removeEventListener?.('voiceschanged', iniciar);
        narrarTexto(limpio, indice);
      };
      sintesis.addEventListener?.('voiceschanged', iniciar);
      setTimeout(iniciar, 700);
      return true;
    }

    return narrarTexto(limpio, indice);
  };

  const detenerVoz = () => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignorar
    }
    utteranceEnCursoRef.current = null;
    setMensajeLeyendo(null);
    setPalabraLeyendo(null);
  };

  // Desbloquea la síntesis de voz dentro del gesto del usuario (algunos
  // navegadores ignoran speak() si no se ha interactuado antes).
  const desbloquearVoz = () => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    try {
      const utterance = new SpeechSynthesisUtterance(' ');
      utterance.volume = 0;
      window.speechSynthesis.speak(utterance);
      window.speechSynthesis.cancel();
    } catch {
      // ignorar
    }
  };

  const reproducirVozRespuesta = (texto, indice = null) => {
    if (!vozRespuestaRef.current) return;
    hablarTexto(texto, indice);
  };

  const reproducirSonidoRespuesta = (textoParaLeer, indice = null) => {
    const contexto = contextoAudioRef.current;
    const puedeTimbrar = sonidoRespuestaRef.current
      && contexto
      && contexto.state !== 'closed';

    // La lectura en voz NUNCA debe depender del AudioContext: si quedó
    // suspendido (p. ej. tras una respuesta lenta), resume() puede no
    // resolverse y la voz no sonaría. Se intenta leer primero y el timbre
    // queda como adorno opcional.
    reproducirVozRespuesta(textoParaLeer, indice);

    if (!puedeTimbrar) return;

    contexto.resume().then(() => {
      if (!sonidoRespuestaRef.current) return;
      const ahora = contexto.currentTime;
      [784, 1046].forEach((frecuencia, indiceTono) => {
        const inicio = ahora + indiceTono * 0.12;
        const oscilador = contexto.createOscillator();
        const volumen = contexto.createGain();
        oscilador.type = 'sine';
        oscilador.frequency.setValueAtTime(frecuencia, inicio);
        volumen.gain.setValueAtTime(0.0001, inicio);
        volumen.gain.exponentialRampToValueAtTime(0.09, inicio + 0.025);
        volumen.gain.exponentialRampToValueAtTime(0.0001, inicio + 0.24);
        oscilador.connect(volumen);
        volumen.connect(contexto.destination);
        oscilador.start(inicio);
        oscilador.stop(inicio + 0.25);
      });
    }).catch((error) => {
      logDebug('No se pudo reproducir el sonido de respuesta:', error);
    });
  };

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

  // Sigue la palabra que se está leyendo: mientras la guía marca la palabra
  // activa, el chat baja (o sube) solo para mantenerla visible, sin usar la
  // rueda del mouse.
  useEffect(() => {
    if (mensajeLeyendo === null || palabraLeyendo === null) return;
    const contenedor = contenedorChatRef.current;
    if (!contenedor) return;
    const marca = contenedor.querySelector('.chat-guia-palabra');
    if (!marca) return;

    const caja = contenedor.getBoundingClientRect();
    const zona = marca.getBoundingClientRect();
    const margenSuperior = caja.top + caja.height * 0.25;
    const margenInferior = caja.bottom - caja.height * 0.3;
    if (zona.top < margenSuperior || zona.bottom > margenInferior) {
      const destino = contenedor.scrollTop + (zona.top - caja.top) - contenedor.clientHeight * 0.45;
      contenedor.scrollTo({ top: Math.max(0, destino), behavior: 'smooth' });
    }
  }, [mensajeLeyendo, palabraLeyendo]);

  // Descarga de fuentes (archivos adjuntos)
  const descargarFuente = async (ruta, etiqueta) => {
    try {
      const respuesta = await fetch(`${API_URL}${ruta}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!respuesta.ok) throw new Error('No se pudo descargar el recurso solicitado.');
      const blob = await respuesta.blob();
      const url = URL.createObjectURL(blob);

      const disposicion = respuesta.headers.get('Content-Disposition') || '';
      const partes = disposicion.match(/filename\*?=(?:UTF-8'')?["']?([^;"']+)["']?/i);
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
    habilitarAudioParaRespuesta();

    setHistorial((prev) => {
      indiceBotAutoRef.current = prev.length + 1;
      return [
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
      ];
    });

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
            contextoConversacion: historial
              .filter((mensaje) => mensaje.emisor === 'usuario' && mensaje.texto)
              .slice(-6)
              .map((mensaje) => mensaje.texto),
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
      let respuestaConError = false;
      let sonidoReproducido = false;
      let textoAcumulado = '';

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
            textoAcumulado += data.texto || '';
            actualizarUltimoBot((ultimo) => ({
              ...ultimo,
              texto: ultimo.texto + (data.texto || ''),
            }));
          }

          // --- REINICIAR TEXTO ----------------------------------------------
          if (data.tipo === 'texto_reset') {
            logDebug('TEXTO_RESET: limpiando respuesta parcial.');
            textoAcumulado = '';
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
            respuestaConError = true;
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
            if (!respuestaConError && !sonidoReproducido) {
              sonidoReproducido = true;
              reproducirSonidoRespuesta(textoAcumulado, indiceBotAutoRef.current);
            }
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

      // Algunas rutas del backend envían su respuesta sin evento "fin"
      // (p. ej. consultas fuera de alcance). Si terminó el stream y hay
      // texto, se lanza la lectura en voz aunque no haya llegado "fin".
      if (!respuestaConError && !sonidoReproducido && textoAcumulado) {
        sonidoReproducido = true;
        reproducirSonidoRespuesta(textoAcumulado, indiceBotAutoRef.current);
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

  // Descarga la conversación actual como un archivo de texto: el usuario se
  // lleva el chat completo (preguntas, respuestas y enlaces de las fuentes).
  const descargarChat = () => {
    if (cargando || !historial.length) return;

    const fecha = new Date();
    const dosDigitos = (n) => String(n).padStart(2, '0');
    const marca = `${fecha.getFullYear()}${dosDigitos(fecha.getMonth() + 1)}${dosDigitos(fecha.getDate())}-${dosDigitos(fecha.getHours())}${dosDigitos(fecha.getMinutes())}`;

    const lineas = [
      'Conversación con el Asistente Virtual IA - North Services',
      `Fecha de descarga: ${fecha.toLocaleString('es-PE', { timeZone: 'America/Lima' })}`,
      '='.repeat(60),
      '',
    ];

    historial.forEach((mensaje) => {
      const autor = mensaje.emisor === 'usuario' ? 'Tú' : 'Asistente North Services';
      lineas.push(`${autor}:`);
      lineas.push(mensaje.texto || '(sin contenido)');

      const descargas = (mensaje.fuentes || [])
        .flatMap((fuente) => fuente.descargas || [])
        .filter((descarga, indice, lista) => lista.findIndex((item) => item.ruta === descarga.ruta) === indice);

      if (descargas.length) {
        lineas.push('');
        lineas.push('Documentos relacionados:');
        descargas.forEach((descarga) => lineas.push(`- ${descarga.etiqueta || descarga.ruta}`));
      }

      lineas.push('');
      lineas.push('-'.repeat(60));
      lineas.push('');
    });

    const blob = new Blob(['\uFEFF', lineas.join('\r\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = `chat-north-services-${marca}.txt`;
    document.body.appendChild(enlace);
    enlace.click();
    document.body.removeChild(enlace);
    URL.revokeObjectURL(url);
  };

  // =========================================================================
  // Render
  // =========================================================================
  return (
    <div className="chatbot-shell">
      <div className="chatbot-toolbar">
          <div className="chatbot-toolbar__left">
            <button
              type="button"
              className={`chatbot-tool-button chatbot-tool-button--compact${sonidoRespuesta ? ' is-active' : ''}`}
              onClick={() => {
                const siguiente = !sonidoRespuesta;
                setSonidoRespuesta(siguiente);
                sonidoRespuestaRef.current = siguiente;
              }}
              aria-pressed={sonidoRespuesta}
              title={sonidoRespuesta ? 'Desactivar sonido al terminar la respuesta' : 'Activar sonido al terminar la respuesta'}
            >
              {sonidoRespuesta ? <FiVolume2 aria-hidden="true" /> : <FiVolumeX aria-hidden="true" />}
            </button>
            <button
              type="button"
              className={`chatbot-tool-button chatbot-tool-button--compact${vozRespuesta ? ' is-active' : ''}`}
              onClick={() => {
                const siguiente = !vozRespuesta;
                setVozRespuesta(siguiente);
                vozRespuestaRef.current = siguiente;
                if (siguiente) {
                  desbloquearVoz();
                  // No leer automáticamente al activar para evitar repeticiones molestas.
                } else {
                  detenerVoz();
                }
              }}
              aria-pressed={vozRespuesta}
              title={vozRespuesta ? 'Desactivar lectura en voz' : 'Activar lectura en voz'}
            >
              {vozRespuesta ? <MdHeadset aria-hidden="true" /> : <MdHeadsetOff aria-hidden="true" />}
            </button>
          {historial.length > 0 && (
            <button
              type="button"
              className="chatbot-tool-button chatbot-tool-button--clear"
              onClick={limpiarChat}
              disabled={cargando}
              title="Borrar la conversación actual"
            >
              <FiTrash2 aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="chatbot-toolbar__right">
          {historial.length > 0 && (
            <button
              type="button"
              className="chatbot-tool-button chatbot-tool-button--download"
              onClick={descargarChat}
              disabled={cargando}
              title={cargando
                ? 'Espera a que termine la respuesta para descargar el chat'
                : 'Descargar esta conversación como archivo de texto'}
            >
              <FiDownload aria-hidden="true" /> Descargar chat
            </button>
          )}
        </div>
      </div>

      {/* Área del chat */}
      <div
        className="chatbot-conversation"
        ref={contenedorChatRef}
        onScroll={manejarScrollChat}
        style={{
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
          const conEscucha = !esUsuario && Boolean(msg.texto);

          return (
            <div
              key={i}
              className="chat-message-row"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: esUsuario ? 'flex-end' : 'flex-start',
              }}
            >
              <div
                className={`chat-message-bubble${esUsuario ? ' chat-message-bubble--user' : ''}`}
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
                  lineHeight: 1.55,
                  fontSize: '14px',
                  whiteSpace: 'pre-wrap',
                  border:
                    esUsuario ? 'none' : '1px solid #e2e8f0',
                  boxShadow:
                    esUsuario
                      ? 'none'
                      : '0 1px 2px rgba(0,0,0,0.04)',
                  ...(conEscucha
                    ? { position: 'relative', paddingRight: 46, paddingBottom: 14 }
                    : {}),
                }}
              >
                {msg.texto ? (
                  !esUsuario && mensajeLeyendo === i
                    ? renderizarConGuia(msg.texto, palabraLeyendo, palabrasParaVoz(msg.texto))
                    : renderizarTextoEnriquecido(msg.texto)
                ) : (
                  <span
                    style={{
                      color: '#64748b',
                      fontStyle: 'italic',
                    }}
                  >
                    Generando respuesta...
                  </span>
                )}

                {conEscucha && (
                  <button
                    type="button"
                    className="chatbot-tool-button chatbot-tool-button--compact chatbot-btn-escuchar"
                    onClick={() => {
                      if (mensajeLeyendo === i) {
                        detenerVoz();
                      } else {
                        hablarTexto(msg.texto, i);
                      }
                    }}
                    aria-pressed={mensajeLeyendo === i}
                    title={mensajeLeyendo === i ? 'Detener lectura' : 'Escuchar respuesta'}
                  >
                    {mensajeLeyendo === i ? <MdStop aria-hidden="true" /> : <MdVolumeUp aria-hidden="true" />}
                  </button>
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
      <form className="chatbot-input-form" onSubmit={manejarEnvio}>
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
          className="chatbot-submit"
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
