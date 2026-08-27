# Google Auth Test

This is an external page intended to be embedded through Hilbert's identity proxy. It does not initiate Google OAuth itself. Hilbert completes Google OAuth, validates the session, and forwards the identity on every proxied request.

Run it from the repository root:

```powershell
npm run google-auth-test
```

It listens on `0.0.0.0:4000` and exposes only `/web/` routes. The page must use a `link` configuration with identity mapping and `auth.mode: identity`.

The page displays the default identity headers injected by Hilbert: `X-Forwarded-User-Id`, `X-Forwarded-Mail`, `X-Forwarded-DisplayName`, `X-Forwarded-Groups`, and `X-Forwarded-User-Picture`. Access it through the page-specific proxy Host, not directly through port 4000; direct requests can forge forwarding headers.

The identity settings also provide two optional switches:

- **透传完整 Google 用户资料** sends Base64URL-encoded JSON in `X-Forwarded-Google-Auth`. OAuth token fields are recursively removed.
- **透传 Google access_token** sends a still-valid access token in `X-Forwarded-Google-Access-Token`. Expired tokens and refresh tokens are never forwarded.

Additional claims can still be mapped declaratively through `auth.claims`.
