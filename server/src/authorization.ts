export interface BoundIdentity {
  connectorId: string;
  domainId: string;
}

export type BoundAuthorizationResult =
  | { ok: true }
  | { ok: false; statusCode: 403 | 409; message: string };

export function isConnectorOwner(user: any, connector: any): boolean {
  const username = String(user?.username ?? "");
  return Boolean(username && connector?.created_by === username);
}

/** 纯授权判定，集中约束 token 主体、中心连接器属主和本机绑定必须完全一致。 */
export function authorizeBoundOwner(
  identity: BoundIdentity,
  user: any,
  connector: any
): BoundAuthorizationResult {
  if (!isConnectorOwner(user, connector)) {
    return { ok: false, statusCode: 403, message: "当前账号不是本连接器属主，不能访问该连接器的本地能力" };
  }
  if (connector?.id !== identity.connectorId || connector?.kuscia_domain_id !== identity.domainId) {
    return { ok: false, statusCode: 409, message: "门户本地绑定与中心连接器身份不一致，请重新接入" };
  }
  return { ok: true };
}
