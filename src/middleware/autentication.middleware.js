
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

// FASE 4.3-C — Autenticacion "opcional pero estricta" para POST /api/orders.
//
// El checkout web admite DOS clientes: invitado (sin `x-token`) y usuario
// autenticado (`x-token` valido). La diferencia con `optionalAuthentication`:
// un `x-token` PRESENTE que no valida NO se degrada a invitado — eso permitiria
// "blanquear" un token corrupto/robado/expirado como pedido guest. Contrato
// cerrado en F4.3-C.0:
//
//   sin x-token                                  -> next() como invitado (req.user undefined)
//   x-token invalido / expirado / malformado     -> 401 (jamas invitado)
//   x-token valido, usuario inexistente/inactivo  -> 401
//   fallo de infraestructura resolviendo el user  -> 500 (fail closed)
//
// NO duplica la verificacion JWT: reutiliza `validateToken()` y
// `dbGetUserByIdEmail()`, igual que `autenticationUser`. NO altera el
// comportamiento de `autenticationUser` ni de `optionalAuthentication`; sus
// callers existentes siguen funcionando sin cambios.
const authenticateOptionalStrict = async (req, res, next) => {
    const token = req.header("x-token");

    // A — invitado legitimo: sin credencial. El controller usara userId = null.
    if (!token) {
        return next();
    }

    // C / D / E — credencial presente: DEBE validar. `validateToken` colapsa
    // firma invalida, expiracion y token malformado en `null` (nunca lanza).
    const payload = validateToken(token);
    if (!payload) {
        return res.status(401).json({
            msg: "Token no válido o expirado"
        });
    }

    delete payload.exp;
    delete payload.iat;

    let userFound;
    try {
        userFound = await dbGetUserByIdEmail(payload.email);
    } catch (error) {
        // H — fallo de infraestructura: fail closed. Un checkout que traia
        // credencial NUNCA se sirve como invitado ante un error de BD.
        console.error(`authenticateOptionalStrict -> ${error && error.name}`);
        return res.status(500).json({
            msg: "No se pudo procesar la solicitud"
        });
    }

    // F — el token valida pero el usuario ya no existe.
    if (!userFound) {
        return res.status(401).json({
            msg: "Token no válido, el usuario no está disponible"
        });
    }

    // G — usuario desactivado.
    if (!userFound.status) {
        return res.status(401).json({
            msg: "La cuenta no se encuentra activa"
        });
    }

    const userData = userFound.toObject();

    delete userData.password;
    delete userData.createdAt;
    delete userData.updatedAt;

    req.payload = payload;
    req.user = userData;

    next();
};

export default autenticationUser;
export { optionalAuthentication, authenticateOptionalStrict };

