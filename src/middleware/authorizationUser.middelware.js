// Definicion de un 'Closure', que no es mas que una funcione que retorna otra funcion
const authorizationUser = (allowedRoles = []) => {
  return (req, res, next) => {
    try {
      // Paso 1: Rol ACTUAL del usuario.
      // `req.user` lo carga autentication.middleware.js desde MongoDB en CADA
      // request, asi que refleja cambios de rol inmediatamente. Se prefiere
      // sobre `req.payload.role` (rol congelado en el JWT, hasta 1h de
      // antiguedad). Fallback al payload por compatibilidad.
      const role = req.user?.role ?? req.payload?.role;
      console.log('ROL RECIBIDO:', JSON.stringify(role));
console.log('ROLES PERMITIDOS:', JSON.stringify(allowedRoles));

      // Verifica hay un valor en role
      if ( !role ) {
        // Nosotros estamos definiendo manualmente una exception
        throw new Error("No tiene los permisos definidos");
      }

      // Paso 2: Verificar si el rol del usuario  esta en la lista de roles permitidos
      if ( !allowedRoles.includes( role )) {
        return res.status(403).json({
          msg: `El rol ${role} no esta autorizado para esta acción`,
        });
      }

      console.log(`El rol ${role}  esta autorizado, acceso permitido`);

      // Paso 3: Da acceso a la ejecucion de la siguiente funcion definida en la ruta
      next();
    } catch ( error ) {
      // A. Capturar error definido en cuerpo del try/catch
      if (error.message.includes("No tiene los permisos definidos")) {
        return res.status(404).json({
          msg: error.message,
        });
      }

      console.error(error);

      // Respuesta generica de la exception
      res.status(500).json({
        msg: "Error de autorización del servidor",
      });
    }
  };
};

export default authorizationUser;
