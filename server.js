
// server.js
// ==== Dependencias ====
const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const fse        = require('fs-extra');
const cron       = require('node-cron');
const bodyParser = require('body-parser');
const moment     = require('moment-timezone');
const sqlite3    = require('sqlite3').verbose();

const app  = express();

// ==== Config básica Render ====
const PORT     = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || __dirname; // en Render usa /data si lo configuras

// ==== Rutas de archivos ====
const PATHS = {
  dbDir:      path.join(DATA_DIR, 'db'),
  dbFile:     path.join(DATA_DIR, 'db', 'dev.db'),
  marcajes:   path.join(DATA_DIR, 'marcajes.json'),
  users:      path.join(DATA_DIR, 'users.json'),
  admins:     path.join(DATA_DIR, 'admins.json'),
  backupsDir: path.join(DATA_DIR, 'backups')
};

// ==== Helpers de FS seguros ====
function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* noop */ }
}

function ensureJsonSync(filePath, fallback = '[]') {
  try {
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, fallback, 'utf8');
  } catch (e) {
    console.error('ensureJsonSync error:', e);
  }
}

function readJsonSafe(filePath, fallback = []) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('writeJsonSafe error:', e);
    return false;
  }
}

function getRealIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').toString();
  return (xff.split(',')[0] || req.ip || '').trim();
}

// ==== Crear carpetas/archivos base ====
ensureDirSync(PATHS.dbDir);
ensureDirSync(PATHS.backupsDir);
ensureJsonSync(PATHS.marcajes, '[]');
ensureJsonSync(PATHS.users, '[]');
ensureJsonSync(PATHS.admins, '[]');

// ==== Confía en el proxy (Render) para IP real ====
app.set('trust proxy', true);

// ==== DB SQLite y esquema ====
const db = new sqlite3.Database(PATHS.dbFile);
db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS registros (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT,
      tipo TEXT,
      fecha TEXT,
      hora TEXT,
      ip TEXT,
      departamento TEXT
    );`,
    (err) => {
      if (err) console.error('Error creando tabla SQLite:', err.message);
      else console.log('SQLite OK: tabla registros lista');
    }
  );
});

// ==== Middlewares ====
app.use(bodyParser.json());

// Bloquea acceso público a JSON/DB por seguridad (antes de estáticos)
app.use((req, res, next) => {
  if (/\.(json|db)$/i.test(req.path)) return res.status(403).send('Forbidden');
  next();
});

// Sirve estáticos (primero /public; luego raíz del repo si tienes html sueltos)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname))); // por eso bloqueamos .json/.db arriba

// ==== Endpoints de salud / ping ====
app.get('/health',  (req, res) => res.send('ok'));
app.get('/healthz', (req, res) => res.send('OK'));
app.get('/api/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ====== Geocerca (Informacion de las sucursales Lat, Long) ======
const OFFICES = [
  { id: 'TX-116',  name: 'Sede 1 - Quickstop',  lat: 29.71694, lng: -95.48804, radiusMeters: 150 },
  { id: 'TX-117',  name: 'Sede 2 - Rosemberg',  lat: 29.57039, lng: -95.77575, radiusMeters: 150 },
  { id: 'TX-1293', name: 'Sede 3 - South West', lat: 29.70031, lng: -95.28904, radiusMeters: 150 },
  { id: 'TX-1386', name: 'Sede 4 - LongPoint',  lat: 29.79806, lng: -95.52474, radiusMeters: 150 },
  { id: 'TX-1615', name: 'Sede 5 - Rampart',    lat: 29.71948, lng: -95.48853, radiusMeters: 150 },
  { id: 'TX-839',  name: 'Sede 6 - Rosemberg C',lat: 29.55853, lng: -95.80851, radiusMeters: 150 },
  { id: 'TX-845',  name: 'Sede 7 - Airline',    lat: 29.89497, lng: -95.39804, radiusMeters: 150 },
  { id: 'TX-1544', name: 'Sede 8 - Fry',        lat: 29.79521, lng: -95.71863, radiusMeters: 150 },
  { id: 'TX-104',  name: 'Sede 9 - Fulton',     lat: 29.83249, lng: -95.37564, radiusMeters: 150 },
  { id: 'TX-101',  name: 'Sede 10 - Office',    lat: 29.74978, lng: -95.48319, radiusMeters: 150 },
];

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function findGeofence(lat, lng) {
  for (const g of OFFICES) {
    const d = distanceMeters(lat, lng, g.lat, g.lng);
    if (d <= g.radiusMeters) return { ...g, distance: d, inside: true };
  }
  return { inside: false };
}

// true = bloquea si está fuera; false = permite pero etiqueta "(fuera de geocerca)"
const MODO_ESTRICTO = false;

// ==== Backups (automático 23:00 y manual) ====
cron.schedule('0 23 * * *', () => {
  const fecha = new Date().toISOString().split('T')[0];
  try {
    fse.copySync(PATHS.marcajes, path.join(PATHS.backupsDir, `marcajes-${fecha}.json`));
  } catch (e) { console.error('[Backup JSON] Error:', e.message); }
  try {
    fse.copySync(PATHS.dbFile, path.join(PATHS.backupsDir, `dev-${fecha}.db`));
  } catch (e) { console.error('[Backup DB] Error:', e.message); }
  console.log(`[Backup] Copias completadas: ${fecha}`);
});

app.get('/api/backup-now', (req, res) => {
  const fecha = new Date().toISOString().split('T')[0];
  try {
    fse.copySync(PATHS.marcajes, path.join(PATHS.backupsDir, `marcajes-${fecha}.json`));
    fse.copySync(PATHS.dbFile, path.join(PATHS.backupsDir, `dev-${fecha}.db`));
    console.log(`[Backup manual] Copia creada: ${fecha}`);
    res.json({ success: true, mensaje: 'Backup creado correctamente.' });
  } catch (err) {
    console.error('[Backup manual] Error:', err);
    res.status(500).json({ success: false, mensaje: 'Error al crear el backup.' });
  }
});

// ==== Auth/Admin/Usuarios ====
app.post('/api/admin-login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    const admins = readJsonSafe(PATHS.admins, []);
    const valid  = admins.some(a => a.username === username && a.password === password);
    res.json({ success: !!valid });
  } catch (e) {
    console.error('admin-login error:', e);
    res.status(500).json({ success: false });
  }
});

app.post('/api/crear-usuario', (req, res) => {
  try {
    const users = readJsonSafe(PATHS.users, []);
    if (users.some(u => u.usuario === req.body.usuario)) {
      return res.json({ success: false, mensaje: 'Usuario ya existe.' });
    }
    const nuevoUsuario = {
      nombre: req.body.nombre,
      usuario: req.body.usuario,
      contrasena: req.body.contrasena,
      departamento: req.body.departamento,
      activo: true,
      estado: 'Activo',
      fecha_creacion: req.body.fecha_creacion || new Date().toISOString(),
      fecha_baja: null
    };
    users.push(nuevoUsuario);
    writeJsonSafe(PATHS.users, users);
    res.json({ success: true, mensaje: 'Usuario creado correctamente.' });
  } catch (e) {
    console.error('crear-usuario error:', e);
    res.status(500).json({ success: false });
  }
});

app.post('/api/login-usuario', (req, res) => {
  try {
    const users = readJsonSafe(PATHS.users, []);
    const u = users.find(u =>
      u.usuario === req.body.usuario &&
      u.contrasena === req.body.contrasena &&
      u.activo !== false
    );
    res.json(u ? { success: true, departamento: u.departamento } : { success: false });
  } catch (e) {
    console.error('login-usuario error:', e);
    res.status(500).json({ success: false });
  }
});

// ==== Marcaje ====
app.post('/api/marcar', (req, res) => {
  try {
    let all = readJsonSafe(PATHS.marcajes, []);

    const now       = moment().tz('America/Chicago');
    const fechaHoy  = now.format('YYYY-MM-DD');
    const hora      = now.format('HH:mm:ss');

    const usuario      = req.body.usuario;
    const tipo         = req.body.tipo;
    const departamento = req.body.departamento || '';
    const ip           = getRealIp(req);

    // Ubicación del front
    const location = req.body.location || {};
    const lat = (typeof location.lat === 'number') ? location.lat : null;
    const lng = (typeof location.lng === 'number') ? location.lng : null;
    const accuracy = (typeof location.accuracy === 'number') ? location.accuracy : null;

    if (lat === null || lng === null) {
      return res.status(400).json({ success: false, mensaje: 'Faltan coordenadas. Debes permitir la ubicación para marcar.' });
    }

    const gf = findGeofence(lat, lng);
    if (MODO_ESTRICTO && !gf.inside) {
      return res.status(403).json({ success: false, mensaje: 'Marcaje rechazado: estás fuera del área permitida.' });
    }

    // Auto-salida 20:00 del día anterior, si aplica
    const fechaAyer = moment(now).subtract(1, 'day').format('YYYY-MM-DD');
    const registrosAyer = all.filter(r => r.usuario === usuario && r.fecha === fechaAyer);
    const huboEntrada = registrosAyer.some(r => r.tipo === 'entrada');
    const huboSalida  = registrosAyer.some(r => r.tipo === 'salida');

    let advertencia = '';
    if (huboEntrada && !huboSalida) {
      const autoSalida = {
        usuario, tipo: 'salida', fecha: fechaAyer, hora: '20:00:00',
        ip, departamento,
        lat: null, lng: null, accuracy: null,
        insideGeofence: null, geofenceId: null, geofenceName: null, distanceToCenterM: null,
        auto: true,
        userAgent: req.headers['user-agent'] || null
      };
      all.push(autoSalida);
      writeJsonSafe(PATHS.marcajes, all);
      db.run(
        `INSERT INTO registros (usuario, tipo, fecha, hora, ip, departamento) VALUES (?, ?, ?, ?, ?, ?)`,
        [usuario, 'salida', fechaAyer, '20:00:00', ip, departamento],
        (err) => { if (err) console.error('SQLite auto-salida:', err.message); }
      );
      advertencia = '⚠️ Se detectó que ayer no se marcó salida. Se registró una salida automática a las 20:00.';
    }

    // Evita duplicado de tipo en el día
    const yaMarcadoHoy = all.some(r => r.usuario === usuario && r.fecha === fechaHoy && r.tipo === tipo);
    if (yaMarcadoHoy) {
      return res.json({ success: false, mensaje: `Ya registraste una marcación de tipo "${tipo}" hoy. No puedes repetirla.` });
    }

    // Máximo 4 marcajes por día
    const count = all.filter(x => x.usuario === usuario && x.fecha === fechaHoy).length;
    if (count >= 4) {
      return res.json({ success: false, mensaje: 'Su turno ya terminó.' });
    }

    const nuevoMarcaje = {
      usuario, tipo, fecha: fechaHoy, hora, ip, departamento,
      lat, lng, accuracy,
      insideGeofence: gf.inside,
      geofenceId: gf.inside ? gf.id : null,
      geofenceName: gf.inside ? gf.name : null,
      distanceToCenterM: gf.distance ? Math.round(gf.distance) : null,
      userAgent: req.headers['user-agent'] || null
    };

    all.push(nuevoMarcaje);
    writeJsonSafe(PATHS.marcajes, all);

    db.run(
      `INSERT INTO registros (usuario, tipo, fecha, hora, ip, departamento) VALUES (?, ?, ?, ?, ?, ?)`,
      [usuario, tipo, fechaHoy, hora, ip, departamento],
      (err) => { if (err) console.error('SQLite insertar:', err.message); }
    );

    const suffix = (!MODO_ESTRICTO && !gf.inside) ? ' (fuera de geocerca)' : '';
    const mensajeFinal = (advertencia ? `${advertencia}\n` : '') + `Marcaje de ${tipo} registrado a las ${hora}.`;

    res.json({
      success: true,
      mensaje: mensajeFinal + suffix,
      insideGeofence: gf.inside,
      geofence: gf.inside ? { id: gf.id, name: gf.name, distanceM: Math.round(gf.distance) } : null
    });
  } catch (e) {
    console.error('POST /api/marcar error:', e);
    res.status(500).json({ success: false, mensaje: 'Error interno en marcaje.' });
  }
});

// ==== Reportes / Usuarios activos/inactivos ====
app.get('/api/reporte', (req, res) => {
  try {
    const usuario = req.query.usuario;
    const users = readJsonSafe(PATHS.users, []);
    const user = users.find(u => u.usuario === usuario);
    if (!user || user.activo !== true) return res.json([]);
    const all = readJsonSafe(PATHS.marcajes, []);
    res.json(all.filter(x => x.usuario === usuario));
  } catch (e) {
    console.error('GET /api/reporte error:', e);
    res.status(500).json([]);
  }
});

app.get('/api/empleados', (req, res) => {
  try {
    const users = readJsonSafe(PATHS.users, []);
    res.json(users.filter(u => u.activo !== false));
  } catch (e) {
    console.error('GET /api/empleados error:', e);
    res.status(500).json([]);
  }
});

app.get('/api/usuarios', (req, res) => {
  try {
    const users = readJsonSafe(PATHS.users, []);
    const nombres = {};
    users.forEach(u => { nombres[u.usuario] = u.nombre; });
    res.json(nombres);
  } catch (e) {
    console.error('GET /api/usuarios error:', e);
    res.status(500).json({});
  }
});

app.get('/api/reporte-todos', (req, res) => {
  try {
    const all     = readJsonSafe(PATHS.marcajes, []);
    const usuarios= readJsonSafe(PATHS.users, []);
    const activos = new Set(usuarios.filter(u => u.activo !== false).map(u => u.usuario));
    const filtrados = all.filter(m => activos.has(m.usuario));
    filtrados.sort((a, b) => {
      if (a.usuario !== b.usuario) return a.usuario.localeCompare(b.usuario);
      if (a.fecha !== b.fecha)     return a.fecha.localeCompare(b.fecha);
      return (a.hora || '').localeCompare(b.hora || '');
    });
    res.json(filtrados);
  } catch (e) {
    console.error('GET /api/reporte-todos error:', e);
    res.status(500).json({ error: 'Error interno leyendo marcajes.' });
  }
});

app.delete('/api/borrar-marcaje', (req, res) => {
  try {
    const { usuario, index } = req.body || {};
    const all = readJsonSafe(PATHS.marcajes, []);
    const regs = all.filter(m => m.usuario === usuario);
    const item = regs[index];
    if (!item) return res.json({ success: false });
    const globalIdx = all.indexOf(item);
    if (globalIdx === -1) return res.json({ success: false });
    all.splice(globalIdx, 1);
    writeJsonSafe(PATHS.marcajes, all);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/borrar-marcaje error:', e);
    res.status(500).json({ success: false });
  }
});

app.delete('/api/limpiar-marcajes', (req, res) => {
  try {
    writeJsonSafe(PATHS.marcajes, []);
    db.run('DELETE FROM registros', [], (err) => {
      if (err) console.error('SQLite borrar:', err.message);
      res.json({ success: true, mensaje: 'Todos los marcajes han sido borrados.' });
    });
  } catch (e) {
    console.error('DELETE /api/limpiar-marcajes error:', e);
    res.status(500).json({ success: false, mensaje: 'No se pudo borrar marcajes.' });
  }
});

app.post('/api/desactivar-usuario', (req, res) => {
  try {
    const users = readJsonSafe(PATHS.users, []);
    const idx   = users.findIndex(u => u.usuario === req.body.usuario);
    if (idx === -1) return res.json({ success: false });
    users[idx].activo = false;
    writeJsonSafe(PATHS.users, users);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/desactivar-usuario error:', e);
    res.status(500).json({ success: false });
  }
});

app.post('/api/eliminar-usuario', (req, res) => {
  try {
    const { usuario } = req.body || {};
    const users = readJsonSafe(PATHS.users, []);
    const index = users.findIndex(u => u.usuario === usuario);
    if (index === -1) return res.json({ success: false, message: 'Usuario no encontrado' });
    users[index].activo = false;
    users[index].estado = 'Eliminado';
    users[index].fecha_baja = new Date().toISOString();
    writeJsonSafe(PATHS.users, users);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/eliminar-usuario error:', e);
    res.status(500).json({ success: false });
  }
});

app.post('/api/activar-usuario', (req, res) => {
  try {
    const users = readJsonSafe(PATHS.users, []);
    const u     = users.find(u => u.usuario === req.body.usuario);
    if (!u) return res.json({ success: false });
    u.activo = true;
    writeJsonSafe(PATHS.users, users);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/activar-usuario error:', e);
    res.status(500).json({ success: false });
  }
});

app.post('/api/corregir-hora', (req, res) => {
  try {
    const all  = readJsonSafe(PATHS.marcajes, []);
    theRegs = all.filter(x => x.usuario === req.body.usuario);
    const item = theRegs[req.body.index];
    const idxG = all.indexOf(item);
    if (idxG < 0) throw new Error('Índice inválido');
    all[idxG].tipo  = req.body.tipo;
    all[idxG].fecha = req.body.fecha;
    all[idxG].hora  = req.body.hora;
    writeJsonSafe(PATHS.marcajes, all);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/corregir-hora error:', e);
    res.json({ success: false });
  }
});

app.post('/api/agregar-marcaje', (req, res) => {
  try {
    const { usuario, departamento, tipo, fecha, hora } = req.body || {};
    const ip = getRealIp(req);

    db.run(
      `INSERT INTO registros (usuario, tipo, fecha, hora, ip, departamento) VALUES (?, ?, ?, ?, ?, ?)`,
      [usuario, tipo, fecha, hora, ip, departamento],
      (err) => {
        if (err) {
          console.error('SQLite insertar manual:', err.message);
          return res.json({ success: false, mensaje: 'Error al guardar en la base de datos.' });
        }
        const all = readJsonSafe(PATHS.marcajes, []);
        all.push({ usuario, departamento, tipo, fecha, hora, ip });
        writeJsonSafe(PATHS.marcajes, all);
        res.json({ success: true, mensaje: 'Registro agregado correctamente.' });
      }
    );
  } catch (e) {
    console.error('POST /api/agregar-marcaje error:', e);
    res.status(500).json({ success: false, mensaje: 'Error interno.' });
  }
});

// === Dashboard: resumen de estado de hoy (con listas de nombres para tooltips) ===
app.get('/api/resumen-estado-hoy', (req, res) => {
  try {
    const usuarios = readJsonSafe(PATHS.users, []);
    const activosUsers = usuarios.filter(u => u.activo !== false);
    const activos = activosUsers.map(u => u.usuario);
    const nameByUser = new Map(activosUsers.map(u => [u.usuario, u.nombre || u.usuario]));

    const all = readJsonSafe(PATHS.marcajes, []);
    const now = moment().tz('America/Chicago');
    const fechaHoy = now.format('YYYY-MM-DD');

    // Agrupar marcajes de hoy por usuario activo
    const porUsuario = new Map();
    for (const u of activos) porUsuario.set(u, []);
    for (const m of all) {
      if (porUsuario.has(m.usuario) && m.fecha === fechaHoy) porUsuario.get(m.usuario).push(m);
    }

    // Clasificación por último marcaje del día
    const ENTRA = new Set(['entrada', 'entrada_lunch']);
    const SALE_ALMUERZO = 'salida_lunch';

    const trabajandoNombres   = [];
    const enAlmuerzoNombres   = [];
    const noTrabajandoNombres = [];

    for (const [usuario, regs] of porUsuario.entries()) {
      const nombre = nameByUser.get(usuario) || usuario;

      if (!regs.length) { noTrabajandoNombres.push(nombre); continue; }
      regs.sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));
      const ult = regs[regs.length - 1];

      if (ult && ult.tipo === SALE_ALMUERZO) enAlmuerzoNombres.push(nombre);
      else if (ult && ENTRA.has(ult.tipo))   trabajandoNombres.push(nombre);
      else                                    noTrabajandoNombres.push(nombre);
    }

    const activosNombres = activosUsers.map(u => u.nombre || u.usuario);

    res.json({
      fecha: fechaHoy,
      totalActivos: activos.length,
      trabajando:   trabajandoNombres.length,
      enAlmuerzo:   enAlmuerzoNombres.length,
      noTrabajando: noTrabajandoNombres.length,
      listas: {
        trabajando:   trabajandoNombres,
        enAlmuerzo:   enAlmuerzoNombres,
        noTrabajando: noTrabajandoNombres,
        activos:      activosNombres
      }
    });
  } catch (e) {
    console.error('GET /api/resumen-estado-hoy error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ==== Manejador global de errores (último middleware) ====
app.use((err, req, res, next) => {
  console.error('🔥 Error no controlado:', err);
  res.status(500).json({ ok: false, error: 'server_error' });
});

// Evita que errores no manejados tumben el proceso
process.on('unhandledRejection', err => console.error('UNHANDLED REJECTION', err));
process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION', err));

// ==== Arranque ====
app.listen(PORT, '0.0.0.0', () => {
  console.log(`DinEX WebClock escuchando en puerto ${PORT}`);
});

