// ============================================================
// CATEGORÍAS DE CONOCIMIENTO Y PERMISOS RAG POR ROL
// ============================================================
//
// Este servicio es la única fuente de verdad para responder:
//
//   - qué categorías (fuentes RAG) existen;
//   - en qué colección de vectores vive cada una;
//   - en qué colección de papelera se aísla cada una;
//   - qué categorías puede consultar cada rol.
//
// Todo se guarda en MongoDB, por lo que el Administrador puede crear
// categorías nuevas o cambiar permisos sin tocar el código fuente.
//
// El RAG NUNCA lee las colecciones "_papelera": el sistema las excluye
// por construcción porque la búsqueda solo recorre `coleccion` de las
// categorías registradas.
// ============================================================

const { getDB } = require('../db/mongodb');
const { db: firestore } = require('../firebaseAdmin');

const COLECCION_CATEGORIAS = 'categorias_conocimiento';
const COLECCION_PERMISOS = 'permisos_rag_roles';
// Documentos de Firestore que describen los archivos subidos. Se usan para
// que desactivar una categoría también saque sus archivos de Archivos y los
// mande a la papelera visible.
const COLECCION_ARCHIVOS = 'archivos';

const SUFIJO_PAPELERA = '_papelera';

// Lote máximo de escrituras que acepta Firestore en una transacción.
const LOTE_FIRESTORE = 400;

// No hay categorías sembradas: el sistema arranca sin ninguna y las crea
// el Administrador desde el panel. El nombre de la colección de vectores y
// el de la papelera se derivan del identificador de la categoría y el índice
// sigue la convención de abajo, así que agregar una fuente nueva nunca
// obliga a tocar el código.

// Categoría que se crea sola la primera vez que se sube un archivo sin
// elegir categoría. Se guarda en MongoDB como cualquier otra.
const CATEGORIA_POR_DEFECTO = 'conocimiento_general';
const NOMBRE_CATEGORIA_POR_DEFECTO = 'Conocimiento General';

// Convención de nombres para categorías nuevas. Es el ÚNICO lugar donde se
// decide cómo se llama una colección o un índice; el resto del sistema solo
// lee el valor ya guardado en MongoDB.
const PREFIJO_INDICE = 'vector_index';

// ============================================================
// NORMALIZACIÓN
// ============================================================

// Reduce un texto a una clave comparable sin tildes ni mayúsculas.
// Se usa para emparejar roles escritos de forma distinta
// ("Contabilidad" vs "contabilidad" vs " CONTABILIDAD ") y para derivar
// el identificador y el nombre de la colección de cada categoría, que
// quedan así: "Fichas Contables" -> "fichas_contables".
function normalizarClave(valor) {
  return String(valor || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function esAdministrador(rol) {
  return normalizarClave(rol) === 'administrador';
}

// "1 archivo" / "3 archivos", para que los mensajes se lean naturales.
function plural(cantidad, palabra) {
  return `${cantidad} ${palabra}${cantidad === 1 ? '' : 's'}`;
}

function coleccionActivaDe(categoria) {
  return categoria?.coleccion;
}

function coleccionPapeleraDe(categoria) {
  if (!categoria) return null;
  return categoria.coleccionPapelera || `${categoria.coleccion}${SUFIJO_PAPELERA}`;
}

// Una colección "_papelera" jamás debe usarse como fuente de búsqueda.
function esColeccionPapelera(nombre) {
  return String(nombre || '').endsWith(SUFIJO_PAPELERA);
}

async function eliminarPapeleraVacia(nombre) {
  if (!esColeccionPapelera(nombre)) return false;

  const mongoDb = getDB();
  const existe = await mongoDb.listCollections({ name: nombre }, { nameOnly: true }).hasNext();
  if (!existe || await mongoDb.collection(nombre).countDocuments({}) > 0) return false;

  try {
    await mongoDb.collection(nombre).drop();
    console.log(`[PAPELERA] Se eliminó la colección vacía "${nombre}".`);
    return true;
  } catch (error) {
    if (error?.code === 26 || error?.codeName === 'NamespaceNotFound') return false;
    throw error;
  }
}

// ============================================================
// CATEGORÍAS
// ============================================================

// Las categorías nacen activas. El Administrador puede desactivar una desde
// el panel para dejar de usarla; una categoría desactivada no aparece en el
// RAG ni se puede marcar para ningún rol.
async function listarCategorias({ incluirInactivas = false } = {}) {
  const filtro = incluirInactivas ? {} : { activa: { $ne: false } };
  const documentos = await getDB()
    .collection(COLECCION_CATEGORIAS)
    .find(filtro)
    .sort({ nombre: 1 })
    .toArray();

  return documentos.map(normalizarCategoria);
}

function normalizarCategoria(categoria = {}) {
  return {
    ...categoria,
    id: categoria.id,
    nombre: categoria.nombre || categoria.id || 'Sin nombre',
    descripcion: categoria.descripcion || '',
    activa: categoria.activa !== false,
    // Una categoría compartida es del sistema: todos los roles la consultan
    // siempre y el Administrador no puede quitársela a nadie. Es el mismo
    // criterio que aplica a Google Drive.
    compartida: categoria.compartida === true,
    // Una categoría DEL SISTEMA ni siquiera se configura. El panel de
    // conocimiento no la muestra para editar, ni la ofrece en la matriz de
    // roles, porque no es conocimiento de la empresa que alguien pueda
    // activar, desactivar o repartir: es infraestructura que el sistema
    // administra por su cuenta.
    sistema: categoria.sistema === true,
    coleccion: coleccionActivaDe(categoria),
    coleccionPapelera: coleccionPapeleraDe(categoria),
    indiceVectorial: categoria.indiceVectorial || `${PREFIJO_INDICE}_${categoria.id}`,
  };
}

async function obtenerCategoria(id) {
  if (!id) return null;
  const documento = await getDB()
    .collection(COLECCION_CATEGORIAS)
    .findOne({ id: String(id) });
  return documento ? normalizarCategoria(documento) : null;
}

// Categoría de software y manuales técnicos que se publican desde Recursos.
//
// A diferencia de las categorías que crea cada usuario, esta es del sistema:
// la usan todos los roles sin que el Administrador tenga que marcar nada. El
// Software autorizado y sus manuales técnicos. Esta categoría es del sistema:
// siempre está activa, no se puede editar ni eliminar. Se gestiona como un módulo
// independiente (similar a Starlink) en el panel de permisos por rol.
const CATEGORIA_RECURSOS = 'software_y_manuales';
const NOMBRE_CATEGORIA_RECURSOS = 'Software y Manuales';

// Categoría general: se devuelve si ya existe y se crea sola la primera vez
// que alguien sube un archivo sin elegir categoría. Así el sistema nunca
// empieza con categorías que el Administrador no haya creado, pero la
// subida más antigua tampoco se queda sin destino. Se pasa el rol de quien
// la crea para que esa categoría quede ligada a su rol automáticamente.
async function obtenerOCrearCategoriaGeneral(creadoPor = null, rolCreador = null) {
  const existente = await obtenerCategoria(CATEGORIA_POR_DEFECTO);
  if (existente) return existente;
  return crearCategoria({
    nombre: NOMBRE_CATEGORIA_POR_DEFECTO,
    descripcion: 'Categoría compartida. Puedes renombrarla o cambiarla desde el panel.',
    creadoPor,
    rolCreador,
  });
}

// Se crea sola la primera vez que se publica un recurso. No hace falta que el
// Administrador la prepare antes: se reutiliza en todas las subidas siguientes.
async function obtenerOCrearCategoriaRecursos(creadoPor = null) {
  const existente = await obtenerCategoria(CATEGORIA_RECURSOS);
  if (existente) return existente;
  return crearCategoria({
    nombre: NOMBRE_CATEGORIA_RECURSOS,
    descripcion:
      'Software autorizado y sus manuales técnicos. Categoría del sistema: siempre activa, no se puede editar ni eliminar. El administrador solo puede configurar qué roles tienen acceso desde el panel de permisos.',
    creadoPor,
    sistema: true,
  });
}

// Resuelve la categoría solicitada en una subida. Si el cliente no envía
// ninguna, se usa la general (creándola si es la primera vez).
async function resolverCategoriaParaIngesta(idSolicitado, opciones = {}) {
  const id = String(idSolicitado || '').trim();
  if (!id) return obtenerOCrearCategoriaGeneral(opciones.creadoPor, opciones.rolCreador);

  const categoria = await obtenerCategoria(id);
  if (!categoria) {
    const error = new Error(`La categoría de conocimiento "${id}" no existe.`);
    error.status = 400;
    throw error;
  }
  if (!categoria.activa) {
    const error = new Error(`La categoría de conocimiento "${categoria.nombre}" está desactivada.`);
    error.status = 400;
    throw error;
  }

  // Quien sube un archivo en una categoría a la que su rol todavía no tiene
  // acceso queda ligado a ella. Sin esto el archivo se indexa y luego no
  // aparece en "Mis archivos" ni el rol puede consultarla en el chat, porque
  // la lista de fuentes permitidas se filtra por rol.
  if (opciones.rolCreador && !esAdministrador(opciones.rolCreador)) {
    await otorgarCategoriaARol(opciones.rolCreador, categoria.id);
  }

  return categoria;
}

// Da acceso a UNA categoría a un rol sin tocar el resto de sus permisos.
//
// Se usa `$addToSet` en vez de leer la lista y volver a guardarla por dos
// razones: `guardarPermisosRol` REEMPLAZA la lista completa, así que leer y
// volver a escribir podría pisar un permiso que otro Administrador cambió en
// paralelo; y `$addToSet` no duplica la entrada si el rol ya la tenía.
async function otorgarCategoriaARol(rol, categoriaId) {
  const id = normalizarClave(rol);
  if (!id || !categoriaId) return false;

  await getDB()
    .collection(COLECCION_PERMISOS)
    .updateOne(
      { _id: id },
      {
        $addToSet: { categorias: categoriaId },
        $set: { rol: id, actualizadoEn: new Date() },
        $setOnInsert: { modulos: { starlink: false } },
      },
      { upsert: true }
    );

  return true;
}

// Crea una categoría y deja a quien la creó con acceso a ella.
//
// Cualquier rol puede crear una categoría al subir un archivo, y no tiene
// sentido que un Administrador tenga que abrir permisos a mano para que el
// autor vea lo que acaba de subir: quedaría invisible para quien lo subió.
// Por eso el rol del creador se enlaza en el mismo momento.
//
// Al Administrador no se le escribe nada porque ya ve todas las categorías
// activas de forma automática; guardar una entrada explícita solo duplicaría
// el dato en el panel de permisos.
async function crearCategoria({ nombre, descripcion = '', creadoPor = null, rolCreador = null, compartida = false, sistema = false } = {}) {
  const nombreLimpio = String(nombre || '').trim();
  if (!nombreLimpio) {
    const error = new Error('El nombre de la categoría es obligatorio.');
    error.status = 400;
    throw error;
  }

  const id = normalizarClave(nombreLimpio);
  if (!id) {
    const error = new Error('El nombre de la categoría no es válido.');
    error.status = 400;
    throw error;
  }

  const mongoDb = getDB();
  const existente = await mongoDb
    .collection(COLECCION_CATEGORIAS)
    .findOne({ id });
  if (existente) {
    const error = new Error(`La categoría "${nombreLimpio}" ya existe.`);
    error.status = 409;
    throw error;
  }

  const categoria = {
    id,
    nombre: nombreLimpio,
    descripcion: String(descripcion || '').trim(),
    activa: true,
    // Cada fuente tiene su propia colección y su propia papelera.
    coleccion: id,
    indiceVectorial: `${PREFIJO_INDICE}_${id}`,
    creadoPor,
    rolCreador: rolCreador ? normalizarClave(rolCreador) : null,
    compartida: compartida === true,
    sistema: sistema === true,
    creadoEn: new Date(),
    actualizadoEn: new Date(),
  };

  await mongoDb.collection(COLECCION_CATEGORIAS).insertOne(categoria);

  // Una categoría compartida no necesita permiso de nadie: se agrega sola al
  // consultar las fuentes de cualquier rol.
  if (rolCreador && !esAdministrador(rolCreador) && !categoria.compartida) {
    await otorgarCategoriaARol(rolCreador, id);
  }

  return normalizarCategoria(categoria);
}

// Un nombre de colección solo puede llevar letras, números y guion bajo,
// empezar por letra o número y no superar 120 caracteres.
function validarNombreColeccion(nombre, etiqueta) {
  const limpio = String(nombre || '').trim();
  if (!limpio) {
    const error = new Error(`${etiqueta}: el nombre de la colección es obligatorio.`);
    error.status = 400;
    throw error;
  }
  if (limpio.length > 120) {
    const error = new Error(`${etiqueta}: el nombre no puede superar 120 caracteres.`);
    error.status = 400;
    throw error;
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(limpio)) {
    const error = new Error(
      `${etiqueta}: " ${limpio} " no es válido. Usa solo letras, números, guion y guion bajo, empezando por una letra.`
    );
    error.status = 400;
    throw error;
  }
  return limpio;
}

// Mueve todos los documentos de una colección a otra conservando el _id, de
// modo que el mismo archivo no se duplique al volver de la papelera.
//
// Se usa al desactivar una categoría (sus documentos pasan a su papelera) y al
// reactivarla (vuelven a la colección activa). Las colecciones "_papelera"
// nunca se leen como fuente de búsqueda, así que mientras un documento está
// allí el asistente no lo encuentra.
async function moverDocumentosAColeccion(origen, destino) {
  const vacio = { movidos: 0, origen: origen || '', destino: destino || '' };
  if (!origen || !destino || origen === destino) return vacio;

  const mongoDb = getDB();
  const existentes = new Set(
    (await mongoDb.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
  );

  if (!existentes.has(origen)) return vacio;

  const documentos = await mongoDb.collection(origen).countDocuments({});
  if (!documentos) {
    if (esColeccionPapelera(origen)) await eliminarPapeleraVacia(origen);
    return { ...vacio, origen: 0 };
  }

  if (!existentes.has(destino)) {
    try {
      await mongoDb.createCollection(destino);
    } catch (errorCrear) {
      // Si aparece justo en este momento, la colección ya existe y sirve igual.
      if (errorCrear?.codeName !== 'NamespaceExists') throw errorCrear;
    }
  }

  // `replaceOne` con upsert evita el error de clave duplicada cuando el mismo
  // _id ya quedó en la papelera de una desactivación anterior.
  const cursor = mongoDb.collection(origen).find({});
  let movidos = 0;
  for await (const documento of cursor) {
    await mongoDb.collection(destino).replaceOne({ _id: documento._id }, documento, { upsert: true });
    movidos += 1;
  }

  if (movidos) {
    await mongoDb.collection(origen).deleteMany({});
    if (esColeccionPapelera(origen)) await eliminarPapeleraVacia(origen);
  }

  return { movidos, origen: documentos, destino };
}

// Documentos de una categoría, incluyendo lo que ya está en su papelera. El
// total es lo que el Administrador borraría de verdad.
async function contarDocumentosCategoria(categoria) {
  // El conteo sale de Firestore y NO de la colección de vectores: un PDF se
  // parte en varios fragmentos al indexarse, así que en MongoDB hay más
  // documentos que archivos. Decirle a quien administra "sus 15 archivos"
  // cuando hay un único PDF sería directamente engañoso.
  //
  // Se usa el aggregation `.count()` en vez de traer los documentos porque una
  // categoría puede tener cientos de archivos y Firestore solo devuelve 1000.
  const vacio = { visibles: 0, enPapelera: 0, total: 0 };
  if (!categoria?.id || !firestore) return vacio;

  const base = firestore.collection(COLECCION_ARCHIVOS).where('categoriaId', '==', categoria.id);
  const [total, papelera] = await Promise.all([
    base.count().get(),
    base.where('eliminado', '==', true).count().get(),
  ]);

  const archivos = total.data()?.count || 0;
  const enPapelera = papelera.data()?.count || 0;

  return { visibles: archivos - enPapelera, enPapelera, total: archivos };
}

// ------------------------------------------------------------------
// PAPELERA DE LOS ARCHIVOS DE UNA CATEGORÍA
// ------------------------------------------------------------------
//
// El sistema tiene dos papeleras que hasta ahora iban por separado:
//   1. la colección de MongoDB "<coleccion>_papelera", que saca el
//      contenido del alcance del asistente;
//   2. la papelera visible de Archivos, que se alimenta de los documentos de
//      Firestore marcados con `eliminado: true`.
//
// Desactivar una categoría tenía que mover los vectores a la primera, pero
// dejaba los archivos visibles en Archivos y la papelera vacía. Aquí se
// mantienen las dos sincronizadas para que el Administrador vea siempre lo
// mismo en ambos lugares.
//
// Se marcan con `eliminadoPorCategoria` para poder distinguirlos de los que
// alguien borró a mano: al reactivar la categoría solo se recuperan estos,
// y los borrados manuales siguen en la papelera hasta que se purguen.
//
// `usuario` es quien pulsó el interruptor. Se guarda su nombre para que la
// papelera muestre "Eliminado por: <persona>": el cambio se atribuye a una
// persona, no a un texto técnico sobre la categoría.

async function moverArchivosDeCategoria(categoria, vanAPapelera, usuario = null) {
  if (!categoria?.id || !firestore) return 0;

  const snapshot = await firestore
    .collection(COLECCION_ARCHIVOS)
    .where('categoriaId', '==', categoria.id)
    .get();

  const quien = {
    eliminadoPor: usuario?.uid || null,
    eliminadoPorNombre: usuario?.nombre || 'Administrador',
  };

  const cambios = [];
  for (const documento of snapshot.docs) {
    const datos = documento.data();

    if (vanAPapelera) {
      // Los que ya estaban en la papelera no se tocan: su fecha y su autor
      // original deben conservarse.
      if (datos.eliminado === true) continue;
      cambios.push([
        documento.ref,
        {
          ...quien,
          eliminado: true,
          eliminadoPorCategoria: true,
          eliminadoEn: new Date(),
        },
      ]);
    } else if (datos.eliminado === true && datos.eliminadoPorCategoria === true) {
      // Solo se recuperan los que puso la categoría; un archivo borrado a mano
      // permanece en la papelera.
      cambios.push([
        documento.ref,
        {
          eliminado: false,
          eliminadoPorCategoria: false,
          eliminadoPor: null,
          eliminadoPorNombre: null,
          eliminadoEn: null,
        },
      ]);
    }
  }

  for (let inicio = 0; inicio < cambios.length; inicio += LOTE_FIRESTORE) {
    const lote = firestore.batch();
    for (const [referencia, valores] of cambios.slice(inicio, inicio + LOTE_FIRESTORE)) {
      lote.set(referencia, valores, { merge: true });
    }
    await lote.commit();
  }

  return cambios.length;
}

// Elimina por completo una colección de MongoDB. No falla si no existe.
async function eliminarColeccion(nombre) {
  if (!nombre) return false;
  try {
    await getDB().collection(nombre).drop();
    return true;
  } catch (error) {
    // 26 = NamespaceNotFound: ya estaba eliminada.
    if (error?.code === 26) return false;
    throw error;
  }
}

// Renombra en Atlas la colección física y su papelera.
//
// Renombrar una colección en MongoDB conserva los documentos, pero Atlas
// descarta el índice vectorial de la colección renombrada. Por eso el
// resultado avisa de que hay que volver a crear el índice con el nombre
// que ahora guarda la categoría.
async function renombrarColeccionEnAtlas(origen, destino) {
  if (origen === destino) return { renombrada: false, documentos: 0, advertencias: [] };

  const mongoDb = getDB();
  const advertencias = [];

  const existentes = new Set(
    (await mongoDb.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
  );

  if (existentes.has(destino)) {
    const error = new Error(
      `Ya existe una colección llamada "${destino}". Elige otro nombre para la colección de vectores.`
    );
    error.status = 409;
    throw error;
  }

  if (!existentes.has(origen)) {
    // Todavía no se subió nada a esta categoría: no hay nada que renombrar.
    return { renombrada: false, documentos: 0, advertencias };
  }

  const documentos = await mongoDb.collection(origen).countDocuments({});

  // El driver 7 ya no expone collection.renameCollection(), así que se usa
  // el comando de administración, que es el mismo por debajo.
  try {
    await mongoDb.admin().command({
      renameCollection: `${mongoDb.databaseName}.${origen}`,
      to: `${mongoDb.databaseName}.${destino}`,
      dropTarget: false,
    });
  } catch (fallo) {
    // 48 = NamespaceExists: el destino ya está ocupado.
    if (fallo.code === 48) {
      const error = new Error(
        `Ya existe una colección llamada "${destino}". Elige otro nombre para la colección de vectores.`
      );
      error.status = 409;
      throw error;
    }
    const error = new Error(
      `No se pudo renombrar "${origen}" a "${destino}" en MongoDB: ${fallo.message}`
    );
    error.status = 500;
    throw error;
  }

  advertencias.push(
    `Se renombró la colección "${origen}" a "${destino}" y se conservaron sus ${documentos} documentos. La categoría sigue funcionando con normalidad.`
  );

  return { renombrada: true, documentos, advertencias };
}

// ============================================================
// EDICIÓN DE CATEGORÍAS
// ============================================================

// `usuario` es quien hizo el cambio. Solo se usa para registrar en la papelera
// el nombre de la persona, no para autorizar: eso lo hace el endpoint, que
// exige rol de Administrador.
async function actualizarCategoria(id, cambios = {}, usuario = null) {
  const actual = await obtenerCategoria(id);
  if (!actual) {
    const error = new Error('Categoría no encontrada.');
    error.status = 404;
    throw error;
  }

  // Las categorías del sistema las administra el código, no el panel. Se
  // bloquea aquí y no solo en la interfaz: si alguien llama al endpoint a mano
  // tampoco debe poder desactivarlas ni mandar su contenido a la papelera.
  if (actual.sistema === true) {
    const error = new Error(
      'Esta categoría la administra el sistema y no se puede modificar.'
    );
    error.status = 409;
    throw error;
  }

  const actualizacion = { actualizadoEn: new Date() };
  const advertencias = [];

  if (typeof cambios.nombre === 'string' && cambios.nombre.trim()) {
    actualizacion.nombre = cambios.nombre.trim();
  }
  if (cambios.descripcion !== undefined) {
    actualizacion.descripcion = String(cambios.descripcion || '').trim();
  }

  const activaSolicitada = cambios.activa === undefined ? null : cambios.activa !== false;
  if (activaSolicitada !== null) actualizacion.activa = activaSolicitada;

  // --- Cambio del nombre de la colección -------------------------------
  const coleccionSolicitada = cambios.coleccion === undefined ? null : validarNombreColeccion(cambios.coleccion, 'Colección de vectores');

  if (coleccionSolicitada && coleccionSolicitada !== actual.coleccion) {
    const papeleraDestino = `${coleccionSolicitada}${SUFIJO_PAPELERA}`;
    const resultado = await renombrarColeccionEnAtlas(actual.coleccion, coleccionSolicitada);

    // La papelera sigue a la colección para no dejar el par descuadrado.
    const papeleraActual = actual.coleccionPapelera;
    advertencias.push(...resultado.advertencias);

    try {
      await renombrarColeccionEnAtlas(papeleraActual, papeleraDestino);
    } catch (falloPapelera) {
      advertencias.push(
        `La papelera "${papeleraActual}" no se pudo renombrar a "${papeleraDestino}": ${falloPapelera.message}`
      );
    }

    actualizacion.coleccion = coleccionSolicitada;
    actualizacion.coleccionPapelera = papeleraDestino;
    actualizacion.indiceVectorial = `${PREFIJO_INDICE}_${coleccionSolicitada}`;
  }

  // --- Activar / desactivar -------------------------------------------
  // Desactivar no basta con ocultar la categoría. Pasa por las dos
  // papeleras del sistema:
  //   1. los vectores de "<coleccion>" van a "<coleccion>_papelera", con lo
  //      cual el asistente deja de encontrar ese contenido;
  //   2. los archivos de Archivos se marcan como eliminados y aparecen en la
  //      papelera visible, que antes quedaba vacía.
  // Al reactivar ocurre exactamente lo contrario y solo se recuperan los
  // archivos que había puesto la categoría, nunca los borrados a mano.
  if (activaSolicitada !== null && activaSolicitada !== actual.activa) {
    const coleccionActual = actualizacion.coleccion || actual.coleccion;
    const papeleraActual = actualizacion.coleccionPapelera || actual.coleccionPapelera;

    const movimiento = activaSolicitada
      ? await moverDocumentosAColeccion(papeleraActual, coleccionActual)
      : await moverDocumentosAColeccion(coleccionActual, papeleraActual);

    const archivos = await moverArchivosDeCategoria(
      { ...actual, ...actualizacion },
      !activaSolicitada,
      usuario
    );

    // El mensaje cuenta ARCHIVOS, no los fragmentos en que se dividen al
    // indexarse. Un PDF genera muchos vectores, así que `movimiento.movidos`
    // nunca debe usarse como cifra visible: para quien administra sería
    // engañoso. Los vectores solo se mueven en silencio.
    if (archivos > 0) {
      const uno = archivos === 1;
      advertencias.push(
        activaSolicitada
          ? `Se ${uno ? 'restauró' : 'restauraron'} ${plural(archivos, 'archivo')} de la papelera y la categoría vuelve a estar disponible.`
          : `Se ${uno ? 'envió' : 'enviaron'} ${plural(archivos, 'archivo')} a la papelera. El asistente ya no ${uno ? 'lo' : 'los'} encuentra y ${uno ? 'vuelve' : 'se recuperan'} al reactivar la categoría.`
      );
    } else if (movimiento.movidos > 0) {
      advertencias.push(
        activaSolicitada
          ? 'Se restauró el contenido de la categoría y vuelve a estar disponible.'
          : 'Se retiró el contenido de la categoría de la búsqueda del asistente.'
      );
    }
  }

  await getDB()
    .collection(COLECCION_CATEGORIAS)
    .updateOne({ id: actual.id }, { $set: actualizacion });

  // Los avisos viajan en la respuesta, no dentro del documento: son
  // resultado de esta operación concreta, no parte de la categoría.
  return { ...(await obtenerCategoria(actual.id)), avisos: advertencias };
}

// ============================================================
// ELIMINACIÓN DE CATEGORÍAS
// ============================================================

// EliminarCategoria elimina la categoría y, según `eliminarDocumentos`, todo
// lo que contiene.
//
// - Con eliminarDocumentos = true se borran la colección activa y su papelera:
//   los documentos y el índice vectorial desaparecen y no hay vuelta atrás.
//   También se borran los archivos de Firestore de la categoría, para no dejar
//   documentos huérfanos apuntando a una categoría que ya no existe.
// - Con eliminarDocumentos = false solo se retira la categoría y sus documentos
//   quedan a salvo en su papelera por si hay que recuperarlos.
//
// En ambos casos se quita la categoría de los permisos de todos los roles,
// porque si no quedarían apuntando a una categoría inexistente.
async function eliminarCategoria(id, { eliminarDocumentos = true } = {}) {
  const categoria = await obtenerCategoria(id);
  if (!categoria) {
    const error = new Error('Categoría no encontrada.');
    error.status = 404;
    throw error;
  }

  // Igual que al actualizar: si la categoría es del sistema no se borra.
  if (categoria.sistema === true) {
    const error = new Error(
      'Esta categoría la administra el sistema y no se puede eliminar.'
    );
    error.status = 409;
    throw error;
  }

  const mongoDb = getDB();
  const enPapelera = [];

  if (eliminarDocumentos) {
    await eliminarColeccion(categoria.coleccion);
    await eliminarColeccion(categoria.coleccionPapelera);

    const snapshot = await firestore
      .collection(COLECCION_ARCHIVOS)
      .where('categoriaId', '==', categoria.id)
      .get();

    for (let inicio = 0; inicio < snapshot.docs.length; inicio += LOTE_FIRESTORE) {
      const lote = firestore.batch();
      for (const documento of snapshot.docs.slice(inicio, inicio + LOTE_FIRESTORE)) {
        lote.delete(documento.ref);
      }
      await lote.commit();
    }
  } else {
    const movimiento = await moverDocumentosAColeccion(categoria.coleccion, categoria.coleccionPapelera);
    enPapelera.push(movimiento.movidos);
  }

  await mongoDb
    .collection(COLECCION_PERMISOS)
    .updateMany({ categorias: categoria.id }, { $pull: { categorias: categoria.id } });

  await mongoDb.collection(COLECCION_CATEGORIAS).deleteOne({ id: categoria.id });

  return {
    id: categoria.id,
    nombre: categoria.nombre,
    documentosEnPapelera: enPapelera[0] || 0,
    mensaje: eliminarDocumentos
      ? `Se eliminó la categoría "${categoria.nombre}" y todos sus documentos.`
      : `Se eliminó la categoría "${categoria.nombre}". Sus documentos quedaron en la papelera.`,
  };
}

// ============================================================
// PERMISOS POR ROL
// ============================================================

async function obtenerPermisosRol(rol) {
  const id = normalizarClave(rol);
  if (!id) return { rol: '', categorias: [], modulos: { starlink: false, software_y_manuales: false }, configurado: false };

  const documento = await getDB()
    .collection(COLECCION_PERMISOS)
    .findOne({ _id: id });

  if (!documento) {
    // software_y_manuales está activado por defecto para todos los roles nuevos
    return { rol: id, categorias: [], modulos: { starlink: false, software_y_manuales: true }, configurado: false };
  }

  return {
    rol: id,
    categorias: Array.isArray(documento.categorias) ? documento.categorias : [],
    modulos: {
      starlink: documento?.modulos?.starlink === true,
      software_y_manuales: documento?.modulos?.software_y_manuales === true,
    },
    configurado: true,
  };
}

async function guardarPermisosRol(rol, { categorias = [], modulos = {} } = {}) {
  const id = normalizarClave(rol);
  if (!id) {
    const error = new Error('El rol es obligatorio.');
    error.status = 400;
    throw error;
  }

  const categoriasValidas = await listarCategorias({ incluirInactivas: true });
  const categoriasLimpias = [
    ...new Set(categorias.map((valor) => String(valor || '').trim()).filter(Boolean)),
  ].filter((valor) => categoriasValidas.some((categoria) => categoria.id === valor));

  await getDB()
    .collection(COLECCION_PERMISOS)
    .updateOne(
      { _id: id },
      {
        $set: {
          rol: id,
          categorias: categoriasLimpias,
          modulos: {
            starlink: modulos?.starlink === true,
            software_y_manuales: modulos?.software_y_manuales === true,
          },
          actualizadoEn: new Date(),
        },
      },
      { upsert: true }
    );

  return {
    rol: id,
    categorias: categoriasLimpias,
    modulos: {
      starlink: modulos?.starlink === true,
      software_y_manuales: modulos?.software_y_manuales === true,
    },
  };
}

// Fuentes RAG habilitadas para un rol.
//
// - Las categorías COMPARTIDAS se agregan siempre, para todos los roles, sin
//   mirar permisos: son contenido del sistema (hoy, software y manuales).
//   Equivale a lo que ya hacía Google Drive.
// - El Administrador recibe TODAS las categorías activas: si se crea una
//   categoría nueva, tiene acceso automáticamente sin marcar nada.
// - Los demás roles solo reciben las categorías marcadas por el
//   Administrador, sin ninguna condición hardcodeada por nombre de rol.
// - Las categorías desactivadas y las colecciones "_papelera" se descartan.
async function obtenerFuentesPermitidas(rol) {
  const categorias = await listarCategorias({ incluirInactivas: true });
  const marcadas = esAdministrador(rol)
    ? categorias
    : (await obtenerPermisosRol(rol)).categorias;

  const permitidas = new Set(
    categorias.filter((categoria) => categoria.compartida).map((categoria) => categoria.id)
  );
  marcadas.forEach((id) => permitidas.add(typeof id === 'string' ? id : id?.id));

  return categorias
    .filter((categoria) => permitidas.has(categoria.id))
    .filter(
      (categoria) =>
        categoria.activa &&
        categoria.coleccion &&
        !esColeccionPapelera(categoria.coleccion)
    );
}

// ============================================================
// ACCESO A MÓDULOS (STARLINK Y SOFTWARE_Y_MANUALES)
// ============================================================
//
// Starlink y Software y Manuales NO son categorías de conocimiento:
// son módulos independientes del sistema de ingestión de documentos.
// Solo se controla si un rol puede entrar a ellos.
// ============================================================

async function puedeAccederModulo(rol, modulo) {
  if (esAdministrador(rol)) return true;
  const permisos = await obtenerPermisosRol(rol);
  return permisos.modulos?.[modulo] === true;
}

// ============================================================
// MATRIZ COMPLETA (PARA EL PANEL DEL ADMINISTRADOR)
// ============================================================

async function listarRolesExistentes() {
  const snapshot = await firestore.collection('users').get();
  const roles = new Set();
  snapshot.forEach((documento) => {
    const rol = String(documento.data()?.rol || '').trim();
    if (rol) roles.add(rol);
  });
  return [...roles].sort((a, b) => a.localeCompare(b, 'es'));
}

async function obtenerMatrizPermisos() {
  const [categoriasBase, roles, indices] = await Promise.all([
    listarCategorias({ incluirInactivas: true }),
    listarRolesExistentes(),
    descubrirIndicesVectoriales(),
  ]);

  // El panel muestra qué categorías están realmente consultables: una
  // categoría sin índice en Atlas guarda documentos, pero el chat la omite.
  // El conteo solo se calcula aquí, que es donde el Administrador va a borrar:
  // en el resto de llamadas (por ejemplo en cada consulta del chat) sería un
  // gasto sin ningún propósito.
  //
  // Las categorías DEL SISTEMA se quedan fuera del panel: no son conocimiento
  // que alguien pueda repartir entre roles, así que no tiene sentido listarlas
  // como una opción más ni marcarlas como "compartidas".
  const categorias = await Promise.all(
    categoriasBase
      .filter((categoria) => categoria.sistema !== true)
      .map(async (categoria) => ({
        ...categoria,
        tieneIndice: indices.has(categoria.coleccion),
        documentos: await contarDocumentosCategoria(categoria),
      }))
  );

  const permisos = await Promise.all(
    roles.map(async (rol) => {
      const configuracion = await obtenerPermisosRol(rol);
      return {
        rol,
        clave: configuracion.rol,
        categorias: configuracion.categorias,
        modulos: configuracion.modulos,
        configurado: configuracion.configurado,
      };
    })
  );

  return { categorias, roles: permisos };
}

// ============================================================
// DESCUBRIMIENTO DE COLECCIONES E ÍNDICES
// ============================================================
//
// Las colecciones de vectores y sus índices de Atlas se descubren leyendo
// la propia base de datos. El código nunca nombra una colección: solo la
// convención para crear las nuevas.
//
// Esto permite que una fuente creada antes de este módulo (la que usa el
// sistema desde su inicio) se asocie automáticamente a su categoría sin
// renombrar nada ni mover un solo vector.

// Devuelve, para cada colección que ya tiene índice vectorial en Atlas, el
// nombre real de ese índice.
async function descubrirIndicesVectoriales() {
  const mongoDb = getDB();
  const colecciones = await mongoDb.listCollections({}, { nameOnly: true }).toArray();
  const discovered = new Map();

  for (const { name } of colecciones) {
    try {
      const indices = await mongoDb.collection(name).listSearchIndexes().toArray();
      const vectorial = indices.find((indice) => indice.type === 'vectorSearch');
      if (vectorial?.name) discovered.set(name, vectorial.name);
    } catch {
      // Sin permiso de Atlas Search o sin índice: se ignora la colección.
    }
  }

  return discovered;
}

// Colecciones de vectores que existen hoy, con su índice y su papelera
// asociada. Sirve para mostrar el estado real en el panel del Administrador
// y para saber qué fuentes hay ya publicadas.
async function listarColeccionesVectoriales() {
  const indices = await descubrirIndicesVectoriales();
  const declarada = new Set(
    (await listarCategorias({ incluirInactivas: true })).map((categoria) => categoria.coleccion)
  );

  return [...indices.entries()]
    .map(([coleccion, indice]) => ({
      coleccion,
      indiceVectorial: indice,
      coleccionPapelera: coleccion.endsWith(SUFIJO_PAPELERA)
        ? coleccion
        : `${coleccion}${SUFIJO_PAPELERA}`,
      esPapelera: coleccion.endsWith(SUFIJO_PAPELERA),
      declaradaPorCategoria: declarada.has(coleccion),
    }))
    .sort((a, b) => a.coleccion.localeCompare(b.coleccion));
}

// ============================================================
// ARRANQUE
// ============================================================

// El sistema arranca sin categorías: las crea el Administrador desde el
// panel. Esta función solo avisa por consola cuántas hay para que quede
// constancia en el log de arranque, y descubre las colecciones de
// vectores que ya existan en Atlas.
async function inicializarRag() {
  const total = await getDB().collection(COLECCION_CATEGORIAS).countDocuments();
  const indices = await descubrirIndicesVectoriales();

  if (total === 0) {
    console.log('[RAG] Sin categorías de conocimiento. Crea la primera desde el panel de administración.');
  } else {
    console.log(`[RAG] Categorías de conocimiento disponibles: ${total}`);
  }
console.log(`[RAG] Colecciones con índice vectorial en Atlas: ${indices.size}`);

  // Migración: Actualizar software_y_manuales para funcionar como módulo (como Starlink)
  // - sistema: true (no se puede editar/eliminar)
  // - compartida: false (no es automático para todos)
  // - Activado por defecto para todos los roles (a diferencia de Starlink)
  // - Migrar permisos de categoría a módulo por rol
  try {
    const categoriaRecursos = await obtenerCategoria(CATEGORIA_RECURSOS);
    if (categoriaRecursos) {
      const necesitaActualizacion = categoriaRecursos.compartida === true || categoriaRecursos.sistema !== true;

      if (necesitaActualizacion) {
        // Obtener todos los roles existentes para migrar sus permisos
        const rolesExistentes = await listarRolesExistentes();

        await getDB().collection(COLECCION_CATEGORIAS).updateOne(
          { id: CATEGORIA_RECURSOS },
          {
            $set: {
              compartida: false,
              sistema: true,
              descripcion: 'Software autorizado y sus manuales técnicos. Categoría del sistema: siempre activa, no se puede editar ni eliminar. Se gestiona como módulo independiente en el panel de permisos por rol. Activado por defecto para todos los roles.',
              actualizadoEn: new Date()
            }
          }
        );

        // Migrar permisos: quitar de categorías y agregar a módulos
        // A diferencia de Starlink, software_y_manuales se activa por defecto para todos
        for (const rol of rolesExistentes) {
          if (!esAdministrador(rol)) {
            try {
              const permisos = await obtenerPermisosRol(rol);
              const tieneAccesoComoCategoria = permisos.categorias?.includes(CATEGORIA_RECURSOS);

              // Quitar de categorías si estaba allí
              if (tieneAccesoComoCategoria) {
                await getDB().collection(COLECCION_PERMISOS).updateOne(
                  { rol: normalizarClave(rol) },
                  { $pull: { categorias: CATEGORIA_RECURSOS } }
                );
              }

              // Activar módulo por defecto para todos los roles
              await getDB().collection(COLECCION_PERMISOS).updateOne(
                { rol: normalizarClave(rol) },
                { $set: { 'modulos.software_y_manuales': true } },
                { upsert: true }
              );

              console.log(`[RAG] Migración: Módulo "${CATEGORIA_RECURSOS}" activado por defecto para rol "${rol}"`);
            } catch (error) {
              console.error(`[RAG] Error migrando permisos para rol "${rol}":`, error.message);
            }
          }
        }

        console.log(`[RAG] Migración: Categoría "${CATEGORIA_RECURSOS}" actualizada como módulo activado por defecto.`);
      }
    }
  } catch (error) {
    console.error('[RAG] Error en migración de software_y_manuales:', error.message);
  }

  return total;
}

module.exports = {
  CATEGORIA_POR_DEFECTO,
  COLECCION_CATEGORIAS,
  COLECCION_PERMISOS,
  SUFIJO_PAPELERA,
  actualizarCategoria,
  crearCategoria,
  descubrirIndicesVectoriales,
  eliminarCategoria,
  eliminarPapeleraVacia,
  esAdministrador,
  esColeccionPapelera,
  listarCategorias,
  listarColeccionesVectoriales,
  listarRolesExistentes,
  normalizarClave,
  obtenerCategoria,
  obtenerFuentesPermitidas,
  otorgarCategoriaARol,
  obtenerOCrearCategoriaRecursos,
  obtenerMatrizPermisos,
  obtenerPermisosRol,
  puedeAccederModulo,
  resolverCategoriaParaIngesta,
  guardarPermisosRol,
  inicializarRag,
  validarNombreColeccion,
};
