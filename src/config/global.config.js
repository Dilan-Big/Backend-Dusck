// Definicion global de roles de usuario

// Retorta un objeto con todos los roles, permitidos o podemos obtener solo uno de ellos
export const ROLES = {
    SUPER_ADMIN: 'super administrator',
    ADMIN: 'administrator',
    EDITOR: 'editor',
    AUTHOR: 'author',
    CONTRIBUTOR: 'contributor',
    SUBSCRIBER: 'subscriber'
};

// Retorna el listado de los roles permitidos
export const ALLOWED_ROLES = Object.values( ROLES );

export const ROLES_LABELS = {
    [ ROLES.SUPER_ADMIN ]: "Super administrador",
    [ ROLES.ADMIN]: "Administrador",
    [ ROLES.EDITOR]: "Editor",
    [ ROLES.AUTHOR]: "Autor",
    [ ROLES.CONTRIBUTOR]:"Contribuidor",
    [ ROLES.SUBSCRIBER]: "Subscriptor"

}