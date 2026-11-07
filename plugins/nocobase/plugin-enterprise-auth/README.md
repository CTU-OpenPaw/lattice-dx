# Enterprise Login

NocoBase 2.2.38 SDK extension: Keycloak authorization code + PKCE, explicit native user mapping and native sessions. No account/role creation at login. No upstream commercial plugin code included.

Deployment: DX_NATIVE_AUTH_ISSUER, DX_NATIVE_AUTH_ORIGIN, DX_NATIVE_AUTH_CLIENT_ID; optional DX_NATIVE_AUTH_INTERNAL_ISSUER only for the local Docker Keycloak fixture. Public client, exact redirect URI `<origin>/api/enterpriseAuth:callback` and PKCE S256 required. HTTPS outside loopback.

Enable plugin, create/enable a `lattice-keycloak` authenticator in native Authentication settings, then explicitly map Keycloak subject to an existing active native Employee/user under Authentication → Enterprise identity mappings. Add block → Other blocks → Enterprise login inserts a button using that authenticator.

Local single-process cache/lock is used for short-lived login state and handoff; multi-process deployment requires shared host cache/lock configuration before scaling. Native logout ends the NocoBase session, not the upstream Keycloak SSO session. Existing password login remains available.

Our extension source: Apache-2.0; host NocoBase is separately licensed. Bundled openid-client, oauth4webapi and jose retain their MIT notices in node_modules. Their licenses are not replaced by this package license.
