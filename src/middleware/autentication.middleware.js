
import { validateToken } from "../helpers/jwt.helpers.js";
import { dbGetUserById, dbGetUserByIdEmail } from "../services/user.service.js";

const autenticationUser = async (req, res, next) => {

    const token = req.header("x-token")
    
    if (! token) {
        return res.status(401).json({
            msg: "cadena del token vacia"
        });
    }

    const payload = validateToken(token)

    if (! payload) {
        return res.status(401).json({
            msg: "Token no valido fue expirado"
        })
    }

    delete payload.exp
    delete payload.iat
    
    

    const userFound = await dbGetUserByIdEmail(payload.email)
    
    if (! userFound) {
        return res.status(401).json({
            msg: "Token no valido, no existe el usuario "
        })
    }

    if (! userFound.status) {
        return res.status(401).json({
            msg: "No se encuentra activo el usuario"
        })
    }

    const userData = userFound.toObject()

    delete userData.password
    delete userData.createdAt
    delete userData.updatedAt


    req.payload = payload
    req.user = userData

    next()
}

// FASE 3 — Product Domain + Editor Workflow.
//
// Variante NO bloqueante de `autenticationUser`, para rutas que son PUBLICAS
// (no requieren sesion) pero cuyo comportamiento cambia SI hay una sesion
// valida (p. ej. GET /product: un editor autenticado ve sus propios
// borradores; una request anonima solo ve PUBLISHED+isActive).
//
// Nunca responde 401/403: ante cualquier problema (sin token, token invalido,
// usuario inactivo/inexistente) simplemente continua sin `req.user`. La
// autorizacion real de que puede ver cada rol la decide el controller.
const optionalAuthentication = async (req, res, next) => {
    const token = req.header("x-token");

    if (!token) {
        return next();
    }

    const payload = validateToken(token);
    if (!payload) {
        return next();
    }

    delete payload.exp;
    delete payload.iat;

    try {
        const userFound = await dbGetUserByIdEmail(payload.email);
        if (!userFound || !userFound.status) {
            return next();
        }

        const userData = userFound.toObject();
        delete userData.password;
        delete userData.createdAt;
        delete userData.updatedAt;

        req.payload = payload;
        req.user = userData;
    } catch (error) {
        // No se bloquea la request publica por un fallo al resolver la sesion
        // opcional; simplemente se sirve como si no hubiera sesion.
        console.error(`optionalAuthentication -> ${error && error.name}`);
    }

    next();
};

export default autenticationUser;
export { optionalAuthentication };

