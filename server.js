
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
const bcrypt    = require('bcryptjs');

const app  = express();

// ==== Config básica Render ====
const PORT     = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || __dirname; // en Render usa /data si lo configuras

// ==== Rutas de archivos ====
const PATHS = {
  dbDir:       path.join(DATA_DIR, 'db'),
  dbFile:      path.join(DATA_DIR, 'db', 'dev.db'),
  marcajes:    path.join(DATA_DIR, 'marcajes.json'),
  users:       path.join(DATA_DIR, 'users.json'),
  admins:      path.join(DATA_DIR, 'admins.json'),
  supervisors: path.join(DATA_DIR, 'supervisors.json'),
  backupsDir:  path.join(DATA_DIR, 'backups')
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
ensureJsonSync(PATHS.supervisors, '[]');

// ==== Confía en el proxy (Render) para IP real ====
app.set('trust proxy', true);

// ==== DB SQLite y esquema ====
const db = new sqlite3.Database(PATHS.dbFile);
// WAL mode: permite lecturas simultáneas mientras se escribe
// WAL mode: permite lecturas simultáneas mientras se escribe (crítico para 45 usuarios)
db.run('PRAGMA journal_mode=WAL');
db.run('PRAGMA synchronous=NORMAL');
db.run('PRAGMA cache_size=-64000'); // 64MB cache
db.serialize(() => {
  // Crear tabla base si no existe
  db.run(
    `CREATE TABLE IF NOT EXISTS registros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario TEXT,
  tipo TEXT,
  fecha TEXT,
  hora TEXT,
  ip TEXT,
  departamento TEXT,
  lat REAL,
  lng REAL,
  accuracy REAL,
  insideGeofence INTEGER,
  geofenceId TEXT,
  geofenceName TEXT,
  distanceToCenterM INTEGER,
  auto INTEGER DEFAULT 0,
  userAgent TEXT
);`,
    (err) => {
      if (err) { console.error('Error creando tabla SQLite:', err.message); return; }
      console.log('SQLite OK: tabla registros lista');

      const columnasFaltantes = [
        { name: 'lat',               def: 'REAL'    },
        { name: 'lng',               def: 'REAL'    },
        { name: 'accuracy',          def: 'REAL'    },
        { name: 'insideGeofence',    def: 'INTEGER' },
        { name: 'geofenceId',        def: 'TEXT'    },
        { name: 'geofenceName',      def: 'TEXT'    },
        { name: 'distanceToCenterM', def: 'INTEGER' },
        { name: 'auto',              def: 'INTEGER DEFAULT 0' },
        { name: 'userAgent',         def: 'TEXT'    },
      ];

      db.all(`PRAGMA table_info(registros)`, [], (err2, cols) => {
        if (err2) { console.error('PRAGMA error:', err2.message); return; }
        const existentes = new Set(cols.map(c => c.name));
        columnasFaltantes.forEach(col => {
          if (!existentes.has(col.name)) {
            db.run(`ALTER TABLE registros ADD COLUMN ${col.name} ${col.def}`, (err3) => {
              if (err3) console.error(`Migración columna ${col.name}:`, err3.message);
              else console.log(`SQLite migración: columna '${col.name}' agregada`);
            });
          }
        });
      });
    }
  );
});

// ==== [FIX A-3] bodyParser con límite de 100kb para prevenir DoS ====
app.use(bodyParser.json({ limit: '100kb' }));

// ==== [FIX A-4] Cabeceras de seguridad HTTP ====
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com data:;"
  );
  next();
});

// Bloquea acceso público a JSON/DB/JS de servidor/backup por seguridad
// [FIX M-1] Extendido para bloquear .js de raíz, .backup, .npmrc, .txt
app.use((req, res, next) => {
  if (/\.(json|db|db-shm|db-wal)$/i.test(req.path)) return res.status(403).send('Forbidden');
  // Bloquear archivos sensibles de la raíz del proyecto
  const blocked = [
    '/server.js', '/arreglar-admins.js', '/server.js.backup',
    '/.npmrc', '/INSTRUCCIONES.txt', '/package-lock.json'
  ];
  if (blocked.includes(req.path.toLowerCase())) return res.status(403).send('Forbidden');
  next();
});

// Sirve estáticos desde /public únicamente
app.use(express.static(path.join(__dirname, 'public')));
// [FIX M-1] Se elimina el segundo express.static(__dirname) que exponía archivos del servidor
// app.use(express.static(path.join(__dirname))); ← ELIMINADO

// ==== Endpoints de salud / ping ====
app.get('/health',  (req, res) => res.send('ok'));
app.get('/healthz', (req, res) => res.send('OK'));
app.get('/api/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ====== Geocerca ======
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

const MODO_ESTRICTO = false;

// ==== Middleware verificar admin (sin cambios — mantiene compatibilidad total) ====
function verificarAdmin(req, res, next) {
  const { username, password } = req.headers['x-admin-auth'] ? JSON.parse(req.headers['x-admin-auth']) : {};
  const admins = readJsonSafe(PATHS.admins, []);
  const valid = admins.some(a => a.username === username && bcrypt.compareSync(password || '', a.password));
  if (!valid) return res.status(401).json({ success: false, mensaje: 'No autorizado.' });
  next();
}

// ==== [FIX A-1] Rate limiting de login por IP ====
const _loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const ip  = getRealIp(req);
  const now = Date.now();
  const entry = _loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 15 * 60 * 1000; }
  entry.count++;
  _loginAttempts.set(ip, entry);
  if (entry.count > 10) {
    const restSec = Math.ceil((entry.resetAt - now) / 1000);
    return res.status(429).json({ success: false, mensaje: `Demasiados intentos. Espera ${restSec} segundos.` });
  }
  next();
}

// ==== Endpoint para IDs de empleados (usado en dona del admin) ====
app.get('/api/empleados-ids', (req, res) => {
  try {
    const users = readJsonSafe(PATHS.users, []);
    const mapa = {};
    users.filter(u => u.activo !== false).forEach(u => {
      mapa[u.nombre || u.usuario] = u.usuario;
    });
    res.json(mapa);
  } catch (e) {
    console.error('GET /api/empleados-ids error:', e);
    res.status(500).json({});
  }
});

// ==== Backups ====
function ejecutarBackup() {
  const fecha = moment().tz('America/Chicago').format('YYYY-MM-DD');
  const errores = [];
  const archivos = [
    { src: PATHS.dbFile,       dst: path.join(PATHS.backupsDir, `dev-${fecha}.db`)           },
    { src: PATHS.users,        dst: path.join(PATHS.backupsDir, `users-${fecha}.json`)        },
    { src: PATHS.admins,       dst: path.join(PATHS.backupsDir, `admins-${fecha}.json`)       },
    { src: PATHS.supervisors,  dst: path.join(PATHS.backupsDir, `supervisors-${fecha}.json`)  },
    { src: PATHS.marcajes,     dst: path.join(PATHS.backupsDir, `marcajes-${fecha}.json`)     },
  ];
  archivos.forEach(({ src, dst }) => {
    try { if (fs.existsSync(src)) fse.copySync(src, dst); }
    catch (e) { errores.push(src); console.error(`[Backup] Error copiando ${src}:`, e.message); }
  });
  try {
    const limite = moment().tz('America/Chicago').subtract(30, 'days');
    fs.readdirSync(PATHS.backupsDir).forEach(f => {
      const match = f.match(/-(\d{4}-\d{2}-\d{2})\./);
      if (match && moment(match[1]).isBefore(limite)) {
        fs.unlinkSync(path.join(PATHS.backupsDir, f));
        console.log(`[Backup] Eliminado backup antiguo: ${f}`);
      }
    });
  } catch(e) { console.warn('[Backup] Error limpiando backups antiguos:', e.message); }
  console.log(`[Backup] ${fecha} — ${archivos.length - errores.length}/${archivos.length} archivos OK`);
  return errores;
}

cron.schedule('0 23 * * *', ejecutarBackup, { timezone: 'America/Chicago' });

app.get('/api/backup-now', verificarAdmin, (req, res) => {
  const errores = ejecutarBackup();
  if (errores.length === 0) {
    res.json({ success: true, mensaje: 'Backup completo creado correctamente.' });
  } else {
    res.status(500).json({ success: false, mensaje: `Backup parcial. Errores en: ${errores.join(', ')}` });
  }
});

// ==== Auth Admin Login — [FIX A-1] con rate limiting ====
app.post('/api/admin-login', loginRateLimit, (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ success: false, mensaje: 'Datos inválidos.' });
    }
    const admins = readJsonSafe(PATHS.admins, []);
    const valid  = admins.some(a => a.username === username && bcrypt.compareSync(password, a.password));
    if (valid) _loginAttempts.delete(getRealIp(req)); // reset counter on success
    res.json({ success: !!valid });
  } catch (e) {
    console.error('admin-login error:', e);
    res.status(500).json({ success: false });
  }
});

// ==== [FIX C-2] crear-usuario ahora requiere verificarAdmin ====
app.post('/api/crear-usuario', verificarAdmin, (req, res) => {
  try {
    const nombre       = (req.body.nombre      || '').trim();
    const usuario      = (req.body.usuario     || '').trim();
    const contrasena   =  req.body.contrasena  || '';
    const departamento = (req.body.departamento|| '').trim();
    if (!nombre || !usuario || !contrasena || !departamento) {
      return res.json({ success: false, mensaje: 'Todos los campos son requeridos.' });
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(usuario)) {
      return res.json({ success: false, mensaje: 'El usuario solo puede contener letras, números, puntos, guiones o guión bajo.' });
    }
    if (contrasena.length < 6) {
      return res.json({ success: false, mensaje: 'La contraseña debe tener al menos 6 caracteres.' });
    }
    const users = readJsonSafe(PATHS.users, []);
    if (users.some(u => u.usuario === usuario)) {
      return res.json({ success: false, mensaje: 'Usuario ya existe.' });
    }
    const hashPassword = bcrypt.hashSync(contrasena, 10);
    const nuevoUsuario = {
      nombre,
      usuario,
      contrasena: hashPassword,
      departamento,
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

app.post('/api/editar-usuario', verificarAdmin, (req, res) => {
  try {
    const { usuario, nombre, departamento, contrasena } = req.body || {};
    if (!usuario || !nombre || !departamento) {
      return res.json({ success: false, mensaje: 'Faltan campos requeridos.' });
    }
    const users = readJsonSafe(PATHS.users, []);
    const idx = users.findIndex(u => u.usuario === usuario);
    if (idx === -1) return res.json({ success: false, mensaje: 'Usuario no encontrado.' });
    users[idx].nombre       = nombre.trim();
    users[idx].departamento = departamento.trim();
    if (contrasena && contrasena.length >= 6) {
      users[idx].contrasena = bcrypt.hashSync(contrasena, 10);
    }
    writeJsonSafe(PATHS.users, users);
    res.json({ success: true });
  } catch (e) {
    console.error('editar-usuario error:', e);
    res.status(500).json({ success: false, mensaje: 'Error interno.' });
  }
});

// ==== Login usuario — [FIX A-1] con rate limiting ====
app.post('/api/login-usuario', loginRateLimit, (req, res) => {
  try {
    const users = readJsonSafe(PATHS.users, []);
    const u = users.find(u =>
      u.usuario === req.body.usuario &&
      bcrypt.compareSync(req.body.contrasena, u.contrasena) &&
      u.activo !== false
    );
    if (u) _loginAttempts.delete(getRealIp(req)); // reset counter on success
    res.json(u ? { success: true, departamento: u.departamento } : { success: false });
  } catch (e) {
    console.error('login-usuario error:', e);
    res.status(500).json({ success: false });
  }
});

// ==== Rate limiting simple por usuario (marcaje) ====
const _lastMarcaje = new Map();
function rateLimitMarcaje(usuario) {
  const ahora = Date.now();
  const ultimo = _lastMarcaje.get(usuario) || 0;
  if (ahora - ultimo < 3000) return false;
  _lastMarcaje.set(usuario, ahora);
  return true;
}

// ==== Marcaje ====
// 100% SQLite — el JSON solo se mantiene como backup secundario
app.post('/api/marcar', (req, res) => {
  try {
    const now       = moment().tz('America/Chicago');
    const fechaHoy  = now.format('YYYY-MM-DD');
    const hora      = now.format('HH:mm:ss');
    const fechaAyer = moment(now).subtract(1, 'day').format('YYYY-MM-DD');

    const usuario      = (req.body.usuario || '').trim();
    const tipo         = (req.body.tipo    || '').trim();
    const departamento = (req.body.departamento || '').trim();
    const ip           = getRealIp(req);
    const userAgent    = req.headers['user-agent'] || null;

    if (!usuario || !tipo) {
      return res.status(400).json({ success: false, mensaje: 'Faltan datos requeridos.' });
    }

    // [FIX M-3] Bloquear marcajes desde celulares y tablets
    // Solo se permiten marcajes desde computadoras de escritorio / laptop
    const uaLower = (userAgent || '').toLowerCase();
    const esCelular = /android|iphone|ipad|ipod|mobile|phone|tablet|blackberry|windows phone/i.test(uaLower);
    if (esCelular) {
      return res.status(403).json({
        success: false,
        mensaje: '⛔ Marcaje no permitido desde celular o tablet. Usa la computadora de la tienda.'
      });
    }

    // [FIX M-2] Validar tipo de marcaje contra lista permitida
    const tiposValidos = ['entrada', 'salida_lunch', 'entrada_lunch', 'salida'];
    if (!tiposValidos.includes(tipo)) {
      return res.status(400).json({ success: false, mensaje: 'Tipo de marcaje inválido.' });
    }

    if (!rateLimitMarcaje(usuario)) {
      return res.status(429).json({ success: false, mensaje: 'Espera un momento antes de marcar de nuevo.' });
    }

    const users = readJsonSafe(PATHS.users, []);
    const userObj = users.find(u => u.usuario === usuario);
    if (!userObj) {
      return res.status(403).json({ success: false, mensaje: 'Usuario no encontrado.' });
    }
    if (userObj.activo === false) {
      return res.status(403).json({ success: false, mensaje: 'Tu cuenta está inactiva. Contacta al administrador.' });
    }

    const location = req.body.location || {};
    const lat      = (typeof location.lat      === 'number') ? location.lat      : null;
    const lng      = (typeof location.lng      === 'number') ? location.lng      : null;
    const accuracy = (typeof location.accuracy === 'number') ? location.accuracy : null;

    if (lat === null || lng === null) {
      return res.status(400).json({ success: false, mensaje: 'Faltan coordenadas. Debes permitir la ubicación para marcar.' });
    }

    const gf = findGeofence(lat, lng);
    if (MODO_ESTRICTO && !gf.inside) {
      return res.status(403).json({ success: false, mensaje: 'Marcaje rechazado: estás fuera del área permitida.' });
    }

    // Buscar registros de hoy y hasta 7 días atrás para detectar días sin salida
    const hace7dias = moment(now).subtract(7, 'days').format('YYYY-MM-DD');
    db.all(
      `SELECT tipo, fecha, auto FROM registros WHERE usuario = ? AND fecha >= ? AND fecha <= ? ORDER BY fecha, hora`,
      [usuario, hace7dias, fechaHoy],
      (err, rows) => {
        if (err) {
          console.error('marcar SELECT:', err.message);
          return res.status(500).json({ success: false, mensaje: 'Error interno al verificar marcajes.' });
        }

        const registrosHoy = rows.filter(r => r.fecha === fechaHoy);

        // Buscar el día más reciente (antes de hoy) que tuvo entrada pero no salida
        const diasPasados = [...new Set(
          rows.filter(r => r.fecha < fechaHoy).map(r => r.fecha)
        )].sort().reverse();

        let diaIncompleto = null;
        for (const dia of diasPasados) {
          const regsDelDia = rows.filter(r => r.fecha === dia);
          const tieneEntrada = regsDelDia.some(r => r.tipo === 'entrada');
          const tieneSalida  = regsDelDia.some(r => r.tipo === 'salida');
          if (tieneEntrada && !tieneSalida) {
            diaIncompleto = dia;
            break;
          }
        }

        // Compatibilidad con lógica anterior
        const registrosAyer = rows.filter(r => r.fecha === fechaAyer);
        const huboEntradaAyer = !!diaIncompleto;
        const huboSalidaAyer  = !diaIncompleto;
        let advertencia = '';

        const insertarMarcajeFinal = () => {
          if (registrosHoy.some(r => r.tipo === tipo)) {
            return res.json({ success: false, mensaje: `Ya registraste "${tipo}" hoy. No puedes repetirlo.` });
          }
          if (registrosHoy.length >= 4) {
            return res.json({ success: false, mensaje: 'Su turno ya terminó.' });
          }
          db.run(
            `INSERT INTO registros
              (usuario, tipo, fecha, hora, ip, departamento, lat, lng, accuracy,
               insideGeofence, geofenceId, geofenceName, distanceToCenterM, userAgent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [usuario, tipo, fechaHoy, hora, ip, departamento,
             lat, lng, accuracy,
             gf.inside ? 1 : 0,
             gf.inside ? gf.id   : null,
             gf.inside ? gf.name : null,
             gf.distance ? Math.round(gf.distance) : null,
             userAgent],
            (errIns) => {
              if (errIns) {
                console.error('SQLite insertar marcaje:', errIns.message);
                return res.status(500).json({ success: false, mensaje: 'Error al guardar el marcaje.' });
              }
              try {
                const all = readJsonSafe(PATHS.marcajes, []);
                all.push({ usuario, tipo, fecha: fechaHoy, hora, ip, departamento,
                           lat, lng, accuracy, insideGeofence: gf.inside,
                           geofenceId: gf.inside ? gf.id : null,
                           geofenceName: gf.inside ? gf.name : null,
                           distanceToCenterM: gf.distance ? Math.round(gf.distance) : null,
                           userAgent });
                writeJsonSafe(PATHS.marcajes, all);
              } catch (e) { console.warn('Backup JSON no-crítico falló:', e.message); }

              const suffix = (!MODO_ESTRICTO && !gf.inside) ? ' (fuera de geocerca)' : '';
              const mensajeFinal = (advertencia ? advertencia + ' ' : '') +
                                   `Marcaje de ${tipo} registrado a las ${hora}.`;
              res.json({
                success: true,
                mensaje: mensajeFinal + suffix,
                insideGeofence: gf.inside,
                geofence: gf.inside ? { id: gf.id, name: gf.name, distanceM: Math.round(gf.distance) } : null
              });
            }
          );
        };

        if (huboEntradaAyer && !huboSalidaAyer) {
          advertencia = `⚠️ El ${diaIncompleto} no marcaste salida. Se registró salida automática a las 7:30 PM.`;
          db.run(
            `INSERT INTO registros
              (usuario, tipo, fecha, hora, ip, departamento, lat, lng, accuracy,
               insideGeofence, geofenceId, geofenceName, distanceToCenterM, userAgent, auto)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [usuario, 'salida', diaIncompleto, '19:30:00', ip, departamento,
             null, null, null, null, null, null, null, null, 1],
            (errAuto) => {
              if (errAuto) console.error('SQLite auto-salida:', errAuto.message);
              try {
                const all = readJsonSafe(PATHS.marcajes, []);
                all.push({ usuario, tipo: 'salida', fecha: diaIncompleto, hora: '19:30:00',
                           ip, departamento, auto: true });
                writeJsonSafe(PATHS.marcajes, all);
              } catch(e) { /* no-crítico */ }
              insertarMarcajeFinal();
            }
          );
        } else {
          insertarMarcajeFinal();
        }
      }
    );

  } catch (e) {
    console.error('POST /api/marcar error:', e);
    res.status(500).json({ success: false, mensaje: 'Error interno en marcaje.' });
  }
});

// ==== Reportes ====
app.get('/api/reporte', (req, res) => {
  try {
    const usuario = req.query.usuario;
    if (!usuario) return res.json([]);
    const users = readJsonSafe(PATHS.users, []);
    const user = users.find(u => u.usuario === usuario);
    if (!user) return res.json([]);
    db.all(
      `SELECT * FROM registros WHERE usuario = ? ORDER BY fecha ASC, hora ASC`,
      [usuario],
      (err, rows) => {
        if (err) {
          console.error('SQLite reporte:', err.message);
          return res.status(500).json([]);
        }
        res.json(rows);
      }
    );
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
    // Incluye todos los usuarios (activos e inactivos) para resolución de nombres en reportes
    const nombres = {};
    users.forEach(u => { nombres[u.usuario] = u.nombre; });
    res.json(nombres);
  } catch (e) {
    console.error('GET /api/usuarios error:', e);
    res.status(500).json({});
  }
});

app.get('/api/usuarios-detalle', (req, res) => {
  try {
    const users = readJsonSafe(PATHS.users, []);
    const detalle = users.map(u => ({
      usuario: u.usuario,
      nombre:  u.nombre  || '',
      activo:  u.activo  !== false,
      estado:  u.estado  || ''
    }));
    res.json(detalle);
  } catch (e) {
    console.error('GET /api/usuarios-detalle error:', e);
    res.status(500).json([]);
  }
});

app.get('/api/reporte-todos', (req, res) => {
  try {
    const users = readJsonSafe(PATHS.users, []);
    const activos = users
      .filter(u => u.activo !== false && u.estado !== 'Eliminado' && u.estado !== 'Inactivo')
      .map(u => u.usuario);

    if (activos.length === 0) return res.json([]);

    const placeholders = activos.map(() => '?').join(',');
    db.all(
      `SELECT * FROM registros WHERE usuario IN (${placeholders}) ORDER BY usuario ASC, fecha ASC, hora ASC`,
      activos,
      (err, rows) => {
        if (err) {
          console.error('SQLite reporte-todos:', err.message);
          return res.status(500).json({ error: 'Error leyendo base de datos.' });
        }
        res.json(rows);
      }
    );
  } catch (e) {
    console.error('GET /api/reporte-todos error:', e);
    res.status(500).json({ error: 'Error interno leyendo marcajes.' });
  }
});

app.delete('/api/borrar-marcaje', verificarAdmin, (req, res) => {
  try {
    const { usuario, index, recordId } = req.body || {};
    if (recordId) {
      db.run(`DELETE FROM registros WHERE id = ?`, [recordId], (err) => {
        if (err) { console.error('borrar-marcaje by ID:', err.message); return res.json({ success: false }); }
        res.json({ success: true });
      });
      return;
    }
    db.all(
      `SELECT id FROM registros WHERE usuario = ? ORDER BY fecha ASC, hora ASC`,
      [usuario],
      (err, rows) => {
        if (err || !rows[index]) return res.json({ success: false });
        const id = rows[index].id;
        db.run(`DELETE FROM registros WHERE id = ?`, [id], (err2) => {
          if (err2) return res.json({ success: false });
          res.json({ success: true });
        });
      }
    );
  } catch (e) {
    console.error('DELETE /api/borrar-marcaje error:', e);
    res.status(500).json({ success: false });
  }
});

app.delete('/api/limpiar-marcajes', verificarAdmin, (req, res) => {
  try {
    db.run('DELETE FROM registros', [], (err) => {
      if (err) {
        console.error('SQLite borrar:', err.message);
        return res.status(500).json({ success: false, mensaje: 'No se pudo borrar marcajes.' });
      }
      writeJsonSafe(PATHS.marcajes, []);
      res.json({ success: true, mensaje: 'Todos los marcajes han sido borrados.' });
    });
  } catch (e) {
    console.error('DELETE /api/limpiar-marcajes error:', e);
    res.status(500).json({ success: false, mensaje: 'No se pudo borrar marcajes.' });
  }
});

app.post('/api/desactivar-usuario', verificarAdmin, (req, res) => {
  try {
    const users = readJsonSafe(PATHS.users, []);
    const idx   = users.findIndex(u => u.usuario === req.body.usuario);
    if (idx === -1) return res.json({ success: false });
    users[idx].activo     = false;
    users[idx].estado     = 'Inactivo';
    users[idx].fecha_baja = new Date().toISOString();
    writeJsonSafe(PATHS.users, users);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/desactivar-usuario error:', e);
    res.status(500).json({ success: false });
  }
});

app.post('/api/eliminar-usuario', verificarAdmin, (req, res) => {
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

app.post('/api/activar-usuario', verificarAdmin, (req, res) => {
  try {
    const users = readJsonSafe(PATHS.users, []);
    const u     = users.find(u => u.usuario === req.body.usuario);
    if (!u) return res.json({ success: false });
    u.activo     = true;
    u.estado     = 'Activo';
    u.fecha_baja = null;
    writeJsonSafe(PATHS.users, users);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/activar-usuario error:', e);
    res.status(500).json({ success: false });
  }
});

app.post('/api/reset-password-admin', verificarAdmin, (req, res) => {
  try {
    const { usuario, nuevaClave } = req.body || {};
    if (!usuario || !nuevaClave) {
      return res.json({ success: false, message: 'Datos incompletos.' });
    }
    if (nuevaClave.length < 6) {
      return res.json({ success: false, message: 'La contraseña debe tener al menos 6 caracteres.' });
    }
    const users = readJsonSafe(PATHS.users, []);
    const idx = users.findIndex(u => u.usuario === usuario);
    if (idx === -1) return res.json({ success: false, message: 'Usuario no encontrado.' });
    users[idx].contrasena = bcrypt.hashSync(nuevaClave, 10);
    writeJsonSafe(PATHS.users, users);
    res.json({ success: true, message: 'Contraseña actualizada correctamente.' });
  } catch (e) {
    console.error('POST /api/reset-password-admin error:', e);
    res.status(500).json({ success: false, message: 'Error interno.' });
  }
});

app.get('/api/empleados-inactivos', (req, res) => {
  try {
    const users = readJsonSafe(PATHS.users, []);
    const inactivos = users.filter(u => u.activo === false || u.estado === 'Eliminado');
    if (inactivos.length === 0) return res.json([]);

    const usuariosInactivos = inactivos.map(u => u.usuario);
    const placeholders = usuariosInactivos.map(() => '?').join(',');

    db.all(
      `SELECT usuario, tipo, fecha, hora, ip, departamento
       FROM registros
       WHERE usuario IN (${placeholders})
       ORDER BY fecha ASC, hora ASC`,
      usuariosInactivos,
      (err, rows) => {
        if (err) {
          console.error('GET /api/empleados-inactivos SQLite error:', err.message);
          return res.status(500).json({ error: 'Error leyendo registros.' });
        }
        const regPorUsuario = {};
        usuariosInactivos.forEach(u => regPorUsuario[u] = []);
        rows.forEach(r => {
          if (regPorUsuario[r.usuario]) regPorUsuario[r.usuario].push(r);
        });
        const resultado = inactivos.map(u => ({
          nombre:         u.nombre        || u.usuario,
          usuario:        u.usuario,
          departamento:   u.departamento  || '-',
          estado:         u.estado === 'Eliminado' ? 'Eliminado' : 'Desactivado',
          fecha_creacion: u.fecha_creacion || null,
          fecha_baja:     u.fecha_baja    || null,
          registros:      regPorUsuario[u.usuario] || []
        }));
        res.json(resultado);
      }
    );
  } catch (e) {
    console.error('GET /api/empleados-inactivos error:', e);
    res.status(500).json({ error: 'Error interno.' });
  }
});

app.post('/api/corregir-hora', verificarAdmin, (req, res) => {
  try {
    const { usuario, index, recordId, tipo, fecha, hora } = req.body || {};
    if (!tipo || !fecha || !hora) return res.json({ success: false, mensaje: 'Faltan campos requeridos.' });

    const doUpdate = (id) => {
      db.run(
        `UPDATE registros SET tipo = ?, fecha = ?, hora = ? WHERE id = ?`,
        [tipo, fecha, hora, id],
        (err) => {
          if (err) { console.error('corregir-hora UPDATE:', err.message); return res.json({ success: false }); }
          res.json({ success: true });
        }
      );
    };

    if (recordId) { doUpdate(recordId); return; }

    db.all(
      `SELECT id FROM registros WHERE usuario = ? ORDER BY fecha ASC, hora ASC`,
      [usuario],
      (err, rows) => {
        if (err || !rows[index]) return res.json({ success: false });
        doUpdate(rows[index].id);
      }
    );
  } catch (e) {
    console.error('POST /api/corregir-hora error:', e);
    res.json({ success: false });
  }
});

// ==== [FIX C-3] agregar-marcaje ahora requiere verificarAdmin ====
app.post('/api/agregar-marcaje', verificarAdmin, (req, res) => {
  try {
    const { usuario, departamento, tipo, fecha, hora } = req.body || {};
    if (!usuario || !tipo || !fecha || !hora) {
      return res.json({ success: false, mensaje: 'Todos los campos son requeridos.' });
    }
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

// ==== Dashboard resumen estado hoy ====
app.get('/api/resumen-estado-hoy', (req, res) => {
  try {
    const usuarios = readJsonSafe(PATHS.users, []);
    const activosUsers = usuarios.filter(u => u.activo !== false);
    const activos = activosUsers.map(u => u.usuario);
    const nameByUser = new Map(activosUsers.map(u => [u.usuario, u.nombre || u.usuario]));

    const now = moment().tz('America/Chicago');
    const fechaHoy = now.format('YYYY-MM-DD');

    db.all(
      `SELECT * FROM registros WHERE fecha = ?`,
      [fechaHoy],
      (err, rows) => {
        if (err) {
          console.error('SQLite resumen-estado-hoy:', err.message);
          return res.status(500).json({ error: 'internal_error' });
        }

        const porUsuario = new Map();
        for (const u of activos) porUsuario.set(u, []);
        for (const m of rows) {
          if (porUsuario.has(m.usuario)) porUsuario.get(m.usuario).push(m);
        }

        const ENTRA = new Set(['entrada', 'entrada_lunch']);
        const SALE_ALMUERZO = 'salida_lunch';

        const trabajandoNombres   = [];
        const enAlmuerzoNombres   = [];
        const noTrabajandoNombres = [];
        const trabajandoConId   = [];
        const enAlmuerzoConId   = [];
        const noTrabajandoConId = [];

        for (const [usuario, regs] of porUsuario.entries()) {
          const nombre = nameByUser.get(usuario) || usuario;
          if (!regs.length) {
            const conId = `${nombre} (Sin marcaje hoy)`;
            noTrabajandoNombres.push(nombre);
            noTrabajandoConId.push(conId);
            continue;
          }
          regs.sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));
          const ult = regs[regs.length - 1];
          // Mostrar TX-XXX si el último marcaje tiene geofenceId, si no mostrar "Fuera de sede"
          const sede  = (ult && ult.geofenceId) ? ult.geofenceId : 'Fuera de sede';
          const conId = `${nombre} (${sede})`;
          if (ult && ult.tipo === SALE_ALMUERZO) {
            enAlmuerzoNombres.push(nombre);
            enAlmuerzoConId.push(conId);
          } else if (ult && ENTRA.has(ult.tipo)) {
            trabajandoNombres.push(nombre);
            trabajandoConId.push(conId);
          } else {
            noTrabajandoNombres.push(nombre);
            noTrabajandoConId.push(conId);
          }
        }

        res.json({
          fecha: fechaHoy,
          totalActivos: activos.length,
          trabajando:   trabajandoNombres.length,
          enAlmuerzo:   enAlmuerzoNombres.length,
          noTrabajando: noTrabajandoNombres.length,
          listas: {
            trabajando:      trabajandoNombres,
            enAlmuerzo:      enAlmuerzoNombres,
            noTrabajando:    noTrabajandoNombres,
            activos:         activosUsers.map(u => u.nombre || u.usuario),
            trabajandoConId: trabajandoConId,
            enAlmuerzoConId: enAlmuerzoConId,
            noTrabajandoConId: noTrabajandoConId
          }
        });
      }
    );
  } catch (e) {
    console.error('GET /api/resumen-estado-hoy error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ==== Supervisor ====
// [FIX A-1] Rate limiting en supervisor login también
app.post('/api/supervisor-login', loginRateLimit, (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.json({ success: false });
    const supervisors = readJsonSafe(PATHS.supervisors, []);
    const valid = supervisors.some(s =>
      s.username === username && bcrypt.compareSync(password, s.password)
    );
    if (valid) _loginAttempts.delete(getRealIp(req));
    res.json({ success: !!valid });
  } catch (e) {
    console.error('supervisor-login error:', e);
    res.status(500).json({ success: false });
  }
});

app.post('/api/crear-supervisor', verificarAdmin, (req, res) => {
  try {
    const { username, password, nombre } = req.body || {};
    if (!username || !password || !nombre) {
      return res.json({ success: false, mensaje: 'Todos los campos son requeridos.' });
    }
    if (password.length < 6) {
      return res.json({ success: false, mensaje: 'La contrasena debe tener al menos 6 caracteres.' });
    }
    const supervisors = readJsonSafe(PATHS.supervisors, []);
    const idx = supervisors.findIndex(s => s.username === username);
    const entry = { username, nombre, password: bcrypt.hashSync(password, 10) };
    if (idx >= 0) supervisors[idx] = entry;
    else supervisors.push(entry);
    writeJsonSafe(PATHS.supervisors, supervisors);
    res.json({ success: true, mensaje: 'Supervisor guardado correctamente.' });
  } catch (e) {
    console.error('crear-supervisor error:', e);
    res.status(500).json({ success: false });
  }
});

app.get('/api/supervisores', verificarAdmin, (req, res) => {
  try {
    const supervisors = readJsonSafe(PATHS.supervisors, []);
    res.json(supervisors.map(s => ({ username: s.username, nombre: s.nombre })));
  } catch (e) { res.status(500).json([]); }
});

app.delete('/api/eliminar-supervisor', verificarAdmin, (req, res) => {
  try {
    const { username } = req.body || {};
    let supervisors = readJsonSafe(PATHS.supervisors, []);
    supervisors = supervisors.filter(s => s.username !== username);
    writeJsonSafe(PATHS.supervisors, supervisors);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false }); }
});

// ==== Manejador global de errores ====
app.use((err, req, res, next) => {
  console.error('Error no controlado:', err);
  res.status(500).json({ ok: false, error: 'server_error' });
});

process.on('unhandledRejection', err => console.error('UNHANDLED REJECTION', err));
process.on('uncaughtException',  err => console.error('UNCAUGHT EXCEPTION', err));

// ==== [FIX B-4] Cierre limpio de SQLite cuando Render hace redeploy ====
process.on('SIGTERM', () => {
  console.log('SIGTERM recibido — cerrando base de datos...');
  db.close((err) => {
    if (err) console.error('Error cerrando SQLite:', err.message);
    else console.log('SQLite cerrado correctamente.');
    process.exit(0);
  });
});

// ==== Arranque ====
app.listen(PORT, '0.0.0.0', () => {
  console.log(`DinEX WebClock escuchando en puerto ${PORT}`);
});

