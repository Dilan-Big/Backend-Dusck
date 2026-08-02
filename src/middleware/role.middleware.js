

const isAdmin = (req , res, next) => {
    if (req.user.role !== 'administrador') {
        return res.status(403).json({
            msg:"No tienes permisos para realizar esta acción"
        });
    }
    next()
}

export default isAdmin;