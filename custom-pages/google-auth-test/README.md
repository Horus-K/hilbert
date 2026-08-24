# Google Auth Test

This is an external page intended to be embedded through Hilbert's identity proxy. It does not initiate Google OAuth itself. Hilbert completes Google OAuth, validates the session, and forwards the identity on every proxied request.

Run it from the repository root:

```powershell
npm run google-auth-test
```

It listens on `0.0.0.0:4000` and exposes only `/web/` routes. The page must use a `link` configuration with identity mapping and `auth.mode: identity`.

The page displays these headers injected by Hilbert: `X-Forwarded-User-Id`, `X-Forwarded-Mail`, `X-Forwarded-DisplayName`, `X-Forwarded-Groups`, and `X-Forwarded-User-Picture`. Access it through Hilbert's `/web/` proxy route, not directly through port 4000; direct requests can forge forwarding headers.

Enable **透传完整 Google 用户资料** in the identity authentication settings to additionally send the Google userinfo JSON in Base64URL-encoded `X-Forwarded-Google-Auth`. OAuth access and refresh tokens are never forwarded.

Enable **透传 Google access_token** only for a trusted target that needs to call Google APIs for the current user. Hilbert injects it as `X-Forwarded-Google-Access-Token` only while it is valid; the test page shows a masked value. Refresh tokens are never retained or forwarded.
