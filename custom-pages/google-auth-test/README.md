# Google Auth Test

This is an external page intended to be embedded through Hilbert's identity proxy. It does not initiate Google OAuth itself. Hilbert completes Google OAuth, validates the session, and forwards the identity on every proxied request.

Run it from the repository root:

```powershell
npm run google-auth-test
```

It listens on `0.0.0.0:4000` and exposes only `/web/` routes. The page must use a `link` configuration with identity mapping and `auth.mode: identity`.

The page displays the default identity headers injected by Hilbert: `X-Forwarded-User-Id`, `X-Forwarded-Mail`, `X-Forwarded-DisplayName`, `X-Forwarded-Groups`, and `X-Forwarded-User-Picture`. Access it through the isolated `/hilbert-proxy/<page-id>/web/` entry, not directly through port 4000; direct requests can forge forwarding headers.

Additional claims can be mapped declaratively through `auth.claims`; the proxy core no longer contains provider-specific identity fields or token-forwarding switches.
