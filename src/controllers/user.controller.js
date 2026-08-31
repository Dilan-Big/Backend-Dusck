
import { encryptedPassword } from "../helpers/bycryp.helper.js";
import { ALLOWED_ROLES, PROFILE_UPDATABLE_FIELDS, ROLES } from "../config/global.config.js";
import {
  dbCreateUser,
  dbDeleteUserById,
  dbGetUserById,
  dbGetUsers,
  dbUpdateUserById,
} from "../services/user.service.js";

// Construye un objeto nuevo SOLO con las claves permitidas presentes en el body.
// Lista blanca por construccion: lo que no esta en `allowed` nunca llega a la BD
// (no dependemos de `delete req.body.campo`).
const pickAllowedFields = (body = {}, allowed = []) => {
  const result = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined) {
      result[key] = body[key];
    }
  }
  return result;
};

const createUser = async (req, res) => {
  try {
    // Lista blanca tambien al crear, para evitar asignacion masiva de campos.
    const inputData = pickAllowedFields(req.body, [
      "name",
      "nickname",
      "email",
      "password",
      "avatar",
      "role",
      "status",
    ]);

    if (inputData.role && !ALLOWED_ROLES.includes(inputData.role)) {
      return res.status(400).json({ msg: `Rol no válido: ${inputData.role}` });
    }

    inputData.password = encryptedPassword(inputData.password);

    const data = await dbCreateUser(inputData);

    res.json({
      msg: "Se registra un usuario",
      data,
    });
  } catch (error) {
    res.json({
      msg: "Ocurrio un error al obtener el usuario",
    });
  }
};

const getUser = async (req, res) => {
  try {
    const data = await dbGetUsers();
    res.json({
      msg: "Se obtiene el listado de usuarios",
      data,
    });
  } catch (error) {
    console.error(error);
    res.json({
      msg: "Ocurrio un error a obtener la lista de usuarios",
    });
  }
};

const getUserById = async (req, res) => {
  try {
    const id = req.params.id;
    const data = await dbGetUserById(id);
    res.json({
      msg: "Se obtiene un usuario por id",
      data,
    });
  } catch (error) {
    console.error(error);
    res.json({
      msg: "Ocurrio un error a obtener el usuario por ID",
    });
  }
};

// PATCH /api/users/:id  -> actualizacion de PERFIL PROPIO.
// Solo campos de perfil; los campos de privilegios (role, status, etc.) se ignoran.
const updateUserById = async (req, res) => {
  try {
    const id = req.params.id;
    const inputData = pickAllowedFields(req.body, PROFILE_UPDATABLE_FIELDS);

    if (inputData.password) {
      inputData.password = encryptedPassword(inputData.password);
    }

    const data = await dbUpdateUserById(id, inputData);
    res.json({
      msg: "Se actualiza usuario po ID",
      data,
    });
  } catch (error) {
    console.error(error);
    res.json({
      msg: "Ocurio un error al actualizar usuario por ID",
    });
  }
};

// PATCH /api/users/:id/role  -> operacion ADMINISTRATIVA (requireAdmin en la ruta).
const updateUserRole = async (req, res) => {
  try {
    const id = req.params.id;
    const { role } = req.body;

    if (!role || !ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({
        msg: `Rol no válido. Valores permitidos: ${ALLOWED_ROLES.join(", ")}`,
      });
    }

    // Anti-lockout: un admin no puede quitarse a si mismo el rol de admin.
    if (id === req.user._id.toString() && role !== ROLES.ADMIN) {
      return res.status(400).json({
        msg: "No puedes cambiar tu propio rol de administrador",
      });
    }

    const data = await dbUpdateUserById(id, { role });
    if (!data) return res.status(404).json({ msg: "Usuario no encontrado" });

    res.json({ msg: "Rol de usuario actualizado", data });
  } catch (error) {
    console.error(error);
    res.status(400).json({ msg: "Ocurrió un error al actualizar el rol" });
  }
};

// PATCH /api/users/:id/status  -> operacion ADMINISTRATIVA (activar/desactivar cuenta).
const updateUserStatus = async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body;

    if (typeof status !== "boolean") {
      return res.status(400).json({ msg: "El campo 'status' debe ser booleano" });
    }

    // Anti-lockout: un admin no puede desactivar su propia cuenta.
    if (id === req.user._id.toString() && status === false) {
      return res.status(400).json({ msg: "No puedes desactivar tu propia cuenta" });
    }

    const data = await dbUpdateUserById(id, { status });
    if (!data) return res.status(404).json({ msg: "Usuario no encontrado" });

    res.json({ msg: "Estado de usuario actualizado", data });
  } catch (error) {
    console.error(error);
    res.status(400).json({ msg: "Ocurrió un error al actualizar el estado" });
  }
};

const deleteUserById = async (req, res) => {
  try {
    const id = req.params.id;
    const data = await dbDeleteUserById(id);
    res.json({
      msg: "Se elimina usuario por ID",
      data,
    });
  } catch (error) {
    console.error(error);
    res.json({
      msg: "Ocurrio un error al eliminiar usuario",
    });
  }
};

export {
  createUser,
  getUser,
  getUserById,
  updateUserById,
  updateUserRole,
  updateUserStatus,
  deleteUserById,
};
