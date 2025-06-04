
// server.js
const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const fse        = require('fs-extra');
const cron       = require('node-cron');
const bodyParser = require('body-parser');
const moment     = require('moment-timezone');
const sqlite3    = require('sqlite3').verbose();

const app  = express();
const PORT = 3000;
const db   = new sqlite3.Database('./db/dev.db');

// 1) Middleware para parsear JSON
app.use(bodyParser.json());

// BACKUP AUTOMATICO A LAS 11PM
const backupFolder = path.join(__dirname, 'backups');
if (!fs.existsSync(backupFolder)) fs.mkdirSync(backupFolder);

cron.schedule('0 23 * * *', () => {
  const fecha = new Date().toISOString().split('T')[0];
  const origenJSON = path.join(__dirname, 'marcajes.json');
  const destinoJSON = path.join(backupFolder, `marcajes-${fecha}.json`);
  const origenDB = path.join(__dirname, 'db/dev.db');
  const destinoDB = path.join(backupFolder, `dev-${fecha}.db`);

  try {
    fse.copySync(origenJSON, destinoJSON);
    fse.copySync(origenDB, destinoDB);
    console.log(`[Backup] Copia guardada: ${fecha}`);
  } catch (err) {
    console.error('[Backup] Error al hacer la copia:', err);
  }
});

// BACKUP MANUAL
app.get('/api/backup-now', (req, res) => {
  const fecha = new Date().toISOString().split('T')[0];
  const origenJSON = path.join(__dirname, 'marcajes.json');
  const destinoJSON = path.join(backupFolder, `marcajes-${fecha}.json`);
  const origenDB = path.join(__dirname, 'db/dev.db');
  const destinoDB = path.join(backupFolder, `dev-${fecha}.db`);

  try {
    fse.copySync(origenJSON, destinoJSON);
    fse.copySync(origenDB, destinoDB);
    console.log(`[Backup manual] Copia creada: ${fecha}`);
    res.json({ success: true, mensaje: "Backup creado correctamente." });
  } catch (err) {
    console.error('[Backup manual] Error:', err);
    res.status(500).json({ success: false, mensaje: "Error al crear el backup." });
  }
});

// 2.2) Login administrador
app.post('/api/admin-login', (req, res) => {
  const { username, password } = req.body;
  const admins = JSON.parse(fs.readFileSync('admins.json', 'utf8'));
  const valid  = admins.some(a => a.username === username && a.password === password);
  res.json({ success: valid });
});

// 2.3) Crear usuario con fecha de creación
app.post('/api/crear-usuario', (req, res) => {
  const uPath = path.join(__dirname, 'users.json');
  if (!fs.existsSync(uPath)) fs.writeFileSync(uPath, '[]', 'utf8');
  
  const users = JSON.parse(fs.readFileSync(uPath, 'utf8'));
  const existe = users.some(u => u.usuario === req.body.usuario);
  if (existe) {
    return res.json({ success: false, mensaje: "Usuario ya existe." });
  }

  // Construir usuario con campos adicionales
  const nuevoUsuario = {
    nombre: req.body.nombre,
    usuario: req.body.usuario,
    contrasena: req.body.contrasena,
    departamento: req.body.departamento,
    activo: true,
    estado: "Activo",
    fecha_creacion: req.body.fecha_creacion || new Date().toISOString(),
    fecha_baja: null
  };

  users.push(nuevoUsuario);
  fs.writeFileSync(uPath, JSON.stringify(users, null, 2), 'utf8');
  res.json({ success: true, mensaje: "Usuario creado correctamente." });
});

// 2.4) Login usuario (devuelve departamento)
app.post('/api/login-usuario', (req, res) => {
  const uPath = path.join(__dirname, 'users.json');
  if (!fs.existsSync(uPath)) return res.json({ success: false });
  const users = JSON.parse(fs.readFileSync(uPath, 'utf8'));
  const u = users.find(u =>
    u.usuario === req.body.usuario &&
    u.contrasena === req.body.contrasena &&
    u.activo !== false
  );
  res.json(u
    ? { success: true, departamento: u.departamento }
    : { success: false }
  );
});

// 2.5) Marcaje con límite de 4 por día y zona Houston
app.post('/api/marcar', (req, res) => {
  const p = path.join(__dirname, 'marcajes.json');
  let all = [];
  try {
    const raw = fs.readFileSync(p, 'utf8').trim();
    all = raw ? JSON.parse(raw) : [];
  } catch (_) {
    all = [];
  }

  const now = moment().tz('America/Chicago');
  const fechaHoy = now.format('YYYY-MM-DD');
  const hora = now.format('HH:mm:ss');
  const usuario = req.body.usuario;
  const tipo = req.body.tipo;

  const fechaAyer = moment(now).subtract(1, 'day').format('YYYY-MM-DD');
  const registrosAyer = all.filter(r => r.usuario === usuario && r.fecha === fechaAyer);

  const huboEntrada = registrosAyer.some(r => r.tipo === 'entrada');
  const huboSalida = registrosAyer.some(r => r.tipo === 'salida');

  let advertencia = "";

  if (huboEntrada && !huboSalida) {
    const autoSalida = {
      usuario: usuario,
      tipo: 'salida',
      fecha: fechaAyer,
      hora: '20:00:00',
      ip: req.ip,
      departamento: req.body.departamento || '',
      auto: true
    };
    all.push(autoSalida);
    advertencia = "⚠️ Se detectó que ayer no se marcó salida. Se registró una salida automática a las 20:00.";

    // También lo guardamos en SQLite
    db.run(
      `INSERT INTO registros (usuario, tipo, fecha, hora, ip, departamento) VALUES (?, ?, ?, ?, ?, ?)`,
      [usuario, 'salida', fechaAyer, '20:00:00', req.ip, req.body.departamento || '']
    );
  }

  const yaMarcadoHoy = all.some(r =>
    r.usuario === usuario &&
    r.fecha === fechaHoy &&
    r.tipo === tipo
  );

  if (yaMarcadoHoy) {
    return res.json({
      success: false,
      mensaje: `Ya registraste una marcación de tipo "${tipo}" hoy. No puedes repetirla.`
    });
  }

  const count = all.filter(x => x.usuario === usuario && x.fecha === fechaHoy).length;
  if (count >= 4) {
    return res.json({ success: false, mensaje: 'Su turno ya terminó.' });
  }

  const nuevoMarcaje = {
    usuario,
    tipo,
    fecha: fechaHoy,
    hora,
    ip: req.ip,
    departamento: req.body.departamento || ''
  };

  // Guardamos en JSON
  all.push(nuevoMarcaje);
  fs.writeFileSync(p, JSON.stringify(all, null, 2), 'utf8');

  // Guardamos en SQLite también
  db.run(
    `INSERT INTO registros (usuario, tipo, fecha, hora, ip, departamento) VALUES (?, ?, ?, ?, ?, ?)`,
    [usuario, tipo, fechaHoy, hora, req.ip, req.body.departamento || '']
  );

  const mensajeFinal = advertencia
    ? `${advertencia}\nMarcaje de ${tipo} registrado a las ${hora}.`
    : `Marcaje de ${tipo} registrado a las ${hora}.`;

  res.json({ success: true, mensaje: mensajeFinal });
});

// 2.6) Reporte por usuario CON IP (solo si el usuario está activo)
app.get('/api/reporte', (req, res) => {
  const usuario = req.query.usuario;
  const p = path.join(__dirname, 'marcajes.json');
  const uPath = path.join(__dirname, 'users.json');

  // Verificar que el usuario exista y esté activo
  if (!fs.existsSync(uPath)) return res.json([]);
  const users = JSON.parse(fs.readFileSync(uPath, 'utf8'));
  const user = users.find(u => u.usuario === usuario);

  if (!user || user.activo === false) {
    return res.json([]); // Usuario eliminado o no existe
  }

  // Cargar marcajes si el usuario es válido
  if (!fs.existsSync(p)) return res.json([]);
  const raw = fs.readFileSync(p, 'utf8').trim();
  const all = raw ? JSON.parse(raw) : [];

  const filt = all.filter(x => x.usuario === usuario);
  res.json(filt);
});

// 2.7) Listar empleados activos
app.get('/api/empleados', (req, res) => {
  const uPath = path.join(__dirname, 'users.json');
  if (!fs.existsSync(uPath)) return res.json([]);
  const users = JSON.parse(fs.readFileSync(uPath, 'utf8'));
  res.json(users.filter(u => u.activo !== false));
});

// 2.7.1) Obtener diccionario de nombres completos por username
app.get('/api/usuarios', (req, res) => {
  const uPath = path.join(__dirname, 'users.json');
  if (!fs.existsSync(uPath)) return res.status(404).json({ error: 'Archivo users.json no encontrado' });

  const users = JSON.parse(fs.readFileSync(uPath, 'utf8'));
  const nombres = {};
  users.forEach(u => {
    nombres[u.usuario] = u.nombre;
  });
  res.json(nombres);
});

// 2.8) Reporte global (solo usuarios activos)
app.get('/api/reporte-todos', (req, res) => {
  try {
    const pMarcajes = path.join(__dirname, 'marcajes.json');
    const pUsuarios = path.join(__dirname, 'users.json');

    if (!fs.existsSync(pMarcajes) || !fs.existsSync(pUsuarios)) return res.json([]);

    const rawMarcajes = fs.readFileSync(pMarcajes, 'utf8').trim();
    const all = rawMarcajes ? JSON.parse(rawMarcajes) : [];

    const rawUsers = fs.readFileSync(pUsuarios, 'utf8').trim();
    const usuarios = rawUsers ? JSON.parse(rawUsers) : [];

    // ✅ Solo usuarios con activo !== false
    const usuariosActivos = new Set(
      usuarios.filter(u => u.activo !== false).map(u => u.usuario)
    );

    // Filtrar marcajes
    const filtrados = all.filter(m => usuariosActivos.has(m.usuario));

    // Ordenar por usuario, luego por fecha y hora
    filtrados.sort((a, b) => {
      if (a.usuario !== b.usuario) return a.usuario.localeCompare(b.usuario);
      if (a.fecha !== b.fecha) return a.fecha.localeCompare(b.fecha);
      return (a.hora || '').localeCompare(b.hora || '');
    });

    res.json(filtrados);
  } catch (err) {
    console.error('Error en GET /api/reporte-todos:', err);
    res.status(500).json({ error: 'Error interno leyendo marcajes.' });
  }
});

// 2.9) Borrar un marcaje individual
app.delete('/api/borrar-marcaje', (req, res) => {
  try {
    const { usuario, index } = req.body;
    const p = path.join(__dirname, 'marcajes.json');
    const raw = fs.readFileSync(p, 'utf8').trim();
    const all = raw ? JSON.parse(raw) : [];

    // filtrar solo los de este usuario
    const regs = all.filter(m => m.usuario === usuario);
    const item = regs[index];
    if (!item) return res.json({ success: false });

    // localizar en array original y eliminar
    const globalIdx = all.indexOf(item);
    if (globalIdx === -1) return res.json({ success: false });

    all.splice(globalIdx, 1);
    fs.writeFileSync(p, JSON.stringify(all, null, 2), 'utf8');

    // Opcional: también podrías eliminar del SQLite si lo deseas
    // db.run(`DELETE FROM registros WHERE rowid = ?`, [item.rowid], ...);

    res.json({ success: true });
  } catch (err) {
    console.error('Error en DELETE /api/borrar-marcaje:', err);
    res.status(500).json({ success: false });
  }
});

// 2.10) Limpiar todos los marcajes (JSON + SQLite)
app.delete('/api/limpiar-marcajes', (req, res) => {
  try {
    // Vaciar JSON
    const p = path.join(__dirname, 'marcajes.json');
    fs.writeFileSync(p, '[]', 'utf8');
    // Vaciar tabla SQLite
    db.run('DELETE FROM registros', [], err => {
      if (err) console.error('Error borrando SQLite:', err.message);
      res.json({ success: true, mensaje: 'Todos los marcajes han sido borrados.' });
    });
  } catch (err) {
    console.error('Error en DELETE /api/limpiar-marcajes:', err);
    res.status(500).json({ success: false, mensaje: 'No se pudo borrar marcajes.' });
  }
});

// 2.11) Desactivar usuario
app.post('/api/desactivar-usuario', (req, res) => {
  const uPath = path.join(__dirname, 'users.json');
  if (!fs.existsSync(uPath)) return res.json({ success: false });
  const users = JSON.parse(fs.readFileSync(uPath, 'utf8'));
  const idx   = users.findIndex(u => u.usuario === req.body.usuario);
  if (idx === -1) return res.json({ success: false });
  users[idx].activo = false;
  fs.writeFileSync(uPath, JSON.stringify(users, null, 2), 'utf8');
  res.json({ success: true });
});

// 2.12) Eliminar usuario con fecha de baja
app.post('/api/eliminar-usuario', (req, res) => {
  const { usuario } = req.body;
  const filePath = path.join(__dirname, 'users.json');

  if (!fs.existsSync(filePath)) {
    return res.json({ success: false, message: 'Archivo no encontrado' });
  }

  const users = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const index = users.findIndex(u => u.usuario === usuario);

  if (index === -1) {
    return res.json({ success: false, message: 'Usuario no encontrado' });
  }

  users[index].activo = false;
  users[index].estado = "Eliminado";
  users[index].fecha_baja = new Date().toISOString(); // ← Fecha y hora actual

  fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf8');
  return res.json({ success: true });
});

// 2.13) Activar usuario
app.post('/api/activar-usuario', (req, res) => {
  const uPath = path.join(__dirname, 'users.json');
  if (!fs.existsSync(uPath)) return res.json({ success: false });
  const users = JSON.parse(fs.readFileSync(uPath, 'utf8'));
  const u     = users.find(u => u.usuario === req.body.usuario);
  if (!u) return res.json({ success: false });
  u.activo = true;
  fs.writeFileSync(uPath, JSON.stringify(users, null, 2), 'utf8');
  res.json({ success: true });
});

// 2.14) Corregir fecha y hora de un marcaje
app.post('/api/corregir-hora', (req, res) => {
  try {
    const p   = path.join(__dirname, 'marcajes.json');
    const raw = fs.readFileSync(p, 'utf8').trim();
    const all = raw ? JSON.parse(raw) : [];
    const regs = all.filter(x => x.usuario === req.body.usuario);
    const item = regs[req.body.index];
    const idxG = all.indexOf(item);
    if (idxG < 0) throw new Error('Índice inválido');
    all[idxG].tipo  = req.body.tipo;
    all[idxG].fecha = req.body.fecha;
    all[idxG].hora  = req.body.hora;
    fs.writeFileSync(p, JSON.stringify(all, null, 2), 'utf8');
    res.json({ success: true });
  } catch (err) {
    console.error('Error en POST /api/corregir-hora:', err);
    res.json({ success: false });
  }
});

app.post('/api/agregar-marcaje', (req, res) => {
  const { usuario, departamento, tipo, fecha, hora } = req.body;
  const ip = req.ip;

  // Guardar en SQLite
  const sql = `
    INSERT INTO registros (usuario, tipo, fecha, hora, ip, departamento)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  db.run(sql, [usuario, tipo, fecha, hora, ip, departamento], err => {
    if (err) {
      console.error('Error SQLite:', err.message);
      return res.json({ success: false, mensaje: "Error al guardar en la base de datos." });
    }

    // También guardar en JSON
    const p = path.join(__dirname, 'marcajes.json');
    let all = [];
    try {
      const raw = fs.readFileSync(p, 'utf8').trim();
      all = raw ? JSON.parse(raw) : [];
    } catch (_) {
      all = [];
    }
    all.push({ usuario, departamento, tipo, fecha, hora, ip });
    fs.writeFileSync(p, JSON.stringify(all, null, 2), 'utf8');

    res.json({ success: true, mensaje: "Registro agregado correctamente." });
  });
});

// 3) Servir estáticos desde /public
app.use(express.static(path.join(__dirname, 'public')));

// Ruta para obtener empleados inactivos y sus registros históricos


// Ruta para obtener empleados inactivos y sus registros históricos (con fechas)
app.get('/api/empleados-inactivos', (req, res) => {
  const fsPath = path.join(__dirname, 'users.json');
  let usuariosJSON = [];

  if (fs.existsSync(fsPath)) {
    usuariosJSON = JSON.parse(fs.readFileSync(fsPath, 'utf8'));
  }

  db.all(`SELECT DISTINCT usuario FROM registros`, [], (err, usuariosBD) => {
    if (err) return res.status(500).json({ error: err.message });

    const resultados = [];
    let pendientes = usuariosBD.length;
    if (pendientes === 0) return res.json([]);

    usuariosBD.forEach(u => {
      const usuarioBD = u.usuario;
      const userMatch = usuariosJSON.find(j => j.usuario === usuarioBD);

      if (!userMatch || userMatch.activo === false) {
        db.all(
          `SELECT * FROM registros WHERE usuario = ?`,
          [usuarioBD],
          (err2, rows) => {
            if (!err2 && rows.length > 0) {
              resultados.push({
                nombre: userMatch?.nombre || usuarioBD,
                departamento: userMatch?.departamento || '-',
                estado: userMatch?.estado || 'Desactivado',
                fecha_creacion: userMatch?.fecha_creacion || null,
                fecha_baja: userMatch?.fecha_baja || null,
                registros: rows
              });
            }
            pendientes--;
            if (pendientes === 0) res.json(resultados);
          }
        );
      } else {
        pendientes--;
        if (pendientes === 0) res.json(resultados);
      }
    });
  });
});

// 4) Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

app.post('/api/reset-password-admin', (req, res) => {
  const { usuario, nuevaClave } = req.body;
  const uPath = path.join(__dirname, 'users.json');
  if (!fs.existsSync(uPath)) return res.json({ success: false, message: "Archivo no encontrado" });

  const users = JSON.parse(fs.readFileSync(uPath, 'utf8'));
  const idx = users.findIndex(u => u.usuario === usuario);
  if (idx === -1) return res.json({ success: false, message: "Empleado no encontrado" });

  users[idx].contrasena = nuevaClave;
  fs.writeFileSync(uPath, JSON.stringify(users, null, 2), 'utf8');
  res.json({ success: true });
});

