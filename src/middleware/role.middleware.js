

const isAdmin = (req , res, next) => {
    if (req.user.role !== 'administrador') {
        return res.status(403).json({
            msg:"No tienes permisos para realizar esta acción"
        });
    }
    next();
}

const verifyUserPermission = (req, res, next) => {
    const idFromUrl = req.params.id;                    //Usuario pueda editar su propio perfil
    const idFromToken = req.user._id.toString();        //No puede editar cualquier perfil solo el de el ("toString" convierte a texto para comparar bien)

    const esElMismoUsuario  = idFromUrl === idFromToken;
    const esAdmin = req.user.role === 'administrador';  //admin puede editar cualquiere perfil

      if (! (esElMismoUsuario || esAdmin) ) {
        return res.status(403).json({
            msg: "No tienes permisos para modificar este usuario"
        });
    }
    next();
}

export  {isAdmin, verifyUserPermission};