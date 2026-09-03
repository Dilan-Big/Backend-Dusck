// Definicion global de roles de usuario

// Roles reales de la aplicacion. Deben coincidir con el enum de models/user.model.js
export const ROLES = {
    ADMIN: 'administrador',
    SHOP_MANAGER: 'shop_manager',
    EDITOR: 'editor',
    SUBSCRIBER: 'subscriber'
};

// Retorna el listado de los roles permitidos
export const ALLOWED_ROLES = Object.values( ROLES );

// Roles con privilegios administrativos (gestion de otros usuarios)
export const ADMIN_ROLES = [ ROLES.ADMIN ];

export const ROLES_LABELS = {
    [ ROLES.ADMIN]: "Administrador",
    [ ROLES.SHOP_MANAGER]: "Gestor de tienda",
    [ ROLES.EDITOR]: "Editor",
    [ ROLES.SUBSCRIBER]: "Subscriptor"

}

// Campos de perfil que un usuario puede modificar sobre su propia cuenta
// mediante PATCH /api/users/:id. Cualquier otro campo del body se ignora.
export const PROFILE_UPDATABLE_FIELDS = ['name', 'nickname', 'email', 'password', 'avatar'];

// FASE 2 / S4 — Lista blanca de actualizacion de categoria.
// Solo estos campos pueden llegar (dentro de $set) a findOneAndUpdate en el
// PATCH de categoria. Se excluyen a proposito los campos de propiedad/auditoria
// (createdBy, timestamps).
export const CATEGORY_UPDATABLE_FIELDS = ['name', 'slug', 'description', 'isActive'];

// FASE 3 — Product Domain + Editor Workflow.
// La lista blanca de PRODUCTO ya NO es estática: depende del rol y del
// `status` actual del producto (workflow editorial). Ver
// `helpers/productWorkflow.helper.js` -> `editableFieldsFor()` /
// `PRODUCT_CREATABLE_FIELDS`. `status` nunca se acepta por PATCH directo:
// solo cambia a través de `PATCH /product/:id/status` (transiciones validadas).
